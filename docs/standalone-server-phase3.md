# 第三阶段：独立 Server、服务宿主与离线升级回退已打通

更新：2026-11-05。

**DSP 管理更新：** 手机和 CLI 现可管理各声区的 IR、校正 EQ、VST3 预设／状态、自定义场景、插件扫描、`.tedsp` 配置包预览／导入导出及参数覆盖。当前交付为 `-profiles-20261104.zip`，导入新增未启用场景，保留当前选择。入口、验证和剩余范围见[DSP 日常管理](./server-dsp-library.md)。

现在可以在没有 Electron、桌面窗口或渲染进程的情况下运行 Core。独立 Server 复用原有业务 Core、SQLite、音频服务和 TLS 遥控协议；已经具备 Windows x64 自包含 ZIP、命令行管理、手机配对、原生 Windows 服务宿主、离线备份／恢复、可回退升级，以及桌面个人数据、多 Zone／同步组、业务设置和 DSP 资产整包迁移。手机已加入 Focus、标签目录、Server 歌单和任意声区／同步组的选歌与队列工作区，见[使用记录](./session-queues-mobile.md)。服务宿主已用同一控制器的 `--console` 入口验证真实音频链路；SCM 安装和服务账号运行验收尚未执行。Linux x86_64 容器构建、Compose、健康检查和包外备份／候选目录恢复入口已接入源码，实际镜像构建及运行等待可用环境，见 [Linux 部署](./server-linux.md)。

## Windows ZIP 解压即可运行，不依赖全局 Node

**11 月 4 日工作区版：** [Windows x64 ZIP](D:/Project/Twilight_Echo/dist/TwilightEchoServer-1.4.0-win32-x64-workspace-20261104.zip)含新声区队列接口、远程资料／图片运行时和手机工作区所需协议。与本轮 Android 一起使用；最终归档解压后的自包含、TLS／PCM 和新队列链路验证见[交付记录](./session-queues-mobile.md)。下方升级版保留为旧包兼容入口。

本机升级版：[Windows x64 ZIP](D:/Project/Twilight_Echo/dist/TwilightEchoServer-1.4.0-win32-x64-upgrade.zip) · [传输校验文件](D:/Project/Twilight_Echo/dist/TwilightEchoServer-1.4.0-win32-x64-upgrade.zip.sha256)。这是包含新维护入口的本地交付包，应用版本仍为 1.4.0。先前的[原始包](D:/Project/Twilight_Echo/dist/TwilightEchoServer-1.4.0-win32-x64.zip)保留，供旧包兼容与回退验证，不原地覆盖。

升级版 ZIP 为 **102,505,935 字节、5,637 个文件**。从最终归档实际解压后，包内 Node／依赖检查与原生宿主的 TLS／卷积／模拟 DAC PCM 联调均通过：[归档运行记录](D:/Project/Twilight_Echo/.server-upgrade-delivery-tests.log)。依赖闭包、暂存清理及 README 新旧包／回退路径的 4 项检查通过：[打包单元记录](D:/Project/Twilight_Echo/.server-upgrade-readme-tests.log)。

将 ZIP 解压到独立的版本目录，数据保存在包外。包内含 Node 24 x64、生产依赖、原生音频／DSP 与服务宿主、Web 遥控资源、内置插件和许可证；不需要 Electron、npm 或源码仓库。

```powershell
cd 'D:\Apps\TwilightEchoServer-1.4.0-win32-x64-upgrade'
.\server.cmd init --data 'D:\ServerData\TwilightEcho' --library 'D:\Music'
.\service-console.cmd --data 'D:\ServerData\TwilightEcho'

# 在另一个终端查询或正常停止：
.\server.cmd status --data 'D:\ServerData\TwilightEcho'
.\server.cmd stop --data 'D:\ServerData\TwilightEcho'
```

`service-console.cmd` 使用包内 Node 和原生宿主，沿用服务的 Bridge-only、就绪／正常停止和 Job 清理；不会注册 Windows Service 或打开本机 DAC。`server.cmd` 提供原 CLI 的全部管理、备份和迁移操作；需要交互式本机输出的 `start` 入口也仍保留。现有服务管理脚本可通过包根 `manage-service.ps1` 调用，自动指定包内 Node／应用路径；PowerShell 7 下默认只显示 LocalService、手动启动的部署计划，注册仍需明确 `-Action Install -Apply`。

ZIP 附有同名 `.sha256`，沿用现有发布资产的传输完整性格式。依赖保留仓库既有 hoisted 安装布局、必要的嵌套版本和共享模块身份，不把每层依赖重复嵌套，也不把同名不同版本强行合并。普通运行只需 Windows；服务管理脚本另需 PowerShell 7。Python 运行环境、用户 VST3 模块／许可证及账号凭据不在包中。

### 从已安装依赖构建新的 Server 包

构建机沿用仓库现有 Node 24、生产依赖、原生音频资源和 CMake／MinGW 工具链。运行时只从这些已安装内容复制，不运行依赖安装或生命周期脚本。目录和 ZIP 目标必须尚不存在，其父目录须存在：

```powershell
cd D:\Project\Twilight_Echo
node --run package:server -- `
  --to 'C:\Builds\TwilightEchoServer-1.4.0-win32-x64' `
  --zip 'D:\Backups\TwilightEchoServer-1.4.0-win32-x64.zip'
```

`--node` 可指定另一个 Node 24 Windows x64 可执行文件；更换版本时需用 `--node-license` 提供该发行版完整 LICENSE。默认使用当前 Node，已纳入 v24.21.0 的上游完整许可证。

