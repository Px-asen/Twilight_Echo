# 第一阶段：一个 Core，选择远端 DAC

更新于 2026-11-03。第一阶段代码、构建和本机原入口的真实 Electron Core 联调已通过；双机／手机／DAC 实机验收按用户安排后置。原入口的 Low 完整性标签故障已按用户授权完成单文件修复。

后续进展：[第二阶段多 Zone 与接力记录](D:/Project/Twilight_Echo/docs/audio-zones-phase2.md)。本文保留第一阶段单 Zone 的交付范围。

2026-11-05 已扩展独立声区的原生 DSD／DoP 与多声道传输，入口和当前边界见[网络音频格式](./audio-bridge-formats.md)。下文双声道 PCM 限制保留为第一阶段历史范围。

## 怎么使用

两台电脑均运行本次构建的 Twilight Echo。现阶段依托桌面宿主及其隔离音频服务；独立安装的 Windows Service、NAS／容器 Server 属于后续阶段。

1. **电脑 B 接 DAC。** 在「设置 → 播放」中明确选择具体的输出后端和设备，不选择系统默认。WASAPI 独占、ASIO 等仍使用现有 C++ 驱动实现。
2. 展开「Core 与输出桥 → 连接另一台电脑 / 将此电脑设为输出桥」，选定请求采样率，点击「开启接收」。开启会停止 B 的本地播放。复制输出桥邀请，只交给可信的电脑 A。
3. **电脑 A 作为 Core。** 在同一面板粘贴 B 的邀请，点击「连接并选择」。A 保留唯一队列、曲目、播放位置和 DSP；B 只接收处理后的 PCM 并驱动选定设备。
4. **手机配对 A，而不是 B。** 沿用已有桌面 Core 配对，在手机选择「控制电脑」，打开「电脑输出 · DSP · 信号链」。可以选择已添加的 B 输出、明确重连、修改 A 的 DSP／EQ 和应用 A 已保存的 DSP 场景。
5. 播放后，在桌面 Hi-Fi 侧栏「输出」或手机音频面板中查看完整路径和 B 回报的格式、缓冲、PCM 出队帧数及欠载。

两台电脑应位于可互通的局域网。邀请内使用 B 首个非回环 IPv4 地址和临时 TCP 端口；多网卡／VPN 环境需检查该地址是否可达。若已有防火墙规则阻止连接，应由用户允许所需的局域网入站连接，不关闭系统防火墙，也不把监听端口映射到公网。

### 断线和退出

- B 点击「关闭并撤销」：关闭监听、撤销当前邀请，立即断开已连接的 A。
- 网络或 DAC 失效：停止播放，保留 Bridge 选中状态；不会自动改播 A 的扬声器。排除问题后明确点击「重新连接」，再开始播放。
- 音频服务重启：保留选中 Bridge 的意图并隔离播放，需要明确重连。整个 Core／应用重启后不会恢复邀请凭据；在 A 桌面重新输入 B 邀请，或明确选择「此电脑」。
- 输出选择文件损坏或无法读取：应用仍可启动，但隔离播放；重新添加输出桥或明确选择「此电脑」后恢复，不推定用户同意本机发声。首次使用且文件不存在时仍默认本机输出。
- 回到本机输出：选择「此电脑」，恢复先前本地输出配置；切换会先停止当前播放。
- 接收模式期间，不允许 B 从自己的队列发起本地播放或修改输出路由。先撤销接收模式再操作。

## 这一阶段的边界

```text
Android Control ── 已配对、加密的控制 RPC ──> A Core
                                               队列 / 解码 / DSP / SRC
                                                        │
                                              TLS · Float32 PCM
                                                        ↓
                                                B Bridge → 指定 DAC
                                                        │
                               格式 / 有界缓冲 / 驱动消耗 / 故障事实
                                                        └────> A → 各控制端
```

