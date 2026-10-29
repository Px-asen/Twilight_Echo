import type {
  AudioOutputId,
  AudioProcessingSettings,
  EqMode,
  EqualizerBand,
  HeadphoneCompensationSettings,
  OutputConfig,
  PlayMode
} from './audioEngineTypes.ts'
import type { MiniPlayerSettings } from './miniPlayer.ts'
import type { ShortcutEnabledSettings } from './shortcutPreferences.ts'
import type { DspScene } from './dspGraph.ts'
import type { SleepTimerSettings } from './sleepTimer.ts'
import type { ThemeSelection, ThemeWindowInheritance } from './theme.ts'
import type { LiquidGlassSettings, SurfaceMaterial } from './liquidGlass.ts'
import type { LyricsAppearanceSettings } from './lyricsAppearance.ts'
import type { LyricsPresetConfig } from './lyricsPresets.ts'
import type { DesktopLyricsSettingsV3 } from './desktopLyrics.ts'
import type { PlayerBarSettings } from './playerBar.ts'
import type { LanguagePreference } from './i18n/locale.ts'
import type { MotionPreference } from './motion.ts'
import type { NavigationPagePreferences } from './navigationPages.ts'
import type { AppFontRendering } from './appFont.ts'
import type { StartupExperience } from './pluginExperience.ts'

export type {
  DesktopLyricsPalette,
  DesktopLyricsSettingsV3,
  DesktopLyricsTransportAction
} from './desktopLyrics.ts'
export { DESKTOP_LYRICS_SETTINGS_VERSION } from './desktopLyrics.ts'

export type AppTheme = 'system' | 'pureWhite' | 'dark'
export type PlaybackResumeMode = 'off' | 'track' | 'trackAndPosition'
export type PreviousButtonAction = 'restart' | 'previous'
export type NcmPlaybackQuality = 'auto' | 'standard' | 'exhigh' | 'lossless' | 'hires'
export type StartupHomePage = 'local' | 'streaming'
export type TrackActivationMode = 'singleClick' | 'doubleClick'
export type UiDensity = 'compact' | 'standard' | 'comfortable'
export type ProxyMode = 'auto' | 'custom' | 'off'
export type NowPlayingBackground = 'blur' | 'fluid' | 'solid'
export type StreamingAudioCachePolicy = 'off' | 'provider'
export type AppBackgroundPage = 'local' | 'settings' | 'streaming' | 'player'
export type AppBackgroundKind = 'theme' | 'color' | 'image'

export type BackgroundTextTone = 'theme' | 'light' | 'dark'
export interface AppBackgroundEffect extends BackgroundEffectTheme {
  scale: number
  positionX: number
  positionY: number
  textTone: BackgroundTextTone
}

export interface AppBackgroundImagePalette {
  /** The local asset this sample belongs to; stale samples never follow a replacement image. */
  image: string
  average: string
  accent: string
  /** Average alpha of the sampled image, before compositing over the background color. */
  opacity?: number
}

export interface AppBackgroundColorPair {
  light: string
  dark: string
  kind: AppBackgroundKind
  image: string
  imagePalette?: AppBackgroundImagePalette
  /** Distinguishes an explicitly edited solid background from theme defaults. */
  customized?: boolean
  /** Optional on legacy settings; normalized before editing or rendering. */
  effects?: Record<'light' | 'dark', AppBackgroundEffect>
}

export interface AppBackgroundPageOverride extends AppBackgroundColorPair {
  inherit: boolean
}

export interface AppBackgroundSettings {
  global: AppBackgroundColorPair
  pages: Record<AppBackgroundPage, AppBackgroundPageOverride>
}

export type CardShadowStrength = 'none' | 'subtle' | 'medium' | 'strong'
export type CardHoverEffect = 'none' | 'lift' | 'zoom' | 'glow'

export interface CardAppearanceTheme {
  blurRadius: number
  blurSaturation: number
  backgroundColor: string
  backgroundOpacity: number
  borderColor: string
  borderOpacity: number
  borderWidth: number
  borderRadius: number
  shadowStrength: CardShadowStrength
  hoverEffect: CardHoverEffect
  glassHighlight: boolean
}

export interface BackgroundEffectTheme {
  blur: number
  brightness: number
  dim: number
}

export interface BackgroundEffectSettings {
  enabled: boolean
  light: BackgroundEffectTheme
  dark: BackgroundEffectTheme
}

export interface CardAppearanceSettings {
  enabled: boolean
  light: CardAppearanceTheme
  dark: CardAppearanceTheme
  /** Legacy import only. Background effects now belong to appBackground. */
  background: BackgroundEffectSettings
}

export interface WindowTransparencyEffectSettings {
  surfaceOpacity: number
  surfaceBlur: number
  cardOpacity: number
  cardBlur: number
}

/** Versioned desktop lyrics window, appearance, and behavior settings. */
export type DesktopLyricsSettings = DesktopLyricsSettingsV3

export interface MusicCachePolicySettings {
  cover: boolean
  lyrics: boolean
  metadata: boolean
  streamingAudio: StreamingAudioCachePolicy
}

export interface AudioEqPreset {
  id: string
  name: string
  eqMode: EqMode
  eqPreamp: number
  eqBands: EqualizerBand[]
}

export interface GlobalShortcutSettings {
  volumeUp: string
  volumeDown: string
  previous: string
  next: string
  playPause: string
  toggleDesktopLyrics: string
  toggleDesktopLyricsLock: string
}

export type CloseWindowBehavior = 'quit' | 'tray' | 'miniPlayer'

