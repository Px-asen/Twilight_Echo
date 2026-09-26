# Twilight Audio Engine API 说明

本文记录当前 `PlaybackInfo`、`OutputInfo`、Capabilities、`sourceExact` / `outputPerfect` 与 Recovery diagnostics 的对外语义。

## PlaybackInfo 与 OutputInfo

设备档案使用 `window.api.audioEngine.getDeviceProfiles/saveDeviceProfile/deleteDeviceProfile/applyDeviceProfile`，返回 `AudioDeviceProfilesSnapshot`；`onDeviceProfilesChanged` 返回退订函数。载荷唯一类型来自 `shared/audioDeviceProfiles.ts`，由 main 边界校验，单次 `applyDeviceProfile(id)` 完成全部输出与 DSP 事务。快照包含当前可保存配置、设备/场景选项、活动 ID、软件音量上限、逐档案不可用原因及 applying/applied/failed 状态。档案集合上限 64，schema version 为 1；旧设置迁移为空集合。删除活动档案不关闭输出、不释放音量上限，编辑后需再次应用才改变配置。

`outputStageOverride` 是设备配置中的 SRC/dither 设置，解析时覆盖引用场景的输出级，保存场景节点不变。`volumeCeiling` 属于软件增益限制，所有音量请求取该上限；硬件音量及声压不在其保证范围。切换与失败日志沿用 `output-route-transaction`，增加 `device-profile` context 和 `dsp-ready` 阶段。恢复顺序仍为 backend → device → config → SetDspPluginChain → ApplyDspState → LoadQueue，不自动播放。

`TAE_GetPlaybackInfo()` 返回 JSON。`outputInfo` 是 canonical 字段，顶层的 `actualBackend`、`actualSampleRate`、`latencyMs`、`sourceExact`、`outputPerfect`、`perfectReason` 等字段只做镜像，值从 `outputInfo` 派生。

关键字段：

- `outputInfo.backend`：用户选择的后端，例如 `wasapi`、`wasapi-exclusive`、`asio`、`coreaudio`、`alsa`。
- `outputInfo.actualBackend`：实际运行后端，应该与后端实现和 fallback 状态一致。
- `outputInfo.deviceName` / `actualDeviceName`：请求设备名与实际设备显示名。`auto` 会解析为平台默认输出设备。
- `outputInfo.actualDeviceId`：backend 实际打开的 platform stable device ID；Windows WASAPI Shared 的 legacy 与 miniaudio provider 都会上报该字段，并由 route ACK 优先校验它，同名设备不能只比较 `actualDeviceName`。当用户选择 `auto`、播放中的系统默认端点变化时，main 会重放完整 backend/device/config 事务，并要求 ACK 的该字段匹配新观察到的默认 endpoint 后才 commit；idle 时只更新待打开的 `auto` 偏好。其它旧 backend 未上报时保持可选兼容字段。
- `outputInfo.outputSampleRate` / `outputBitDepth` / `outputChannels` / `outputSampleFormat`：引擎
  callback/render 格式；`outputChannels` 是实际 callback 通道数，不从源文件通道数推断；
  `outputSampleFormat` 仅在 active provider 可直接观测时返回，未知时为空字符串。
- `outputInfo.actualSampleRate` / `actualBitDepth` / `actualChannels`：后端协商后的实际输出参数。
- `outputInfo.actualOutputFormat`：后端样本格式，例如 `float32`、`S16_LE`、`S24_3LE`。
- `decodedSampleRate` / `decodedBitDepth` / `decodedChannels` / `decodedSampleFormat`：FFmpeg 解码后送入 AudioPipeline 的 PCM 工作格式，供 UI 展示输出链路并参与 passthrough 事实核对。
- `outputInfo.bufferSizeFrames`：后端缓冲区帧数。
- `outputInfo.latencyMs`：估算总延迟，等价于或接近 `latencyInfo.totalLatencyMs`。
- `outputInfo.latencyInfo.bufferLatencyMs`：周期/缓冲带来的渲染延迟估算。
- `outputInfo.latencyInfo.outputLatencyMs`：设备/驱动报告的额外输出延迟估算。
- `outputInfo.supportsOutputPerfect`：后端是否声明当前路径具备独占或直连输出前提能力。
- `outputInfo.sourceExact`：源文件级精确状态。只有无损/整数 PCM 源格式与输出格式可证明完全保持时才为 `true`；MP3/AAC/OGG 等有损格式默认 `false`。
- `outputInfo.outputPerfect`：解码后 PCM 到后端实际输出之间没有额外处理、重采样、音量、DSP、破坏性 routing 或 sample format 损伤时为 `true`。
- `outputInfo.pcmPassthrough`：本次播放 decoded PCM 与后端实际 PCM 格式完全一致且没有后端 resample 时为 `true`；由 `AudioPipeline` 比较 decoded PCM 与 backend actual output 后写入，不由后端自行声明。
- `outputInfo.resampled`：后端或统一评估发现采样率、位深、声道数或 sample format 发生转换；它仍是现有 evaluator 使用的兼容事实。
- `outputInfo.providerImplementation`：实际实现诊断，取 `legacy-native` 或 `miniaudio`；这不是用户可选择的新 backend，公开 backend id 仍保持不变。
- Windows Shared/default PCM 可通过进程环境 `TWILIGHT_AUDIO_PCM_PROVIDER=legacy|miniaudio` 选择实现；未设置时仍为 `legacy`。非法值或请求未编译进当前引擎的 `miniaudio` 会在输出后端 prepare 阶段明确失败，不会静默回退；WASAPI Exclusive、ASIO 与 DSD 特殊路由忽略该选择。
- `TAE_EnumerateDevices()` 的 Windows PCM 记录保持兼容 `id/label/isDefault`，并增量返回 `platformStableId`、`providerFamily="wasapi"`、`defaultRole="console"` 与 `lastKnownLabel`。`id` 与 `platformStableId` 均为 Windows endpoint ID；`ma_device_id`、指针和枚举序号不进入 JSON 或设置持久化。空 ID 和重复 stable ID 不进入可选目录，重复 label 则保留并依靠 stable ID 区分。
- `outputInfo.conversionInfo`：增量转换事实，包括 `sampleFormatConverted`、`sampleRateConverted`、`channelLayoutConverted` 和来源 `source`（`backend-runtime`、`engine-inferred` 或 `unavailable`）。`sampleRateConverted` 与既有 `resampled` 保持一致；当 legacy backend 无法证明某项转换时必须报告 `source="unavailable"`，不能把占位的 `false` 当作未转换证据。
- `outputInfo.perfectReason`：`sourceExact` 或 `outputPerfect` 未达成时的 canonical 原因。
- `outputInfo.isDsd` / `dsdMode` / `dsdRate`：DSD 状态 canonical 字段。顶层 `PlaybackInfo.isDsd`、`dsdMode`、`dsdRate` 只做镜像；Renderer 应优先读取 `outputInfo` 表示当前 runtime 传输状态。若 DoP 在运行时回退到 PCM，canonical 状态必须同步为 `isDsd=false`、`dsdMode='pcm'`、`dsdRate=0`，UI 可另外基于源文件元数据保留 `DSF/DFF DSD64 -> PCM fallback ...` 的源侧说明。
- `crossfadeActive` / `crossfadeSeconds`：播放连续性处理状态。当前 native 会对预加载下一首做 overlap mixing，并参与 bit-perfect 判定；启用 crossfade 时必须报告 `outputPerfect=false`。
- `gaplessActive`：gapless 意图开启、无 crossfade、且当前存在预加载流时为 `true`（表示 gapless 路径在跑，不等于已 promote）。
- `preloadReady`：下一首预解码流已 `readyForRender`，可被 `skipToPreloaded` 或 render-path promote 消耗。
- `gaplessBlockedReason`：gapless 路径阻塞原因；空串表示未阻塞。取值：`disabled`（意图关或内部门控）、`dsd_path`（DoP/Native DSD）、`typed_passthrough`（typed PCM passthrough 关闭 preload）、`crossfade`（交叉淡入关闭 true gapless）、`format_mismatch`（相邻曲目无法在当前输出格式下 promote）。EOF auto-next 与手动 `next()` 均优先 `skipToPreloaded`，失败才走完整 `playQueueItem`/`stop()`。

