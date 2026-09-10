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
  `useProviderStore.callProvider` 复用 `toProviderIpcArgs`，避免响应式分区参数在 Electron 桥上克隆失败。
- `utils/logicalTrackModel.ts`：跨来源曲目的逻辑合并和优先级排序。

## 音频链路

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

运行时以全局外观设置作为默认值，用户主题在当前深浅色中显式保存的覆盖值、字体资源绑定、背景模式与封面取色优先；内置主题及用户主题未自定义的项目仍沿用全局设置。恢复单项或分类默认后重新继承全局设置。播放栏形态按主题提供默认值：`builtin:aurora-reference` 及其派生主题默认为紧凑，标准主题默认为标准；用户在设置页或首启向导主动选择形态后保留用户选择。暮光档案隐藏侧边栏品牌标识，普通材质播放栏使用不透明的播放页底色；液态玻璃仍由外观设置管理。

## 本地库与搜索数据流

本地曲库加载时先把已保存曲目放入 renderer，使界面尽快可用；`libraryScanService` 随后用快速索引做启动增量核对，provider 元数据补全也在后台进行。后台结果按 track id/path 合并，避免覆盖用户在加载期间新增、删除或排除的曲目。完整扫描的大规模提交只返回有界增量；renderer 收到 reload 标记后重新加载已原子提交的曲库文档。主进程加载路径不得遍历解析全库 metadata、转换 base64 封面或逐项修复封面；这些工作只允许在显式后台重扫中执行。

`useMusicStore` 维护两个非响应式索引：

- `trackById`：按 track id 定位曲目。
- `trackByPath`：按文件路径定位曲目，供文件 watcher 的增量 add/remove 使用。

派生集合 `artists`、`albums`、`folders` 使用 `shallowRef`，并通过 coalesced rebuild 合并多次变更。不要在高频操作中逐次重建完整派生集合；批量导入、删除、修复后应调度一次 rebuild。跨来源歌单解析依赖按曲库 revision 缓存的 local logical map；收藏按钮状态依赖歌单 identity cache。修改曲库数组时必须走 store 内部的曲库替换路径，确保这些缓存能正确失效。

统一搜索会把本地结果和插件 provider 结果合并为逻辑曲目。`buildLogicalTracks` 使用逻辑 key 索引候选组，避免大结果集下按组线性扫描。新增搜索、最近播放或收藏逻辑时，应复用 `logicalTrackModel`，不要重新实现跨来源合并规则。

最近播放、排行和 Dashboard 推荐需要把历史统计解析回可播放的本地变体时，使用 `createUnifiedRecentTrackResolver(localTracks)` 在一次计算中复用本地 id/logical 索引。不要在每条统计上单独调用会重建整库索引的解析流程。

Streaming 页的本地歌曲、歌单、歌手搜索逻辑放在 `components/streaming-page/localStreamingSearch.ts`。该工具扫描完整集合以保留分页总数，但只 materialize 当前页结果；不要在 SFC 内重新写 `filter().map().slice()` 的全量中间数组链。

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
- 本地主页由 `components/local-dashboard/LocalHome.vue` 根据主题运行时的 `presetLayout` 选择布局。「暮光档案」（`builtin:aurora-reference`）与其派生主题使用唱片客厅主页；`builtin:obsidian-glass` 使用 `NightHarborDashboard.vue` 的夜港唱片厅布局：黑胶播放台、曲库统计、最近轮换与唱片架；`builtin:paper-light` 使用下述声场主页；其他主题使用 `LocalDashboard.vue`。`LocalHome.vue` 使用稳定的外层容器承接页面过渡，避免异步主页切换时残留入场透明样式；主题预览与取消同步切换布局。`archiveLibrary.ts` 按音乐库数组版本物化统计和曲目位置索引，只保留最新 30 首，夜港主页只 materialize 当前可见的最近曲目与最多 4 张专辑，时长在小时不足 1 时显示分钟；最近播放复用统一曲目解析器，播放队列最多取相邻 200 首，禁止在播放 tick 中重建音乐库索引。夜港样式使用主题 token，亮色为纸白/珊瑚红/青绿，暗色为墨色/珊瑚红/灰绿，并为中小窗口提供播放台折行、曲目单列和唱片架双列布局。
- 第四套「声场 Sound Field」沿用 `builtin:paper-light` 标识，由 `SoundFieldDashboard.vue` 接入独立 `SoundFieldHome.vue`：左侧纵向播放控制台、右侧专辑画廊与分页曲目目录、底部曲库统计。冷白/石墨底色与信号红强调通过主题 token 提供明暗两套配色；小于 820px 的内容区域改为顶部横向播放台，小于 540px 的专辑画廊改为双列。最近记录复用统一解析器，音乐库索引按数组版本物化，最多准备 8 张专辑，每页仅渲染 4 张专辑和 5 首曲目；播放、上下首、随机播放和 seek 复用播放器 store，未加载当前曲目时禁用 seek。主题预览、取消及派生主题均通过现有 `presetLayout` 路由同步布局；运行时背景和强调色继续遵循用户的全局外观设置。
- 第二套「暮光档案」的本地歌曲列表由 `assets/theme-layouts/aurora-library.css` 提供无外框、细分隔线布局；深浅色默认关闭曲目标题底色，标题按文字宽度收缩，强调色用于播放与选中状态。专辑和时长列使用稳定宽度，按列表容器宽度在 720px 以下收起专辑列、480px 以下收起音质副行；保持既有虚拟滚动行高和多选逻辑，主题工作室的显式底色设置仍生效。
- provider 或文件系统慢操作必须后台化，不能阻塞首屏曲库渲染。

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
