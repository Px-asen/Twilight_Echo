import { themeContrastRatio } from '../../../shared/theme'

const layers = new WeakMap<Document, Set<HTMLElement>>()
function syncFallbackTone(document: Document, page: string): void {
  const root = document.documentElement
  const name = `data-te-${page}-image-fallback-tone`
  const layer = [...(layers.get(document) ?? [])].find(
    (element) =>
      (element.dataset.backgroundPage ?? 'local') === page &&
      ['loading', 'error'].includes(element.dataset.backgroundImageState ?? '')
  )
  let tone: string | null = null
  if (layer) {
    const color = document.defaultView?.getComputedStyle(layer).backgroundColor ?? '#ffffff'
    tone =
      (themeContrastRatio('#ffffff', color) ?? 0) > (themeContrastRatio('#000000', color) ?? 0)
        ? 'light'
        : 'dark'
  }
  if (root.getAttribute(name) === tone) return
  if (tone) root.setAttribute(name, tone)
  else root.removeAttribute(name)
}

/** Keep image-only tuning from darkening the fallback color while an asset is unavailable. */
export function mountBackgroundImageFallback(layer: HTMLElement, changed?: () => void) {
  const view = layer.ownerDocument.defaultView
  let page = layer.dataset.backgroundPage ?? 'local'
  const registered = layers.get(layer.ownerDocument) ?? new Set<HTMLElement>()
  registered.add(layer)
  layers.set(layer.ownerDocument, registered)
  let source = ''
  let image: HTMLImageElement | undefined
  let disposed = false
  const state = (value?: 'loading' | 'ready' | 'error') => {
    if (layer.dataset.backgroundImageState === value) return
    if (value) layer.dataset.backgroundImageState = value
    else delete layer.dataset.backgroundImageState
    syncFallbackTone(layer.ownerDocument, page)
    changed?.()
  }
  const release = () => {
    if (image) image.onload = image.onerror = null
    image = undefined
  }
  const refresh = () => {
    if (!view || disposed) return
    const nextPage = layer.dataset.backgroundPage ?? 'local'
    if (page !== nextPage) {
      const previousPage = page
      page = nextPage
      syncFallbackTone(layer.ownerDocument, previousPage)
    }
    // Read the resolved input token, which remains intact when the fallback
    // temporarily hides the painted image after a loading error.
    const value = view.getComputedStyle(layer).getPropertyValue('--appearance-image').trim()
    syncFallbackTone(layer.ownerDocument, page)
    if (value === source) return
    source = value
    release()
    const url = value.match(/^url\(["']?(.*?)["']?\)$/)?.[1]
    if (!url) {
      state()
      return
    }
    state('loading')
    const pending = layer.ownerDocument.createElement('img')
    image = pending
    pending.onload = () => {
      if (!disposed && image === pending) state('ready')
    }
    pending.onerror = () => {
      if (!disposed && image === pending) state('error')
    }
    pending.src = url
  }
  const observer = new MutationObserver(refresh)
  observer.observe(layer.ownerDocument.documentElement, { attributes: true })
  refresh()
  return {
    refresh,
    dispose() {
      disposed = true
      release()
      observer.disconnect()
      registered.delete(layer)
      syncFallbackTone(layer.ownerDocument, page)
    }
  }
}