## Visualization API

`TAE_GetVisualizationData(engine, options_json, buffer, buffer_size, required_size)` 是只读 tap 查询接口，使用与其他 JSON 查询相同的 buffer/required-size 模式。它监听最终送往后端前的 PCM 渲染缓冲，不改变音频输出；旧的 `TAE_GetSpectrumData()` 保留为兼容入口。

`options_json` 支持：

- `spectrumPoints`：8-4096，默认 64。高保真播放页可请求 4096 个线性 FFT bins，并在 UI 侧按参考可视化实现做 log-Hz 映射与插值。
- `waveformPoints`：16-512，默认 128。
- `spectrogramFrames`：0-96，默认 48；native 侧保留固定滚动窗口，不无限增长；传 0 表示本次查询不返回 spectrogram payload，适合全屏可视化高频轮询。
- `oscilloscopePoints`：0-4096，默认 1024；请求的时域示波器样本数，独立于 `fftResolution` 与 `waveformPoints`，由专门的 decoupled tap 返回；传 0 表示本次查询不返回 oscilloscope payload。
- `visualizerBarCount`：0-256，默认 0；main 进程可为全屏可视化预聚合 log-Hz 频谱柱，减少 renderer 与 iframe 间传输。

返回 JSON 固定包含：

- `spectrum: number[]`
- `waveform: number[]`
- `peakDb: number`
- `rmsDb: number`
- `lufsMomentary: number | null`
- `spectrogram: number[][]`
- `oscilloscope: number[]`
- `visualizerBars?: number[]`
- `sampleRate: number`
- `active: boolean`
- `tapStatus: "active" | "stopped" | "disabled" | "no-samples" | "native-unavailable" | "synthetic-fallback"`
- `reason: string`

`oscilloscope` 是与 `waveform` 解耦的独立时域采样数组，长度由 `oscilloscopePoints` 决定，不随 `fftResolution` 或 `waveformPoints` 变化；返回 N 个 signed time-domain 样本，供 UI 做稳定波形触发与绘制。PlayerBar 在 `oscilloscope` 基础上提供独立的示波器子面板（canvas polyline、客户端零交叉触发、`transition:none`、渐变描边 `#2563eb`→`#14b8a6`），与频谱面板互不影响。

当没有播放采样或 FFT tap 禁用时，`active=false`，`spectrum` / `waveform` / `oscilloscope` 返回请求长度的零数组，`spectrogram=[]`，`lufsMomentary=null`，并通过 `tapStatus` / `reason` 区分 `stopped`、`disabled`、`no-samples`、`native-unavailable`。main 进程在播放中遇到旧 native binding 或 native tap 无采样时允许返回 `tapStatus="synthetic-fallback"` 的兼容数据；UI 必须把它识别为诊断 fallback，不能标成真实 native 采样成功。当前 LUFS 为基于当前 PCM 块 RMS 的 momentary 估算，用于播放器可视化，不作为合规响度计量。

## Capabilities 与错误 JSON

`TAE_GetEngineCapabilities()` 使用 C ABI 的 buffer/required-size 模式返回 JSON。稳定字段包括：

- `defaultBackend`：当前平台默认 backend id。
- `pcmPassthrough`：当前构建具备 per-playback PCM passthrough 判定能力；实际状态以 `outputInfo.pcmPassthrough` 为准。
- `outputPerfectRequiresPcmPassthrough`：`outputPerfect` 是否要求 PCM passthrough；当前为 `true`。
- `htmlAudioFallbackDefault`：Electron 是否默认允许 HTMLAudio 兜底；现阶段为 `false`。
- `backends` / `backendCapabilities`：后端能力列表，两个字段保持兼容。
- `features`：FFmpeg、WASAPI、ASIO、CoreAudio、ALSA、Native DSD、DoP、SACD ISO 能力布尔值。
- `dsd`：DSD 能力模型。DSF/DFF 与 SACD ISO 未压缩 DSD area 可进入 Native DSD / DoP / PCM fallback 决策链；DST 压缩曲目（SACD ISO DST area 与 DSDIFF `'DST '` form/CMPR `"DST "`，含 DSTF 帧表 + FRTE 帧率，seek 按帧索引）通过 DSD-preserving provider（vendored dstdec 算术核心，LGPL-2.1+，输出原始 DSD 字节而非 PCM）解出 DSD 后，同样进入该决策链。管线播放前探测同样接有 provider，DST 源的 `dsdProbe` 不会因缺解码器而失败。provider 默认可用，此时 `sacdIsoDst=true`、`sacdIsoDstMode="native"`、`sacdIsoDstDsdProvider=true`；provider 不可用时退回 `sacdIsoDst=false`、`sacdIsoDstMode=unavailable`、`sacdIsoDstReasonCode=dst_dsd_provider_unavailable`。

