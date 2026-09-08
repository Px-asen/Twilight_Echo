import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import typescript from 'typescript'

const require = createRequire(import.meta.url)

test('VST3 parameter pages keep edits while bounding rendered controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-vst3-editor-'))
  try {
    const source = await readFile(new URL('./Vst3ParameterEditor.vue', import.meta.url), 'utf8')
    const parsed = parse(source)
    assert.deepEqual(parsed.errors, [])
    let component = compileScript(parsed.descriptor, {
      id: 'vst3-editor',
      inlineTemplate: true
    }).content
    component = component.replace(/import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*/g, '')
    component = component.replace(
      /import\s+\{([^}]*)\}\s+from\s+['"]vue['"]\s*/g,
      (_match, bindings: string) =>
        `const {${bindings.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')}} = Vue\n`
    )
    component = component.replace(
      /import\s+\{[^}]*\}\s+from\s+['"]@renderer\/utils\/vst3Parameters['"]\s*/g,
      ''
    )
    component = component.replace('export default', 'window.ParameterEditor =')
    let helpers = await readFile(new URL('../../utils/vst3Parameters.ts', import.meta.url), 'utf8')
    helpers = helpers.replace(/^import type .*$/m, '').replace(/export function /g, 'function ')
    const script = typescript.transpileModule(helpers + '\n' + component, {
      compilerOptions: { target: typescript.ScriptTarget.ES2022 }
    }).outputText
    const vue = await readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
    const htmlPath = join(directory, 'fixture.html')
    await writeFile(
      htmlPath,
      `<!doctype html><html><body><div id="app"></div>
<script>${vue}</script><script>${script}</script><script>
const parameters = Array.from({length: 2048}, (_, id) => ({id, title: 'Parameter ' + id, unit: '', stepCount: 0, flags: 1, defaultNormalizedValue: 0}))
const node = Vue.reactive({id: 'first', type: 'vst3Plugin', enabled: true, params: {parameters: {}}})
Vue.createApp({setup: () => () => Vue.h(window.ParameterEditor, {node, parameters})}).mount('#app')
window.verify = async () => {
  const check = (condition, reason) => { if (!condition) throw Error(reason) }
  const ranges = () => document.querySelectorAll('input[type="range"]')
  const edit = async value => {
    const input = ranges()[0]
    input.value = value
    input.dispatchEvent(new Event('input', {bubbles: true}))
    await Vue.nextTick()
  }
  check(ranges().length === 32, 'too many controls rendered')
  await edit('0.875')
  document.querySelector('[aria-label="下一页参数"]').click()
  await Vue.nextTick()
  check(ranges().length === 32, 'page size changed')
  await edit('0.625')
  check(node.params.parameters['0'] === 0.875 && node.params.parameters['32'] === 0.625, 'page edits overwrote each other')
  document.querySelector('[aria-label="上一页参数"]').click()
  await Vue.nextTick()
  check(ranges()[0].value === '0.875', 'edit reverted on return')
  node.params = {parameters: {'0': 0.875, '32': 0.625}}
  await Vue.nextTick()
  check(ranges()[0].value === '0.875', 'saved snapshot reset parameter')
  console.log('VST3_EDITOR_OK')
}
</script></body></html>`
    )
    const runnerPath = join(directory, 'runner.cjs')
    await writeFile(
      runnerPath,
      `const {app, BrowserWindow} = require('electron')
app.whenReady().then(async () => {
  const window = new BrowserWindow({show: false, webPreferences: {contextIsolation: false, nodeIntegration: false}})
  window.webContents.on('console-message', (_event, _level, message) => console.error(message))
  try {
    await window.loadFile(process.argv.at(-1))
    await window.webContents.executeJavaScript('window.verify()')
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})`
    )
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', runnerPath, htmlPath],
      { timeout: 30000, windowsHide: true }
    )
    assert.match(stderr, /VST3_EDITOR_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
