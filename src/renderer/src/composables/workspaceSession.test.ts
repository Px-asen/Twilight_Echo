/* eslint-disable vue/one-component-per-file -- lifecycle fixtures intentionally mount multiple scopes */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { provideWorkspaceSession, useWorkspaceState } from './workspaceSession.ts'
import { useAppearanceHistory } from './useAppearanceHistory.ts'
import {
  cloneAppearance,
  defaultCardAppearance,
  normalizeAppBackgroundSettings,
  type AppearanceDraft
} from '../../../shared/appAppearance.ts'
import { DEFAULT_LIQUID_GLASS } from '../../../shared/liquidGlass.ts'

type Element = { parent?: Element; children: Element[]; text?: string }
const element = (): Element => ({ children: [] })
const renderer = createRenderer<Element, Element>({
  createElement: element,
  createText: (text) => ({ children: [], text }),
  createComment: element,
  setElementText: (node, text) => {
    node.text = text
  },
  setText: (node, text) => {
    node.text = text
  },
  parentNode: (node) => node.parent ?? null,
  nextSibling: () => null,
  insert(node, parent) {
    node.parent = parent
    parent.children.push(node)
  },
  remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = undefined
  },
  patchProp() {}
})

function mount(key: string, revision: number, child: ReturnType<typeof defineComponent>) {
  const app = renderer.createApp(
    defineComponent({
      setup() {
        provideWorkspaceSession(key, revision)
        return () => h(child)
      }
    })
  )
  const root = element()
  app.mount(root)
  return () => app.unmount()
}

test('JSON workspace rehydrates pending appearance history and releases mounted state', async () => {
  const initial = (): AppearanceDraft =>
    cloneAppearance({
      appBackground: normalizeAppBackgroundSettings({}),
      cardAppearance: defaultCardAppearance(),
      liquidGlass: DEFAULT_LIQUID_GLASS,
      surfaceMaterial: 'standard'
    })
  let draft!: Ref<AppearanceDraft>
  let history!: ReturnType<typeof useAppearanceHistory>
  const Child = defineComponent({
    setup() {
      draft = ref(initial())
      history = useAppearanceHistory(
        () => draft.value,
        (value) => {
          draft.value = value
        }
      )
      useWorkspaceState('draft', () => ({
        draft: draft.value,
        history: history.snapshot()
      })).restore((value) => {
        draft.value = value.draft
        history.resume(value.history)
      })
      return () => h('div')
    }
  })
  let unmount = mount('history-test', 1, Child)
  draft.value.surfaceMaterial = 'transparent'
  history.snapshot()
  draft.value.surfaceMaterial = 'liquidGlass'
  await nextTick()
  const old = draft.value
  unmount()
  old.surfaceMaterial = 'standard'
  unmount = mount('history-test', 1, Child)
  assert.equal(draft.value.surfaceMaterial, 'liquidGlass')
  history.undo()
  assert.equal(draft.value.surfaceMaterial, 'transparent')
  history.redo()
  assert.equal(draft.value.surfaceMaterial, 'liquidGlass')
  unmount()
  unmount = mount('history-test', 2, Child)
  assert.equal(draft.value.surfaceMaterial, 'standard')
  assert.equal(history.canUndo.value, false)
  unmount()
})

test('unopened panes survive repeated suspensions while removed pane state is retired', async () => {
  const selected = ref('both')
  const restored = new Map<string, number>()
  let next = 10
  const Pane = defineComponent({
    props: { id: { type: String, required: true } },
    setup(props) {
      const value = ref(next++)
      useWorkspaceState(props.id, () => value.value).restore((saved) => {
        value.value = saved
      })
      restored.set(props.id, value.value)
      return () => h('div')
    }
  })
  const Child = defineComponent({
    setup: () => () =>
      h('div', [
        selected.value !== 'b' && h(Pane, { id: 'a', key: 'a' }),
        selected.value !== 'a' && h(Pane, { id: 'b', key: 'b' })
      ])
  })
  let unmount = mount('panes-test', 1, Child)
  assert.equal(restored.get('b'), 11)
  unmount()
  selected.value = 'a'
  unmount = mount('panes-test', 1, Child)
  assert.equal(restored.get('a'), 10)
  unmount()
  selected.value = 'b'
  unmount = mount('panes-test', 1, Child)
  assert.equal(restored.get('b'), 11)
  selected.value = 'a'
  await nextTick()
  unmount()
  selected.value = 'b'
  unmount = mount('panes-test', 1, Child)
  assert.notEqual(restored.get('b'), 11)
  unmount()
})
