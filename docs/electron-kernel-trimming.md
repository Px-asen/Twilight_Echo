# Electron 43.8.1 内核裁剪评估

## 结论

正式应用继续使用官方 Electron。下一轮独立内核实验的候选是 **PDF 查看器与 Electron 扩展支持的组合裁剪**，以及单独关闭内置拼写检查。候选仅完成固定版本源码评估；构建成功、插件兼容性和内存收益均未验证。

目前没有足够依据为了常驻内存维护一套定制内核。先完成应用进程的按需加载更直接：它针对实际执行的初始化，而内核裁剪还涉及包体积、可执行代码页和运行时对象之间的区别。组件未使用时，移除其代码不一定降低同等数量的私有工作集。

本评估于 2026-11-06 检查项目锁定的 Electron `v43.8.1`。该标签 `DEPS` 指向 Chromium `150.0.7871.250`、Node `v24.22.0`；项目开发机用于构建脚本的 Node 版本与嵌入运行时版本应分别记录。没有使用 Electron 主分支的开关替代固定版本，也没有下载内核源码树、工具链或构建二进制。

## 组件与实际开关

| 组件 | 固定版本证据与开关 | 项目兼容影响 | 收益判断与建议 |
|---|---|---|---|
| PDF 查看器 | Electron 声明 `enable_pdf_viewer`；`BUILD.gn` 要求它同时依赖 `enable_pdf` 和 `enable_electron_extensions`。[E1、E3] | 本轮未发现业务直接调用 PDF 查看器；Experience 协议仍声明 PDF MIME，外部登录页面和插件内容也不等于仓库可穷尽的页面集合。 | 可与扩展支持一起作为实验候选。优先影响查看器资源和代码；没有常驻内存节省量。 |
| Electron Chrome 扩展支持 | `enable_electron_extensions` 控制 Electron 扩展源码与一组依赖；启用时还要求 Chromium `enable_extensions`。[E1、E3] | 未发现应用调用 `loadExtension`；Twilight 的 Node 插件机制与 Chrome 扩展机制不同，但不能据此忽略嵌入页面及 Electron 自身功能的依赖。 | 裁剪时须同时关闭 PDF 查看器。该开关不等于删除所有 Chromium 扩展相关代码；更底层的组合未验证。 |
| 内置拼写检查 | Electron 的 `enable_builtin_spellchecker` 生成 `ENABLE_BUILTIN_SPELLCHECKER`；Chromium 另有由平台推导的 `enable_spellcheck`、`use_browser_spellchecker`、`use_renderer_spellchecker`。[E1、E2、C2] | 主窗口和主要辅助窗口已经设置 `spellcheck: false`。不删除中文输入、字体、ICU 或文本编辑能力。 | 独立低优先级候选。关闭 Electron 功能标志不代表 Hunspell 和系统拼写依赖全部从二进制消失。 |
| 打印与 PDF 底层 | Electron 通用参数指定 `enable_printing = true`；Chromium 的 `enable_print_preview` 依赖打印与 PDF，Windows 的进程外打印对话框还依赖 `enable_oop_printing`。[E3、E4、C1] | 仓库未发现 `print()` / `printToPDF()` 业务调用；插件和登录页的打印入口仍需单独确认。 | 初始实验保留。关闭查看器后，打印仍可能保留 PDF 代码；不能宣称 PDF 底层已裁净。 |
| WebRTC | 已核对的 Electron 自有开关未提供完整 WebRTC 裁剪项；本轮没有确认能适用于该固定依赖树的完整 GN 组合。 | 仓库未发现 `RTCPeerConnection` / `getUserMedia` 直接调用；外部登录页面及插件的兼容范围仍开放。 | **未确认，保留。** 不把通用网上参数写入发行配置。 |

GN 开关存在、生成宏、移除某组依赖、成功构建，是不同层次的证据。上表只说明已经从源码确认到哪一层。

## 保留项与维护成本

- **GPU、WebGL、合成器：** 播放页流体背景使用 WebGL，现有透明、模糊和动画属于产品体验约束。
- **Node、V8 和进程隔离：** Core、数据库、音频、分析和插件使用独立工作进程；不通过合并进程或关闭沙箱交换内存。
- **国际化、字体与媒体：** 曲库存在中文拼音排序和多语言文本；Linux 的媒体会话使用 HTMLAudioElement 辅助发布，Windows 与其他平台不能共用一个未经确认的媒体删除清单。
- **编解码器与原生音频：** Chromium 媒体功能与应用原生音频依赖分别评估，不能因为主要播放走原生引擎就直接删除 Chromium 的媒体库。

对未来定制版本，每次 Electron 升级都需重新对齐其 Chromium/Node 版本、补丁、构建参数、打包清单和原生模块兼容性。保留官方构建作为可切换的发行候选；插件登录、媒体协议和系统集成的兼容问题须在替换前解决。当前没有改变发行配置或原生模块 ABI。

## 固定版本来源

以下是本评估直接读取的源文件，链接中的标签固定。

- E0：Electron `DEPS`，版本依赖。
  `https://raw.githubusercontent.com/electron/electron/v43.8.1/DEPS`
- E1：Electron `buildflags/buildflags.gni`，三个 Electron 开关的声明。
  `https://raw.githubusercontent.com/electron/electron/v43.8.1/buildflags/buildflags.gni`
- E2：Electron `buildflags/BUILD.gn`，对应生成宏。
  `https://raw.githubusercontent.com/electron/electron/v43.8.1/buildflags/BUILD.gn`
- E3：Electron `BUILD.gn`，PDF/扩展依赖约束及打印、扩展、PDF 条件依赖。
  `https://raw.githubusercontent.com/electron/electron/v43.8.1/BUILD.gn`
- E4：Electron `build/args/all.gn`，通用构建参数。
  `https://raw.githubusercontent.com/electron/electron/v43.8.1/build/args/all.gn`
- C1：Chromium `printing/buildflags/buildflags.gni`，打印开关关系。
  `https://raw.githubusercontent.com/chromium/chromium/150.0.7871.250/printing/buildflags/buildflags.gni`
- C2：Chromium `components/spellcheck/spellcheck_build_features.gni`，Windows 拼写实现选择。
  `https://raw.githubusercontent.com/chromium/chromium/150.0.7871.250/components/spellcheck/spellcheck_build_features.gni`

项目证据：窗口的 `webPreferences`、Experience 协议 MIME 表、`appleMusicFluidRenderer.ts`、`mediaSessionSentinel.ts`、`pinyinInitials.ts` 及 Core 的 utility process 入口。
