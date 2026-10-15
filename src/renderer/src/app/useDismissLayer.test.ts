import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { computed, createRenderer, defineComponent, nextTick, ref, shallowRef } from 'vue'
import { createFocusTrap } from './focusTrap.ts'
import { hasDismissLayer, useEscapeToClose, useFocusTrap } from './useDismissLayer.ts'

function environment() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const document = { activeElement: null as HTMLElement | null, body: null as HTMLElement | null }
  const window = {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const callbacks = listeners.get(type) ?? new Set()
      callbacks.add(listener)
      listeners.set(type, callbacks)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener)
    }
  }
  function element(children: HTMLElement[] = [], visible = true): HTMLElement {
    const node = {
      isConnected: true,
      getClientRects: () => (visible ? [{}] : []),
      closest: () => null,
      querySelectorAll: () => children,
      contains: (other: unknown) => other === node || children.includes(other as HTMLElement),
      focus: () => {
        document.activeElement = node as unknown as HTMLElement
      }
    }
    return node as unknown as HTMLElement
  }
  document.body = element()
  const opener = element()
  document.activeElement = opener
  const requestFrame = (callback: FrameRequestCallback): number => {
    const id = ++frameId
    frames.set(id, callback)
    return id
  }
  const cancelFrame = (id: number): void => {
    frames.delete(id)
  }
  return {
    window: window as unknown as Window,
    document: document as unknown as Document,
    requestFrame,
    cancelFrame,
    element,
    opener,
    focus: (target: HTMLElement) => {
      document.activeElement = target
    },
    frameCount: () => frames.size,
    listenerCount: () =>
      [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0),
    flushFrames() {
      const current = [...frames.values()]
      frames.clear()
      current.forEach((callback) => callback(0))
    },
    key(key: string, shiftKey = false) {
      const event = new Event('keydown', { cancelable: true })
      Object.defineProperties(event, { key: { value: key }, shiftKey: { value: shiftKey } })
      for (const listener of [...(listeners.get('keydown') ?? [])]) {
        if (typeof listener === 'function') listener(event)
        else listener.handleEvent(event)
      }
      return event
    }
  }
}

test('focus closes during an exit transition, restores the opener and cancels opening work', () => {
  const env = environment()
  const first = env.element(),
    last = env.element()
  const root = env.element([first, last])
  const trap = createFocusTrap(() => root, env)
  try {
    trap.activate()
    env.flushFrames()
    assert.equal(env.document.activeElement, first)
    env.focus(last)
    assert.equal(env.key('Tab').defaultPrevented, true)
    assert.equal(env.document.activeElement, first)
    assert.equal(env.key('Tab', true).defaultPrevented, true)
    assert.equal(env.document.activeElement, last)
    trap.deactivate()
    assert.equal(env.document.activeElement, env.opener)
    assert.equal(env.listenerCount(), 0)
    trap.activate()
    trap.deactivate()
    env.flushFrames()
    assert.equal(env.document.activeElement, env.opener)
    assert.equal(env.frameCount(), 0)
  } finally {
    trap.deactivate()
  }
})

test('only the innermost trap handles Tab and closing it restores the outer dialog', () => {
  const env = environment()
  const outerFirst = env.element(),
    outerLast = env.element()
  const innerFirst = env.element(),
    innerLast = env.element()
  const outer = createFocusTrap(() => env.element([outerFirst, outerLast]), env)
  const inner = createFocusTrap(() => env.element([innerFirst, innerLast]), env)
  try {
    outer.activate()
    env.flushFrames()
    inner.activate()
    env.flushFrames()
    env.focus(innerLast)
    env.key('Tab')
    assert.equal(env.document.activeElement, innerFirst)
    inner.deactivate()
    assert.equal(env.document.activeElement, outerFirst)
    env.focus(outerLast)
    env.key('Tab')
    assert.equal(env.document.activeElement, outerFirst)
    outer.deactivate()
    assert.equal(env.document.activeElement, env.opener)
  } finally {
    inner.deactivate()
    outer.deactivate()
  }
})

test('opening keeps a visible destination already focused by an entry point', () => {
  const env = environment()
  const first = env.element(),
    destination = env.element(),
    hidden = env.element([], false),
    inert = env.element()
  Object.assign(inert, { closest: () => inert })
  const root = env.element([first, destination, hidden, inert])
  const trap = createFocusTrap(() => root, env)
  try {
    trap.activate()
    env.focus(destination)
    env.flushFrames()
    assert.equal(env.document.activeElement, destination)
    for (const invalid of [hidden, inert]) {
      trap.activate()
      env.focus(invalid)
      env.flushFrames()
      assert.equal(env.document.activeElement, first)
    }
  } finally {
    trap.deactivate()
  }
})

