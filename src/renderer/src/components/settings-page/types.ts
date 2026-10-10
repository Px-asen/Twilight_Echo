import {
  DSD_OUTPUT_MODE_OPTIONS,
  DSD_RATE_POLICY_OPTIONS,
  VOLUME_NORMALIZATION_OPTIONS
} from '../../../../shared/audioProcessingOptions.ts'
import type {
  PlayerBarMode,
  PlayerBarPageMode,
  PlayerBarPageVisibility,
  PlayerBarVisibility
} from '../../../../shared/playerBar.ts'
import type { PlayerBarControlId, PlayerBarRegionName } from '../../../../shared/playerBarLayout.ts'
import type {
  AppTheme,
  AppBackgroundPage,
  ChannelRoutingMode,
  DesktopLyricsSettings,
  LyricsAppearanceAlign,
  LyricsAppearanceFontFamily,
  LyricsFocusLineCount,
  MotionPreference,
  NcmPlaybackQuality,
  PlaybackResumeMode,
  PreviousButtonAction,
  SacdProgramMode,
  StartupHomePage,
  TrackActivationMode,
  StreamingAudioCachePolicy,
  UiDensity
} from '../../types/settings'
import { DEFAULT_DESKTOP_LYRICS_SETTINGS } from '../../../../shared/desktopLyrics.ts'
import type { AppFontFamily } from '../../../../shared/appFont.ts'

export type SectionKey =
  | 'general'
  | 'appearance'
  | 'playback'
  | 'lyrics'
  | 'library'
  | 'connections'
  | 'system'
export type LegacySettingsSection =
  | 'dsp'
  | 'cache'
  | 'performance'
  | 'desktopLyrics'
  | 'shortcuts'
  | 'about'
export type SettingsSectionInput = SectionKey | LegacySettingsSection
export type SettingsResetGroup = 'appearance' | 'playback' | 'lyrics' | 'desktopLyrics'
export const LEGACY_SETTINGS_TARGETS: Record<
  LegacySettingsSection,
  { section: SectionKey; anchor: string }
> = {
  dsp: { section: 'playback', anchor: 'dsp' },
  cache: { section: 'library', anchor: 'cache' },
  performance: { section: 'system', anchor: 'setting-hardware-acceleration' },
  desktopLyrics: { section: 'lyrics', anchor: 'desktopLyrics' },
  shortcuts: { section: 'connections', anchor: 'shortcuts' },
  about: { section: 'system', anchor: 'about' }
}
export function normalizeSettingsSection(value: unknown): SectionKey {
  if (typeof value !== 'string') return 'general'
  if (Object.hasOwn(LEGACY_SETTINGS_TARGETS, value))
    return LEGACY_SETTINGS_TARGETS[value as LegacySettingsSection].section
  return sections.some((section) => section.key === value) ? (value as SectionKey) : 'general'
}

export type BooleanSettingKey =
  | 'autoCheckLogin'
  | 'launchAtLogin'
  | 'hardwareAcceleration'
  | 'proxyAllowDirectFallback'
  | 'windowTransparency'
  | 'useCoverTheme'
  | 'globalShortcuts'
  | 'watchLibrary'
  | 'onlineLyricsFallback'
  | 'smtcEnabled'
  | 'taskbarThumbarButtonsEnabled'
  | 'discordRpcEnabled'
  | 'remoteControlEnabled'
  | 'developerMode'

export const sections: { key: SectionKey; label: string; icon: string; description: string }[] = [
  {
    key: 'general',
    label: '通用',
    icon: 'pi pi-sliders-h',
    description: '调整启动、窗口和日常操作习惯。'
  },
  {
    key: 'appearance',
    label: '外观',
    icon: 'pi pi-palette',
    description: '设置主题、背景、字体与播放器外观。'
  },
  {
    key: 'playback',
    label: '播放与音效',
    icon: 'pi pi-volume-up',
    description: '调整播放习惯、输出设备和声音处理。'
  },
  {
    key: 'lyrics',
    label: '歌词',
    icon: 'pi pi-align-left',
    description: '设置歌词来源与播放页、桌面上的显示方式。'
  },
  {
    key: 'library',
    label: '媒体库与存储',
    icon: 'pi pi-database',
    description: '管理本地媒体库、下载目录与缓存。'
  },
  {
    key: 'connections',
    label: '连接与控制',
    icon: 'pi pi-link',
    description: '配置系统集成、远程控制和快捷键。'
  },
  {
    key: 'system',
    label: '系统与关于',
    icon: 'pi pi-cog',
    description: '管理性能、插件、备份与软件更新。'
  }
]

export const colorModeOptions: { value: AppTheme; label: string; icon: string }[] = [
  { value: 'system', label: '系统', icon: 'pi pi-desktop' },
  { value: 'pureWhite', label: '浅色', icon: 'pi pi-sun' },
  { value: 'dark', label: '深色', icon: 'pi pi-moon' }
]

export const motionPreferenceOptions: { value: MotionPreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'full', label: '完整动效' },
  { value: 'reduced', label: '减少动效' },
  { value: 'off', label: '关闭动效' }
]

export const playbackResumeOptions: { value: PlaybackResumeMode; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: 'track', label: '记住曲目' },
  { value: 'trackAndPosition', label: '曲目和位置' }
]

export const previousButtonActionOptions: { value: PreviousButtonAction; label: string }[] = [
  { value: 'restart', label: '重播当前歌曲' },
  { value: 'previous', label: '切换到上一首' }
]

export const ncmPlaybackQualityOptions: { value: NcmPlaybackQuality; label: string }[] = [
  { value: 'auto', label: '自动（最高可用）' },
  { value: 'standard', label: '标准' },
  { value: 'exhigh', label: '极高' },
  { value: 'lossless', label: '无损' },
  { value: 'hires', label: 'Hi-Res' }
]

export const startupHomePageOptions: { value: StartupHomePage; label: string; icon: string }[] = [
  { value: 'local', label: '本地音乐主页', icon: 'pi pi-home' },
  { value: 'streaming', label: '流媒体主页', icon: 'pi pi-compass' }
]

export const trackActivationModeOptions: {
  value: TrackActivationMode
  label: string
  icon: string
}[] = [
  { value: 'singleClick', label: '单击播放', icon: 'pi pi-bolt' },
  { value: 'doubleClick', label: '双击播放', icon: 'pi pi-clone' }
]

export const bufferSizeOptions = [
  { value: 0, label: 'Auto' },
  { value: 64, label: '64' },
  { value: 128, label: '128' },
  { value: 256, label: '256' },
  { value: 512, label: '512' },
  { value: 1024, label: '1024' },
  { value: 2048, label: '2048' }
] as const

export const routingModeOptions: { value: ChannelRoutingMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'stereo', label: 'Stereo' },
  { value: 'stereo-to-5.1', label: 'Stereo → 5.1' },
  { value: 'stereo-to-7.1', label: 'Stereo → 7.1' },
  { value: 'mono-to-stereo', label: 'Mono → Stereo' },
  { value: 'mono-to-multichannel', label: 'Mono → Multichannel' }
]

