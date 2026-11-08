# ASIO 与 DSD 输出契约

ASIO 是 Windows x64 的实验性兼容后端。能力与发布状态以
[发布能力说明](./release-capability-status.md)及当前发布包清单为准。
历史设备测试记录不能代替当前构建的硬件验证。

## 契约与实现边界

- 独立 ABI、样本格式和 Native DSD 扩展以
  [ASIO 互操作规范](./legal/asio-interoperability-spec.md)为准。
- 驱动由独立 helper 加载，进程、控制协议、缓冲所有权、退出和超时约束见
  [ASIO helper 隔离架构](./asio-helper-process-adr.md)。
- 法律来源与决策保存在 [来源说明](./legal/asio-clean-room-provenance.md)和
  [决策记录](./legal/asio-decision-record.md)中。

## PCM、Native DSD 与 DoP

PCM 输出按实际协商的格式、声道和采样率处理。
Native DSD 使用驱动报告的 DSD 通道类型和 I/O-format 能力；
DoP 将 DSD 数据封装在 PCM 载波中，要求有效标记和支持相应载波的设备。
普通高采样率 PCM 不是 DSD 传输的证明。

DSD 格式切换后重新查询缓冲范围；驱动对缓冲单位、格式切换顺序及速率的
差异由后端实际能力、探测结果和回退原因说明。来源格式、传输格式和
设备输出格式是不同事实，不能通过采样率名称推断 Native DSD 或直通成功。

缓冲设置保留 PCM 配置单位。Native DSD 切换前后，如果驱动报告的最小值、最大值、
首选值和步长呈一致比例，按该比例换算传给驱动的计数。例如 FiiO 6.16.0 的 DSD256
比例为 256，设置 1024 对应驱动计数 262144，打包后每声道 32768 字节。
`asioStartupSummary` 分别记录 `requestedBuffer`、`bufferScale` 和 `driverBuffer`；
`bufferSizeFrames` 继续表示实际驱动计数。直接使用 `IAsioHost` 的调用方默认仍传原始计数，
仅在需要 PCM 单位换算时设置 `bufferSizeInPcmFrames`。

Native DSD 的单位证据由 helper 在真实 ASIO 回调处采集时间戳，父进程工作线程的唤醒间隔
不参与扩大写入容量。LSB1/MSB1 从 `bufferSize/8` 的保守容量开始；连续且明确的字节帧节拍
才会扩大到完整 buffer。NER8 保持保守容量，并在 ASIO 边界把每个打包字节展开为 8 个 0/1
字节；不同驱动的 NER8 分配方式仍需硬件证据确认。

PCM/DoP 最多 32768 帧；Native DSD 原始计数最多 2097152，实际传输仍受每声道
262144 字节限制。确认后的字节帧或 NER8 容量超过此限制时报告失败，不能截断音频。

直通状态由统一 evaluator 根据实际输出、运行证据及 DSP/音量/路由状态计算。
完整字段和 `sourceExact` / `outputPerfect` 判定见
[音频引擎 API](./audio-engine-api.md#dsd--dop--sacd-语义)。

## 验证与诊断

无设备夹具用于验证 ABI、生命周期、格式处理、错误回退与进程隔离。
真实 DAC/驱动、DSD/DoP 听感和当前发布包兼容性使用
[Windows HiFi 检查清单](./windows-phase-6c-smoke-checklist.md)与
[音频证据规则](./audio-smoke-evidence.md)独立验证。

记录实际驱动与设备身份、输入和输出格式、缓冲单位、回退原因、欠载计数、
二进制身份及最终结果。设备诊断和单次修复日志放在 Issue、PR 或外部证据目录。

## 参考规范

- [ASIO 官方 SDK 镜像与 DSD 扩展定义](https://github.com/audiosdk/asio)
- [DoP open standard](https://dsd-guide.com/dop-open-standard)
- [DSDIFF 1.5 规范](https://dsd-guide.com/sites/default/files/white-papers/DSDIFF_1.5_Spec.pdf)

参考资料用于解释互操作契约；项目的实现与打包边界以法律说明为准。