`TAE_GetLastError()` 同样使用 buffer/required-size 模式，返回 `hasError`、`code`、`message`、`backend`、`context`、`recoverable`。

## 引擎诊断事件日志

`TAE_GetDiagnosticLog(engine, since_sequence, max_entries, buffer, buffer_size, required_size, next_sequence)`
返回引擎侧进程级环形日志（512 条封顶）中 `sequence > since_sequence` 的条目，按时间升序的 JSON 数组；
`next_sequence` 回传下次轮询的游标，保证增量拉取不重不漏。N-API 导出名 `GetDiagnosticLog(sinceSequence, maxEntries)`。
每条形如：

```json
{
  "sequence": 4,
  "timestamp": "2026-08-27T10:51:56.695Z",
  "level": "warning",
  "event": "dsd_pcm_fallback",
  "message": "Current output backend cannot carry DSD or DoP",
  "details": { "backend": "wasapi", "dsdRate": 64 }
}
```

埋点事件（只对 DSF/DFF/SACD ISO 源记录，普通 PCM 不产生噪音）：

- `dsd_route_decision`（info/warning）：管线路由决策快照（backend/mode/速率/各 canTry 门/dsdRate/probeError）。
- `dsd_probe_failed`（error）：播放前 DSD 探测打开源失败（如路径不可读）。
- `dsd_pcm_fallback`（warning）：DSD→PCM 降级及其具体原因文本。
- `dsd_route_engaged`（info）：Native DSD / DoP / PCM→DSD 路由成功建立。

main 进程（`engineIpc.ts`）在播放状态变化、引擎错误与诊断导出时按游标增量拉取，并入
`audio-diagnostics.jsonl`（`details.source: "engine"`）；导出报告的"事件时间线"分节据此渲染
警告/错误 + 路由决策（`selectTimelineEvents`，上限 40 条）。

## 双状态判定规则

最终 `outputPerfect=true` 必须同时满足：

- 后端当前路径声明 `supportsOutputPerfect=true`。
- decoded PCM 与实际输出格式的采样率、有效 PCM 位深、声道数和 sample format 完全匹配。
- 当前 PCM 路径已验证样本级 passthrough，即 `outputInfo.pcmPassthrough=true`；Float32 -> Int24、Int24 -> Float32、Int24 -> Int24-in32 等 sample format 或容器变化都不算 passthrough。
- 后端没有报告 `resampled=true`。
- 音量为 1.0。
- ReplayGain、Loudnorm、EQ、Convolver、Crossfeed、Crossfade 均未启用。
- 声道 routing 不改变声道语义。

`volumeNormalization` / ReplayGain 模式：

| 模式       | 含义                                                | perfect reason      |
| ---------- | --------------------------------------------------- | ------------------- |
| `off`      | 不归一                                              | —                   |
| `track`    | ReplayGain Track 或 R128 track 标签                 | `replaygain_active` |
| `album`    | ReplayGain Album 或 R128 album 标签                 | `replaygain_active` |
| `loudnorm` | EBU R128 Loudnorm（独立模式，**不得**映射为 Track） | `loudnorm_active`   |

`loudnorm` 使用离线 EBU R128 测量（`TAE_AnalyzeLoudness` / libebur128 integrated + true peak），缓存键对齐 BPM（path|size|mtime|algo|target|ceiling）。完整解码只在独立 `audioAnalysisService` utility process 中执行，不得通过播放 `audioEngineService` RPC。analysis pool 有独立 watchdog、优先级、并发/队列上限和取消；worker 超时/退出不会重启播放 service。C ABI 的 size probe 会在线程局部保存一次分析结果，紧随其后的 buffer read 只复制 JSON；`TAE_GetAnalysisExecutionCount("bpm"|"loudness")` 可验证 probe/read 没有重复解码。默认目标 **−23.0 LUFS**、True Peak 上限 **−1.0 dBTP**，再叠加 `replayGainPreamp`。缓存命中时增益为 `(targetLufs - measuredIntegratedLufs) + preamp`，超 ceiling 再衰减；无缓存时首播使用 `replayGainFallback` + preamp 并后台测量，状态为 measuring/cached/fallback/unavailable。无 libebur128 时报告 unavailable 并用 fallback，禁止假成功。始终报告 `loudnormActive` / `loudnorm_active`。

**Stage-1 UI 契约：** Renderer Settings 与 HiFi 控制台必须从 `src/shared/audioProcessingOptions.ts` 暴露完整 `volumeNormalization` / `dsdOutputMode` 选项集（含 `loudnorm`）。软件音量默认 **0.7**；bit-perfect 需用户显式 Unity（1.0），`perfectReasonCode=volume_not_unity` 时提供 CTA。禁止静默把默认音量改成 1.0，禁止在任一 UI 路径「forbid loudnorm」。

**Stage-2 输出采样率锁：** 采样率锁 / resampler / dither 仅通过 DSP graph `outputStage` 配置（`AudioEngineManager.setOutputStage` / HiFi 输出页 / DspRack）。非 `device` 目标采样率或启用 SRC/dither 会使 `outputPerfect=false`。`setAudioProcessing` 重写 legacy graph 时保留既有 `outputStage`。

### 库内批量响度分析

`window.api.loudnessAnalysis` 增加以下方法。DTO 唯一定义在 `src/shared/libraryLoudness.ts`，handler 由 `audio/loudnessIpc.ts` 注册，经 `libraryLoudnessIpc.ts` 校验可信 sender、字段、数量、16 MiB 载荷上限及本地路径；实际读取前由 `resolveAuthorizedAudioFile` 检查授权与 canonical path。

| 方法 / 事件                 | 行为                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `startBatch(groups)`        | 开始一个有界任务，返回状态和全部项目；已有运行任务时拒绝新任务                          |
| `cancelBatch(jobId)`        | 只取消匹配任务，等待当前分析退出；旧 jobId 不影响新任务                                 |
| `getBatch()`                | 返回本次应用运行内最近任务的快照                                                        |
| `getResults(groups)`        | 按当前完整成员和文件身份返回 `measured`、`missing` 或 `unavailable`，专辑结果附成员测量 |
| `clearResults(ids)`         | 清理这些分组的记录和备份；分析运行期间须先取消                                          |
| `onBatchProgress(callback)` | 订阅 `loudnessAnalysis:batchProgress`，返回解除订阅函数                                 |