- **一个 Zone、一套 Core 队列**，输出为 `local` 或 `bridge`。没有新增第二个播放会话；多 Zone 独立队列、同步组和接力留待第二阶段。
- **立体声 PCM，44.1–192 kHz。** 可请求 44.1、48、88.2、96、176.4、192 kHz，以 B 驱动实际协商结果为准。一个连接维持该速率，音源不同速率在 A 重采样。网络为 Float32 little-endian，B 后端再转换到驱动格式。
- **B 不重复做 DSP。** A 从现有渲染流水线 DSP 后拉取 PCM，B 的接收器直接使用输出后端，不走 B 的解码器或 DSP 图。
- **DSD 经 A 解码成 PCM。** 网络不承载 DoP、Native DSD 或 PCM→DSD。已有本机 DSD 路由／升频配置不会把网络输出偷偷转到 A 的硬件。
- **DAC 驱动消耗决定补充节奏。** B 通常保持约 100 ms 网络缓冲；较大的驱动回调会提高启动门槛及补充目标。环形缓冲上限 250 ms，单包最多 2048 帧，超出容量的驱动缓冲配置会被拒绝。该值不是端到端延迟测量。
- `consumedFrames` 是驱动 render 回调从 Bridge 环形缓冲取走的帧数，不是独立硬件时钟测量。信号链仅显示可观测事实，DAC 内部处理为未知，不显示凭空推定的 bit-perfect 状态。
- ALSA 接收仅接受明确的 `hw:`／`plughw:` 设备（可带 `alsa:` 前缀），排除会跟随系统默认设备的命名混音出口。
- 原有桌面本地播放、手机离线播放和「取电脑文件、手机独立解码／DSP」继续使用原入口。手机音频面板的修改只发给当前播放控制目标，不修改手机 DSP。

## 授权与旧音频隔离

B 默认不监听。开启接收时复用桌面已有 TLS 身份，生成 24 字节随机邀请令牌；A 核验证书 SHA-256 指纹后才发送令牌。当前只允许一个接收连接，有握手／空闲超时及连接、消息、缓冲预算。

邀请令牌只在内存保留，不写入配置或诊断参数。持久化文件 `bridge-output-selection.json` 只记录是否选中过 Bridge，服务重启不会因此自动退回本机设备。

Pause、Seek、Stop 和显式切曲发送 flush，接收端关闭旧驱动会话并清空旧缓冲；运行代次、原生代次和 credit ID 隔离晚到数据。自然 EOF 则排空尾音，不按 Stop 丢弃。设备失效关闭接收流，不自动选择替代设备。

远程 DSP 接口只允许有限处理设置和已存在的场景；不接收文件路径、插件状态或任意 DSP 图。场景应用及恢复自动场景都明确征求可能的 DSD→PCM 许可。

## 验证与当前缺口

### 已取得的主机证据

- Windows 原生 addon、Bridge receiver 单元目标构建成功；测试覆盖协商格式、样本精确的 DSP 旁路、短尾音、欠载、溢出、非有限样本、设备失效、重置和大驱动启动缓冲。
- 真实原生解码／DSP 拉取测试通过：44.1→48 kHz，−6 dB 前级、Pause／Seek／Stop 代次及本地 DSD 配置隔离。
- **生产构建的音频服务通过已有 Node IPC 适配器运行，真实原生解码／DSP → 实际 TLS → 模拟 DAC**：−6 dB 接收 RMS 比值 **0.5012**；PCM 不穿过 Core 命令 RPC，撤销后保持 Bridge 选中并拒绝播放。
- Core 输出／DSP、远程加密授权、协议及 Bridge 测试通过；凭据不进诊断、驱动／TLS 生命周期使用慢操作截止时间另有回归测试。
- 2026-11-03 修复输出意图文件损坏时错误回到本机的问题：校验版本与布尔值，读取失败时保守隔离，保留原记录直至明确选择。相关持久化、TLS 与隔离回归 **14 通过、0 失败**；Node 类型检查通过。
- **本机原入口的真实 Electron utility Core／数据库私有 MessagePort 联调通过**，包括新增的 `zones.state`、`audio.signalPath` 和停止状态下本机输出选择，以及原有崩溃恢复与服务退出检查。修复后直接运行 `node --test scripts/core-headless.test.cjs`，**1 通过、0 失败，约 9.52 秒**，没有临时运行时路径覆盖、关闭沙箱、创建窗口或打开音频设备。测试夹具分别检查正常试听关闭和 Core 崩溃后各一次的停音通知，不再把两次不同会话的关闭累计误算为一次。
- **原开发入口已恢复。** 经用户授权，仅将 `node_modules/electron/dist/electron.exe` 的完整性标签从 Low 设为 Medium；进程实测为 `S-1-16-8192`，原先失败的窗口站 API 成功，`--version` 正常输出 `v43.8.1`。文件所有者、组、DACL 和父目录标签读回未变；原标签及独立恢复脚本已备份。原因与恢复路径见 [诊断记录](D:/Project/Twilight_Echo/docs/evidence/electron-startup-2026-11-03.md)。
- `tsconfig.node.json` 与 `tsconfig.web.json` 在 `--composite false` 下通过；portable `tsconfig.core.json` 通过；`electron-vite build` 成功。普通 composite 检查存在原有跨项目测试导入 TS6307，未改写这些测试来迁就构建。
- Android `:core-client:test :app:assembleDebug` 成功，包含共享原生库编译。客户端测试覆盖目标与 revision、目标切换隔离、未知结果不重试、不回退到手机 Core。
- 已在浏览器检查真实 Vue 组件的深／浅色和窄／宽布局，以及断线、重连、本地选择、启用／撤销接收、邀请输入和信号链展开。使用的是隔离模拟 Core，不等于实际双机验证。

