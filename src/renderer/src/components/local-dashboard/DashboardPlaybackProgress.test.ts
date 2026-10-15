import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer, h, nextTick, ref } from 'vue'

test('playback ticks update the progress island without rendering its parent, and seeking still works', async () => {
  const currentTime = ref(0)
  const duration = ref(100)
  const progress = ref(0)
  let seekPosition = -1
  const player = {
    currentTime,
    duration,
    progress,
    seek: (seconds: number) => {
      seekPosition = seconds
    },
    formatTime: (seconds: number) => `${seconds}s`
  }
  const globals = globalThis as Record<string, unknown>
  globals.__dashboardProgressTestPlayer = player
  const require = createRequire(import.meta.url)
  const source = readFileSync(new URL('./DashboardPlaybackProgress.vue', import.meta.url), 'utf8')
  const { descriptor } = parse(source)
  const compiled = compileScript(descriptor, { id: 'progress-test', inlineTemplate: true })
  const script = compiled.content
    .replace(
      /import \{ usePlayerStore \} from [^\n]+/,
      'const usePlayerStore = () => globalThis.__dashboardProgressTestPlayer'
    )
    .replace(
      /import SmoothedProgressFill from [^\n]+/,
      "const SmoothedProgressFill = { props: ['percent', 'as'], render() { return null } }"
    )
    .replace(
      /from ['"]vue['"]/g,
      `from '${pathToFileURL(require.resolve('vue/dist/vue.runtime.esm-bundler.js')).href}'`
    )
  const js = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
  const component = (
    await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  ).default
  type Element = { tag: string; text: string; props: Record<string, unknown>; children: Element[] }
  const element = (tag: string): Element => ({ tag, text: '', props: {}, children: [] })
  const renderer = createRenderer<Element, Element>({
    createElement: element,
    createText: (text) => ({ ...element('#text'), text }),
    createComment: () => element('#comment'),
    setText: (node, text) => {
      node.text = text
    },
    setElementText: (node, text) => {
      node.text = text
    },
    insert: (node, parent) => {
      parent.children.push(node)
    },
    remove: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: (node, key, _previous, value) => {
      node.props[key] = value
    }
  })
  let parentRenders = 0
  const app = renderer.createApp({
    render() {
      parentRenders++
      return h(component)
    }
  })
  const root = element('root')
  try {
    app.mount(root)
    for (let tick = 1; tick <= 20; tick++) {
      currentTime.value = tick
      progress.value = tick
      await nextTick()
    }
    assert.equal(parentRenders, 1)
    const container = root.children[0]
    assert.equal(container.children[1].children[0].text, '20s')
    assert.equal(container.children[1].children[1].text, '100s')
    const click = container.children[0].props.onClick as (event: unknown) => void
    click({
      clientX: 60,
      currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 100 }) }
    })
    assert.equal(seekPosition, 50)
    click({
      clientX: 500,
      currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 100 }) }
    })
    assert.equal(seekPosition, 100)
    const previewRoot = element('preview-root')
    const previewApp = renderer.createApp({ render: () => h(component, { preview: true }) })
    try {
      previewApp.mount(previewRoot)
      const snapshotNode = (node: Element): string =>
        JSON.stringify([node.tag, node.text, node.props, node.children.map(snapshotNode)])
      const snapshot = snapshotNode(previewRoot)
      for (let tick = 21; tick <= 100; tick++) {
        currentTime.value = tick
        progress.value = tick
        duration.value = 200 + tick
        await nextTick()
      }
      assert.equal(snapshotNode(previewRoot), snapshot)
      const previewContainer = previewRoot.children[0]
      assert.equal(previewContainer.children[1].children[0].text, '63s')
      assert.equal(previewContainer.children[1].children[1].text, '180s')
      const previewClick = previewContainer.children[0].props.onClick as (event: unknown) => void
      previewClick({
        clientX: 60,
        currentTarget: {
          getBoundingClientRect: () => {
            throw Error('preview measures an interactive seek')
          }
        }
      })
      assert.equal(seekPosition, 100)
    } finally {
      previewApp.unmount()
    }
    click({ clientX: 0, currentTarget: { getBoundingClientRect: () => ({ left: 10, width: 0 }) } })
    assert.equal(seekPosition, 100)
  } finally {
    app.unmount()
    delete globals.__dashboardProgressTestPlayer
  }
})
