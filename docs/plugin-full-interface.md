# 开发一套可切换的完整界面

要让自己的设计出现在「设置 → 外观 → 完整界面」中，使用 **API v4 的 page experience**：把 HTML、CSS、JavaScript 和素材打进 `.tep`，由 Twilight Echo 加载为独立界面。界面负责布局和交互，宿主继续负责曲库、播放队列、音频引擎和持久化。

推荐先运行[完整界面示例](../sdk/examples/full-interface/README.md)，再替换视觉和逐步补齐页面。示例没有前端构建依赖，适合先确认接入；正式项目可选 Vue、React 或其他能输出静态页面的技术栈。

本文面向完整界面作者；协议细节见 [experience 协议](./plugin-experiences.md)，通用安装与分发规则见[插件规范](./twilight-echo-plugin-spec.md)。本文对应仓库的 1.4.0 开发线实现。使用方需具备 API v4、bridge v2 和所需方法；仅看应用版本号不足以确认旧构建是否兼容。

## 1. 先选对扩展方式

| 你要交付的东西                             | 扩展方式                                                                     | 进入「完整界面」选择器 |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------- |
| 自己组织首页、曲库、播放器等整套页面       | `contributes.experiences`，`launch: "page"` 或省略                           | 是，安装并启用后       |
| 保留原页面，调整颜色、材质、字体、外壳布局 | `contributes.themes`，参见[主题指南](./theme-plugin-authoring.md)            | 否，属于主题选择       |
| 标题栏按钮打开的右侧面板                   | experience，`launch: "panel"`，配合 `titleBarButton`                         | 否                     |
| 导航下方的小组件                           | experience，`launch: "sidebar"`，参见[侧栏指南](./plugin-sidebar-widgets.md) | 否                     |
| 宿主渲染的命令页面或按钮                   | 传统 `sidebarPage` / `playerBarButton` 等                                    | 否                     |

「完整界面」不是只允许莱茵生命使用的固定入口。任意符合协议的 page experience 都会进入列表，选项名称来自 experience 的 `name`。

## 2. 跑通安装、打开和启动选择

在仓库根目录或开发参考包根目录运行：

```powershell
node packages/create-twilight-plugin/bin/create-twilight-plugin.cjs pack sdk/examples/full-interface
```

1. 在插件管理 → 已安装 →「从本地安装包 (.tep)」安装 `sdk/examples/full-interface/dist/com.example.full-interface-1.0.0.tep`，确认权限并启用。
2. 在侧栏点击「完整界面开发示例」。先验证曲库、播放和退出，再设为默认启动界面。
3. 在设置 → 外观 →「完整界面」选择示例。选择会保存，并询问是否立即重启；重启会中断当前播放。取消确认则保持当前界面，可稍后重启。
4. 切回默认启动界面也需要在选择器中保存并重启。顶部「返回 Twilight Echo」只退出当前界面，不改变下次启动选择。

选择器只有「Twilight Echo 默认界面」时，表示目前没有可列出的已启用 page experience。先检查插件是否安装、启用、manifest 是否通过校验，再检查 `launch` 是否为 page；普通 theme、panel、sidebar 不会出现在这里。

开发时可在插件页开启「开发者模式」，用「从文件夹安装（开发）」选择含 `plugin.json` 的目录。**目录安装会复制文件，不是软链接或开发服务器热更新**；修改后重新安装，并重新打开界面。新插件安装后还需启用。正式发布递增插件版本，不替换已发布的同版本包。

CLI 目前在本仓库中维护，尚未发布 npm；`init --type ui-tool` 是传统命令型 UI 模板，不是完整界面模板。完整界面从本示例复制最直接。

## 3. 入口和目录：一个 HTML 就能启动

示例的可安装 manifest：

```json
{
  "id": "com.example.full-interface",
  "name": "完整界面开发示例",
  "version": "1.0.0",
  "description": "使用宿主真实曲库和播放器的完整界面入门示例。",
  "author": "Twilight Echo",
  "license": "Apache-2.0",
  "type": ["ui"],
  "apiVersion": 4,
  "engines": { "twilightEcho": ">=1.4.0-0" },
  "permissions": [
    "ui:inject",
    "library:read",
    "player:observe",
    "player:control",
    "settings",
    "app:settings"
  ],
  "contributes": {
    "experiences": [
      {
        "id": "main",
        "name": "完整界面开发示例",
        "entry": "ui/index.html",
        "bridgeVersion": 2,
        "launch": "page"
      }
    ]
  }
}
```

