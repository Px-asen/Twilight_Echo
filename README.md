<h1 align="center">Twilight Echo</h1>

<p align="center">
  <img src="./assets/logo.png" width="480" alt="Twilight Echo 渐变色标志" />
</p>

<p align="center">
  <strong>收藏你喜欢的音乐，找到下一首心动。</strong><br />
  一款集本地音乐、在线发现、沉浸歌词与 HiFi 播放于一体的开源桌面播放器。
</p>

<p align="center">
  <a href="https://github.com/Px-asen/Twilight_Echo/releases/latest"><img alt="最新正式版" src="https://img.shields.io/github/v/release/Px-asen/Twilight_Echo?display_name=tag&style=flat-square&color=8b5cf6" /></a>
  <img alt="支持 Windows 10 和 11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-2563eb?style=flat-square" />
  <a href="./LICENSE"><img alt="Apache 2.0 开源许可证" src="https://img.shields.io/badge/license-Apache--2.0-64748b?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://github.com/Px-asen/Twilight_Echo/releases/latest"><strong>下载 Windows 版</strong></a>
  · <a href="#快速开始">快速开始</a>
  · <a href="#功能一览">功能一览</a>
  · <a href="#界面预览">界面预览</a>
  · <a href="#常见问题">常见问题</a>
  · <a href="https://github.com/Px-asen/Twilight_Echo/issues">问题反馈</a>
</p>

![Twilight Echo 本地音乐主页：正在播放、曲库概览与随机漫游](./assets/screenshots/local-dashboard.png)

<p align="center"><sub>从硬盘里的珍藏，到每日推荐里的新发现，让音乐陪你度过每一个日常。</sub></p>

## 下载与安装

