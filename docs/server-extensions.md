# 从手机管理 Server 扩展

在手机的 **音乐库 → 选择电脑 → 管理 → Server 扩展** 中，查看该电脑安装的 `.tep` 扩展，上传安装包、确认安装或更新，并启用、停用或卸载。该入口跟随所选电脑曲库。

## 首次开启远程管理

正常停止 Server，在数据目录的 `server.json` 中设置 `"remotePluginManagement": true`，再启动。默认关闭时，已配对手机仍可查看列表，本机 CLI 可以管理扩展。此开关允许已配对客户端管理执行于 Server 账号下的扩展代码。

选包后显示名称、作者、版本变化、声明权限和依赖。勾选信任来源并确认后才执行安装验证。新安装保持停用；更新保留启用状态；候选激活失败时恢复旧版本。需要桌面 UI、主题或原生 DSP 工作台的 `.tep` 会显示不适用；VST3 在声区的 DSP 管理中操作。

安装期间不能切换管理对象。回应丢失时先刷新核对版本和启用状态，页面不会自动重放安装。卸载默认保留设置与登录数据，勾选“同时删除设置和登录数据”才删除。

## 本机命令行

```powershell
.\server.cmd plugins --data D:\ServerData\TwilightEcho
.\server.cmd plugin-install --data D:\ServerData\TwilightEcho --from D:\Packages\radio.tep
.\server.cmd plugin-install --data D:\ServerData\TwilightEcho --from D:\Packages\radio.tep --apply
.\server.cmd plugin-enable --data D:\ServerData\TwilightEcho --id com.example.radio
.\server.cmd plugin-disable --data D:\ServerData\TwilightEcho --id com.example.radio
.\server.cmd plugin-uninstall --data D:\ServerData\TwilightEcho --id com.example.radio
.\server.cmd plugin-uninstall --data D:\ServerData\TwilightEcho --id com.example.radio --apply
```

安装与卸载默认仅预览。安装的 `--apply` 表示信任文件来源，允许验证并执行扩展；安装后的启用是另一项操作。卸载加 `--remove-data` 可删除该扩展的设置与登录数据。列表可用 `--offset 100` 分页。

## 实现与验证（2026-11-05）

上传限 50 MiB，分块限 768 KiB；临时包与预览绑定认证客户端，预览十分钟过期。安装和状态编辑比较观察到的版本令牌，其他客户端改变扩展后必须重新读取。复用原插件安装器的包检查、按插件串行事务和失败回退；新增通用分块传输实现也用于原 DSP 上传。

无头宿主不注册桌面悬浮窗能力。Windows 的敏感扩展设置使用 DPAPI 绑定运行账号；同账号下迁移 Profile 路径后仍可解密，换账号须重新登录。备份应继续保护整个 Profile。

软件证据：

- `scripts/server-plugin-management.test.cjs`：真实 Node Server、配对 TLS、手机协议和 CLI。覆盖默认禁写、本机管理、预览无执行、取消、版本冲突、启停、更新回退、成功更新、无头不适用扩展、卸载数据和敏感设置落盘保护。
- `src/core/plugins/management.test.ts`：上传与确认所属客户端、断开后清理、取消后不可安装。
- `src/main/server/credentials.test.ts`：原生凭据往返、扩展范围隔离、同账号 Profile 改路径。
- Android `DesktopPluginsTest`、`DesktopPluginsPresenterTest`：电脑切换、旧选择器结果、不确定写入须刷新。
- Android `DesktopPluginsUiTest`：信任确认、写入锁定、失去回执后的刷新入口、卸载默认保留数据；模拟器截图位于 Android 仓库 `.artifacts/server-plugin-shots/`。

真实手机／DAC 与 Windows SCM／服务账号部署验收继续后置。Linux／NAS、WAN、离线下载、移动网络策略和 Android Auto 仍在总计划中。