```text
my-interface/
├── plugin.json
└── ui/
    ├── index.html
    ├── app.css
    ├── app.js
    ├── bridge.js
    └── assets/          自带图片、字体等
```

- 纯界面无需 `main`、`activate()` 或后台进程。需要后台工作时再添加 `main`。
- `entry` 是相对插件根的包内 HTML 路径。使用 `/`，不能是 URL、绝对路径、`..` 或反斜杠路径。
- experience `id` 必须匹配 `^[a-z][a-z0-9-]{0,63}$`，同一插件内不重复；最多 8 个 experience。
- 运行 URL 由宿主解析为 `plugin-ui://<pluginId>/<version>/<entry>`，不要保存或硬编码带版本的 URL。
- 脚本、CSS、字体和图片放在入口目录或其子目录，使用相对路径。协议只服务允许的资源类型；当前包含 HTML、JS、CSS、JSON、GLB、WOFF2、PNG/JPEG/WebP/SVG、OGG、TXT、PDF，未列出的扩展名会被拒绝。构建不要输出 `.mjs` 脚本或 `.wasm` 等未支持资源。

使用 Vite 时设 `base: './'`，输出本地资源；路由用 hash 或内存路由，避免跳到没有实体 HTML 的路径。所有代码和授权素材随包提供，不使用 CDN、远程字体或运行时远程代码。

## 4. 宿主与你分别负责什么

```text
插件 HTML / CSS / JS（跨源 iframe，自有页面与状态）
        ⇅ MessagePort：命名请求、响应与事件
宿主 experienceBridge / experienceServices（权限、参数、数据适配）
        ⇅ 现有应用服务与 Core
曲库数据库、队列、音频引擎、音源、下载、设置
```

**界面作者负责**：导航和页面结构、可访问性、响应式布局、自己的设计变量、加载/空/错误状态、交互反馈、数据分页、订阅和卸载清理。

**宿主负责**：真正播放、解码与输出、当前队列、曲库扫描和持久化、平台登录凭据、受控文件选择、原生窗口控制和退出入口。界面关闭、切页或重新挂载，不应自动停止播放或清空队列；重新进入后先读取宿主状态。

iframe 没有 Node、Electron、preload、`window.api` 或宿主 DOM 访问权。CSP 阻止外部脚本、外部网络、worker、嵌套 iframe 和表单提交。包内同源资源可读取，封面句柄 `cover://…` 可作为图片。不要把 `audioUrl` 当作可用的本地音频路径，也不要通过 `<audio>` 再实现一套播放器。

## 5. 用桥接客户端读取和控制播放器

复用示例的 [`ui/bridge.js`](../sdk/examples/full-interface/ui/bridge.js)，它完成握手、请求 ID、响应关联、事件订阅、超时、16 并发上限和 `pagehide` 清理。

```js
import { connectExperience } from './bridge.js'

const host = await connectExperience()
const capabilities = await host.call('host.capabilities')
if (!capabilities.methods.includes('player.state')) {
  throw new Error('宿主或插件权限不支持读取播放状态')
}

const stop = host.on('player', (state) => renderPlayer(state))
renderPlayer(await host.call('player.state'))
await host.call('player.volume', { value: 0.5 }) // 0–1，不是 0–100

// SPA 页面卸载时取消本页订阅；整个 iframe 的卸载由客户端自动处理。
// stop()
```

`renderPlayer` 是你的渲染函数。TypeScript 可使用 `packages/plugin-api/src/index.ts` 中的 `PluginExperienceRequest` / `PluginExperienceMessage` 类型；它们描述传输信封，不是每个 method 的完整参数和返回值类型。普通进程插件的 `twilight` API 与这里的字符串方法不能混用。

### 传输契约

1. 子窗口发送 `{ type: 'twilight-experience-ready', bridgeVersion: 2 }`。
2. 宿主检查 iframe 窗口和 `plugin-ui://<pluginId>` origin，用 `twilight-experience-connect` 消息移交一个 MessagePort。
3. 端口请求为 `{ id: 1, method: 'player.state', args: {} }`。
4. 响应为 `{ id: 1, value: ... }` 或 `{ id: 1, error: '...' }`；事件为 `{ event: 'player', value: ... }`。

