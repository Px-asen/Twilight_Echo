# 同步组无缝切曲

把两个已连接的双声道 PCM 声区编成同步组后，照常从组队列播放。所有成员都预加载了同一下一项时，切曲保持原有 TLS、DAC 起播时间线和时钟修正，不再逐曲停止、重新缓冲和起播。

## 同一队列，只推进一次

- Core 会话仍是唯一 SQL 队列、来源解析和游标所有者。每个成员只收到当前项与已确定的下一项，使用不自行循环的原生队列。
- 下一项必须在所有成员都完成准备后共同确认。重复文件按 occurrence 区分；单曲循环续接同一 occurrence，并逐次计数自然边界。
- 原生捕获同时记录连续输出帧、曲内位置与准确切曲帧。预加载领先于 DAC，手机曲目、SQL 游标、听歌统计和睡眠边界要等共同可听时间线到达边界才更新。
- 热编辑对每个成员执行 CAS；部分提交、结果未知、未经确认的推进或切曲边界不同，都暂停全组，不留下不同队列继续播放。

## DSP 不在每首歌重新冷启动

每个成员保留自己的 DSP、音量比例和延迟补偿。常规无缝切曲继续使用正在工作的滤波器、卷积和插件实例，保留历史与尾音；采用下一项预先计算的 ReplayGain，顺序仍在卷积及后续非线性处理之前。

起播先完成来源格式对应的 DSP 确认，再放行第一帧网络 PCM。这样既不会把旧场景的预缓冲送到 DAC，也不会在缓冲已满、尚未 arm 时等待一个只能靠 render 产生的 DSP 确认。

组接管期间，成员的本地 AutoMix 协调器挂起，本地 crossfade 不独立执行；解除编组后恢复协调器，用户保存的 gapless／crossfade／AutoMix 偏好不变。

## 没准备好时，明确重新起播

来源未及时准备、精确时间线不可用、剩余准备时间不足或相邻格式不能连续处理时，不把重新缓冲称为无缝：先等所有 DAC 呈现完尾部，再按原流程共同准备下一项。Seek、DSP 延迟变化和需要校正的持续偏差，仍撤销旧时间线并共同重缓冲。掉线后保持暂停，须明确重连及继续。

同步组仍限 1 倍速、双声道 adaptive PCM。原生 DSD／DoP 和多声道使用[独立声区](audio-bridge-formats.md)。

## 在桌面和手机开启组 AutoMix

打开「声区」并选择同步组，在 AutoMix 中选择「自然」或「DJ」；「关闭」使用普通衔接。更改会暂停全组，保存完成后按播放继续。每组单独保存模式，旧组默认为关闭；重启只恢复队列、位置和模式，不打开解码器、不准备混音，也不自动发声。成员独立播放时保存的 AutoMix 偏好不变。

模式设置使用当前组 revision 与 `settings:write` 权限。遇到其他控制端已更改、断线或未知结果时，两端读取最新状态，不自动重放设置。慢保存不阻塞即时暂停／停止；迟到的成功保存也不恢复音频。保存失败尝试恢复旧模式并保持暂停。成员或 Core 不具备完整能力时不能开启，仍可关闭；恢复会话需要更新或重连。

整包迁移分别保留组模式与成员独立播放的 AutoMix／分离策略、计算设备偏好和缓存额度；旧迁移包缺少组模式时恢复为关闭。预览、导入、备份恢复和升级回退都不自动播放，不携带模型包、设备授权或缓存路径。迁移回归见 `.group-settings-migration-regression.log`、真实包内 Core 的六会话恢复见 `.group-settings-migration-package.log`，升级／回退见 `.group-settings-upgrade-final.log`。

### 全组共同准备与提交

Core 只执行一次策略选择，再将同一来源／occurrence／CUE 范围和帧方案绑定到每个成员自己的采样率。selection ID 与 preparation ID 都由各原生实例分别签发；Core 等所有成员 ready、复核 ID 和剩余准备时间后，才共同提交。普通 gapless 不会在决策期间抢先推进。部分提交、回执未知或撤销未确认会停音全组，不留下不同方案继续播放。

每组使用一个现有 Core AutoMix 协调器，复用来源身份、模型分析、边界缓存和来源资源租约；同一内容窗口不按输出成员重复分析。准备预算按所有成员中领先最多的捕获位置和 DSP 延迟计算，歌词／进度仍使用共同可听位置。单曲循环会为每次切换创建新事务，继续复用验证过的分析结果。

组选择预留两秒准备时间，协调器提交前保留一秒，原生提交再逐成员确认至少半秒余量；不把同一捕获时钟余量重复扣除。短曲循环在第二次准备加入 100 ms IPC 延迟后仍能完成共同混音。本地独立播放保留原两秒提交保护。

