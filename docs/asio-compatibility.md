# ASIO 对照 ECHO 的兼容性改进

本轮对照仓库为 `D:\Project\ECHO`，版本为
`a197bb3e959ca582db3aee13b81c50a9f69040c5`。主要参考其
`native/audio-host/src/asio_host.cpp` 中的驱动协商、缓冲候选与格式转换行为。
Twilight Echo 保留独立 ABI 和 helper 进程架构；本轮改动没有引入 ECHO 的 SDK 文件。

| 兼容点 | Twilight Echo 此前的限制 | 本轮实现 |
| --- | --- | --- |
| 初始化窗口 | 消息窗口可能不满足驱动对宿主 HWND 的要求 | 普通隐藏顶层窗口，控制线程持续处理消息 |
| 采样率 | 切换后等待与恢复不够充分 | 连续读回确认，避免重复设置，支持合法速率 pivot，必须回到目标速率 |
| 缓冲大小 | 主要依赖单个选择和 preferred 重试 | 请求值、preferred、邻近合法值及多个候选；PCM/DoP 最大 32768 帧，Native DSD 按模式切换后的范围换算，另行校验实际字节容量 |
| 缓冲创建 | 输出分配方式较固定 | output-only 优先，必要时分配输入通道；每次失败后 dispose；重读范围后重试 |
| 通道格式 | 创建前查询可能读到临时类型 | 创建前信息只供参考，创建后重新确认全部输出格式、指针和采样率 |
| PCM wire 格式 | 以小端常见格式为主 | 完整 18 种 PCM 类型，包括大小端、Float64 容器及 16/18/20/24 有效位 |
| 输出通道 | 从第一个硬件输出开始 | 可配置起始通道，设置界面从 1 计数，驱动使用从 0 开始的编号 |
| 运行时设置 | ASIO 缓冲或通道改变没有完整重开事务 | 重开驱动，保留播放或暂停状态，失败恢复原缓冲和通道 |
| DoP | Int32 容器归一化未充分检查有效位 | 要求统一整数载波且有效位不少于 24，拒绝无法保留标记的载波 |
| Native DSD 容量 | 父进程工作线程节拍可能受调度影响 | helper 在实际驱动回调中采集节拍并发布写入容量，检查提交帧数、字节数和 stride |
| NER8 | 打包源字节与 wire 表示混在一起 | ASIO 边界展开成每 bit 一个 0/1 字节，写入最多 `bufferSize` 字节，仍待硬件验证 |
| 关闭恢复 | 重复关闭可能清掉已失败的恢复结果 | 读回验证恢复速率，保留恢复失败并拒绝复用该会话 |
| 诊断 | 缺少创建后的完整实际值 | 启动尝试摘要、实际速率和延迟、容器位数、有效位、字节序，降低精度时不声称 bit-perfect |

采样率严格读回和 helper 的写入边界检查属于本项目额外强化的验证路径。
设备兼容性和听感必须通过当前构建的硬件结果判断，不能仅凭新增分支或模拟测试
声称已经超越 ECHO。

## 无设备验证

- MinGW 全量构建成功；完整 CTest 50 项通过，含 MSVC DLL 与 MinGW 宿主跨 ABI 测试。
- 关闭恢复失败及 ASIO 配置重开/回滚新增用例位于
  `asio_driver_compatibility_tests.cpp` 和 `runtime_queue_reroute_tests.cpp`。
- 输出设置、设备配置、音频助手、renderer 设置与输出 controller 共 41 项 TypeScript 测试通过。
- `pnpm run typecheck`、`node scripts/verify-asio-sdk-free.cjs` 通过。

验证运行时已暂存到 `D:\TwilightEchoDependencies\builds\asio-validation-runtime`。
它包含配套引擎、Node addon、helper 及能力清单。开发窗口仍加载旧的
`resources/audio-engine` DLL 时，需要退出开发进程后更新资源目录，重启才会加载本轮改动。

## TOPPING 实机验证

示例驱动为 `Topping USB Audio Device`，CLSID 为
`{6D241B5E-CF73-4043-A85F-EF11D4670955}`，用户提供的安装包版本为 5.74.0。
当前没有连接真实 TOPPING 设备，本轮没有完成它的成功播放验证。

在项目目录退出旧开发进程后执行：

```powershell
node scripts/stage-audio-engine.cjs --build-dir D:/TwilightEchoDependencies/builds/audio-engine-mingw
$env:TAE_ASIO_TRACE_PATH = 'D:\Project\asio-topping.log'
pnpm dev
```

先确认设备可见、能够打开和有声，再分别测试 44.1/48/96 kHz PCM、Auto/256/512/1024
缓冲及设备支持的 DoP/Native DSD。多输出设备再测试起始输出通道。记录实际输出格式、
启动摘要、失败阶段和 `D:\Project\asio-topping.log`；仅有设备名称或能力广告不足以
归因 TOPPING 的原始故障。
