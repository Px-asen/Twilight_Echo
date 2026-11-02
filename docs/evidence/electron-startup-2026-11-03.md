# Electron 启动故障：工作区 Low 完整性标签使进程降级

2026-11-03；Windows 11 Pro 10.0.26200；Electron 43.8.1。

**已修复并验证原入口。** 经用户授权，仅把原 `electron.exe` 的完整性标签从 Low 改为 Medium；版本检查、原先失败的窗口站 API 和真实 Core MessagePort 联调均通过。没有继续使用独立路径运行时。

## 修复前：相同文件，不同安全标签

原入口 `D:\Project\Twilight_Echo\node_modules\electron\dist\electron.exe --version` 以 `0x80000003`（2147483651）退出。GDB 定位到 `CreateWindowStationW` 返回 NULL、错误 5，Chromium 以 12（`SBOX_ERROR_CANNOT_CREATE_WINSTATION`）触发断点退出，尚未运行应用代码。

从 Electron 下载缓存独立解压同版本发行包后：

- 全部 **75 个发行文件逐字节相同**，没有缺失或多余文件。
- 修复前原路径不能启动，独立路径能正常输出 `v43.8.1`。
- 同一个原生 API 探针在原路径 Electron Node 模式中失败，在独立路径成功。
- 原路径进程的 `TokenIntegrityLevel` 为 **Low（`S-1-16-4096`）**，`TokenIsSandboxed=1`；独立路径为 **High（`S-1-16-12288`）**，`TokenIsSandboxed=0`。已核查的登录 SID、会话、AuthenticationId、提权类型等相同。

`icacls` 显示原可执行文件上的继承项：

```text
Mandatory Label\Low Mandatory Level:(I)(NW)
```

工作区根目录、`node_modules`、`electron` 和 `dist` 均有可向子项继承的 Low 标签；独立发行目录没有该标签。标签来源未追溯，未据此更改整个工作区的安全设置。

[Microsoft Mandatory Integrity Control 文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)明确：新进程完整性取用户和可执行文件完整性的较低者；管理员运行 Low 可执行文件，进程仍是 Low。即使 DACL 允许，强制完整性检查仍可拒绝向更高完整性对象写入。这解释了为什么换终端和重启未解决问题。

## 真实 Core MessagePort 联调已通过

临时使用 Electron 自带的 `ELECTRON_OVERRIDE_DIST_PATH` 指向独立的同版本发行目录，运行：

```powershell
node --test scripts/core-headless.test.cjs
```

结果：**1 通过，0 失败，约 6.38 秒**。覆盖真实 utility Core、数据库及音频服务的私有 MessagePort、Bridge 状态、信号链和停止状态下本机输出选择，并完成原有崩溃恢复、迁移、扫描和服务退出检查。未创建 BrowserWindow 或打开音频设备。

首次恢复运行时后，发现旧夹具把前一次试听的正常关闭也累计进了崩溃后的停音计数。已分别断言正常关闭一次、崩溃后新增停音一次，保留原来的安全要求；另为无封面的夹具补齐 `artwork.remotePreview` 平台响应。生产关闭协议未改动。

运行结束恢复了临时环境变量。测试日志：`D:\Project\Twilight_Echo\.bridge-core-headless-fresh-20261103.log`。

## 原入口已完成单文件标签修复

用户确认后，先备份原标签，再仅对下列文件执行 `icacls /setintegritylevel M`，保留了验证失败时自动恢复的路径：

```text
D:\Project\Twilight_Echo\node_modules\electron\dist\electron.exe
```

修改前后标签分别为：

```text
修改前：S:AI(ML;ID;NW;;;LW)
修改后：S:AI(ML;;NW;;;ME)
```

原文件所有者、组、DACL 和父目录标签读回一致，未修改其他文件或目录权限、窗口站权限、Windhawk 或 Electron 沙箱。Medium 是普通桌面程序级别，不是赋予管理员权限。

通过原入口验证得到：

- `--version` 输出 `v43.8.1`，退出码 0。
- 主进程完整性为 **Medium（`S-1-16-8192`）**，Windows `TokenIsSandboxed=0`；这是主进程的令牌状态，不是修改 Electron 渲染器沙箱开关。
- `CreateWindowStationW(NULL,0,0x80000008,&attrs)` 成功，错误码 0。
- **原入口 Core MessagePort 联调 1 通过、0 失败，约 9.52 秒**；没有 `ELECTRON_OVERRIDE_DIST_PATH` 覆盖、BrowserWindow 或音频设备输出。

原入口日志：`D:\Project\Twilight_Echo\.bridge-core-headless-original-20261103.log`。

持久备份与恢复入口：

```text
D:\TwilightEchoDependencies\diagnostics\electron-integrity-20261103
  original.clixml  原标签、所有者／组／DACL 及父目录标签
  restore.ps1     仅恢复原文件标签的独立脚本
  result.json     修改范围与原入口验收结果
  version-result.json / api-probe.log
```

本次验证成功，因此保留 Medium 标签，没有执行回退。依赖重新安装时，新文件可能再次继承父目录的 Low 标签，应在该次安装中复查，不递归修改整个工作区。

## 已排除的误判与对照

- **撤回窗口站 DACL 缺权限的结论。** `.NET WindowsIdentity.Groups` 会省略登录 SID；原生 `GetTokenInformation(TokenLogonSid)` 证明当前登录 SID 已启用，窗口站 DACL 允许创建桌面。此前检查忽略了原 Electron 进程实际的 Low 完整性，不能仅凭终端自身的 High 完整性推定子进程相同。
- **Windhawk 排除生效但未解除故障。** 经用户授权，只临时排除原 Electron 路径，并使用 Windhawk 自身的后台重启机制刷新。GDB 确认没有 Windhawk DLL，仍捕获同一崩溃。`finally` 原样恢复原 `Exclude` 的存在状态、类型和空 REG_SZ 值，Windhawk 服务正常运行。没有永久排除。
- 独立 Node 与分别编译为控制台、GUI 子系统的 API 探针均成功，GUI 子系统本身不能解释失败。

## 诊断检查点

临时文件可能被系统清理；本文保留了关键参数和结果。

```text
C:\Users\XOS\AppData\Local\Temp\twilight-electron-runtime-ab-20261103
  43.8.1\                    独立解压的同版本发行文件
  distribution-comparison.log 全部文件内容对比与启动结果
  context-probe.cpp           令牌与原生 API 探针
  context.log                 原路径 Low / 独立路径 High 对照

C:\Users\XOS\AppData\Local\Temp\twilight-windhawk-ab-20261103
  original.clixml / restore.ps1 / restore.log
  excluded-version.json / excluded-gdb.log
```

## 实现来源

- [Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)：文件标签、进程创建及 DACL 之外的强制完整性检查。
- [.NET WindowsIdentity.Groups](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Security.Principal.Windows/src/System/Security/Principal/WindowsIdentity.cs)：忽略 disabled、logon ID、deny-only groups。
- [Chromium window.cc](https://chromium.googlesource.com/chromium/src/+/main/sandbox/win/src/window.cc)：复制 DACL、API 参数及错误 5 后的重试。
- [Electron 43.8.1 Windows 入口](https://github.com/electron/electron/blob/v43.8.1/shell/app/electron_main_win.cc)：Node 模式在 Chromium 初始化前分支。
- [Windhawk 1.7.3 设置实现](https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/vscode-windhawk/src/utils/appSettingsUtils.ts)及[调用方](https://github.com/ramensoftware/windhawk/blob/v1.7.3/src/vscode-windhawk/src/extension.ts)：引擎设置修改后的后台重启。