可选 stems 按各成员的原生采样率分别导出，保留自己的 selection ID、帧起点和临时目录，沿用已有 worker、缓存和材料校验。只在所有成员的原生准备都确认增强后，才报告组增强已启用；材料准备不完整时全组使用基础方案，不混用增强与未增强音轨。原生准备已完成或任务被撤销后，回收本次导出的目录。Pause／Seek 撤销旧任务，旧分析或绑定的迟到结果不能再提交。

成员 DSP 延迟不同，混音包络按各自延迟对齐；Core 的曲内位置使用共同策略的 80% 保持／20% 回到 1 倍速的来源映射。曲目与 SQL 仍只在每个成员的准确 promotion 帧都得到确认、共同可听时间到达后推进。原生回收已完成方案的诊断不单独作为完成证据。

短音源 EOF 后会向 DSP 继续输入零，排出卷积延迟／尾音和 limiter 固定延迟；这些零输入不推进音源位置。incoming EOF 落在 AutoMix 延迟排空内时也能完成一次推进，不滞留在混音状态。确认的普通 gapless 直接接续下一音源，不在两曲之间插入这段排空。图状态 `totalTailFrames` 与节点 `tailFrames` 包含固定延迟；VST 的无限尾音声明保留在状态中，终曲仅排出已知有限延迟，不把无限值当作数十小时的有限音频渲染。

共同分析、逐成员材料与短 EOF 路径已通过 Core／原生开发回归。两个独立音频服务通过生产 TLS 自动完成两次循环切换，复用同一内容分析且不重新 arm；48／44.1 kHz 的两个原生进程验证独立导出、票据、增强准备、共同推进和目录回收，分离 worker 的输出受控。未安装或执行额外 Demucs 模型包；可选增强沿用已有模型环境和能力探测。

## 开发证据与交付

- 原生样本回归：准确 PCM 边界、重复 occurrence、Seek 代际、卷积历史、ReplayGain／卷积顺序与起播 DSP 确认。见 `.sync-gapless-native-timeline-final.log`。
- Core／SQL／TLS 回归：共同窗口、循环、CUE 游标、热 CAS、停音、隐私和起播媒体门控。见 `.sync-gapless-core-regression-final.log`、`.sync-gapless-manager-lease.log`。
- 生产路径：两个独立原生解码进程、生产 TLS 和真实 SQLite 的重复 occurrence 切曲，不增加 arm 次数或改变流代际；逐成员 −6／0 dB DSP 输出比为 0.5012。DAC 时钟与接收边界受控，见 `.sync-gapless-production-tls-final.log`。
- 自动 AutoMix：共同协调器／材料错误回归见 `.group-automix-coordinator-regression-final.log`；异采样率原生材料联调见 `.group-automix-coordinator-native-final.log`；真实 Core／SQLite／TLS 的自动循环见 `.group-automix-coordinator-repeat-tls.log`。
- 组设置：`.group-automix-settings-core-final.log` 覆盖权限、负载、revision、暂停恢复、保存失败、部分原生失败、慢保存期间的即时停音与本地／组准备余量；`.group-automix-settings-packaged-groups.log` 使用归档原生服务和真实 Registry 设置，验证双原生服务／TLS 自动过渡及延迟的第二次准备。桌面深浅色与键盘操作、Android 组详情的选中／禁用／失败核对均有界面检查。

交付包：[Windows x64 桌面／Bridge ZIP](D:/Project/Twilight_Echo/dist/TwilightEcho-2.0.0-win32-x64-network-bridge-20261105-r2.zip)、[Windows x64 Server ZIP](D:/Project/Twilight_Echo/dist/TwilightEchoServer-2.0.0-win32-x64-network-formats-automix-20261105-r4.zip)、[Android Debug APK](D:/Project/Twilight_Echo_Android/app/build/outputs/apk/debug/app-debug.apk)。包含网络原生 DSD／DoP／多声道、普通无缝切曲、组 AutoMix、短 EOF 排空及迁移模式保留修复；旧 network-formats r3 Server 包保留回退。

桌面 ZIP 解压到新目录后，先正常退出旧桌面应用，再运行其中的 `TwilightEcho.exe`。它沿用现有桌面用户数据，不是独立便携 Profile；旧安装程序不会自动更新。最终 ZIP 实际解压后的 `.network-desktop-packaged-native.log` 有 17 项通过，包含包内 Electron／原生模块、`app.asar` 内音频服务、真实 SQLite／TLS 的两次自动循环和异采样率材料准备。接收 DAC 与时钟为受控测试边界。

原生引擎仍独立暂存于 `D:/Project/Twilight_Echo/.artifacts/group-automix-resources-20261105-r2/audio-engine`，不覆盖正在使用的 DLL。桌面与 Server 新包均包含这一引擎；开发桌面入口须先正常退出旧播放器，再使用既有暂存脚本更新运行时。

双机、DAC、车机、Windows 服务账号和 Linux／NAS 部署验收仍统一后置；大曲库优化继续暂停。
