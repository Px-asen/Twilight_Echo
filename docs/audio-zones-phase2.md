# 第二阶段：多 Zone、接力与同步组的软件链路已验证

2026-11-03。沿用[第一阶段](D:/Project/Twilight_Echo/docs/audio-bridge-phase1.md)的 TLS PCM Bridge。独立 Zone、有限队列接力、同步组拓扑／持久化／两端控制已实现。真实组所有者、SQLite 与两路真实 SWR／接收呈现历史的 **30 分钟模拟时间**联调通过；真实解码服务／TLS 也验证了同一输出重起播沿用已确认速率。第二阶段的软件主链已有无设备证据，手机 UI、双机／DAC 的实机验收继续后置到全部计划实现后。下一阶段为独立 Server／Windows Service 和完整远程控制面。

| 验收项 | 当前状态 |
|---|---|
| 多个 Zone 独立队列、播放位置、DSP、持久化、音频进程和输出故障隔离 | 主机验证通过；最多 4 个会话：原 `local` 主会话 + 3 个 Bridge 会话 |
| 复制队列／位置的会话接力，覆盖确认、取消与失败恢复 | 普通有限队列已实现，主机验证通过 |
| Bridge 设备播放时钟、网络时差与漂移观测 | WASAPI 原生接口、TLS 能力协商、桌面与 Android 展示已实现；主机验证通过 |
| 可取消的定时起播、静音预运行与媒体／设备帧映射 | 原生 WASAPI、音频服务与组引擎已接通，组播放／Seek 的双服务 TLS 联调通过 |
| 带限时钟 SRC、变速后实际提交的媒体映射与尾音呈现 | 可选内部入口已实现；原生样本测试、TLS／服务联调与两端构建通过 |
| 跟随 Core PCM 时间线的自动闭环速率校正 | 真实 SWR／提交映射的单输出 30 分钟受控验证通过；共同引擎及生产组拓扑已复用 |
| 共同会话／单一队列游标、逐输出延迟调度及组级生命周期 | 成员占用、组目录、重启暂停恢复、公开协议和桌面／Android 入口已接通；真实 SQLite、无窗口 Electron、双服务 TLS 生命周期联调通过 |
| 具有时钟估计、调度起播、持续漂移修正及长时间误差测量的同步组 | 组所有者下 30 分钟受控验证通过：稳态组间最大 0.6426 ms、p99 0.6047 ms；含强制漂移反转全程最大 1.8087 ms。物理输出和 Android 渲染验收仍后置 |

## 使用独立播放会话

### 在 Core 电脑上建立 Zone

1. 打开「设置 → 播放 → Core 与输出桥 → 独立播放会话」。原主播放栏仍控制 `local`；新建 Zone 不清空、不切换主队列。
2. 输入名称，新建 Zone。每个额外 Zone 只使用明确授权的 Bridge，不会打开本机扬声器。
3. 在接 DAC 的另一台电脑上开启输出桥，复制邀请；在对应 Zone 的「连接此 Zone 的输出桥」中粘贴并连接。一个接收端只接受一个会话连接。
4. 展开「载入曲库队列」，输入搜索条件，或留空使用整个曲库。载入后暂停；未连接 Bridge 也能建立队列，不解码、不打开设备。
5. 连接输出后播放。各 Zone 的播放控制、音量、DSP／直通／EQ 开关、前级与信号链互相独立。

主会话的输出切换与接收模式仍由原面板管理。额外 Zone 目前不提供本地 DAC 或 Cast 路由。

### 用 Android 控制现有 Zone

手机配对 **Core 电脑 A**，选择「控制电脑」，打开「电脑输出 · DSP · 信号链」：

- 选择已在桌面建立的 Zone，控制播放／暂停／停止、切曲、进度、音量及其 DSP，查看实际信号链。
- Zone 选择只改变此音频面板的控制对象；主播放页仍显示原主会话。
- Zone 新建、移除和 Bridge 邀请授权在电脑上完成，手机不能远程开启接收或注入文件路径。
- 切换到另一台 Core 或手机本地播放后，旧面板的命令与晚到响应会被目标代次隔离。

手机离线播放器、电脑文件串流到手机独立解码／DSP 的入口继续保留。

## 查看输出时钟观测

桌面展开所选 Zone 的「信号链」；Android 在电脑音频面板中查看「实际信号链 → 时钟观测」。Core 与 Bridge 均更新后，连接自动协商 `clock-v1`，无需另开开关。

- 原生 WASAPI 共享／独占后端通过 `IAudioClock::GetPosition` 获取设备流位置与关联 QPC 时间戳。只接受 `S_OK`；`S_FALSE`、获取失败或未来时间戳显示不可用，不停止原有 PCM 播放。
- `漂移已估计` 表示已有至少 8 个样本、覆盖至少 2 秒，估计相对于 **Bridge 主机单调时钟**的设备速率偏差；正数表示设备更快。它不是两个输出之间的同步误差。
- 网络往返与时差用四时间戳估计，扣除 Bridge 处理耗时；原生读取前后的单调时间将 QPC 观测映射到 Core 时钟。网络项 `uncertaintyMs` 是往返的一半；原生读取区间和 DAC 固定延迟仍需在同步调度中处理。
- 时钟样本每 250 ms 采集；设备拟合窗口最多 60 秒／512 条，网络窗口最多 5 秒／32 条。超过 1 秒未更新便标为过期，并隐藏旧漂移值。计数／时间倒退或突变时停止拟合，等待新的流或时钟 epoch。
- 暂停、停止、Seek、切曲会清除对应流观测；旧代次、重复或超时回复不能恢复旧状态。时钟探针不会延长未响应 PCM credit 的超时。
- 旧版 Bridge 和尚无时钟接口的后端继续正常单独播放，显示「未提供时钟观测」。ASIO、CoreAudio、ALSA 等后端本轮没有新增时钟能力。Android 读取的是电脑 Core 的观测，不用手机时钟代测。

三个帧计数保持分离：

| 字段 | 含义 |
|---|---|
| `consumedFrames` | 原有媒体出队计数；不含欠载补零。界面由「驱动消耗」改称「媒体出队」，数值与原合同不变。 |
| `clock.callbackRequestedFrames` | 输出回调请求的全部帧，包含补零；不是成功提交或设备播放计数。 |
| `clock.positionFrames` | 带时间戳的设备流位置，包含驱动播放的静音；不是歌曲位置，也不确认 DAC 后方的模拟输出时刻。 |

原有 WASAPI 启动预填充仍保留取出媒体再静音的行为。新的定时路径独立执行纯静音预填充，不调用媒体回调；普通播放入口不因定时功能而改变。