**[前往 Releases 下载最新版 →](https://github.com/Px-asen/Twilight_Echo/releases/latest)**

1. 在发布页的 **Assets（资源）** 中，下载以 `-setup.exe` 结尾的 Windows 安装程序。
2. 运行安装程序，按向导选择安装位置并完成安装。
3. 打开 Twilight Echo，跟随首次使用向导设置听歌习惯、音乐文件夹和播放器外观。

> [!NOTE]
> Windows 10/11 是当前主要且验证最完整的平台。macOS 与 Linux 后端已有实现，但尚未达到正式发布验证标准。

<details>
<summary>安装时提示“未知发布者”？</summary>

当前安装包由个人开发者发布，尚无商业代码签名证书，因此 Windows SmartScreen 可能显示“未知发布者”。请从本项目的 GitHub Releases 下载，并在发布页提供 `.sha256` 文件时核对安装包的校验值。

在安装包所在文件夹打开 PowerShell，运行下面的命令，将引号内的名称替换为实际文件名，然后与发布页的 SHA-256 比对：

```powershell
Get-FileHash -LiteralPath '.\你下载的安装包文件名.exe' -Algorithm SHA256
```

</details>

## 快速开始

**听本地收藏** — 在首次使用向导中添加音乐文件夹，或打开「设置 → 常规 → 媒体库管理 → 添加文件夹」。扫描完成后，就能按歌曲、专辑、艺术家或文件夹浏览和播放。

**发现在线音乐** — 打开「流媒体」，使用内置网易云音乐服务；扫码登录后，可以访问每日推荐、私人 FM 与个人收藏。更多音源可在「扩展中心」查找，或从[第三方插件仓库](https://github.com/Px-asen/Twilight-Echo-plugins)获取 `.tep` 扩展包。

**调成喜欢的样子** — 在「设置 → 外观」切换深浅主题、封面取色与背景；打开「主题工作室」继续调整字体、布局和播放器样式。想边工作边听歌，可以试试迷你播放器和桌面歌词。

日常听歌可以先使用默认音频设置。接入耳机、音箱或外置声卡后，再到「设置 → 播放」选择对应输出设备。

## 功能一览

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🎵 把收藏整理好</h3>
      <p>多文件夹曲库、专辑与艺术家浏览、歌单和最近播放。新增音乐自动扫描，支持标签批量编辑、重复歌曲检测与 CUE 整轨分曲。</p>
    </td>
    <td width="50%" valign="top">
      <h3>📻 总有新的声音</h3>
      <p>网易云音乐推荐、搜索与歌单发现，云盘上传和下载，还有网络电台与 RSS 播客。通过扩展接入更多音乐来源。</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>✨ 让歌词跟着音乐走</h3>
      <p>逐行、逐词同步，翻译与音译分层显示，支持 TTML 歌词与本地歌词导入。沉浸式播放页随封面变换色彩，桌面歌词独立陪伴。</p>
    </td>
    <td valign="top">
      <h3>🎧 按你的喜好调音</h3>
      <p>原生音频引擎、WASAPI 共享与独占输出、图形和参数均衡器。通过 OPRA/AutoEQ 查找耳机校正，也能组合 DSP 效果并查看频谱、波形与响度。</p>
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>🎨 做成你喜欢的样子</h3>
      <p>浅色、深色与跟随系统，封面取色和液态玻璃材质。主题工作室支持调整外观、预览与导入导出，主窗口和小窗也能分别设置。</p>
    </td>
    <td valign="top">
      <h3>🌙 融入日常的播放控制</h3>
      <p>迷你播放器、托盘控制、自定义全局快捷键与系统媒体控件。支持变速不变调、A-B 区间循环和睡眠定时，工作、练习、入睡时都能用。</p>
    </td>
  </tr>
</table>

## 界面预览

### 找歌、逛歌单，也照顾好本地收藏

<table>
  <tr>
    <td width="50%"><a href="./assets/screenshots/streaming-home.png"><img src="./assets/screenshots/streaming-home.png" alt="在线音乐主页：每日推荐与私人漫游" /></a></td>
    <td width="50%"><a href="./assets/screenshots/local-library-light.png"><img src="./assets/screenshots/local-library-light.png" alt="本地音乐库：歌曲列表与专辑封面" /></a></td>
  </tr>
  <tr>
    <td align="center">每日推荐 · 从熟悉的喜好发现新歌</td>
    <td align="center">本地曲库 · 随时翻阅自己的收藏</td>
  </tr>
</table>

### 留一点屏幕空间给音乐

封面、歌词与色彩一起构成正在播放页面；支持深浅主题，也可以把歌词留在桌面上。

![沉浸式播放页：封面取色、同步歌词与双语显示](./assets/screenshots/immersive-lyrics.png)

<details>
<summary>查看更多界面：歌单发现、调音工具与扩展中心</summary>

<table>
  <tr>
    <td width="50%"><a href="./assets/screenshots/playlist-discovery.png"><img src="./assets/screenshots/playlist-discovery.png" alt="按语种、风格和场景筛选歌单" /></a></td>
    <td width="50%"><a href="./assets/screenshots/streaming-playlist.png"><img src="./assets/screenshots/streaming-playlist.png" alt="在线歌单详情与播放队列" /></a></td>
  </tr>
  <tr>
    <td align="center">按心情与场景发现歌单</td>
    <td align="center">浏览歌单与管理播放队列</td>
  </tr>
  <tr>
    <td><a href="./assets/screenshots/dsp-processor.png"><img src="./assets/screenshots/dsp-processor.png" alt="DSP 处理器与音频信号链" /></a></td>
    <td><a href="./assets/screenshots/equalizer-autoeq.png"><img src="./assets/screenshots/equalizer-autoeq.png" alt="均衡器与 OPRA AutoEQ 耳机校正" /></a></td>
  </tr>
  <tr>
    <td align="center">组合 DSP 效果，查看处理状态</td>
    <td align="center">均衡器与耳机校正</td>
  </tr>
  <tr>
    <td><a href="./assets/screenshots/audio-visualizer.png"><img src="./assets/screenshots/audio-visualizer.png" alt="音频频谱、波形与响度可视化" /></a></td>
    <td><a href="./assets/screenshots/extension-center.png"><img src="./assets/screenshots/extension-center.png" alt="扩展中心：浏览和管理可选插件" /></a></td>
  </tr>
  <tr>
    <td align="center">看见声音的频谱与动态</td>
    <td align="center">按需添加音源、主题和工具</td>
  </tr>
</table>

</details>

<sub>截图供界面参考，实际外观随版本和主题设置变化。截图中的 Bilibili、YouTube Music 等为可选第三方扩展示例，可用性以当前扩展为准。</sub>

## 支持的音频格式

| 类型            | 格式                                                   |
| --------------- | ------------------------------------------------------ |
| 常见音频        | MP3、AAC、OGG、Opus、WMA                               |
| 无损与 PCM 音频 | FLAC、WAV / WAVE、AIFF / AIF、ALAC、APE、WavPack（WV） |
| 其他容器        | M4A、MP4、WebM                                         |
| DSD 与整轨收藏  | DSF、DFF、SACD ISO；支持 CUE 整轨分曲                  |

实际解码与输出能力取决于发布包、音频驱动和设备。`.mqa` 文件按 FLAC 兼容容器扫描与解码，不提供 MQA unfold、认证或授权能力。

## 常见问题

<details>
<summary>只听本地音乐，需要登录或联网吗？</summary>

播放已有本地音乐无需登录音乐平台账号。在线推荐、网络音源、在线歌词获取、电台和播客等功能需要网络；部分在线内容还需要对应平台的登录或订阅权限。

</details>

<details>
<summary>添加文件夹后，歌曲没有出现怎么办？</summary>

先确认文件夹中有受支持的音频文件，并等待扫描完成。在「设置 → 常规 → 媒体库管理」检查扫描目录和扫描状态，必要时执行完整重扫。存放在扫描目录之外的下载文件，需要将所在文件夹加入媒体库后才会显示。

</details>

<details>
<summary>没有声音，或者其他应用突然不能出声？</summary>

先检查播放器音量、静音状态和 Windows 音量混合器，再到「设置 → 播放」确认输出设备。如果启用了 WASAPI 独占模式，设备可能被播放器独占；日常多应用同时播放时，使用共享模式更方便。

</details>

<details>
<summary>为什么有些在线歌曲或扩展暂时不可用？</summary>

内置网易云音乐与第三方音源均依赖对应平台服务，可用内容受账号权限、所在地区和平台策略影响。扩展由各自作者维护，可先检查登录状态并更新扩展；仍有问题时，向对应扩展作者反馈。使用账号和内容时，请遵守对应服务条款。

</details>

<details>
<summary>如何更新播放器？</summary>

打开「设置 → 关于」检查更新，下载完成后按提示运行安装程序；也可以从 [Releases](https://github.com/Px-asen/Twilight_Echo/releases) 手动下载。各版本的更新内容和历史安装包都在发布页中。

</details>

<details>
<summary>HiFi 进阶：独占输出、DSD、ASIO 和 DSP 有哪些限制？</summary>

- **共享与独占**：WASAPI Shared（共享）经过 Windows 系统混音；Exclusive（独占）可在设备允许时进行格式直通。日常播放无需开启独占。
- **DSD**：Native DSD、DoP 与 SACD ISO 的实际播放模式取决于设备、驱动和发布包。WASAPI 与 CoreAudio 没有平台级 native DSD 通道，会使用 DoP 或 PCM 回退；Linux 仅在兼容的 ALSA `hw:` 设备上尝试 native DSD。DSD / 直通播放会绕过部分 DSP，这是预期行为。
- **ASIO 与 VST3**：Windows x64 的 ASIO 兼容层仍属实验性，真实设备支持尚未验证；VST3 的实际运行与设备兼容性同样尚未完成验证。请结合发布包能力清单与应用中的输出诊断判断。
- **重采样与转换**：PCM SRC 支持 SWR；SoXR 随构建可选，当前仍属未验证能力。实验性 PCM→DSD64/128/256 由 CPU 执行，不代表完整高品质 SDM；当前不提供 CUDA SDM。

更详细的能力状态见[发布能力说明](./docs/release-capability-status.md)，实际发布包以随附的 `audio-capabilities.json` 与 `release-capability-status.json` 为准。

</details>

<details>
<summary>macOS 和 Linux 可以用吗？</summary>

CoreAudio 与 ALSA 后端已存在，但目前没有经过与 Windows 同等级别的发布和真实设备验证。现阶段建议普通用户使用 Windows 版本；macOS / Linux 构建供开发、测试和贡献使用。

</details>

## 反馈与交流

遇到问题或有新想法，欢迎[提交 Issue](https://github.com/Px-asen/Twilight_Echo/issues)。描述问题时，附上**应用版本、系统版本、复现步骤**和相关截图或日志；音频问题再补充输出设备、驱动、输出模式及歌曲格式，方便定位。

**官方 QQ 群：1093775290** — 交流使用体验、参与预览版内测，获取Apple Music 音源。

## 支持与赞助

如果 Twilight Echo 成了你常用的播放器，欢迎给项目点一个 **Star**、分享给朋友，或通过[爱发电](https://afdian.com/a/pxasen)支持后续开发。捐赠者将记录在软件内的贡献者名单中，感谢每一份支持。

## 扩展与开发

想制作扩展、贡献代码或从源码运行，可以从这里开始：

[开发者文档](./docs/DEVELOPER_README.md) · [插件开发指南](./docs/PLUGIN_README.md) · [插件规范](./docs/twilight-echo-plugin-spec.md) · [第三方插件仓库](https://github.com/Px-asen/Twilight-Echo-plugins) · [全部文档](./docs/README.md)

开发环境使用项目锁定的 `pnpm@11.7.0`；依赖安装、原生音频工具链和运行步骤见开发者文档，Windows 发布流程见[发布检查](./docs/windows-release-gate.md)。

## 开源许可

Twilight Echo 采用 [Apache License 2.0](./LICENSE) 开源。第三方依赖、字体、图标、插件和内容素材遵循各自的许可证或服务条款；相关商标归其权利人所有，Twilight Echo 与这些服务不存在官方隶属或背书关系。

如有版权或侵权问题，请联系 [asenyarzc@gmail.com](mailto:asenyarzc@gmail.com)，以便核实并处理。
