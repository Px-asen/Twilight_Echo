# 控件样式与 Token 契约

本文记录共享控件的几何、语义色与回归约束。整体设计原则见 [界面语言](./interface-language.md)。

表面透明度、阴影、模糊和回退遵循 [统一材质声明](./material-contract.md)，控件几何继续使用本文 token；两者不互相覆盖。

## 统一原则

- **单一事实来源**：所有交互控件的几何与语义色都落在 `assets/base.css` 的
  `--te-control-*` / `--te-switch-*` / `--te-badge-*` token 上。
- **不新增硬编码颜色**：组件样式只消费 token；颜色仍由主题运行时注入，浅色 / 深色 /
  主题预设全部照常工作（`themeColorAudit` 守卫）。
- **组件作用域优先**：跨组件的类只在定义处改成 token，不引入 `!important`，不用全局
  覆盖去压倒 scoped 样式。`base.css` 只补「未被任何组件样式覆盖时的兜底几何」。
- **尺寸归一到刻度，而非一刀切**：每个控件吸附到最近的 token 档位（`sm/md/lg/field`），
  保留各 surface 的合理大小差异，同时消除「26/30/32/33/34/36/38/40/42/46」这类随手值。

## Token 契约

定义位置：`src/renderer/src/assets/base.css` 的 `:root`。

### 通用控件几何

| Token                                             | 值                                               | 用途                            |
| ------------------------------------------------- | ------------------------------------------------ | ------------------------------- |
| `--te-control-radius-sm`                          | `8px`                                            | 紧凑按钮 / 字段 / 菜单项        |
| `--te-control-radius-md`                          | `var(--te-radius-global)` 10px                   | 标准按钮 / 菜单容器             |
| `--te-control-radius-lg`                          | `12px`                                           | 分段容器 / 大按钮 / 对话面板    |
| `--te-control-radius-pill`                        | `999px`                                          | 胶囊按钮 / 开关 / 圆形图标按钮  |
| `--te-control-height-sm`                          | `28px`                                           | 紧凑控件（工具条 / 选择按钮）   |
| `--te-control-height-md`                          | `34px`                                           | 标准控件（图标按钮 / 常规按钮） |
| `--te-control-height-lg`                          | `40px`                                           | 大控件（主行动按钮 / 传输按钮） |
| `--te-control-height-field`                       | `36px`                                           | 输入框 / 选择框 / 工具触发器    |
| `--te-control-pad-x-sm/md/lg`                     | `10 / 14 / 18px`                                 | 横向内边距                      |
| `--te-control-gap`                                | `8px`                                            | 图标与文字间距                  |
| `--te-control-font-size`                          | `var(--te-font-size-body)`                       | 标准字号                        |
| `--te-control-font-size-sm`                       | `calc(var(--te-font-size-body, 14px) * 12 / 14)` | 随界面字号缩放的紧凑字号        |
| `--te-control-font-weight` / `-strong` / `-bold`  | `500 / 600 / 700`                                | 字重                            |
| `--te-control-border-width`                       | `1px`                                            | 描边                            |
| `--te-control-focus-width` / `-offset` / `-color` | `2px / 2px / accent`                             | 焦点环                          |

### 语义色

`--te-control-bg`、`--te-control-bg-hover`、`--te-control-bg-active`、`--te-control-fg`、
`--te-control-fg-muted`、`--te-control-border`、`--te-control-accent`、`--te-control-accent-soft`、
`--te-control-accent-line`、`--te-control-accent-text`、`--te-control-on-accent`、
`--te-control-danger`、`--te-control-danger-soft`、`--te-control-on-danger`。

主题运行时根据最终生效的强调色和卡片背景计算实心按钮及软按钮文字色。
普通文字目标对比度为 4.5:1，软按钮同时覆盖默认和悬停状态；危险按钮独立计算文字色，
避免亮色强调色所需的深色文字被误用到红色按钮上。

### 开关几何（三个 family 共用）

`--te-switch-width`(40) `--te-switch-height`(22) `--te-switch-inset`(3) `--te-switch-thumb`(16)
`--te-switch-travel`(18)，以及 `.large` 变体 `-lg`（48 / 28 / 4 / 20 / 20）；
颜色侧 `--te-switch-track` `--te-switch-track-active` `--te-switch-thumb-bg` `--te-switch-thumb-shadow`。
带 1px 描边的开关用 `calc(var(--te-switch-inset) - var(--te-control-border-width))` 保持视觉居中。