![时钟观测界面，模拟 Core 数据](D:/Project/Twilight_Echo/docs/evidence/bridge-clock-observation-ui.jpg)

## 定时起播底层入口已接通

编组协调器现在可以先让输出桥静音运行、取得设备时钟并缓冲 PCM，再按共同时间起播。桌面与 Android 仍只开放原有独立 Zone／接力；同步组需要下节所列的持续修正和组状态机。

### 内部调用顺序

由会话所有者先解析音源、准备队列，并冻结需要恢复的位置。以下是隔离音频服务的内部命令，不在手机可调用的公开 Core RPC 白名单内：

1. `BridgePrepareTimed()`：撤销旧流并停止 Core 的旧解码；接收端创建新流，启动纯静音输出。两端协商 `timed-start-v1`，且当前原生后端支持 clocked PCM 时才接受。没有这项能力的输出继续使用原有播放入口。
2. 执行一次 `Play(source, positionSeconds)` 或 `SelectQueueIndex(index)`，只提供媒体；不会立即发声。必须先准备队列，再调用 `BridgePrepareTimed`；之后再 `LoadQueue` 会按原合同撤销定时计划。
3. 读取 `BridgeStatus`：确认媒体已达到 `prebufferFrames`（明确 EOF 的短尾允许不足），网络时钟为 ready，且新流的设备时钟有效、年龄不超过 250 ms。源尚未开始产生 PCM 时的 idle 不会被当作 EOF。
4. `BridgeArmTimed(startAtCoreMs, mediaFrame)`：时间使用音频服务的 Node 单调毫秒，不是 `Date.now()`；准备结果中的 `coreNowMs` 可用于核对时间域。时差换算为接收端 Node 时间，再用原生读取区间映射到 QPC。Native 验证流 generation 和准备时的 clock epoch；目标需晚于接收时刻 **两倍预缓冲时长**、且不超过 2 秒，以覆盖已排队和正在填充的静音包。
5. 中止时调用 `BridgeCancelTimed()`，等待接收端关闭并 join 输出线程的确认。原有 Pause／Stop／Seek／切曲也会立即发出 flush 撤销计划；它们保持原调用合同，不额外等待此确认。

控制请求超时 1.5 秒便报告结果未知，不自动重试。未 arm 的准备状态按单调时钟最多保留 3 秒。旧 transport epoch、旧流、旧时钟 epoch、重复请求和晚到确认都不能重新激活起播。失败的 Native Play 也会撤销准备；不会降级到本机输出。

### 媒体映射由设备帧决定

新增 `IOutputBackend::startClocked()` 与 `ClockedRenderContext`。WASAPI 共享／独占后端重置新流的帧账本，将成功提交的静音预填充也计入设备帧；回调收到下一输出包的设备帧地址及关联呈现时间。它在包内填充必要的前导静音，随后才从媒体环形缓冲读取首帧。`ReleaseBuffer` 的结果通过 commit 回调确认；媒体／设备首帧映射只在提交成功后发布，提交失败立即使定时流失败。

`receiver.timedStart` 回报：

- `state`：disabled、prepared、armed、running、completed 或 failed。
- `mediaFrame`：调用方提供的当前传输片段首媒体帧标签；不是歌曲秒数。后续 DSP 延迟与歌曲位置映射仍由会话／编组所有者处理。
- `deviceStartFrame`／`deviceStartAtMs`：首次媒体样本所在的设备流帧与时钟映射时间；尚未提交首媒体包时为 null。
- `presentedMediaFrames`：原有 1:1 定时路径取设备位置减去首媒体设备帧；可选时钟 SRC 路径则查询已提交样本的源媒体坐标。两者均限制在已确认提交的媒体范围，尚无有效映射时为 null。短尾完成条件为设备越过已确认的末输出媒体帧。

定时路径发生时钟不可用／epoch 改变、设备帧不连续、错过起播包或媒体欠载时输出静音并标为 failed，要求重新准备。它不会插入静音后悄悄续播旧时间线；独占定时流也不执行旧的设备自动恢复。普通独立播放的欠载与恢复规则保持不变。

## 可选时钟 SRC 与 Core 时间线闭环

普通播放及原有 `BridgePrepareTimed()` 继续逐帧传送。新的内部调用 `BridgePrepareTimed(true)` 显式启用 `adaptive-pcm-v1`，仅对同时支持时钟、定时输出和原生转换器的新 Bridge 生效；旧接收端不会被迫更新或重采样。随后按原定时顺序供应媒体、arm，共同队列准备仍须先于 prepare。

- **实现选择：** 使用项目已经链接的 FFmpeg `libswresample` soft compensation，不引入新依赖。原内置 SoXR VR32 未启用，且其 `vr_delay()` 仍返回 TODO 常数 100，不能直接提供所需的位置事实；现有解码 SoXR 路径保持不变。
- **滤波与线程：** 强制名义同采样率也经过 `filter_size=256`、cutoff 0.96、beta 12 的 Kaiser 带限 FIR，1024 相位并插值滤波器响应。转换、内存分配和 EOF 处理只在网络／控制线程执行；DAC 回调仍做有界拷贝、补零与提交记账。
- **速率命令：** `BridgeSetTimedCorrection(ppm)` 接受 ±1000 ppm。正数为快 DAC 生成更多输出帧。请求绑定 transport epoch、接收流 generation 和 clock epoch，沿用单次确认与 1.5 秒未知结果超时；失败撤销当前定时流，不重试或回退本机。默认仍是手动模式；下节的闭环模式接管后，拒绝额外的手动速率所有者。
- **位置：** 每个已生成输出帧携带源媒体起止坐标。转换器使用实际输入累计量减公开 `swr_get_delay()` 获得精细位置，不累计请求 ppm 的理想比例。驱动确认提交后才写入两秒长的原子历史；查询设备位置时在对应输出帧内插值。已排队样本不会因后来改变速率而改写坐标；查询已被覆盖的历史返回 null，不外推旧值。
- **尾音：** EOF 在转换器输入端做明确的右侧零延伸，仅返回坐标小于真实媒体终点的输出样本，最后边界封顶到真实输入长度。没有在输出端插入滤波静音，也不把 SWR 隐含 flush 的反射样本误计为真实输入。完成判断仍等待最后输出帧实际呈现，不以源位置到达终点或软件队列为空代替。
- **流控：** 输入 credit 计入转换器尚持有的媒体与 +1000 ppm 最大扩张，保持原输出环形缓冲 250 ms 上限。若驱动启动缓冲没有给 FIR 留出空间，自适应 prepare 明确拒绝，避免等不到预缓冲门槛；旧 1:1 定时入口不受这一新限制影响。EOF 后停止索取 PCM，时钟回复继续携带完整状态；未响应 PCM credit 的原超时仍有效。