其余五个通道使用同名 `loudnessAnalysis:<方法>`。状态中的 `total` / `processed` / `failed` 按组计数，`currentTitle` 标识正在处理的曲目或专辑；专辑内部不伪造逐曲百分比。`revision` 单调递增，renderer 用它丢弃旧快照。完整任务上限 10,000 首，每张专辑 1–256 首；Track 组必须恰好一首。关闭面板不会取消分析，应用退出会取消在途任务，完成的记录可跨重启读取。

原生 `AnalyzeLoudness(source, optionsJson)` 保留单文件返回格式，并增加分组输入：

```json
{
  "segments": [
    { "source": "D:/Music/disc.flac", "startSeconds": 0, "endSeconds": 180 },
    { "source": "D:/Music/disc.flac", "startSeconds": 180, "endSeconds": 390 }
  ],
  "album": true
}
```

分组返回 `{ tracks: LoudnessAnalysisResult[], album: LoudnessAnalysisResult | null }`。省略区间时测量完整文件；批量输入的 `maxAnalysisSeconds` 必须省略或为 0，不能把采样片段标为完整专辑。原始测量必须为 `source: 'analyzed'`、`available: true`、`algorithmVersion: 2`，且 LUFS、峰值和时间戳有效。旧原生模块、解码错误、静音 / 不足以形成综合响度的区间、缺失成员、越过文件末尾的 CUE 都显式失败；整个分组不返回半套 `tracks` 或 Album 值。

| 数值              | 单位与计算                                                 |
| ----------------- | ---------------------------------------------------------- |
| `integratedLufs`  | libebur128 的综合响度，LUFS；不是播放块 RMS 估算           |
| `truePeakDb`      | oversampling true peak，dBTP；不是 sample peak dBFS        |
| ReplayGain 2 gain | `−18 − integratedLufs` dB                                  |
| R128 gain         | `−23 − integratedLufs` dB；Q7.8 数值为增益 dB × 256 后取整 |
| Peak linear       | `10 ** (truePeakDb / 20)`                                  |

Album 保留每首的 libebur128 测量状态，再调用 `ebur128_loudness_global_multiple` 合并门限统计；不能平均各曲目的 dB。专辑真峰值取成员最高值。JSON 数值保留至 0.001，界面展示两位小数。首版结果供库内查询与后续分析复用，不写文件标签，也不改变播放增益；既有自动 loudnorm 仍用独立的 512 项缓存，该缓存算法身份也升级至 2。

专辑分组直接使用 `useMusicStore().albums`：其稳定 ID、合辑合并及多碟排序继续遵循已有曲库规则。选中一首进行 Album 分析也会包含该专辑在当前曲库中的全部成员。身份不是只凭同名标题重建的；曲库成员变化后，旧专辑测量无法命中新成员指纹。CUE 使用实际源区间 `[startSeconds, endSeconds)`，起止位置分别转换到最近 PCM 样本；显式 PREGAP 产生的虚拟静音不参与测量，源内 INDEX 00 仍按既有区间归属处理。为保证样本边界，离线分析从文件开头解码并跳过起点前的 PCM，后段 CUE 会重复解码前缀。没有 CUE 区间的容器子曲目尚不支持，不能退化为测量整个容器。

记录位置为 `userData/library-loudness/<sha256(groupId)>.json`，schema version 1，每组最多 512 KiB，使用现有 JSON 原子替换和备份恢复。指纹包含算法版本、Track/Album 模式、全部有序成员 ID、canonical path、size、mtime 和实际 CUE 起止点；虚拟 PREGAP 不影响测量身份。Track 与 Album 分别缓存；专辑记录中的成员结果随该专辑一起清理。读取同样重新验证授权和源文件，失效数据只显示未分析 / 不可用。清理只删除此库内目录的确定记录和备份。

`libraryLoudnessManager` 每次向独立分析池提交一组，任务种类 `loudness-batch`、优先级 −20、执行 deadline 14,520 秒，复用现有队列上限、aging、等待 deadline 和 worker 重启。取消只终止该种类，不取消自动 loudnorm 或 BPM。每组测量完成后再次验证文件身份；取消检查后立即同步原子提交一份小记录，检查与提交间没有异步等待。当前组取消、源文件变化或部分成员失败时不发布该组结果，先前完整提交的其它组保留。worker 崩溃表现为组失败，可手动重试；不会重启播放 service。

验证：`test:audio-manager` 覆盖取消边界、源文件 / CUE / 成员失效、持久化失败、IPC 授权和与播放的隔离；`test:local-perf` 覆盖完整专辑分组及 Electron 面板的键盘、焦点、重试、旧请求和 10,000 项虚拟 DOM。`test:loudness-native` 使用确定的 48 kHz stereo PCM fixtures，LUFS 容差 0.15、1 kHz 真峰值容差 0.1 dB、重复测量和 CUE 对切片参考容差 0.001，并校验逐样本区间、intersample peak、静音、缺失与截断失败；该测试已接入 `test:audio-engine:mingw`。

### 原生音频能力清单

`resources/audio-engine/audio-capabilities.json` 由 `pnpm run stage:audio-engine` 生成；开发环境可单独运行 `pnpm run generate:audio-capability-manifest`。`artifactDirectory` 固定为逻辑根 `.`，全部 artifact 路径相对此根，绝不写入构建机绝对路径。清单只检查实际暂存的原生二进制与其导入表，记录 SWR、CPU PCM→DSD、miniaudio PoC、CUDA 和其它 GPU backend 的编译事实；CUDA 与其它 GPU 导入检查覆盖每个成功解析的 native artifact，主引擎专属的 PCM/SWR 判断仍只读取引擎二进制。

每项 native artifact 都包含 `importInspection`。解析失败时状态是 `unavailable`（例如非 PE），而非空导入表等同于“不存在 GPU”；此时 `cuda.compiled` 为 `null`，相关 `importInspectionComplete=false`，必须先修复检查或取得可解析产物才能声明未编译。完整检查中没有对应产物证据时，能力才为 `false` 或空数组，不能由设置项、UI 文案或二进制中的一般性字符串推断。