### 徽标几何

`--te-badge-radius`(pill)、`--te-badge-pad-x`(8) `--te-badge-pad-y`(2)、
`--te-badge-font-size`（默认 12，随界面字号缩放）`--te-badge-font-weight`(600)。

### 对话框

对话框消费 `--te-dialog-radius`，保留 Pxasen 的 **`8px`** 默认值，与主题注册表一致；
用户主题和预设仍可覆盖该值。

## 控件差异

统一的是**刻度与语义**，不是把每个 surface 抹平。以下差异是设计意图，不应被「统一」掉：

- **形状**：播放栏 `.icon-btn` 是圆形（pill），插件页 `.icon-btn` 是圆角方形（sm）——
  前者悬浮在内容上，后者是列表内工具。
- **尺寸档位**：标题栏窗口控制按钮、仪表盘 `.transport-button`(46px) 属于大号传输控件，
  保留大尺寸；`.sf-play-button` 主播放按钮仍有强调尺寸。
- **配色**：`.deck-*` 侧栏、`.stage-*` 流媒体舞台、`.an-*` 仪表盘、`.onb-*` 引导页各自
  持有独立调色板，几何使用共享刻度，配色沿用其 surface token。
- **状态**：`.menu-item.danger`、`.badge.http` 等语义变体保留各自的危险/告警色。

## 防回归守卫

## 7. Pxasen 集成验证

- 主题套件：290/290 通过，包含新增的 Electron 控件行为回归测试。
- 改动文件 ESLint、Node/Web 类型检查通过。
- 生产构建和渲染资源预算检查通过。
- 保留 Pxasen 的依赖版本和既有测试脚本；仅向 `test:themes` 加入控件回归测试。

## 8. 2026-10-12 Apple HIG 复查