新增 `receiver.adaptive` 事实包括 `requestedPpm`、`effectivePpm`、`inputFrames`、`pendingInputFrames`、`resamplerDelayFrames`、`sourceConsumedFrames` 与 `inputCreditFrames`。`effectivePpm` 是最近生成 PCM 的实际比例，不是当前已经到 DAC 的比例。`resamplerDelayFrames` 是 SWR 回报的滤波前视与内部缓存总和，EOF 时还包含右侧延伸，不可直接当成固定 DSP／DAC 延迟。`inputFrames` 不计 EOF 延伸；`sourceConsumedFrames` 记录软件出队的源坐标，仍不等于呈现。

原 `consumedFrames` 继续统计接收 PCM 环形缓冲出队帧数；在新模式中，它属于重采样后的输出域。桌面和 Android 改用「PCM 出队」标签，并单列「Bridge 时钟 SRC」、请求／已生成 PCM 比例和媒体呈现坐标。信号链明确时钟适配会重采样，不宣称位完美；它不重复应用 Core 的用户 DSP。

![可选时钟 SRC 信号链，模拟 Core 数据](D:/Project/Twilight_Echo/docs/evidence/bridge-adaptive-src-ui.png)

### 自动跟随一条 Core PCM 时间线

在 `BridgePrepareTimed(true)` 并供应媒体之后，内部所有者调用 `BridgeArmTimed(startAtCoreMs, mediaFrame, true)` 启用闭环。省略第三参数时仍保持原有定时／手动速率合同。此底层入口不直接暴露在公开 Core RPC 中；两端编组界面使用 `groups.*` 协议，由组所有者调用它。

- 同一次时钟 pong 中的完整接收事实与其 `IAudioClock` 样本严格配对，再映射到 Core 时间；不会把较新的 PCM credit 位置与较早的时钟时间拼接。网络往返的一半加原生读取区间的一半作为控制死区的观测范围，不包含 DAC 模拟级或网络固定非对称的测量认证。
- `BridgeTimelineController` 用实际呈现的网络 PCM 源坐标与共同起播 deadline 计算相位误差。网络低 RTT 样本足以拟合 Bridge 主机／Core 速率时，将设备／主机漂移转换为设备／Core 前馈；尚在预热时保留原设备／主机前馈。UI 的 `output.driftPpm` 仍表示设备相对 Bridge 主机的漂移，含义未变。低通 PI 补偿剩余相位与 SRC 量化误差；时间常数 1.5 秒，比例时间 8 秒、积分时间乘积 320 秒²。连续闭环更新限幅 ±1000 ppm、变化不超过 40 ppm/s，没有丢帧或硬重复帧。
- 同一 peer 的重缓冲／Seek／下一曲可在自动 arm 前沿用已确认的实际速率与已学残余速率偏置，再从零媒体相位重新观测。它不携带旧 deadline、媒体位置、旧时钟 epoch 或未确认请求。普通 prepare 仍从 0 ppm 开始；非自动 arm 不应用旧估计，已确认手动速率覆盖旧估计，重新连接或闭环失败清除估计。
- 同时最多一个速率请求。等待确认期间继续接收观测，不把健康时钟误判为停止；未响应控制仍遵守原 1.5 秒超时。原生重复快照按设备时间戳和位置去重，网络时差重新估计不会把同一旧样本当成新进展。
- 观测超过 1 秒未更新、时钟／媒体 epoch 改变、位置倒退，或相位已丢失（超过 40 ms 与四倍观测范围的较大值），停止媒体并 flush，保留 Bridge 选中，记录失败原因，等待明确重新准备。Pause／Stop／Seek／切曲／断连均撤销闭环，晚到确认不能复活。
- EOF 进入 draining／completed，不再发新修正。EOF 可能先于正在传输的速率请求到达：Bridge 此时确认原速率及 ended 状态，不因不能再改变已生成 PCM 而丢弃尾音。完成仍由最后设备呈现帧决定。

`BridgeStatus.synchronization` 回报 waiting／correcting／draining／completed／failed、失败原因、媒体相位偏差、观测范围、已请求／已生成 PCM 的 ppm 与样本数。`correcting` 表示正在跟随 **网络 PCM 时间线**，不单独证明两个输出的模拟端已同步。组所有者结合逐输出 DSP／配置的下游延迟与呈现反馈管理共同进度；主播放会话的原生 position 合同不变。

## 把当前会话接力到另一处

桌面：选择源 Zone，展开「接力到另一个 Zone」。手机：在源 Zone 的音频面板中选择「接力到…」。

1. 选择目标。若目标已有队列，先确认替换；确认携带当时的源／目标队列版本和具体 occurrence，不会悄悄覆盖后来变化的队列。
2. 默认「接力并暂停」。需要继续发声时，明确选中「在目标输出继续播放」；目标 Bridge 未连接时，继续播放会被拒绝。
3. Core 先暂停源会话，再在 SQLite 事务内复制队列，保留当前重复曲目 occurrence、播放位置、播放模式、当前顺序和原始顺序；目标获得不同的队列 ID。
4. 目标暂停接管并完成持久化后，才执行可选的播放。目标保留自己的 DSP 和音量；源保留原队列并暂停。

暂停／停止可打断慢速准备，无需先等待列表或输出状态查询。即时静音只允许 Pause／Stop 跳过 transport revision，仍验证 Core epoch、Zone 身份、远程授权及手机目标代次。其他控制继续使用版本栅栏。

失败或请求结果未知时，刷新状态后再决定，不自动重试、不自动让源重新发声。若目标已暂停接管但恢复播放失败，新队列与位置保留供明确重试；不会回退到本机输出。

当前只接力普通有限队列。源处于 Cast、心动、动态推荐或直播电台时明确拒绝；不会把缺少推荐状态的截断队列冒充完整接力，也不会给直播虚构恢复位置。队列编辑撤销历史不复制，两个 Zone 后续选曲、重排、编辑不共享游标。

## 生命周期与数据位置

- `audio-zones.json` 只记录 Zone ID／名称；Bridge 令牌不落盘。
- 每个额外 Zone 在 Core 状态目录的 `zones/<zone-id>/` 中保存独立设置、播放会话和 DSP 数据；SQL 引用 owner 为 `zone:<zone-id>:persisted`。
- 重启恢复队列与位置时全部暂停。额外 Zone 保持 Bridge 隔离，需要重新输入邀请；不会借用其他 Zone 的授权或自动播放。
- 网络／DAC 故障只停止受影响的输出，保持 Bridge 选中。若原生停止无法确认而该 Zone 引擎被销毁，明确重连会先等待旧进程退出，再从持久状态重建该 Zone；保持暂停，不自动发声。其他 Zone 保持可用。
- 「移除」停止进程并移出清单，当前保留该 Zone 的状态文件与持久 SQL 引用，不做自动清除。恢复这些状态需使用完整 Core 状态目录；现有个人数据导出的「当前播放队列与位置」仍对应原主会话，额外 Zone 尚未纳入该导出格式。
- 全局音源／缓存维护会保护所有 Zone 的已确认音源，不能只检查主会话。

