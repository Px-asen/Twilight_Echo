# 调试会话、常驻日志与诊断包

## 复现一次问题并反馈

打开 **设置 → 系统与关于 → 日志与问题排查**，点击 **开始调试**，然后复现问题。界面会持续显示正在记录；可以填写说明并点击“标记刚刚发生的问题”，最后选择 **结束并导出调试包**。取消保存对话框会继续记录。导出失败后，本地会话仍然保留，可重新导出。

调试会话保留完整本地路径、JavaScript 堆栈文件及行列号、模块加载过程、Core 最近状态和调用关联信息。文本中的密码、Token、Cookie 和网络认证信息仍会过滤。调试模式不递归扫描用户磁盘，也不记录音频内容或任意网络请求体。

如果遇到音频进程退出、原生插件崩溃等问题，先勾选 **启用崩溃取证**，再点击 **重启并开始取证**。开始和结束都需要重启；队列和进度按应用原有退出流程保存，重启后手动继续播放。异常退出后再次启动会延续同一个调试会话。结束时先选择导出位置，应用关闭取证并重启，然后自动完成导出。

崩溃转储是可选附件，可能包含敏感内存片段，不能按文本日志的脱敏规则保证其内容安全；导出时会单独提示。所有记录只保存在本机，不自动上传。

调试数据与常驻日志分开保存在 `debug-sessions/<会话编号>/`，预算 1 GiB、保留 7 天，每个会话最多保留 3 份完成的转储。清理优先处理已结束的旧会话，待导出失败的会话保留以便重试。容量、写入错误和采集覆盖不足会显示在状态与导出包中。

状态会区分服务日志确认、Electron 采集器启用结果、原生进程附加结果和已保存的转储数量。服务在 5 秒内未确认模式切换时会报告超时；采集 helper 的启动、附加或写入失败会记录阶段及系统错误码。开启取证不代表已经产生转储。

### 在调试包中找证据

- `timeline.jsonl`：按 `debugSessionId`、`operationId`、`requestId`、进程实例和服务代次关联一次操作。
- `debug/startup/`：加载原生模块及执行原生命令前写下的记录，即使进程在返回结果之前退出也能保留。
- `debug/processes/`：Core 和后台服务最后发布的缓存。`alive`、`collectedAt`、`dataAgeMs` 区分当前状态和历史证据。导出不探测或重新启动故障音频进程。
- `debug/directories.json`、`debug/windows/`：实际目录、Windows 构建修订号、应用错误事件和进程模块清单。
- `debug/crashes/`：异常代码、异常地址、模块加载基址和可选 `.dmp`。异常地址减去所属模块加载基址得到模块偏移。
- `snapshots.json` 中的 `build.javascript`、`build.native`：发布文件与调试符号之间的身份映射。

三端桌面共用调试会话、日志和 Electron Crashpad 本地转储。Windows 的独立 Node、ASIO 和 VST3 进程在加载业务原生模块前自行注册到采集 helper，由进程外写入精简转储；采集器不会附加到 Electron 进程。macOS/Linux 独立原生辅助进程的转储暂未覆盖，状态中会明确注明。

包内 `README.md` 优先列出问题说明、关联操作编号、故障进程、异常代码和可计算的模块偏移，再列出进程最后状态与缺失证据。十六进制模块基址和异常地址在调试包中保留原值。

### 用发布符号还原代码位置

构建保留 source maps 和原生符号，发布二进制仍裁剪。符号默认归档到 `output/diagnostic-symbols/`，也可以通过 `TWILIGHT_SYMBOL_DIRECTORY` 指定保留目录。发布时应一起留存该归档；符号文件不进入用户安装包。

```powershell
# 使用诊断包中对应二进制的 artifactId 和模块偏移。
node scripts/symbolize-diagnostics.cjs --artifact <artifactId> --offset 0x5d70 --addr2line D:/tools/bin/addr2line.exe
# JavaScript 堆栈的行列号均按 1 起算。
node scripts/symbolize-diagnostics.cjs --artifact <javascriptArtifactId> --line 120 --column 8
```

MSVC PDB 使用打包的 x64 采集 helper 的只读符号解析入口；GNU 符号使用 `addr2line`。缺少对应构建的符号会直接报错，不用相近版本替代。

### 验证打包后的完整流程

```powershell
node scripts/run-debug-session-package-smoke.cjs path/to/TwilightEcho.exe
```