结论：当前是参考 HIG 的 Windows 适配，不能宣称全程序已符合 HIG。依据官方 [Design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)、[Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)、[SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)、[Materials](https://developer.apple.com/design/human-interface-guidelines/materials) 和 [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) 检查一致性、层级、可发现性、材质分层和键盘操作。SF Symbols 的字重与符号一致性原则用于现有 Phosphor 图标系统；未引入 Apple 专有字体或符号资源，Windows 窗口控制继续使用平台形态。

| 检查项 | 当前结果与证据范围 |
| --- | --- |
| 标题栏与侧边栏字体 | 原本均沿用 `--te-font-sans`，标题栏现在显式消费同一字体与控件字重；侧边栏标签去除单独字距。分组标题与子页面保留不同层级，不把所有文字强制成相同大小。 |
| 图标一致性 | 标题栏的菜单、个人、返回、扩展、设置、通知，以及导航的搜索、收藏、云盘、网络和展开箭头统一使用现有 ThemeIcon。标题栏和普通侧边栏默认图标均为 18px；保留小／大图标偏好及插件自定义图标。 |
| 侧边栏层级与可发现性 | 两层导航、当前页面与展开状态的无障碍属性、左右键展开／折叠保持有效；子页面图标仅在 rail 模式显示，修复空按钮，展开模式继续使用清晰文字。 |
| 弹窗、反馈和关闭 | 首页 DSP 弹窗接入公共焦点限制和 Escape 层，关闭恢复触发入口。已复查命令面板、下载弹窗、通知与原生右键菜单的已有行为测试；原生菜单的隐藏 Vue 项目不作为可点击 div 缺陷。 |
| 内容入口与嵌套控件 | 在线音乐库“最近播放／听歌排行”改为语义按钮，支持 Tab、Enter 和焦点环。歌单删除改为独立按钮，键盘操作和指针按下不再传播给外层歌单卡片；键盘聚焦卡片时显示删除按钮。 |
| 材质和切换 | 内容保持普通材质，导航和控制使用模糊；标题栏选中只增加内收底色。歌曲详情的标题栏文字立即使用播放页颜色，避免跨深浅色时短暂的旧色；透明、减少特效、高对比度回退继续有效。 |
| 布局、滚动与字号 | 相关 Electron 回归覆盖主要页面滚动边界、共享返回、播放器避让、设置组织，以及不同字体、深浅色和三种导航图标族。不能据此推断所有自定义布局和全部字号／DPI 组合均已验收。 |

本次扫描了组件目录中的 169 个 Vue 模板，并对点击、模态框和焦点候选逐项区分原生菜单、容器代理事件、已有键盘支持与实际缺口。随后按[界面语言](./interface-language.md)补齐歌曲／聚合列表的键盘播放与选择、DSP 节点的键盘选择与排序；这些入口现已纳入真实组件回归。

此外，自定义背景和所有强调色下的最终文字对比度、第三方插件页面、Windows 读屏器、系统大字号及全部 DPI 组合尚未完成全量原生验收。本轮采用独立数据目录的真实 Vue／Electron 夹具；`ChromeHig.behavior.test.ts` 实际加载图标字体并检查两组字体、深浅色、三种图标族、三种导航模式、点击命中和真实键盘激活。隐藏窗口通过 Chromium 焦点模拟验证浏览器焦点行为，不代表已经验证 Windows 读屏器。构建和渲染资源预算通过；这些结果不构成 Apple 合规认证。

## 9. 2026-10-12 全页面布局复查

结论：内置页面的入口、共享布局和主要状态已检查，发现并修复了布局和控件样式问题；当前仍有键盘可达性和小字号问题，不能称为全面符合 HIG。检查依据为官方 [Layout](https://developer.apple.com/design/human-interface-guidelines/layout)、[Typography](https://developer.apple.com/design/human-interface-guidelines/typography)、[Materials](https://developer.apple.com/design/human-interface-guidelines/materials) 和 [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。采用桌面键鼠环境下的层级、对齐、适应性、焦点和可读性原则，没有把 iPhone 的字号和触控尺寸直接套到 Windows，也没有把玻璃效果数量当作符合 HIG 的证据。

### 9.1 页面覆盖与证据

| 页面族 | 本轮检查方式与结果 |
| --- | --- |
| 本地主页、搜索 | 原生窗口查看；共享滚动边界、标题栏避让和字号回归。当前数据下未见明显错位。 |
| 本地歌曲、专辑、艺术家、文件夹、流派及详情 | 检查 SongList 分支和共享列表／网格；歌曲、专辑原生查看，专辑行为夹具验证；歌曲末尾避让修复。其他分类依据共享布局检查，未逐个真实数据状态截图验收。 |
| 应用歌单、聚合歌单 | 原生查看应用／聚合入口，聚合行为夹具通过；移除页签重复预留的标题栏空间，修复较高播放栏下的末尾遮挡。 |
| 最近播放、听歌统计 | 检查本地／平台分支和统计页样式，统计行为夹具、共享滚动边界通过；平台历史、统计页底部留白跟随播放栏。 |
| 在线推荐、发现、音乐库、云盘、搜索和歌单／专辑／歌手详情 | 检查 StreamingPage、StreamingLibrary、NcmCloudPanel 和 StreamingDetailStage 等入口与滚动关系；原生查看在线音乐库；共享在线滚动边界回归通过。未访问每个服务、登录状态和远程详情数据组合。 |
| 歌曲详情、普通／沉浸播放栏 | 检查页面分层与播放栏切换，歌词和标题栏／导航行为夹具通过；保持原有封面与歌词布局、普通页面悬浮播放栏和详情页贴底播放栏。 |
| 电台、播客 | 检查两种分支和窄容器布局；原生查看电台空内容并滚动到末尾，最终操作区在播放栏上方；长内容夹具通过。没有新增订阅或真实播放。 |
| 网络源、网络媒体库、目录浏览 | 检查三类分支，原生查看无连接状态；长内容和按钮样式夹具通过。修复添加／连接等按钮退回原生灰色按钮的问题。未使用凭据连接外部服务器。 |
| 设置七个分组与外观编辑 | 原生查看外观，设置组织、滚动、背景、公共控件字号和对比度夹具通过。没有修改个人偏好。 |
| 主题编辑器、主题插件工坊 | 两页原生查看；修复主题编辑器重复标题栏偏移，工坊隔离预览宿主高度和样式加载后的图层命中更新。隔离项目的拖动、一次撤销、Esc 取消、保存和预览隔离通过。未保存或应用用户项目。 |
| 图形／参数均衡器 | 两种原生页面查看与切换；参数工作区回归通过。复现并修复含 AutoMix 设置时的克隆错误；重新载入后原生切换显示 DSP 就绪，随后恢复图形模式。 |
| DSP 机架 | 原生查看场景、处理链、参数和试听区；试听夹具通过；增加试听卡片与编辑区间距，避免描边连成一体。未应用新处理链。 |
| 扩展中心、插件页面宿主 | 原生查看已安装扩展列表；开发者模式夹具通过。插件宿主通过长输出／长标题夹具验证，修复滚动裁切和深色模式文字配色。第三方插件自己的内容不属于已验证范围。 |
| 登录、首次引导 | 源码入口和组织检查；首次引导完成／跳过流程测试通过。未重走个人登录或清除引导状态。 |
| 队列、导航编辑、曲库收件箱、响度等弹窗 | 使用独立数据目录的 Vue／Electron 行为夹具检查焦点、关闭、编辑和布局。导航夹具已适配侧边栏删除导入／编辑按钮后的设计，独立测试编辑对话框。 |
| 迷你播放器、托盘播放器、桌面歌词 | 源码布局检查；迷你播放器布局／控件测试、桌面歌词 Electron 行为通过。未对所有独立原生窗口、皮肤和桌面缩放组合验收。 |

### 9.2 已修复问题

- 主题编辑器在已避让标题栏的宿主内再次增加顶部偏移，导致位置错误及下沿越界。
- 应用歌单页签和插件页面宿主重复预留标题栏空间。
- 插件页面长输出缺少受约束的滚动区域，长标题无法换行；结果／错误／加载文字使用不适合深色模式的固定颜色。
- 歌曲、统计、聚合歌单、平台最近播放、电台和网络源的底部留白未始终跟随实际播放栏高度。
- 工坊全窗口装饰的宿主在固定子元素布局下高度塌陷，预览加载样式之后没有及时刷新图层命中区域。
- 网络源的软按钮只继承共享几何、缺少自己的颜色和边框定义，呈现默认浏览器按钮。现在显式使用共享控件颜色、尺寸和禁用状态。
- DSP 试听区和下方三栏编辑区的描边紧挨，增加 14px 间距恢复区块层级。
- 音频设置快照未复制 AutoMix 子对象，Vue 响应式对象穿过传递边界时导致均衡器同步失败。复制该对象并新增结构化克隆回归。

### 9.3 仍需完善

1. 歌曲与聚合列表、DSP 图节点的键盘缺口已在后续界面语言修复中处理；新增行为见[界面语言](./interface-language.md)的控件与键盘规则。
2. 参数均衡器仍有 8–10px 的固定辅助字号，紧凑播放栏也有小字号。高 DPI 和放大字号下的可读性尚需单独处理和原生验证。
3. 全部自定义主题／布局、背景图上的最终对比度、全部第三方页面、Windows 读屏器及全部 DPI 组合没有完成逐项验收。

### 9.4 验证记录

- 主页面、材质／字体、均衡器与快照回归组：62/62 通过。
- 辅助页面、导航、弹窗、网络控件和布局回归组：65/65 通过；与前一组有重复测试，不累加为独立测试数。
- 新增页面边界夹具覆盖 760×692、960×720、1366×874，14／18px 字号和 102／220px 播放栏底部避让，共 84 组布局组合。夹具使用真实组件样式及代表性 DOM；它不是所有页面和全部业务数据的完整原生验收。
- 新布局和快照测试已加入 `test:app`。改动文件 ESLint、Node／Web 类型检查、生产构建及渲染资源预算通过。
- 原生窗口查看通过 computer-use 完成；隔离夹具没有写入个人曲库、主题项目或播放队列。当前开发窗口已经载入修复。


## 10. 2026-10-12 设计心理学复查

侧边栏与播放栏的视觉比重调整、研究依据、主要页面族评估及后续优先级见 [设计心理学与界面规范评估](./design-psychology-audit.md)。该报告区分原生观察、源码判断与隔离渲染证据，不代表所有业务状态或 Apple 合规认证。
