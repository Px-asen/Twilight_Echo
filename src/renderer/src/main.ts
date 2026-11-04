import './assets/main.css'
import { installRendererDiagnostics, installVueDiagnostics } from './app/diagnostics.ts'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { bootstrapThemeRuntime } from './stores/useThemeStore'
import { beginStartupSnapshot } from './app/startupSnapshot'
import { installAutoHideScrollbars } from './utils/autoHideScrollbars'
import { installScrollToTopButton } from './utils/scrollToTopButton'
import { injectCachedThemeRuntime } from './app/themeRuntimeCache'
import { initializeCoreWindow } from './app/initializeCoreWindow.ts'
import { useCoreConnection } from './stores/coreConnection.ts'

const query = new URLSearchParams(window.location.search)
installRendererDiagnostics()
const windowKind = query.get('window')
const isMiniPlayer = windowKind === 'mini-player'
const isTrayPlayer = windowKind === 'tray-player'
const isDesktopLyrics = windowKind === 'desktop-lyrics'
const isDynamicIsland = windowKind === 'dynamic-island'
const isSatelliteWindow = isMiniPlayer || isTrayPlayer || isDesktopLyrics || isDynamicIsland
if (isSatelliteWindow) {
  const documentClass = isMiniPlayer
    ? 'mini-player-document'
    : isTrayPlayer
      ? 'tray-player-document'
      : isDesktopLyrics
        ? 'desktop-lyrics-document'
        : 'dynamic-island-document'
  document.documentElement.classList.add(documentClass)
  document.body.classList.add(documentClass)
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.style.padding = '0'
}

function applyExperienceWindowTheme(theme: string): void {
  const enabled = theme === 'rhine' || theme === 'rhine-night'
  document.documentElement.classList.toggle('rhine-experience-window', enabled)
  document.body.classList.toggle('rhine-experience-window', enabled)
  document.documentElement.dataset.experienceTone = theme === 'rhine-night' ? 'night' : 'day'
}

if (isSatelliteWindow) {
  applyExperienceWindowTheme(query.get('experienceTheme') || 'default')
  void import('./assets/rhineWindows.css')
  window.api.experienceWindow?.onTheme((theme) => applyExperienceWindowTheme(theme))
}

installAutoHideScrollbars()
if (!isSatelliteWindow) {
  injectCachedThemeRuntime()
  // The satellite windows are only a few hundred pixels tall, so a floating
  // back-to-top would cover more than it saves; the main window gets it for
  // every scroll container it owns.
  installScrollToTopButton()
}

// Chromium starts an OS drag for images, links, and arbitrary elements, letting
// users drag app content out of the window onto the desktop. Block every
// dragstart that did not originate on an explicitly draggable app surface.
// The app's intentional HTML5 drag-and-drop (playback queue reorder, DSP rack
// reorder, playlist-detail reorder) marks its rows draggable="true", so those
// keep working while everything else is confined to the window.
document.addEventListener(
  'dragstart',
  (event) => {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('[draggable="true"]')) {
      event.preventDefault()
    }
  },
  true
)

function createFallbackLoadingOverlay(): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-secondary,#9ca3af);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;z-index:9999;pointer-events:auto;'
  const dragBar = document.createElement('div')
  dragBar.style.cssText =
    'position:fixed;top:0;left:0;right:0;height:36px;-webkit-app-region:drag;'
  const label = document.createElement('div')
  label.textContent = '正在启动核心服务…'
  label.style.cssText = 'opacity:0.78;letter-spacing:0.02em;-webkit-app-region:no-drag;'
  overlay.append(dragBar, label)
  return overlay
}

async function mountApp(): Promise<void> {
  const iconsPromise = import('./assets/icon-fonts')
  const startupSnapshot = isSatelliteWindow ? null : beginStartupSnapshot()
  if (!isSatelliteWindow) {
    let loadingOverlay = null as HTMLDivElement | null
    const loadingTimer = setTimeout(() => {
      loadingOverlay = createFallbackLoadingOverlay()
      document.getElementById('app')?.append(loadingOverlay)
    }, 120)
    try {
      await initializeCoreWindow(useCoreConnection())
    } catch (error) {
      clearTimeout(loadingTimer)
      loadingOverlay?.remove()
      void iconsPromise.catch(() => null)
      const container = document.createElement('div')
      container.style.cssText =
        'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;box-sizing:border-box;color:var(--text-primary,#e5e7eb);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;z-index:9999;'
      const dragBar = document.createElement('div')
      dragBar.style.cssText =
        'position:fixed;top:0;left:0;right:0;height:36px;-webkit-app-region:drag;'
      const card = document.createElement('div')
      card.style.cssText =
        'max-width:520px;width:100%;padding:24px 28px;border-radius:14px;background:rgba(128,128,128,0.12);border:1px solid rgba(128,128,128,0.22);box-sizing:border-box;-webkit-app-region:no-drag;'
      const message = document.createElement('p')
      message.textContent = `Core 初始化未完成：${error instanceof Error ? error.message : String(error)}`
      message.style.cssText =
        'margin:0 0 18px;line-height:1.6;font-size:14px;word-break:break-word;white-space:pre-wrap;'
      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;'
      const buttonStyle =
        'padding:7px 16px;border-radius:8px;border:1px solid rgba(128,128,128,0.3);background:rgba(128,128,128,0.16);color:inherit;font-size:13px;cursor:pointer;'
      const retry = document.createElement('button')
      retry.textContent = '重试'
      retry.style.cssText = buttonStyle
      retry.onclick = () => {
        container.remove()
        void mountApp()
      }
      const closeBtn = document.createElement('button')
      closeBtn.textContent = '关闭应用'
      closeBtn.style.cssText = buttonStyle
      closeBtn.onclick = () => {
        if (window.api?.window?.close) window.api.window.close()
        else window.close()
      }
      actions.append(retry, closeBtn)
      card.append(message, actions)
      container.append(dragBar, card)
      document.getElementById('app')?.append(container)
      return
    }
    clearTimeout(loadingTimer)
    loadingOverlay?.remove()
  }
  const rootComponentPromise = isMiniPlayer
    ? import('./mini-player/MiniPlayerApp.vue')
    : isTrayPlayer
      ? import('./tray-player/TrayPlayerApp.vue')
      : isDesktopLyrics
        ? import('./desktop-lyrics/DesktopLyricsApp.vue')
        : isDynamicIsland
          ? import('./dynamic-island/DynamicIslandApp.vue')
          : import('./App.vue')
  const [, rootComponentModule] = await Promise.all([iconsPromise, rootComponentPromise])
  const rootComponent = rootComponentModule.default
  // The lyrics window reads no theme tokens: every colour arrives in its settings
  // payload, so it must not pay for (or wait on) the theme runtime.
  if (isMiniPlayer) await bootstrapThemeRuntime()
  const app = createApp(rootComponent).use(createPinia())
  installVueDiagnostics(app)
  app.mount('#app')
  void startupSnapshot
}

void mountApp()
