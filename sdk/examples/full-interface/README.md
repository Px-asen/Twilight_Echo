# 完整界面开发示例

安装并启用后，侧栏和「设置 → 外观 → 完整界面」中会出现「完整界面开发示例」。它读取真实的本地专辑、曲目和播放队列，通过宿主播放，不自行解码音频。

## 运行

在 Twilight Echo 仓库或开发参考包的根目录执行（需要 Node.js）：

```powershell
node packages/create-twilight-plugin/bin/create-twilight-plugin.cjs pack sdk/examples/full-interface
```

安装 `dist/com.example.full-interface-1.0.0.tep`（相对本示例目录），启用后先从侧栏打开。想设为启动界面，再到「完整界面」选择并重启。使用包含 API v4、bridge v2 和 `host.capabilities` 的 1.4.0 开发线或后续兼容宿主。

也可在插件页开启开发者模式，用「从文件夹安装（开发）」选择本目录。宿主会复制目录；改源码后需要重新安装，关闭并重新打开界面，不会直接热更新。

曲库为空时，请返回默认界面导入歌曲。搜索只搜索本地库；主题按钮在本示例内切换明暗。主界面设置按钮打开宿主设置面板，因此示例声明了 `app:settings`；删除该按钮及对应功能后可移除此权限。

## 从哪里改

- `plugin.json`：插件身份、权限、HTML 入口和启动界面名称。
- `ui/index.html`：独立页面结构，顶部留出宿主窗口控制区。
- `ui/app.css`：自有样式与明暗色。可整体替换，不依赖宿主 Vue 或 DOM。
- `ui/bridge.js`：握手、请求、事件、超时和卸载清理；可被其他前端框架复用。
- `ui/app.js`：专辑分页、详情、搜索、队列、播放器和私有偏好。
- `tests/bridge.test.mjs`：零依赖桥接客户端测试，运行 `node --test sdk/examples/full-interface/tests/bridge.test.mjs`（从参考包根目录）。

示例只实现本地库浏览和基本播放，完整产品的页面与接口选型见[完整界面开发指南](../../../docs/plugin-full-interface.md)。它没有扫描、收藏、流媒体登录、DSP 编辑和插件管理操作，便于从较小权限集合起步。
