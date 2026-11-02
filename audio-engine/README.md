# Twilight Audio Engine

Twilight Echo 的 C++20 原生音频引擎，通过稳定 C ABI 和 Node-API 桥接给 Electron 使用。API 字段、outputPerfect 判定和 Recovery diagnostics 见 [docs/audio-engine-api.md](../docs/audio-engine-api.md)，阶段与架构约束见 [docs/twilight-audio-engine-architecture.md](../docs/twilight-audio-engine-architecture.md)。

## 当前状态

当前仓库已经包含：

- C ABI：`TAE_Play`、队列、DSP 配置、设备/后端枚举、`TAE_GetPlaybackInfo`、`TAE_GetVisualizationData`、`TAE_GetEngineCapabilities`、`TAE_GetLastError`。
- Node-API：薄桥接到 C ABI，返回 JSON，不承载播放策略。
- 解码与管线：FFmpeg 解码、Float32 内部渲染、环形缓冲、gapless preload、只读 visualization tap（含 decoupled 示波器时域采样）。
- DSD-preserving DST provider：vendored FFmpeg dstdec 算术核心（LGPL-2.1+，attribution 保留，未 relicense 为 Apache），输出原始 DSD 字节而非 PCM，接入 SACD ISO demuxer，使 DST 压缩曲目进入与未压缩 DSD 相同的 Native DSD / DoP / PCM 决策链。
- Queue：native 侧负责队列索引、upcoming track、EOF auto-next、gapless 预加载和 crossfade overlap mixing。
- 后端：WASAPI Shared/Exclusive、Windows x64 独立 ASIO 兼容层、CoreAudio/ALSA 源码后端；Windows MinGW preset 编译包含 miniaudio 0.11.25 Shared/default PCM PoC，但 `TAE_DEFAULT_PCM_PROVIDER=legacy` 使未设置 selector 时仍走 legacy，`TWILIGHT_AUDIO_PCM_PROVIDER=miniaudio` 仅用于显式实验/A-B，Exclusive/ASIO/DSD 特殊路径不变；ASIO 默认枚举已安装驱动，可用 `TWILIGHT_DISABLE_ASIO=1` 显式禁用；ALSA `hw:` 支持 native DSD 直送（`DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE`），`backendCanAttemptNativeDsd("alsa")==true`；ICoreAudioHost / IAlsaHost seam + Mock 使 CoreAudio / ALSA 后端逻辑可在 Windows 单元测试。
- DSP：ReplayGain、Parametric EQ、FIR Convolver、Crossfeed、FFT Spectrum / Waveform / Peak / LUFS / Spectrogram / 示波器采样。
- Metadata：container、channel layout、channel count、DSD64/128/256/512 识别字段、ReplayGain/R128 字段。

Windows MinGW 验证命令：

- `pnpm run configure:audio-engine:mingw`
- `pnpm run build:audio-engine:mingw`
- `ctest --test-dir $env:TAE_MINGW_BUILD_DIR -N`
- `pnpm run test:audio-engine:mingw`
- `pnpm run typecheck`
- `pnpm run build`

无真实设备默认门禁：

```bash
pnpm run test:no-real-device
```

该脚本会串联 MinGW configure/build、native CTest、Electron manager 测试、typecheck 和前端 build。ASIO 驱动、真实 WASAPI Exclusive DAC、Native DSD、SACD ISO 播放和真实 DoP DAC smoke 都不进入默认门禁，通过 `TAE_RUN_REAL_AUDIO_BACKEND_TESTS=1` 开启，不伪造结果。

Windows MinGW 的构建能力与 provider 采用状态分开记录：preset 会编译 miniaudio，但当前编译期默认仍为 `legacy`。短时 Shared PCM A/B 可显式设置 `TWILIGHT_AUDIO_PCM_PROVIDER=miniaudio`；完整 Windows 真机矩阵、packaged burn-in 和 MA-106 独立决策完成前，不得把编译能力或 bounded A/B 写成默认采用。

## 构建目标

