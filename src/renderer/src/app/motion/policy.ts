import { resolveMotionMode, type ResolvedMotionMode } from '../../../../shared/motion.ts'

type Listener = () => void
interface Policy {
  input: 'pointer' | 'keyboard'
  listeners: Set<Listener>
  release(): void
}
/** Presentation capability shared by CSS entry effects and programmatic motion. */
function publishInput(document: Document, value: Policy['input']): void {
  document.documentElement.dataset.teMotionInput = value
}
const policies = new WeakMap<Document, Policy>()

/** One input and preference observer per window, shared by the motion owners. */
export function observeMotionPolicy(document: Document, listener: Listener): () => void {
  let policy = policies.get(document)
  if (!policy) {
    const listeners = new Set<Listener>()
    const notify = (): void => {
      for (const fn of [...listeners]) fn()
    }
    const pointer = (): void => {
      policy!.input = 'pointer'
      publishInput(document, 'pointer')
    }
    const keyboard = (): void => {
      policy!.input = 'keyboard'
      publishInput(document, 'keyboard')
      notify()
    }
    const click = (event: MouseEvent): void => {
      if (!event.isTrusted) return
      policy!.input = event.detail === 0 ? 'keyboard' : 'pointer'
      publishInput(document, policy!.input)
      if (policy!.input === 'keyboard') notify()
    }
    const view = document.defaultView!
    const media = view.matchMedia('(prefers-reduced-motion: reduce)')
    const observer = new view.MutationObserver(notify)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-te-motion', 'data-te-visibility']
    })
    document.addEventListener('pointerdown', pointer, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', keyboard, true)
    document.addEventListener('visibilitychange', notify)
    media.addEventListener('change', notify)
    policy = {
      input: 'pointer',
      listeners,
      release() {
        observer.disconnect()
        document.removeEventListener('pointerdown', pointer, true)
        document.removeEventListener('click', click, true)
        document.removeEventListener('keydown', keyboard, true)
        document.removeEventListener('visibilitychange', notify)
        media.removeEventListener('change', notify)
        policies.delete(document)
      }
    }
    policies.set(document, policy)
    publishInput(document, policy.input)
  }
  policy.listeners.add(listener)
  return () => {
    policy!.listeners.delete(listener)
    if (!policy!.listeners.size) policy!.release()
  }
}

export function surfaceMotionMode(document: Document): ResolvedMotionMode {
  if (
    document.hidden ||
    document.documentElement.dataset.teVisibility === 'hidden' ||
    policies.get(document)?.input === 'keyboard'
  )
    return 'off'
  const mode = document.documentElement.dataset.teMotion
  if (mode === 'full' || mode === 'reduced' || mode === 'off') return mode
  return resolveMotionMode(
    'system',
    document.defaultView!.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function motionDuration(element: HTMLElement, token: string, fallback: number): number {
  const value = element.ownerDocument
    .defaultView!.getComputedStyle(element)
    .getPropertyValue(token)
    .trim()
  const duration = Number.parseFloat(value) * (value.endsWith('ms') ? 1 : 1000)
  return Number.isFinite(duration) && duration >= 0 ? duration : fallback
}

export type PageMotionName = 'page-up' | 'page-down' | 'page-forward' | 'page-back'
