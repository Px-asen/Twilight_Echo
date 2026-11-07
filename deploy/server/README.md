# Twilight Echo Server 2.0.0 — Linux x86_64

把本目录复制到 Intel／AMD 的 Linux NAS 或服务器，即可导入镜像并运行。Server 保存曲库、队列、配对和 DSP；连接 DAC 的电脑运行 Twilight Echo 桌面版并开启输出桥；Android 用于遥控。

## 导入并启动

需要已安装 Docker Engine 和 Docker Compose。以下命令在本目录执行。镜像已经包含 Node、原生引擎、生产依赖与基础 AutoMix 模型，部署时无需编译或下载模型。

```sh
docker load --input TwilightEchoServer-2.0.0-linux-x86_64-20261106-r1.tar.gz
cp .env.example .env
```

编辑 `.env`：把 `TWILIGHT_MUSIC` 改为音乐目录，`TWILIGHT_DATA` 改为新的私有空目录。`TWILIGHT_UID`、`TWILIGHT_GID` 填入具有音乐读取权限的运行账号 ID，可用 `id -u`、`id -g` 查看。此账号须能使用 Docker。然后：

```sh
set -a
. ./.env
set +a
mkdir -p "$TWILIGHT_DATA"
chmod 700 "$TWILIGHT_DATA"
docker compose run --rm server init --data /data --library /music
docker compose up -d
docker compose exec server node out/server/server.cjs health --data /data
docker compose exec server node out/server/server.cjs remote-on --data /data
docker compose exec server node out/server/server.cjs remote-status --data /data
```

数据目录须由所选 UID／GID 持有；已有数据时跳过 `init`。Compose 使用主机网络、只读根文件系统及只读音乐挂载。手机连接 NAS 的局域网地址和 `remote-status` 返回的端口。

## 手机配对与输出桥

Android 发起配对后，在 NAS 对照手机验证码批准：

```sh
docker compose exec server node out/server/server.cjs remote-status --data /data
docker compose exec server node out/server/server.cjs allow-pairing --data /data --id REQUEST_ID --code PHONE_CODE
```

连接 DAC 的电脑打开桌面版，在“声区 → 本机输出与输出桥”中选择具体 DAC、开启接收并复制邀请。先暂停该 Server 主声区的播放，然后在 NAS 执行下面的连接命令；输入时粘贴整条 `twilight-bridge://...` 邀请并回车。此操作把 Server 主声区连接到该电脑。

```sh
printf '粘贴输出桥邀请并回车：\n'
read -r BRIDGE_INVITATION
export BRIDGE_INVITATION
docker compose exec -T -e BRIDGE_INVITATION server node <<'NODE'
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const cli = (...args) => JSON.parse(execFileSync(process.execPath,
  ['out/server/server.cjs', ...args, '--data', '/data'], { encoding: 'utf8' }));
const invitation = new URL(process.env.BRIDGE_INVITATION.trim());
if (invitation.protocol !== 'twilight-bridge:') throw Error('请复制完整输出桥邀请');
const peer = { host: invitation.hostname.replace(/^\[|\]$/g, ''), port: Number(invitation.port),
  token: invitation.searchParams.get('token'), fingerprint: invitation.searchParams.get('fp') };
const epoch = cli('status').epoch;
const temporary = fs.mkdtempSync('/tmp/twilight-bind-');
try {
  const rpc = (kind, name, payload = {}) => {
    const file = temporary + '/request.json';
    fs.writeFileSync(file, JSON.stringify({ kind, name, payload, epoch, requestId: randomUUID() }), { mode: 0o600 });
    return cli('rpc', '--request', file);
  };
  const current = rpc('query', 'zones.state');
  rpc('command', 'bridge.connect', { revision: current.revision, peer });
  const connected = rpc('query', 'zones.state');
  console.log(JSON.stringify({ connected: connected.connected, peerName: connected.peerName }));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
NODE
unset BRIDGE_INVITATION
```

连接成功后，Android 在对应 Server 的主声区选歌播放。新增声区、编组及 DSP 操作从手机“声区”页面完成。Bridge 或 Server 重启后，重新取得邀请并执行连接。邀请包含连接凭据，交给需要连接的 Server 管理员。

Server 容器仅发送音频，不直接打开 NAS 的本机 DAC。独立声区支持 Native DSD／DoP 与最多 8 声道 PCM，同步组使用双声道 PCM。格式条件见 `audio-bridge-formats.md`。

## 停止、备份与更新

```sh
docker compose stop
docker compose start
```

停止会保存状态并关闭 Core。数据保存在包外的 `TWILIGHT_DATA`。备份、恢复到新目录和升级回退的完整命令见 `server-linux.md`；升级前保留旧镜像和原数据目录。恢复时继续使用容器内 `/data` 与 `/music` 路径。

## 当前交付证据

2026-11-06：Linux 公开模型重建、原生编译及 Core／SQLite／TLS 检查通过；Native DSD／DoP／多声道、组连续切曲／AutoMix 及六会话迁移通过。最终镜像以非 root 账号在无外网、只读根文件系统下完成真实模型分析、扫描、健康查询、重启持久化、快照恢复、密钥 0600 权限与归属及 SIGTERM 停服。

真实 NAS、DAC 声音／通道顺序、物理双机同步、WAN／VPN、Android Auto 和 Windows SCM／服务账号验收按计划统一进行。可选 Demucs 模型包、Python 环境与用户 VST3 插件由操作者另外提供。