新 Zone 当前完成普通队列播放、独立基础 DSP 与信号链；未把主会话的 AutoMix、动态推荐、Cast、独立听歌统计和 DSP 资产导入完整扩展到新 Zone。

## 已验证的候选

- **286 个主机测试通过，0 失败**：会话接力／取消／失败后不重播、慢输出查询后不复活旧 Play、SQL occurrence／顺序隔离、持久引用、销毁后的显式重连、监督层 Zone 容量与单进程退出、Bridge、远程 TLS／权限／路径过滤、协议及应用分发。日志：[`.zones-final-host-tests.log`](D:/Project/Twilight_Echo/.zones-final-host-tests.log)。
- **真实 Electron utility Core 联调通过**：通过生产入口创建两个 Zone，建立不同 SQL 队列与 DSP；离线播放拒绝；明确确认后复制接力；强制 Core 重启后恢复不同的队列 ID、暂停状态和各自 DSP。测试：[core-headless.test.cjs](D:/Project/Twilight_Echo/scripts/core-headless.test.cjs)，日志：[`.zones-electron-test.log`](D:/Project/Twilight_Echo/.zones-electron-test.log)。不创建 BrowserWindow，不打开音频设备。
- **两个生产音频进程 + 原生解码／DSP + 实际 TLS + 模拟 DAC 通过**：−6／0 dB 接收 RMS 比值 **0.5012**；A 的接收设备模拟失效后仍保持 Bridge 选中并拒绝播放，B 继续消耗至少 **9600 帧**；明确重连 A 后再终止正在播放的 A 音频进程，B 再继续消耗至少 **9600 帧**。测试：[audio-zones-native.test.cjs](D:/Project/Twilight_Echo/scripts/audio-zones-native.test.cjs)，日志：[`.zones-native-test.log`](D:/Project/Twilight_Echo/.zones-native-test.log)。这证明独立输出隔离，不是同步误差测量。
- Android `:core-client:test :app:assembleDebug` 通过，包含命名 Zone、接力双端版本、覆盖确认、请求不重试与切换目标隔离测试。日志：[`.zones-android-build.log`](D:/Project/Twilight_Echo_Android/.zones-android-build.log)。未安装 APK。
- Node 与 Web 类型检查通过，桌面 `electron-vite build` 通过。对应日志为 [`.zones-typecheck.log`](D:/Project/Twilight_Echo/.zones-typecheck.log)、[`.zones-web-typecheck.log`](D:/Project/Twilight_Echo/.zones-web-typecheck.log) 和 [`.zones-desktop-build.log`](D:/Project/Twilight_Echo/.zones-desktop-build.log)。
- 桌面真实 Vue 组件使用隔离模拟 Core 检查布局、EQ 状态、完整信号链、慢 Play 可停止、覆盖确认和接力后暂停反馈。该检查不驱动真实音频；Android 的设备渲染与触控仍待后置验收。

![桌面多 Zone 面板，模拟 Core 数据](D:/Project/Twilight_Echo/docs/evidence/audio-zones-phase2-ui.jpg)

构建产物：桌面 [out](D:/Project/Twilight_Echo/out)；Android [app-debug.apk](D:/Project/Twilight_Echo_Android/app/build/outputs/apk/debug/app-debug.apk)。未生成桌面安装包或发布。

### 时钟观测增量验证（2026-11-03）

- `node --run test:audio-bridge`：**13 项通过**，覆盖可选时钟合同、NTP 处理时间扣除、独立时钟原点映射、旧 Bridge 兼容、暂停／重连／重复回复隔离、PCM credit 超时、信号链和过期展示。该入口已加入 `test:no-real-device`。日志：[`.sync-clock-tests.log`](D:/Project/Twilight_Echo/.sync-clock-tests.log)。
- 四组 **30 分钟模拟时间**的 −200／−100／+100／+200 ppm 合成序列，经网络抖动和慢回复后，速率估计误差均小于 **0.1 ppm**；拟合残差小于 **0.5 帧**。这是观测算法测试，不是组间播放误差测量。
- C++ Bridge 单元测试通过：原子时钟快照并发一致性、64 帧媒体出队／128 帧回调请求／32 帧设备位置分离、错误时间戳不影响 PCM。WASAPI COM 协议测试通过：设备频率单位、QPC 100 ns 换算、`S_FALSE`／失败、epoch 与不可用时钟。均不打开设备。日志：[`.sync-native-tests.log`](D:/Project/Twilight_Echo/.sync-native-tests.log)、[`.sync-wasapi-clock-tests.log`](D:/Project/Twilight_Echo/.sync-wasapi-clock-tests.log)。
- 生产解码／DSP／TLS／音频 RPC 联调中，模拟 DAC 的 **+100 ppm** 被 Core 测为 **100.000 ppm**；−6 dB RMS 比仍为 **0.5012**。双 Zone 的 DAC 故障与音频进程崩溃隔离再次通过。日志：[`.sync-production-native.log`](D:/Project/Twilight_Echo/.sync-production-native.log)。
- 受影响的应用分发、远程服务、Zone、协议及监督层 **131 项回归通过**；真实无窗口 Electron Core 入口通过。日志：[`.sync-host-regression.log`](D:/Project/Twilight_Echo/.sync-host-regression.log)、[`.sync-electron-test.log`](D:/Project/Twilight_Echo/.sync-electron-test.log)。
- Core／Node／Web 类型检查、桌面构建和 Android `:core-client:test :app:assembleDebug` 通过；Android 新增两个时钟展示测试。桌面隔离 Vue 预览已检查正常／过期状态：过期后不显示旧 ppm。Android 设备渲染及实际 DAC 的时钟准确度仍按后置安排验收。日志：[桌面构建](D:/Project/Twilight_Echo/.sync-desktop-build.log)、[Android 构建](D:/Project/Twilight_Echo_Android/.sync-android-build.log)。

用户退出占用进程后，当前原生模块已暂存至项目 `resources/audio-engine`。无需修改 Windows 安全设置。

### 定时起播增量验证（2026-11-03）

