import { resolveMotionMode, type ResolvedMotionMode } from '../../../shared/motion.ts'

export interface UiMotionHandle {
  readonly enabled: boolean
  readonly finished: Promise<void>
  cancel(): void
}
export interface UiMotionTiming {
  duration: number
  delay?: number
  easing?: string
}
export interface UiMotionVariant {
  keyframes: Keyframe[]
  timing: UiMotionTiming
}
export interface UiMotionPreset {
  full: UiMotionVariant
  reduced?: UiMotionVariant
}
export interface UiMotionEdgeOptions {
  edges?: 'all' | 'bottom'
  radius?: number
  duration?: number
  color?: string
}
export interface UiMotionController {
  control(target: HTMLElement, name: string, options?: Partial<UiMotionTiming>): UiMotionHandle
  edge(target: HTMLElement, options?: UiMotionEdgeOptions): UiMotionHandle
  register(name: string, preset: UiMotionPreset): () => void
  dispose(): void
}

const controllers = new WeakMap<Document, UiMotionController>()
const disabled: UiMotionHandle = {
  enabled: false,
  finished: Promise.resolve(),
  cancel: () => undefined
}
type Channel = 'control' | 'edge'
interface Job {
  target: HTMLElement
  channel: Channel
  mode: ResolvedMotionMode
  cancel(): void
}

