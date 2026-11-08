# 调试会话验证记录（2026-11-09）

本次在 Windows x64 验证了调试会话、跨进程证据、崩溃采集和打包后的重启导出流程。使用方法见 [诊断文档](diagnostics.md)。

## 已取得的证据

| 范围               | 结果                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 常驻日志与调试会话 | 18 项既有诊断检查及 9 项会话检查通过；覆盖完整路径、认证过滤、RPC 字段白名单、模块基址、退出后 PID、缓存、模式确认超时、重启、导出重试及容量 |
| 原生崩溃           | x64、x86 外部采集器捕获 `0xC00000FF`，进程退出码保持不变；Electron utility Crashpad 和独立 Node 的 NAPI 崩溃均生成转储                       |
| 采集失败与上限     | helper 缺失时记录失败阶段并继续运行；第四次原生崩溃保留异常记录并注明转储容量限制；最终导出最多三份转储                                      |
| x86 ASIO           | 生产 helper 的启动入口实际完成 x86 采集器附加，再成功运行自检；x86 异常现场通过独立崩溃 fixture 验证                                         |
| 界面               | 渲染测试覆盖开始、取消导出、失败重试、崩溃选项、转储数量、采集器失败及错误码；已检查实际截图                                                 |
| 发布符号           | GNU 调试信息和 JavaScript source map 解析到项目源码行；MSVC PDB 按发布文件身份与 RVA 解析到函数及源码行                                      |
| 构建               | Node、Web、portable Core 类型检查及桌面构建通过；Windows 解压包包含两种架构采集器、构建身份，依赖闭包检查通过                                |
| 音频回归           | 音频服务与证据缓存相关 71 项检查通过；原生诊断 CTest、Core 原生集成及 VST3 自检通过                                                          |

完整打包验收使用独立的中文及空格目录，依次完成普通会话导出、开启崩溃取证后重启、真实 utility 崩溃、结束取证后重启、普通模式自动导出。最终普通包无缺失项；取证包保留会话缓存与三份转储，清单明确记录较早转储被保留策略清理。取证期间发生的音频进程退出也被纳入证据；这些检查验证取证能力，不是对原用户崩溃根因的修复验证。

可重复执行的入口：

```powershell
node --experimental-strip-types --test src/main/diagnostics/diagnostics.test.ts src/main/diagnostics/debugSession.test.ts src/main/diagnostics/quit.test.ts
node scripts/build-crash-helper.cjs
node scripts/build-asio-helper.cjs --arch x86
node --test --test-concurrency=1 scripts/diagnostics-crash-capture.test.cjs
node --experimental-strip-types --test src/renderer/src/components/settings-page/DiagnosticsSettingsSection.behavior.test.ts
node scripts/run-debug-session-package-smoke.cjs path/to/TwilightEcho.exe
```

## 性能与尚待验证的范围

各 10 秒的真实 WASAPI 静音播放中，普通模式和调试模式均记录 996 次回调，underrun 和 deadline miss 均为零；平均回调耗时分别为 12,990 ns 和 13,116.5 ns。该短测验证启动与基本播放，不替代长时间压力测试。

本机未完成 macOS/Linux 实机 UI、Crashpad 与符号工具验证，也未安装新的 NSIS 安装器。Windows 已验证的是实际打包的 `win-unpacked` 运行时。独立原生辅助进程在 macOS/Linux 的转储暂不覆盖，并已在状态和使用文档中说明。实际 ASIO 驱动内部的崩溃注入仍需对应设备与驱动环境。

本地详细证据在 `tmp/audio-crash-support/`：`final-diagnostics-tests.log`、`final-debug-tests.log`、`final-crash-tests.log`、`final-asio-capture-test.log`、`final-ui-test.log`、`debug-settings.png`、`pdb-symbol-resolution.txt`、`final-package.log`、`final-package-acceptance.log`，以及 `final-package-acceptance/` 中各次运行的 ZIP 与状态。播放对照在 `playback-ordinary/result.json` 和 `playback-debug/result.json`。
