# 内存优化（2026-11-08）

本轮处理失效查询堆积、播放过程中保留的分析窗口和卷积数据，以及封面落盘的整图复制。使用相同输入的前后对照验证对象保留量；下表是各自测试场景的结果，不应相加为整应用工作集下降量。

| 场景                                                   | 修改前                                    | 修改后                           |
| ------------------------------------------------------ | ----------------------------------------- | -------------------------------- |
| AutoMix 连续读取 128 个不同的磁盘分析窗口              | 保留 128 个窗口、384,000 个帧数值         | 保留 64 个窗口、192,000 个帧数值 |
| 140,000 帧单声道 IR，采样率按 8→16→32→48→96→8 kHz 切换 | 比切换前额外保留 13,441,466 字节 C++ 分配 | 额外保留 782 字节                |

## AutoMix 的磁盘命中也遵守内存预算

`src/core/audio/autoMixCoordinator.ts` 原先只在新分析完成后淘汰超过 64 条的内存窗口，磁盘缓存命中会绕过这一限制。两条路径现在共用同一淘汰方法，近期窗口继续复用，已淘汰窗口可从磁盘重新读取，不必再次分析。

读取磁盘缓存后还会重新检查取消状态和来源版本，避免 seek、停用或来源变化后，迟到的结果重新占用已清空的缓存；失效读取失败也不会继续启动分析。

新增的 3 项回归在旧实现上均失败，修复后通过。连同现有协调器、磁盘缓存及 Core AutoMix 服务，共 29 项测试通过。

## 卷积器释放旧采样率的数据

`audio-engine/dsp/ConvolverProcessor.{h,cpp}` 保留原始脉冲响应（IR）和当前采样率需要的 IR，取消每个实例对历次重采样结果的强引用。其他存活实例仍可共享已有结果。再次访问已经释放的采样率时，在控制路径重新准备；实时处理路径保持原有算法。

禁用或卸载卷积器时释放湿声延迟缓冲的容量。禁用仍保留原始 IR，以支持重新启用。

原生测试统计存活 C++ 分配，避免把分配器保留的空闲页误作仍被业务持有的数据。回切原采样率后逐样本输出比较通过；禁用/卸载覆盖 96 kHz、8 声道、250 ms 延迟。`twilight_convolver_unit` 和 `twilight_convolver_format_unit` 均通过，后者包含 WAV、FLAC、AIFF、AIFC。生产 `twilight_audio_engine` 目标构建成功。

## 封面写入不再复制整张图片

`src/main/cache/remoteCoverCache.ts` 将 MIME 头和原图作为两个分段交给 `writeFile`，替换此前的 `Buffer.concat`。临时文件、原子重命名和缓存维护流程保持原有行为。

24 MiB 图像在落盘调用入口的额外 ArrayBuffer 分配由 25,165,834 字节降至 0 字节。这个计量覆盖应用在进入写入 API 前的分配，不代表文件系统内部缓冲或整应用峰值。新增回归先验证旧实现失败，再验证优化后通过，并逐字节核对带非零偏移的图像视图；封面与元数据图片相关 8 项测试全部通过。

## 渲染层取消已失效的查询

`src/renderer/src/stores/player/corePlayerResource.ts` 原先只忽略旧回复，已经发出的慢请求仍会继续保留回调和响应数据。现在每个资源拥有独立的取消信号，状态变化、再次刷新、清空或卸载时取消旧请求。播放诊断、队列、歌词、书签和工作区的调用链均转发此信号；取消后的分页不会继续读取。

同一夹具连续触发 1,000 次状态更新，未完成请求由 1,001 个降至 1 个。新增测试还核对独立资源不会被误取消、取消不显示为业务错误、真正的查询失败仍可见，以及书签重新打开后能正常加载。旧回复隔离和结果冻结继续保留，播放诊断的刷新频率不变。渲染层相关 31 项测试通过。

## 复现

整合后的 `test:memory` 共 72 项通过；Core、Node、Web 类型检查、修改文件 ESLint、最终生产构建与 renderer 资源体积检查通过。新增回归已同时接入内存专项和 Core 测试入口。

```powershell
pnpm run test:memory
node --experimental-strip-types --test --import ./scripts/register-renderer-aliases.mjs src/main/audio/twilightAutoMixCoordinator.test.ts src/main/audio/twilightAutoMixCache.test.ts src/core/audio/autoMixService.test.ts
ctest --test-dir D:/TwilightEchoDependencies/builds/audio-engine-mingw -R 'twilight_convolver_(unit|format_unit)' --output-on-failure
```

原生测试路径是本机已有的 MinGW 构建目录；其他环境使用自己的 CMake 构建目录。

完整桌面内存测量沿用 [memory-benchmark.md](memory-benchmark.md) 的进程私有工作集、GPU 和堆统计口径。完整验收要求每种库规模重复 3 次、50 轮导航和 30 分钟持续播放；短时诊断不替代这一验收，也不用于宣称整体内存下降百分比。

## 桌面测量的实际限制

最终生产构建位于 `.artifacts/memory-optimization-20261108/production`。验证后的原生引擎已通过项目原有暂存脚本同步到 `resources/audio-engine`，下次启动开发版可加载卷积器优化。原运行文件备份在 `.artifacts/memory-optimization-20261108/runtime-before`。

桌面短测使用 AutoMix 和卷积修复后的中间构建，配置为 1,057 条合成记录、3 轮导航、20 秒播放观察和 12 秒阶段等待；封面与渲染层修改随后纳入最终构建。

正常沙箱启动在加载页面前崩溃，退出码 `-2147483645`；使用相同 Electron 运行空白沙箱窗口也复现此错误。诊断模式使用隔离配置及显式 `--diagnostic-no-sandbox`，成功加载曲库、开始原生播放并查询全部 1,057 条收藏状态，但在导航截图的前台绘制等待处超时。生产安全配置未修改。

两次运行均未完成验收，不据此给出整机内存节省量。报告分别位于 `.artifacts/memory-optimization-20261108/desktop-probe/report.json` 和 `.artifacts/memory-optimization-20261108/desktop-diagnostic/report.json`。后续整机对照需要在可正常启动沙箱渲染器和完成前台绘制的桌面会话中运行原基准。
