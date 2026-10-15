import { onBeforeUnmount, onMounted, watch, type ComputedRef, type Ref } from 'vue'
import { LIQUID_GLASS_TUNING_CHANGED_EVENT } from '../../../shared/liquidGlass.ts'
import { loadLiquidGlassContextImage } from '../utils/liquidGlassContextImage'
import { refreshLiquidGlassRuntimeVariables } from '../stores/useThemeStore'
import type { AppBackgroundPage } from '../types/settings'
import {
  analyzeLiquidGlassColor,
  analyzeLiquidGlassPixels,
  extractCssImageUrl,
  fallbackLiquidGlassEnvironment,
  isTrustedLiquidGlassImageUrl,
  resolveAdaptiveGlassTone,
  type LiquidGlassEnvironment,
  type LiquidGlassTone
} from '../utils/liquidGlassEnvironment'

const RUNTIME_VARIABLES = [
  '--te-lg-context-rgb',
  '--te-lg-context-surface-alpha',
  '--te-lg-context-shadow-alpha',
  '--te-lg-context-diffusion',
  '--te-lg-context-rim-alpha',
  '--te-lg-context-label-rgb',
  '--te-lg-context-surface',
  '--te-lg-context-surface-solid',
  '--te-lg-context-material',
  '--te-lg-context-label',
  '--te-lg-context-shadow',
  '--te-lg-context-rim'
]

type EnvironmentRef<T> = Ref<T> | ComputedRef<T>