- `twilight_audio_engine`：共享 C 接口动态库，Windows 输出名为 `twilight-audio-engine.dll`。
- `twilight_audio_node`：Node-API 桥接模块，MinGW preset 默认启用。
- `twilight_asio_helper`：x64 构建输出 `twilight-asio-helper.exe`；独立 MSVC Win32 构建输出 `twilight-asio-helper-x86.exe`，不构建 x86 引擎或 Node addon。[双架构构建、暂存和验收](../docs/asio-x86-bridge.md)。
- `twilight_audio_tests` 和相关单元测试：C ABI、DSP、metadata、bit-perfect evaluator、queue、backend factory、platform backend smoke、ASIO mock、CoreAudio mock、ALSA mock、output backend。

## Windows MinGW

推荐入口：

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

`configure:audio-engine:mingw` 由 `scripts/configure-audio-engine-mingw.cjs` 包装 CMake preset，处理两件事：

- 如果 vcpkg/FFmpeg 解压或 rename 遇到 `Access is denied` / `拒绝访问`，清理 `buildtrees/ffmpeg/src/*.tmp` 后重试 configure。
- configure 前验证 `VCPKG_ROOT`、`W64DEVKIT_ROOT`、x86_64 MinGW 编译器、Ninja 和 GNU `patch`；Git for Windows 的 `patch.exe` 会优先于 w64devkit 的 BusyBox 版本。未安装 Git 时设置 `TWILIGHT_GNU_PATCH`。
- 当仓库路径包含空白时，必须设置 `TAE_MINGW_BUILD_DIR` 到一个可写且完整路径不含空白的外部目录。配置、构建、CTest 和暂存都使用该目录，临时目录为 `$env:TAE_MINGW_BUILD_DIR\tmp`。
- 发现 CTest 注册仍指向移动前的构建目录，或 configure 后目标缺失时，会清理 CMake 配置缓存并重试。

生成并暂存的运行文件：

```text
$env:TAE_MINGW_BUILD_DIR/twilight-audio-engine.dll
$env:TAE_MINGW_BUILD_DIR/twilight_audio_node.node
resources/audio-engine/twilight-audio-engine.dll
resources/audio-engine/twilight_audio_node.node
resources/audio-engine/libstdc++-6.dll
resources/audio-engine/libgcc_s_seh-1.dll
resources/audio-engine/libmcfgthread-2.dll
```

`windows-mingw-static` 的 static 只针对 vcpkg triplet，libstdc++ / libgcc / mcfgthread 仍是动态链接，所以那三个运行时 DLL 必须和 `.node` 放在同一目录，否则任何没有装同款工具链的机器都会 dlopen 失败（表现为「未加载 twilight_audio_node.node」）。`stage:audio-engine` 会解析产物的 import table 自动补齐它们，来源优先取构建目录 `CMakeCache.txt` 里记录的编译器所在目录（必须与产物同源：PATH 上另一套 MinGW 的 libstdc++ 会导致 `The specified procedure could not be found`），其次是 `W64DEVKIT_ROOT`；也可用 `--runtime-dir` 或 `TAE_MINGW_RUNTIME_DIR` 指定。缺任何一个都会直接失败而不是暂存出一份不完整的运行时。

## 重采样相位与独立 SoX 库

`TAE_ENABLE_SOXR=ON` 默认构建 `third_party/soxr/` 中锁定的 libsoxr 0.1.3，输出独立 `libtwilight-soxr.dll`／`.so`／`.dylib`。最小相位或显式 `soxrHq`／`soxrVhq` 请求只在速率不同时使用直接 API；普通线性 Native／High／Ultra 继续使用 SWR，同率 typed PCM 不经过 SoX。SWR 在源速率转换声道／表示，实际速率转换只执行一次。

最小相位使用 `phase_response=0`，SoX 线性为 50；Native 固定滚降，高档 HQ、极高档 VHQ，平滑 `passband_end=0.85`。SoX 与 SWR 的带宽不同。相位测试使用同一 SoX recipe 比较幅频与保护区前能量，1 kHz 先拟合相位再计算残差；`twilight_resampler_response_tests` 同时覆盖分块、短尾、准确 Seek、整数单／双声道及配置失败保留原滤波器。`twilight_ffmpeg_decoder_tests --resampler-probe` 验证直接库不受旧 FFmpeg wrapper 不可用缓存影响。