- C++ 定时输出测试通过：准备期媒体出队为 0、包内首样本与后续样本连续、取消后的回调为静音、媒体／设备位置分离、驱动提交失败不发布首帧映射、流／clock epoch 栅栏、过近时间拒绝、迟到／欠载／无时钟失败、64 帧短尾和设备呈现完成判定。两个受控包相位的首帧量化误差均小于一个 48 kHz 帧（约 0.0208 ms）。这些测试使用受控时钟与模拟 DAC；实际双机精度仍待后置测量。日志：[`.timed-native-tests.log`](D:/Project/Twilight_Echo/.timed-native-tests.log)。
- 驱动重复提交确认与设备帧跳变的补充用例通过，都会使映射失效并要求重新准备。日志：[`.timed-native-commit-tests.log`](D:/Project/Twilight_Echo/.timed-native-commit-tests.log)。
- Bridge 主机入口 **20 项通过**：包含协商兼容、Core／接收端／原生时间域换算、arm 前媒体保持、Pause 撤销、显式取消确认、Native 失败撤销、源 generation 变化、3 秒准备租约、旧／重复控制隔离、准备请求超时不重试与晚到 ACK 隔离。日志：[`.timed-host-tests.log`](D:/Project/Twilight_Echo/.timed-host-tests.log)。
- **生产解码／DSP + 音频服务 RPC + 实际 TLS + 模拟 DAC**通过：PCM 在 arm 前保持未消费；到期前 Pause 后不会在旧时刻恢复；重新 prepare／arm 后正常消费，`BridgeCancelTimed` 返回时接收已停止。原 −6 dB RMS 比 **0.5012**、+100 ppm 观测及双 Zone 故障隔离仍通过。日志：[`.timed-production-native.log`](D:/Project/Twilight_Echo/.timed-production-native.log)。
- 音频服务、应用、远程、Zone、协议和监督层 **191 项回归通过**；新增命令使用既有 topology deadline，未触发短 RPC watchdog。既有退避测试的错误断言改为匹配当前 `restarting` 分支，生产错误文案及退避行为未变。日志：[`.timed-host-regression.log`](D:/Project/Twilight_Echo/.timed-host-regression.log)。
- 原无窗口 Electron Core 入口通过；Core／Node／Web 类型检查、桌面构建、Android 原生共享引擎及 APK 构建通过。平台 smoke／miniaudio 测试目标完成编译链接，未运行可能访问设备的测试。日志：[Electron](D:/Project/Twilight_Echo/.timed-electron-test.log)、[桌面构建](D:/Project/Twilight_Echo/.timed-desktop-build.log)、[Android 构建](D:/Project/Twilight_Echo_Android/.timed-android-build.log)、[相邻原生目标构建](D:/Project/Twilight_Echo/.timed-adjacent-native-build.log)。

### 复现关键主机联调

```powershell
cd D:\Project\Twilight_Echo
# 先生成与当前源码匹配的桌面构建
.\node_modules\.bin\electron-vite.cmd build
node --run test:audio-bridge
node --test scripts/core-headless.test.cjs
node --experimental-strip-types --test scripts/audio-bridge-native.test.cjs
node --experimental-strip-types --test scripts/audio-zones-native.test.cjs

cd D:\Project\Twilight_Echo_Android
.\gradlew.bat :core-client:test :app:assembleDebug --console=plain
```

### 时钟 SRC 增量验证（2026-11-03）

- 四个无设备原生目标通过：普通 Bridge、1:1 定时、带限 SRC 和自适应接收器。覆盖 44.1／48／96／192 kHz，−1000／−200／0／+200／+1000 ppm，1–48013 帧短尾、小输出块、比例切换、真实输入／输出计数、源媒体位置连续、并发历史覆盖、驱动失败不发布映射及输入 credit。日志：[`.adaptive-native-tests.log`](D:/Project/Twilight_Echo/.adaptive-native-tests.log)。
- 48 kHz、3 秒合成正弦、修正每 50 ms 在 ±200 ppm 之间切换时，排除首尾各 256 个源帧后，1／10／20 kHz 的样本相对真实源坐标误差 SNR 分别为 **138.39／137.00／124.77 dB**，20 kHz 增益差约 **−0.0000045 dB**；23.8 kHz 相对输入幅度衰减 **118.32 dB**。这是单级 Float32 转换器的受控数值测试，不是模拟输出测量或双机同步误差。
- Bridge 主机测试 **25 项通过**，新增可选能力、输入 credit、正负修正确认、停止撤销、原生失败隔离、EOF 后不再索取媒体但持续报告完成状态，以及两端 SRC 展示。音频服务 client **60 项通过**，新命令使用既有慢操作截止时间。日志：[主机](D:/Project/Twilight_Echo/.adaptive-host-tests.log)、[服务 client](D:/Project/Twilight_Echo/.adaptive-service-client-tests.log)。
- **生产解码／DSP + 音频服务 RPC + 实际 TLS + 模拟 DAC／SRC**验证新 prepare、±200 ppm 确认和取消；样本正确性由上述 C++ 真实 SWR 目标验证。原 −6 dB RMS 比 **0.5012**、合成 +100 ppm 观测与双 Zone 故障隔离仍通过。日志：[`.adaptive-production-native.log`](D:/Project/Twilight_Echo/.adaptive-production-native.log)。
- 原无窗口 Electron 入口、Core／Node／Web 类型检查、桌面构建、Android `:core-client:test :app:assembleDebug` 通过。桌面真实 Vue 预览已检查新增节点排版，截图使用模拟 Core；Android 渲染及音频硬件验收仍后置。产物仍为上述 `out`、`resources/audio-engine` 与未安装的 Debug APK。日志：[Electron](D:/Project/Twilight_Echo/.adaptive-electron-test.log)、[桌面](D:/Project/Twilight_Echo/.adaptive-desktop-build.log)、[Android](D:/Project/Twilight_Echo_Android/.adaptive-android-build.log)。

### 闭环增量验证（2026-11-03）