`release-capability-status.json` 是与 manifest 配套的发行声明，受控项为 ASIO、VST3、SoXR、ebur128、CUDA 与 Native DSD provider。每项同时保留 `buildStatus`、`runtimeStatus` 和 `deviceVerification`，以及每个维度的 `evidence.state`、`reason`、`provenance`；值只能是 `available`、`experimental`、`unverified`、`not-built` 或 `unsupported`。运行观察仅接受 `audio-engine-runtime-observation` 且其 artifact hash 必须逐一匹配 manifest。没有真实设备证据必须是 `unverified`，而不是把缺设备变成构建错误或由设备名猜测为可用。

SoXR 不是独立链接的宿主 backend，而是 FFmpeg 的构建可选 resampler engine。清单把它标记为 `ffmpeg-runtime-probe`：只有播放期 `DspOutputStageStatus.resamplerEngine` 与 `resamplerFallback` 才能报告实际 engine 和回退。没有 runtime observation 只表示“未观察”，不表示 SoXR 已可用，也不把它伪装为编译保证。

miniaudio 0.11.25 是 Windows Shared/default PCM provider PoC。通用 CMake 选项 `TAE_ENABLE_MINIAUDIO` 仍默认关闭，但 Windows MinGW 发布 preset 已将它打开以保证目标二进制具备可回退的实验实现；编译期默认 provider 通过 `TAE_DEFAULT_PCM_PROVIDER` 固定为 `legacy`，因此当前未设置 `TWILIGHT_AUDIO_PCM_PROVIDER` 时仍使用现有 legacy provider。只有显式设置 `TWILIGHT_AUDIO_PCM_PROVIDER=miniaudio` 才选择 miniaudio，`legacy` 是明确 rollback 值；非法值和未编译 provider 均明确失败，不静默回退。MA-101 的 callback 固定为 Float32 interleaved，并关闭 WASAPI `AUTOCONVERTPCM`，使 miniaudio 自己的 converter 与公开的 internal device facts 保持可区分；设备通知在 control event path 延迟派发。Manifest 中的 `capabilities.miniaudio.compiled=true` 只说明 staged 主引擎包含该 PoC 代码与 WASAPI backend 编译标记；`runtimeStatus` 和 `deviceStatus` 在真实运行与设备 A/B 证据前保持 `unverified`，也不改变公开 backend id、默认输出选择或 G3/G4 采用结论。

Manifest 中的 `capabilities.pcmOutputProvider` 单独列出 `buildAvailability`、当前编译默认 `defaultProvider`、实际打开路由的 `activeProvider`、`runtimeObservation` 和 `deviceVerification`。暂存阶段没有打开播放路由时 `activeProvider` 必须为 `null`，这不等同于 legacy 或 miniaudio 已完成真实设备验证；`rollbackProvider` 固定为 `legacy`。因此构建可用性、活动实现、运行观察和设备验证不能互相推断或合并。

当前批准的产品术语是“PCM SRC”和“实验性 PCM→DSD64/128/256（CPU）”。CUDA SDM 与完整高品质 SDM 在 AP-409 完成并拥有数值、性能及真机证据前不得作为支持能力发布。

**Stage-2 平衡/相位与库标签：** HiFi 通过 `AudioEngineManager.setStereoImage` 写入 default graph 的 stereoField + channelStrip polarity（`DspStereoImageConfig`：balance/width/mid-side/invert/swap/mono）。`createLegacyDspGraph` / `setAudioProcessing` 必须保留既有 `stereoImage`。任一非默认立体声图像 ⇒ `outputPerfect=false`。本地库扫描持久化 ReplayGain/R128 标签，经 `NativeQueueLoadItem` / `AudioEngineQueueItem` / 原生 `QueueItem` 注入 `ReplayGainInfo`（覆盖 decode 缺标签）；session restore 保留字段；`loudnorm` 仍只消费离线测量缓存。

**Loudnorm 状态与硬化：** `prepareLoudnormForPlay` 推送 `loudnorm-status`（measuring|cached|fallback|unavailable|idle）到 renderer HiFi 与 Settings；`setAudioProcessing` / `setReplayGainMode` 离开 loudnorm 时立刻 `cancel` 并发 `idle`，播放中切入 loudnorm 时对当前 `source` 重新 prepare。`setReplayGainMode` 必须走 `setAudioProcessing`，保证 default-scene graph 与 `SetReplayGainMode` 双路径一致。测量完成后 `LoadQueue` 注入 `measuredIntegratedLufs` / `measuredTruePeakDb`，`AudioPipeline::refreshQueueReplayGainTags` 把测量叠到当前/预加载流的 `ReplayGainInfo`（不 reopen 设备），本曲即可从 Fallback 切到测量增益。异步测量回调在 destroy / 离模式 / 换曲后丢弃。隔离 analysis pool 默认并发 1、队列有界，loudnorm 高优先级；identity 命中跳过重测、切曲/关模式 `cancel` 后不写缓存、缓存上限 512、Settings 清空缓存会 `notifyLoudnessCacheCleared` 重准备当前曲。

`sourceExact=true` 额外要求源格式无损，并且源格式与实际输出格式完全一致。有损格式可以达成 `outputPerfect=true`，但 `sourceExact=false`，原因会显示为 `Source is lossy; decoded PCM path is output perfect`。

各后端只声明能力和实际格式；`TwilightAudioEngine` 与 `AudioPipeline` 不按 backend id 硬编码最终状态。WASAPI Exclusive / ASIO 当前可以在处理链完全 bypass、音量为 1.0、routing 保持语义且 decoded PCM 与后端实际格式完全一致时走 typed PCM passthrough；Int16/Int24/Int32/Float32 都由 `PcmBlock`、typed `AudioBuffer` 和后端 typed render 承载。整数 PCM 源如果因为格式不匹配或处理链要求被转换到 Float32，再由后端重新打包为整数输出，仍必须报告 `outputPerfect=false`、`pcmPassthrough=false` 和具体原因，例如 `integer_passthrough_unavailable` 或 `pcm_converted`。

## DSD / DoP / SACD 语义