export const pcmToDsdModeOptions: {
  value: import('../../types/settings').PcmToDsdMode
  label: string
}[] = [
  { value: 'off', label: '关闭' },
  { value: 'dsd64', label: 'DSD64' },
  { value: 'dsd128', label: 'DSD128' },
  { value: 'dsd256', label: 'DSD256' }
]

export const replayGainOptions = VOLUME_NORMALIZATION_OPTIONS
export const dsdOutputModeOptions = DSD_OUTPUT_MODE_OPTIONS
export const dsdRatePolicyOptions = DSD_RATE_POLICY_OPTIONS

export const sacdProgramModeOptions: { value: SacdProgramMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'stereo', label: 'Stereo' },
  { value: 'multichannel', label: 'Multichannel' }
]

export const fftResolutionOptions = [64, 128, 256, 512, 1024, 2048, 4096, 8192] as const

export const accentColorOptions: { value: string; label: string; class: string }[] = [
  { value: 'violet', label: '紫罗兰', class: 'violet' },
  { value: 'blue', label: '蓝', class: 'blue' },
  { value: 'emerald', label: '翠绿', class: 'emerald' },
  { value: 'rose', label: '玫瑰', class: 'rose' },
  { value: 'amber', label: '琥珀', class: 'amber' },
  { value: 'slate', label: '石板', class: 'slate' }
]

export const fontFamilyOptions: { value: AppFontFamily; label: string }[] = [
  { value: 'system', label: '默认（跟随主题）' },
  { value: 'inter', label: 'Inter / Roboto' },
  { value: 'lxgw', label: '霞鹜文楷 (LXGW)' },
  { value: 'sarasa', label: 'Sarasa Gothic' },
  { value: 'comic', label: 'Comic Sans MS' }
]

export const lyricsAppearanceFontFamilyOptions: {
  value: LyricsAppearanceFontFamily
  label: string
}[] = [
  { value: 'inherit', label: '跟随界面字体' },
  { value: 'system', label: '系统默认 (System)' },
  { value: 'inter', label: 'Inter / Roboto' },
  { value: 'lxgw', label: '霞鹜文楷 (LXGW)' },
  { value: 'sarasa', label: 'Sarasa Gothic' },
  { value: 'comic', label: 'Comic Sans MS' },
  { value: 'custom', label: '自定义字体（在播放页设置）' }
]

export const lyricsFocusLineCountOptions: { value: LyricsFocusLineCount; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 1, label: '1 行' },
  { value: 3, label: '3 行' },
  { value: 5, label: '5 行' }
]

export const uiDensityOptions: { value: UiDensity; label: string }[] = [
  { value: 'compact', label: '紧凑' },
  { value: 'standard', label: '标准' },
  { value: 'comfortable', label: '舒展' }
]

export const appBackgroundPageOptions: { value: AppBackgroundPage; label: string; desc: string }[] =
  [
    { value: 'local', label: '本地主页', desc: '本地音乐首页和资料概览背景。' },
    { value: 'settings', label: '设置与插件', desc: '设置页、插件中心等管理界面背景。' },
    { value: 'streaming', label: '流媒体页', desc: '在线音乐浏览、搜索和详情页背景。' },
    { value: 'player', label: '播放页', desc: '播放页和全屏播放背景。' }
  ]

export const lyricAlignOptions: { value: LyricsAppearanceAlign; label: string }[] = [
  { value: 'center', label: '居中对齐' },
  { value: 'left', label: '靠左对齐' },
  { value: 'right', label: '靠右对齐' }
]

export const streamingAudioCachePolicyOptions: {
  value: StreamingAudioCachePolicy
  label: string
}[] = [
  { value: 'provider', label: '由 Provider 规则控制' },
  { value: 'off', label: '不缓存流媒体音频' }
]

export const playerBarModeOptions: { value: PlayerBarMode; label: string; icon: string }[] = [
  { value: 'standard', label: '标准', icon: 'pi pi-window-maximize' },
  { value: 'mini', label: '迷你', icon: 'pi pi-window-minimize' },
  { value: 'compact', label: '紧凑', icon: 'pi pi-minus' }
]

export const playerBarPageModeOptions: { value: PlayerBarPageMode; label: string }[] = [
  { value: 'inherit', label: '跟随全局形态' },
  { value: 'standard', label: '标准' },
  { value: 'mini', label: '迷你（可自动隐藏）' },
  { value: 'compact', label: '紧凑（可自动隐藏）' }
]

/**
 * Labels for the controls the playbar layout can place. Lives here rather than in
 * the shared contract for the same reason the mode options do: `src/shared` holds
 * the structure, the renderer holds the copy.
 */
export const playerBarControlOptions: {
  value: PlayerBarControlId
  label: string
  icon: string
  /** Why this control may render nothing even when it is placed. */
  hint?: string
}[] = [
  { value: 'cover', label: '封面', icon: 'pi pi-image' },
  { value: 'trackInfo', label: '曲目信息', icon: 'pi pi-align-left' },
  { value: 'transport', label: '上一首 / 播放 / 下一首', icon: 'pi pi-play-circle' },
  { value: 'playPause', label: '单独的播放按钮', icon: 'pi pi-play' },
  { value: 'time', label: '时间读数', icon: 'pi pi-clock' },
  {
    value: 'favorite',
    label: '收藏',
    icon: 'pi pi-heart',
    hint: '仅在当前来源支持收藏时出现'
  },
  { value: 'playMode', label: '播放顺序', icon: 'pi pi-refresh' },
  { value: 'volume', label: '音量', icon: 'pi pi-volume-up' },
  { value: 'queue', label: '播放列表', icon: 'pi pi-list' },
  { value: 'hifi', label: 'HiFi 控制台', icon: 'ph ph-faders' },
  { value: 'equalizer', label: '均衡器', icon: 'ph ph-sliders' },
  { value: 'desktopLyrics', label: '桌面歌词', icon: 'pi pi-window-maximize' },
  { value: 'miniPlayer', label: '迷你播放器', icon: 'ph ph-picture-in-picture' },
  {
    value: 'exitPlayingPage',
    label: '退出播放页',
    icon: 'ph ph-arrows-out-simple',
    hint: '仅在播放页出现'
  }
]

export const playerBarRegionOptions: { value: PlayerBarRegionName; label: string }[] = [
  { value: 'left', label: '左侧' },
  { value: 'center', label: '中间' },
  { value: 'right', label: '右侧' }
]

export const playerBarVisibilityOptions: {
  value: PlayerBarVisibility
  label: string
  icon: string
}[] = [
  { value: 'visible', label: '常显', icon: 'pi pi-eye' },
  { value: 'autoHide', label: '自动隐藏', icon: 'pi pi-arrow-down' },
  { value: 'hidden', label: '完全隐藏', icon: 'pi pi-eye-slash' }
]

export const playerBarPageVisibilityOptions: { value: PlayerBarPageVisibility; label: string }[] = [
  { value: 'inherit', label: '跟随全局可见性' },
  { value: 'visible', label: '常显' },
  { value: 'autoHide', label: '自动隐藏（需迷你或紧凑形态）' },
  { value: 'hidden', label: '完全隐藏' }
]