/** A document owns the controller; callers cancel their handles on unmount. */
export function uiMotionFor(document: Document): UiMotionController {
  const existing = controllers.get(document)
  if (existing) return existing
  const view = document.defaultView
  const jobs = new Set<Job>()
  const targets = new WeakMap<HTMLElement, Map<Channel, Job>>()
  const presets = new Map<string, UiMotionPreset>([
    [
      'reveal',
      { full: { keyframes: [{ opacity: 0 }, { opacity: 1 }], timing: { duration: 220 } } }
    ],
    [
      'press',
      {
        full: {
          keyframes: [{ opacity: 1 }, { opacity: 0.82 }, { opacity: 1 }],
          timing: { duration: 110 }
        },
        reduced: { keyframes: [{ opacity: 0.86 }, { opacity: 1 }], timing: { duration: 80 } }
      }
    ]
  ])
  let disposed = false
  let observer: MutationObserver | undefined
  let media: MediaQueryList | undefined

  function mode(): ResolvedMotionMode {
    const preference = document.documentElement.dataset.teMotion
    if (preference === 'full' || preference === 'reduced' || preference === 'off') return preference
    return resolveMotionMode(
      'system',
      (media ?? view?.matchMedia?.('(prefers-reduced-motion: reduce)'))?.matches === true
    )
  }
  function visible(): boolean {
    return !document.hidden && document.documentElement.dataset.teVisibility !== 'hidden'
  }
  function stopWatching(): void {
    observer?.disconnect()
    observer = undefined
    media?.removeEventListener('change', policyChanged)
    media = undefined
    document.removeEventListener('visibilitychange', policyChanged)
  }
  function policyChanged(): void {
    const current = mode()
    for (const job of [...jobs]) if (!visible() || current !== job.mode) job.cancel()
  }
  function watchPolicy(): void {
    if (observer || !view) return
    observer = new view.MutationObserver(policyChanged)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-te-motion', 'data-te-visibility']
    })
    media = view.matchMedia?.('(prefers-reduced-motion: reduce)')
    media?.addEventListener('change', policyChanged)
    document.addEventListener('visibilitychange', policyChanged)
  }
  function supersede(target: HTMLElement, channel: Channel): void {
    targets.get(target)?.get(channel)?.cancel()
  }
  function available(target: HTMLElement): boolean {
    return (
      !disposed && !!view && visible() && target.isConnected && target.ownerDocument === document
    )
  }
  function play(
    target: HTMLElement,
    animated: HTMLElement,
    channel: Channel,
    current: ResolvedMotionMode,
    keyframes: Keyframe[],
    timing: UiMotionTiming,
    cleanup: () => void = () => {}
  ): UiMotionHandle {
    let animation: Animation
    try {
      animation = animated.animate(keyframes, {
        ...timing,
        iterations: 1,
        fill: 'none',
        easing: timing.easing ?? 'ease-out'
      })
    } catch {
      cleanup()
      return disabled
    }
    let done = false
    let resolveFinished!: () => void
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const job: Job = {
      target,
      channel,
      mode: current,
      cancel() {
        if (done) return
        done = true
        animation.cancel()
        cleanup()
        jobs.delete(job)
        const channels = targets.get(target)
        if (channels?.get(channel) === job) channels.delete(channel)
        if (!jobs.size) stopWatching()
        resolveFinished()
      }
    }
    jobs.add(job)
    let channels = targets.get(target)
    if (!channels) {
      channels = new Map()
      targets.set(target, channels)
    }
    channels.set(channel, job)
    void animation.finished.then(job.cancel, job.cancel)
    watchPolicy()
    return { enabled: true, finished, cancel: job.cancel }
  }

  const controller: UiMotionController = {
    control(target, name, options = {}) {
      supersede(target, 'control')
      if (!available(target) || typeof target.animate !== 'function') return disabled
      if (
        name === 'press' &&
        (target.matches(':disabled') || target.closest('[inert], [aria-disabled="true"]'))
      )
        return disabled
      const current = mode()
      const preset = presets.get(name)
      if (current === 'off' || !preset) return disabled
      const variant =
        current === 'reduced'
          ? (preset.reduced ?? {
              keyframes: [{ opacity: 0 }, { opacity: 1 }],
              timing: { duration: 100 }
            })
          : preset.full
      const timing = { ...variant.timing, ...options }
      if (!Number.isFinite(timing.duration) || timing.duration <= 0) return disabled
      if (current === 'reduced') {
        timing.duration = Math.min(timing.duration, 120)
        timing.delay = 0
      }
      // Only control opacity and optional local transforms. Preserve the layout transform.
      const base =
        current === 'full' && variant.keyframes.some((frame) => frame.transform !== undefined)
          ? view!.getComputedStyle(target).transform
          : 'none'
      const keyframes = variant.keyframes.map((frame) => {
        const result: Keyframe = {
          opacity: frame.opacity,
          offset: frame.offset,
          easing: frame.easing
        }
        if (current === 'full' && frame.transform !== undefined)
          result.transform =
            `${base === 'none' ? '' : base} ${frame.transform === 'none' ? '' : frame.transform}`.trim() ||
            'none'
        return result
      })
      return play(target, target, 'control', current, keyframes, timing)
    },
    edge(target, options = {}) {
      supersede(target, 'edge')
      if (!available(target) || mode() !== 'full' || !document.body) return disabled
      const duration = options.duration ?? 700
      if (!Number.isFinite(duration) || duration <= 0) return disabled
      const rect = target.getBoundingClientRect()
      if (!rect.width || !rect.height) return disabled
      const layer = document.createElement('div')
      layer.className = 'te-ui-motion-edge'
      layer.dataset.edges = options.edges ?? 'all'
      layer.setAttribute('aria-hidden', 'true')
      Object.assign(layer.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        borderRadius:
          options.radius === undefined
            ? view!.getComputedStyle(target).borderRadius
            : `${Math.max(0, options.radius)}px`
      })
      if (options.color) layer.style.setProperty('--te-ui-motion-edge-color', options.color)
      document.body.append(layer)
      return play(
        target,
        layer,
        'edge',
        'full',
        [{ opacity: 0 }, { opacity: 0.85, offset: 0.24 }, { opacity: 0 }],
        { duration },
        () => layer.remove()
      )
    },
    register(name, preset) {
      if (disposed) return () => {}
      const previous = presets.get(name)
      presets.set(name, preset)
      return () => {
        if (presets.get(name) !== preset) return
        if (previous) presets.set(name, previous)
        else presets.delete(name)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const job of [...jobs]) job.cancel()
      stopWatching()
      presets.clear()
      controllers.delete(document)
    }
  }
  controllers.set(document, controller)
  return controller
}
