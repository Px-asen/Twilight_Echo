# 侧栏电量小组件示例

启用后在侧边栏显示三台设备的**演示电量**。点击“刷新示例”切换鼠标读数，验证自定义 HTML 交互；示例不读取真实设备。

在 Twilight Echo 仓库根目录打包：

```powershell
node packages/create-twilight-plugin/bin/create-twilight-plugin.cjs pack sdk/examples/sidebar-widget
```

在插件管理中安装生成的 `dist/com.example.sidebar-battery-1.0.0.tep` 并启用，或在开发者模式安装此目录。需要包含侧栏小组件接口的 1.4.0 开发线宿主。

- `plugin.json`：用 `launch: "sidebar"` 和内容区高度声明位置。
- `ui/index.html`、`widget.css`、`widget.js`：自定义布局、交互和宿主外观同步。
- 真实数据接入、权限和生命周期：[开发指南](../../../docs/plugin-sidebar-widgets.md)。