export { GITHUB_URL, HOMEPAGE_URL, RELEASES_URL } from '../../../../shared/projectUrls.ts'

export interface SettingsSearchEntry {
  /** Stable target, independent of translated labels. Optional for legacy callers. */
  id?: string
  disclosureId?: string
  fallbackId?: string
  fallbackReason?: string
  appearanceArea?: 'background' | 'material' | 'advanced'
  /** 所属设置分区 */
  section: SettingsSectionInput
  /** 结果展示标题（设置项名称） */
  title: string
  /** 用于在 DOM 中定位设置项文本；默认取 title */
  match?: string
  /** 搜索关键词（别名 / 英文 / 相关词，空格分隔） */
  terms: string
}

/** 设置项级细粒度搜索索引：每个设置项一条，保证任意设置项都能被搜到 */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    id: 'library-folders',
    section: 'library',
    title: '扫描文件夹',
    terms: '媒体库 下载 缓存 存储 媒体库 文件夹 目录 扫描 添加 本地 音乐 库 扫描文件夹'
  },
  {
    id: 'genre-separators',
    section: 'library',
    title: '流派分隔符',
    terms: '媒体库 下载 缓存 存储 genre separator 标签 分隔 元数据 流派分隔符',
    disclosureId: 'scan-diagnostics'
  },
  {
    id: 'watch-library',
    section: 'library',
    title: '实时监控文件夹变动',
    terms: '媒体库 下载 缓存 存储 watch 监控 文件夹 自动 同步 媒体库 监听 实时监控文件夹变动'
  },
  {
    id: 'lyrics-fallback',
    section: 'lyrics',
    title: '在线歌词回退 (LRCLIB)',
    terms: '歌词 桌面歌词 歌词 lyric 回退 provider LRCLIB 在线 搜索 在线歌词回退 (LRCLIB)'
  },
  {
    id: 'watcher-status',
    fallbackId: 'library-folders',
    section: 'library',
    title: '媒体库监控状态',
    terms: '媒体库 下载 缓存 存储 watcher 状态 监控 监听 文件夹 降级 媒体库监控状态',
    disclosureId: 'scan-diagnostics'
  },
  {
    id: 'library-rescan',
    section: 'library',
    title: '完整重扫',
    terms: '媒体库 下载 缓存 存储 rescan 重扫 扫描 元数据 封面 刷新 媒体库 完整重扫',
    disclosureId: 'scan-diagnostics'
  },
  {
    id: 'check-login',
    section: 'connections',
    title: '启动时检查网易云登录',
    terms: '连接 控制 快捷键 集成 网络 代理 网易云 ncm 登录 检查 启动 账号 启动时检查网易云登录'
  },
  {
    id: 'system-media',
    section: 'connections',
    title: '原生媒体控制 (SMTC)',
    terms:
      '连接 控制 快捷键 集成 网络 代理 smtc 媒体控制 系统 媒体键 集成 windows 原生媒体控制 (SMTC)'
  },
  {
    id: 'taskbar-controls',
    section: 'connections',
    title: '任务栏缩略图按钮',
    terms:
      '连接 控制 快捷键 集成 网络 代理 任务栏 taskbar 缩略图 thumbar 上一首 播放 暂停 下一首 windows 任务栏缩略图按钮'
  },
  {
    id: 'discord',
    section: 'connections',
    title: 'Discord Rich Presence',
    terms: '连接 控制 快捷键 集成 网络 代理 discord 状态 展示 集成 社交 游戏 Discord Rich Presence'
  },
  {
    id: 'remote-control',
    section: 'connections',
    title: '局域网远程控制',
    terms: '连接 控制 快捷键 集成 网络 代理 远程 遥控 局域网 手机 控制 投送 DLNA 局域网远程控制'
  },
  {
    id: 'remote-pairing',
    section: 'connections',
    title: '配对 PIN / 访问地址',
    terms: '连接 控制 快捷键 集成 网络 代理 pin 配对 访问 地址 远程 安全 配对 PIN / 访问地址',
    fallbackId: 'remote-control'
  },
  {
    id: 'track-activation',
    section: 'general',
    title: '歌曲列表播放方式',
    terms: '通用 常规 语言 启动 窗口 操作 单击 双击 播放 列表 操作 习惯 激活 歌曲列表播放方式'
  },
  {
    id: 'startup-home',
    section: 'general',
    title: '启动后进入',
    terms: '通用 常规 语言 启动 窗口 操作 startup 主页 首页 启动 进入 本地 流媒体 启动后进入'
  },
  {
    id: 'launch-at-login',
    section: 'general',
    title: '开机自动启动',
    terms: '通用 常规 语言 启动 窗口 操作 开机 启动 自启 登录 自动启动 launch at login 开机自动启动'
  },
  {
    id: 'close-window',
    section: 'general',
    title: '关闭主窗口时',
    terms:
      '通用 常规 语言 启动 窗口 操作 关闭 主窗口 最小化 托盘 退出 行为 窗口 迷你播放器 关闭主窗口时'
  },
  {
    id: 'mini-taskbar',
    section: 'appearance',
    title: '迷你播放器显示在任务栏',
    terms:
      '外观 主题 界面 迷你播放器 mini player 任务栏 taskbar 悬浮窗 独立窗口 迷你播放器显示在任务栏',
    disclosureId: 'mini-player'
  },
  {
    id: 'onboarding',
    section: 'general',
    title: '欢迎向导',
    terms: '通用 常规 语言 启动 窗口 操作 向导 欢迎 onboarding 首次 引导 任务栏 播放器形态 欢迎向导'
  },
  {
    id: 'settings-backup',
    section: 'system',
    title: '设置备份',
    terms: '系统 性能 备份 关于 版本 更新 备份 backup 导出 导入 恢复 设置 设置备份'
  },
  {
    id: 'reset-settings',
    section: 'system',
    title: '按分组恢复默认',
    terms: '系统 性能 备份 关于 版本 更新 恢复 默认 重置 reset 分组 按分组恢复默认'
  },
  {
    id: 'plugin-settings',
    section: 'system',
    title: '插件设置',
    terms: '系统 性能 备份 关于 版本 更新 插件 plugin 面板 设置 扩展 插件设置',
    disclosureId: 'plugin-settings'
  },
  {
    id: 'developer-mode',
    section: 'system',
    title: '开发者模式',
    terms:
      '系统 性能 备份 关于 版本 更新 开发者 开发 模式 developer dev debug 调试 插件 目录 文件夹 未打包 unpacked 本地安装 开发者模式',
    disclosureId: 'developer-options'
  },
  {
    id: 'proxy-mode',
    section: 'connections',
    title: '代理模式',
    terms: '连接 控制 快捷键 集成 网络 代理 代理 proxy 模式 网络 系统 关闭 代理模式'
  },
  {
    id: 'proxy-host',
    section: 'connections',
    title: '代理地址',
    terms: '连接 控制 快捷键 集成 网络 代理 代理 proxy 地址 host 服务器 代理地址',
    fallbackId: 'proxy-mode'
  },
  {
    id: 'proxy-port',
    section: 'connections',
    title: '代理端口',
    terms: '连接 控制 快捷键 集成 网络 代理 代理 proxy 端口 port 代理端口',
    fallbackId: 'proxy-mode'
  },
  {
    id: 'proxy-fallback',
    section: 'connections',
    title: '代理失败时允许直连',
    terms: '连接 控制 快捷键 集成 网络 代理 代理 proxy 直连 fallback 失败 回退 代理失败时允许直连',
    fallbackId: 'proxy-mode'
  },
  {
    id: 'audio-output',
    section: 'playback',
    title: '输出模式',
    terms: '播放 输出 引擎 DSP 音效 输出 output 设备 音频 模式 声卡 输出模式'
  },
  {
    id: 'dsd-output-mode',
    section: 'playback',
    title: 'DSD 直通路由',
    terms: '播放 输出 引擎 DSP 音效 dsd 直通 路由 sacd 采样 原始 DSD 直通路由',
    disclosureId: 'dsd-routing'
  },
  {
    id: 'exclusive-mode',
    section: 'playback',
    title: '独占模式',
    terms: '播放 输出 引擎 DSP 音效 独占 exclusive 输出 设备 绕过 混音 独占模式 (Exclusive)'
  },
  {
    id: 'exclusive-release',
    section: 'playback',
    title: '独占模式自动启停',
    terms: '播放 输出 引擎 DSP 音效 独占 exclusive 自动 启停 暂停 释放 声卡 设备 独占模式自动启停'
  },
  {
    id: 'software-volume',
    section: 'playback',
    title: '软件音量',
    terms: '播放 输出 引擎 DSP 音效 音量 削波 clip 保护 响度 安全 音量与削波保护'
  },
  {
    id: 'gapless',
    section: 'playback',
    title: '无缝播放',
    terms:
      '播放 输出 引擎 DSP 音效 无缝 播放 gapless 间隙 连续 歌曲 交叉淡化 交叉淡入淡出 淡入 淡出 crossfade 等功率 曲线 边界 无缝播放 (Gapless Playback)'
  },
  {
    id: 'playback-resume',
    section: 'playback',
    title: '启动时恢复播放',
    terms: '播放 输出 引擎 DSP 音效 恢复 播放 resume 上次 曲目 位置 启动 启动时恢复播放'
  },
  {
    id: 'automix',
    section: 'playback',
    title: 'AutoMix',
    terms: '播放 输出 引擎 DSP 音效 automix 自动混音 智能转场 衔接 选段 淡化 实验 AutoMix'
  },
  {
    id: 'previous-action',
    section: 'playback',
    title: '上一首按钮行为',
    terms:
      '播放 输出 引擎 DSP 音效 上一首 按钮 重播 重放 回到 开头 previous restart 行为 上一首按钮行为'
  },
  {
    id: 'sleep-timer',
    section: 'playback',
    title: '睡眠定时器',
    terms: '播放 输出 引擎 DSP 音效 睡眠 定时 sleep timer 停止 播放 计时 睡眠定时器'
  },
  {
    id: 'streaming-quality',
    section: 'playback',
    title: '网易云播放音质',
    terms: '播放 输出 引擎 DSP 音效 网易云 ncm 音质 无损 hi-res lossless 标准 网易云播放音质'
  },
  {
    id: 'advanced-engine-parameters',
    section: 'playback',
    title: '高级引擎参数',
    terms:
      '播放 输出 引擎 DSP 音效 引擎 engine buffer 缓冲 采样率 位深 高级 高级引擎参数 (Advanced Engine)',
    disclosureId: 'advanced-engine-parameters'
  },
  {
    id: 'wasapi-push',
    fallbackId: 'exclusive-mode',
    section: 'playback',
    title: 'WASAPI 独占推送模式',
    terms: '播放 输出 引擎 DSP 音效 wasapi 独占 推送 模式 windows 输出 WASAPI 独占推送模式',
    disclosureId: 'advanced-engine-parameters'
  },
  {
    id: 'dsp-master',
    section: 'playback',
    title: 'DSP 音效',
    terms: 'DSP 数字音效 主开关 启用 旁路 播放 音频处理'
  },
  {
    id: 'clip-guard',
    section: 'playback',
    title: '防破音保护',
    terms: '播放 输出 引擎 DSP 音效 防破音 clip guard 保护 削波 响度 防破音保护 (Clip Guard)'
  },
  {
    id: 'volume-normalization',
    section: 'playback',
    title: '音量标准化 (ReplayGain / Loudnorm)',
    terms:
      '播放 输出 引擎 DSP 音效 replaygain loudnorm 音量 标准化 响度 增益 音量标准化 (ReplayGain / Loudnorm)',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'replaygain-preamp',
    section: 'playback',
    title: 'Preamp',
    terms: '播放 输出 引擎 DSP 音效 preamp 增益 前置 音量 标准化 Preamp',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'replaygain-fallback',
    section: 'playback',
    title: 'Fallback Gain',
    terms: '播放 输出 引擎 DSP 音效 fallback gain 增益 回退 音量 Fallback Gain',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'replaygain-clip',
    section: 'playback',
    title: 'ReplayGain Clip',
    terms: '播放 输出 引擎 DSP 音效 replaygain clip 削波 限制 增益 ReplayGain Clip',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'parametric-eq',
    section: 'playback',
    title: 'Parametric EQ',
    terms: '播放 输出 引擎 DSP 音效 eq 均衡 均衡器 parametric 频率 增益 Parametric EQ',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'crossfeed',
    section: 'playback',
    title: '耳机交叉馈电 (Crossfeed)',
    terms: '播放 输出 引擎 DSP 音效 crossfeed 交叉 馈电 耳机 声场 空间 耳机交叉馈电 (Crossfeed)',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'crossfeed-delay',
    section: 'playback',
    title: 'Crossfeed Delay',
    terms: '播放 输出 引擎 DSP 音效 crossfeed delay 延迟 交叉 馈电 Crossfeed Delay',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'crossfeed-cutoff',
    section: 'playback',
    title: 'Crossfeed Cutoff',
    terms: '播放 输出 引擎 DSP 音效 crossfeed cutoff 截止 频率 交叉 馈电 Crossfeed Cutoff',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'vst3-enabled',
    section: 'playback',
    title: '启用 VST3 宿主',
    terms: '播放 输出 引擎 DSP 音效 vst3 宿主 插件 启用 效果器 host 启用 VST3 宿主',
    disclosureId: 'vst3-settings'
  },
  {
    id: 'vst3-paths',
    section: 'playback',
    title: 'VST3 搜索目录',
    terms: '播放 输出 引擎 DSP 音效 vst3 搜索 目录 插件 扫描 路径 VST3 搜索目录',
    disclosureId: 'vst3-settings'
  },
  {
    id: 'vst3-catalog',
    section: 'playback',
    title: '插件目录状态',
    terms: '播放 输出 引擎 DSP 音效 插件 目录 状态 vst3 扫描 检测 插件目录状态',
    disclosureId: 'vst3-settings'
  },
  {
    id: 'cache-directory',
    section: 'library',
    title: '缓存目录',
    terms: '媒体库 下载 缓存 存储 缓存 目录 cache 路径 存储 位置 缓存目录'
  },
  {
    id: 'cache-cover',
    section: 'library',
    title: '封面缓存',
    terms: '媒体库 下载 缓存 存储 封面 cover 缓存 图片 清除 封面缓存',
    disclosureId: 'cache-details'
  },
  {
    id: 'cache-lyrics',
    section: 'library',
    title: '歌词缓存',
    terms: '媒体库 下载 缓存 存储 歌词 lyric 缓存 清除 歌词缓存',
    disclosureId: 'cache-details'
  },
  {
    id: 'cache-metadata',
    section: 'library',
    title: '元数据缓存',
    terms: '媒体库 下载 缓存 存储 元数据 metadata 缓存 清除 元数据缓存',
    disclosureId: 'cache-details'
  },
  {
    id: 'cache-audio',
    section: 'library',
    title: '流媒体音频缓存',
    terms: '媒体库 下载 缓存 存储 流媒体 音频 缓存 streaming 缓存策略 网络 流媒体音频缓存',
    disclosureId: 'cache-details'
  },
  {
    id: 'bpm-analysis',
    section: 'playback',
    title: 'BPM 自动分析',
    terms: '播放 输出 引擎 DSP 音效 bpm 分析 自动 节奏 扫描 BPM 自动分析'
  },
  {
    id: 'cache-bpm',
    section: 'library',
    title: 'BPM 分析缓存',
    terms: '媒体库 下载 缓存 存储 bpm 分析 缓存 清除 BPM 分析缓存',
    disclosureId: 'cache-details'
  },
  {
    id: 'cache-loudness',
    section: 'library',
    title: 'Loudnorm / 响度分析缓存',
    terms: '媒体库 下载 缓存 存储 loudnorm 响度 分析 缓存 清除 Loudnorm / 响度分析缓存',
    disclosureId: 'cache-details'
  },
  {
    id: 'cache-usage',
    section: 'library',
    title: '缓存占用',
    terms: '媒体库 下载 缓存 存储 缓存 占用 大小 清理 清空 释放 空间 缓存占用'
  },
  {
    id: 'hardware-acceleration',
    section: 'system',
    title: '硬件加速',
    terms: '系统 性能 备份 关于 版本 更新 硬件 加速 gpu 渲染 显卡 性能 硬件加速'
  },
  {
    id: 'window-transparency',
    section: 'appearance',
    title: '系统窗口透明',
    terms: '外观 主题 界面 窗口 透明 透明度 毛玻璃 玻璃 背景 窗口透明'
  },
  {
    id: 'window-surface-opacity',
    section: 'appearance',
    title: '背景表面不透明度',
    terms: '外观 主题 界面 表面 不透明度 opacity 透明度 窗口 表面不透明度 (Surface Opacity)',
    fallbackId: 'window-transparency'
  },
  {
    id: 'window-surface-blur',
    section: 'appearance',
    title: '背景表面模糊度',
    terms: '外观 主题 界面 表面 模糊 blur 毛玻璃 窗口 表面模糊度 (Surface Blur)',
    fallbackId: 'window-transparency'
  },
  {
    id: 'window-card-opacity',
    section: 'appearance',
    title: '卡片不透明度',
    terms: '外观 主题 界面 卡片 不透明度 opacity 透明度 卡片不透明度 (Card Opacity)',
    fallbackId: 'window-transparency'
  },
  {
    id: 'window-card-blur',
    section: 'appearance',
    title: '卡片模糊度',
    terms: '外观 主题 界面 卡片 模糊 blur 毛玻璃 卡片模糊度 (Card Blur)',
    fallbackId: 'window-transparency'
  },
  {
    id: 'theme-studio',
    section: 'appearance',
    title: '主题创意工坊',
    terms: '外观 主题 界面 主题 工作室 theme 编辑器 自定义 皮肤 主题创意工坊与主题插件工坊'
  },
  {
    id: 'color-mode',
    section: 'appearance',
    title: '主题模式',
    terms: '外观 主题 界面 主题 模式 浅色 深色 系统 亮色 暗色 主题模式'
  },
  {
    id: 'motion',
    section: 'appearance',
    title: '界面动效',
    terms: '外观 主题 界面 动效 动画 减少动画 motion 特效 过渡 界面动效'
  },
  {
    id: 'plugin-theme',
    section: 'appearance',
    title: '插件主题',
    terms: '外观 主题 界面 插件 主题 plugin theme 扩展 插件主题'
  },
  {
    id: 'accent-light',
    section: 'appearance',
    title: '浅色强调色',
    terms: '外观 主题 界面 强调色 accent 浅色 颜色 主题 浅色强调色'
  },
  {
    id: 'accent-dark',
    section: 'appearance',
    title: '深色强调色',
    terms: '外观 主题 界面 强调色 accent 深色 颜色 主题 深色强调色'
  },
  {
    id: 'background-editor',
    section: 'appearance',
    title: '背景与界面材质',
    terms: '外观 主题 界面 背景 自定义 壁纸 图片 封面 材质 外观 整合 背景与界面材质',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-73',
    section: 'appearance',
    title: '透明材质',
    terms: '外观 主题 界面 透明 全透明 文字 通透 图片 皮肤 透明材质',
    appearanceArea: 'material'
  },
  {
    id: 'appearance-editor-74',
    section: 'appearance',
    title: '文字明暗',
    terms: '外观 主题 界面 字体 文字 颜色 浅色 深色 对比 文字明暗',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-75',
    section: 'appearance',
    title: '画面缩放',
    terms: '外观 主题 界面 图片 背景 缩放 裁切 大小 zoom scale 画面缩放',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-76',
    section: 'appearance',
    title: '统一背景',
    terms: '外观 主题 界面 背景 统一 所有 页面 壁纸 统一背景',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-77',
    section: 'appearance',
    title: '页面背景覆盖',
    terms: '外观 主题 界面 背景 页面 覆盖 独立 壁纸 图片 页面背景覆盖',
    appearanceArea: 'background'
  },
  {
    id: 'cover-theme',
    section: 'appearance',
    title: '封面主题色',
    terms: '外观 主题 界面 封面 主题色 cover 颜色 专辑 封面主题色'
  },
  {
    id: 'global-font',
    section: 'appearance',
    title: '界面字体',
    terms:
      '外观 主题 界面 字体 font typography 排版 全局 界面字体 正文 标题 霞鹜文楷 更纱黑体 跟随主题 全局字体 (Typography)'
  },
  {
    id: 'font-rendering',
    section: 'appearance',
    title: '文字渲染',
    terms:
      '外观 主题 界面 字体 清晰 平滑 发虚 模糊 渲染 笔画 透明 背景 font rendering crisp smooth 文字渲染'
  },
  {
    id: 'ui-density',
    section: 'appearance',
    title: '界面密度',
    terms: '外观 主题 界面 密度 ui density 排版 紧凑 宽松 界面排版密度 (UI Density)'
  },
  {
    id: 'playing-lyrics',
    section: 'lyrics',
    title: '播放页歌词',
    terms: '歌词 桌面歌词 歌词 lyric 样式 高亮 逐字 显示 歌词显示样式 (Lyrics Style)'
  },
  {
    id: 'lyrics-word-highlight',
    section: 'lyrics',
    title: '逐字高亮',
    terms: '歌词 桌面歌词 逐字 高亮 歌词 卡拉 ok 同步 逐字高亮'
  },
  {
    id: 'appearance-editor-84',
    section: 'appearance',
    title: '卡片与背景自定义',
    terms: '外观 主题 界面 卡片 背景 自定义 外观 卡片与背景自定义',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-85',
    section: 'appearance',
    title: '启用自定义外观',
    terms: '外观 主题 界面 外观 自定义 启用 卡片 开关 启用自定义外观',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-86',
    section: 'appearance',
    title: '卡片模糊强度',
    terms: '外观 主题 界面 卡片 模糊 强度 blur 毛玻璃 卡片模糊强度',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-87',
    section: 'appearance',
    title: '卡片模糊饱和度',
    terms: '外观 主题 界面 卡片 模糊 饱和度 saturation blur 卡片模糊饱和度',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-88',
    section: 'appearance',
    title: '卡片背景颜色',
    terms: '外观 主题 界面 卡片 背景 颜色 color 卡片背景颜色',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-89',
    section: 'appearance',
    title: '卡片边框',
    terms: '外观 主题 界面 卡片 边框 border 描边 卡片边框',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-90',
    section: 'appearance',
    title: '卡片圆角半径',
    terms: '外观 主题 界面 卡片 圆角 radius 圆角 弧度 卡片圆角半径',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-91',
    section: 'appearance',
    title: '卡片阴影强度',
    terms: '外观 主题 界面 卡片 阴影 强度 shadow 投影 卡片阴影强度',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-92',
    section: 'appearance',
    title: '卡片悬浮效果',
    terms: '外观 主题 界面 卡片 悬浮 hover 效果 悬停 卡片悬浮效果',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-93',
    section: 'appearance',
    title: '玻璃高光',
    terms: '外观 主题 界面 玻璃 高光 glass highlight 光泽 玻璃高光',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-94',
    section: 'appearance',
    title: '背景模糊与暗化',
    terms: '外观 主题 界面 背景 模糊 暗化 遮罩 blur darken 背景模糊与暗化',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-95',
    section: 'appearance',
    title: '背景模糊',
    terms: '外观 主题 界面 背景 模糊 blur 毛玻璃 背景模糊',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-96',
    section: 'appearance',
    title: '背景亮度',
    terms: '外观 主题 界面 背景 亮度 brightness 明暗 背景亮度',
    appearanceArea: 'background'
  },
  {
    id: 'appearance-editor-97',
    section: 'appearance',
    title: '背景暗化遮罩',
    terms: '外观 主题 界面 背景 暗化 遮罩 蒙版 overlay darken 背景暗化遮罩',
    appearanceArea: 'background'
  },
  {
    id: 'player-bar-mode',
    section: 'appearance',
    title: '播放条形态',
    terms:
      '外观 主题 界面 播放条 播放栏 playbar 迷你 mini 标准 紧凑 compact 形态 大小 贴底 全宽 播放条形态',
    disclosureId: 'player-bar'
  },
  {
    id: 'player-page-mode',
    section: 'appearance',
    title: '播放页形态',
    terms:
      '外观 主题 界面 播放页 播放条 playbar 迷你 mini 紧凑 compact 形态 now playing 播放页形态',
    disclosureId: 'player-bar'
  },
  {
    id: 'player-bar-layout',
    section: 'appearance',
    title: '播放条按钮编排',
    terms:
      '外观 主题 界面 按钮 编排 排列 顺序 布局 槽位 自定义 增删 左侧 中间 右侧 播放条 播放栏 playbar layout 收藏 音量 均衡器 时间 封面 播放条按钮编排',
    disclosureId: 'player-bar'
  },
  {
    id: 'player-bar-visibility',
    section: 'appearance',
    title: '播放条可见性',
    terms:
      '外观 主题 界面 可见性 常显 自动隐藏 完全隐藏 隐藏播放条 关闭播放条 不显示播放条 播放条 播放栏 playbar auto hide hidden visibility 播放条可见性',
    disclosureId: 'player-bar'
  },
  {
    id: 'player-page-visibility',
    section: 'appearance',
    title: '播放页可见性',
    terms:
      '外观 主题 界面 播放页 可见性 自动隐藏 完全隐藏 播放条 playbar auto hide hidden now playing 歌词页 播放页可见性',
    disclosureId: 'player-bar'
  },
  {
    id: 'player-bar-threshold',
    section: 'appearance',
    title: '触发距离',
    terms: '外观 主题 界面 触发 距离 阈值 threshold 鼠标 底边 播放条 自动隐藏 触发距离',
    disclosureId: 'player-bar',
    fallbackId: 'player-bar-visibility'
  },
  {
    id: 'player-bar-delay',
    section: 'appearance',
    title: '收起延迟',
    terms: '外观 主题 界面 收起 延迟 delay 播放条 自动隐藏 隐藏 收起延迟',
    disclosureId: 'player-bar',
    fallbackId: 'player-bar-visibility'
  },
  {
    id: 'appearance-editor-105',
    section: 'appearance',
    title: '液态玻璃材质',
    terms:
      '外观 主题 界面 液态玻璃 玻璃 透明 透明化 折射 材质 质感 liquid glass 卡片 播放条 播放栏 playbar 毛玻璃 液态玻璃材质',
    appearanceArea: 'material'
  },
  {
    id: 'appearance-editor-106',
    section: 'appearance',
    title: '启用液态玻璃',
    terms:
      '外观 主题 界面 液态玻璃 启用 开关 透明 透明化 材质 liquid glass 播放条 播放栏 卡片 启用液态玻璃',
    appearanceArea: 'advanced'
  },
  {
    id: 'appearance-editor-107',
    section: 'appearance',
    title: '高光跟随指针',
    terms: '外观 主题 界面 高光 跟随 指针 鼠标 光源 镜面 specular 液态玻璃 高光跟随指针',
    appearanceArea: 'advanced'
  },
  {
    id: 'desktop-enabled',
    section: 'lyrics',
    title: '启用桌面歌词',
    terms: '歌词 桌面歌词 桌面歌词 启用 开关 显示 歌词 启用桌面歌词'
  },
  {
    id: 'desktop-font',
    section: 'lyrics',
    title: '歌词字体 (Font Family)',
    terms:
      '歌词 桌面歌词 桌面歌词 字体 字体名 跟随 PlayingMusic 系统默认 霞鹜文楷 更纱黑体 本机字体 已安装 font family custom installed follow 歌词字体 (Font Family)'
  },
  {
    id: 'desktop-font-size',
    section: 'lyrics',
    title: '字体大小 (Font Size)',
    terms: '歌词 桌面歌词 字体 大小 font size 字号 歌词 字体大小 (Font Size)'
  },
  {
    id: 'desktop-font-weight',
    section: 'lyrics',
    title: '字体粗细 (Font Weight)',
    terms: '歌词 桌面歌词 字体 粗细 font weight 加粗 字体粗细 (Font Weight)'
  },
  {
    id: 'desktop-outline',
    section: 'lyrics',
    title: '文字描边 (Text Outline)',
    terms: '歌词 桌面歌词 描边 边框 outline stroke 有描边 无描边 歌词 文字描边 (Text Outline)'
  },
  {
    id: 'desktop-line-gap',
    section: 'lyrics',
    title: '行间距 (Line Spacing)',
    terms: '歌词 桌面歌词 行距 间距 line spacing 歌词 行间距 (Line Spacing)',
    disclosureId: 'desktop-lyrics-advanced'
  },
  {
    id: 'desktop-lines',
    section: 'lyrics',
    title: '显示行数 (Display Lines)',
    terms: '歌词 桌面歌词 行数 单行 双行 single double display lines 歌词 显示行数 (Display Lines)'
  },
  {
    id: 'desktop-writing',
    section: 'lyrics',
    title: '文字排列 (Writing Mode)',
    terms:
      '歌词 桌面歌词 横排 竖排 横向 纵向 horizontal vertical writing mode 排版 歌词 文字排列 (Writing Mode)'
  },
  {
    id: 'desktop-palette',
    section: 'lyrics',
    title: '配色方案 (Palette)',
    terms:
      '歌词 桌面歌词 配色 方案 落日晖 Twilight 暖白 封面强调色 palette color 歌词 配色方案 (Palette)'
  },
  {
    id: 'desktop-active-color',
    section: 'lyrics',
    title: '已播放颜色 (Played Color)',
    terms: '歌词 桌面歌词 已播放 当前 歌词 颜色 active played color 已播放颜色 (Played Color)',
    fallbackId: 'desktop-palette'
  },
  {
    id: 'desktop-inactive-color',
    section: 'lyrics',
    title: '未播放颜色 (Unplayed Color)',
    terms:
      '歌词 桌面歌词 未播放 未唱 歌词 颜色 inactive unplayed color 未播放颜色 (Unplayed Color)',
    fallbackId: 'desktop-palette'
  },
  {
    id: 'desktop-background-opacity',
    section: 'lyrics',
    title: '背景透明度 (Background Opacity)',
    terms: '歌词 桌面歌词 背景 透明度 opacity 歌词 半透明 背景透明度 (Background Opacity)',
    disclosureId: 'desktop-lyrics-advanced'
  },
  {
    id: 'desktop-shadow',
    section: 'lyrics',
    title: '文字阴影 (Text Shadow)',
    terms: '歌词 桌面歌词 文字 阴影 强度 shadow 投影 歌词 文字阴影 (Text Shadow)',
    disclosureId: 'desktop-lyrics-advanced'
  },
  {
    id: 'desktop-align',
    section: 'lyrics',
    title: '对齐方式 (Alignment)',
    terms: '歌词 桌面歌词 对齐 align 居左 居中 居右 歌词 对齐方式 (Alignment)'
  },
  {
    id: 'desktop-width',
    section: 'lyrics',
    title: '窗口宽度 (Window Width)',
    terms: '歌词 桌面歌词 窗口 宽度 width 桌面歌词 窗口宽度 (Window Width)'
  },
  {
    id: 'desktop-height',
    section: 'lyrics',
    title: '窗口高度 (Window Height)',
    terms: '歌词 桌面歌词 窗口 高度 height 桌面歌词 窗口高度 (Window Height)'
  },
  {
    id: 'desktop-on-top',
    section: 'lyrics',
    title: '始终置顶 (Always on Top)',
    terms: '歌词 桌面歌词 置顶 always on top 窗口 顶层 钉住 始终置顶 (Always on Top)'
  },
  {
    id: 'desktop-locked',
    section: 'lyrics',
    title: '锁定并穿透点击 (Click Through)',
    terms: '歌词 桌面歌词 锁定 鼠标 穿透 click through 点击 窗口 锁定并穿透点击 (Click Through)'
  },
  {
    id: 'desktop-translation',
    section: 'lyrics',
    title: '显示翻译',
    terms: '歌词 桌面歌词 翻译 translation 显示 双语 原文 显示翻译 (Show Translation)'
  },
  {
    id: 'desktop-romanization',
    section: 'lyrics',
    title: '显示音译',
    terms:
      '歌词 桌面歌词 音译 罗马音 romanization transliteration 显示 外文歌词 显示音译 (Show Romanization)'
  },
  {
    id: 'global-shortcuts',
    section: 'connections',
    title: '全局快捷键',
    terms:
      '连接 控制 快捷键 集成 网络 代理 全局 快捷键 系统 媒体键 后台 注册 全局快捷键 (Global Shortcuts)'
  },
  {
    id: 'shortcut-status',
    fallbackId: 'global-shortcuts',
    section: 'connections',
    title: '快捷键状态',
    terms: '连接 控制 快捷键 集成 网络 代理 快捷键 状态 注册 冲突 检测 失败 快捷键状态'
  },
  {
    id: 'shortcut-bindings',
    section: 'connections',
    title: '自定义组合键',
    terms:
      '连接 控制 快捷键 集成 网络 代理 自定义 组合键 修改 绑定 录制 恢复默认 上一首 下一首 播放 暂停 桌面歌词 自定义组合键'
  },
  {
    id: 'media-keys',
    fallbackId: 'global-shortcuts',
    section: 'connections',
    title: '系统媒体键',
    terms: '连接 控制 快捷键 集成 网络 代理 媒体键 media key 键盘 耳机 播放键 停止 系统媒体键'
  },
  {
    id: 'app-version',
    section: 'system',
    title: '版本信息',
    terms: '系统 性能 备份 关于 版本 更新 版本 version 关于 twilight echo 名称 版本信息'
  },
  {
    id: 'app-update',
    section: 'system',
    title: '检查更新',
    terms: '系统 性能 备份 关于 版本 更新 更新 update 检查 版本 下载 安装 发布 检查更新'
  },
  {
    id: 'app-update-install',
    section: 'system',
    title: '下载 / 安装更新',
    terms: '系统 性能 备份 关于 版本 更新 更新 下载 安装 版本 发布 github releases 下载 / 安装更新'
  },
  {
    id: 'project-support',
    section: 'system',
    title: '支持项目发展',
    terms: '系统 性能 备份 关于 版本 更新 赞助 支持 捐赠 项目 开源 爱发电 支持项目发展'
  },
  {
    id: 'project-links',
    section: 'system',
    title: '开源致谢与交流群',
    terms: '系统 性能 备份 关于 版本 更新 开源 致谢 交流 群 社区 感谢 license 开源致谢与交流群'
  },
  {
    id: 'language',
    section: 'general',
    title: '界面语言',
    terms: '通用 常规 语言 启动 窗口 操作 语言 中文 英文 language locale'
  },
  {
    id: 'download-directory',
    section: 'library',
    title: '下载目录',
    terms: '媒体库 下载 缓存 存储 下载 目录 保存位置 文件夹'
  },
  {
    id: 'download-naming',
    section: 'library',
    title: '下载文件命名',
    terms: '媒体库 下载 缓存 存储 下载 文件名 命名 歌手 歌曲'
  },
  {
    id: 'download-metadata',
    section: 'library',
    title: '内嵌歌曲信息与封面',
    terms: '媒体库 下载 缓存 存储 下载 标签 metadata 封面'
  },
  {
    id: 'download-lyrics',
    section: 'library',
    title: '同时保存歌词文件',
    terms: '媒体库 下载 缓存 存储 下载 歌词 文件 lrc'
  },
  {
    id: 'personal-backup',
    section: 'system',
    title: '个人数据备份与迁移',
    terms: '系统 性能 备份 关于 版本 更新 备份 数据 曲库 歌单 队列 迁移'
  },
  {
    id: 'mini-player',
    section: 'appearance',
    title: '迷你播放器',
    terms: '外观 主题 界面 迷你 播放器 窗口 主题 布局 mini',
    disclosureId: 'mini-player'
  },
  {
    id: 'compact-visualizer',
    section: 'appearance',
    title: '歌词页底部动态频谱',
    terms: '外观 主题 界面 频谱 底栏 性能 动态 可视化',
    disclosureId: 'player-bar'
  },
  {
    id: 'theme-workshop',
    section: 'appearance',
    title: '主题插件工坊',
    terms: '外观 主题 界面 主题 插件 编辑 导出 工坊'
  },
  {
    id: 'dsd-compatible-route',
    section: 'playback',
    title: 'DSD 兼容层路由',
    terms: '播放 输出 引擎 DSP 音效 dsd asio 代理 兼容 直通',
    disclosureId: 'dsd-routing'
  },
  {
    id: 'dsd-route-backend',
    section: 'playback',
    title: '路由后端',
    terms: '播放 输出 引擎 DSP 音效 dsd 后端 asio 代理',
    disclosureId: 'dsd-routing',
    fallbackId: 'dsd-compatible-route'
  },
  {
    id: 'dsd-route-device',
    section: 'playback',
    title: '路由设备',
    terms: '播放 输出 引擎 DSP 音效 dsd 设备 驱动',
    disclosureId: 'dsd-routing',
    fallbackId: 'dsd-compatible-route'
  },
  {
    id: 'dsd-route-upsampling',
    section: 'playback',
    title: 'PCM→DSD 上采样也走此路由',
    terms: '播放 输出 引擎 DSP 音效 pcm dsd 上采样 兼容',
    disclosureId: 'dsd-routing',
    fallbackId: 'dsd-compatible-route'
  },
  {
    id: 'dsd-route-strict',
    section: 'playback',
    title: '严格直通模式',
    terms: '播放 输出 引擎 DSP 音效 dsd 严格 直通 回退',
    disclosureId: 'dsd-routing',
    fallbackId: 'dsd-compatible-route'
  },
  {
    id: 'playback-policy',
    section: 'playback',
    title: '连续播放策略',
    terms: '播放 输出 引擎 DSP 音效 连续 原样 无缝 bit-perfect continuity'
  },
  {
    id: 'buffer-size',
    section: 'playback',
    title: '缓冲大小',
    terms: '播放 输出 引擎 DSP 音效 buffer size 缓冲 延迟',
    disclosureId: 'advanced-engine-parameters'
  },
  {
    id: 'channel-routing',
    section: 'playback',
    title: '声道路由',
    terms: '播放 输出 引擎 DSP 音效 routing 声道 环绕 上混',
    disclosureId: 'advanced-engine-parameters'
  },
  {
    id: 'pcm-to-dsd',
    section: 'playback',
    title: 'PCM 转 DSD',
    terms: '播放 输出 引擎 DSP 音效 上采样 pcm dsd',
    disclosureId: 'advanced-engine-parameters'
  },
  {
    id: 'dsd-rate-policy',
    section: 'playback',
    title: 'DSD 采样率策略',
    terms: '播放 输出 引擎 DSP 音效 dsd rate policy 回退',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'sacd-program',
    section: 'playback',
    title: 'SACD 声道节目',
    terms: '播放 输出 引擎 DSP 音效 sacd program 声道 多声道',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'fft-capture',
    section: 'playback',
    title: '频谱采集',
    terms: '播放 输出 引擎 DSP 音效 fft capture 频谱 分辨率',
    disclosureId: 'dsp-details',
    fallbackId: 'dsp-master',
    fallbackReason: 'DSP 已关闭。请先开启此处的 DSP 音效，再调整详细参数。'
  },
  {
    id: 'lyrics-font',
    section: 'lyrics',
    title: '播放页歌词字体',
    terms: '歌词 桌面歌词 歌词 font 字体'
  },
  {
    id: 'lyrics-align',
    section: 'lyrics',
    title: '播放页歌词对齐',
    terms: '歌词 桌面歌词 歌词 对齐 align'
  },
  {
    id: 'lyrics-size',
    section: 'lyrics',
    title: '播放页歌词字号',
    terms: '歌词 桌面歌词 歌词 字号 大小 font size'
  },
  {
    id: 'lyrics-weight',
    section: 'lyrics',
    title: '播放页歌词字重',
    terms: '歌词 桌面歌词 歌词 字重 粗细 weight'
  },
  {
    id: 'lyrics-line-gap',
    section: 'lyrics',
    title: '播放页歌词行距',
    terms: '歌词 桌面歌词 歌词 行距 间距 spacing'
  },
  {
    id: 'lyrics-dim',
    section: 'lyrics',
    title: '未播放歌词暗度',
    terms: '歌词 桌面歌词 歌词 未播放 暗度 dim'
  },
  {
    id: 'lyrics-focus',
    section: 'lyrics',
    title: '歌词聚焦行数',
    terms: '歌词 桌面歌词 歌词 聚焦 范围 focus'
  },
  {
    id: 'lyrics-color',
    section: 'lyrics',
    title: '播放页歌词颜色',
    terms: '歌词 桌面歌词 歌词 配色 颜色'
  },
  {
    id: 'lyrics-customizer',
    section: 'lyrics',
    title: '高级歌词个性化',
    terms: '歌词 桌面歌词 歌词 个性化 字体 翻译 罗马音 逐层'
  }
]

/** Resolve pre-reorganization commands without guessing from rendered text. */
export function resolveSettingsSearchEntry(entry: SettingsSearchEntry): SettingsSearchEntry {
  return (
    SETTINGS_SEARCH_INDEX.find(
      (candidate) =>
        candidate.id === entry.id ||
        (!entry.id && (candidate.title === entry.title || candidate.terms.endsWith(entry.title)))
    ) ?? { ...entry, section: normalizeSettingsSection(entry.section) }
  )
}

export const RESET_DESKTOP_LYRICS: DesktopLyricsSettings = DEFAULT_DESKTOP_LYRICS_SETTINGS

export type PluginSettingsFieldType = 'text' | 'password' | 'url' | 'select'

export interface PluginSettingsOption {
  label: string
  value: string
}

export interface PluginSettingsField {
  key: string
  label: string
  type: PluginSettingsFieldType
  required: boolean
  placeholder: string
  value: string
  options: PluginSettingsOption[]
}

export interface PluginSettingsForm {
  submitCommand: string
  fields: PluginSettingsField[]
  notice: string
}