export interface AppSettings {
  autoCheckLogin: boolean
  autoLaunch: boolean
  launchAtLogin: boolean
  hardwareAcceleration: boolean
  globalShortcuts: boolean
  shortcutEnabled: ShortcutEnabledSettings
  globalShortcutBindings: GlobalShortcutSettings
  minimizeToTray: boolean
  musicCachePath: string
  cachePath: string
  cachePolicy: MusicCachePolicySettings
  autoAnalyzeBpm: boolean
  /**
   * How the main-window close control behaves. closeToTray is retained as the
   * compatibility mirror for older settings and code paths.
   */
  closeWindowBehavior: CloseWindowBehavior
  closeToTray: boolean
  /** Windows taskbar thumbnail transport buttons; independent from SMTC metadata. */
  taskbarThumbarButtonsEnabled: boolean
  /**
   * Unload the UI renderer while the native engine keeps playing (Afterglow).
   * `off` keeps every window resident; other values enter automatically when the
   * main window is minimized and/or hidden to the tray.
   */
  afterglowAutoEntry: import('./afterglowMode.ts').AfterglowAutoEntry
  /** First-run welcome wizard has been completed or skipped. */
  onboardingCompleted: boolean
  /** Unlocks developer-only affordances, e.g. installing an unpacked plugin directory. */
  developerMode: boolean
  startupHomePage: StartupHomePage
  startupExperience: StartupExperience | null
  navigationPages: NavigationPagePreferences
  trackActivationMode: TrackActivationMode
  /** UI and error-message language. `system` follows the OS locale. */
  language: LanguagePreference
  theme: AppTheme
  pluginThemeId: string | null
  activeTheme: ThemeSelection
  themeWindowInheritance: ThemeWindowInheritance
  motionPreference: MotionPreference
  blurEffect: boolean
  windowTransparency: boolean
  windowTransparencyEffect: WindowTransparencyEffectSettings
  useCoverTheme: boolean
  lyricsAppearance: LyricsAppearanceSettings
  lyricsPresets: LyricsPresetConfig
  libraryFolders: string[]
  /** Last location used by the music folder picker, including existing or removed roots. */
  lastLibraryFolder: string
  /** Destination for provider downloads. Empty falls back to the first music library folder. */
  downloadPreferences: import('./downloadPreferences.ts').DownloadPreferences
  downloadFolder: string
  genreSeparators: string
  watchLibrary: boolean
  musicIdentification: import('./musicIdentificationSchedule.ts').MusicIdentificationSettings
  /** When true, empty local/provider lyrics may fall back to LRCLIB online search. */
  onlineLyricsFallback: boolean
  smtcEnabled: boolean
  discordRpcEnabled: boolean
  accentColor: string
  lightAccentColor: string
  darkAccentColor: string
  fontFamily: string
  fontRendering: AppFontRendering
  uiDensity: UiDensity
  appBackground: AppBackgroundSettings
  /** Independent foreground and out-of-bounds decoration channels for every widget. */
  appearanceLayers?: import('./appearanceLayers').AppearanceLayersSettings
  cardAppearance: CardAppearanceSettings
  /** Switches navigation and playback controls between standard surfaces and liquid glass. */
  surfaceMaterial: SurfaceMaterial
  liquidGlass: LiquidGlassSettings
  /** Standard vs mini playbar shape, plus now-playing auto-hide. */
  playerBar: PlayerBarSettings
  nowPlayingBackground: NowPlayingBackground
  playbackResumeMode: PlaybackResumeMode
  /** restart: previous button replays the current track first; previous: always jump to the previous track. */
  previousButtonAction: PreviousButtonAction
  autoMixMode: import('./twilightAutoMix.ts').AutoMixMode
  autoMixStemMode: import('./twilightAutoMix.ts').AutoMixStemMode
  autoMixStemDevice: import('./twilightAutoMix.ts').AutoMixStemDevice
  autoMixStemCacheMiB: import('./twilightAutoMix.ts').AutoMixStemCacheMiB
  sleepTimer: SleepTimerSettings
  ncmPlaybackQuality: NcmPlaybackQuality
  playMode: PlayMode
  /** Last user software volume in [0, 1]. Default 0.7; bit-perfect needs explicit 1.0. */
  softwareVolume: number
  audioOutput: AudioOutputId
  audioDevice: string
  audioExclusiveMode: boolean
  audioExclusiveAutoRelease: boolean
  audioOutputConfig: OutputConfig
  audioDeviceProfiles: import('./audioDeviceProfiles.ts').AudioDeviceProfileSettings
  audioProcessing: AudioProcessingSettings
  dspScenes: DspScene[]
  dspPinnedSceneId: string | null
  headphoneCompensation: HeadphoneCompensationSettings
  /** Customized built-in EQ presets, or null when using factory defaults. */
  audioEqBuiltInPresets: AudioEqPreset[] | null
  audioEqPresets: AudioEqPreset[]
  /** Null until the one-time browser preference import has been applied. */
  audioEqAutoPreamp: import('./equalizerPreferences.ts').EqualizerAutoPreamp | null
  desktopLyrics: DesktopLyricsSettings
  miniPlayer: MiniPlayerSettings
  proxyMode: ProxyMode
  proxyHost: string
  proxyPort: number
  proxyAllowDirectFallback: boolean
  streamingActiveProvider: string
  /** LAN web remote + media token server. Default OFF. */
  remoteControlEnabled: boolean
  /** Preferred remote HTTP port; 0 = ephemeral. */
  remoteControlPort: number
}

export interface SettingsSnapshotMetadata {
  settings: AppSettings
  defaults: {
    cachePath: string
  }
  paths: {
    settingsFile: string
    userDataPath: string
    activeCachePath: string
  }
  appVersion: string
  platform: string
  windowTransparencySupported: boolean
  restartRequired: boolean
  restartReasons: string[]
}

export interface SettingsSnapshot extends AppSettings, SettingsSnapshotMetadata {}
