import type { AppSettings } from '../../shared/appSettings.ts'
import type { BrowserWindow } from 'electron'

type WindowAppearanceSettings = {
  theme: AppSettings['theme']
  appBackground: { global: { dark: string; light: string } }
}

export function getWindowBackgroundColor(
  settings: WindowAppearanceSettings,
  systemDark: boolean
): string {
  if (settings.theme === 'dark') return settings.appBackground.global.dark
  if (settings.theme === 'system' && systemDark) {
    return settings.appBackground.global.dark
  }
  return settings.appBackground.global.light
}

/** Avoid a theme-coloured DWM outline around edge-to-edge playback content. */
export function syncWindowFrameColor(
  win: Pick<BrowserWindow, 'setAccentColor'>,
  highContrast: boolean
): void {
  if (process.platform !== 'win32') return
  win.setAccentColor(highContrast ? null : false)
}