- **真实 SWR、生产 BridgeReceiver 环形缓冲、render／commit 与媒体位置历史 + 生产 TypeScript 时钟／控制器**跑过两组各 **30 分钟模拟时间**。控制对象为 DAC −200／+200 ppm、主机反向 +80／−80 ppm，网络包含不对称抖动／慢回复；100 ms PCM 缓冲延迟保留，15 分钟时强制反转 DAC 漂移。C++ 夹具逐轮用实际正弦样本核对源位置，未出现欠载。日志：[`.sync-loop-native-test.log`](D:/Project/Twilight_Echo/.sync-loop-native-test.log)，入口：[audio-bridge-sync-native.test.cjs](D:/Project/Twilight_Echo/scripts/audio-bridge-sync-native.test.cjs)。
- 上述两组在排除起始 60 秒和漂移强制反转后 120 秒的稳态区间，媒体／Core 相位绝对误差最大 **0.7878／0.8002 ms**，p99 **0.6453／0.6562 ms**；包括强制反转在内的全程最大 **2.9133／2.9126 ms**。这些是软件受控时间与真实数字样本的结果，物理输出与组间误差仍待后置验收。瞬态偏差需要组协调器的共同重缓冲策略，不能据稳态值宣称全程 1 ms 内。
- 四组 −200／−100／+100／+200 ppm 的 30 分钟控制模型也通过，额外覆盖 500 ms 排队执行延迟与 1 ppm SRC 量化；覆盖重复样本、待确认时继续观测、时钟／媒体 epoch、倒退、观测过期、相位丢失与 EOF 完成。日志：[`.sync-loop-model-tests.log`](D:/Project/Twilight_Echo/.sync-loop-model-tests.log)。
- Bridge 主机入口通过 **32 项**，包含真实 TLS 的自动速率所有权、Pause 后不恢复、持续时钟消息下缺少呈现反馈的停止、自动请求失败不重试与 EOF／速率请求竞态。日志：[`.sync-loop-host-tests.log`](D:/Project/Twilight_Echo/.sync-loop-host-tests.log)。
- 生产音频服务 RPC、原生解码／DSP 与 TLS 联调通过：第三参数启用闭环、自动生成修正、拒绝手动抢占、Pause 撤销；DAC／SRC 边界在该项中模拟，样本正确性由上述 C++ 联调覆盖。双 Zone 故障隔离继续通过。日志：[`.sync-loop-production-native.log`](D:/Project/Twilight_Echo/.sync-loop-production-native.log)。
- 原无窗口 Electron 入口、Core／Node 类型检查与桌面构建通过；本轮未改 Android 代码／原生播放实现，复用上节 APK 与兼容性证据。新增 `test:bridge-sync-native` 已加入 `test:no-real-device`，复用现有 MinGW 构建和 FFmpeg，不访问设备。日志：[Electron](D:/Project/Twilight_Echo/.sync-loop-electron-test.log)、[桌面构建](D:/Project/Twilight_Echo/.sync-loop-desktop-build.log)。

## 共同会话引擎与逐输出调度

新增 [SyncGroupEngine](D:/Project/Twilight_Echo/src/core/playback/syncGroupEngine.ts)，作为一个 `CorePlaybackSession` 的协调音频引擎使用。原 SQL 队列／来源解析／持久化所有者仍只有一个；各物理 Zone 接收当前一项、`sequential`、1 倍速的本地 native 队列，不能独立推进或重复播放。组内可维护独立 DSP 与音量比例，不把多次接力克隆当成同步。

- 组先停止所有成员，准备同一 occurrence 与位置，等全部预缓冲和时钟就绪，再逐输出 arm。任一 prepare／arm 失败均撤销全部输出，不偷偷移除失败成员，也不自动让剩余成员继续。
- 调度使用各输出实际 DSP 延迟和配置的下游延迟：`输出 PCM 起播时刻 = 共同可听时刻 − DSP 帧延迟 / 该帧域采样率 − 下游延迟`。原生 DSP 新增 `latencySampleRate`，不能用 DAC 采样率猜测 DSP 帧域。下游零值表示尚未校准 DAC 模拟级；可听时刻仍以软件模型命名，不冒充实测模拟输出。
- 为取得真实延迟，修正了原有两项状态缺口：legacy DSP 路径的卷积／limiter 延迟纳入总计；卷积 render clone 已旁路时不再将其延迟及尾长计为正在处理。新增原生用例验证旁路／恢复的总计变化和 48 kHz 延迟帧域。
- 曲终等待所有 DAC 的 `completed`，再由唯一引擎选择共同 successor／repeat。SQL 热 rebind 不改变已调度的当前媒体，Core maintainer 仍持有唯一队列游标；组的自然边界计数只推进一次。切曲会重新准备共同时间线，目前不提供组间 gapless／AutoMix 混音。
- Seek 统一撤销并重新 prepare／arm；Pause／Stop 同步撤销挂起的准备与 deadline，不被会话的慢提交 lane 卡住。新 `CorePlaybackEngine.interrupt(preparingOnly)` 仅由协调引擎提供；纯队列编辑只取消尚未完成的准备，不停止已运行媒体，原单机引擎没有新增前提。
- DSP 延迟变化、待应用 DSP 或持续 500 ms 超出观测范围 1 ms 以上的组内估计偏差，会共同暂停并从最新共同媒体位置重缓冲。掉线／闭环失败暂停全部并保留成员；需要明确重连后恢复。无法确认停音会升级为音频服务故障，不报告已静音成功。
- [zoneGroupOutput](D:/Project/Twilight_Echo/src/main/coreProcess/zoneGroupOutput.ts) 复用每 Zone 已有的受监督音频进程。新的 `AudioEngineManager.playTimedBridge()` 在 loudness／音源准备之后、真正 Play 之前 prepare，避免中途 LoadQueue 撤销定时计划；定时 Play 失败不尝试 ASIO／本地兜底或第二次普通 Play。

这些内部协调接口现已由 `CoreZoneRegistry` 的组拓扑使用。用户明确编组才会接管成员；重启恢复已有成员关系和共同队列，保持暂停，不自行连接 Bridge 或恢复播放。

### 共同会话增量验证（2026-11-03）

- **157 项主机测试通过**：共同引擎、原会话、Zone registry、输出适配与信号事实。新引擎 11 项场景覆盖同一媒体的不同 occurrence、实际 CUE 范围、共同 EOF／repeat／listLoop、真实 SQLite 单一游标、持久引用、组 Seek、DSP 延迟不同帧域、相位重缓冲、准备中 Pause、成员／arm 故障和停音未确认升级。输出／时钟在该层受控，不能据此声称完成真实组间误差测量。日志：[`.group-session-tests.log`](D:/Project/Twilight_Echo/.group-session-tests.log)。
- 定时 Play 入口测试通过：prepare 在源设置后且在 Play 前、失败仅发送一次 Play、没有输出兜底，已取消请求不 prepare。日志：[`.group-manager-entry-tests.log`](D:/Project/Twilight_Echo/.group-manager-entry-tests.log)。
- 原生 DSP 目标通过：原图／legacy 延迟域和卷积旁路延迟事实；新版 addon 已暂存至 `resources/audio-engine`。日志：[`.group-dsp-native.log`](D:/Project/Twilight_Echo/.group-dsp-native.log)。
- Core／Node／Web 类型检查、桌面构建和 Android `:core-client:test :app:assembleDebug` 通过，未安装 APK。原无窗口 Electron 入口、生产解码／DSP／TLS 联调及双独立 Zone 故障隔离继续通过；这些复用原入口，新组协调器的完整双输出服务联调仍需在拓扑接入后执行。日志：[桌面](D:/Project/Twilight_Echo/.group-engine-desktop-build.log)、[Android](D:/Project/Twilight_Echo_Android/.group-engine-android-build.log)、[Electron](D:/Project/Twilight_Echo/.group-engine-electron-test.log)、[原生／TLS](D:/Project/Twilight_Echo/.group-engine-production-native.log)。
- 扩大的 manager／service client／DSP orchestrator 回归 **298 通过、1 失败**：`native ASIO device names become labels and stale selected devices stay out of the list` 期待把失效选中设备替换为另一 ASIO ID，实际保留失效 ID。该路径没有调用本轮新增定时入口，输出路由实现本轮未改；此失败属于单机失效设备选择合同，未改断言或改变为自动换 DAC 来迁就测试。它不验证新组路径，但较广 manager 回归仍非全绿。日志：[`.group-manager-regression.log`](D:/Project/Twilight_Echo/.group-manager-regression.log)。