该命令在独立的中文和空格路径中创建测试配置，依次验证普通调试导出、启用取证后重启、utility process 真实崩溃、关闭取证后重启与自动导出；随后检查 ZIP 中的会话缓存、模块身份、转储和缺失项。结果与诊断包留在命令输出的目录。测试窗口隐藏，使用测试专用 `--no-sandbox`，不改变发布配置。

## 常驻日志

应用启动时自动开启 debug 级别日志，只保存到本机。设置 → 系统与关于 → 日志与问题排查可以查看状态、打开目录、标记刚刚发生的问题、导出 ZIP 和清理历史日志。保留最近 7 天，总容量 256 MiB，JSONL 分段 8 MiB；正在写入的文件不会被清理。写入异常或容量不足时优先保留活动文件，并在状态和包清单中注明丢失情况。

## 没声音或播放卡住时

若启动时隔离音频进程崩溃，应用仍会打开曲库和设置，保留队列与进度，播放保持停止。主界面提示“音频暂不可用”，点击“处理音频故障”可进入恢复面板。连续三次短时间退出后停止自动重启；面板显示原始进程错误，可手动重启音频引擎。恢复完成前不会自动播放，也不会改写输出设备或切换播放引擎。音频相关的可视化、AutoMix 与 DSP 初始化会在引擎恢复后补齐；文件读取、数据库和其他启动错误仍按原有失败流程处理。

打开 **设置 → 播放与音效 → 音频故障排除**。先检查系统音量和输出设备，然后：

1. **重启音频引擎**：只中断 Twilight Echo，确认旧隔离音频进程退出后重建，并恢复输出设备、DSP、音量和队列。曲目进度保留，完成后点击播放继续。
2. **重启 Windows 音频服务**：引擎重启无效时再试。先结束通话或录音；确认提示并通过 Windows 管理员授权后，应用会停止自己的音频进程，再重启 `Audiosrv` 和 `AudioEndpointBuilder`。其他应用也会短暂失去声音。取消确认不会中断播放；取消管理员授权后，应用仍会重建自己的引擎，但不自动播放。
3. 仍有问题时，点击同一区域的 **导出音频诊断**，保存 Markdown 报告和配套 JSON。完整运行日志仍可从“系统与关于”导出。

恢复期间不能开始新的播放，设置页关闭再打开也能查看任务状态。正在投放到其他设备时，需先停止投放。若系统服务重启失败或超时，界面会显示失败；检查 Windows 声音输出，必要时重启电脑。

## 排查 DSD 播放无声（#218）

先核对实际设备与传输方式。DSD 默认使用选中的输出设备；需要独立 ASIO 输出时，显式配置 `dsdRoute`。已安装的 DSD 转码器可能指向其他设备，支持 DSD 的能力探测不能证明它连接到了当前 DAC。

在 #218 的诊断包中，`2026-11-08T07:47:01Z` 前后的路由决策把 WASAPI 独占输出转到了 ASIO；随后驱动名称变为“DSD 转码器”，状态却保留了前一首 PCM 的 176400 Hz / 24-bit、`integer_passthrough_unavailable` 和 `dsdRate=0`。修复后播放不再自动选择该代理；显式独立路由的实际输出信息也不会被旧 PCM 状态覆盖。

- `dsdMode=dop` 时，24-bit 是承载 DSD 数据的 DoP 容器。44.1 kHz 系列 DSD256 需要 705600 Hz 载波，看到 24-bit 本身不代表转换成了 PCM。
- `dsdMode=native` 时，核对 `actualBackend`、`actualDeviceId` 和 `nativeDsdRuntimeState`。WASAPI 本身没有 Native DSD 输出；需要选择支持它的 ASIO 设备，或配置独立 DSD 路由。
- 设备拒绝 DoP 载波时，默认 `pcm-fallback` 策略在同一选定设备上转换为 PCM，并报告原因；`exact` 策略则报错。以实际协商结果判断，不能从设备名称推断 DSD256 支持。

原生回归覆盖 PCM→DSD256 切换、Auto／DoP／Native 模式下保持选定 WASAPI 设备，以及显式独立路由。Moonriver 3 的实际出声与设备锁定仍需真机验证。

## 新模块接入

主进程和后台服务使用公共接口：

```ts
import { createDiagnosticLogger } from '../diagnostics/logger.ts'
const log = createDiagnosticLogger('library.tags')
await log.operation('tags.write', async () => writeTags(), { count: tracks.length })
log.warn('tags.partial', { succeeded: 4, failed: 1, error })
```