AutoMix 准备、素材导出和续接同时继承各流的质量、相位与滚降；模型分析仍使用原固定参数。`decodeAutoMixFrames` 的新增末尾相位参数默认为线性，旧调用不变。`twilight_audio_performance_gate --verify-automix-minimum-phase` 验证最小相位自然／DJ、普通／CUE 的逐样本续接和活动观察；未继承相位的旧实现会在续接比较失败。

`TAE_ENABLE_SOXR=OFF` 保留既有 FFmpeg SoX 探测／SWR Ultra 回退和最小相位别名，活动状态如实报告实际线性响应。该选项不改变普通调用的入口或同率语义。

SoX 以 LGPL-2.1-or-later 独立动态链接，包含 PFFFT／FFT4G 的适用许可。桌面暂存复制依赖和 `licenses/soxr-0.1.3/` 中的完整修改后库源码、许可和 CMake 包装；打包过滤器包括它们。Android 同样打包独立库与许可，调试验收包附对应源码。具体测量、Android 构建参数和硬件余项见相邻 Android 仓库 `RESAMPLER_VALIDATION.md`。

## 真峰值与限制器延迟

仪表和限制器共用 `dsp/TruePeakDetector.h` 的 49 抽头 Hann 窗 sinc：低于 96 kHz 进行 4 倍重建，其他速率 2 倍，192 kHz 以上也保留采样间峰值。系数固定，历史逐声道预分配；计量不修改音频。限制器用单调最大队列保持衰减，覆盖音频延迟和 FIR 尾部后再释放，声道仍共用增益。

`lookaheadMs` 保留请求语义；实际延迟取请求帧数与 FIR 最低支持长度的较大值：低于 96 kHz 最少 11 帧，其他速率最少 23 帧。默认 1 ms 不变。`DynamicsProcessor::latencyFrames()` 和 DSP 图节点／总延迟均报告实际值；例如 48 kHz 请求 0.1 ms，实际为 11 帧。全程未触发衰减时，PCM 仅增加这段精确延迟。

`twilight_true_peak_tests` 用内存正弦的解析振幅和原版 libebur128 对照，覆盖分块、8 声道、脉冲、宽带、双音突变、释放和逐样本延迟。`twilight_true_peak_realtime_unit` 对两个活动处理器执行十分钟等效音频，并在 MinGW 跟踪 C／C++ 分配；均不打开音频设备。Android 的构建／数值记录见相邻仓库 `POWERAMP_HIFI_COMPARISON.md` 第 35 节。

## 动力学响应与分频合成

三／四段压缩在后续 LR4 分频时给先前频带补齐全通相位，单位压缩合成保持平坦幅频；两段路径不变，全部频带禁用仍精确旁路。动态 EQ 用输入与输出修正历史实现当前系数的差分方程，避免变系数状态保留旧权重，并保持零增益峰值滤波的精确单位响应。全频门限／压缩原有启动、声道链接和时间参数含义不变。

`twilight_dynamics_response_tests`／CTest `twilight_dynamics_response_unit` 含 214 项数值检查：44.1／48／96 kHz 的硬拐点与 makeup、解析 DC 攻击／释放、独立复数 LR4 幅相、动态 EQ 增益与 long-double 时域参考，以及分块／reset／8 声道与旁路。时间参数是每级一阶 `1/e` 常数，不是端到端稳定时间；多段单位增益仍有全通相位，不承诺逐样本相等。接口含义见 `docs/audio-engine-api.md`，Android 交付与完整数值序列见相邻路线图第 38 节。

## 声场／校准响应与 double 桥边界

`twilight_spatial_response_tests`／`twilight_spatial_response_unit` 对现有立体声矩阵、逐声道增益／延迟／静音、声道矩阵、LR4 低频管理、固定补偿搁架和交叉馈送模型执行 1086 项独立数值检查。包含 480 组立体声控制组合、0–250 ms 延迟、44.1／48／96 kHz 幅相、脉冲、分块与 reset；不打开音频设备。命名交叉馈送现对照原版 libbs2b，custom 保留原解析参考；当前含义见 `docs/audio-engine-api.md`。