`host.capabilities` 返回当前桥版本和按插件权限筛选的方法名，不等于每台设备、音源、后台服务都可用。缺方法时隐藏或禁用相应功能；操作失败时保留用户当前视图并展示错误，不用空结果掩盖失败。

普通请求上限 256 KiB，同一端口最多 16 个并发。`music.metadata.operate` / `files.export` 上限 5 MiB，`music.metadata.write` 为 17 MiB 请求信封；元数据文档本身仍遵循 16 MiB 契约。示例普通请求 30 秒超时；超时不代表宿主取消，写操作超时后先读取状态，不自动重试。

## 6. 从真实专辑到播放队列

```js
const page = await host.call('library.list', { offset: 0, limit: 24 })
if (page.albums.length) {
  const album = await host.call('library.album', { id: page.albums[0].id })
  if (album.tracks.length) {
    await host.call('player.play', { id: album.tracks[0].id, albumId: album.id })
  }
}
```

先读取专辑摘要，点击后读取详情；不要启动时载入所有专辑的所有曲目。`library.album` 使用本次桥接会话读取/搜索得到的专辑 ID，重新挂载后重新查询，不自行拼接 ID。

### 常用方法的实际参数

下表中的 `—` 表示省略 args 或传 `{}`；这里只列客户端应依赖的关键字段，完整映射见 [`experienceBridge.ts`](../src/renderer/src/extensions/experienceBridge.ts)。

| 方法                                                   | args                                 | 关键结果 / 行为                                                                                                |
| ------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `library.list`                                         | `{ offset?, limit? }`                | `{ albums, total }`；默认 200，limit 1–500；摘要 `tracks: []`                                                  |
| `library.album`                                        | `{ id }`                             | 专辑详情，含 `tracks`、`trackCount`、`coverUrl`                                                                |
| `library.search`                                       | `{ query }`                          | `{ albums, tracks }`；query 截到 200 字符，最多 80 专辑/100 曲目，无搜索翻页参数                               |
| `library.playlists`                                    | —                                    | 歌单数组，含完整曲目；大歌单注意渲染开销                                                                       |
| `library.favorite`                                     | `{ id }`                             | 切换本地收藏，返回更新后的 track；不是幂等「设为收藏」                                                         |
| `library.createPlaylist`                               | `{ name }`                           | 由宿主创建本地歌单                                                                                             |
| `library.addToPlaylist` / `library.removeFromPlaylist` | `{ playlistId, id }`                 | 添加/移除曲目                                                                                                  |
| `library.deletePlaylist`                               | `{ id }`                             | 删除歌单，删除前由界面提供明确确认                                                                             |
| `library.scan`                                         | —                                    | 触发已有曲库扫描                                                                                               |
| `music.library`                                        | `{ offset?, limit?, revision? }`     | 含曲目的专辑页、genres、roots、scan；limit 最大 100，revision 相同可返回 `unchanged`                           |
| `player.state`                                         | —                                    | `transport`、`currentTrack`、`playing`、`loading`、`duration`、`currentTime`、`volume`、`playMode`、`error` 等 |
| `player.play`                                          | `{ id, albumId? }` 或 `{ id, ids? }` | 由宿主解析曲目并播放；ids 可提供队列，最多 10,000 项                                                           |
| `player.toggle` / `pause` / `stop`                     | —                                    | 控制并返回播放状态                                                                                             |
| `player.next` / `previous`                             | —                                    | 切换曲目；读取 state 或等待事件更新                                                                            |
| `player.seek`                                          | `{ value }`                          | 秒，0–当前 duration                                                                                            |
| `player.volume`                                        | `{ value }`                          | 0–1                                                                                                            |
| `player.mode`                                          | `{ value? }`                         | `sequential` / `listLoop` / `repeat` / `shuffle`；省略则轮换                                                   |
| `player.rate`                                          | `{ value }`                          | 0.5–2                                                                                                          |
| `player.transition`                                    | `{ mode }`                           | `gapless` / `fade-in-out`                                                                                      |
| `player.sleep`                                         | `{ mode, minutes? }`                 | mode 为 `minutes` / `trackEnd` / `queueEnd`；null 取消，分钟 1–720                                             |
| `player.queue`                                         | —                                    | 含 `queueEntryId` 的曲目数组；超过 10,000 首时报错，不静默截断                                                 |
| `player.playQueue`                                     | `{ entryId }`                        | 播放指定队列项，保留重复歌曲的位置语义                                                                         |
| `player.removeQueue`                                   | `{ entryId }` 或 `{ index }`         | 推荐稳定队列项 ID；index 从 0 开始                                                                             |
| `player.reorderQueue`                                  | `{ from, to }`                       | 从 0 开始的索引，先刷新队列后操作                                                                              |
| `player.setQueue` / `clearQueue`                       | `{ ids }` / —                        | 替换队列 / 清空；不是打开界面时的初始化步骤                                                                    |
| `player.lyrics`                                        | —                                    | `{ id, lyrics, translatedLyrics }`                                                                             |
| `preferences.read` / `write`                           | — / `{ value: object }`              | 插件私有 JSON，64 KiB；write 替换整个对象，先读后合并                                                          |
| `host.environment`                                     | —                                    | `{ reducedMotion }`                                                                                            |
| `host.panel`                                           | `{ name }`                           | 宿主面板：`settings` / `equalizer` / `dsp` / `plugins` / `theme` / `workshop`                                  |
| `host.exit` / `fullscreen`                             | —                                    | 临时退出当前界面 / 切换全屏                                                                                    |
| `host.openLink`                                        | `{ url }`                            | 打开无内嵌账号密码的 HTTPS 参考链接                                                                            |
| `window.mini` / `tray` / `lyrics`                      | —                                    | 打开现有宿主附属窗口，不是提供自定义窗口 HTML                                                                  |

