# 在 Linux x86_64 NAS 上运行 Server

容器运行同一个 Node Core、SQLite 曲库和原生音频引擎，将处理后的 PCM 发送到独立 Bridge。音乐目录只读挂载；曲库、配对、扩展及登录数据保存在包外的数据目录。

当前代码已提供构建和验证入口。2026-11-05 用户确认没有可用 Linux 环境，本地也没有 Docker／WSL；镜像构建和 Linux 运行验收等待环境。

## 构建并初始化

需要 Linux x86_64 的 Docker Engine 与 Compose。以下命令由有权使用 Docker、且能读取音乐目录的非 root 账号在仓库根目录执行：

```sh
docker build --target verification -f deploy/server/Dockerfile -t twilight-server-verified .
docker build --target runtime -f deploy/server/Dockerfile -t twilight-echo-server:local .

export TWILIGHT_DATA=/srv/twilight/data
export TWILIGHT_MUSIC=/srv/music
export TWILIGHT_UID=$(id -u)
export TWILIGHT_GID=$(id -g)
mkdir -p "$TWILIGHT_DATA"
chmod 700 "$TWILIGHT_DATA"
docker compose -f deploy/server/compose.yaml run --rm server init --data /data --library /music
docker compose -f deploy/server/compose.yaml up -d
docker compose -f deploy/server/compose.yaml exec server node out/server/server.cjs remote-on --data /data
```

初始化需要空目录。数据目录须由所选 UID／GID 持有；音乐目录须对该账号可读。Compose 使用 Linux 主机网络，便于局域网发现和 Bridge 连接；手机可以自动发现，或使用 `remote-status` 返回的端口连接 NAS。配对仍需本机 CLI 对照手机验证码批准。

```sh
docker compose -f deploy/server/compose.yaml exec server node out/server/server.cjs remote-status --data /data
docker compose -f deploy/server/compose.yaml exec server node out/server/server.cjs allow-pairing --data /data --id REQUEST_ID --code PHONE_CODE
```

镜像不包含桌面 Electron、Windows 模块或用户的音频插件。Linux 容器的本机 DAC 输出关闭；VST3 宿主可用性按当前 Linux 构建实际能力显示。Windows Server 与 Bridge 的原入口继续使用原行为。

## 数据与更新

`docker compose stop` 给 Core 六十秒正常保存和关闭，`start --bridge-only` 不依赖交互式 stdin。健康检查通过受认证的本机管理 socket 查询状态：`health` 仅在 Core 为 `ready` 时返回 0，启动中、恢复中、失败或无法连接时返回非零。`status` 继续用于读取诊断信息，能读到失败状态不代表健康。

### 停止后备份到宿主机

快照不能放在 `/data` 内。为一次性维护容器另挂可写目录；以下变量与前面的初始化变量须在同一终端中设置：

```sh
export TWILIGHT_BACKUPS=/srv/twilight/snapshots
export TWILIGHT_SNAPSHOT="before-upgrade-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TWILIGHT_BACKUPS"
chmod 700 "$TWILIGHT_BACKUPS"

docker compose -f deploy/server/compose.yaml stop
docker compose -f deploy/server/compose.yaml run --rm --no-deps \
  --volume "$TWILIGHT_BACKUPS:/snapshots" server \
  backup --data /data --to "/snapshots/$TWILIGHT_SNAPSHOT"
```

备份完成后，宿主机的 `$TWILIGHT_BACKUPS/$TWILIGHT_SNAPSHOT` 包含清单和数据。未升级时用 `docker compose -f deploy/server/compose.yaml start` 恢复运行。

### 恢复到新目录，再切换入口

使用生成快照时的同版本、同操作系统镜像恢复。先停服，再创建新的宿主机父目录；不要预建下面的 `data` 子目录，恢复不会覆盖已有目录。

```sh
docker compose -f deploy/server/compose.yaml stop
export TWILIGHT_RESTORE_PARENT="/srv/twilight/recovery-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$TWILIGHT_RESTORE_PARENT"
docker compose -f deploy/server/compose.yaml run --rm --no-deps \
  --volume "$TWILIGHT_BACKUPS:/snapshots:ro" \
  --volume "$TWILIGHT_RESTORE_PARENT:/restore" server \
  restore --from "/snapshots/$TWILIGHT_SNAPSHOT" --data /restore/data

export TWILIGHT_DATA="$TWILIGHT_RESTORE_PARENT/data"
docker compose -f deploy/server/compose.yaml up -d --force-recreate
docker compose -f deploy/server/compose.yaml exec server \
  node out/server/server.cjs health --data /data
```

健康检查通过后，在手机核对配对身份、曲库和队列。将新的 `TWILIGHT_DATA` 保存到部署时使用的环境文件；原目录与快照继续保留。所有实例都把数据挂到 `/data`、音乐挂到 `/music`，恢复后不要改变这两个容器内路径。

升级前另给旧镜像打保留标签，例如 `docker tag twilight-echo-server:local twilight-echo-server:before-upgrade-20261105`。Compose 支持 `TWILIGHT_IMAGE` 选择镜像；回退时设置该变量为旧标签，用旧镜像把升级前快照恢复到上述新目录，再切换 `TWILIGHT_DATA`。新版应先在独立候选数据目录验证，验证期间不要让旧实例同时使用该目录。原地打开新版数据后，不能仅换回旧镜像当作已回退。

Linux 扩展凭据使用数据目录中的随机 32 字节 `server-credentials.key`，文件权限为 0600，归运行账号所有。备份和迁移应保留整个 Profile 及密钥权限；丢失密钥后须重新登录，Server 不会为旧密文静默生成替代密钥。Windows DPAPI 凭据迁到 Linux 时须重新登录。

本机已通过 Profile 密钥隔离、密文完整性、备份恢复及原 Windows DPAPI 回归。健康状态的退出码、关闭 stdin 的 Bridge-only 启动、原生音频与图片模块加载、扫描、重启持久化及 CLI 正常停止已有 Windows 软件证据；Linux 文件权限与 SIGTERM 用例由 Linux 工作流执行。

## 验收入口

`.github/workflows/server-linux.yml` 可手动运行，也对构建输入相关的 PR 运行；提供可 `docker load` 的镜像归档，无自动发布步骤。构建阶段以非 root 账号运行真实 Core／SQLite／配对 TLS／模拟 DAC 的 DSP、队列、扩展事务及备份恢复测试；最终运行镜像另验证只读根文件系统、关闭 stdin、原生扫描、健康状态、持久状态、离线快照恢复和 SIGTERM 停止。恢复用例核对 Profile 身份、TLS 身份、凭据密钥、曲库及远程设置，Linux 下还核对密钥的归属和 0600 权限。

下一步由可用的 Linux x86_64 runner 执行该工作流或以上构建命令；只有实际通过后才将 Linux／NAS 标为交付。实机 NAS／DAC 验收按总体安排后置。
