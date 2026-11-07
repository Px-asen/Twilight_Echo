/**
 * 简体中文文案目录（基准语言）。
 *
 * 迁移前就存在的文案——`PlayerBar.vue` 的 `reasonCodeLabels`、主进程抛错点的字符串
 * ——在这里**逐字保留**：现有测试对这些中文字面量有断言，而且中文是默认语言，
 * 用户不该看到任何变化。
 *
 * 新增的是每条 code 的 `explain`（样本到底发生了什么）与 `fix`（该怎么办）。
 * 原来只有一句开发者术语，用户读不出下一步动作。
 *
 * `fix` 为空字符串 = 这条不是用户能改的（硬件或驱动限制），不硬凑建议。
 */

export const ZH_CN_MESSAGES: Record<string, string> = {
  'audioRecovery.title': '音频故障排除',
  'audioRecovery.guide': '没声音、播放卡住或设备异常时，先检查系统音量和输出设备，再尝试下面的恢复操作。',
  'audioRecovery.engine.title': '先重启应用内音频引擎',
  'audioRecovery.engine.description': '仅中断 Twilight Echo 播放；保留队列、进度和声音设置，完成后手动继续播放。',
  'audioRecovery.engine.action': '重启音频引擎',
  'audioRecovery.windows.title': 'Windows 音频服务',
  'audioRecovery.windows.description': '引擎重启无效时再试。会中断其他应用的声音，并请求管理员授权。',
  'audioRecovery.windows.action': '重启 Windows 音频服务',
  'audioRecovery.windows.confirm': '重启这台电脑的 Windows 音频服务？',
  'audioRecovery.windows.impact': '这会中断浏览器、游戏、通话及其他应用的声音。请先结束通话或录音。系统将请求管理员授权；完成后需手动继续播放。',
  'audioRecovery.windows.cancelled': '已取消管理员授权，Windows 音频服务未重启。',
  'audioRecovery.windows.timeout': '等待系统服务重启超时，结果尚未确认。请检查 Windows 声音输出；仍异常时重启电脑。',
  'audioRecovery.windows.failed': 'Windows 音频服务未能完成重启。请检查管理员权限及系统声音输出；仍异常时重启电脑。',
  'audioRecovery.cancel': '取消',
  'audioRecovery.loading': '正在读取恢复状态…',
  'audioRecovery.refresh': '刷新状态',
  'audioRecovery.unavailable': '音频恢复暂不可用，请确认桌面音频核心已就绪。',
  'audioRecovery.failed': '音频恢复未完成。请查看诊断报告后重试。',
  'audioRecovery.phase.idle': '',
  'audioRecovery.phase.confirming': '等待确认：其他应用的声音也会中断。',
  'audioRecovery.phase.restarting-engine': '正在重建音频引擎并恢复输出配置…',
  'audioRecovery.phase.restarting-services': '正在重启 Windows 音频服务，请完成系统授权…',
  'audioRecovery.phase.succeeded': '恢复完成，点击播放即可继续。',
  'audioRecovery.phase.cancelled': '已取消恢复。',
  'audioRecovery.phase.failed': '恢复未完成；播放保持停止。',
  'audioRecovery.diagnostics.description': '仍有问题？导出音频诊断报告以便排查。',
  'audioRecovery.diagnostics.action': '导出音频诊断',
  'automix.phase.off': '已关闭',
  'automix.phase.preparing': '正在分析并准备下一次过渡',
  'automix.phase.ready': '过渡已就绪，将在曲尾自动混音',
  'automix.phase.mixing': '正在混音',
  'automix.phase.completed': '过渡已完成',
  'automix.phase.degraded': '本次使用常规播放',
  'automix.strategy.beat-aligned': '节拍对齐过渡',
  'automix.strategy.content-boundary': '非人声尾奏过渡（保持原速）',
  'automix.strategy.release-boundary': '尾音衰减过渡（保持原速）',
  'automix.strategy.tail-overlap': '尾奏长交接（保持原速）',
  'automix.reason.waiting': '等待新的过渡准备',
  'automix.reason.beats': '节拍不够稳定，暂不对拍',
  'automix.reason.tempo': '两曲速度差超出当前模式范围',
  'automix.reason.boundary': '未找到合适的重叠位置',
  'automix.reason.gapless': '连续专辑优先无缝播放',
  'automix.reason.transport': '当前播放处理或音频格式不支持智能过渡',
  'automix.reason.range': '音源时间范围不一致，请重新开始播放',
  'automix.reason.timeout': '准备未赶上本次过渡',
  'automix.reason.source': '音源已变化或尚未准备好',
  'automix.reason.retrying': '服务暂时忙碌，正在重试',
  'automix.reason.cache': '缓存不可用，正在使用有效分析',
  'automix.reason.decode': '音频边界解码或续播准备失败',
  'automix.reason.model': '增强模型不可用，使用基础混音',
  'automix.reason.service': '分析或音频服务暂时不可用',
  'automix.reason.unsuitable': '此歌曲组合不适合混音',
  'automix.reason.analysis': '音乐分析失败',
  'automix.stems.active': '已使用分轨增强',
  'automix.stems.cache.title': '分轨缓存容量',
  'automix.stems.cache.description': '复用已完成的分轨。按最近使用顺序清理；关闭后不保留声部缓存。',
  'automix.stems.title': '分轨增强',
  'automix.stems.description':
    '开启后使用人声和贝斯分轨辅助交接；关闭或准备未完成时使用基础 AutoMix。',
  'automix.stems.device': '分轨计算设备',
  'automix.stems.deviceDescription':
    '自动优先使用 GPU，显存不足时回退 CPU；指定 GPU 时失败会使用基础 AutoMix。已有分轨缓存可直接复用。',
  'automix.stems.deviceAuto': '自动（优先 GPU）',
  'automix.stems.checking': '正在检测分轨器和计算设备…',
  'automix.stems.missing': '未检测到分轨器。点击上方“安装分轨包”选择 ZIP，安装后可选择 GPU / CPU。',
  'automix.stems.install.button': '安装分轨包…',
  'automix.stems.resourceNotice':
    '分轨增强会使用内存处理音频；使用 GPU 时还会占用显存。占用量取决于音频和计算设备，可随时关闭分轨增强。',
  'automix.stems.install.enableAfter': '安装完成后开启分轨增强',
  'automix.stems.install.enableDescription':
    '勾选后自动选择 GPU / CPU；不勾选则在安装成功后关闭分轨增强。取消或安装失败保留当前设置。',
  'automix.stems.install.choose': '选择 ZIP 并安装',
  'automix.notice.cancel': '取消',
  'automix.djNotice.title': '开启 DJ 模式？',
  'automix.djNotice.description':
    'DJ 模式可能为了对拍和过渡，大幅跳过歌曲的开头或结尾，并让两首歌曲较长时间重叠混音。若希望保留更多歌曲内容，请选择自然模式。',
  'automix.djNotice.confirm': '确认开启 DJ',
  'automix.stems.install.pick': '选择 AutoMix 分轨包 ZIP',
  'automix.stems.install.selecting': '请选择分轨包 ZIP…',
  'automix.stems.install.checking': '正在检查分轨包和可用空间…',
  'automix.stems.install.extracting': '正在解压分轨包',
  'automix.stems.install.verifying': '正在校验文件并检测 GPU / CPU…',
  'automix.stems.install.ready': '分轨包安装完成，请选择计算设备并开启分轨增强。',
  'automix.stems.install.cancel': '取消安装',
  'automix.stems.install.cancelled': '已取消安装。',
  'automix.stems.install.error.invalid_archive':
    '安装失败：ZIP 无效或包含不支持的文件，请重新选择完整的分轨包。',
  'automix.stems.install.error.invalid_pack': '安装失败：分轨包文件不完整或模型版本不兼容。',
  'automix.stems.install.error.integrity': '安装失败：文件校验不通过，请重新获取完整的分轨包。',
  'automix.stems.install.error.disk_space':
    '安装失败：用户数据所在磁盘空间不足，请释放空间后重试。',
  'automix.stems.install.error.runtime': '安装失败：分轨运行环境检测未通过，请检查分轨包后重试。',
  'automix.stems.install.error.io':
    '安装失败：无法读取 ZIP 或写入安装目录，请检查文件和磁盘后重试。',
  'automix.stems.cpuReady': '已检测到分轨器 · CPU 可用，GPU 不可用',
  'automix.stems.gpuReady': '已检测到分轨器 · GPU / CPU 可用',
  'automix.stems.deviceUnavailable': '已保存的计算设备当前不可用，请选择可用设备。',
  'automix.stems.pack_invalid': '分轨器文件不完整或版本不兼容，请检查增强包后重新检测。',
  'automix.stems.runtime_unavailable': '分轨器运行检测失败，请检查增强包后重新检测。',
  'automix.stems.probe_timeout': '分轨器检测超时，请稍后重新检测。',
  'automix.stems.refresh': '重新检测',
  'automix.stems.off': '关闭',
  'automix.stems.auto': '自动（需要增强包）',
  'automix.reason.failed': '过渡准备失败',
  // ── 通用动作 ──────────────────────────────────────────────────────────────
  // Label/value separator. Locale-dependent: CJK uses the fullwidth form, and a
  // fullwidth colon in English copy reads as a typo, so it cannot be hardcoded
  // at the call site.
  'punct.labelSeparator': '：',
  'action.retry': '重试',
  'action.resumePlayback': '继续播放',
  'action.resumeManually': '稍后手动继续',
  'action.openFolder': '打开所在文件夹',

  // ── 语言设置 ──────────────────────────────────────────────────────────────
  'settings.language.title': '语言',
  'settings.language.description': '界面与错误提示使用的语言。',
  'settings.language.system': '跟随系统',
  'settings.language.zh-CN': '简体中文',
  'settings.language.en-US': 'English',

  // ── DSP 节点名 ────────────────────────────────────────────────────────────
  'audio.dspNode.replayGain': 'ReplayGain',
  'audio.dspNode.equalizer': '均衡器',
  'audio.dspNode.dynamicEqualizer': '动态均衡器',
  'audio.dspNode.convolver': '卷积器',
  'audio.dspNode.crossfeed': 'Crossfeed',
  'audio.dspNode.channelMatrix': '声道矩阵',
  'audio.dspNode.channelStrip': '通道条',
  'audio.dspNode.bassManagement': '低频管理',
  'audio.dspNode.gate': '噪声门',
  'audio.dspNode.compressor': '压缩器',
  'audio.dspNode.multibandCompressor': '多段压缩器',
  'audio.dspNode.stereoField': '立体声场',
  'audio.dspNode.loudnessContour': '等响曲线',
  'audio.dspNode.truePeakLimiter': '真峰限制器',
  'audio.dspNode.nativePlugin': '原生插件',
  'audio.dspNode.vst3Plugin': 'VST3 插件',
  'audio.dspNode.meter': '电平表',

  // ── 通用兜底 ──────────────────────────────────────────────────────────────
  'audio.reason.dsp_node.label': '{node} 已启用',
  'audio.reason.dsp_node.explain': 'DSP 链里的 {node} 正在改写样本，输出与源文件不再逐位相同。',
  'audio.reason.dsp_node.fix': '在 DSP 机架里停用 {node}，或改用直通模式。',
  'audio.reason.unknown.explain':
    '音频引擎报告了未收录的原因代码 {code}。这通常说明引擎版本比界面新；请导出音频诊断报告反馈。',

  // ── 播放控制 ──────────────────────────────────────────────────────────────
  'audio.reason.pause_fade_active.label': '暂停淡出',
  'audio.reason.pause_fade_active.explain':
    '暂停时声音在 200 毫秒内逐渐减弱；这段过渡会临时改变样本，继续播放后恢复原来的音量与输出状态。',
  'audio.reason.pause_fade_active.fix': '',
  'audio.reason.volume_not_unity.label': '软件音量不是 100%',
  'audio.reason.volume_not_unity.explain':
    '软件音量会逐样本乘一个小于 1 的系数，样本值因此改变。默认 70% 是为了保护听感，但 bit-perfect 要求 Unity（100%）。',
  'audio.reason.volume_not_unity.fix':
    '把软件音量设为 100%，改用功放或 DAC 上的物理音量旋钮控制响度。',

  'audio.reason.playback_rate_not_unity.label': '播放倍速不是 1.0x',
  'audio.reason.playback_rate_not_unity.explain':
    '非 1.0x 倍速走 WSOLA 保音高变速算法，会重新合成波形，与源文件不再逐位相同。',
  'audio.reason.playback_rate_not_unity.fix': '把播放倍速恢复到 1.0x。',

  // ── 处理链 ────────────────────────────────────────────────────────────────
  'audio.reason.processing_active.label': '当前处理链正在改变样本',
  'audio.reason.processing_active.explain': '有处理环节接在解码之后，样本在到达设备前被改写过。',
  'audio.reason.processing_active.fix': '在播放设置里开启直通模式，或逐项关掉不需要的处理。',

  'audio.reason.replaygain_active.label': 'ReplayGain 正在改变样本',
  'audio.reason.replaygain_active.explain':
    'ReplayGain 按标签里的增益值统一响度，这是一次逐样本乘法，样本值因此改变。',
  'audio.reason.replaygain_active.fix': '把播放设置里的音量归一化设为「关闭」。',

  'audio.reason.loudnorm_active.label': 'Loudnorm 正在改变样本（EBU R128）',
  'audio.reason.loudnorm_active.explain':
    'Loudnorm 按 EBU R128 实测响度动态施加增益，样本值因此改变。',
  'audio.reason.loudnorm_active.fix': '把播放设置里的音量归一化设为「关闭」。',

  'audio.reason.eq_active.label': 'EQ 正在改变样本',
  'audio.reason.eq_active.explain': '均衡器按频段施加增益，输出波形与源文件不同。',
  'audio.reason.eq_active.fix': '关闭均衡器，或在 DSP 机架里停用对应节点。',

  'audio.reason.convolver_active.label': 'Convolver 正在改变样本',
  'audio.reason.convolver_active.explain':
    '卷积器把脉冲响应卷进信号（房间校正、耳机校正等），输出被完全重算。',
  'audio.reason.convolver_active.fix': '在 DSP 机架里停用卷积器。',

  'audio.reason.crossfeed_active.label': 'Crossfeed 正在改变声道内容',
  'audio.reason.crossfeed_active.explain':
    'Crossfeed 把左右声道按比例互相混入，模拟音箱听感，声道内容因此改变。',
  'audio.reason.crossfeed_active.fix': '关闭 Crossfeed，或把强度调到 0。',

  'audio.reason.crossfade_active.label': 'Crossfade 正在改变播放连续性',
  'audio.reason.crossfade_active.explain':
    '淡入淡出在曲目衔接处叠加两条流并施加增益包络，衔接段的样本被改写，同时会关闭 true gapless。',
  'audio.reason.crossfade_active.fix': '把播放设置里的交叉淡入淡出时长设为 0 秒。',
  'audio.reason.automix_processing.label': 'AutoMix 正在处理歌曲过渡',
  'audio.reason.automix_processing.explain':
    'AutoMix 在歌曲过渡时调整增益、速度或混合两曲，输出样本因此改变。',
  'audio.reason.automix_processing.fix':
    '若需要原样输出，请在播放设置中关闭 AutoMix 并重新播放歌曲。',
  'audio.reason.dsd_output_mode_pcm.label': 'DSD 输出模式被设为 PCM',
  'audio.reason.dsd_output_mode_pcm.explain':
    '当前设置强制把 DSD 转成 PCM，不会尝试 Native DSD 或 DoP 直通。',
  'audio.reason.dsd_output_mode_pcm.fix':
    '把播放设置里的 DSD 输出模式改为「自动」或「Native/DoP」。',

  // ── DSP 场景与输出级 ──────────────────────────────────────────────────────
  'audio.reason.dsp_scene_requires_pcm.label': 'DSP 场景需要 PCM',
  'audio.reason.dsp_scene_requires_pcm.explain':
    '当前 DSP 场景里有节点只能处理 PCM，DSD 必须先转成 PCM 才能进链。',
  'audio.reason.dsp_scene_requires_pcm.fix':
    '在 DSP 机架里停用这些节点，或为 DSD 播放切换到一个空场景。',

  'audio.reason.output_sample_rate_locked.label': '输出采样率被锁定',
  'audio.reason.output_sample_rate_locked.explain':
    '输出级把采样率固定在 {value}，与源采样率不一致时会重采样，样本被重算。',
  'audio.reason.output_sample_rate_locked.fix': '把输出级的目标采样率改为「跟随设备」。',

  'audio.reason.output_resampler_active.label': '重采样器已启用',
  'audio.reason.output_resampler_active.explain':
    '输出级正在以 {value} 质量重采样，输出样本由插值算法重新生成。',
  'audio.reason.output_resampler_active.fix': '把重采样质量改为「native」以关闭重采样。',

  'audio.reason.output_dither_active.label': '抖动已启用',
  'audio.reason.output_dither_active.explain':
    '输出级正在施加 {value} 抖动。抖动会故意加入微量噪声以改善位深转换，样本因此改变。',
  'audio.reason.output_dither_active.fix': '把输出级的抖动设为「关闭」。',

  // ── 输出路由与设备 ────────────────────────────────────────────────────────
  'audio.reason.android_system_path.label': 'Android 系统音频输出',
  'audio.reason.android_system_path.explain':
    '音频经过 Android 系统音频通路，设备可能施加混音、重采样或音量调整，尚未验证逐位一致输出。',
  'audio.reason.android_system_path.fix': '',
  'audio.reason.shared_mixer.label': '共享输出经过系统混音器',
  'audio.reason.shared_mixer.explain':
    '共享模式下音频要先过系统混音器，由它做音量、重采样和混音，通常不可能 bit-perfect。',
  'audio.reason.shared_mixer.fix': '在播放设置里选择独占模式（WASAPI Exclusive 或 ASIO）。',

  'audio.reason.routing_not_auto.label': '声道路由不是自动',
  'audio.reason.routing_not_auto.explain':
    '声道路由被设为 {value}，样本会按矩阵重新分配到不同声道。',
  'audio.reason.routing_not_auto.fix': '把声道路由改回「自动」。',

  'audio.reason.routing_changes_semantics.label': '声道路由或通道语义发生变化',
  'audio.reason.routing_changes_semantics.explain':
    '输出链改变了声道的数量或含义（如上下混、声道重映射），输出与源的通道布局不再对应。',
  'audio.reason.routing_changes_semantics.fix': '检查 DSP 机架里的声道矩阵设置，恢复为直通布局。',

  'audio.reason.plugin_path.label': '当前设备路径包含插件或混音层',
  'audio.reason.plugin_path.explain':
    '选中的设备是一个虚拟或插件设备（如 ALSA plug、虚拟声卡），音频会被它二次处理。',
  'audio.reason.plugin_path.fix': '直接选择硬件设备（如 ALSA 的 hw: 设备），绕开插件层。',

  'audio.reason.hog_mode_failed.label': '无法获取 CoreAudio Hog Mode 独占访问',
  'audio.reason.hog_mode_failed.explain':
    '独占访问被拒绝，通常是别的程序正占用这块设备，已回落到共享模式。',
  'audio.reason.hog_mode_failed.fix': '退出其他正在播放音频的程序，然后重新选择该设备。',

  'audio.reason.sample_rate_unsupported.label': '设备不支持请求的采样率',
  'audio.reason.sample_rate_unsupported.explain':
    '设备不接受源文件的采样率，音频已被重采样到设备支持的最接近速率。',
  'audio.reason.sample_rate_unsupported.fix':
    '在设备驱动面板里确认可用采样率；部分 DAC 需要切换固件模式才能支持高速率。',

  'audio.reason.device_not_found.label': '当前后端没有找到请求设备',
  'audio.reason.device_not_found.explain':
    '记录的设备在当前后端里不存在——可能已拔出、被禁用，或驱动没加载。',
  'audio.reason.device_not_found.fix': '在播放设置里刷新设备列表并重新选择输出设备。',

  'audio.reason.format_not_supported.label': '当前设备不支持请求的输出格式',
  'audio.reason.format_not_supported.explain':
    '设备拒绝了请求的位深或采样格式，已回落到它能接受的格式。',
  'audio.reason.format_not_supported.fix': '在输出设置里换一个位深；独占模式下可用格式由驱动决定。',

  'audio.reason.pcm_converted.label': 'PCM 格式或采样率发生转换',
  'audio.reason.pcm_converted.explain':
    '源 PCM 的采样率或位深与设备实际打开的格式不一致，中间做了一次转换。',
  'audio.reason.pcm_converted.fix': '把设备格式设成与源一致，或改用能自动跟随源采样率的独占模式。',

  'audio.reason.pcm_wire_precision_reduced.label': 'ASIO 输出有效位数低于整数容器位数',
  'audio.reason.pcm_wire_precision_reduced.explain':
    '驱动使用的有效 PCM 位数少于引擎的 32 位整数容器，输出可能丢失低位数据，因此不能确认 bit-perfect。',
  'audio.reason.pcm_wire_precision_reduced.fix':
    '选择提供足够有效位数的输出通道或设备格式；可用精度由驱动决定。',

  'audio.reason.integer_passthrough_unavailable.label':
    '源格式与设备实际输出格式不一致，无法 PCM 直通',
  'audio.reason.integer_passthrough_unavailable.explain':
    '整数直通要求源与设备的采样格式逐位一致，当前两者不匹配，已走转换路径。',
  'audio.reason.integer_passthrough_unavailable.fix':
    '选择支持源位深的独占设备；24-in-32 打包的独占设备可以直通 24 位源。',

  'audio.reason.backend_not_output_perfect.label': '当前输出路径未声明 bit-perfect 能力',
  'audio.reason.backend_not_output_perfect.explain':
    '这个输出后端本身不提供逐位直通保证（例如共享模式的 WASAPI）。',
  'audio.reason.backend_not_output_perfect.fix': '切换到 WASAPI Exclusive、ASIO 或 CoreAudio Hog。',

  'audio.reason.output_not_perfect.label': '当前输出链尚未验证为直通',
  'audio.reason.output_not_perfect.explain': '尚未取得逐位直通的验证结果。',
  'audio.reason.output_not_perfect.fix': '',
  'audio.reason.output_released.label': '音频设备已释放',
  'audio.reason.output_released.explain': '播放已暂停或结束，音频设备当前未被占用。',
  'audio.reason.output_released.fix': '继续播放时将重新获取所选音频设备。',

  // ── 源文件属性 ────────────────────────────────────────────────────────────
  'audio.reason.source_lossy.label': '源文件是有损格式，不能 Source Exact',
  'audio.reason.source_lossy.explain':
    'MP3、AAC 等有损格式未保留原始样本，无法验证为 Source Exact。',
  'audio.reason.source_lossy.fix': '',

  'audio.reason.source_format_differs.label': '源格式与输出链不一致',
  'audio.reason.source_format_differs.explain': '源文件的格式参数与输出链实际使用的不同。',
  'audio.reason.source_format_differs.fix': '让输出设备跟随源采样率与位深。',

  // ── DSD 传输 ──────────────────────────────────────────────────────────────
  'audio.reason.dsd_dop.label': '当前 DSD 正在通过 DoP 载波传输',
  'audio.reason.dsd_dop.explain':
    'DoP（DSD over PCM）把 DSD 位流打包进 PCM 帧传输。DSD 数据本身保持完整，只是走了 PCM 通道。',
  'audio.reason.dsd_dop.fix': '',

  'audio.reason.dsd_processing_pcm_fallback.label': 'DSD 因处理链启用而回退到 PCM',
  'audio.reason.dsd_processing_pcm_fallback.explain':
    'DSP 处理无法直接作用于 DSD 位流，所以 DSD 先被转成 PCM 才能进处理链。',
  'audio.reason.dsd_processing_pcm_fallback.fix':
    '关闭 DSP 处理或开启直通模式，让 DSD 保持原生传输。',

  'audio.reason.dsd_volume_pcm_fallback.label': 'DSD 因软件音量不是 100% 而回退到 PCM',
  'audio.reason.dsd_volume_pcm_fallback.explain':
    '调整软件音量需要将 DSD 转为 PCM。直通模式不会修改音量，也不会取消此转换。',
  'audio.reason.dsd_volume_pcm_fallback.fix':
    '先降低功放或 DAC 的物理音量，再将软件音量设为 100%（Unity）。',

  'audio.reason.dsd_high_rate_pcm_fallback.label': 'DSD 因采样率或驱动限制回退到 PCM',
  'audio.reason.dsd_high_rate_pcm_fallback.explain':
    '这个 DSD 速率超出了设备或驱动的 Native DSD 与 DoP 承载能力，已转成 PCM。',
  'audio.reason.dsd_high_rate_pcm_fallback.fix':
    '换用支持该速率的设备，或播放较低速率的 DSD 文件（如 DSD64、DSD128）。',

  'audio.reason.dsd_downrated.label': 'DSD 已降倍率以适配输出设备',
  'audio.reason.dsd_downrated.explain':
    '源信号保持在单比特 DSD 域内，但已低通滤波、抽取并重新调制为设备支持的较低 DSD 倍率；这不是 source-exact。',
  'audio.reason.dsd_downrated.fix': '换用支持源 DSD 倍率的设备，或选择「Exact rate」拒绝转换。',

  'audio.reason.dsd_converted_to_pcm.label': 'DSD 当前已转换为 PCM 输出',
  'audio.reason.dsd_converted_to_pcm.explain': 'DSD 位流已被解调成 PCM 后输出。',
  'audio.reason.dsd_converted_to_pcm.fix':
    '把 DSD 输出模式改为「自动」，并选择支持 DSD 的独占设备。',

  'audio.reason.dsd_probe_failed.label': 'DSD 源探测失败，已回退 PCM',
  'audio.reason.dsd_probe_failed.explain':
    '引擎在播放前无法读取该 DSD 文件的流信息（容器损坏或路径不可读），原生 DSD 与 DoP 均未尝试。',
  'audio.reason.dsd_probe_failed.fix': '确认文件可被其他播放器打开；若文件正常请收集引擎日志反馈。',

  'audio.reason.dsd_backend_cannot_carry.label': '当前输出后端无法承载 DSD，已回退 PCM',
  'audio.reason.dsd_backend_cannot_carry.explain':
    '当前后端（如 WASAPI 共享模式）无法进行位精确传输，原生 DSD 与 DoP 都不可能建立。',
  'audio.reason.dsd_backend_cannot_carry.fix':
    '在音频输出设置里改用 ASIO 或 WASAPI 独占模式（并选择支持 DSD 的设备）。',

  'audio.reason.dsd_source_unsupported.label': '当前 DSD 源或模式不受支持',
  'audio.reason.dsd_source_unsupported.explain': '这个 DSD 源的容器或编码方式当前无法直接播放。',
  'audio.reason.dsd_source_unsupported.fix': '',

  'audio.reason.dop_carrier_mismatch.label': 'DoP 载波格式与目标 DSD 速率不匹配',
  'audio.reason.dop_carrier_mismatch.explain':
    'DoP 需要特定的 PCM 载波速率（DSD64 需 176.4kHz，DSD128 需 352.8kHz），当前设备打开的载波速率不符。',
  'audio.reason.dop_carrier_mismatch.fix': '在设备驱动里允许对应的载波采样率，或改用 Native DSD。',

  'audio.reason.dop_carrier_rejected.label': 'ASIO 输出格式无法承载 DoP',
  'audio.reason.dop_carrier_rejected.explain':
    'DoP 要求所有输出通道使用一致的整数格式，且至少保留 24 个有效位；驱动创建的输出缓冲不满足这些条件。',
  'audio.reason.dop_carrier_rejected.fix':
    '选择支持至少 24 个有效位的统一整数输出通道，或改用 Native DSD、PCM 输出。',

  'audio.reason.dop_passthrough_unproven.label': 'DoP 输出路径未能证明直通',
  'audio.reason.dop_passthrough_unproven.explain':
    '引擎无法确认 DoP 帧原样到达了设备。可能是正常的，只是缺少证据。',
  'audio.reason.dop_passthrough_unproven.fix': '',

  'audio.reason.dop_marker_mismatch.label': 'DoP 标记字节校验失败',
  'audio.reason.dop_marker_mismatch.explain':
    'DoP 用 0x05 与 0xFA 交替标记字节标识 DSD 帧。校验不通过说明有环节改写了这些字节，设备可能把它当噪声播放。',
  'audio.reason.dop_marker_mismatch.fix':
    '确认输出链上没有音量或混音处理；必要时改用 Native DSD 传输。',

  'audio.reason.native_dsd_runtime_unproven.label': 'Native DSD 未能证明直通',
  'audio.reason.native_dsd_runtime_unproven.explain':
    '设备声称支持 Native DSD，但引擎没能在运行时确认位流原样送达。多数情况下播放是正常的，只是缺少直通证据。',
  'audio.reason.native_dsd_runtime_unproven.fix': '',

  'audio.reason.native_dsd_typed_callback_missing.label': '驱动缺少 Native DSD 回调',
  'audio.reason.native_dsd_typed_callback_missing.explain':
    'ASIO 驱动没有提供 DSD 专用的数据回调，引擎无法按位流方式喂数据，已回落到其他传输方式。',
  'audio.reason.native_dsd_typed_callback_missing.fix':
    '更新 ASIO 驱动到支持 DSD 的版本，或改用 DoP 传输。',

  'audio.reason.native_dsd_buffer_unit_mismatch.label': '驱动的 DSD 缓冲区计数单位与引擎不一致',
  'audio.reason.native_dsd_buffer_unit_mismatch.explain':
    '实测回调节奏表明该 ASIO 驱动按 1-bit 样本而非打包字节组来计算 DSD 缓冲区大小，继续直通会越界写入。引擎已把 Native DSD 判定为不可用并如实上报。',
  'audio.reason.native_dsd_buffer_unit_mismatch.fix':
    '改用 DoP 传输，或向厂商反馈驱动缓冲区计数单位的问题（可附带引擎追踪日志）。',

  'audio.reason.sacd_iso_unsupported.label': 'SACD ISO 不含可播放的未压缩 DSD 区域',
  'audio.reason.sacd_iso_unsupported.explain':
    '这个 SACD 镜像里的音轨是 DST 压缩的，或者没有可读的 DSD 区域。',
  'audio.reason.sacd_iso_unsupported.fix': '安装支持 DST 解码并保留 DSD 的 provider 插件。',

  'audio.reason.dst_dsd_provider_unavailable.label':
    'SACD DST 需要保留 DSD 的 provider，当前不可用',
  'audio.reason.dst_dsd_provider_unavailable.explain':
    'DST 是 SACD 的无损压缩格式，解码它需要专门的 provider 插件，当前没装或没启用。',
  'audio.reason.dst_dsd_provider_unavailable.fix': '在插件页安装并启用 DST 解码 provider。',

  'audio.reason.dst_dsd_provider_failed.label': 'SACD DST 保 DSD provider 解码失败',
  'audio.reason.dst_dsd_provider_failed.explain':
    'DST provider 已就位但解码出错，可能是文件损坏或 provider 版本不匹配。',
  'audio.reason.dst_dsd_provider_failed.fix': '更新 DST provider 插件，并确认镜像文件完整。',

  // ── 引擎与驱动故障 ────────────────────────────────────────────────────────
  'audio.reason.backend_open_failure.label': '输出后端打开失败',
  'audio.reason.backend_open_failure.explain':
    '无法打开输出设备。常见原因是设备被其他程序独占、驱动未就绪，或请求的格式不被接受。',
  'audio.reason.backend_open_failure.fix':
    '退出其他占用声卡的程序，刷新设备列表后重试；必要时重启音频服务。',

  'audio.reason.backend_start_failure.label': '输出后端启动失败',
  'audio.reason.backend_start_failure.explain': '设备已打开但无法启动数据流。',
  'audio.reason.backend_start_failure.fix': '重新选择输出设备，或重启音频服务。',

  'audio.reason.buffer_failure.label': '输出缓冲失败或发生 underrun',
  'audio.reason.buffer_failure.explain':
    '音频数据没能及时填满设备缓冲（underrun），会听到爆音或卡顿。通常是缓冲区太小或系统负载过高。',
  'audio.reason.buffer_failure.fix': '调大输出缓冲区，或关闭占用 CPU 的后台程序。',

  'audio.reason.device_lost.label': '输出设备已断开，需要恢复',
  'audio.reason.device_lost.explain': '设备在播放过程中消失了——被拔出、休眠或驱动重置。',
  'audio.reason.device_lost.fix': '重新接好设备；引擎会自动尝试恢复，也可以手动重启音频服务。',

  'audio.reason.driver_restart.label': '驱动发生重启或重置',
  'audio.reason.driver_restart.explain': '音频驱动重置了自己，播放链路已重建。',
  'audio.reason.driver_restart.fix': '',

  'audio.reason.unsupported_asio_sample_type.label': 'ASIO 采样格式不受支持',
  'audio.reason.unsupported_asio_sample_type.explain':
    'ASIO 驱动报告的采样格式引擎无法处理，这块设备的这个格式暂时用不了。',
  'audio.reason.unsupported_asio_sample_type.fix':
    '在 ASIO 控制面板里换一个采样格式，或更新驱动后重试。',

  'audio.reason.dsd_mute_lock_timeout.label': 'DSD 传输锁定超时',
  'audio.reason.dsd_mute_lock_timeout.explain':
    '设备未能在有界静音窗口内确认稳定的 DoP 或 Native DSD 传输，因此引擎保持静音并停止输出，没有放行未知音频。',
  'audio.reason.dsd_mute_lock_timeout.fix':
    '适当增大 DSD 过渡超时，改用 DoP 或 PCM 回退，或重新选择输出设备。',

  'audio.reason.asio_helper_launch_failed.label': 'ASIO helper 无法启动',
  'audio.reason.asio_helper_launch_failed.explain':
    '承载 ASIO 驱动的隔离进程未能启动，因此没有开始 ASIO 播放。',
  'audio.reason.asio_helper_launch_failed.fix': '重启音频服务，或改选 WASAPI 输出设备。',

  'audio.reason.asio_helper_protocol_error.label': 'ASIO helper 协议错误',
  'audio.reason.asio_helper_protocol_error.explain':
    '音频服务收到了来自 ASIO 隔离进程的无效控制响应，因此已停止当前输出路由。',
  'audio.reason.asio_helper_protocol_error.fix': '重启音频服务，或改选 WASAPI 输出设备。',

  'audio.reason.asio_helper_control_timeout.label': 'ASIO helper 响应超时',
  'audio.reason.asio_helper_control_timeout.explain':
    'ASIO 控制操作超过了截止时间。播放已停止，不会自动重开或续播。',
  'audio.reason.asio_helper_control_timeout.fix': '重启音频服务，或改选 WASAPI 输出设备。',

  'audio.reason.asio_helper_process_exited.label': 'ASIO helper 意外退出',
  'audio.reason.asio_helper_process_exited.explain':
    '承载 ASIO 驱动的隔离进程在使用过程中退出。播放已停止，不会自动续播。',
  'audio.reason.asio_helper_process_exited.fix': '重启音频服务，或改选 WASAPI 输出设备。',

  'audio.reason.asio_helper_callback_stalled.label': 'ASIO 驱动回调已停滞',
  'audio.reason.asio_helper_callback_stalled.explain':
    'ASIO helper 不再收到驱动的渲染回调。为避免继续输出未知音频，当前路由已停止。',
  'audio.reason.asio_helper_callback_stalled.fix': '重启音频服务，或改选 WASAPI 输出设备。',

  'audio.reason.asio_helper_device_rejected.label': 'ASIO 驱动拒绝了设备或格式',
  'audio.reason.asio_helper_device_rejected.explain': '所选 ASIO 驱动未接受请求的设备配置。',
  'audio.reason.asio_helper_device_rejected.fix': '改选其他 ASIO 格式，或切换到 WASAPI 输出设备。',

  'audio.reason.asio_helper_format_restore_failed.label': 'ASIO 驱动格式恢复失败',
  'audio.reason.asio_helper_format_restore_failed.explain':
    'ASIO 操作失败后，helper 未能把驱动恢复到原来的采样率和声道格式。',
  'audio.reason.asio_helper_format_restore_failed.fix': '重启音频服务和 ASIO 驱动后再试。',

  'audio.reason.asio_helper_command_failed.label': 'ASIO helper 命令执行失败',
  'audio.reason.asio_helper_command_failed.explain':
    '承载 ASIO 驱动的隔离进程拒绝了控制命令，或未能完成该命令。',
  'audio.reason.asio_helper_command_failed.fix': '重启音频服务，或改选 WASAPI 输出设备。',

  'audio.reason.topology_rollback_failed.label': '输出链回滚失败',
  'audio.reason.topology_rollback_failed.explain':
    '切换输出配置失败后，引擎试图回退到上一个可用配置，但回退也失败了。音频链路当前处于不确定状态。',
  'audio.reason.topology_rollback_failed.fix': '重启音频服务以重建输出链路。',

  'audio.reason.visualization_inactive.label': '当前没有可视化采样数据',
  'audio.reason.visualization_inactive.explain':
    '可视化需要处理链提供采样数据。直通或独占 DSD 路径不经过分析节点，因此没有数据可画。',
  'audio.reason.visualization_inactive.fix': '',

  // ── 音频引擎错误 ──────────────────────────────────────────────────────────
  'error.audio.diagnostics_recorder_unavailable': '音频诊断记录器尚未初始化',
  'error.audio.service_fatal':
    '音频服务无法启动：{reason}。请重新构建或重装原生音频引擎后重试，音频功能当前不可用。',
  'error.audio.service_crashed': '音频服务已重启：{reason}。正在恢复音频服务，恢复后不会自动续播。',
  'error.audio.service_start_failed': '音频服务启动失败',
  'error.audio.service_still_failing': '音频服务仍无法启动',
  'error.audio.service_restarting': '正在重新启动音频服务…',
  'error.audio.service_recovered': '音频服务已恢复，播放已停止，可手动继续。',
  'error.audio.service_recovered_route_pending':
    '音频服务已恢复，但输出设备或后端未完全恢复{detail}。请重新选择输出设备后继续。',
  'error.audio.restore_detail': '（{detail}）',
  'error.audio.output_route_not_restored': '音频输出设备或后端未完全恢复',
  'error.audio.awaiting_route_confirmation': '等待结构化输出路由恢复确认',
  'error.audio.unknown_reason': '未知原因',
  'error.audio.native_unavailable': '原生音频引擎不可用',
  'error.audio.playback_target_unavailable':
    '播放地址不可用或未获授权，请检查文件位置、缓存是否已清理，或重新获取音源地址。',
  'error.audio.native_unavailable_detail': '原生音频引擎不可用：{reason}',
  'error.audio.native_fallback': '原生音频引擎不可用，已启用临时播放通道：{reason}',
  'error.audio.playback_fallback_switched':
    '播放 {title} 失败，已尝试切换到 {source} 来源：{reason}',
  'error.audio.playback_fallback_rematched': '播放 {title} 失败，已重新匹配到 {source} 来源',
  'error.audio.current_track': '当前曲目',

  // ── 引擎抛错（主进程 ipcError） ────────────────────────────────────────────
  // {detail} 是原生引擎给出的原始原因，通常是英文；没有原因时填「原生音频引擎不可用」。
  'error.audio.engine_not_initialized': '原生音频引擎尚未初始化',
  'error.audio.dsp_library_not_initialized': 'DSP 资料库尚未初始化',
  'error.audio.vst3_catalog_not_initialized': 'VST3 目录尚未初始化',
  'error.audio.dsp_asset_kind_invalid': 'DSP 资料类型无效',
  'error.audio.dsp_asset_id_invalid': 'DSP 资料标识无效',
  'error.audio.correction_profile_id_invalid': 'DSP 校正资料标识无效',
  'error.audio.correction_profile_missing': 'DSP 校正资料不存在',
  'error.audio.exclusive_unsupported': '{backend} 不支持独占模式',
  'error.audio.exclusive_switch_failed': '独占模式切换失败：{detail}',
  'error.audio.device_switch_failed': '输出设备切换失败：{detail}',
  'error.audio.output_switch_failed': '输出后端切换失败：{detail}',
  'error.audio.device_profile_failed': '设备档案应用失败：{detail}',
  'error.audio.service_restarted_during_topology': '音频服务在输出拓扑更新期间重启',
  'error.audio.service_restarted_during_ack': '音频服务在读取输出拓扑确认时重启',
  'error.audio.direct_routing_failed': '直通声道路由应用失败：{detail}',
  'error.audio.output_config_failed': '输出配置应用失败：{detail}',
  'error.audio.default_device_rebind_failed': '跟随系统默认输出设备失败：{detail}',
  'error.audio.output_target_not_ready': '目标输出设备未能保持当前播放状态',
  'error.audio.output_target_unavailable': '目标输出设备不可用：{device}',
  'error.audio.source_empty': '音频地址为空',
  'error.audio.play_failed': '播放失败：{detail}',
  'error.audio.pause_failed': '暂停或继续播放失败：{detail}',
  'error.audio.stop_failed': '停止播放失败：{detail}',
  'error.audio.queue_load_failed': '播放队列加载失败：{detail}',
  'error.audio.play_mode_sync_failed': '播放模式同步失败：{detail}',
  'error.audio.play_mode_switch_failed': '播放模式切换失败：{detail}',
  'error.audio.decode_failed': '音频读取或解码失败，请检查文件完整性或音源是否可用',

  // ── 网络错误 ──────────────────────────────────────────────────────────────
  'error.network.timeout': '网络请求超时',
  'error.network.failed': '网络连接失败，请检查网络后重试',
  'error.network.unauthorized': '登录状态已失效，请重新登录',
  'error.network.rate_limited': '请求过于频繁，请稍后再试',

  // ── 通用错误兜底 ──────────────────────────────────────────────────────────
  'error.generic.unknown': '发生未知错误',
  'error.generic.withDetail': '{action}失败：{detail}',

  'app.closePersistence.title': '退出前保存失败',
  'app.closePersistence.message': '尚未确认所有更改已保存。',
  'app.closePersistence.detail':
    '可重试保存或保留窗口。不保存退出可能丢失最近的队列、歌单或设置更改。',
  'app.closePersistence.retry': '重试退出',
  'app.closePersistence.keepOpen': '保留窗口',
  'app.closePersistence.discard': '不保存退出',
  'app.closePersistence.cleanup.title': '退出尚未完成',
  'app.closePersistence.cleanup.message': '后台服务尚未确认停止。',
  'app.closePersistence.cleanup.detail': '可重试退出或保留窗口。已选择跳过未完成的保存。',

  // ── 诊断面板 ──────────────────────────────────────────────────────────────
  'diagnostics.panel.title': '输出状态诊断',
  'diagnostics.panel.perfect': '输出链已验证为逐位直通',
  'diagnostics.panel.blockerCount': '{count} 项影响直通',
  'diagnostics.panel.noBlockers': '没有检测到影响直通的因素',
  'diagnostics.panel.underrunRateWarning': '当前缓冲不足（欠载率 {rate}%），建议增大缓冲区',
  'diagnostics.panel.showDetail': '展开原因',
  'diagnostics.panel.hideDetail': '收起原因',
  'diagnostics.panel.fixLabel': '处理建议',
  'diagnostics.panel.goToSetting': '前往设置',
  'diagnostics.severity.blocking': '阻断直通',
  'diagnostics.severity.degraded': '降级传输',
  'diagnostics.severity.info': '提示',
  'diagnostics.origin.player': '播放控制',
  'diagnostics.origin.processing': '处理链',
  'diagnostics.origin.dsp-scene': 'DSP 场景',
  'diagnostics.origin.output': '输出设备',
  'diagnostics.origin.source': '源文件',
  'diagnostics.origin.engine': '引擎或驱动',

  // ── 诊断导出 ──────────────────────────────────────────────────────────────
  'diagnostics.export.dialogTitle': '导出音频诊断日志',
  'diagnostics.export.reportTitle': 'Twilight Echo 音频诊断报告',
  'diagnostics.export.generatedAt': '生成时间',
  'diagnostics.export.conclusion': '结论',
  'diagnostics.export.conclusionPerfect': '当前输出链已验证为逐位直通（bit-perfect）。',
  'diagnostics.export.conclusionNotPerfect': '当前输出链**不是**逐位直通，共 {count} 项原因。',
  'diagnostics.export.conclusionNoPlayback': '导出时没有正在播放的音频，以下仅为配置快照。',
  'diagnostics.export.currentPlayback': '当前播放',
  'diagnostics.export.sourceFormat': '源格式',
  'diagnostics.export.actualOutput': '实际输出',
  'diagnostics.export.reasonsHeading': '原因逐条说明',
  'diagnostics.export.whatHappens': '发生了什么',
  'diagnostics.export.whatToDo': '怎么办',
  'diagnostics.export.noActionNeeded': '这一项不需要也无法由用户处理。',
  'diagnostics.export.environment': '运行环境',
  'diagnostics.export.privacyHeading': '隐私说明',
  'diagnostics.export.privacyNote':
    '本报告不含音频内容本身，也不含完整本地路径或 URL 查询参数——路径与地址只保留类型、扩展名和单向指纹。',
  'diagnostics.export.rawHeading': '原始数据（供开发者排查）',
  'diagnostics.export.eventCount': '共 {count} 条事件记录',
  'diagnostics.export.timelineHeading': '事件时间线（警告/错误 + DSD 路由决策）',
  'diagnostics.export.timelineEmpty': '时间线中没有警告或错误事件。',
  'diagnostics.export.savedNotice': '音频诊断报告已导出',
  'diagnostics.export.failed': '导出音频诊断日志失败'
}
