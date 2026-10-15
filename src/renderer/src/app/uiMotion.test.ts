import assert from 'node:assert/strict'
import test from 'node:test'
import { uiMotionFor, type UiMotionPreset } from './uiMotion.ts'

interface FakeAnimation {
  keyframes: Keyframe[]
  timing: KeyframeAnimationOptions
  cancelled: boolean
  finished: Promise<void>
  finish(): void
  cancel(): void
}
interface FakeElement {
  ownerDocument: Document
  isConnected: boolean
  className: string
  dataset: Record<string, string>
  children: unknown[]
  style: Record<string, string>
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | undefined
  matches(selector: string): boolean
  closest(selector: string): FakeElement | null
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  animate(keyframes: Keyframe[], timing: KeyframeAnimationOptions): FakeAnimation
  remove(): void
}

function environment(preference?: string, reduced = false) {
  const observers = new Set<Observer>()
  const documentListeners = new Map<string, Set<() => void>>()
  const mediaListeners = new Set<() => void>()
  const animations: FakeAnimation[] = []
  const layers: FakeElement[] = []
  const reads = { rect: 0, style: 0 }
  const root = { dataset: { teMotion: preference, teVisibility: 'visible' } }
  const media = {
    matches: reduced,
    addEventListener(_type: string, callback: () => void) {
      mediaListeners.add(callback)
    },
    removeEventListener(_type: string, callback: () => void) {
      mediaListeners.delete(callback)
    }
  }
  class Observer {
    callback: () => void
    constructor(callback: () => void) {
      this.callback = callback
    }
    observe() {
      observers.add(this)
    }
    disconnect() {
      observers.delete(this)
    }
  }
  function animation(keyframes: Keyframe[], timing: KeyframeAnimationOptions): FakeAnimation {
    let resolve!: () => void
    let reject!: (reason: Error) => void
    const result: FakeAnimation = {
      keyframes,
      timing,
      cancelled: false,
      finished: new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      }),
      finish() {
        resolve()
      },
      cancel() {
        result.cancelled = true
        reject(new Error('cancelled'))
      }
    }
    animations.push(result)
    return result
  }
  function element(): FakeElement {
    const attributes = new Map<string, string>()
    const style: Record<string, string> = {
      transform: 'matrix(1, 0, 0, 1, 24, 8)',
      borderRadius: '12px'
    }
    Object.defineProperty(style, 'setProperty', {
      value: (name: string, value: string) => {
        style[name] = value
      }
    })
    return {
      ownerDocument: document as unknown as Document,
      isConnected: true,
      className: '',
      dataset: {} as Record<string, string>,
      children: [] as unknown[],
      style,
      setAttribute(name: string, value: string) {
        attributes.set(name, value)
      },
      getAttribute(name: string) {
        return attributes.get(name)
      },
      matches(selector: string) {
        return selector === ':disabled' && attributes.has('disabled')
      },
      closest(selector: string) {
        return (selector.includes('inert') && attributes.has('inert')) ||
          (selector.includes('aria-disabled') && attributes.get('aria-disabled') === 'true')
          ? this
          : null
      },
      getBoundingClientRect() {
        reads.rect++
        return { left: 40, top: 60, width: 120, height: 32 }
      },
      animate: animation,
      remove() {
        const index = layers.indexOf(this)
        if (index !== -1) layers.splice(index, 1)
      }
    }
  }
  const document = {
    documentElement: root,
    hidden: false,
    defaultView: {
      MutationObserver: Observer,
      matchMedia: () => media,
      getComputedStyle(target: ReturnType<typeof element>) {
        reads.style++
        return target.style
      },
      requestAnimationFrame() {
        throw new Error('UI motion must not schedule frames')
      }
    },
    body: {
      append(layer: ReturnType<typeof element>) {
        layers.push(layer)
      }
    },
    createElement: element,
    addEventListener(type: string, callback: () => void) {
      const callbacks = documentListeners.get(type) ?? new Set()
      callbacks.add(callback)
      documentListeners.set(type, callbacks)
    },
    removeEventListener(type: string, callback: () => void) {
      documentListeners.get(type)?.delete(callback)
    }
  }
  return {
    document: document as unknown as Document,
    element: () => element() as unknown as HTMLElement,
    root,
    media,
    animations,
    layers,
    reads,
    watcherCount: () =>
      observers.size +
      mediaListeners.size +
      [...documentListeners.values()].reduce((count, callbacks) => count + callbacks.size, 0),
    mutate(preference: string) {
      root.dataset.teMotion = preference
      for (const observer of [...observers]) observer.callback()
    },
    hidden(value: boolean) {
      document.hidden = value
      for (const callback of [...(documentListeners.get('visibilitychange') ?? [])]) callback()
    },
    visibility(value: string) {
      root.dataset.teVisibility = value
      for (const observer of [...observers]) observer.callback()
    },
    systemReduced(value: boolean) {
      media.matches = value
      for (const callback of [...mediaListeners]) callback()
    }
  }
}

