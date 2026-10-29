# 在侧边栏嵌入自定义小组件

设备电量、快捷操作和状态摘要可以直接显示在导航下方、导入／编辑工具上方，不必先打开插件页面。API v4 的 `contributes.experiences` 新增 `launch: "sidebar"`：插件用包内 HTML、CSS 和 JavaScript 自定义内容，宿主负责侧栏容器和隔离桥接。

## 先运行电量示例

[`sdk/examples/sidebar-widget`](../sdk/examples/sidebar-widget) 是一个不需要依赖或构建的完整插件。电量明确标为演示数据，刷新按钮用于演示交互。

在仓库根目录运行：

```powershell
node packages/create-twilight-plugin/bin/create-twilight-plugin.cjs pack sdk/examples/sidebar-widget
```

在插件管理中安装生成的 `sdk/examples/sidebar-widget/dist/com.example.sidebar-battery-1.0.0.tep` 并启用，打开侧边栏即可看到小组件。也可以通过开发者模式直接安装示例目录。

## 用 manifest 声明一个小组件

在完整的 `plugin.json` 中加入以下字段（完整可安装文件见示例）：

```json
{
  "apiVersion": 4,
  "type": ["ui"],
  "permissions": ["ui:inject"],
  "contributes": {
    "experiences": [
      {
        "id": "battery",
        "name": "设备电量",
        "entry": "ui/index.html",
        "bridgeVersion": 2,
        "launch": "sidebar",
        "sidebar": { "height": 128 }
      }
    ]
  }
}
```

新接口随 1.4.0 开发线提供，旧宿主不识别 `sidebar`，发布时用 `engines.twilightEcho` 声明兼容版本。SDK 类型为 `PluginExperience`。

- `entry` 必须是包内 HTML，相邻的脚本、样式和图片使用相对路径。
- `name` 作为宿主标题、按钮的可访问名称与 iframe 标题，不必在内容中再画一遍标题。
- `sidebar.height` 是内容区高度，不含宿主标题；默认 144 CSS px，只接受 64–480 的整数。短窗口中内容区最多占窗口高度的 55%，溢出内容由插件页面自身滚动。
- 宽度随侧栏变化，内容应适配展开和紧凑模式，不设置固定页面宽度。同一插件可声明多个小组件，按声明顺序排列。
- 图标栏模式保留小组件按钮，点击后在宿主右侧面板打开对应组件。

`sidebarPage` 和 `localSidebarItem` 仍用于新增导航入口；侧栏小组件不进入“编辑页面”或“完整界面”的选择列表。`launch: "page"`／省略 `launch`、`launch: "panel"` 的原有用法不变。

## 连接宿主并跟随外观

脚本加载时发送 ready 消息，接收宿主传来的 MessagePort。脚本放在包内文件中，通过 `<script src="widget.js" defer></script>` 引用：

```js
window.addEventListener('message', (event) => {
  if (event.source !== parent ||
      event.data?.type !== 'twilight-experience-connect' ||
      event.data.bridgeVersion !== 2 || !event.ports[0]) return

  const port = event.ports[0]
  port.onmessage = ({ data }) => {
    if (data?.event !== 'appearance') return
    const { theme, colors, fontFamily, fontSize } = data.value
    const root = document.documentElement
    root.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
    root.style.setProperty('--text', colors.text)
    root.style.setProperty('--accent', colors.accent)
    root.style.fontFamily = fontFamily
    root.style.fontSize = fontSize
  }
  port.start()
})
parent.postMessage({ type: 'twilight-experience-ready', bridgeVersion: 2 }, '*')
```

宿主只接受来自对应 iframe 窗口且 origin 为 `plugin-ui://<plugin-id>` 的握手，回传端口时指定该 origin。首次连接和宿主外观变化时，端口都会收到 `appearance` 事件，类型为 `PluginExperienceAppearance`：

- `theme`：`dark`／`pureWhite`。
- `colors`：`text`、`muted`、`accent`、`surface`、`border`，为宿主当前导航与卡片颜色。
- `fontFamily`、`fontSize`：宿主字体与正文字号。
- `reducedMotion`：用户是否选择减少／关闭动效。

宿主背景透过 iframe 显示，通常让 `body` 保持透明即可。iframe 内的 CSS 只影响小组件自身。

## 读取真实数据和处理交互

小组件使用已有 [experience 桥](./plugin-experiences.md#bridge-versions-1-and-2)，请求格式为 `{ id, method, args }`，响应携带相同 `id` 和 `value` 或 `error`。权限按具体操作检查，仅声明 `ui:inject` 不会获得播放器或曲库访问权。

需要访问设备、文件或网络时，为插件添加 `main`，由后台代码读取数据。小组件通过 `plugin.request` 请求自己的后台处理器，后台通过 `twilight.experience.onRequest()` 接收、通过 `twilight.experience.emit()` 推送变化。目前这条中继需要额外的 `network` 权限；设备／文件访问还应如实声明所用权限。完整请求和事件语义见 [后台中继](./plugin-experiences.md#talking-to-the-plugins-own-background-code-pluginrequest)。

小组件没有宿主 DOM、Node、Electron 或 preload 权限。CSP 不允许外部脚本、外部网络请求、嵌套 iframe 和表单提交。`host.exit` 收起当前小组件／关闭图标栏面板；`host.panel` 在这种嵌入容器中返回错误，应从主界面打开宿主设置。

## 按挂载周期管理界面状态

关闭侧栏、收起小组件、进入图标栏模式、停用／卸载插件时，宿主移除对应内嵌 iframe，关闭 MessagePort 并取消桥接订阅。重新展开会重新连接；版本更新也会替换旧 iframe。图标栏面板关闭或离开图标栏模式时同样清理。

小组件的收起状态仅在当前侧栏挂载期间保留。需要跨挂载保留的数据放在插件后台或已有的私有 preferences 中；后台推送在没有挂载界面时被丢弃，重连后先请求一次当前状态。主题预览不加载真实插件小组件。