- DoP carrier：DSF/DFF DSD64/128/256/512 在后端、设备、声道数和实际 PCM carrier 格式满足条件时可进入 `dsdMode=dop`，遵循 dCS DoP open standard v1.1（24-bit、`0x05`/`0xFA` marker 交替）。carrier 采样率：DSD64=176.4kHz、DSD128=352.8kHz、DSD256=705.6kHz（44.1k family）/768kHz（48k family）、DSD512=1411.2kHz（44.1k family）/1536kHz（48k family）。carrier 上限从 DSD128 提升到 DSD512，但运行时仍由设备 carrier-rate 能力决定：ASIO 读取 `dopCarrierSampleRates`，WASAPI Exclusive / CoreAudio Exclusive 通过 `IsFormatSupported` 运行时探测。UI 展示为 DSD 源到 `DoP carrier` 再到后端实际输出；它不同于 PCM fallback，因为 carrier 保留 DSD bitstream。
- PCM fallback：DoP carrier 条件不满足（包括设备不支持 DSD256/512 carrier 速率），或软件音量、ReplayGain、EQ、Convolver、Crossfeed、Crossfade 等处理启用时，必须走 PCM fallback。UI 展示为 DSD 源到 PCM 工作格式再到后端实际 PCM 格式，不把它标为 Native DSD 或 DoP。
- DSD downrate：`dsdRatePolicy` 可选 `pcm-fallback`（默认）、`exact`、`downrate`。`downrate` 在 source rate 的 Native/DoP 候选被拒绝后，按同 family 的 DSD256/128/64 依次重试；全部失败才 PCM fallback。`DsdDownrateProcessor` 在 DSD 域内以 63-tap FIR、幂二抽取和有界一阶误差反馈 1-bit 重调制完成 x2/x4/x8 转换，configure 后 process 不分配，seek/reopen 时 reset。输出诊断报告 `actualDsdRate`、`dsdConversion`（`exact|downrate|pcm-fallback`）及 `dsdConversionReason`；降倍率始终 `sourceExact=false`、`resampled=true`、`outputPerfect=false`，并使用 `dsd_downrated` reason code。真实 DAC 的 DSD256/512 和 48 kHz-family 降倍率验收仍待证据，不得据此宣称真机资格已完成。
- Native DSD：指后端和设备直接接收 DSD bitstream。当前支持 ASIO 与 Linux ALSA `hw:` 设备（通过 `SND_PCM_FORMAT_DSD_U8` / `DSD_U16_LE` / `DSD_U32_LE` 直送 DSD，rate = DSD bit-clock / phys_width：DSD64→U8@352.8k、DSD128→U8@705.6k、DSD256→U16_LE@705.6k、DSD512→U32_LE@705.6k，静音字节 `0x69`，格式选择顺序按 MPD 约定 U8→U32_LE→U16_LE），`backendCanAttemptNativeDsd("alsa")==true`，nativeDsdRuntimeFacts 在打开时为 Candidate、首次成功 `writei` 后为 Proven。只有运行态证明为 `proven` 才能声明 native。WASAPI 与 CoreAudio 没有 native DSD 通道（WASAPI 无 UAC2 native DSD path、CoreAudio 无 DSD path），属平台限制而非代码缺口；这两个后端走 DoP（Exclusive / Hog）或 PCM fallback。
- SACD ISO：支持未压缩 DSD area 的曲目切片播放；`?area=stereo|multichannel&track=N` 可选择具体 program/track。DST 压缩曲目通过 DSD-preserving provider（vendored FFmpeg dstdec 算术核心，LGPL-2.1+，输出原始 DSD 字节而非 PCM）解出 DSD 后，进入与未压缩 DSD 相同的 Native DSD / DoP / PCM 决策链。provider 默认可用；provider 失败时报 `dst_dsd_provider_failed`，provider 不可用时退回 `dst_dsd_provider_unavailable`，禁止把 FFmpeg PCM DST decode 包装成 Native DSD/DoP 成功。

`GetMetadata()` 对 SACD ISO 返回 `isoTracks[]`。每个 track 带有 `playable`、`reasonCode` 和 `outputModes`：未压缩 DSD track 为 `playable=true` 且 `outputModes=["native","dop","pcm"]`；DST track 在 provider 可用时（默认）同样为 `playable=true`、`codec=dst`、`outputModes=["native","dop","pcm"]`，仅当 provider 不可用时才退回 `playable=false`、`reasonCode=dst_dsd_provider_unavailable`、`outputModes=[]`。

Phase 6B 的后端规则：

- WASAPI Shared 永远不进入 `outputPerfect=true`，原因应说明系统 shared mixer。
- WASAPI Exclusive 只有独占打开成功、实际 PCM 格式完整上报且与 decoded PCM 完全匹配时，才允许进入 evaluator 判定；协商失败要区分 sample rate、bit depth、channel、sample format 或 exclusive open。
- ASIO 只有驱动成功加载、buffer 创建成功、实际 sample format/采样率/声道/位深完整上报且与 decoded PCM 匹配时，才允许进入 evaluator 判定。
- CoreAudio shared 路径继续 `outputPerfect=false`；`coreaudio-exclusive` 后端在 Hog Mode 获取成功、采样率匹配且整数 PCM 直通时进入 evaluator 判定。
- ALSA `default` / `plughw:` 默认可能经过插件转换，继续 `outputPerfect=false`；只有显式 `hw:` 且实际格式完全匹配时才允许进入 evaluator 判定。

## Render Performance Metrics

`outputInfo.renderPerformance` is a lock-free snapshot maintained by the native render path:

- `callbackCount`: number of PCM or typed render callbacks observed since the pipeline opened.
- `totalCallbackNanoseconds` / `meanCallbackNanoseconds` / `peakCallbackNanoseconds`: callback execution time totals and latency summary.
- `totalDeadlineNanoseconds`: sum of audio-buffer deadlines derived from callback frame count and sample rate.
- `deadlineMissCount`: callbacks whose measured execution time exceeded that deadline.
- `callbackDeadlineLoadPercent`: `totalCallbackNanoseconds / totalDeadlineNanoseconds * 100`.

These fields measure native callback deadline load. They are not a claim about process CPU, system CPU,
or real-device scheduling. The deterministic `twilight_audio_performance_gate` CTest emits the same
metrics with decoded WAV, gapless/crossfade, convolution, controlled VST3-host pressure on Windows,
diagnostic deltas, and working-set snapshots. A physical WASAPI Exclusive soak is opt-in through
`pnpm run smoke:audio-performance -- --device "<endpoint>" --duration-seconds 300 --json`; keep that
JSON separately as real-device evidence and do not substitute the controlled-pump result.