事件名使用 `对象.动作.结果`，模块名固定，避免把歌曲标题、URL、路径、用户输入或随机 ID 拼入事件名。只记录白名单摘要，如数量、格式、错误码、字节数、耗时、版本和状态。Error 可以直接作为详情传入，序列化器保留 message、stack、code、errno 和 cause，不访问 getter，并处理循环引用、深度、二进制和超长文本。密码、Cookie、Token、认证头、签名参数会被移除；路径和地址记录类型及稳定指纹。不要依赖脱敏器替代白名单设计。

`withDiagnosticContext({ operationId, requestId, serviceGeneration, streamToken }, fn)` 使用 AsyncLocalStorage 传递上下文；`observeDiagnosticOperation` 记录开始、完成、失败、取消、超时和在途请求。嵌套请求沿用 operationId，每次 RPC 使用自己的 requestId。预加载脚本和 IPC 注册包装器负责传递内部信封，业务函数收到的参数和返回值不变，旧客户端调用继续兼容。公共通道登记在 `src/shared/ipcChannels.ts`。

界面使用 `recordRendererDiagnostic`，Vue 和 window 错误自动记录。后台服务入口调用 `initializeUtilityDiagnostics(role)`，同时观察 console、网络和进程异常；统一事件通过标准输出传回主进程。不能将日志格式化、文件操作或阻塞锁引入音频实时回调。

原生控制线程可以调用可选的 `SetDiagnosticContext(JSON.stringify(context))`，调用结束后用 `{}` 清除。音频服务已自动处理这一点。解码线程通过 streamToken 与控制事件关联。原生事件使用 `DiagnosticLog::append`，独立采样线程将有界 ring 和健康状态持久化；原生字符串采用更保守的枚举白名单和指纹处理。原生指纹与 Node 的 SHA-256 指纹算法不同，跨层关联优先使用流标识。

## 记录范围与故障隔离

启动、设置加载保存、窗口和渲染进程生命周期、Vue/JavaScript 错误、未处理异常、服务退出、睡眠恢复、更新阶段自动记录。IPC/RPC 覆盖音乐服务、下载、媒体库、标签、备份恢复、主题、插件和媒体集成操作；高频播放状态、频谱、进度 getter 按秒汇总，失败逐条记录。下载任务状态与系统媒体会话另有领域事件。网络记录请求和响应头阶段，保留原响应流及错误传播行为，不读取请求体或音频内容。

主进程每 250 ms 异步批量写入，error/fatal/warn 优先。单条事件最多 16 KiB，发送队列最多 4 MiB，内存备用记录最多 1 MiB。过载优先丢弃低级别事件，记录 `events.dropped`；日志故障不会通过 console 再次递归记录。正常退出最多等待 2 秒刷新。异常退出可能留下截断尾行，导出器会忽略并计数。

原生采样独立于 JavaScript RPC、transport 锁和 clock 线程。每秒读取回调和消费计数，pipeline 锁只使用 try-lock；锁忙、无活动流和 DSD 会明确标记不可用。日志磁盘失败保留原生有界 ring，并向主进程输出一次状态说明。样本中的多个原子字段并非整个引擎的原子快照。

## 解读 ZIP

- `README.md`：覆盖时段、采集结果、近期重要事件和缺失项。
- `timeline.jsonl`：按 UTC 排序的统一事件，按 eventId 去重。
- `logs/`：当前和保留会话的固定快照，以及有界内存备用记录、旧音频和插件日志；所有记录在导出时再次脱敏。
- `markers.json`：最近的人工问题标记及原生异常标记，标记说明前 120 秒、后 30 秒的上下文窗口。重启后标记仍在保留日志中。立即导出时，后续窗口可能尚未收集完成。
- `snapshots.json`：脱敏设置、环境、进程、在途请求、音频缓存状态、能力清单、实际加载二进制的 SHA-256。音频缓存带数据年龄。单项采集最多等待 2 秒，总采集预算 15 秒；不通过原生控制请求刷新缓存。
- `manifest.json`：文件大小、SHA-256、事件覆盖时段、无效尾行、去重、丢失与缺失采集项。清单不包含自身哈希。

导出以固定目录中的打开文件及初始长度为快照边界，采用有界排序和流式 ZIP，不将 256 MiB 日志整体放入内存。worker 失效时直接读取已保存文件，并标记未取得写入确认。包中 `timeout`、`failed`、`available: false` 或未知数据年龄都代表缺失证据，不能解释为服务正常。