打包在独立临时目录完成后才发布。生产依赖保留已安装的嵌套版本、peer 和可用 optional 依赖，缺少必要模块时失败；不会借源码仓库的父级依赖冒充闭合。排除 Electron 专用工具、开发依赖和测试目录，保留第三方许可证。自有原生产品只在副本上剥离符号；DLL 闭包、公开 AutoMix 资产及能力清单复用既有发布检查。源目录和正在使用的音频 DLL 不改写。

离线升级入口会在独立数据副本上验证新旧运行时，再切换活动入口。具体命令见下方“新版本验证通过后才切换入口”；不覆盖运行中的版本目录。

## 在独立数据目录启动

以下是源码开发入口，需要 Node 24、本仓库已安装的依赖及 `resources/audio-engine` 原生运行时；普通使用可改用上方自包含 ZIP。构建不会安装系统服务。

```powershell
cd D:\Project\Twilight_Echo
node --run build:server

$data = Join-Path $env:LOCALAPPDATA 'TwilightEchoServer'
node out/server/server.cjs init --data $data --library 'D:\Music'
node out/server/server.cjs start --data $data
```

`--library` 可以重复指定。`init` 只接受空目录，不能指向桌面端配置；已有个人数据使用下方 `migrate` 入口导入到新目录。数据目录含 TLS 私钥与本机管理凭据，应放在仅服务账号和管理用户可访问的位置。

`start` 在当前终端前台运行。另一个终端可以管理它：

```powershell
$data = Join-Path $env:LOCALAPPDATA 'TwilightEchoServer'
node D:\Project\Twilight_Echo\out\server\server.cjs status --data $data
node D:\Project\Twilight_Echo\out\server\server.cjs stop --data $data
```

`status` 返回 Core phase、epoch、最近故障及各独立进程 PID。正常停止等待 Core 最终持久化、音频停音及全部所属进程退出，然后移除管理入口与目录锁；再次启动前没有旧数据库写进程。

若持久化失败，管理入口保留；检查状态后，可明确执行 `stop --force` 放弃最后一次持久化。进程意外退出留下锁时，`unlock --data ...` 只在锁中 PID 已不存在时移除旧锁，不终止进程，也不删除音乐或数据库。

## 从桌面个人数据备份迁入 Server

在桌面设置的 **“个人数据备份与迁移”** 导出 JSON。[迁移入口](D:/Project/Twilight_Echo/src/main/server/migration.ts) 接受现有 v1／v2 格式，复用原有预览、SQLite CAS、恢复日志和 Core 状态恢复合同，不读取或复制活动桌面配置目录。

音乐路径不变时，先查看预览，再执行：

```powershell
$data = 'D:\ServerData\TwilightEcho'
node out/server/server.cjs migrate --from 'D:\Backups\desktop-personal.json' `
  --data $data --library 'D:\Music'
node out/server/server.cjs migrate --from 'D:\Backups\desktop-personal.json' `
  --data $data --library 'D:\Music' --apply
```

目标父目录须存在，目标数据目录须尚不存在。默认预览只使用临时数据库，不创建目标；`--apply` 才建立并填充新 Profile，迁移期间持有与 Server 启动相同的目录锁。失败清理本次创建的不完整目标，保留源备份和已有目录。目录授权只来自明确提供的 `--library`，不会根据备份内容扩大授权。

需要换盘或选择恢复项目时，用 `--options 'D:\Backups\restore-options.json'` 指定原 `PersonalRestoreOptions`。以下例子将旧目录映射到新目录，并选择全部个人数据域；也可明确减少 `domains`：

```json
{
  "conflict": "use-backup",
  "mappings": [{ "from": "C:/Old", "to": "D:/Music" }],
  "domains": [
    "library", "playlists", "queue", "playback", "lyrics", "bookmarks",
    "radio", "podcasts", "statistics", "versions", "music"
  ]
}
```

未提供 options 时，选择备份中全部已有域，冲突策略为 `use-backup`；v1 没有 `music` 域。JSON 预览中的 `roots` 是原备份目录，`mappedRoots` 是本次经过授权的实际目录。v2 同时恢复音乐整理的收藏、评分、标签、Focus、手工资料和图片；缺少来源的引用沿用原备份的离线锚点规则。

迁移成功记录在 `$data\server-migration.json`。原恢复模式一并保留：`trackAndPosition` 恢复曲目和位置，`track` 从曲首恢复，`off` 不恢复当前会话；如果同时导入设置备份，其中明确提供的恢复模式优先。恢复的会话保持暂停，输出选择 Bridge 但未连接；请重新授权输出桥。新 Server 生成自己的 TLS 身份并重新配对，不带入桌面账号登录、设备授权或插件凭据。

### 同时带入主 Zone 的设置、场景与脉冲响应

桌面的设置备份 JSON 与 DSP 页面导出的 `.tedsp` 可以与个人数据一起迁移：

```powershell
node out/server/server.cjs migrate --from 'D:\Backups\desktop-personal.json' `
  --data $data --library 'D:\Music' `
  --settings 'D:\Backups\desktop-settings.json' --dsp 'D:\Backups\room.tedsp'
# 核对预览后，对同一命令增加 --apply。
```

`--settings` 接受原有平面／v2 设置备份；迁移其中明确提供的业务字段：语言、曲库监视／识别与歌词策略、播放恢复／上一首／模式／音量／睡眠计时、音源质量，以及处理参数、EQ 预设／自动余量、耳机补偿、场景和固定场景。主题、窗口和设备界面设置不属于 Server 配置；设备、路径、远程监听和授权也不会从设置备份接管。