test('resolved full overrides the OS; off, reduced edges and hidden documents schedule nothing', async () => {
  for (const preference of ['off', 'reduced']) {
    const env = environment(preference),
      motion = uiMotionFor(env.document),
      target = env.element()
    assert.equal(motion.edge(target).enabled, false)
    assert.deepEqual(env.reads, { rect: 0, style: 0 })
    assert.equal(env.watcherCount(), 0)
    if (preference === 'off') assert.equal(motion.control(target, 'reveal').enabled, false)
    motion.dispose()
  }
  for (const viaAttribute of [false, true]) {
    const env = environment('full'),
      motion = uiMotionFor(env.document),
      target = env.element()
    if (viaAttribute) env.visibility('hidden')
    else env.hidden(true)
    assert.equal(motion.control(target, 'reveal').enabled, false)
    assert.equal(motion.edge(target).enabled, false)
    assert.equal(env.animations.length, 0)
    assert.equal(env.layers.length, 0)
    assert.equal(env.watcherCount(), 0)
    motion.dispose()
  }
  const env = environment('full', true),
    motion = uiMotionFor(env.document),
    target = env.element()
  assert.equal(uiMotionFor(env.document), motion)
  const handle = motion.control(target, 'reveal')
  assert.equal(handle.enabled, true)
  assert.equal(env.animations[0].timing.duration, 220)
  assert.equal(env.animations[0].keyframes[0].opacity, 0)
  assert.deepEqual(env.reads, { rect: 0, style: 0 })
  env.systemReduced(false)
  assert.equal(env.animations[0].cancelled, false)
  env.animations[0].finish()
  await handle.finished
  assert.equal(env.watcherCount(), 0)
  motion.dispose()
})

test('one element has independent control and edge channels with latest-wins cleanup', async () => {
  const env = environment('full'),
    motion = uiMotionFor(env.document),
    target = env.element()
  const before = JSON.stringify(target.style)
  const first = motion.control(target, 'reveal'),
    edge = motion.edge(target),
    second = motion.control(target, 'press')
  await first.finished
  assert.equal(env.animations[0].cancelled, true)
  assert.equal(env.animations[1].cancelled, false)
  assert.equal(env.animations[2].timing.duration, 110)
  assert.equal(env.layers.length, 1)
  env.animations[2].finish()
  await second.finished
  assert.ok(env.watcherCount() > 0)
  env.animations[1].finish()
  await edge.finished
  assert.equal(env.layers.length, 0)
  assert.equal(env.watcherCount(), 0)
  assert.equal(JSON.stringify(target.style), before)
  motion.dispose()
})

test('input edges use a body overlay, measure once, inherit corners and remove stale layers', async () => {
  const env = environment('full'),
    motion = uiMotionFor(env.document),
    input = env.element()
  const before = JSON.stringify(input.style)
  const first = motion.edge(input)
  assert.equal(env.layers.length, 1)
  assert.equal(input.children.length, 0)
  assert.equal(env.layers[0].getAttribute('aria-hidden'), 'true')
  assert.deepEqual(env.reads, { rect: 1, style: 1 })
  assert.equal(env.layers[0].style.left, '40px')
  assert.equal(env.layers[0].style.width, '120px')
  assert.equal(env.layers[0].style.borderRadius, '12px')
  assert.equal(env.animations[0].timing.duration, 700)
  const second = motion.edge(input, {
    edges: 'bottom',
    radius: 0,
    duration: 320,
    color: 'var(--te-settings-text)'
  })
  await first.finished
  assert.equal(env.layers.length, 1)
  assert.equal(env.layers[0].dataset.edges, 'bottom')
  assert.equal(env.layers[0].style.borderRadius, '0px')
  assert.equal(env.layers[0].style['--te-ui-motion-edge-color'], 'var(--te-settings-text)')
  assert.deepEqual(env.reads, { rect: 2, style: 1 })
  assert.equal(env.animations[1].timing.duration, 320)
  second.cancel()
  second.cancel()
  await second.finished
  assert.equal(env.layers.length, 0)
  assert.equal(env.watcherCount(), 0)
  assert.equal(JSON.stringify(input.style), before)
  motion.dispose()
})

