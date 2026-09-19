# Twilight Echo 技术文档

本文档面向 Twilight Echo 维护者，说明仓库结构、运行架构、关键数据流、性能约束和验证命令。插件系统的权威契约以 [twilight-echo-plugin-spec.md](./twilight-echo-plugin-spec.md) 与 [twilight-echo-plugin-plan.md](./twilight-echo-plugin-plan.md) 为准；本文只描述 app 仓库如何接入和承载插件能力。

## 技术栈

Twilight Echo 是 Electron + Vue 3 + TypeScript 应用，使用 electron-vite 构建，electron-builder 打包。当前包信息为 `TwilightEcho@1.1.4`，许可证为 Apache-2.0。

核心依赖：

- Electron `^43.0.0`
- Vue `^3.5.25`
- TypeScript `^5.9.3`
- electron-vite `^5.0.0`
- `music-metadata`
- `@neteasecloudmusicapienhanced/api`
- PrimeIcons

原生音频引擎使用 C++20、CMake、FFmpeg、Node-API，并通过平台后端输出到 WASAPI、CoreAudio、ALSA 或 ASIO。Windows MinGW 是当前验证最完整的原生构建路径。

## 仓库结构

```text
.
├── src/
│   ├── main/                 Electron 主进程：窗口、IPC、设置、本地库、插件管理、音频引擎
│   ├── preload/              contextBridge 安全 API
│   └── renderer/             Vue 3 renderer
├── audio-engine/             C++20 原生音频引擎与 Node-API addon
├── resources/
│   ├── audio-engine/         打包时加载的原生二进制
│   ├── plugins/ncm-provider/ 内置 NCM provider 插件
│   └── plugin-index/         离线插件索引
├── packages/
│   ├── plugin-api/           `@twilight-echo/plugin-api` typings
│   └── create-twilight-plugin/ 插件脚手架与 pack 工具
├── scripts/                  构建、staging、smoke、发布辅助脚本
└── docs/                     技术文档、插件规范、发布 gate
```

第三方插件源码不属于 app 仓库。第三方插件应放在外部仓库 `Twilight-Echo-plugins`，app 只消费 `TWILIGHT_PLUGIN_INDEX_URL` 或内置静态索引。`resources/plugins/ncm-provider` 是唯一内置 provider 例外。

## 运行架构

本地歌曲、流媒体歌曲及在线音乐库歌单的右键菜单由 Electron `Menu.popup` 展示，允许超出应用窗口，并由系统处理屏幕边界、子菜单与长列表滚动。renderer 的 `NativeContextMenu.vue` 从隐藏的声明式菜单项生成纯 DTO，保留原有点击动作；只经 `window.api.window.popupContextMenu` / `closeContextMenu` 调用 preload。主进程在 `ipc/nativeContextMenuIpc.ts` 校验来源、菜单规模和字段，只返回选中项 ID，不接受 renderer 提供的 Electron role、回调、脚本或文件路径。每个窗口最多保留一个菜单，组件卸载会取消对应请求。

首页音源切换不依赖登录态；音乐库未登录时在页头显示切换入口。音源选择器使用浏览器顶层 popover，保留主题样式，按视口空间限制高度并独立滚动，不受资料卡片的裁剪影响。验证命令：`pnpm run test:native-menus`。

Electron main 侧有五个构建入口，均在 `electron.vite.config.ts` 中声明：

- `index` -> `src/main/index.ts` -> `src/main/app/lifecycle.ts`
- `pluginHost` -> `src/main/pluginHost.ts`
- `audioEngineService` -> `src/main/audioEngineService.ts`
- `audioAnalysisService` -> `src/main/audioAnalysisService.ts`
- `libraryScanService` -> `src/main/library/libraryScanService.ts`

`audioAnalysisService` 使用独立 `utilityProcess` worker pool 执行 BPM/loudness 完整文件解码。其有界优先级队列使用 aging 防止低优先级任务饥饿，并为等待任务设置 deadline；队列满时更高有效优先级可驱逐最差等待项。并发上限、取消、watchdog 和 worker 重启均与实时 `audioEngineService` 隔离，离线分析不得进入播放 RPC 队列。BPM/loudness manager 在 cache commit 期间收到取消时会按精确值条件回滚，且不得广播 completed 事件。

`libraryScanService` 在独立 `utilityProcess` 中执行目录枚举、`music-metadata` 解析和封面落盘。主进程的 `libraryIndexCoordinator` 持久化 `path + size + mtime` 快速索引：启动只解析新增、变化或索引缺失的文件；文件 watcher 事件按 canonical path 合并后进入串行队列；完整 metadata/封面重扫只能由用户在设置页显式启动，并支持进度、暂停、继续和取消。大扫描通过有界批次传输 identity 与解析结果，进度按时间/文件数节流；元数据通过可随机定位的文件 tokenizer 读取，跳过音频载荷但保留尾部标签与封面；无 CUE 的目录复用枚举阶段的 dependency signature，避免逐曲同步重读目录。单文件解析和扫描 worker 均有 watchdog；暂停期间停用 worker watchdog。完整 identity 快照扫描在 worker 重启后保留主进程已收到的结果批次及 identity 快照，仅解析尚未完成的文件，进度累计已完成文件数；当前阻塞路径跳过并在下次扫描重试，watch 局部扫描仍重新核对变化路径。恢复检查点仅在当前扫描任务内有效，不跨应用重启持久化。扫描提交前必须重查曲库 revision、授权 roots 与 exclusions；发生 drift 时丢弃旧结果并重规划，禁止把已移除目录或 TE-0.4 排除项重新写回。