Float32-only 节点现在显式用准备格式的声道数调用 `processFloatBridge`，修正旧默认 double 桥固定转换 8 声道、改写较小缓冲区尾部的问题。`processDouble` 调用签名和 C／JNI／插件 ABI 不变；内部派生实现不再继承无格式默认桥。原生 double 节点保留，Float32 桥仍为原精度与临时分配，未改变实际播放的 Float32 路径。`twilight_double_bridge_tests` 的 144 项检查、DSP 图和卷积回归见相邻 Android 路线图第 40 节；第 39 节保留完整声场数列。

## native 声道布局与低频管理

`AudioFormat.channelMask` 保存 native speaker 位与交错顺序，贯通 FFmpeg／环形缓冲／DSP／预加载。低频管理按真实 primary LFE 位定位，无 LFE 时完整旁路；未知布局的旧调用继续原索引约定。Android API 32+ 动态请求／查询 AAudio 的共用 speaker 位，旧 API 不增加前置条件；CUE PCM 导出保留 WAVE speaker mask。

`twilight_channel_layout_tests`／`twilight_channel_layout_unit` 的 150 项内存检查覆盖 15 种布局，受控生产管线入口 `twilight_audio_performance_gate --verify-channel-layout`／CTest `twilight_audio_channel_layout` 覆盖 11 个场景。无 LFE 的中置／主声道保持、实际 LFE、同声道数异布局、预加载晋升和输出事实均经检查；没有打开音频设备。接口、未知布局边界和证据见 `docs/audio-engine-api.md` 及相邻 Android 路线图第 41 节。

实时／离线 LUFS 共用 native 角色映射，排除 primary LFE／LFE2，分别计入 7.1 的侧方与后方声道，保留旧 count-only 调用。BS.1770-5 权重、BL／BR 的名义布局约定及未知位置边界见 API 文档。离线结果和自动／库内响度缓存身份同步为算法 **3**，旧缓存需要重新测量。

`twilight_android_loudness_unit` 的 322 项检查与 `twilight_loudness_layout_unit` 的 17 个实际 FFmpeg／C ABI 场景通过；后者覆盖单文件、CUE、混合布局专辑及原超过 8 声道输入。源码构建的 Android 同源 libebur128 与相同 PCM 的离线结果最大差 0.046 LU，包含直方图精度影响。证据和四 ABI 包见相邻路线图第 42 节。

## BS2B 交叉馈送

`bauer`／`bs2b` 现在使用 BS2B 3.1.0 官方默认的低通＋高频补偿（700 Hz、4.5 dB），两种旧值保留为同一模型的别名；`meier` 是 BS2B 官方 JMEIER 预设（650 Hz、9.5 dB）。命名模式的 strength 为干湿比例，1 为完整预设；custom 保持原延迟／低通算法。双精度系数按实际速率计算到 768 kHz，保留 ±4 DSP 余量，不加入独立 ±1 限制器。

`twilight_crossfeed_response_tests`／CTest `twilight_crossfeed_response_unit` 的 1320 项检查对照未改的原版 C 实现（8–384 kHz）和独立 long-double 传递函数（到 768 kHz），覆盖 Float32／double、双侧脉冲／幅相、互易、分块、状态切换、custom 兼容与回调／reset 零分配。原版代码仅进入主机测试，生产适配不新增运行时库；MIT 来源与通知位于 `third_party/bs2b/`。接口和 Android 交付见 API 文档与相邻路线图第 43 节。

## 后台生成 CUE 投送文件

`TAE_RenderPcmSegment` 将绝对音源起终点映射到准确 PCM 帧，生成零起点的独立 WAV，显式虚拟 PREGAP 放在文件开头。它只使用 `FFmpegDecoder`，不初始化播放引擎或设备，不执行音量、DSP 图或播放选率。整数 16／24／32 位与 Float32 保留解码 PCM 表示；多声道和非整字有效位深使用 WAVEFORMATEXTENSIBLE，Float32 包含 fact chunk。

调用方提供新输出路径，并在失败或取消后删除半成品。源提前结束、文件写入错误或超过 RIFF 32 位长度会失败，不补齐未知音频、不回退整轨。共享 Core 在 analysis worker 中调用此接口，等待完成后才发媒体 token；取消等待 worker 退出，Stop ACK 后释放生成文件。HTTP(S) 来源由 Core 禁止重定向地暂存后再解码。

