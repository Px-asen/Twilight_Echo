import { WORKSHOP_SURFACE_SELECTORS } from '../../../../shared/themeWorkshopLayerCss'
import { WORKSHOP_LAYER_LIMIT } from '../../../../shared/themeWorkshopLayers'

export function mountWorkshopDecorations(doc: Document): () => void {
  const selector = Object.values(WORKSHOP_SURFACE_SELECTORS).join(',')
  const style = doc.createElement('style')
  style.textContent =
    '.workshop-decoration{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1;border-radius:inherit}.workshop-decoration>div{display:none;position:absolute;pointer-events:none}'
  doc.head.append(style)
  let scheduled = false
  let disposed = false
  const update = (): void => {
    scheduled = false
    if (disposed) return
    for (const host of doc.querySelectorAll(selector)) {
      if (host.querySelector(':scope > .workshop-decoration')) continue
      const decoration = doc.createElement('div')
      decoration.className = 'workshop-decoration'
      decoration.setAttribute('aria-hidden', 'true')
      decoration.inert = true
      for (let index = 0; index < WORKSHOP_LAYER_LIMIT; index++)
        decoration.append(doc.createElement('div'))
      host.prepend(decoration)
    }
  }
  const observer = new MutationObserver((records) => {
    if (
      scheduled ||
      !records.some((record) =>
        [...record.addedNodes].some(
          (node) =>
            node.nodeType === 1 && !(node as Element).classList.contains('workshop-decoration')
        )
      )
    )
      return
    scheduled = true
    queueMicrotask(update)
  })
  const scroll = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    let host: Element | null = target
    while (host) {
      if (host.matches(selector))
        (host as HTMLElement).style.setProperty('--te-workshop-scroll-y', target.scrollTop + 'px')
      host = host.parentElement
    }
  }
  doc.addEventListener('scroll', scroll, true)
  update()
  observer.observe(doc.body, { childList: true, subtree: true })
  return () => {
    disposed = true
    observer.disconnect()
    doc.removeEventListener('scroll', scroll, true)
    style.remove()
    doc.querySelectorAll('.workshop-decoration').forEach((node) => node.remove())
  }
}
