import { app } from 'electron'
import { assertLegacySettingsWriter } from '../coreProcess/settingsBridge.ts'
import { execFile, execFileSync } from 'node:child_process'
import { release } from 'node:os'
import { join, resolve } from 'node:path'
import { writeDiagnostic } from '../diagnostics/logger.ts'
import type { AppSettings, SettingsSnapshot } from './types'
import { startupExperienceKey } from '../../shared/pluginExperience.ts'
import {
  loadSettingsFile,
  writeSettingsFile,
  type SettingsFileLoadIssue
} from '../persistence/settingsFile.ts'
import {
  createDefaultSettings,
  normalizeAppSettings as normalizePortableSettings
} from '../../core/settings/normalization.ts'
export {
  DEFAULT_DESKTOP_LYRICS,
  DEFAULT_MUSIC_CACHE_POLICY,
  DEFAULT_GLOBAL_SHORTCUT_BINDINGS,
  clampNumber,
  normalizeProxyMode,
  compareVersions,
  normalizeAudioEqPresets,
  normalizeBuiltInAudioEqPresets,
  normalizeAppTheme,
  normalizePlaybackResumeMode,
  normalizePreviousButtonAction,
  normalizeNcmPlaybackQuality,
  normalizeStartupHomePage,
  normalizeTrackActivationMode,
  normalizeAfterglowAutoEntry,
  normalizeStreamingAudioCachePolicy,
  normalizeShortcutAccelerator,
  normalizeGlobalShortcutBindings,
  normalizeMusicCachePolicy,
  normalizePlayMode,
  ACCENT_COLORS,
  normalizeAccentColor,
  normalizeLightAccentColor,
  normalizeDarkAccentColor,
  normalizeStringArray,
  normalizeUiDensity,
  normalizeNowPlayingBackground,
  normalizeHexColor,
  normalizeBackgroundKind,
  normalizeBackgroundImageHandle,
  APP_BACKGROUND_PAGES,
  normalizeAppBackground,
  CARD_SHADOW_STRENGTHS,
  CARD_HOVER_EFFECTS,
  normalizeCardShadowStrength,
  normalizeCardHoverEffect,
  normalizeCardAppearanceTheme,
  normalizeWindowTransparencyEffect,
  normalizeBackgroundEffectTheme,
  normalizeCardAppearance,
  normalizePluginThemeId,
  isDefaultAudioDeviceAlias,
  normalizeAudioDevice,
  normalizeOutputConfig,
  normalizeDesktopLyrics,
  normalizeSleepTimerSettings
} from '../../core/settings/normalization.ts'
export {
  normalizeChannelRoutingMode,
  normalizePcmToDsdMode
} from '../../shared/audioOutputConfig.ts'

let appSettingsLoadIssue: SettingsFileLoadIssue | null = null
export const DEFAULT_SETTINGS = createDefaultSettings(process.platform)
export function normalizeAppSettings(settings: Partial<AppSettings>): AppSettings {
  return normalizePortableSettings(settings, {
    platform: process.platform,
    defaultCachePath: getDefaultCachePath(),
    resolvePath: resolve
  })
}

export function getSettingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function getDefaultCachePath(): string {
  return join(app.getPath('userData'), 'music-cache')
}

export function getOpraDatabaseCachePath(): string {
  return join(app.getPath('userData'), 'opra', 'database_v1.jsonl')
}

export function readAppSettings(): AppSettings {
  const started = performance.now()
  writeDiagnostic('settings', 'load.start', {}, 'debug')
  const result = loadSettingsFile(getSettingsFilePath(), DEFAULT_SETTINGS, normalizeAppSettings)
  appSettingsLoadIssue = result.issue
  writeDiagnostic('settings', 'load.complete', {
    durationMs: performance.now() - started,
    issue: result.issue?.kind ?? null
  })
  if (result.issue?.kind === 'recovered') {
    console.warn('[persistence] application settings recovered from backup')
  } else if (result.issue?.kind === 'corrupt') {
    console.error('[persistence] application settings are corrupt; using defaults for this run')
  }
  return result.settings
}

export function writeAppSettings(settings: AppSettings): void {
  assertLegacySettingsWriter()
  const started = performance.now()
  try {
    writeSettingsFile(getSettingsFilePath(), settings)
    writeDiagnostic(
      'settings',
      'save.complete',
      { durationMs: performance.now() - started, keys: Object.keys(settings).length },
      'debug'
    )
  } catch (error) {
    writeDiagnostic('settings', 'save.failed', { error }, 'error')
    throw error
  }
}

export function consumeAppSettingsLoadIssue(): SettingsFileLoadIssue | null {
  const issue = appSettingsLoadIssue
  appSettingsLoadIssue = null
  return issue
}