### 仍未通过或未执行

1. 此前较广回归的 **222 通过、1 失败**中，退避测试期待「音频服务不可用」，实际返回 `Audio engine is restarting`。第二阶段已让断言匹配现有 restarting 分支，未改生产错误文案或退避行为；当前相关主机回归通过，见第二阶段记录。
2. 用户后置的双机 Wi-Fi／DAC 验收未执行：连续切曲与 Seek、断网重连、撤销、USB 拔出和驱动恢复、跨端队列／进度一致性、长时间欠载与听感。Android 新面板已编译，但未在手机／模拟器检查实际渲染与触控。

这份交付达到第一阶段代码、构建和原入口的真实 Electron 主机联调层面；后置实机结果仍是端到端使用验收的依赖。

### 本机原入口与依赖重装

当前原入口已经修复，不需要临时运行时覆盖。窗口站权限、工作区其余权限、Windhawk 和 Electron 沙箱未改动。重装依赖后新文件可能再次继承工作区的 Low 标签，需在该次安装时复查；不要递归修改整个工作区的安全标签。

复现已通过的原入口检查（使用临时配置，不打开音频设备）：

```powershell
cd D:\Project\Twilight_Echo
node --test scripts/core-headless.test.cjs
```

预期通过 `real utility Core and database communicate over private MessagePorts without a BrowserWindow`。该测试现已包含 `zones.state`、`audio.signalPath` 和停止状态下选择本机输出的真实 Core／音频服务调用。

## 构建产物与复现入口

- Android APK：[D:/Project/Twilight_Echo_Android/app/build/outputs/apk/debug/app-debug.apk](D:/Project/Twilight_Echo_Android/app/build/outputs/apk/debug/app-debug.apk)。未安装到设备。
- 桌面开发构建：[D:/Project/Twilight_Echo/out](D:/Project/Twilight_Echo/out)，配套原生文件已暂存至 [D:/Project/Twilight_Echo/resources/audio-engine](D:/Project/Twilight_Echo/resources/audio-engine)。未生成安装包、提交或发布。
- 真实 PCM 联调：[D:/Project/Twilight_Echo/scripts/audio-bridge-native.test.cjs](D:/Project/Twilight_Echo/scripts/audio-bridge-native.test.cjs)。在桌面仓库运行：

```powershell
node --experimental-strip-types --test `
  --import ./scripts/register-renderer-aliases.mjs `
  scripts/audio-bridge-native.test.cjs
```

- 隔离 UI 检查：[D:/Project/Twilight_Echo/scripts/bridge-ui-preview.mjs](D:/Project/Twilight_Echo/scripts/bridge-ui-preview.mjs)。运行 `node scripts/bridge-ui-preview.mjs` 后打开 `http://127.0.0.1:5187/bridge-preview`，只有测试数据和模拟状态，无设备输出。
- 先前 Roon 公开资料与实施前差距：[D:/Project/Twilight_Echo_Android/ROON_GAP_ASSESSMENT_2026-11-02.md](D:/Project/Twilight_Echo_Android/ROON_GAP_ASSESSMENT_2026-11-02.md)。
