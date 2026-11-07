# 在 Linux x86_64 NAS 上运行 Server

容器运行同一个 Node Core、SQLite 曲库和原生音频引擎，将处理后的音频发送到独立 Bridge。构建输入包含独立声区 PCM／DSD／DoP／多声道、双声道 PCM 同步组、基础原生 AutoMix 与组设置迁移。音乐目录只读挂载；曲库、配对、扩展及登录数据保存在包外的数据目录。

2026-11-06 已完成 Linux x86_64 实际构建与最终容器软件验证，可使用本地镜像归档部署。镜像压缩归档约 206 MiB，已实际通过 `docker load`；Docker 健康状态达到 `healthy`，经 `tini` 转发 SIGTERM 正常退出。公开源码／权重重建的两份 AutoMix 图与锁定发布图一致；原生引擎、生产依赖、Core／SQLite／TLS、网络格式、组 AutoMix 与六会话迁移均通过 Linux 检查。最终镜像以 UID／GID 1000 运行，在无外网、只读根文件系统和独立临时数据目录下通过模型分析、重启持久化、离线恢复及 SIGTERM 停服。实机 NAS、DAC 和物理双机验收按总体安排后置。

本地交付目录：`dist/TwilightEchoServer-2.0.0-linux-x86_64-20261106-r1/`，包含镜像归档、部署 Compose、环境变量示例和使用说明。镜像标签为 `twilight-echo-server:2.0.0-linux-x86_64-20261106-r1`。将整个目录复制到 Linux x86_64 NAS／服务器后，先在该目录执行：

```sh
docker load --input TwilightEchoServer-2.0.0-linux-x86_64-20261106-r1.tar.gz
```

然后按交付目录的 `README.md` 设置音乐和数据目录、初始化并启动。已有 Windows Bridge 与 Android APK 可连接此 Server；容器负责曲库、队列、DSP 和解码，独立 Bridge 负责 DAC 输出。 该说明还包含主声区连接邀请的完整命令；手机负责日常遥控，Bridge 首次连接与重连由 NAS 本机管理入口完成。

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

### 原生 AutoMix 模型随镜像构建，不依赖本机缓存

`public-models` 构建阶段使用 Python 3.12 和依赖锁中的导出工具版本，从固定的公开源码提交、权重和 YAMNet 文件生成两份 `.tamg`。权重、来源文件及最终图均须匹配已有锁定摘要；不匹配会停止构建，不改锁或静默换模型。首次构建需要下载导出工具及公开模型，后续可复用 Docker 构建缓存。

最终镜像只接收两份图、清单、四份许可说明和现有原生运行时，不包含 PyTorch、TensorFlow、ONNX Runtime 或转换工作目录。Linux 按已加载原生库的位置查找图，不依赖启动目录。可选人声分离 worker 源码随包携带；Demucs 模型和 Python 运行包仍需独立提供，缺少时保留基础 AutoMix。

在已有公开模型暂存目录的开发工作区，可先运行 `node --run test:server-linux:inputs` 检查 ELF 架构、模型／许可允许清单、worker 源码与验证入口。Python 构建编排单测由 `python scripts/test-build-public-automix-assets.py` 执行，不下载或安装依赖。它们检查构建输入，实际 Linux 图转换、原生编译及镜像运行仍由下面的 Linux 验证阶段完成。

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

Linux 已通过 Profile 密钥隔离、密文完整性、密钥 0600 权限与归属、备份恢复、健康退出码、关闭 stdin 的 Bridge-only 启动、音频／图片原生模块加载、扫描及重启持久化。最终只读运行镜像同时通过 CLI 停止和 SIGTERM 停止；Windows DPAPI 与原 Windows 包的回归证据继续保留。

## 验收入口

`.github/workflows/server-linux.yml` 可手动运行，也对构建输入相关的 PR 运行；提供可 `docker load` 的镜像归档，无自动发布步骤。构建阶段以非 root 账号运行真实 Core／SQLite／配对 TLS／模拟 DAC 的 DSP、队列、扩展事务、网络 DSD／DoP／多声道、组 AutoMix 和六会话迁移测试。最终运行镜像从无关工作目录执行真实模型分析，再验证只读根文件系统、关闭 stdin、原生扫描、健康状态、持久状态、离线快照恢复和 SIGTERM 停止。恢复用例核对 Profile 身份、TLS 身份、凭据密钥、曲库及远程设置，Linux 下还核对密钥的归属和 0600 权限。

本次 Linux 结果：

- `.server-linux-verification-dsp-20261106.log`：公开模型和原生构建成功；第一组 22 项通过，跳过 1 项仅适用于 Windows 长路径的测试；第二组 21 项全部通过，覆盖原生网络格式、同步组／AutoMix、成员采样率与 DSP 延迟，以及 4 种六会话迁移。
- `.server-linux-final-runtime-20261106.log`：最终运行镜像在非 root、无外网、只读根文件系统和 256 MiB `/tmp` 中完成真实模型推理、扫描、健康状态、重启、身份／密钥／曲库恢复及 SIGTERM 停服。
- `.server-linux-archive-load-20261106.log` 与 `.server-linux-container-lifecycle-20261106.log`：压缩归档实际导入成功；容器健康检查为 `healthy`，通过 `docker stop`／`tini` 正常停服，退出码 0。
- `.server-linux-bridge-shutdown-regression-20261106.log`：24 项桥接回归通过。关闭仅停止并释放桥接资源；显式断开仍恢复用户选择的本机输出。修复容器关闭时误恢复未编译 ALSA 导致停服失败的问题。

本次还修复了无硬件 Capture 在 AutoMix 选择时尚未确认预载 DSP 的时序：在同一 Capture 传输锁下应用待处理控制，再绑定图版本票据。真实双解码器／TLS 测试已完成两次自动重复切换；原生跨采样率测试在选择前主动排入 DSP 更新，验证准备不会依赖额外 PCM 拉取。Windows 共享原生构建和三条组回归也通过，见 `.server-linux-shared-native-windows-build-20261106.log`、`.server-linux-shared-native-windows-regression-20261106.log`；新 Windows 引擎仅放在私有验证目录，原 Windows 交付包仍为既有版本。接收 DAC、时钟和可选分离输出采用受控数据；真实 NAS／DAC 部署验收统一后置。