export function getRestartReasons(settings: AppSettings, launch: AppSettings): string[] {
  const reasons: string[] = []
  if (
    startupExperienceKey(settings.startupExperience) !==
    startupExperienceKey(launch.startupExperience)
  ) {
    reasons.push('完整界面')
  }
  if (settings.hardwareAcceleration !== launch.hardwareAcceleration) {
    reasons.push('GPU 加速')
  }
  if (settings.windowTransparency !== launch.windowTransparency) {
    reasons.push('窗口透明')
  }
  if (resolve(settings.musicCachePath) !== resolve(launch.musicCachePath)) {
    reasons.push('缓存位置')
  }
  if (
    settings.proxyMode !== launch.proxyMode ||
    settings.proxyHost !== launch.proxyHost ||
    settings.proxyPort !== launch.proxyPort ||
    settings.proxyAllowDirectFallback !== launch.proxyAllowDirectFallback
  ) {
    reasons.push('插件代理')
  }
  return reasons
}

// Win11 22H2 (build 22621) 及以上才支持 DWM 原生亚克力背板。
export function isWindowsAcrylicBuild(): boolean {
  if (process.platform !== 'win32') return false
  const build = Number(release().split('.')[2] ?? 0)
  return Number.isFinite(build) && build >= 22621
}

// 透明窗口支持判定：
// - Linux Wayland：合成器忽略逐像素 alpha，内容可能整窗不渲染（黑屏）→ 不支持；
// - Windows：逐像素透明（transparent: true）在 DWM/部分 GPU 下会整窗黑屏且卡住，
//   只有系统开启"透明效果"、能用 DWM 原生亚克力时才安全 → 否则视为不支持；
// - 其余平台（X11/macOS）支持。
// 不支持的平台回退为不透明窗口，保证应用始终可见。
export function supportsNativeWindowTransparency(): boolean {
  if (process.platform === 'linux') {
    if (process.env['WAYLAND_DISPLAY'] || process.env['XDG_SESSION_TYPE'] === 'wayland') {
      return false
    }
    return true
  }
  if (process.platform === 'win32') {
    return isWindowsAcrylicBuild() && isWindowsAcrylicBackdropAvailable()
  }
  return true
}

// Win11 的原生亚克力（backgroundMaterial）依赖系统"透明效果"开关：
// 关闭时 DWM 不提供系统背板，Electron 会把窗口画成灰色。
// 这里读注册表检测该开关，供窗口层决定是否使用亚克力（而非逐像素透明）。
let windowsAcrylicBackdropAvailableCache: boolean | null = null
const TRANSPARENCY_REG_ARGS = [
  'query',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
  '/v',
  'EnableTransparency'
]

// 读不到注册表时不做强判，交给 Electron 的默认回退行为。
function parseTransparencyQuery(output: string): boolean {
  const match = /EnableTransparency\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output)
  return match ? parseInt(match[1], 16) === 1 : true
}

export function isWindowsAcrylicBackdropAvailable(): boolean {
  if (process.platform !== 'win32') return false
  if (windowsAcrylicBackdropAvailableCache !== null) {
    return windowsAcrylicBackdropAvailableCache
  }
  try {
    const output = execFileSync('reg', TRANSPARENCY_REG_ARGS, { encoding: 'utf8', timeout: 3000 })
    windowsAcrylicBackdropAvailableCache = parseTransparencyQuery(output)
  } catch {
    windowsAcrylicBackdropAvailableCache = true
  }
  return windowsAcrylicBackdropAvailableCache
}

// 启动时异步预热，避免建窗时同步起 reg.exe 阻塞主进程。
export function warmWindowsAcrylicBackdropAvailability(): Promise<void> {
  if (process.platform !== 'win32' || windowsAcrylicBackdropAvailableCache !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    execFile('reg', TRANSPARENCY_REG_ARGS, { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
      windowsAcrylicBackdropAvailableCache ??= error ? true : parseTransparencyQuery(stdout)
      resolve()
    })
  })
}

export function createSettingsSnapshot(
  settings: AppSettings,
  launch: AppSettings
): SettingsSnapshot {
  const restartReasons = getRestartReasons(settings, launch)
  return {
    ...settings,
    settings: { ...settings },
    defaults: {
      cachePath: getDefaultCachePath()
    },
    paths: {
      settingsFile: getSettingsFilePath(),
      userDataPath: app.getPath('userData'),
      activeCachePath: launch.musicCachePath || getDefaultCachePath()
    },
    appVersion: app.getVersion(),
    platform: process.platform,
    windowTransparencySupported: supportsNativeWindowTransparency(),
    restartRequired: restartReasons.length > 0,
    restartReasons
  }
}