## Recovery Diagnostics

`outputInfo.diagnostics` 记录当前 session 与 lifetime 的恢复信息：

- `sessionUnderrunCount` / `lifetimeUnderrunCount`：本次打开或进程生命周期内的 underrun/xrun 次数。
- `sessionBufferDropCount` / `lifetimeBufferDropCount`：缓冲提交失败或丢弃次数。
- `sessionRecoveryCount` / `lifetimeRecoveryCount`：恢复成功次数。
- `driverRestartCount`：驱动重启或重置事件计数。
- `deviceLostCount`：设备丢失事件计数。
- `lastError`：最近一次后端错误或恢复原因。

ASIO 保留冷却与恢复诊断策略。ALSA 提供基础 xrun 恢复：`snd_pcm_prepare()` / `snd_pcm_resume()` 成功后更新 underrun 与 recovery 计数。

Electron IPC 会在 audio service crash 时同时发送结构化 `audioEngine:service-crash { reason }` 与兼容错误文案。Renderer 恢复提示应优先订阅结构化事件；service ready 后只恢复配置、队列和状态，不自动续播，由用户通过提示按钮手动继续。输出路由恢复必须按 `output-backend -> output-device -> output-config` 顺序等待 RPC ACK，避免设备或 buffer 配置套到旧后端。native 侧把 backend/device 视为待提交 topology，只有随后的 output-config 才一次性重开当前 stream；禁止 backend/device 各自用半套 route 连续重启。用户触发的输出后端、设备、独占模式和输出配置切换使用同一可回滚事务：先枚举/验证目标，事务静音后按 backend/device/config 应用目标并等待 ACK，commit 后才恢复原软件音量；目标打开、ready ACK、service generation 或配置 revision 竞争失败时回滚旧 backend/device/config，旧设备也不可用时执行 safe-stop 并保持无自动重播。DSP 恢复顺序固定为 `SetDspPluginChain -> ApplyDspState(revision, payload) -> LoadQueue`；统一 payload 同时携带 processing、scene 和完整 graph，service 对 processing 字段合并、对 graph 采用最新完整 snapshot，并把同一批次等待者统一解析到最终 ACK。native 只有在 isolated active/preload 候选全部成功且 RT retirement window 未满时才提交；失败保持旧配置和旧 applied revision。`GetDspGraphStatus.revision` 是 Renderer pending/applied/failed 的权威 ACK。`audioEngine:service-ready` 会携带 `{ manualResumeRequired, outputRouteSynced, restoreErrors }`，只有输出后端、设备和输出配置恢复成功时 UI 才应展示“继续播放”动作；失败时提示用户重新选择输出设备。

## 设备能力与刷新事件

`AudioDeviceOption` 可携带 `dopSupportState` 与 `nativeDsdSupportState`，取值为：

- `verified`：设备枚举或驱动事实已明确提供能力，例如 ASIO 枚举到 carrier/native DSD 格式。
- `runtime-probed`：枚举阶段不能静态证明，但播放打开时可通过后端格式探测确认，例如 WASAPI/CoreAudio DoP carrier 或 ALSA `hw:` native DSD。
- `unsupported`：平台或路径不支持，例如 WASAPI/CoreAudio native DSD。
- `unknown`：当前枚举信息不足，UI 应避免展示为已支持或不支持。

main 进程会在输出后端、设备、独占模式、audio service recovery、native 输出诊断变化时清空设备能力缓存，并向 renderer 发送 `audioEngine:device-options-changed`。Windows 主窗口监听 `WM_DEVICECHANGE`，经过短 debounce 后触发 `platform-device-change:wm-devicechange` 刷新，用于更快捕捉常见 USB DAC/ASIO 设备插拔。Linux 监听 `/dev/snd`，当 ALSA `hw:` 设备节点变化时触发 `platform-device-change:alsa-dev-snd` 刷新；如果该目录暂不存在、watcher 创建失败或关闭，会保留轮询兜底并低频重试 watcher。CoreAudio shared/exclusive 后端在打开设备后监听设备在线状态和 HAL 设备列表变化，用于触发播放路径的 device-lost/recovery；manager 保留 5s 低频设备选项轮询作为兜底。这不是高级多设备同步的完整替代。

## 后端支持矩阵

| 后端                      | 平台        | 当前状态                                                               | outputPerfect 能力                                                                                                                                                                   |
| ------------------------- | ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WASAPI shared             | Windows     | 已接入并通过 MinGW 测试矩阵                                            | `supportsOutputPerfect=false`，经过系统混音                                                                                                                                          |
| WASAPI exclusive          | Windows     | 已接入格式协商和 smoke 覆盖                                            | 独占成功且 actual PCM format 与 decoded PCM 完全匹配后进入 evaluator                                                                                                                 |
| ASIO                      | Windows x64 | 独立 SDK-free 兼容层；默认枚举已安装驱动，可显式禁用                   | mock 覆盖 Int16/Int24/Int24-in32/Int32/Float32；真实设备 smoke opt-in                                                                                                                |
| CoreAudio shared          | macOS       | 源码后端存在，需 macOS 工具链验证                                      | `supportsOutputPerfect=false`，经过系统混音                                                                                                                                          |
| CoreAudio exclusive (Hog) | macOS       | 已实现 Hog Mode + 采样率匹配 + 整数 PCM 直通，需 macOS 工具链/设备验证 | Hog 获取成功且 actual PCM format 与 decoded PCM 完全匹配后进入 evaluator                                                                                                             |
| ALSA                      | Linux       | 源码后端存在，需 Linux 工具链/设备验证                                 | `default`/`plughw:` 默认 false；仅显式 `hw:` 且格式完全匹配时可为 true。`hw:` 支持 native DSD 直送（`DSD_U8`/`DSD_U16_LE`/`DSD_U32_LE`），`backendCanAttemptNativeDsd("alsa")==true` |

## 当前非闭环范围