`--dsp` 使用现有 `.tedsp` 格式及资产校验合同，导入场景、规则、固定关系和内嵌 IR／校正／VST3 状态资产；与设置备份同时提供时，以该包的场景列表和固定场景为准。VST3 模块和许可证不随包安装，预览的 `vst3References` 列出需要在新服务环境重新扫描／关联的引用。缺失的托管 IR 不会被包中附加的任意路径替代。

旧式卷积如果还引用外部文件，可用同一 `--options` 映射其路径，并明确授权相应根目录；也可增加 `--impulse 'D:\Backups\my-room.wav'`，把该文件迁入新 Profile 的托管资产库，并替换原旧式卷积路径。后者不用把 IR 目录当作音乐目录扫描，不改变其他场景所用的不同 IR。场景的设备／格式规则保持原值；连接新 Bridge 后按实际设备检查匹配条件。

音乐文件、外部插件和其他 Zone／同步组配置不在个人数据 JSON 中。多会话改用下方整包入口；两种格式都不是整个桌面 Profile 的逐字节克隆。

## 一次迁入多个 Zone、同步组和各自 DSP

先正常退出桌面端及其后台服务，将 `$desktop` 设为实际数据目录。来源须已完成 Core／SQLite 数据迁移。以下命令只读来源，在私有临时副本上转换，再发布到尚不存在的包目录：

```powershell
$desktop = 'D:\DesktopData\TwilightEcho'
$bundle = 'D:\Backups\TwilightEcho-migration'
node D:\Project\Twilight_Echo\out\server\server.cjs export-migration `
  --from $desktop --to $bundle --stopped

# 与单份个人 JSON 相同：先预览，核对后对同一命令增加 --apply。
node D:\Project\Twilight_Echo\out\server\server.cjs migrate --from $bundle `
  --data 'D:\ServerData\TwilightEcho-migrated' --library 'D:\Music'
```

`--stopped` 是操作者对已正常退出的明确确认，**不会自动检测或停止 Electron**。若来源本身是 Server，还须能取得 Profile 锁；运行中或遗留锁未解除时拒绝导出。来源目录中的链接不会被遍历。缺失会话目录、损坏设置或缺失 DSP 资产会使导出失败，不用默认数据替代。

整包包含：

- 原个人备份支持的数据域，以及最多 4 个 Zone、2 个互不重叠同步组的名称、成员和下游延迟（毫秒）。
- 每个当前会话的重复 occurrence、选中项、位置、显示顺序和原始顺序。逐 Zone／组使用独立 SQL 导入身份及持久引用，主会话仍保留原 `core-session-<revision>` 合同。
- 命名 SQL 队列转成可携带的数组；沿用原恢复合同，捕获当前共享队列的内容／游标，保留命名会话自身的位置和模式。原始顺序单独保存，不把大数组塞入 2 MiB 的会话状态文件。
- 每个物理 Zone 的业务设置、DSP 场景／规则／固定关系和托管资产。设置只导出 Server 的业务字段；不带桌面 UI、设备、远程监听或信任配置。
- 主会话的心动／喜欢列表、心动原队列、离开队列的推荐曲目和个性化电台延续信息。它们使用独立上下文文件，不改变原个人 JSON 的无 SQL 引用格式；导入后重新绑定新队列。预览 `additional.playbackContexts` 列出相关上下文及心动原队列数量。

原始顺序文件和上下文在预览时即检查，失败不会退化成普通队列。队列和命名会话仍遵守现有格式容量，超过时明确拒绝，不截断。

外部原始 IR 不会沿设置路径自动读取。可重复提供 `--asset-root 'D:\RoomCorrection'` 授权需要的目录；导出器把场景中的原始 IR 转为 `.tedsp` 托管资产，旧式卷积另带显式 IR 文件。来源内的托管 IR 根目录已在授权范围，无须额外开给音乐扫描器。资产随包移动，音乐路径则使用前述 `--options` 映射，并明确提供新 `--library` 根目录。取消 `playback` 域会同时取消所有当前 Zone／组播放会话的恢复，仍迁入拓扑和成员配置。

包不包含音乐文件、Chromium 数据、账号／插件登录凭据、TLS 身份、Bridge 信任或 VST3 模块／许可证。新 Server 的所有输出保持断连；重新授权 Bridge，在线续播前重新登录相应音源。普通、心动、脱离队列推荐和个性化电台均已在实际生产 Core 中恢复为暂停，恢复本身不会自动续播。

## Windows Service 负责常驻，Bridge 负责 DAC

[原生宿主](D:/Project/Twilight_Echo/native/server-service/service_host.cpp) 对接 Windows SCM：只有 Core 和本机管理均就绪，才报告 RUNNING。STOP、SHUTDOWN 和 PRESHUTDOWN 均经过 Core 持久化及所属进程退出屏障。普通停止失败或超时返回 RUNNING，保留本机管理；系统关机的失败／期限则报告错误并终止自己拥有的 Job。

Node 在挂起状态下加入带 `KILL_ON_JOB_CLOSE` 的专属 Job 后才开始执行；Core、数据库和各音频进程均在其中。宿主异常退出不会留下所属后台进程；其他播放器与服务不在该 Job 中。

服务模式只向远端输出桥发送音频，不枚举为可用本机输出，也拒绝本机选择和接收器托管。连接 DAC 的电脑应运行交互式 Bridge。控制台 `start` 的既有本机播放方式不变。