## 排查流媒体封面

封面链路使用 `media.remote`、`cover.cache` 和 `cover.renderer` 领域事件，直接覆盖独立的 undici 图片请求，不依赖全局 fetch 拦截。`grant.issued` 只表示授权完成，`upstream.response.headers` 只表示收到响应头，`body.complete` 才表示上游正文读取结束；它们都不能代替浏览器成功解码图片的证据。

- 按 `handleUrl.fingerprint` 关联授权、协议请求与前端图片失败；按 `source.fingerprint` 关联原始封面与磁盘缓存。正文、缓存和 CDN 跳转沿用本次协议请求的 `requestId`，不同请求不混用。转成 blob 的播放封面通过 `display.materialized` 的 `displayUrl` 关联浏览器资源错误。
- `upstream.response.headers` 保留每一跳的状态码、Content-Type、声明长度和耗时；`upstream.redirect` 保留脱敏后的跳转目标。`request.failed.reason` 区分授权、Range、上游状态、网络、类型及大小校验失败。网络 Error 保留 code/cause；中途断流与取消分别记录 `body.failed`、`body.cancelled`，不误记为下载完成。
- `cover.cache` 区分禁用、文件不存在、过期、损坏和磁盘读写失败，记录写入字节数及缩图失败。缓存异常仍沿用原有回退行为。
- `cover.renderer` 记录缺少封面字段、解析/授权失败、图片加载失败、重试拿到相同地址、回退以及重试成功。普通图片加载成功不逐张记录，避免滚动刷屏。`renderer/resource.failed` 补充资源地址指纹，覆盖不经过 CoverImg 的图片。

地址、协议句柄、文件路径统一脱敏；不记录 Cookie、请求头、歌曲标题、图片正文或 data URL 的内嵌内容。现有导出器会自动把这些事件收入 `timeline.jsonl` 和 `logs/`。定位时先看封面事件，不能把歌词接口的 403/404 当作封面请求失败。

## 排查 #132 音频

先定位 `problem.marked` 或 `incident.empty-output`，检查相邻的 `audio.native / health.sample`：

| 证据                                                                             | 可能方向                   |
| -------------------------------------------------------------------------------- | -------------------------- |
| 回调增长，sourceConsumedFrames 停住，bufferedFrames 为 0，decodeStage 为 reading | 解码或读取断供             |
| stopRequested 为 true，decode_stop_requested / stream_retired 事件存在           | 内部停止或流退役           |
| 缓冲充足，emptyOutputCount/zeroFilledFrames 增长                                 | 渲染取样或空输出分支       |
| 消费持续增长，clockHeartbeat 停住或 clockAgeMs 增长                              | 控制线程或状态更新阻塞     |
| available 为 false，unavailableReason 为 pipeline-lock-busy                      | 控制锁忙，不能推断解码状态 |

使用 streamToken、preloadStreamToken、服务代次和 queue/stream 事件核对流是否切换。连续三个有效间隔出现“playing + callbacks 增长 + 源帧未消费”会标记异常；暂停、EOF、停止、流变化和不可用样本会重置检测。检测只取证，不执行恢复操作。FFmpeg 打开、探测、读取和跳转失败记录错误码；读取中断记录 timeoutOrCancel。

## 验证命令

```powershell
pnpm run test:diagnostics
$env:TAE_AUDIO_NODE = '实际新构建的 twilight_audio_node.node 路径'
pnpm run test:diagnostics-native
pnpm run typecheck
pnpm run build
```

长时间取证使用 `scripts/diagnostics-playback-soak.ts`。先在启动 shell 设置 `TAE_DIAGNOSTICS_DIR`、`TWILIGHT_LOG_SESSION_ID` 和 `TAE_SERVICE_GENERATION`，再执行 `node --experimental-strip-types scripts/diagnostics-playback-soak.ts 输出目录 1800 addon路径`。脚本使用真实 WASAPI 共享 PCM 解码输出、音量 0，包含每秒健康、普通轮询、20 条/秒写入负载、磁盘增长和回调性能报告。它验证日志与音频性能，不代表复现了用户 #132。

常驻日志不采集进程内存转储；仅用户主动选择的崩溃取证会话启用转储。旧音频 Markdown/JSON 导出保持原有脱敏行为。