```powershell
cmake --build <build-dir> --target twilight_pcm_segment_tests twilight_audio_node
ctest --test-dir <build-dir> -R '^twilight_pcm_segment_unit$' --output-on-failure
$env:TWILIGHT_SEGMENT_NATIVE_BINDING='<staged-runtime>/twilight_audio_node.node'
pnpm run test:cast-segment-native
```

原生目标用内存 WAV／FLAC 检查逐字节分段、静音、重读和失败边界；后一个入口使用真实 worker／addon 与静默 loopback DLNA 接收端，检查鉴权 URL、Range、小数秒控制及回收，不打开音频输出设备。

## 接口语义

`outputInfo` 是播放状态的 canonical 字段。顶层 `PlaybackInfo.actualBackend`、`actualSampleRate`、`latencyMs`、`sourceExact`、`outputPerfect`、`perfectReason`、`isDsd`、`dsdMode`、`dsdRate` 等字段只做镜像。

`sourceExact=true` 表示源文件级精确；`outputPerfect=true` 表示 decoded PCM 到设备实际输出之间没有额外处理或格式损伤。有损格式可达成 `outputPerfect=true`，但 `sourceExact=false`。`pcmPassthrough` 由 decoded PCM 与后端 actual output 精确比较；整数 PCM 源如果被转换到 Float32 管线再打包为整数输出，不能标记为 `outputPerfect=true`。

WASAPI Exclusive / ASIO 已具备 typed PCM passthrough 分支：当无 DSP、音量为 1.0、routing 不改变语义，且源 PCM 格式与后端实际输出格式完全一致时，FFmpeg decode、AudioBuffer 和后端 typed render 会按 Int16/Int24/Int32/Float32 直通，允许 `pcmPassthrough=true` / `outputPerfect=true`。如果源格式和设备实际格式不一致，或处理链需要 Float32，则继续报告 `integer_passthrough_unavailable` 或 `pcm_converted`，避免误报 bit-perfect。

`TAE_GetVisualizationData` / Node-API `GetVisualizationData` 返回只读可视化数据：`spectrum`、`waveform`、`peakDb`、`rmsDb`、`lufsMomentary`、`spectrogram`、`oscilloscope`、可选 `visualizerBars`、`sampleRate`、`active`、`tapStatus`、`reason`。`spectrumPoints` 支持 8-4096；播放页全屏可视化默认以 4096 个频谱点请求 140 根 log-Hz 频谱柱。`visualizerBarCount` 支持 0-256，0 保留完整频谱接口；大于 0 时原生直接聚合柱条，省略 `spectrum`、`spectrogram` 和 `oscilloscope`，旧版原生绑定由 main 聚合兼容。可视化采样器仍使用 8192 FFT，对齐 WebAudio `AnalyserNode` 参考页的 4096-bin 频谱。`oscilloscope` 是与 `waveform` 解耦的独立时域采样数组，长度由 `oscilloscopePoints`（0-4096，默认 1024；0 表示不返回该 payload）决定，独立于 `fftResolution`，供 UI 做稳定波形触发与绘制。无播放采样时返回 inactive 空闲态；播放中 native tap 不可用时 main 可返回显式 `synthetic-fallback` 诊断 fallback；旧的 `TAE_GetSpectrumData` 保留兼容。

原生 JSON 可用 `visualizerBarMode:"peak"` 在每个对数频带内取原生 FFT bin 的最大显示电平；默认仍为 `"interpolated"`，保留桌面原有结果。Android 直接 JNI 的 48 段监测选择新模式，桌面 Core 尚未开放该选项。频谱仍来自各 PCM 声道的算术平均，等幅反相会相消，不是声道能量和；新模式不做时间峰值保持。`twilight_audio_monitor_tests` 校验独立 DFT、频带归属和既有累计 L/R 相关性；`--profile` 离线模拟 10 Hz 轮询。完整参数与标度见 `docs/audio-engine-api.md`，Android 软件证据见相邻路线图第 36 节。

