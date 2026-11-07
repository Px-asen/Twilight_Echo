# 通过输出桥播放原生 DSD、DoP 和多声道

在连接 DAC 的电脑打开「声区 → 本机输出与输出桥」，先选择接收格式、声道布局和采样率，再开启「允许此电脑作为输出桥」。另一台 Core 使用这份邀请连接；手机仍控制同一个声区。

## 先选择 DAC，再开放接收

在接收电脑的音频设置中明确选择 DAC 和驱动，不能使用系统默认设备。开启接收时先打开并验证指定设备；设备协商成不同采样率或声道数时拒绝，不降为双声道或切到扬声器。

| 接收格式 | 网络内容 | 输出要求 |
|---|---|---|
| PCM · Float32 | 小端 Float32；1–8 声道，44.1–768 kHz | 驱动支持所选速率、声道及布局；可保留 Core DSP |
| DoP | 小端 24 位载波，176.4–1536 kHz；每帧每声道携带 16 个 DSD 位 | DAC 支持 DoP，使用能证明载波格式的 ASIO／WASAPI 独占／CoreAudio 独占路径 |
| 原生 DSD | 按接收驱动协商的 LSB、MSB 或 NER8 字节序发送；DSD64–DSD512，两种基频系列 | ASIO 或 ALSA 驱动明确支持请求的原生 DSD 速率与声道数 |

范围表示协议可表达的格式；开启接收时仍以所选驱动能否实际打开为准。Linux x86_64 Server 镜像已完成实际构建、网络格式与最终容器软件验证，见 [Linux 部署](server-linux.md)。容器使用独立 Bridge 输出；真实 Linux DAC 运行验收统一后置。

**每条连接固定一种格式。** 切换 PCM／DSD、载波速率或布局时，先关闭接收，修改设置后重新开启，并让 Core 使用新的邀请连接。

## DSD 音源需要保留为 DSD

Core 选择与接收端相符的 Native DSD／DoP 输出模式，音量设为单位增益，播放速率为 1，并关闭要求 PCM 的处理。现有 DSD 读取、位序转换及 DoP 封装继续由原生引擎完成，网络不把原始字节转成浮点。

DSD-only 接收端遇到 PCM 音源、不匹配的 DSD 速率、非单位增益或需要 PCM 的 DSP 时拒绝播放。不会把 PCM 字节当作 DSD，也不会跳到 Core 上保存的本机 DSD 设备。本轮不增加网络 PCM→DSD 调制；需要普通 DSP 时改用 PCM 接收模式。

DoP 数据入缓冲前检查标记及跨包连续性。接收端适配驱动的 packed-24／24-in-32 容器，只调整容器和标记，不改变 DSD 负载。欠载时写入 DSD 空闲数据，DoP 标记继续交替；设备失效、撤销授权和连接中断均停止接收，不自动换设备。

## 多声道按明确布局传送

界面提供单声道、双声道、5.1 侧环绕和 7.1。网络同时传送声道数和 WAVE／FFmpeg 声道位图，样本按位图中扬声器位的升序交错；不只靠声道数量猜顺序。高级 Core `bridge.host` 调用可指定 `channels` 和 `channelMask`，位图的有效声道数必须一致。

ASIO／ALSA 的逐通道输出可能不报告扬声器位图。此时保留选定布局，按设备通道顺序输出；操作者须核对 DAC 的物理连接。`channelMask` 是网络配置布局，`actualChannelMask` 是驱动报告，0 表示未报告，不把配置冒充硬件确认。

DSD／DoP 和多声道用于**独立声区**。现有同步组仍要求双声道 PCM 和自适应时钟；不对 DSD 进行 PCM 重采样或速率修正。

## 更新与验证

Core 与 Bridge 都需要本轮运行时。双声道 PCM 的原入口和旧协议继续可用；缺少新能力的旧端不能接入 DSD／DoP／多声道，不静默改成 PCM。桌面与 Android 信号链显示真实传输格式、声道数和按正确帧单位计算的缓冲。

交付包：

