export type {
  AudioOutputId,
  PlayMode,
  EqMode,
  VolumeNormalizationMode,
  ChannelRoutingMode,
  PcmToDsdMode,
  DsdOutputMode,
  DsdRatePolicy,
  SacdProgramMode,
  EqualizerFilterType,
  EqualizerBand,
  AudioProcessingSettings,
  AudioOutputOption,
  AudioDeviceOption,
  AudioCapabilitySupportState,
  OutputConfig,
  OutputConfigApplyStatus,
  HeadphoneCompensationSettings
} from '../../../shared/audioEngineTypes.ts'
export type {
  AppTheme,
  CloseWindowBehavior,
  PlaybackResumeMode,
  PreviousButtonAction,
  NcmPlaybackQuality,
  StartupHomePage,
  HomePageMode,
  TrackActivationMode,
  UiDensity,
  ProxyMode,
  NowPlayingBackground,
  NowPlayingFluidSettings,
  StreamingAudioCachePolicy,
  AppBackgroundPage,
  AppBackgroundKind,
  AppBackgroundEffect,
  BackgroundTextTone,
  AppBackgroundColorPair,
  AppBackgroundPageOverride,
  AppBackgroundSettings,
  CardShadowStrength,
  CardHoverEffect,
  CardAppearanceTheme,
  BackgroundEffectTheme,
  BackgroundEffectSettings,
  CardAppearanceSettings,
  WindowTransparencyEffectSettings,
  DesktopLyricsPalette,
  DesktopLyricsSettings,
  MusicCachePolicySettings,
  AudioEqPreset,
  GlobalShortcutSettings,
  AppSettings,
  SettingsSnapshotMetadata as SettingsSnapshot
} from '../../../shared/appSettings.ts'

export type { MiniPlayerSettings } from '../../../shared/miniPlayer.ts'
export type { AfterglowAutoEntry, AfterglowModeStatus } from '../../../shared/afterglowMode.ts'
export type { MotionPreference } from '../../../shared/motion.ts'
export type {
  LiquidGlassCoverage,
  LiquidGlassSettings,
  LiquidGlassTheme,
  SurfaceMaterial
} from '../../../shared/liquidGlass.ts'
export type {
  PlayerBarMode,
  PlayerBarPageMode,
  PlayerBarPresentation,
  PlayerBarSettings,
  PlayerBarVisibility
} from '../../../shared/playerBar.ts'
export type {
  LyricsAppearanceAlign,
  LyricsAppearanceColorMode,
  LyricsAppearanceFontFamily,
  LyricsAppearanceSettings,
  LyricsFocusLineCount
} from '../../../shared/lyricsAppearance.ts'

import type { PlayerShortcutAction } from '../../../shared/playerShortcuts.ts'
export type { PlayerShortcutAction } from '../../../shared/playerShortcuts.ts'

export type { DsdRouteSettings } from '../../../shared/audioProcessingOptions.ts'

export interface PlayerShortcutStatus {
  accelerator: string
  action: PlayerShortcutAction
  label: string
  registered: boolean
  enabled?: boolean
  error: string | null
}