test('custom presets preserve layout transforms and reduced motion retains only a short opacity effect', async () => {
  const env = environment('full'),
    motion = uiMotionFor(env.document),
    target = env.element()
  const preset: UiMotionPreset = {
    full: {
      keyframes: [
        { opacity: 0, transform: 'translateY(6px)', filter: 'blur(4px)' },
        { opacity: 1, transform: 'none' }
      ],
      timing: { duration: 400 }
    },
    reduced: {
      keyframes: [
        { opacity: 0.6, transform: 'scale(0.5)' },
        { opacity: 1, transform: 'none' }
      ],
      timing: { duration: 300, delay: 200 }
    }
  }
  const remove = motion.register('custom', preset),
    before = JSON.stringify(target.style)
  const full = motion.control(target, 'custom')
  assert.equal(
    env.animations[0].keyframes[0].transform,
    'matrix(1, 0, 0, 1, 24, 8) translateY(6px)'
  )
  assert.equal(env.animations[0].keyframes[1].transform, 'matrix(1, 0, 0, 1, 24, 8)')
  assert.equal(env.animations[0].keyframes[0].filter, undefined)
  env.mutate('reduced')
  await full.finished
  const reduced = motion.control(target, 'custom', { duration: 900, delay: 500 })
  assert.equal(env.animations[1].timing.duration, 120)
  assert.equal(env.animations[1].timing.delay, 0)
  assert.equal(env.animations[1].keyframes[0].opacity, 0.6)
  assert.equal(env.animations[1].keyframes[0].transform, undefined)
  env.animations[1].finish()
  await reduced.finished
  remove()
  assert.equal(motion.control(target, 'custom').enabled, false)
  assert.equal(env.watcherCount(), 0)
  assert.equal(JSON.stringify(target.style), before)
  motion.dispose()
})

test('mode and both visibility signals cancel active jobs and detach all policy watchers', async () => {
  const env = environment('full'),
    motion = uiMotionFor(env.document),
    target = env.element()
  const first = motion.control(target, 'reveal'),
    edge = motion.edge(target)
  env.mutate('off')
  await Promise.all([first.finished, edge.finished])
  assert.equal(env.layers.length, 0)
  assert.equal(env.watcherCount(), 0)
  env.mutate('full')
  const hidden = motion.control(target, 'reveal')
  env.hidden(true)
  await hidden.finished
  assert.equal(env.watcherCount(), 0)
  env.hidden(false)
  const attribute = motion.edge(target)
  env.visibility('hidden')
  await attribute.finished
  assert.equal(env.layers.length, 0)
  assert.equal(env.watcherCount(), 0)
  motion.dispose()
})

test('system mode changes cancel active effects; dispose leaves no retained jobs or listeners', async () => {
  const env = environment(),
    motion = uiMotionFor(env.document),
    target = env.element()
  const full = motion.control(target, 'reveal')
  env.systemReduced(true)
  await full.finished
  const reduced = motion.control(target, 'reveal')
  assert.equal(env.animations[1].timing.duration, 100)
  env.systemReduced(false)
  await reduced.finished
  const active = motion.edge(target)
  motion.dispose()
  await active.finished
  assert.equal(env.layers.length, 0)
  assert.equal(env.watcherCount(), 0)
  assert.equal(motion.control(target, 'reveal').enabled, false)
  assert.equal(motion.edge(target).enabled, false)
  const replacement = uiMotionFor(env.document)
  assert.notEqual(replacement, motion)
  replacement.dispose()
})

test('missing presets, detached nodes and zero-duration effects leave no work behind', () => {
  const env = environment('full'),
    motion = uiMotionFor(env.document),
    target = env.element()
  assert.equal(motion.control(target, 'unknown').enabled, false)
  assert.equal(motion.control(target, 'reveal', { duration: 0 }).enabled, false)
  assert.equal(motion.edge(target, { duration: 0 }).enabled, false)
  Object.assign(target, { isConnected: false })
  assert.equal(motion.control(target, 'reveal').enabled, false)
  assert.equal(motion.edge(target).enabled, false)
  assert.equal(env.animations.length, 0)
  assert.equal(env.layers.length, 0)
  assert.equal(env.watcherCount(), 0)
  motion.dispose()
})

test('press skips disabled, aria-disabled and inert controls while reveal remains available', async () => {
  for (const attribute of ['disabled', 'aria-disabled', 'inert']) {
    const env = environment('full'),
      motion = uiMotionFor(env.document),
      target = env.element()
    target.setAttribute(attribute, attribute === 'aria-disabled' ? 'true' : '')
    assert.equal(motion.control(target, 'press').enabled, false)
    assert.equal(env.animations.length, 0)
    assert.equal(env.watcherCount(), 0)
    const reveal = motion.control(target, 'reveal')
    assert.equal(reveal.enabled, true)
    env.animations[0].finish()
    await reveal.finished
    assert.equal(env.watcherCount(), 0)
    motion.dispose()
  }
})