## 组拓扑、持久化与两端控制已接通

### 编组、控制与解除

桌面进入「设置 → 播放 → Core 与输出桥 → 同步组 → 建立同步组」。选择 2–4 个未占用的输出、采用哪份普通曲库队列，填写组名及每个成员的下游延迟。可以离线建立暂停队列；实际播放要求全部成员连接支持时钟自适应的 Bridge。下游延迟限 0–250 ms，0 表示 DAC 模拟输出尚未校准。

- 组面板提供一起播放、全部暂停／停止、共同 Seek、切曲、保留比例的组音量、成员连接状态和逐成员信号链；桌面也可按曲库搜索替换组队列并暂停。组内估计偏差与观测范围分别展示。
- Android 在「电脑输出与音频链」中建立／解除同步组。选择某个组成员后，播放控制作用于共同会话，DSP 与信号链仍针对所选物理输出；不会将旧的本地主播放接口暗中重定向到另一个会话。主播放页仍显示原主会话。
- 组创建在 SQL／宿主慢操作前就占用成员。独立 Play／Seek／队列编辑／音量和路由切换不能争抢同一引擎；任何成员的 Pause／Stop 可以立即取消创建或暂停全组，不排队等待创建结束。
- 解除编组必须确认停音并提交清单。各成员回到自己的**原独立队列并暂停**，不自动采用组队列或播放。组目录保留在状态目录中，当前界面不提供已解除组的历史恢复入口。
- `audio-sync-groups.json` 只保存组名、ID、成员 ID 与下游延迟；共同会话位于 `groups/<group-id>/`，SQLite 持久引用为 `group:<id>:persisted`。Bridge 令牌不保存。清单提交失败会保持暂停并支持明确重试；停音未确认不释放输出租约。
- 成员离线时尝试暂停其余成员；明确重连必须完成新 TLS 握手及组级停音确认，之后仍不自动播放。主输出沿用原 Bridge 面板的 peer／版本／输出名称；「重新连接」可复用已授权 peer，切回本机或开启接收模式仍需先解除编组。失效额外音频进程先退出，再重建并重新接管，组输出代理不保留旧 manager 指针。
- `groups.list/create/remove/transport/queueFromQuery/signalPath` 接入原 Core 权限。远程组请求要求配对身份和 TLS，曲目通过既有无路径投影；建立新 Bridge 授权仍限桌面。主输出原 `audio.dsp.edit` 也走组协调，避免只改一个成员后错误恢复。

### 本次增量证据（2026-11-03）

- 新拓扑专项 **10 项通过**，真实 SQLite 与持久会话覆盖组独占、原会话事件冻结、过期 occurrence 不停其他输出、创建中 Pause、清单失败、重启暂停和缺失音频 runtime 的明确重建。清单失败且关闭未确认时，重连只完成停音并要求解除，不复活已释放的共同 SQL 会话。[日志](D:/Project/Twilight_Echo/.group-topology-tests.log)。与旧会话／Zone／应用／远程回归合计的一轮 **222 项通过**；后续变更的共同引擎／拓扑／Bridge／远程／适配 **49 项通过**，新增应用权限分发测试通过。[回归](D:/Project/Twilight_Echo/.group-topology-regression.log)、[最终专项](D:/Project/Twilight_Echo/.group-topology-final-tests.log)、[应用](D:/Project/Twilight_Echo/.group-topology-application-test.log)。当时的 ASIO 陈旧断言已按下节既有合同修正。
- **真实组 owner + SQLite + 两个独立生产解码／DSP 服务 + 实际 TLS + 模拟 DAC／SRC** 联调通过共同 Play／Seek、成员失败全组停止、明确重连保持暂停及解除恢复原队列；−6／0 dB 的实际 PCM RMS 比为 **0.5012**。这些证明生产链路与生命周期，不是物理或长期组间误差测量。[入口](D:/Project/Twilight_Echo/scripts/audio-sync-groups-native.test.cjs)、[日志](D:/Project/Twilight_Echo/.group-topology-production-native.log)。`test:audio-sync-groups` 与 `test:audio-sync-groups:native` 已加入无设备检查入口，后者安排在桌面构建之后。
- 无窗口 Electron Core 验证离线编组、唯一组队列、成员占用、强制 Core 重启后组关系／队列暂停恢复、解除后两份原队列保持暂停。[日志](D:/Project/Twilight_Echo/.group-topology-electron-test.log)。
- 桌面实际 Vue 预览已操作创建、准备中暂停、共同播放状态及解除确认；修复旧 Play 的迟到错误覆盖后来 Pause 的反馈。截图来自模拟 Core：[界面证据](D:/Project/Twilight_Echo/docs/evidence/audio-sync-groups-ui.png)。
- Android `:core-client:test :app:assembleDebug` 通过；新增 3 项客户端测试验证组／物理成员分工、共同版本与 occurrence 栅栏、暂停无需预读、目标代次隔离和解除不自动播放。APK 未安装，Android 实际渲染验收后置。[构建](D:/Project/Twilight_Echo_Android/.group-topology-android-build.log)、[组客户端测试](D:/Project/Twilight_Echo_Android/.group-topology-android-client-tests.log)。

## 30 分钟组间误差与重缓冲验证

### 压力验证先发现了重缓冲不收敛

初次 120 秒探针出现 **21 次共同 prepare**，没有进入 60 秒稳定区间：每次重缓冲将校正速率清零，两个相反漂移的输出还未收敛就再次超过组偏差阈值。仅保留旧速率仍不足以解决主机时钟偏差：设备／Bridge 主机的漂移并不等于设备／Core 的漂移。[原始失败探针](D:/Project/Twilight_Echo/.group-long-probe.log)、[仅保留速率的完整反例](D:/Project/Twilight_Echo/.group-long-seed-full.log)。