function rootToneIsDark(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

function sourceForPage(page: AppBackgroundPage): string | null {
  const styles = getComputedStyle(document.documentElement)
  const pageSource = extractCssImageUrl(styles.getPropertyValue(`--te-${page}-bg-image`))
  const themeSource = extractCssImageUrl(styles.getPropertyValue('--te-theme-background-image'))
  const appSource = extractCssImageUrl(styles.getPropertyValue('--te-app-bg-image'))
  if (pageSource ?? themeSource ?? appSource) return pageSource ?? themeSource ?? appSource

  // Sample the actual page backdrop, never artwork contained in a content card.
  return null
}

function sampleImage(image: HTMLImageElement, isDark: boolean): LiquidGlassEnvironment {
  const canvas = document.createElement('canvas')
  canvas.width = 48
  canvas.height = 48
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return fallbackLiquidGlassEnvironment(isDark)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return analyzeLiquidGlassPixels(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    isDark
  )
}

function applyEnvironment(environment: LiquidGlassEnvironment, tone: LiquidGlassTone): void {
  const root = document.documentElement
  root.dataset.teLiquidGlassContext = environment.context
  for (const [name, value] of Object.entries(environment.variables)) {
    root.style.setProperty(name, value)
  }
  root.style.setProperty('--te-lg-context-luminance', environment.luminance.toFixed(3))

  // Adaptive tone: publish the sampled decision, then re-resolve the glass
  // profiles so the material flips without waiting on the manual switch. The
  // hero sample doubles as the home decision — the hero art is the backdrop the
  // feature cards actually sit over on the local page.
  const adaptive = resolveAdaptiveGlassTone(environment.luminance, tone)
  const nextValue = adaptive === 'dark' ? 'dark' : 'light'
  if (
    root.dataset.teLiquidGlassAdaptiveTone !== nextValue ||
    root.dataset.teHomeLiquidGlassAdaptiveTone !== nextValue
  ) {
    root.dataset.teLiquidGlassAdaptiveTone = nextValue
    root.dataset.teHomeLiquidGlassAdaptiveTone = nextValue
    refreshLiquidGlassRuntimeVariables()
  }
}

function resolveCssVariable(styles: CSSStyleDeclaration, name: string): string {
  let value = styles.getPropertyValue(name).trim()
  for (let depth = 0; depth < 4; depth += 1) {
    const match = value.match(/^var\((--[\w-]+)\)$/)
    if (!match) break
    const next = styles.getPropertyValue(match[1]).trim()
    if (!next || next === value) break
    value = next
  }
  return value
}

function solidColorForPage(page: AppBackgroundPage): string | null {
  const styles = getComputedStyle(document.documentElement)
  const pageColor = resolveCssVariable(styles, `--te-${page}-bg`)
  if (pageColor && !pageColor.includes('gradient')) return pageColor
  const appColor = resolveCssVariable(styles, '--te-app-bg')
  return appColor && !appColor.includes('gradient') ? appColor : null
}

function clearEnvironment(): void {
  const root = document.documentElement
  delete root.dataset.teLiquidGlassContext
  delete root.dataset.teLiquidGlassSource
  delete root.dataset.teLiquidGlassScrolled
  delete root.dataset.teLiquidGlassAdaptiveTone
  delete root.dataset.teHomeLiquidGlassAdaptiveTone
  for (const name of RUNTIME_VARIABLES) root.style.removeProperty(name)
  root.style.removeProperty('--te-lg-context-luminance')
}

export function useLiquidGlassEnvironment(options: {
  active: EnvironmentRef<boolean>
  page: EnvironmentRef<AppBackgroundPage>
}): void {
  let sequence = 0
  let observer: MutationObserver | null = null
  let imageRequest: AbortController | null = null
  let environmentKey: string | null = null
  let refreshQueued = false
  let disposed = false

  async function refresh(): Promise<void> {
    if (disposed) return
    if (!options.active.value) {
      sequence++
      imageRequest?.abort()
      imageRequest = null
      environmentKey = null
      clearEnvironment()
      return
    }

    const isDark = rootToneIsDark()
    const tone: LiquidGlassTone = isDark ? 'dark' : 'light'
    const source = sourceForPage(options.page.value)
    const solidColor = source ? null : solidColorForPage(options.page.value)
    const nextKey = `${isDark}:${source ?? `solid:${solidColor ?? 'fallback'}`}`
    if (environmentKey === nextKey) return
    const currentSequence = ++sequence
    imageRequest?.abort()
    imageRequest = null
    environmentKey = nextKey
    if (!source || !isTrustedLiquidGlassImageUrl(source)) {
      if (solidColor) {
        applyEnvironment(analyzeLiquidGlassColor(solidColor, isDark), tone)
        document.documentElement.dataset.teLiquidGlassSource = 'solid'
        return
      }
      applyEnvironment(fallbackLiquidGlassEnvironment(isDark), tone)
      document.documentElement.dataset.teLiquidGlassSource = 'fallback'
      return
    }

    try {
      const request = new AbortController()
      imageRequest = request
      const image = await loadLiquidGlassContextImage(source, request.signal)
      if (disposed || currentSequence !== sequence || !options.active.value) return
      applyEnvironment(sampleImage(image, isDark), tone)
      document.documentElement.dataset.teLiquidGlassSource = 'image'
    } catch {
      if (!disposed && currentSequence === sequence && options.active.value) {
        applyEnvironment(fallbackLiquidGlassEnvironment(isDark), tone)
        document.documentElement.dataset.teLiquidGlassSource = 'fallback'
      }
    } finally {
      if (currentSequence === sequence) imageRequest = null
    }
  }

  function queueRefresh(): void {
    if (disposed || refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      if (!disposed) void refresh()
    })
  }

  function syncScrollEdge(event: Event): void {
    if (!options.active.value) return
    const target = event.target
    const scrollTop =
      target instanceof Element
        ? target.scrollTop
        : (document.scrollingElement?.scrollTop ?? document.documentElement.scrollTop)
    const next = scrollTop > 4 ? 'on' : 'off'
    if (document.documentElement.dataset.teLiquidGlassScrolled !== next) {
      document.documentElement.dataset.teLiquidGlassScrolled = next
    }
  }

  onMounted(() => {
    queueRefresh()
    window.addEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, queueRefresh)
    document.addEventListener('scroll', syncScrollEdge, { capture: true, passive: true })
    observer = new MutationObserver(queueRefresh)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-active-theme', 'data-te-surface-material', 'style']
    })

  })

  onBeforeUnmount(() => {
    disposed = true
    sequence++
    imageRequest?.abort()
    imageRequest = null
    clearEnvironment()
    window.removeEventListener(LIQUID_GLASS_TUNING_CHANGED_EVENT, queueRefresh)
    document.removeEventListener('scroll', syncScrollEdge, true)
    observer?.disconnect()
  })

  watch([options.active, options.page], queueRefresh)
}