test('closing does not steal deliberate outside focus or focus a detached opener', () => {
  const env = environment()
  const root = env.element([env.element()])
  const trap = createFocusTrap(() => root, env)
  try {
    trap.activate()
    env.flushFrames()
    const outside = env.element()
    env.focus(outside)
    trap.deactivate()
    assert.equal(env.document.activeElement, outside)
    trap.activate()
    env.flushFrames()
    Object.assign(outside, { isConnected: false })
    trap.deactivate()
    assert.notEqual(env.document.activeElement, outside)
    assert.equal(env.listenerCount(), 0)
  } finally {
    trap.deactivate()
  }
})

interface HostNode {
  parent: HostNode | null
  children: HostNode[]
}
const node = (): HostNode => ({ parent: null, children: [] })
const renderer = createRenderer<HostNode, HostNode>({
  createElement: node,
  createText: node,
  createComment: node,
  insert(child, parent) {
    child.parent = parent
    parent.children.push(child)
  },
  remove(child) {
    const siblings = child.parent?.children
    if (siblings) siblings.splice(siblings.indexOf(child), 1)
    child.parent = null
  },
  parentNode: (child) => child.parent,
  nextSibling: () => null,
  patchProp() {},
  setText() {},
  setElementText() {}
})

test('application chrome mounts restored open and closed navigation before registering Escape', async () => {
  const { useAppNavigation } = await import('./useAppNavigation.ts')
  const { createNavigationSessionPersistence } =
    await import('./useNavigationSessionPersistence.ts')
  const source = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
  // Execute the production declaration and registration in their actual source order.
  const fragments = [
    source.match(/const showLocalSidebar = computed\([\s\S]*?\n\)/),
    source.match(
      /useEscapeToClose\(\(\) => menuOpen\.value && showLocalSidebar\.value, closeNavigation\)/
    )
  ]
  for (const fragment of fragments) assert.ok(fragment)
  const chromeSetup = fragments
    .sort((left, right) => left!.index! - right!.index!)
    .map((fragment) => fragment![0])
    .join('\n')
  const env = environment()
  const original = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: env.window, document: env.document })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  try {
    for (const menuOpen of [true, false]) {
      for (const overlay of [null, 'appearance'] as const) {
        const navigation = useAppNavigation()
        const saved = JSON.stringify({ ...navigation.session.value, menuOpen, overlay })
        const persistence = createNavigationSessionPersistence(navigation, {
          getItem: () => saved,
          setItem() {}
        })
        assert.equal(navigation.menuOpen.value, menuOpen)
        const scope = {
          ...navigation,
          computed,
          useEscapeToClose,
          appearanceFullWindowPreview: ref(false),
          closeNavigation: navigation.collapseMenu
        }
        const setupChrome = new Function(...Object.keys(scope), chromeSetup)
        const errors: unknown[] = []
        const app = renderer.createApp(
          defineComponent({
            setup() {
              setupChrome(...Object.values(scope))
              return () => null
            }
          })
        )
        app.config.errorHandler = (error) => errors.push(error)
        try {
          app.mount(node())
          assert.deepEqual(errors, [], `restored menu=${menuOpen}, overlay=${overlay}`)
          assert.equal(hasDismissLayer(), menuOpen && overlay === null)
          if (overlay === 'appearance') {
            navigation.closeAppearancePage()
            await nextTick()
          }
          navigation.menuOpen.value = true
          await nextTick()
          assert.equal(hasDismissLayer(), true)
          assert.equal(env.key('Escape').defaultPrevented, true)
          await nextTick()
          assert.equal(navigation.menuOpen.value, false)
          assert.equal(hasDismissLayer(), false)
        } finally {
          app.unmount()
          persistence.stop()
        }
        assert.equal(env.listenerCount(), 0)
      }
    }
  } finally {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('real Vue mount initializes an already-open trap; Escape and unmount release resources', async () => {
  const env = environment()
  const original = new Map<string, PropertyDescriptor | undefined>()
  const globals = {
    window: env.window,
    document: env.document,
    requestAnimationFrame: env.requestFrame,
    cancelAnimationFrame: env.cancelFrame
  }
  for (const [key, value] of Object.entries(globals)) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const first = env.element()
  const active = ref(true)
  const root = shallowRef(env.element([first]))
  const app = renderer.createApp(
    defineComponent({
      setup() {
        useFocusTrap(root, active)
        useEscapeToClose(active, () => {
          active.value = false
        })
        return () => null
      }
    })
  )
  try {
    app.mount(node())
    env.flushFrames()
    assert.equal(env.document.activeElement, first)
    assert.equal(hasDismissLayer(), true)
    env.key('Escape')
    await nextTick()
    assert.equal(active.value, false)
    assert.equal(env.document.activeElement, env.opener)
    assert.equal(env.listenerCount(), 0)
    active.value = true
    await nextTick()
    assert.equal(env.frameCount(), 1)
    app.unmount()
    env.flushFrames()
    assert.equal(env.frameCount(), 0)
    assert.equal(env.listenerCount(), 0)
    assert.equal(hasDismissLayer(), false)
  } finally {
    if (app._instance) app.unmount()
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