- [Windows x64 桌面／Bridge ZIP](D:/Project/Twilight_Echo/dist/TwilightEcho-2.0.0-win32-x64-network-bridge-20261105-r2.zip)：包含新的原生引擎、x64／x86 ASIO 辅助程序和桌面控制界面。
- [Windows x64 Server ZIP](D:/Project/Twilight_Echo/dist/TwilightEchoServer-2.0.0-win32-x64-network-formats-automix-20261105-r4.zip)：用于 Core／Server。
- [Android Debug APK](D:/Project/Twilight_Echo_Android/app/build/outputs/apk/debug/app-debug.apk)：用于手机控制及原有手机本地播放。

接收电脑将桌面 ZIP 解压到新目录，正常退出旧桌面应用后运行其中的 `TwilightEcho.exe`，再按本页选择 DAC 和开启输出桥。ZIP 沿用桌面应用现有用户数据位置，不是独立便携 Profile，也不更新已安装的旧版本。Windows ZIP 均附传输校验文件，桌面包未签名；系统可能显示 SmartScreen 提示。

这批交付包含普通组 gapless、组 AutoMix、两端模式设置、暂停恢复、短 EOF 的 DSP 排空及迁移模式保留修复。组 AutoMix 使用方法见[同步组切曲](sync-group-transitions.md)。版本沿用工作区的 2.0.0；旧 network-formats r3 Server 包保留回退。

开发入口的原生文件仍独立暂存在 `.artifacts/group-automix-resources-20261105-r2/audio-engine`，未覆盖被占用的活动 DLL。正常退出占用该 DLL 的播放器后，可沿用原暂存命令更新：

```powershell
node scripts/stage-audio-engine.cjs --build-dir D:\TwilightEchoDependencies\builds\audio-engine-mingw
```

Server 打包器也接受 `--audio-runtime <完整原生运行时目录>`，可从独立暂存目录交付，不覆盖活动 DLL。桌面打包沿用 `packaged-audio-staging.cjs` 的独立暂存路径，交付 ZIP 已包含新引擎。

桌面最终 ZIP 已实际解压：`.network-desktop-final-verification.log` 验证 282 个运行依赖、7 个必需原生文件、双架构 ASIO 自检、模型／许可清单及能力声明。`.network-desktop-packaged-native.log` 使用解压包内 Electron／原生模块／归档音频服务，17 项格式与同步组回归通过；接收 DAC／时钟受控。Server r4 的真实包检查见 `.group-settings-migration-package-validation.log`，六会话迁移见 `.group-settings-migration-package.log`；此前格式回归见 `.group-automix-settings-packaged-formats.log`。Android 模式设置及构建见 Android 仓库 `.group-automix-settings-ui.log`、`.group-automix-settings-android-final-build.log`。

软件证据：

- C++ 接收器用受控驱动验证 1／2／6／8 声道、原始 DSD 字节、DoP 容器／标记、欠载空闲数据、拔出停音和布局拒绝；原双声道、定时及自适应接收回归通过。日志 `.bridge-formats-native-final.log`。
- 真实原生解码器／Capture 后端通过生产 TLS 发送旧双声道 PCM、5.1／7.1 PCM、LSB／MSB／NER8 DSD、六声道 DSD，以及 DSD64／DSD512 的 Native 与 DoP；核对数据、Seek 重建、Pause 清空、旧端拒绝及 PCM 误入 DSD 拒绝。接收 DAC 为受控边界。归档模块的最终日志 `.bridge-formats-packaged-tls.log`。
- 旧 TLS／时钟／同步控制回归及格式／信号链检查通过；桌面真实 Vue 页面已检查格式选择、速率联动和开启后的锁定。类型检查及 Android 构建记录以 `.bridge-formats-*` 日志为准。
- r3 的纯 PCM 44.1↔48 kHz 首次读取检查覆盖双声道及 5.1，不插入 DSD roll 静音；DoP→PCM 的首次保护保留，后续纯 PCM 起播不继承旧诊断。后续组 AutoMix 已补齐共同协调器、持久化和两端设置；组仍使用双声道 adaptive PCM，不将 DSD／DoP 或多声道隐式转换后编组。

真实 ASIO／ALSA／DoP DAC 的声音、驱动兼容性及物理通道顺序继续列入统一实机验收。