主进程负责窗口生命周期、单实例锁、IPC 注册、设置持久化、本地库扫描、桌面歌词、快捷键托盘、Discord RPC、NCM API 启动和音频引擎编排。

preload 位于 `src/preload/index.ts`，通过 `contextBridge` 暴露受控 API。renderer 不直接访问 Electron、Node 或主进程内部模块。

renderer 位于 `src/renderer/src/`，入口是 `main.ts` 与 `App.vue`。主要状态分布：

- `stores/usePlayerStore.ts`：播放队列、当前曲目、播放状态、音频输出、可视化轮询、播放会话恢复。
- `stores/useMusicStore.ts`：本地曲库、艺术家/专辑/文件夹派生集合、歌单、收藏、曲库修复与元数据补全。
- `stores/useProviderStore.ts`：插件 provider 注册状态、能力与健康度。
- `providers/mediaProvider.ts`：统一 provider 抽象。
- 流媒体主页以 `ui.streamingSections` 显式准入并校验 provider 实际注册的
  `supportedMethods`；发现歌单以标准 playlist discovery 方法准入。两个页面仅在有多个可用音源时显示可交互切换器，切源会重置筛选并废弃旧请求。
  声明 `ui.streamingHome` 的插件使用 `streaming-page/ProviderMusicHome.vue` 的品牌首页，
  按 API 分区展示新歌、榜单或私人 FM，支持公开浏览、局部错误和保留内容刷新。
  酷狗的推荐发现仅使用上游可用分类（含 Hi-Res）和 `hasMore` 翻页，不显示未支持的排序或虚构总数。
  QQ 每日推荐使用登录后的“每日30首”；首页分区可单独要求登录，公开榜单不受影响。
  酷狗与 QQ 的首页页头统一显示“主页”，副标题使用按时段变化的问候语；进入详情、搜索或音乐库后仍显示对应上下文。
  `useProviderStore.callProvider` 复用 `toProviderIpcArgs`，避免响应式分区参数在 Electron 桥上克隆失败。
- `utils/logicalTrackModel.ts`：跨来源曲目的逻辑合并和优先级排序。

统一命令面板由 `app/useCommandPalette.ts` 连接现有播放器、统一搜索和导航，`components/CommandPalette.vue` 负责原生 modal、输入法与虚拟结果列表。标题栏搜索按钮或 Ctrl+K / ⌘K 打开，支持歌曲、本地/聚合歌单、设置索引、正在播放、EQ、DSP、桌面歌词、设备档案，以及队列撤销、清空、保存/管理会话和实际播放顺序；`>` 前缀只搜索操作和设置。空查询及一般导航不会发起歌曲搜索或应用音频设置。查询按来源分页，旧请求取消并受 request ID 约束；本地不可变曲库快照共用排序/文本索引。设置定位请求带独立 revision，即使已在相同分区也能重新定位。