同一队列的手动选曲可使用 `TAE_SelectQueueIndex` / Node-API `SelectQueueIndex` 更新游标，再调用原有 Play 接口。Electron 的 `selectQueueItem` 还会校验主进程签发的队列版本、索引、逻辑 ID 和重新授权的规范路径；队列内容、CUE 范围、响度数据变更或服务重启后须重新加载队列。

Phase 6B 中，后端只上报事实：WASAPI Shared 始终按系统混音路径报告 false；WASAPI Exclusive/ASIO 只有实际格式完整上报并与 decoded PCM 完全匹配时才进入 evaluator；CoreAudio 默认路径在 Hog/Exclusive 未验证前继续 false；ALSA `default` / `plughw:` 默认 false，只有显式 `hw:` 且格式匹配才可能 true。

`TAE_GetEngineCapabilities` 暴露 `backends` / `backendCapabilities`、`pcmPassthrough`、`outputPerfectRequiresPcmPassthrough`、`htmlAudioFallbackDefault` 和 DSD 能力模型（`sacdIsoDst`、`sacdIsoDstMode`、`sacdIsoDstDsdProvider`，provider 默认可用时分别为 `true` / `"native"` / `true`）。`TAE_GetLastError` 使用 buffer/required-size 模式返回稳定 JSON。

暂存发布清单中的 `capabilities.pcmOutputProvider` 将构建可用性、编译默认 provider、实际活动 provider、运行观测和设备验证分开记录；没有打开播放路由时 `activeProvider` 为 `null`，不代表真实设备通过。当前编译默认和显式 rollback 都是 `legacy`。

## Electron 集成

Electron 默认走 native engine。`src/main/audioEngineManager.ts` 会从开发构建目录、`resources/audio-engine` 和 packaged resources 查找 `twilight_audio_node.node`。

HTMLAudio 不再静默兜底；只有设置环境变量时才允许临时 Renderer 播放通道：

```powershell
$env:TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK="1"
```

未启用该变量时，native 播放失败会向 Renderer 返回明确错误原因。

## 当前非闭环范围