构建与只读部署计划：

```powershell
cd D:\Project\Twilight_Echo
node --run build:server
node --run build:server-service
pwsh -NoProfile -File scripts/manage-server-service.ps1 -Data $data
```

[管理脚本](D:/Project/Twilight_Echo/scripts/manage-server-service.ps1) 要求 PowerShell 7；默认只输出计划，即使指定 `-Action Install`，没有 `-Apply` 也不注册服务。计划使用 **LocalService、手动启动**，不使用 LocalSystem、不自动启动、不更改应用或音乐目录权限。服务账号必须能读取应用、Node、依赖和音乐，并可写入独立私有数据目录。

后续经明确安排安装时，在管理员 PowerShell 使用 `-Action Install -Apply`，然后用 `Start -Apply` 启动；`Status` 同时查询 SCM 和 Core。本轮未执行这些写操作。可选 `-GrantProfileAccess` 仅适用于刚 `init`、尚未运行的独立目录：先保存目录 DACL，再为 SYSTEM、管理员、当前管理用户和 LocalService 设置权限；注册失败恢复目录 DACL。已有数据目录的权限由管理员另行配置。`Stop -Apply` 请求正常停止；`Remove -Apply` 仅移除已停止的服务注册，保留数据。

不安装服务的完整生命周期入口：

```powershell
.\out\server-service\twilight-server-service.exe --console `
  --node 'C:\Program Files\nodejs\node.exe' `
  --entry 'D:\Project\Twilight_Echo\out\server\server.cjs' --data $data
```

该入口使用相同的子进程协议与 Job 控制器，但不经过 SCM 账号切换。日志位于 `$data\server-service.log`；本机 `status`、`rpc` 和 `stop` 仍可用。

## 新版本验证通过后才切换入口

先正常停止原实例；如果注册为 Windows Service，还需由操作者正常停止服务，使 SCM 状态为 `Stopped`。把新包解压到**另一个版本目录**，保留旧包。下面从新包运行维护 CLI，默认只预览：

```powershell
$old = 'D:\Apps\TwilightEchoServer-old'
$new = 'D:\Apps\TwilightEchoServer-new'
$data = 'D:\ServerData\TwilightEcho'
$work = 'D:\ServerData\Upgrade-01'
& "$new\server.cmd" upgrade --from $old --to $new --data $data --work $work
# 核对目录后执行；work 必须尚不存在，父目录须存在且保持私有。
& "$new\server.cmd" upgrade --from $old --to $new --data $data --work $work --apply

& "$new\server.cmd" upgrade-status --work $work
pwsh -File "$work\service-console.ps1"
# 另一个终端查询／停止当前活动实例：
pwsh -File "$work\server.ps1" status
pwsh -File "$work\server.ps1" stop
```

升级期间持有原 Profile 锁，先在 `work\before-upgrade` 创建完整离线快照，再恢复到 `work\candidate`。旧包和新包依次在这个副本启动原生宿主：Core、本机管理、所有 Zone／同步组须恢复，输出须保持 Bridge 断连且不自动播放，最后正常停止并清除运行锁。全部通过才把 `upgrade.json` 的活动入口切到新包和候选数据。

原数据目录和旧包不变。副本内的托管缓存、各会话托管 DSP 目录中的绝对 IR 引用重绑到副本；音乐、下载目的地、外部 IR／插件及用户文本保持原意义。TLS 身份与已配对设备保留，本机管理令牌每次启动重建。工作目录和快照含长期凭据，不能用作分享包。

`server.ps1` 与 `service-console.ps1` 根据活动记录选用包内 Node／原生宿主及数据目录，不接受 `--data` 覆盖。后续管理继续通过新包 CLI；回退后被选中的旧包可能没有新维护命令。

### 注册服务只更换入口，不改账号或自动启动

已注册的服务可在上述 upgrade 命令中增加 `--service TwilightEchoServer`；预览只查询现状，`--apply` 需管理员 PowerShell。服务原入口必须精确对应指定旧包／数据目录，并保持 `Stopped`。程序只向**新建的数据副本**复制原数据目录的有效访问规则，验证完毕后更改该服务的 `PathName`，保留原账号和启动方式，服务仍为停止状态。

新版本目录、音乐和外部资源的读取权限仍由部署管理员提供。此路径的软件测试注入 SCM 接口；实际注册、权限复制及服务账号运行按计划后置验收。

### 回退使用升级前快照，新版数据另行保留

正常停止活动实例／已注册服务后，先预览，再执行：

```powershell
& "$new\server.cmd" rollback --work $work
& "$new\server.cmd" rollback --work $work --apply
& "$new\server.cmd" upgrade-status --work $work
```

回退把升级前快照恢复到另一个新的 `rollback-<ID>` 目录，以旧包启动、检查和正常停止后才切换入口。**升级后的更改不会合入回退数据**；新版候选目录完整保留，可另行处理其中的更改。旧原目录、快照和两个版本包均保留。

### 切换响应丢失时先确认实际入口

服务切换前持久记录 pending 转换。如果 SCM 响应丢失或提交中断，启动脚本拒绝不确定状态。先正常停止相关实例，再从新包检查并恢复：

```powershell
& "$new\server.cmd" upgrade-status --work $work
& "$new\server.cmd" upgrade-recover --work $work
& "$new\server.cmd" upgrade-recover --work $work --apply
```