当前不包含高级多设备同步；Windows 已接入 `WM_DEVICECHANGE` 事件刷新，Linux 已接入 ALSA `/dev/snd` 节点 watcher，CoreAudio 播放后端已接入设备失效监听，但 macOS 枚举级复杂热插拔同步仍待真实设备验证和补充。所有平台仍保留轻量设备选项轮询和 recovery-triggered 能力刷新。SACD DST 已通过 DSD-preserving provider 闭环（provider 默认可用）。Native DSD 支持 ASIO 与 ALSA `hw:`；WASAPI 与 CoreAudio 没有 native DSD 通道，属平台限制而非代码缺口，这两个后端走 DoP 或 PCM fallback。ASIO 兼容层不携带 SDK，且仅在 Windows x64 构建中编译；默认枚举并可激活已安装驱动，设置 `TWILIGHT_DISABLE_ASIO=1` 可显式禁用。真实设备 smoke（WASAPI Exclusive / ASIO PCM / DoP DAC / Native DSD / SACD ISO / CoreAudio Hog / ALSA `hw:`）通过 `TAE_RUN_REAL_AUDIO_BACKEND_TESTS=1` 开启，opt-in，不进入默认 CI 门禁，不伪造结果；没有对应设备时必须跳过并保持默认验证通过。`pnpm run smoke:audio-evidence -- --input <evidence-envelope.json>` 或 `--input-dir <dir>` 可把多台机器/多设备的 opt-in 结果沉淀为 Markdown/JSON 报告，并显式列出未覆盖的 required surfaces。报告 JSON 包含 `coverage.complete`、缺失/失败 surface 列表和未闭环 surface 的 `actionPlan`；只有带固定采集元数据、存在本地 artifact 与匹配 SHA-256 的 `real-device` pass 计入 complete，mock/未知来源不计入。发布前可手动加 `--require-complete` 让证据不完整时退出非 0。证据库采集与判定细节见 [Audio Smoke Evidence](./audio-smoke-evidence.md)。

## 等响度试听会话

`window.api.audioEngine.audition` 使用 `shared/dspAudition.ts` 唯一契约：

- `measure({ source, startSeconds, endSeconds, a, b })` 冻结当前已授权本地源、文件 size/mtime、CUE 区间和两套 graph，返回会话 ID、A/B 处理后 LUFS/True Peak、共同目标及补偿。期间不改变播放；每次重新测量，不复用源文件响度缓存。
- `select(id, 'a' | 'b')` 在音源、设备和 DSP revision 仍一致时，经 AudioEngineManager 与 DSP ACK 应用临时补偿图；成功后才返回选中状态。不 seek、不重建队列、不保存场景或设备档案。
- `status()` 返回有效会话或 `null`；`end()` 取消测量并等待在途切换，在 revision 未被其他修改替换时恢复原有处理设置。旧请求、外部设置/设备变更和引擎恢复使会话失效，不能用旧恢复覆盖新配置。

四个 IPC 为 `audioEngine:measureDspAudition/selectDspAudition/getDspAudition/endDspAudition`。入口验证 sender 和有界 JSON；本地文件仍由 path grants 授权。分析走独立 `audioAnalysisService` 的 `dsp-audition` 类别，取消不影响同源 loudnorm。原生 `AnalyzeLoudness` options 增加 `processedGraph`、`startSeconds`、`endSeconds`，响应 `processingVersion: 1` 才可参与匹配；旧引擎或仅源文件测量不可冒充处理后结果。

首版接受单/双声道、本机可解码为 PCM 的音频，要求实际输出同采样率、同声道数、正常速度、自动声道路由；不接受 DSD/DoP、远程、交叉淡化、输出重采样/抖动或其他 DSP 节点。图只允许无处理或一个内置 EQ；不改变 PCM 的 meter 观察节点在分析图中略去。区间长 10–60 秒、起点不晚于 600 秒，CUE 不得越过当前段。静音、截断、削波、超出 ±24 dB 前级范围或复测失败均不显示“已匹配”。补偿只衰减，以共同可用目标约束两侧 True Peak；补偿后再次原生测量，要求差值 ≤0.1 LU、峰值 ≤−1 dBTP（允许测量舍入误差 0.01 dB）。这只说明选定区间的测量结果，不保证主观等响，也不保证曲目其他区间或外部设备链路的峰值。

### 连续播放策略与交叉淡化

`OutputConfig.playbackPolicy` 为 `bit-perfect-first | continuity-first`，旧配置归一化为前者；`continuitySampleRate` 为 44100、48000（默认）或 96000。设置和设备档案共同保存该配置，经既有输出事务应用，播放中切换保留进度和暂停状态并重新打开输出。连续模式对 PCM 请求固定双声道 Float32，采样率优先于场景 outputStage 的目标，复用 FFmpeg/libswresample；设备协商后的实际格式在本次连续序列内复用于下一首。界面并列显示来源、请求目标及实际格式，不以策略名称宣称 bit-perfect。该模式要求自动声道路由、关闭 PCM 转 DSD，冲突配置拒绝应用。

原样优先只预加载来源采样率、位深、声道和采样格式兼容的 PCM。连续优先允许上述 PCM 格式变化，同专辑、专辑边界和混排均遵循同一个固定目标。DSD 不参与 PCM 连续预加载，保留原有 DSD 选路并以正常切歌重新打开；不代表实现 DSD gapless。新候选失败时撤下旧预加载，保留当前播放和未消费的新曲起点，运行状态继续报告阻断。

处理设置新增 `crossfadeCurve: linear | equal-power`（默认 linear）与 `crossfadeContent: conservative | all | live`（默认 conservative）。线性增益为 `(1-t,t)`，等功率为 `(cos(πt/2),sin(πt/2))`，`t` 限于 0–1；相关信号仍可能相加超过满幅，混音保留既有幅度限幅。conservative 保留同专辑且同艺术家的曲间边界，以及时长不足 `max(10, 2×请求淡化秒数)` 的短曲；all 可覆盖这两项，live 始终保留边界，不猜测文件名。CUE（包括精确 pregap）、DSD、未知时长和非正常速度始终不重叠。重叠上限取请求长度和两曲各自一半时长的最小值，避免在交接前耗尽下一首；seek 与变速重建下一首预加载，手动 next 遇到已消费的重叠流时重新打开下一首，从其起点播放。

`PlaybackInfo.sourceChannels` 补齐来源声道事实；`crossfadeCurve`、`crossfadeEffectiveSeconds`、`crossfadeBlockedReason` 和 `crossfadeMixActive` 分别报告实际曲线、规则允许的重叠上限、未生效原因和实时混合状态。原有 `crossfadeActive` 仍表达处理请求，不能当作正在混合的证据。两路先经过各自 DSP，再混合；没有新增自动响度分析或额外曲间响度匹配。