- ASIO 兼容层不携带 SDK，Windows x64 引擎通过 x64/x86 helper 加载相应位数的驱动；发布包需同时携带两个 helper。设置 `TWILIGHT_DISABLE_ASIO=1` 可停止枚举和激活驱动。BRAVO-HD 3.14 / DETHONRAY Clarinet 的 PCM 与 Native DSD 兼容性仍待实机验收。
- 真实设备 smoke 是 opt-in；没有目标平台工具链或对应设备时跳过，不阻塞默认 CI。
- Crossfade 已进入 native float 渲染路径，能对预加载下一首做 overlap mixing，并在启用时稳定报告 `outputPerfect=false` / `perfectReasonCode=crossfade_active`。
- DSF/DFF DSD64/128/256/512 可进入 DoP carrier path（遵循 dCS DoP open standard v1.1，carrier 上限 DSD512，运行时由设备 carrier-rate 能力门控：ASIO `dopCarrierSampleRates` 或 WASAPI/CoreAudio Exclusive `IsFormatSupported` 探测），并在 UI 中展示 DSD 源到 `DoP carrier` 再到后端实际输出；DoP 是用 PCM carrier 承载 DSD bitstream，不等同于把 DSD 转成 PCM。
- DoP 条件不满足（含设备不支持 DSD256/512 carrier 速率），或软件音量、ReplayGain、EQ、Convolver、Crossfeed、Crossfade 等处理启用时走 PCM fallback，并在 UI 中展示 DSD 源到 PCM 输出链路。运行时若从 DoP 回退到 PCM，canonical `outputInfo.isDsd/dsdMode/dsdRate` 会清成当前 PCM 状态，顶层 `PlaybackInfo` 只做同值镜像。
- Native DSD 支持 ASIO 与 ALSA `hw:`（`DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE` 直送，rate = DSD bit-clock / phys_width，静音字节 `0x69`，格式顺序 U8→U32_LE→U16_LE，`backendCanAttemptNativeDsd("alsa")==true`，nativeDsdRuntimeFacts 开打开时 Candidate、首次成功 `writei` 后 Proven）；只有运行态 facts 证明为 `proven` 时才声明 `dsdMode=native`、`sourceExact=true` 和 `outputPerfect=true`，否则按 DoP、PCM 顺序回退。WASAPI 与 CoreAudio 没有 native DSD 通道（平台限制），走 DoP 或 PCM。
- SACD ISO 支持未压缩 DSD area 的曲目切片播放，并进入与 DSF/DFF 相同的 Native DSD -> DoP -> PCM 决策链；DST 压缩曲目通过 DSD-preserving provider（vendored FFmpeg dstdec，LGPL-2.1+，attribution 保留、未 relicense 为 Apache，输出原始 DSD 字节而非 PCM）解出 DSD 后进入同一决策链，provider 默认可用。provider 不可用时返回 `dst_dsd_provider_unavailable`，失败时返回 `dst_dsd_provider_failed`，不把 FFmpeg PCM DST decode 伪装成 Native DSD/DoP。
- Metadata 默认测试覆盖空 source、缺失文件 shape、generated DSF DSD64/128/256 和 SACD ISO `isoTracks`。FFmpeg decoder 默认测试通过生成 WAV/DSF fixture 覆盖 PCM/DSD shape；如设置 `TAE_AUDIO_FIXTURE_MANIFEST`，会读取外部 JSON 矩阵；如设置 `TAE_AUDIO_FIXTURES_DIR`，会额外扫描 MP3/FLAC/M4A/OGG/AAC 等真实小样本做 opt-in 解码 smoke，真实样本不作为默认门禁依赖。
- 外部格式矩阵 runner：`pnpm run smoke:audio-format-matrix -- --manifest "<matrix.json>" --json` 默认执行 metadata/assertion；加 `--playback --backend wasapi-exclusive --device "<device>"`、`--backend asio` 或 macOS Hog 的 `--backend coreaudio-exclusive` 可生成真实硬件 playback raw artifact。
- WASAPI 真实设备 smoke 可用 `pnpm run smoke:wasapi -- --device "M30" --buffer 256 --expect-bit-perfect --format-matrix` 跑多格式矩阵；矩阵只要求实际匹配格式 bit-perfect，不支持或被协商到其它格式的样本必须给出明确 non-perfect reason。
- 真实设备 smoke 结果可用 `pnpm run smoke:audio-evidence -- --input <evidence-envelope.json>` 或 `--input-dir <dir>` 汇总到 `output/audio-smoke-evidence/audio-smoke-evidence.md` 与 `.json`；报告固定列出 WASAPI Exclusive、ASIO PCM、DoP DAC、Native DSD、SACD ISO、CoreAudio Hog、ALSA `hw:`，未覆盖项显示为 `not-run`，JSON 写入 `coverage` 摘要和未闭环 surface 的 `actionPlan`。`coverage.complete` 只接受带固定采集字段、存在本地 artifact 与匹配 SHA-256 的 `real-device` pass；mock 与未知来源只验证逻辑，绝不计入硬件覆盖。发布前可手动加 `--require-complete`，证据不完整时退出非 0；该检查不进入默认 CI。
- macOS/Linux 后端需要对应平台工具链和真实设备 smoke 后才能声明发布级能力；CoreAudio / ALSA 后端逻辑已通过 ICoreAudioHost / IAlsaHost + Mock 在 Windows 单元测试覆盖，真实硬件 smoke 保持 opt-in（`TAE_RUN_REAL_AUDIO_BACKEND_TESTS=1`），不伪造结果。

### macOS HAL 与独占输出

macOS PCM 使用 HAL AudioUnit float32 客户端，链路中的实际格式按客户端格式上报；设备虚拟整数格式不作为回调缓冲区格式。多缓冲区按声道分组写入，短回调补静音。Hog Mode 使用 global scope，获取前检查占用与可写性，写入后确认拥有者 PID；关闭时仅释放本进程仍持有的设备，独占打开失败同样恢复原采样率。设备枚举按实际 Hog 属性报告独占能力，属性可写仍不代表当前设备可抢占。

采样率切换等待 HAL 回读确认，并支持设备声明的连续采样率范围。Hog Mode 与 bit-perfect 分别报告：客户端与设备格式不一致时不能声明 output-perfect；当前 float32 AudioUnit 路径不提供 DoP 整数直通，DSD 使用现有 PCM 回退。外接 DAC 的独占竞争、拔插和听感需真实设备验证。