修正包含两项：同一 peer 的自动重起播沿用已确认速率／残余偏置；以最近 5 秒内接近最小 RTT（不超过最小值 0.1 ms）的至少 8 个样本、至少 2 秒跨度拟合主机／Core 速率。设备时钟映射与未来 arm 使用同一仿射时间变换，UI 的主机相对漂移字段不改义。新的流仍重新建立媒体相位和呈现映射。

### 实际组所有者、SQLite 与两路真实接收器／SWR

[audio-sync-group-soak.test.cjs](D:/Project/Twilight_Echo/scripts/audio-sync-group-soak.test.cjs) 使用实际 `CoreZoneRegistry`、共同 `CorePlaybackSession` 与 `SyncGroupEngine`，驱动两个 C++ [受控 DAC 边界](D:/Project/Twilight_Echo/audio-engine/tests/bridge_group_fixture.cpp)。时间、网络交换与 DSP／下游延迟受控，SWR、PCM 环、render／commit 和两秒源呈现历史使用生产实现；夹具用实际正弦样本核对源坐标，不只比较控制器自报相位。

- 48 kHz；DAC 分别 +200／−200 ppm，Bridge 主机相对 Core 分别 −80／+80 ppm；网络含非对称抖动与慢包，校正执行额外延迟 100–200 ms，PCM 缓冲高水位在 80–140 ms 变化。
- 两路 DSP 延迟分别 480 帧／48 kHz 和 1920 帧／96 kHz，下游延迟为 0／3 ms，驱动排队模型为 10／20 ms。600 秒时第二路 DSP 增加 5 ms；900 秒时同时反转两路 DAC 漂移；1200 秒时模拟成员掉线，全组停音后明确重连并明确播放。
- 每个输出总共 **6 次 prepare**：初次、DSP 变更、漂移反转后的 3 次共同重缓冲、成员明确恢复。共同 SQL 队列保持同一 ID，没有遗漏成员或独立推进。两路各完成 **188419／188427 次**实际样本／源坐标核对，未出现欠载。

| 测量区间 | 样本数（100 ms 采样） | p50 | p99 | 最大组间误差 |
|---|---:|---:|---:|---:|
| 稳态：排除每次 arm 后 60 秒及强制漂移反转后 120 秒 | 14999 | 0.2689 ms | 0.6047 ms | **0.6426 ms** |
| 全部有效呈现采样，包括强制反转瞬态 | 17982 | 0.2646 ms | 0.9802 ms | **1.8087 ms** |

这是 **30 分钟模拟时间**的数字链路与已配置延迟模型结果；没有实测模拟输出，瞬态也没有保持在 1 ms 内。测试同时要求有效采样覆盖率与足够的稳定区间，不能通过持续静音／重缓冲来隐藏误差。完整事件与数值：[摘要 JSON](D:/Project/Twilight_Echo/docs/evidence/audio-sync-group-soak-summary.json)、[运行日志](D:/Project/Twilight_Echo/.group-long-clock-model.log)。

### 变更后的原入口与故障路径

- 时钟／控制器／真实 TLS 宿主 **32 项通过**，新增同 peer 自动 re-arm、手动覆盖、重连清除、复制速率失败不重试，以及当前／未来时间映射、主机相对字段含义验证。[日志](D:/Project/Twilight_Echo/.group-long-host-tests.log)。最后的手动确认／失败清理调整另有 **3 项专项通过**：[日志](D:/Project/Twilight_Echo/.group-long-seed-recovery-tests.log)。共同引擎／拓扑／适配 **23 项通过**：[日志](D:/Project/Twilight_Echo/.group-long-lifecycle-tests.log)。
- 原单输出两组各 30 分钟真实 SWR 联调继续通过，稳态最大 **0.4631／0.4690 ms**，p99 **0.3689／0.3703 ms**；含反转全程最大 **2.6991／2.6988 ms**。这与组间误差是不同量。[日志](D:/Project/Twilight_Echo/.group-long-single-native.log)。
- 双生产解码／DSP 服务、真实 TLS 与模拟 DAC 增加等待实际校正后再 Seek 的路径，确认新 receiver generation 的首个自动速率来自旧流已确认值；共同队列、失败停音、重连暂停及解除继续通过。[日志](D:/Project/Twilight_Echo/.group-long-production-group.log)。单输出生产解码／TLS 联调也通过。[日志](D:/Project/Twilight_Echo/.group-long-production-native.log)。该合并日志中双输出的新断言曾失败；随后修正了模拟 DAC 的 armed 阶段时间推进和“未建立呈现映射不能报 0 帧”的夹具事实，双输出最终结果以上述独立日志为准。
- 无窗口 Electron Core 的离线组恢复／解除入口继续通过；Core／Node／Web 类型检查通过。[Electron](D:/Project/Twilight_Echo/.group-long-electron-test.log)、[桌面构建](D:/Project/Twilight_Echo/.group-long-desktop-build.log)。本轮未改 Android，沿用上节 APK；Android 渲染仍后置。
- 原 ASIO 失败已查明为测试断言落后于现有双架构合同：提交 `c2b6b403` 的 router 与 `dual-architecture ASIO` 用例均保留缺席的显式 CLSID，不能把另一 CLSID 称为“同一 endpoint”。本轮仅修正陈旧测试，使用有效但不存在的 CLSID，并验证明确选择另一驱动后才改变选中值，且不自动播放；没有改生产路由或引入换 DAC 兜底。相关 **3 项通过**：[日志](D:/Project/Twilight_Echo/.group-long-asio-contract.log)。

复现新的长期检查（先编译 `twilight_bridge_group_fixture`）：

```powershell
cd D:\Project\Twilight_Echo
$env:TAE_MINGW_BUILD_DIR = 'D:\TwilightEchoDependencies\builds\audio-engine-mingw'
node --run test:audio-sync-groups:soak
```

## 下一阶段：独立 Server／Windows Service 与完整远程控制面

第三阶段现已打通独立 Node Server、真实 Core／SQLite／音频进程的私有直连、本机命令行管理与无窗口 TLS 配对，见[第三阶段记录](D:/Project/Twilight_Echo/docs/standalone-server-phase3.md)。Windows Service 生命周期、备份恢复／升级回退、完整手机资料管理和 NAS／容器交付继续实施。独立 Node 的软件入口联调已通过；Windows Service 尚未完成。

第四阶段的 WAN／ARC 类访问、离线下载、移动网络策略和 Android Auto 继续保留。硬件测量与 Android 渲染按用户安排等全部计划实现后再统一执行。同步组当前不含组间 gapless／AutoMix、动态推荐、Cast、独立听歌统计和 DSP 资产导入的全面扩展；这些边界不冒充已具备完整 Roon 功能。