曲目 `duration` 和播放时间单位均为秒，`sampleRate` 为 Hz，`bitsPerSample` 为位深。曲目 ID 用于音乐实体，`queueEntryId` 用于队列位置；同一首歌可在队列中重复。专辑摘要没有完整 tracks，不要把 `tracks: []` 当成空专辑。

### 事件按用途消费

- `player`：状态快照。宿主还会在文档可见且拥有 `player:observe` 时约每 250ms 推送，不必再开高频轮询。
- `queue` / `lyrics` / `library`：失效通知，value 可为 null；重新请求相应数据，不把 null 当成完整新数据。曲库扫描期间合并刷新，避免每次事件重载所有页面。
- `plugin`：`{ event, value }`，来自自己后台的实时事件。iframe 未挂载时丢弃，重新连接后请求当前状态。
- `appearance`：当前由嵌入式 sidebar/flyout 容器提供，完整页面的 `ExperienceView` 没有此推送。完整页面管理自己的明暗样式，不依赖该事件初始化。

## 7. 按页面选择能力和权限

以下覆盖完整播放器界面的主要工作区；每个页面都要有加载、空数据、错误、重试和不可用状态。按交付范围实现页面，尚未实现的入口不要显示为可用。

| 页面/功能                          | 对接方法族                                                                                  | 权限与实现重点                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 首页、专辑、艺术家/流派展示、搜索  | `library.*`、`music.library`                                                                | `library:read`；桥接是专辑/曲目投影，没有通用的艺人详情 API，不能直接照搬宿主私有查询                              |
| 歌单与收藏                         | `library.playlists/favorite/createPlaylist/addToPlaylist/removeFromPlaylist/deletePlaylist` | 读取 `library:read`，编辑 `library:write`；本地收藏与平台喜欢分别处理                                              |
| 播放器、队列、歌词、睡眠、速度     | `player.*`                                                                                  | 读取 `player:observe`，控制 `player:control`；拖动滑块预览，结束再提交                                             |
| 流媒体、登录、推荐、平台歌单、云盘 | `online.providers/search/login/qr/qrStatus/logout/library/playlist/recommendations/cloud`   | `network`；先看 provider methods，不假定所有音源实现相同登录/云盘能力                                              |
| 下载                               | `downloads.list/create/cancel/retry`                                                        | list 为 `network`；编辑 `library:write`；create 还检查 `network`                                                   |
| 电台                               | `radio.list/add/remove/import/search/play`                                                  | list/search/play 为 `network`，编辑为 `library:write`；play 还需 `player:control`                                  |
| 播客                               | `podcasts.list/episodes/subscribe/remove/refresh/play`                                      | list/episodes/refresh/play 为 `network`，订阅/删除为 `library:write`；订阅还检查 network，play 还需 player:control |
| NAS/网络源                         | `network.profiles/create/remove/test/browse/library/scan/play`                              | 读取/测试/播放 `network`；create/remove `app:settings`；scan `library:write`；play 还需 player:control             |
| 设置、输出设备、音效               | `settings.read/update`、`audio.read/processing/output`                                      | `app:settings`；更新用 `{ patch }`，设备/后端用 `audio.output({ output?, device? })`，候选项从 audio.read 获取     |
| DSP 场景与节点                     | `dsp.read/create/apply/node/import/export`                                                  | `app:settings`；节点操作有白名单，不支持通过 dsp.node 新增 nativePlugin/vst3Plugin；复杂流程可打开宿主 DSP 面板    |
| 主题项目                           | `themes.list/create/read/edit/import/export/apply`                                          | 除 apply 外为 `app:settings`；apply 为 `plugins:manage` 且还检查 app:settings；桥接编辑不含图片控件                |
| 插件管理                           | `plugins.list/enable/disable/install/uninstall/catalog/update`                              | `plugins:manage`；安装沿用宿主确认，不接受任意文件路径；可能停用当前界面，操作前说明结果                           |
| 统计                               | `stats.read`                                                                                | `library:read`；当前给 days/recent/top/artists 摘要                                                                |
| 诊断                               | `diagnostics.status/mark/export`                                                            | `app:settings`；导出由宿主选择位置                                                                                 |
| 扫描、音乐资料与文件导出           | `music.scan/metadata.read/metadata.write/metadata.operate`、`files.export`                  | `library:write`；元数据有 revision、历史和恢复规则，见 experience 协议                                             |
| 自有 UI 偏好                       | `preferences.read/write`                                                                    | `settings`，与应用设置 `app:settings` 不是同一权限                                                                 |
| 自有后台                           | `plugin.request`                                                                            | 当前中继要求 `network`；后台另外如实声明文件等权限                                                                 |