队列操作由 `stores/player/queueCommandController.ts` 维护稳定队列项 ID、revision 和有界撤销栈，`playbackSelectionController.ts` 保证重复曲目按具体队列项选择。命名会话的 CRUD、来源重解析与恢复分别由 `queueWorkspaceStore.ts`、`queueSessionSources.ts` / `queueSessionRestore.ts` 和 `queueSessionController.ts` 负责；恢复默认暂停，单独提供“恢复并播放”。`playbackHistoryController.ts` 仅在实际播放成功后记录顺序，最近 200 次开始与累计统计分开持久化。共享 DTO `src/shared/queueWorkspace.ts` 经 preload data API 和 `main/ipc/queueWorkspaceIpc.ts` 写入版本化 `queue-workspace.json`；最多 20 个会话、每个 20,000 项、合计 40,000 项和 32 MiB。详细行为与失败处理见 [队列虚拟化](./playback-queue-virtualization.md) 和 [歌单生命周期](./playlist-lifecycle.md#named-queue-sessions)。

Renderer TS 测试通过 `scripts/register-renderer-aliases.mjs` 为 Node `--test` 解析 `@renderer/`，与应用构建使用同一模块位置，不引入额外测试框架。命令面板的键盘、组合输入、失败重试、关闭失效及 20,000 条结果的有界渲染由隐藏 Electron 行为测试覆盖。

## 音频链路

设备档案位于播放设置和 HiFi 输出页，支持从当前配置创建、命名、复制、编辑、删除及按稳定设备 ID 自动应用。版本化 `audioDeviceProfiles` 保存后端、独占、完整 buffer/routing、软件音量上限、SRC/DSD 策略和 DSP 场景引用；场景 graph 不复制进档案，设备 SRC 作为运行时 output-stage override 独立持久化。手工调整输出或 DSP 后清除“已应用档案”标记，保留实际设置和音量上限；编辑或删除已应用档案也不会突然改变播放。

档案应用仅经 `audioEngineManager` 的 `DeviceProfiles` 与 `OutputRouter`：串行验证、静音、backend/device/config、DSP plugin chain、DSP revision ACK、输出状态 ACK、持久化，再恢复不超过档案上限的原音量。新的选择淘汰旧请求；失败回滚输出、DSP 和已保存选择，回滚失败则停止播放并显示原因。自动应用只响应重新出现且唯一匹配的稳定 ID，同名、缺失设备、冲突档案或已删除场景均有明确反馈。重启恢复档案选择与上限；服务崩溃后的恢复与配置事务串行，仍等待结构化 ready 且不自动续播。软件上限不是硬件音量或声压保证，也不会自动设置 Unity。对应软件回归位于 `audio/deviceProfiles.test.ts`；真实 DAC 切换未作为本轮验证证据。

ASIO 隔离进程通过回调事件唤醒渲染线程，不依赖 `sleep(1ms)` 轮询；事件可以合并，待处理工作仍以共享内存队列为准。停止线程时主动唤醒，进程退出和回调停滞仍由现有 watchdog 处理。能力枚举只查询，不切换 DSD I/O 模式或设置采样率；PCM 模式下查不到 DSD 倍率时保留未知状态，实际 Native DSD 请求再协商。`AudioFormat.dopEncoded` 只由 DoP 载体构造设置，并经 ASIO helper 协议 v3 传递；普通高采样率 24-bit PCM 不验证 DoP 标记，也不产生 DoP 错误证据。

引擎内部 `Int24In32Interleaved` 保持有效位高位对齐；ASIO `Int32LSB24` 的物理缓冲要求低位对齐，直通与浮点输出均在写入驱动缓冲时转换。完整 `Int32LSB` 承载 24-bit PCM/DoP 时仍保留高位对齐，不能混用两种驱动布局。低位布局与 [PortAudio 的 ASIO 输出转换](https://github.com/PortAudio/portaudio/blob/master/src/hostapi/asio/pa_asio.cpp)一致。

PCM 打开前检查驱动是否仍处于 DSD 模式，必要时恢复 PCM；恢复不能只看返回码，还需检查 `formatType` 及可用的回读结果。驱动拒绝恢复或 PCM 请求仍返回 DSD 通道类型时拒绝启动，避免把 PCM 样本送入 DSD 通道。不支持 I/O 格式查询的驱动仍以实际通道类型验证。

常规播放链路：

```text
Renderer -> preload API -> main IPC -> audioEngineManager
  -> audioEngineService 或进程内 fallback
  -> twilight_audio_node.node
  -> twilight-audio-engine.dll
  -> FFmpeg decode -> DSP chain -> platform output
```

`TWILIGHT_AUDIO_SERVICE=0` 仅用于开发调试，会让主进程直接加载引擎。生产路径应使用可重启的音频服务进程，避免 native 崩溃拖垮 app。

DSD / passthrough 路径会绕过不安全的 DSP。WASAPI 与 CoreAudio 没有平台级 native DSD 通道，DSD 通过 DoP 或 PCM fallback；ALSA `hw:` 可支持 native DSD。macOS 和 Linux 音频后端仍未完成发布级验证。

DSP Rack 保存前通过 `utils/dspSceneDraft.ts` 将响应式场景深拷贝为可跨 IPC 克隆的数据，包含 VST3 参数、预设引用和场景规则。“应用”通过一次 `setDspScenes` 同时提交当前草稿和选中场景的 pin，避免保存后再次应用导致音频链连续重建。提交期间禁用编辑区，防止异步返回的快照覆盖新的输入；失败保留草稿，DSD 转 PCM 仍需用户确认。场景副本与 A 快照隔离嵌套参数和 VST3 状态引用。VST3 参数每页渲染 32 项，编辑只更新对应 ID，折叠的原始配置不序列化完整参数表。

VST3 扫描与运行时支持最多 2048 个参数。隔离宿主共享内存协议 v2 为参数 JSON 预留 128 KiB 加终止字节，覆盖完整参数集的 uint32 ID 与双精度归一化值；旧版 8 KiB 容量会使 WORMHOLE 等大参数集插件在启动前被旁路。协议布局变更后必须同时重建并 stage MinGW 音频引擎与 MSVC VST3 helpers，再重启应用。`test:dsp-graph` 包含 Windows 原生桥回归，验证完整参数载荷跨进程传输、处理后音频返回以及超限载荷拒绝，不依赖真实音频设备或第三方插件。

VST3 音频桥按绝对帧位置回填预分配的环形缓冲，宿主按提交序号处理，允许 WASAPI 回调长度变化。桥接延迟固定为 4096 帧（48 kHz 时约 85 ms），并与插件自身延迟一起报告；仅启动/重置时填充延迟，超时保留同一时间位置的干声，不因相邻块长度不同丢弃效果音频或补静音。音频回调不等待宿主、不分配内存。原生回归覆盖交替块长度、缓冲回绕和重置后的逐样本顺序。

主题工作室应用主题时以主进程返回的主题库快照为提交点：先更新活动主题状态并结束预览，再等待 Vue 响应式视图刷新，最后同步重绘运行时 CSS、布局属性和启动缓存。主题变更事件按严格递增的库 revision 接受，避免保存广播晚到时把刚应用的主题覆盖回旧主题。关闭页面只复用一个预览清理任务，避免关闭钩子与应用操作并发后把当前窗口恢复成旧主题。

主题工作室按外观区域提供颜色与不透明度、逐色渐变、阴影预设和滤镜滑块；参数按歌词、封面、按钮等区域折叠分组，原始 CSS 值由单项代码图标展开。显示名称与搜索结果复用 `themeVisualControls.ts` 的用语映射，搜索保留原始名称与 ID 别名；点击结果清除搜索过滤、展开目标分组并聚焦控件。“更多外观”只列出其他分类未覆盖的项目。字体选择与导入集中在“字体与歌词”，小窗字体使用选项列表；“跟随当前主题”位于各小窗设置顶部。选择强调色色板会切回固定颜色，选择背景色板会切回实色背景。封面取色、渐变背景等有前置条件的控件按模式启用，不依赖提示文案判断是否可编辑。媒体库分类预览实际 `SongList`，页面背景的显式覆盖通过 `--te-library-custom-bg` 接入，未覆盖时保留全局壁纸；列表底色和阴影直接使用主题值。

运行时以全局外观设置作为默认值，用户主题在当前深浅色中显式保存的覆盖值、字体资源绑定、背景模式与封面取色优先；内置主题及用户主题未自定义的项目仍沿用全局设置。恢复单项或分类默认后重新继承全局设置。所有内置主题及其派生主题统一复用项目标准／迷你／紧凑三种播放栏，主题布局样式不再覆盖播放栏及其附属面板的结构与样式，播放栏的颜色、字体、按钮尺寸与圆角统一使用默认主题同色调的原始令牌，不继承主题的 pro 控件、标题大小写／着色、对齐、进度装饰及可见性规则；控件显示只由播放栏按钮编排与三种模式自身决定，材质仍由全局外观设置管理。第 2、3、4 套主题（`builtin:aurora-reference`、`builtin:obsidian-glass`、`builtin:paper-light`）及其派生主题默认为紧凑，其余内置主题默认为标准；用户在设置页或首启向导主动选择形态后保留用户选择。暮光档案隐藏侧边栏品牌标识。

## 本地库与搜索数据流

本地曲库加载时先把已保存曲目放入 renderer，使界面尽快可用；`libraryScanService` 随后用快速索引做启动增量核对，provider 元数据补全也在后台进行。后台结果按 track id/path 合并，避免覆盖用户在加载期间新增、删除或排除的曲目。完整扫描的大规模提交只返回有界增量；renderer 收到 reload 标记后重新加载已原子提交的曲库文档。主进程加载路径不得遍历解析全库 metadata、转换 base64 封面或逐项修复封面；这些工作只允许在显式后台重扫中执行。

`useMusicStore` 维护两个非响应式索引：

- `trackById`：按 track id 定位曲目。
- `trackByPath`：按文件路径定位曲目，供文件 watcher 的增量 add/remove 使用。

派生集合 `artists`、`albums`、`folders` 使用 `shallowRef`，并通过 coalesced rebuild 合并多次变更。不要在高频操作中逐次重建完整派生集合；批量导入、删除、修复后应调度一次 rebuild。跨来源歌单解析依赖按曲库 revision 缓存的 local logical map；收藏按钮状态依赖歌单 identity cache。修改曲库数组时必须走 store 内部的曲库替换路径，确保这些缓存能正确失效。

统一搜索会把本地结果和插件 provider 结果合并为逻辑曲目。`buildLogicalTracks` 使用逻辑 key 索引候选组，避免大结果集下按组线性扫描。新增搜索、最近播放或收藏逻辑时，应复用 `logicalTrackModel`，不要重新实现跨来源合并规则。

最近播放、排行和 Dashboard 推荐需要把历史统计解析回可播放的本地变体时，使用 `createUnifiedRecentTrackResolver(localTracks)` 在一次计算中复用本地 id/logical 索引。不要在每条统计上单独调用会重建整库索引的解析流程。

Streaming 页的本地歌曲、歌单、歌手搜索逻辑放在 `components/streaming-page/localStreamingSearch.ts`。该工具扫描完整集合以保留分页总数，但只 materialize 当前页结果；不要在 SFC 内重新写 `filter().map().slice()` 的全量中间数组链。

## Issue #46 交互与诊断约定

- 主窗口前台空格切换播放/暂停，输入、可编辑区域、按钮、菜单和对话框保留自身键盘行为；全局音量增减默认使用 `CommandOrControl+Alt+Up/Down`，步进 5%，允许在快捷键设置中修改。跨进程快捷键载荷统一在 `src/shared/playerShortcuts.ts`。
- 全局字体设置支持 `local:<字体名称>`，复用 main 字体枚举与既有字体 CSS 变量，保留 CJK 回退。Windows 字体注册表经 PowerShell 显式 UTF-8 输出，避免中文名称被按错误代码页解码。
- 均衡器模式切换和参数编辑保留旁路状态；明确点击启用才开启 EQ。合并规则在 `equalizerSettingsPatch.ts`。
- 参数 EQ 使用随浅色／深色主题切换的全画布工作区；频段面板在遮挡所选节点时上移，可用宽度小于 800px 时停靠在图下。关闭面板不会删除频段；删除最后一段后保留空画布，参数预设按自身模式恢复 0–32 个频段。频率、增益、Q 旋钮支持上下拖动、滚轮、方向键及数值输入，Shift 精调；频率和 Q 使用对数映射，普通拖动 180px 覆盖量程。拖动仅预览，结束手势或滚轮停止 140ms 后沿现有提交链写入；切换频段或执行命令前结束待提交编辑。自动增益补偿不在拖动预览期间单独触发引擎写入。频谱沿用播放器可视化数据，电平标示实际 Peak／RMS。
- 登录页返回平台列表、切换账号/登录方式和销毁组件后，旧二维码生成/轮询结果不再改写当前页面或触发跳转。
- 本地歌曲列表及流媒体歌单详情的歌曲标题打开信息，艺人/专辑链接与播放点击隔离；网易云曲目保留 provider 专辑 ID。缺少专辑身份时提示而不猜测同名专辑。
- HiFi 面板 Teleport 到 body，并按顶栏实际高度避让；面板内部点击不会触发播放栏的外部点击关闭。菜单坐标使用 CSS viewport 坐标并限于视口边界。常用控件 hover 不移动命中区域；两种侧栏和播放栏避让复用 `--te-motion-panel`。
- Streaming 返回滚动位置在进入动画开始时恢复，避免进入动画结束后跳回旧位置。
- 授权后的远程封面按完整来源地址哈希缓存到现有 `cover-cache`，缓存有效期 7 天、单项上限 25 MiB，遵守 `cachePolicy.cover` 及上游 `private/no-store`。音频请求不经封面缓存。清理音乐缓存包含这些文件。
- 诊断 Markdown 单独列出欠载/丢缓冲计数，并兼容旧版 diagnosis 中的实际输出格式；非逐位直通不等同于播放卡顿。Issue 附件的 1.1.2 legacy-native / Voicemeeter ASIO 卡顿尚需当前版本同配置实机对照，不能仅凭无设备测试判定已解决。

## Renderer 性能约束

低频交互动效复用 `--te-ease-soft`、`--te-motion-panel` 和 `--te-motion-hover`：新建聚合歌单弹窗使用遮罩淡入与居中缩放，添加网络源表单使用短距离位移与淡入，扫描状态仅在状态切换时交叉淡入淡出，DSP 节点排序由 Vue `TransitionGroup` 在独立容器上做位移过渡。减弱动效模式仅保留 120ms 显隐淡化，节点立即定位；关闭动效时全部即时完成。不为歌曲虚拟列表、播放 tick 或主题实时预览增加入场动画。

歌词页紧凑播放栏仅在鼠标进入底部触发区或操作控件时展开，不因切歌或播放状态变化自动弹出。离开触发区后按 `playerBar.hideDelayMs`（默认 900ms）收起，在页面其他位置移动鼠标不会重置倒计时；返回底部、键盘焦点或打开浮动面板可保持展开，鼠标点击留下的焦点不会阻止收起。播放栏保持固定布局高度，以 160ms 位移与控件淡化完成展开和收起，频谱随之贴回底部；减弱动效仅保留 120ms 控件淡化，关闭动效时即时切换。

本项目的卡顿风险主要来自大曲库和高频播放状态更新。维护时遵守以下规则：

- 大列表只渲染可见区域。`SongList` 表格走虚拟滚动，网格视图走 idle/timer 分批渲染。
- 大型数组更新使用 `shallowRef` + 新数组替换，避免深层响应式追踪整首曲目对象。
- 曲库艺术家、专辑、文件夹等派生集合在分组入库时同步维护封面等摘要元数据，不要生成每个分组后再扫描组内曲目。
- 高频查找使用 `Map` / `Set` 索引，不在事件处理、watcher、播放 tick 中反复 `find`、`includes` 或全量 `map/filter`。
- 单曲 metadata、BPM 等回写路径使用 `trackIndexById` 定位数组槽位，不要对整张曲库 `findIndex`。
- 最近播放、排行榜和 Dashboard 榜单等只需要前 N 项的选择器使用 store 内的有界 top-N 收集，避免在 SFC 内为整张历史表创建 `entries/filter/sort/slice/map` 中间链。
- 播放 tick 会写入的统计状态使用 `shallowRef` 加显式 `triggerRef` 提交，更新单条统计时不要复制整张历史表。
- 搜索热路径避免为每首歌创建临时字段数组，优先短路判断，并尽量只保留当前页需要渲染的结果。
- store composable 可以被多个组件调用；模块级初始化不能在每次调用时全量重建曲库索引。
- 启动期跨 store 副作用优先由入口层注入所需 refs，不要在 store 内动态 import 已经被主界面静态引用的热 store；否则既形成隐式反向依赖，也无法带来实际 chunk 拆分。
- 播放进度和频谱同步要节流。桌面歌词由 `useDesktopLyricsPublisher.ts` 发布标准化 session 与最多 4 Hz 的 clock；歌词窗口在本地外推时钟、按下一句边界唤醒，并将逐字填充交给 WAAPI 遮罩时间轴，快照只用于漂移校正、暂停和 seek，禁止逐帧 IPC、逐帧 CSS 变量写入和 Vue 重渲染。独立窗口外观设置（单双行、横竖排、对齐、描边、配色、翻译与音译）都通过 `src/shared/desktopLyrics.ts` 的版本化契约持久化和实时同步；插件启动时的主题对账只在活动主题实际回退时更新独立窗口默认值，不能覆盖用户已保存的桌面歌词配置。
- 正在播放页按播放时间定位歌词时使用二分查找，不在每个播放 tick 从歌词首行线性扫描。
- 封面主题色提取使用小型 LRU/promise 缓存；切歌时必须防止旧封面异步结果覆盖当前曲目颜色。
- 本地主页由 `components/local-dashboard/LocalHome.vue` 根据主题运行时的 `presetLayout` 选择布局。「暮光档案」（`builtin:aurora-reference`）与其派生主题使用唱片客厅主页；`builtin:obsidian-glass` 使用 `NightHarborDashboard.vue` 的夜港唱片厅布局：黑胶播放台、曲库统计、最近轮换与唱片架；其默认歌词页复用主题 1 的标准布局、封面效果、文字模式与完整信息可见性，不再叠加全屏封面及侧边歌词面板样式，底部播放栏设置保持独立；`builtin:paper-light` 使用下述声场主页；其他主题使用 `LocalDashboard.vue`。`LocalHome.vue` 使用稳定的外层容器承接页面过渡，避免异步主页切换时残留入场透明样式；主题预览与取消同步切换布局。`archiveLibrary.ts` 按音乐库数组版本物化统计和曲目位置索引，只保留最新 30 首，夜港主页只 materialize 当前可见的最近曲目与最多 4 张专辑，时长在小时不足 1 时显示分钟；最近播放复用统一曲目解析器，播放队列最多取相邻 200 首，禁止在播放 tick 中重建音乐库索引。夜港样式使用主题 token，亮色为纸白/珊瑚红/青绿，暗色为墨色/珊瑚红/灰绿，并为中小窗口提供播放台折行、曲目单列和唱片架双列布局。
- 第四套「声场 Sound Field」沿用 `builtin:paper-light` 标识，由 `SoundFieldDashboard.vue` 接入独立 `SoundFieldHome.vue`：左侧独立圆角聆听面板、右侧圆角专辑画廊与分页曲目目录、底部曲库统计。暖灰底色与柔和青绿通过主题 token 提供明暗两套配色；主页强调色由青绿辅助色与全局主色混合，正文与辅助信息采用清晰的字号层级，最近收听/新近入库使用分段切换。宽屏采用 300px 播放面板与弹性内容区，1100px 以下收拢间距；小于 820px 的内容区域改为顶部横向播放台，小于 540px 的专辑画廊改为双列。最近记录复用统一解析器，音乐库索引按数组版本物化，最多准备 8 张专辑，每页仅渲染 4 张专辑和 5 首曲目；播放、上下首、随机播放和 seek 复用播放器 store，未加载当前曲目时禁用 seek。声场本地主页的内容宽度大于 820px 时由左侧播放台接管控制并隐藏底栏，补齐收藏、随机/循环、音量/静音、队列、歌词和音频面板入口；队列与音频面板复用仍挂载的 PlayerBar，收藏复用 App 的统一收藏动作。封面随窗口高度缩放，侧栏可独立滚动。窄窗口及其他本地列表保留底栏，流媒体模式和歌词页继续使用原有播放栏设置，不修改持久化设置。主题预览、取消及派生主题均通过现有 `presetLayout` 路由同步布局；运行时背景和强调色继续遵循用户的全局外观设置。
- 第二套「暮光档案」的本地歌曲列表由 `assets/theme-layouts/aurora-library.css` 提供无外框、细分隔线布局；深浅色默认关闭曲目标题底色，标题按文字宽度收缩，强调色用于播放与选中状态。专辑和时长列使用稳定宽度，按列表容器宽度在 720px 以下收起专辑列、480px 以下收起音质副行；保持既有虚拟滚动行高和多选逻辑，主题工作室的显式底色设置仍生效。
- provider 或文件系统慢操作必须后台化，不能阻塞首屏曲库渲染。

歌词页背景：在全局播放背景选择为“封面模糊”时，内置主题使用当前曲目的封面作为模糊背景。主题 4（`builtin:paper-light`）通过 `playback.backdrop.filter` 与半透明 `playback.backdrop.scrim` 保持这层封面可见，同时保留自身的浅色／深色文字和强调色。

主题 4 的侧边栏沿用主题 3 的悬浮控制台结构：上下留白、右侧圆角、半透明材质、圆角菜单项和发光活动指示线，颜色仍取主题 4 的导航 token。

主题 3「夜港」首页的固定分区眉标题和英文副标题已移除，保留中文页面标题、分区编号、动态曲目元数据和无障碍标签。

## 插件边界

插件运行在 `utilityProcess`，入口为 `src/main/pluginHost.ts`。插件只能通过版本化 `twilight` API 访问宿主能力，不得直接 import Electron、Node 内置模块或 app 内部实现。

app 仓库允许包含：

- 插件 host/runtime 代码。
- 插件 API typings 与脚手架。
- 内置 NCM provider。
- 宿主验证所需的内置示例或静态索引客户端。

app 仓库不允许包含第三方插件源码、第三方插件测试、第三方 `.tep` 包或插件专属 README。需要新增第三方能力时，app 侧只实现通用 host/API/UI 能力，具体 provider 逻辑放到外部插件仓库。

## 常用命令

安装依赖：

```bash
corepack enable
pnpm install --frozen-lockfile
```

主仓库只使用 `pnpm@11.7.0` 和 `pnpm-lock.yaml`。不要运行 `npm install`，也不要提交
`package-lock.json`；内置 NCM API 的修补由 `pnpm-workspace.yaml` 的
`patchedDependencies` 在安装时应用。

`discord-rpc` 的 `register-scheme` 仅是 Electron 不可用时的 optional fallback，且上游把它
指向 exotic Git dependency。主应用通过 Discord IPC 上报播放状态，**当前不注册** OS 默认
协议客户端（无 `setAsDefaultProtocolClient`）。因此 workspace 通过
`ignoredOptionalDependencies` 只排除这个 fallback，并保持 `blockExoticSubdeps: true`。
`pnpm run verify:install-policy` 会确认该包未安装且 `discord-rpc` 在普通 Node.js 环境安全降级。

第二实例（`second-instance`）仅恢复/聚焦主窗口或迷你播放器，**不**解析 `commandLine` /
自定义 URL 深链。在产品明确实现协议客户端之前，argv 交接为 N/A。

仓库内字体均为已转换并提交的 `.woff2` 资源，构建和打包不执行字体转换。不要为了安装时
生成字体重新引入 native converter；若未来需要重建字体资产，必须提供独立、可验证的
转换脚本和跨平台 fallback。

开发运行：

```bash
pnpm run dev
```

### Linux 输入法（fcitx5/ibus）说明

KDE Plasma Wayland 会话下，KWin 只有在 `kwinrc` 的 `[Wayland]` 组配置了
`InputMethod`（KDE 系统设置 → 虚拟键盘）时，才会向 Wayland 客户端暴露
`zwp_input_method` 协议 —— 这是 Wayland 原生 text-input 通道的前提。未配置时，
Chromium/Electron 在 Wayland 下无法通过 text-input 使用 fcitx5/ibus。

处理方式（见 `src/main/imeBackend.ts` 与 `src/main/app/lifecycle.ts`）：

- 检测到「Linux + Wayland + KWin/Plasma + 未配置输入法」时，应用以真实启动参数
  `--ozone-platform=x11` 运行（X11/XWayland 后端），fcitx5 通过
  `GTK_IM_MODULE`/XIM 链路工作，与 VS Code 等 Electron 应用一致。
- 为什么必须用真实参数：Chromium 的 ozone 平台在 Electron 二进制启动阶段确定，
  早于任何主进程 JS。环境变量（`OZONE_PLATFORM` 等）对 Electron 无效；
  `app.commandLine.appendSwitch()` 只影响子进程（renderer/GPU），无法改变
  browser 进程自身。
- 开发/预览模式（`pnpm run dev` / `pnpm run start`）由
  `scripts/run-electron-vite.cjs` 在启动时透传参数（electron-vite 的 `--` 透传
  机制）；打包后的生产模式由 `src/main/index.ts` 的 `relaunchWithX11BackendIfNeeded()`
  自重启并携带参数。
- KWin 已配置输入法时，遵循 fcitx-im 官方建议使用 text-input-v1（KWin 对
  text-input-v3 存在协议理解差异）；GNOME/Sway 等仅支持 v3 的 compositor 保持 v3。

渲染层 IME 注意事项（`src/renderer/src/components/AnimatedInput.vue`）：

- 自定义输入框不得在 IME composition 期间丢弃 `input` 事件：X11/XIM 路径下
  commit 文本的 `input` 事件可能与 `compositionend` 时序不一致，只依赖
  `compositionend` + `setTimeout(0)` 兜底会丢失已提交的中文。
- 不要对需要中文输入的输入框使用 `type="search"`（Chromium 对 search 框有独立
  IME/清除按钮处理，提交时序与 `type="text"` 不同），统一用 `type="text"`。

类型检查与构建：

```bash
pnpm run typecheck
pnpm run build
```

Lint 与格式化：

```bash
pnpm run lint
pnpm run format
```

应用测试：

```bash
pnpm run test:plugins
pnpm run test:audio-manager
pnpm run test:playback-routing
pnpm run test:local-perf
pnpm run test:plugin-tooling
pnpm run test:app
```

单个 TS 测试文件：

```bash
node --experimental-strip-types --test src/renderer/src/utils/logicalTrackModel.test.ts
```

Windows MinGW 原生音频引擎：

```powershell
$env:VCPKG_ROOT = 'C:\path\to\vcpkg'
$env:W64DEVKIT_ROOT = 'C:\path\to\w64devkit'
$env:TWILIGHT_GNU_PATCH = 'C:\Program Files\Git\usr\bin\patch.exe'
# 仓库路径含空白时必须设置；该目录必须可写且完整路径不含空白。
$env:TAE_MINGW_BUILD_DIR = 'C:\twilight-build\mingw-static'
pnpm run test:audio-toolchain
pnpm run configure:audio-engine:mingw
pnpm run build:audio-engine:mingw
pnpm run test:audio-engine:mingw
ctest --test-dir $env:TAE_MINGW_BUILD_DIR -N
```

配置脚本会在调用 CMake 前验证 vcpkg、MinGW 编译器、Ninja 和 GNU `patch`，并清理指向已移动构建目录的 CTest 注册。Git for Windows 的 `patch.exe` 必须优先于 w64devkit 的 BusyBox 版本；未安装 Git 时设置 `TWILIGHT_GNU_PATCH`。当仓库路径包含空白时，必须设置 `TAE_MINGW_BUILD_DIR` 到一个可写且完整路径不含空白的外部目录；配置、构建、CTest、暂存和临时目录 `$env:TAE_MINGW_BUILD_DIR\tmp` 都使用它。不要把本机工具链路径写入 CMake preset。

无真实设备发布前 gate：

```bash
pnpm run test:no-real-device
```

## 变更验证建议

按改动范围选择最小但足够的验证：

- renderer 搜索、最近播放、收藏、逻辑曲目：`pnpm run test:playback-routing`
- 本地曲库性能、列表、收藏按钮：`pnpm run test:local-perf`
- 插件 manifest、依赖、索引、provider routing：`pnpm run test:plugins`
- 音频引擎 IPC、播放/分析 service client、BPM/loudness manager：`pnpm run test:audio-manager`
- 其余可执行应用契约（设置、导航、OPRA、逻辑曲目和音频证据 CLI）：`pnpm run test:app`
- 跨 main/preload/renderer 类型变更：`pnpm run typecheck`
- 发布前：按 [windows-release-gate.md](./windows-release-gate.md) 执行完整 gate

真实设备 smoke 不属于默认 gate。ASIO、WASAPI Exclusive、native DSD、SACD ISO、CoreAudio、ALSA `hw:` 等验证需要明确设备与曲目样本。

## 代码风格

Prettier 配置：单引号、无分号、`printWidth: 100`、无 trailing comma。ESLint 使用 flat config，Vue SFC 必须使用 `<script lang="ts">`。

测试使用 Node 内置 `node --test`，TS 测试通过 `--experimental-strip-types` 运行。新增测试应与被测文件 co-locate，命名为 `*.test.ts`、`*.test.mjs` 或 `*.test.cjs`。

renderer import 使用 `@renderer/*` alias 或已有局部模式，避免跨层深度相对路径。主进程、preload、renderer 的类型边界要显式维护，不要让 renderer 直接依赖 main 内部实现。

歌单详情提供页内返回入口：流媒体复用详情栈恢复上一层，本地分类返回集合，聚合歌单返回网格。再次点击当前流媒体栏目会清除详情和搜索。全局 Esc 优先关闭已注册浮层，没有浮层且焦点不在输入控件时返回上一层（长按和输入法组合事件不触发返回）。网易云歌单删除或取消收藏放在右键／更多操作菜单中，继续使用原有确认流程。底栏常用工具图标使用继承按钮颜色的 SVG，避免图标字体加载或字形渲染影响操作入口。

## 局域网远程控制

远程控制默认关闭。完整控制面由 `src/main/remote/httpServer.ts` 提供，PIN 配对后才会暴露带 Bearer token 的状态、SSE、浏览与命令接口；投送模式的 `mediaOnly` bind 仍只服务 capability-token 媒体，绝不开放远控 UI/API。

`GET /api/browse` 接受受限的 `view`（`library`、`playlists`、`queue`）、`query`、`offset`、`limit`（1–100）与可选 `playlistId`，返回分页且经 renderer 生成的展示数据。曲目与歌单 ID 是短生命周期 opaque token，LAN 端不会获得主机路径、真实媒体 URL 或 provider 凭据。远控播放/入队只接受这些 token；不能传入路径或 URL。

主进程通过受信任的 `remote:request` / `remote:rendererResponse` IPC 向已就绪 renderer 请求每页数据或实际播放动作，并以 5 秒 timeout 明确失败，不会静默确认。队列页面和播放状态共享 `queueRevision`；`jumpQueue`、`removeQueue` 必须回传该 revision，陈旧索引返回 `409 queue_changed`。播放模式 API 使用 `sequence`、`loop`、`single`、`shuffle`，renderer 映射到内部 `sequential`、`listLoop`、`repeat`、`shuffle`。

网页位于 `resources/remote/`，采用暖纸白与墨绿的响应式听音室布局：桌面双栏，手机提供正在播放、音乐库、队列导航及浏览时的迷你控制条。音乐库与歌单支持搜索、每页 40 条、点播和入队；队列支持跳转和移除。歌单曲目复用 `getPlaylistTracksById`，包括已保存的 provider 曲目快照，不额外开放在线平台全站搜索或任意 URL 点播。

`remotePlaybackPublisher` 在曲目封面变化时复用现有封面解析，只有不超过 256 KiB 的 PNG/JPEG/WebP data URL 可以发布；不传递本机协议句柄或原始远端地址，缺失或超限封面显示网页内置唱片插画。不变封面不随播放 tick 重复发送。网页配对凭据保留在当前浏览器，断开配对会清除本机保存；仅适用于可信局域网，不应将 HTTP 端口映射到公网。

远控改动至少运行 `pnpm run test:radio-remote` 和 `pnpm run typecheck`。该测试集包含真实 localhost HTTP 认证/分页/并发/错误/mediaOnly 检查、preload 请求回执测试、曲目与歌单选择测试、状态发布测试及网页 DOM 行为测试。

## 用户需求表：在线歌单与界面补齐（2026-09-10）

- 在线歌单详情提供当前列表搜索、标题/歌手/专辑/时长升降序、刷新、播放定位。检索索引按数据版本缓存；虚拟列表测量实际行高并在字号/窗口变化后更新。多选及播放队列使用同一视图顺序；排序不改写远端歌单。收藏列表尚未全部加载时，界面提示检索范围并提供“加载全部”；加载完成后即可检索完整收藏。
- 在线歌曲右键支持“下一首播放”，复用播放队列控制器，不直接操作原生引擎。
- 在线音乐库提供全部/我创建的/我收藏的分类；来源未提供归属信息的歌单保留在全部分类。长按约 450ms 后拖动排序，无需进入调整模式；键盘支持 Alt + ↑ / ↓。顺序按音源与账号保存到当前设备；不写回服务端。歌单卡片分批显示，每批 48 个。
- 主窗口支持 760px 最小宽度，首次窗口大小不超过主显示器工作区。小于 760px 的工作区按实际可用宽度限制。设置导航在 1180px 以下转为横向栏，导航跳转保留原有平滑滚动（反馈表第 36 项不采纳）。主界面的设置、主题工作室、侧栏、曲库、首页、播放栏及插件等页面的固定文字尺寸按界面字号同比缩放；独立桌面歌词窗口继续使用专用字号。
- 下载设置提供音源原名、歌手-歌名、歌名-歌手、歌名四种格式；标签/封面补写与歌词文件保存默认关闭，保留既有行为。标签先写临时副本，失败保留原始音频并展示提示。歌词文件使用排他写入，不覆盖已有同名歌词。
- 下载面板区分请求音质、音源报告和文件核验结果；无损 24bit/48kHz 归类 Lossless，采样率超过 48kHz 的无损归类 Hi-Res。无法解析时保留音源报告并标注未核验。逐字歌词仅保留音源提供的真实时间信息，不合成伪逐字时间轴。
- 验证入口新增 `pnpm run test:feature-requests`，涵盖视图顺序、分类排序、下载偏好、音质判断、歌词保护与任务栏浮层几何。

本地与流媒体歌单总览均支持长按歌单卡片拖动排序，松手后保存本机显示顺序；搜索后只调整可见歌单的相对位置。歌单内歌曲未接入此次长按排序，保留原有曲目排序与播放行为。长按交互提供落点提示、边缘滚动、Esc 取消和防误点击；键盘使用 Alt + ↑ / ↓ 调整。歌曲列表的歌名、歌手与专辑链接按文字内容收缩，长文本仍在列宽内省略，空白区域不触发详情跳转。

本地页面通过 Vue `Transition mode="out-in"` 切换，`SongList` 必须保留单一元素根节点。歌曲信息弹窗置于列表根容器内部，仍经 Teleport 显示；不得与根容器并列，否则离开歌曲列表后切换可能停在空白占位。`LocalViewTransition.test.ts` 使用实际模板的根节点结构验证首页、列表、其他本地页及模式切换，并覆盖弹窗开启状态。

网易云播放在会话首次解析及地址缓存到期后，先通过当前账号解析在线地址，再复用匹配完整来源 URL 的磁盘缓存。旧版仅按歌曲 ID 保存的缓存不参与直接播放；试听响应不写入播放缓存，重新登录清空会话缓存，避免开通会员后继续播放旧试听文件。
