# 2.0.0 音频服务启动崩溃：需要 Windows 故障模块记录

用户在“播放与音效”中看到“音频服务进程退出：3221225727”，重启应用内音频引擎后仍然失败。当前证据确认原生音频服务反复崩溃，尚未定位到具体 DLL 或源代码缺陷。

## 让反馈用户补充 Windows 崩溃记录

将 `scripts/collect-windows-audio-crash.ps1` 发给反馈用户。让用户再次触发音频错误，然后在脚本所在文件夹打开 PowerShell，执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\collect-windows-audio-crash.ps1
```

回传同目录下生成的 `TwilightEcho-windows-crash-*.json`。脚本读取最近七天的 Windows 应用错误记录，只保留 Twilight Echo 相关进程的故障模块名称、版本、异常代码、故障偏移、时间，以及 Windows 构建号；不写注册表、不重启服务、不上传数据。命令中的执行策略仅用于这一次 PowerShell 进程。

如果报告的 `events` 为空，不能据此判断没有崩溃；可能 Windows 没有留下对应事件。可在“事件查看器 → Windows 日志 → 应用程序”中找到同一时间的 **Application Error / 事件 1000**，复制“常规”详情。若仍无记录，下一步需要在反馈机器上捕获一次原生崩溃转储。

拿到故障模块和偏移后，再针对原生引擎、系统音频组件或第三方 DLL 确定调试目标。故障模块只是崩溃位置；若记录仅指向 `ntdll.dll` 的异常处理路径，还需要崩溃堆栈才能判断起因。

## 已有证据

- 输入：`TwilightEcho-audio-diagnostics-2026-11-08T11-25-35-661Z.json`、同名 Markdown，以及 `TwilightEcho-diagnostics-2026-11-08T11-26-28-064Z.zip`。
- 环境：TwilightEcho 2.0.0，Windows `10.0.26300` x64，Electron `43.8.1`，Node `24.22.0`，Intel i5-11260H。报告未包含 Windows 构建修订号。
- 2026 年 11 月 8 日北京时间 19:17—19:20，音频报告记录 23 次 `audio-service-crash`，退出码均为 `3221225727`，对应 `0xC00000FF / STATUS_BAD_FUNCTION_TABLE`。工具链 Windows 头文件 `ntstatus.h` 确认该映射。
- 首次 `audio.native / EnumerateDevices` 开始于 `11:17:26.349Z`，音频子进程于 `11:17:26.371Z` 退出，间隔 22 ms，没有完成记录。
- 后续崩溃多数发生在枚举设备调用期间，也有输出配置和其他初始化调用尚未完成的情况，因此不能把枚举函数直接认定为根因。
- 首次崩溃前模块已加载、服务已发送 ready；尚未开始播放歌曲。曲库和设置仍可用。
- 音频报告中的共享混音、软件音量 40% 是逐位直通判定信息，不解释进程退出。
- 通用诊断包缺少原生崩溃堆栈及 Windows 故障模块、故障偏移。导出时 `audio.cached`、`native.identity`、`native.capabilities` 均不可用。

## 本机验证及其范围

GitHub 发布元数据确认最新正式发布为 `v2.0.0`，发布时间为 2026 年 11 月 8 日北京时间 12:03:57。Windows 安装包和 ZIP 的本地产物存在于 `dist/2.0.0-20261108/`。

本机检查结果：

- 当前原生模块在普通 Node 和 Electron utility process 中枚举设备成功。
- 当前模块经过发布脚本裁剪后，在 Node 中枚举设备成功。
- 本地 2.0.0 发布目录的原生模块，在 Electron 43.8.1 utility process 中连续五轮执行设备枚举、选择 WASAPI、选择默认设备、应用输出配置，均正常退出。
- 现有 `scripts/core-native-audio.test.cjs` 通过，覆盖 Core 私有 MessagePort 加载原生音频服务及基本状态读取。

本机未复现；反馈用户的 Windows 构建、设备和进程内第三方模块仍是待核对条件。采集脚本已在 Windows PowerShell 5.1 下验证事件字段提取、进程筛选、路径省略和报告导出。下一步由反馈用户提供 Windows 故障记录，开发侧据此确定需要调试的模块；本次调查尚未确定修复点。