`host.panel` 需要 `app:settings`，打开 plugins 面板还需要 `plugins:manage`。不提供设置/管理页面时不必申请这两个高影响权限。权限表以 [`EXPERIENCE_METHOD_PERMISSIONS`](../src/shared/pluginExperience.ts) 为准，附加权限和实际参数以 bridge/services 实现为准。

当前桥没有通用 IPC 转发，也没有把所有新 Core 功能自动暴露出来。例如多 Zone/同步组管理不在此方法表中；需要新增能力时由宿主维护者增加明确 DTO、方法、权限和测试，再交给界面调用。附属窗口仍由宿主实现；莱茵专用皮肤不会自动成为第三方界面的通用皮肤接口。

## 8. 网络和后台任务放在哪里

已有音源、下载、NAS 功能优先调用宿主对应方法。访问插件自己的服务或执行设备/文件任务时，添加进程入口并走自己的后台：

```js
// iframe
const result = await host.call('plugin.request', {
  request: { action: 'read-summary' }
})
host.on('plugin', ({ event, value }) => {
  if (event === 'summary-updated') renderSummary(value)
})
```

后台通过 `context.twilight.experience.onRequest(handler)` 接收，通过 `context.twilight.experience.emit(event, value)` 推送。它使用进程插件生命周期，类型为 `TwilightExperienceApi`；实现示例和约束见[后台中继协议](./plugin-experiences.md#talking-to-the-plugins-own-background-code-pluginrequest)和[插件导读](./PLUGIN_README.md)。API key、认证信息和网络凭据留在后台或宿主，不通过 iframe 保存。

## 9. 视觉、交互和持久化的边界

- **留出窗口控制区**：bridge v2 的宿主标题栏透明覆盖顶部 30 CSS px，保留返回、拖动、最小化、最大化和关闭。示例留 38px，不在这里放导航、搜索或自绘窗口按钮。
- **样式自洽**：iframe 不继承宿主 CSS 或 `--te-*` 变量。自己的字体、颜色、层级和页面布局随包提供；宿主 CSS 主题继续只影响默认界面。
- **同步标题栏色调**：可发 `parent.postMessage({ type: 'twilight-experience-tone', tone: 'day' }, '*')`，夜间用 `night`；这只通知宿主外壳，不会替你切换 iframe CSS。初始化通过 `await host.call('host.environment')` 读取 `reducedMotion`，自己的动画同时尊重系统减少动态偏好。
- **适配实际窗口**：内容可滚动，长标题可截断/查看全文，底部播放器不能挡住最后一行；验证窄窗、放大字号、键盘焦点和明暗对比。大列表用虚拟化/分页，图片延迟加载。
- **不要复制核心状态**：当前播放、队列、收藏、歌单以宿主结果为准；失败保持原状态并提示。用 preferences 保存主题和导航偏好，不保存整份曲库、绝对路径、版本 URL 或另一个权威播放队列。
- **启动选择**：`startupExperience` 只保存 `{ pluginId, experienceId }`。插件缺失/停用时宿主回到默认界面，保留偏好供恢复；开机引导和用户主动导航优先于自动打开。

## 10. 交付前按用户路径检查

1. `.tep` 根目录有 `plugin.json`；所有 JS/CSS/素材都在包内，安装后无 403/404/CSP 错误。
2. 安装 → 启用 → 从侧栏打开 → 在「完整界面」中可选；取消重启保持现界面，重启后进入所选界面；切回默认同样有效。
3. 空曲库有导入指引；专辑分页、搜索、详情、播放、暂停、跳转进度和音量都使用真实宿主数据。
4. 重复歌曲队列按 queueEntryId 播放/删除；切页、退出、重新打开不会额外停播或重建队列。
5. 权限不足、接口缺失、专辑失效、网络/登录失败有明确状态；写操作不自动重复提交。
6. 明暗、窄窗、大字号、键盘操作可用；顶部宿主返回按钮始终能操作，底部播放器不遮挡内容。
7. 退出/停用/升级后清理端口、监听和计时器；重新进入可恢复当前宿主状态和插件偏好。

仓库中可运行的定向检查：

```powershell
node --test sdk/examples/full-interface/tests/bridge.test.mjs
node --test packages/create-twilight-plugin/test/cli.test.cjs
node --experimental-strip-types --test src/shared/pluginExperience.test.ts
```

前三项覆盖客户端与打包/权限契约；实际宿主、启动重启、外部账号和真实音频设备仍按上面的用户路径验证。参考包中的源码用于查看当前适配语义，不能单独构建整个应用；调试宿主请使用完整仓库。

## 11. 源码索引：需要查哪里

| 要查的事                                | 当前入口                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| manifest 约束、方法名、主权限、请求大小 | [`src/shared/pluginExperience.ts`](../src/shared/pluginExperience.ts)                           |
| 主界面所有请求参数、返回投影和事件      | [`experienceBridge.ts`](../src/renderer/src/extensions/experienceBridge.ts)                     |
| 电台、播客、NAS、统计、主题、诊断适配   | [`experienceServices.ts`](../src/renderer/src/extensions/experienceServices.ts)                 |
| 专辑分页与会话内 ID 映射                | [`experienceLibrary.ts`](../src/renderer/src/extensions/experienceLibrary.ts)                   |
| iframe、握手、标题栏、退出和面板        | [`ExperienceView.vue`](../src/renderer/src/components/experience/ExperienceView.vue)            |
| 包内协议、资源 MIME、CSP                | [`experienceProtocol.ts`](../src/main/plugins/experienceProtocol.ts)                            |
| 已启用 experience 如何成为页面          | [`extensions/registry.ts`](../src/renderer/src/extensions/registry.ts)                          |
| 设置选择器与重启提示                    | [`ExperienceSettings.vue`](../src/renderer/src/components/settings-page/ExperienceSettings.vue) |
| 启动选择解析                            | [`startupExperience.ts`](../src/renderer/src/app/startupExperience.ts)                          |
| 对外插件类型                            | [`packages/plugin-api/src/index.ts`](../packages/plugin-api/src/index.ts)                       |
| `.tep` 打包                             | [`create-twilight-plugin`](../packages/create-twilight-plugin/README.md)                        |

莱茵生命是较完整的独立产品参考，源码在单独的 [Twilight-Echo-plugins 仓库](https://github.com/Px-asen/Twilight-Echo-plugins)中维护，不是开发另一个完整界面的前置依赖。先用本仓库的小示例跑通协议，再参考它的多页面组织。
