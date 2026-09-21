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
const execFileAsync = promisify(execFile)

test('tag manager renders a keyboard-contained dialog with linked tabs and restores its trigger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-tag-manager-a11y-'))
  try {
    const component = await compileTagManager()
    const vueRuntime = await readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
    const htmlPath = join(directory, 'tag-manager-a11y.html')
    const runnerPath = join(directory, 'tag-manager-a11y-runner.cjs')
    await writeFile(htmlPath, createFixture(vueRuntime, component), 'utf8')
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      timeout: 30_000,
      windowsHide: true
    })
    assert.match(stderr, /TAG_MANAGER_A11Y_OK/)
    assert.doesNotMatch(stderr, /TAG_MANAGER_A11Y_FAILED/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

async function compileTagManager(): Promise<string> {
  const source = await readFile(new URL('./LocalLibraryTagManager.vue', import.meta.url), 'utf8')
  const parsed = parse(source, { filename: 'LocalLibraryTagManager.vue' })
  assert.equal(parsed.errors.length, 0, `SFC parse errors: ${parsed.errors.join(', ')}`)

  let compiled = compileScript(parsed.descriptor, {
    id: 'twilight-tag-manager-a11y',
    inlineTemplate: true
  }).content
  compiled = compiled.replace(
    /import\s+\{([^}]*)\}\s+from\s+['"]vue['"]\s*/g,
    (_match, bindings: string) => {
      const destructured = bindings.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')
      return `const {${destructured}} = Vue\n`
    }
  )
  compiled = compiled.replace(/import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*/g, '')
  compiled = compiled.replace(
    /import\s+\{[\s\S]*?\}\s+from\s+['"]@renderer\/utils\/localLibraryTagManagement\.ts['"]\s*/,
    'const { hasTagPatch, successfulTagPaths, summarizeTagWriteResults, tagPatchFromForm, tagWritePathKey, toDuplicateReviewGroups, validateTagCoverFile } = window.__tagManagerUtils\n'
  )
  assert.doesNotMatch(compiled, /^import\s/m, 'fixture must run without Node module imports')
  compiled = compiled.replace('export default', 'window.TagManagerComponent =')
  return typescript.transpileModule(compiled, {
    compilerOptions: { target: typescript.ScriptTarget.ES2022 }
  }).outputText
}

function createFixture(vueRuntime: string, component: string): string {
  return `<!doctype html>
<html><body>
  <script>window.addEventListener('error', (event) => console.error('FIXTURE_ERROR', event.message, event.error && event.error.stack))</script>
  <button id="tag-manager-trigger" type="button">Open manager</button>
  <div id="app"></div>
  <script>${vueRuntime}</script>
  <script>
    window.api = {
      library: {
        detectDuplicates: async () => ({ groups: [], suggestions: [], contentHashUnavailableIds: [] }),
        writeTags: async () => ({ items: [] }),
        restoreTags: async () => ({ items: [] })
      }
    }
    window.__tagManagerUtils = {
      hasTagPatch: () => false,
      successfulTagPaths: () => [],
      summarizeTagWriteResults: () => ({ successCount: 0, failedCount: 0, rolledBackCount: 0, notAttemptedCount: 0 }),
      tagPatchFromForm: () => ({}),
      tagWritePathKey: value => value,
      toDuplicateReviewGroups: () => [],
      validateTagCoverFile: () => null
    }
  </script>
  <script>${component}</script>
  <script>
    const { createApp: vueCreateApp, nextTick: vueNextTick, ref: vueRef } = Vue
    const Root = {
      components: { TagManager: window.TagManagerComponent },
      setup() {
        const open = vueRef(false)
        const openManager = () => { open.value = true }
        const closeManager = () => {
          open.value = false
          vueNextTick(() => document.getElementById('tag-manager-trigger').focus())
        }
        return { open, openManager, closeManager, tracks: [] }
      },
      template: '<button id="fixture-open" type="button" @click="openManager">Open</button><TagManager v-if="open" :tracks="tracks" @close="closeManager" />'
    }
    vueCreateApp(Root).mount('#app')
    const tick = () => vueNextTick().then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    const key = (target, key, shiftKey = false) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey }))
    window.runTagManagerA11y = async () => {
      const trigger = document.getElementById('fixture-open')
      trigger.focus()
      trigger.click()
      await tick()
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) throw new Error('dialog did not render')
      const close = dialog.querySelector('[aria-label="关闭标签管理"]')
      if (document.activeElement !== close) throw new Error('initial focus was not placed on close control')

      const editTab = dialog.querySelector('#tag-manager-edit-tab')
      const duplicateTab = dialog.querySelector('#tag-manager-duplicates-tab')
      const editPanel = dialog.querySelector('#tag-manager-edit-panel')
      if (editTab.getAttribute('aria-controls') !== editPanel.id || editPanel.getAttribute('aria-labelledby') !== editTab.id || editPanel.getAttribute('role') !== 'tabpanel') throw new Error('edit tab relationship is incomplete')
      if (duplicateTab.getAttribute('aria-controls') !== 'tag-manager-duplicates-panel') throw new Error('duplicate tab controls relationship is incomplete')

      const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled])')].filter((element) => element.tabIndex >= 0)
      focusable.at(-1).focus()
      key(focusable.at(-1), 'Tab')
      if (document.activeElement !== close) throw new Error('Tab escaped modal instead of wrapping')
      key(close, 'Tab', true)
      if (document.activeElement !== focusable.at(-1)) throw new Error('Shift+Tab did not wrap to final control')

      duplicateTab.click()
      await tick()
      const duplicatePanel = dialog.querySelector('#tag-manager-duplicates-panel')
      if (!duplicatePanel || duplicatePanel.getAttribute('role') !== 'tabpanel' || duplicatePanel.getAttribute('aria-labelledby') !== duplicateTab.id) throw new Error('duplicate panel relationship is incomplete')
      if (duplicateTab.getAttribute('aria-selected') !== 'true' || editTab.getAttribute('aria-selected') !== 'false') throw new Error('active tab state is incorrect')

      key(dialog, 'Escape')
      await tick()
      if (document.querySelector('[role="dialog"]')) throw new Error('Escape did not close the dialog')
      if (document.activeElement !== trigger) throw new Error('trigger focus was not restored after close')

      trigger.click()
      await tick()
      const reopenedDialog = document.querySelector('[role="dialog"]')
      reopenedDialog.querySelector('[aria-label="关闭标签管理"]').click()
      await tick()
      if (document.querySelector('[role="dialog"]')) throw new Error('close control did not close the dialog')
      if (document.activeElement !== trigger) throw new Error('trigger focus was not restored after close control')
      console.log('TAG_MANAGER_A11Y_OK')
    }
  </script>
</body></html>`
}

function electronRunnerSource(): string {
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript('window.runTagManagerA11y()')
    app.exit(0)
  } catch (error) {
    console.error('TAG_MANAGER_A11Y_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