恢复重新检查服务实际入口和候选 Core；已经生效的 SCM 更改不会重复发送。其他管理员修改过的入口或运行中服务会使操作停止，原配置不会被覆盖。有 pending 转换时先恢复该转换，不能直接用另一轮 rollback 覆写记录。

进程异常退出留下锁时，`upgrade-unlock --work $work` 只解除已退出 PID 的操作／受管副本锁；原 Profile 锁还必须属于该次操作。仍存在的进程不会被结束，运行中实例的锁不会被移除。解除锁不是切换提交；之后仍按 `upgrade-status` 选择恢复或回退。

## 单独备份／恢复也使用新目录

Server 正常停止后，可执行：

```powershell
node out/server/server.cjs backup --data $data --to 'D:\Backups\TwilightEcho-before-upgrade'
node out/server/server.cjs restore --from 'D:\Backups\TwilightEcho-before-upgrade' `
  --data 'D:\ServerData\TwilightEcho-restored'
```

备份与恢复目标均须为**尚不存在的新目录**，其父目录须已存在。备份获取同一 Profile 锁，运行中或遗留锁尚未解除时拒绝操作。数据先写入独立临时目录，完成清单及 SQLite `quick_check` 后才发布；失败不覆盖源数据或既有目标。

快照保留数据目录内的 SQLite、Zone／组记录、DSP 资产、设置、TLS 身份和已配对设备；不复制运行锁、每次启动的管理地址／令牌或服务日志。目录中的链接会明确拒绝，不沿链接复制外部资源。音乐、外部脉冲／插件及其他目录仍需独立备份；路径保持原值，不自动重映射。

快照含长期凭据，应保存在私有目录中，不作为分享包。恢复沿用原服务器身份，应先停止原实例；新运行的本机管理令牌会重新生成。恢复要求相同应用版本与操作系统。单独恢复时使用生成快照的旧版程序，恢复到新目录；上方升级入口会协调新旧运行时，沿用这个版本约束。`migrate` 使用的个人 JSON／桌面整包与完整 Server 快照格式不同。

## 手机通过 TLS 配对，管理员核对验证码

新配置默认关闭遥控。先在 Server 所在电脑执行：

```powershell
node D:\Project\Twilight_Echo\out\server\server.cjs remote-on --data $data
node D:\Project\Twilight_Echo\out\server\server.cjs remote-status --data $data
```

Android 使用现有电脑发现／连接流程。手机提交请求并显示六位验证码后，`remote-status` 列出待确认设备、来源地址、请求 ID 和验证码。**先核对手机上的六位数字**，再执行：

```powershell
node D:\Project\Twilight_Echo\out\server\server.cjs allow-pairing --data $data --id '<请求 ID>' --code '<手机六位验证码>'
```

验证码错误、请求过期或尚未揭示随机数时，不会批准。待确认请求由现有 Core 配对状态机持有；没有窗口时不会自动同意或降级为明文设备令牌。配对身份和证书继续使用原持久化机制。`remote-off` 关闭遥控；已启用的遥控设置会在正常重启时恢复。

## 管理入口与进程边界

- [Node 宿主](D:/Project/Twilight_Echo/src/main/server/nodeHost.ts) 使用独立 Node 进程运行 Core、数据库、扫描、分析、插件及逐 Zone 音频服务。没有改成共享进程内的 worker，也没有复制业务状态机。
- 监督进程只建立回环 socket 对并转移连接句柄；两端均交给所属子进程后关闭监听器。请求／响应直接在 Core 与服务间传输。V8 帧支持 `ArrayBuffer`、typed array、Map 和 bigint；32 MiB 分片用例通过。
- [bootstrap](D:/Project/Twilight_Echo/src/main/server/bootstrap.ts) 在载入原生产入口前提供现有 parent-port 合同。父进程失联时，服务收到关闭事件；音频服务沿原停音处理退出。私有通道不重连、不重放业务写入。
- Windows 本机管理使用随机命名管道和每次启动生成的 256 位管理令牌，运行地址保存在数据目录内。管理入口不绑定 LAN TCP 端口。非 Windows 的代码路径使用 Unix socket，尚未完成 Linux 部署验收。
- 新 `server-admin` 身份由本机宿主分配。它可在原 settings 权限之上授权 Bridge／Zone 配置；网络 RPC 不能提交该身份。`remote`、`system`、插件和 mini-player 的原限制保留。需要桌面文件对话框的能力没有伪造为成功。
- 音乐／VST3 目录授权来自 `server.json`，请求中的 settings 路径不能扩大授权。沿用 canonical path 检查，拒绝通过 junction／symlink 越界。当前缓存固定在独立数据目录；VST3 搜索根需在停止 Server 后明确写入配置。
- Node 原生模块候选路径已经锚定 `out/server` 所属应用根，不受启动终端所在目录影响。

高级本机管理可使用 `rpc --request <JSON 文件>`。文件遵循现有 `CoreRequestEnvelope`，包括 `kind`、`name`、`payload`、从 `status` 读取的 `epoch` 和新 `requestId`。原 revision／occurrence 栅栏继续生效；命令超时或连接丢失后先刷新，不自动重发。服务内的 Core 仍是唯一队列、Zone 和同步组所有者。

## 已通过的软件证据

复现：

```powershell
cd D:\Project\Twilight_Echo
node --run test:server
node --run test:server-service # Windows，构建原生宿主；不注册系统服务
node --run test:server-package # Windows，自包含 ZIP 解压后运行；不注册系统服务
node --run test:server-upgrade # Windows，候选与回退隔离副本；不修改 SCM
```

该入口已加入原无真实设备检查链。

- **原有 6 项宿主专项通过**：双子进程直接传输二进制；分片／合帧及 32 MiB 消息；canonical 授权与越界拒绝；封面投影；独立配置／目录锁；持久化失败后保留管理与明确强制停止。
- **2 项真实生产入口联调通过**。测试给每个 Node 子进程安装“任何 `require('electron')` 均失败”的加载钩子，实际 Core、SQLite、原生音频服务、扫描器依然运行。数据库进程故障后重新打开；Core 故障触发原有一次恢复，旧 epoch 被拒绝；同步组的共同 SQL 队列与成员关系恢复为暂停，解除后可正常关闭。服务业务消息经过监督通道的数量为 **0**。
- CLI 从与仓库不同的工作目录启动，扫描临时 WAV，完成本机错误令牌拒绝、真实 TLS 连接、双端验证码核对、拒绝错误验证码、明确批准、已配对遥控和无本机路径的曲库查询。停止后进程清单为空，管理记录与目录锁消失。配置目录缺失导致启动失败时，锁也正确释放。
- 同一 CLI 联调进一步用已配对的模拟手机发送 TLS `zones.transport`，经过真实 Core、SQL 队列、独立 Node 音频服务、原生解码／SRC 与输出音量处理，将 8 kHz 单声道 WAV 变为 48 kHz 双声道 PCM，送到 TLS 模拟 DAC；采样 RMS 为 **0.08750**，随后由手机明确暂停。该检查还修正了 CLI 对无返回值命令输出字面 `undefined` 的问题，现在输出合法 JSON `null`。日志：[完整手机→Core→Bridge PCM 路径](D:/Project/Twilight_Echo/.server-cli-pcm-accepted.log)。
- 原私有通道／生命周期检查：[日志](D:/Project/Twilight_Echo/.server-final-gate.log)。注入 Core／数据库故障产生的退出日志是相应用例的输入。PCM 扩展的初次模拟 DAC 未复现原生 `BridgeReceiver::write` 的预缓冲后自动启动，停在 3 个 PCM 块；按原生合同修正夹具后通过，没有修改生产播放／DSP 路径或换用另一种音源。[诊断记录](D:/Project/Twilight_Echo/.server-cli-pcm-diagnostic.log)。
- 应用权限／原生路径／私有通道的 **39 项回归通过**，含旧桌面、远程、system、插件与 mini-player 的角色限制：[日志](D:/Project/Twilight_Echo/.server-host-regression-final.log)。
- Core／Node／Web 类型检查与桌面构建结果见：[Core](D:/Project/Twilight_Echo/.server-core-typecheck.log)、[Node](D:/Project/Twilight_Echo/.server-node-typecheck-release.log)、[Web](D:/Project/Twilight_Echo/.server-web-typecheck.log)、[桌面构建](D:/Project/Twilight_Echo/.server-desktop-build.log)。
- **9 项原生服务生命周期通过**：就绪后 RUNNING、正常停止、停止失败后重试、启动超时、根进程异常、假 STOPPED 遗留子进程、关机失败、普通停止期限和关机期限，以及宿主被结束时的 Job 清理。最终宿主还为 SCM 状态查询／发布加锁，避免控制回调与运行循环并发访问状态结构；重编译后，9 项生命周期、真实 PCM 链路与只读管理计划共 **11 项通过**：[最终日志](D:/Project/Twilight_Echo/.service-native-final.log)。测试的分离子进程避开 Node 自己的子进程 Job，实际检查的是原生宿主的 Job；使用的都是夹具，不打开 DAC。
- **两种服务入口的真实 PCM 链路通过**：直接 `service-child` 与原生 `--console` 均完成扫描、鉴权、双端配对、TLS 模拟手机控制、真实解码／SRC、模拟 DAC 接收和暂停；PCM RMS 均为 **0.08750367525137642**。直接子进程从私有 stdin 正常停止；原生宿主从本机 CLI 停止，并确认 `ownedRemaining=0`。[日志](D:/Project/Twilight_Echo/.service-server-pcm-accepted.log)。服务模式拒绝本机 DAC 的专项及原有 Bridge 行为共 4 项通过：[日志](D:/Project/Twilight_Echo/.service-source-tests.log)。
- **只读部署计划通过**：默认计划及未带 `-Apply` 的 Install 均不改变临时 Profile，中文／空格／单引号路径保持正确，账号为 LocalService。[日志](D:/Project/Twilight_Echo/.service-management-plan.log)。实际 SCM 注册、ACL 授权与服务账号启动仍待后置部署验收。
- **5 项快照专项通过**：SQLite／TLS／DSP 文件保留、活动锁与覆盖拒绝、不完整／缺失／错误版本拒绝、同大小 SQLite 损坏拒绝、链接拒绝及失败解锁。[日志](D:/Project/Twilight_Echo/.server-maintenance-tests.log)。真实生产 Core 的扩展 CLI 联调又验证了备份→恢复→重启：曲库数量、SQL 队列 ID／occurrence 保留，Zone 暂停且输出未连接，原 TLS 配对仍能访问，新管理令牌不同。[日志](D:/Project/Twilight_Echo/.server-snapshot-core-accepted.log)。
- 本轮服务策略变更后的 [Core 类型检查](D:/Project/Twilight_Echo/.service-core-typecheck.log)、[Node 类型检查](D:/Project/Twilight_Echo/.service-node-typecheck.log)、[Web 类型检查](D:/Project/Twilight_Echo/.service-web-typecheck.log)、[桌面构建](D:/Project/Twilight_Echo/.service-desktop-build.log)均通过；新增维护模块后的 [Node 类型检查](D:/Project/Twilight_Echo/.server-maintenance-node-typecheck.log)通过。
- **桌面迁移的 4 项专项通过**：v1 全部个人域与 Core 统计／版本恢复；真实 v2 导出后的收藏、评分、标签、Focus、歌单与路径映射；目录授权／已有目标拒绝；恢复中途失败时仅清理新目标。[日志](D:/Project/Twilight_Echo/.server-migration-source-final.log)。两项 CLI→真实生产 Core 联调均通过：两次重复曲目及选中的第二个 occurrence、12 秒位置、暂停状态、20 秒统计均保留，未连接输出且硬件事实为空。[日志](D:/Project/Twilight_Echo/.server-migration-core-accepted.log)。v2 还通过启动扫描后的在库标签→录音→评分／收藏以及 Focus 命中查询，证明不是只保留空壳名称：[日志](D:/Project/Twilight_Echo/.server-migration-v2-links.log)。
- 迁移联调发现原恢复合同会生成仅含曲库目录的 settings 文件，正常加载将缺失的恢复模式设为 `off`。迁移现在先在新 Profile 种入备份中的模式，保留原桌面设置／规范化合同。旧统计夹具没有最近播放时间，查询按 `seconds` 而非默认 `recent` 检查已有计数。新增迁移模块后的 [Node 类型检查](D:/Project/Twilight_Echo/.server-migration-node-typecheck.log)通过。
- **设置／DSP 迁移通过**：5 项专项覆盖业务字段与主机授权隔离、部分设置导入、原 `.tedsp` 场景与资产内容、显式迁入旧式 IR、缺失资产拒绝、预览和最终 Profile 交付：[日志](D:/Project/Twilight_Echo/.server-configuration-fields.log)。DSP 授权提取为同一共享实现，原设置恢复与新迁移使用相同路径／资产规则；DSP／个人迁移回归共 23 项通过：[日志](D:/Project/Twilight_Echo/.server-configuration-source-final.log)。旧式卷积引用托管 IR 时也纳入引用计数，只有明确清除路径后才允许删除。
- **迁入配置实际作用于音频**：由已有设置备份和 `.tedsp` 建立新 Server，配对后的 TLS 模拟手机控制主 Zone；真实解码／SRC／卷积／余量处理后，经 TLS 送到模拟 DAC。音量 **0.42**、单抽头 IR **0.5**、余量 **−6 dB**，原生图报告 `room`／`applied`／`ready`，卷积启用且未旁路，稳态采样 RMS **0.0131565274**。解析预期为 `(0.25/√2) × (1/√2) × 0.42 × 0.5 × 10^(−6/20) = 0.0131561649`，第二个 `1/√2` 来自 FFmpeg 默认 mono FC→stereo FL／FR 混音，实际偏差约 0.0028%，在 2% 容差内。随后手机暂停，并完成该 Profile 的快照恢复／重启：[日志](D:/Project/Twilight_Echo/.server-configuration-pcm-accepted.log)。采样窗口位于卷积启动延迟之后。
- 本次新增共享 DSP 授权及引用保护后的 [Core 类型检查](D:/Project/Twilight_Echo/.server-configuration-core-typecheck.log)、[Node 类型检查](D:/Project/Twilight_Echo/.server-configuration-node-typecheck-final.log)和[桌面构建](D:/Project/Twilight_Echo/.server-configuration-desktop-build.log)通过。
- **多会话整包专项 11 项通过**：实际 SQLite 来源的 6 个同 revision 会话、两种顺序、重复选中项、命名 SQL 会话转换、逐成员 DSP／资产、路径映射与播放域选择；显式停止确认、活动锁、覆盖／越界／坏拓扑／缺失资产拒绝；原目录内容保持不变。还覆盖心动原队列／模式、喜欢列表、脱离队列推荐及个性化电台上下文，错误上下文在预览中拒绝：[日志](D:/Project/Twilight_Echo/.desktop-bundle-context-source.log)。
- **扩展 Server 固定入口通过**：31 项源模块检查和 10 项生产入口联调全部通过，其中 4 项是普通、心动、脱离队列推荐、个性化电台整包迁入。每项实际启动无 Electron 的服务 Core：4 个 Zone、2 个同步组的 SQL 队列互不重名，位置分别为 10／11／12／13／14／15 秒，全部暂停，成员 DSP 保留，硬件为空，解除两组后独立会话仍可用并正常关闭。原 TLS PCM／卷积和 Server 快照联调也保持通过：[日志](D:/Project/Twilight_Echo/.desktop-bundle-server-gate.log)。
- **队列／旧调用回归 220 项通过**：原普通会话、Zone、SQL 队列身份／GC、持久恢复与心动原队列引用保护；默认 SQL 导出仍只返回原三个字段，新迁移调用才附带原始顺序：[日志](D:/Project/Twilight_Echo/.desktop-bundle-queue-regression.log)。本次 [Core 类型检查](D:/Project/Twilight_Echo/.desktop-bundle-core-types.log)、[Node 类型检查](D:/Project/Twilight_Echo/.desktop-bundle-node-types.log)和[桌面构建](D:/Project/Twilight_Echo/.desktop-bundle-desktop-build.log)通过。
- **自包含交付 6 项检查通过**：生产依赖版本／peer／optional／循环与缺失项、嵌套版本和 builtin 同名包、失败发布清理、链接拒绝、README 绝对路径，以及 ZIP 真实解压后的运行入口。使用包内 Node **v24.21.0**、**283 个实际安装包位置**；没有 Electron、Vite 或 TypeScript。测试将 `NODE_PATH` 清空、`PATH` 缩为 Windows System32，并在各 Node 子进程阻止包外 CJS 模块加载；从源码仓库之外、含中文／空格／单引号的目录启动原生服务宿主，完成扫描、本机鉴权、TLS 双端配对、原生解码／SRC／卷积和模拟 DAC 接收，PCM RMS **0.0131565274**，然后正常停止、`ownedRemaining=0`。包内服务管理仅验证只读计划：[运行日志](D:/Project/Twilight_Echo/.server-package-hoisted-final.log)、[路径用例](D:/Project/Twilight_Echo/.server-package-readme-unit.log)。最终 ZIP 的 5,636 个文件及 README 命令直接从归档读取检查：[归档记录](D:/Project/Twilight_Echo/.server-package-artifact-inspection.log)。依赖沿原 hoisted 物理布局复制，避免早期递归嵌套产生不必要的重复副本和长路径。
- **离线升级／回退的软件链路通过**：真实先前 1.4.0 包→当前代码的测试标签 1.4.1→旧包，全程使用包内 Node、原生宿主与隔离 Profile，没有 Electron 或全局模块。原 Profile 内容不变，SQL occurrence、TLS 配对、托管 IR／缓存重绑、新管理令牌及新版数据保留均通过；生成的 `service-console.ps1` 实际启动候选与回退实例，`server.ps1` 查询同一 epoch 并拒绝数据目录覆盖：[入口联调](D:/Project/Twilight_Echo/.server-upgrade-launchers-final.log)。1.4.1 仅为测试标签，本地交付仍是 1.4.0。
- **4 Zone／2 组升级回退通过**：6 个不同 SQL 队列、重复选中项、显示／原始顺序、10／11／12／13／14／15 秒位置、命名会话和逐成员 DSP／IR 均经真实旧版、新版、回退版 Core 检查；所有输出断连且硬件为空，原数据未改：[多会话联调](D:/Project/Twilight_Echo/.server-upgrade-zones-final.log)。此用例发现回退临时目录超出 Windows 普通 SQLite 路径限制；最小复现确认后，维护检查改用 Windows 扩展长度路径，新增同类快照恢复回归。
- **升级后 Server 固定入口 46 项源测试及 10 项生产联调通过**，包括升级协调／不确定 SCM 回应／其他管理员改入口／死锁恢复、各会话设置与备份重绑，以及原快照、迁移、TLS PCM 和心动／推荐／电台上下文：[固定入口日志](D:/Project/Twilight_Echo/.server-upgrade-server-gate.log)。SCM 协调测试使用注入接口；PowerShell 适配器仅作语法解析，和测试归属／门禁检查共 16 项通过：[门禁记录](D:/Project/Twilight_Echo/.server-upgrade-gate-wiring.log)。本次 [Core 类型检查](D:/Project/Twilight_Echo/.server-upgrade-core-types-final.log)与 [Node 类型检查](D:/Project/Twilight_Echo/.server-upgrade-node-types-final.log)通过。

服务宿主和升级验证未安装 Windows Service、启动真实 DAC 或安装 APK。按用户单项授权，仅将 `out/server-service/twilight-server-service.exe` 的强制完整性标签从继承 Low 改为显式 Medium，原标签 `S:AI(ML;ID;NW;;;LW)` 保存于本地 `.service-exe-label-original.json`。首次夹具失败时已恢复，再修正夹具并重新验证后保留 Medium；未更改目录、其他文件 DACL、Windhawk 或沙箱。未来重建／重装若再次继承 Low，仍需针对新文件确认处理。后续控制面工作已修改 Android 客户端源码；手机 UI 与实际双机／DAC 验收继续等全部计划实现后统一进行。

## 接下来完成服务化与完整控制面

1. **部署验收后置**：Windows x64 自包含运行时／依赖／ZIP 已提供；实际 SCM 注册、账号权限和开关机验收等全部计划实现后统一执行。
2. **升级已可回退**：新旧独立包、快照、候选健康检查、活动入口、回退副本和不确定切换恢复已接通。真实 SCM／服务账号验收后置。桌面当前只持有 Electron 单实例锁，没有 Server Profile 锁，整包导出仍须由操作者先正常退出；不能直接复制活动桌面目录。
3. **完整远程日常管理**：Focus、标签、评分／收藏、歌单与人工资料的 TLS RPC、实体表单和日常管理工作区已接通，新增显式声区队列接口。无 GUI 的 DSP 资产／插件管理继续实施。Server 的大图缩图与图片回显依赖随新包携带的 `twilight_image_node.node`；见[使用记录](./session-queues-mobile.md)。
4. **NAS／容器部署（2026-11-05）**：目标已确定 Linux x86_64，容器／Compose／持久目录／Profile 凭据及 CI 构建验证已接入，见 [Linux 部署](./server-linux.md)。用户确认没有可用环境，实际 Linux 镜像构建与运行仍待验收。

第四阶段已实现可达 VPN／HTTPS 地址管理、离线下载、计费网络策略与 Android Auto 浏览搜索，见 Android 仓库 `MOBILE_LIBRARY.md`。真实 WAN／车机及原后置实机验收仍待执行；第二阶段数字同步证据仍以[原记录](D:/Project/Twilight_Echo/docs/audio-zones-phase2.md)为准。
