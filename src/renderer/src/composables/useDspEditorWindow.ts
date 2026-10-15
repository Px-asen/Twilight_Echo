import { nextTick, onBeforeUnmount, shallowRef } from 'vue'

export const dspEditorDocumentVisible = shallowRef(false)

// Render the existing editor into a same-origin native window. No second Pinia
// instance, playback controller, engine initialization, or draft writer is started.
export function useDspEditorWindow(onChange: (detached: boolean) => void) {
  const target = shallowRef<HTMLElement | null>(null)
  let child: Window | null = null
  let observer: MutationObserver | null = null
  let closedCheck: ReturnType<typeof setInterval> | null = null

  function release(notify = true): void {
    observer?.disconnect()
    observer = null
    if (closedCheck) clearInterval(closedCheck)
    closedCheck = null
    child = null
    target.value = null
    dspEditorDocumentVisible.value = false
    if (notify) onChange(false)
  }

  function focus(): void {
    if (child && !child.closed) child.focus()
  }

  function open(): void {
    if (child && !child.closed) {
      focus()
      return
    }
    const opened = window.open('about:blank', 'twilight-dsp-editor')
    if (!opened) throw new Error('无法打开 DSP 窗口，请重试。')
    child = opened
    try {
      const doc = opened.document
      doc.title = 'DSP · Twilight Echo'
      const styles = doc.createElement('div')
      const styleCopies = new Map<Element, HTMLElement>()
      const windowStyle = doc.createElement('style')
      windowStyle.textContent = `
        html.dsp-editor-document { --te-titlebar-inset: 0px; --te-playbar-bottom-clearance: 0px; }
        html.dsp-editor-document, .dsp-editor-document body, .dsp-editor-document #app {
          margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
          background: var(--te-app-bg, #202024);
        }
        .dsp-editor-document body::before, .dsp-editor-document body::after { display: none; }
        .dsp-editor-document .audio-workspace { height: 100dvh; padding: 24px 24px 0; }
      `
      const sync = (): void => {
        if (opened.closed) return
        for (const attribute of [...doc.documentElement.attributes])
          if (!document.documentElement.hasAttribute(attribute.name))
            doc.documentElement.removeAttribute(attribute.name)
        for (const attribute of [...document.documentElement.attributes]) {
          const value =
            attribute.name === 'class' ? `${attribute.value} dsp-editor-document` : attribute.value
          if (doc.documentElement.getAttribute(attribute.name) !== value)
            doc.documentElement.setAttribute(attribute.name, value)
        }
        doc.documentElement.classList.add('dsp-editor-document')
        doc.body.className = document.body.className
        const sources = [...document.head.querySelectorAll('style, link[rel="stylesheet"]')]
        for (const [source, clone] of styleCopies) {
          if (!sources.includes(source)) {
            clone.remove()
            styleCopies.delete(source)
          }
        }
        for (const source of sources) {
          let clone = styleCopies.get(source)
          if (!clone) {
            clone = source.cloneNode(true) as HTMLElement
            if (source instanceof HTMLLinkElement) clone.setAttribute('href', source.href)
            styleCopies.set(source, clone)
            styles.append(clone)
          } else if (source.tagName === 'STYLE' && clone.textContent !== source.textContent) {
            clone.textContent = source.textContent
          } else if (
            source instanceof HTMLLinkElement &&
            clone.getAttribute('href') !== source.href
          ) {
            clone.setAttribute('href', source.href)
          }
        }
        // The override follows theme styles, including lazily loaded editor CSS.
        doc.head.append(windowStyle)
      }
      doc.head.append(styles)
      const appRoot = doc.createElement('div')
      appRoot.id = 'app'
      const host = doc.createElement('div')
      host.id = 'dsp-editor-root'
      appRoot.append(host)
      doc.body.replaceChildren(appRoot)
      sync()
      const syncVisibility = (): void => {
        if (child === opened) dspEditorDocumentVisible.value = !opened.closed && !doc.hidden
      }
      doc.addEventListener('visibilitychange', syncVisibility)
      syncVisibility()
      observer = new MutationObserver(sync)
      observer.observe(document.documentElement, { attributes: true })
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      })
      opened.addEventListener('beforeunload', () => {
        if (child === opened) release()
      })
      closedCheck = setInterval(() => {
        if (opened.closed && child === opened) release()
      }, 500)
      target.value = host
      onChange(true)
      focus()
    } catch (error) {
      release()
      opened.close()
      throw error
    }
  }

  async function dock(): Promise<void> {
    const opened = child
    release()
    // Move the same DOM and component instances home before closing the view.
    await nextTick()
    if (opened && !opened.closed) opened.close()
  }

  onBeforeUnmount(() => {
    const opened = child
    release(false)
    if (opened && !opened.closed) opened.close()
  })
  return { target, open, dock, focus }
}
