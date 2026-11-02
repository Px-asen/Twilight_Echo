import { createApp, h, nextTick, shallowRef } from 'vue'
import { createPinia } from 'pinia'
import Page from '@renderer/components/theme-workshop/CustomThemeAdvancedPanel.vue'
import { useThemeWorkshopEditor } from '@renderer/components/theme-workshop/useThemeWorkshopEditor.ts'
import { useWorkshopDiagnostics } from '@renderer/components/theme-workshop/useWorkshopDiagnostics.ts'
import { workshopTemplate } from '@shared/themeWorkshopTemplates.ts'
import { copyWorkshopDraft, workshopProjectSummary } from '@shared/themeWorkshop.ts'
import { createWorkshopLayer } from '@shared/themeWorkshopLayers.ts'
import { diagnoseWorkshopProject } from '@shared/themeWorkshopDiagnostics.ts'
import '@renderer/assets/main.css'

const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = async () => {
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await nextTick()
}
const settle = async (predicate, message) => {
  for (let i = 0; i < 120; i++) {
    await tick()
    if (predicate()) return
  }
  throw new Error(message + '\n' + document.body.innerText.slice(0, 2400))
}
const button = (label) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === label)
const click = async (label) => {
  expect(button(label), 'Missing button: ' + label)
  button(label).click()
  await tick()
}
const input = async (element, value) => {
  expect(element, 'Missing input')
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
const choose = async (label, value) => {
  const element = document.querySelector('[aria-label="' + label + '"]')
  element.value = value
  element.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
let stored = workshopTemplate('00000000-0000-0000-0000-000000000000', 'minimal')
stored.revision = 1
const layer = createWorkshopLayer('gradient', 'gradient')
layer.width = 24
layer.height = 24
layer.x = 40
layer.y = 40
stored.layers = { pureWhite: { app: [layer] }, dark: {} }
let lastSaved = stored,
  writes = 0
const api = {
  list: async () => [workshopProjectSummary(stored)],
  sources: async () => [],
  get: async () => copyWorkshopDraft(stored),
  create: async (template) => {
    stored = { ...workshopTemplate(crypto.randomUUID(), template), revision: 1 }
    return copyWorkshopDraft(stored)
  },
  save: async (project) => {
    expect(project.revision === stored.revision, 'Save revision conflict')
    writes++
    stored = {
      ...copyWorkshopDraft(project),
      revision: project.revision + 1,
      updatedAt: new Date().toISOString()
    }
    lastSaved = stored
    return copyWorkshopDraft(stored)
  },
  preflight: async () => diagnoseWorkshopProject(stored),
  exportProject: async () => 'theme.tep',
  importProject: async () => null
}
window.api = new Proxy(window.api, {
  get: (target, domain) => (domain === 'themeWorkshop' ? api : target[domain])
})

let pointerId = 0
const pointerPending = new Map()
window.__workshopPointerQueue = []
window.__workshopPointerDone = (id) => {
  pointerPending.get(id)?.()
  pointerPending.delete(id)
}
const nativePointer = (event) =>
  new Promise((resolve) => {
    const id = ++pointerId
    pointerPending.set(id, resolve)
    window.__workshopPointerQueue.push({ id, event })
  })

window.runWorkshopTests = async () => {
  localStorage.removeItem('twilight:workshop:mode')
  localStorage.removeItem('twilight:workshop:guide')
  const app = createApp(Page).use(createPinia())
  app.mount('#app')
  await settle(
    () => document.querySelector('iframe')?.contentDocument?.querySelector('.app-shell'),
    'Iframe never mounted'
  )
  expect(button('简单模式').getAttribute('aria-pressed') === 'true', 'Simple mode is default')
  expect(document.querySelector('.workshop-onboarding'), 'Guide is open')
  await click('收起引导')
  await click('项目')
  await input(document.querySelector('[data-workshop-field="name"] input'), '')
  await click('专业模式')
  await click('配色')
  await click('项目')
  expect(
    document.querySelector('[data-workshop-field="name"] input').value === '',
    'Invalid metadata buffer survives navigation'
  )
  await input(document.querySelector('[data-workshop-field="name"] input'), 'DOM theme')
  await click('高级 CSS')
  const code = document.querySelector('[aria-label="高级 CSS"]')
  await input(code, '.card {\n color red;\n}')
  await settle(
    () => document.querySelector('.workshop-diagnostics').textContent.includes('最近有效预览'),
    'Invalid CSS does not retain preview'
  )
  expect(button('应用主题').disabled, 'Errors block apply')
  document.querySelector('.workshop-diagnostic-location').click()
  await tick()
  expect(
    document.activeElement === document.querySelector('[aria-label="高级 CSS"]'),
    'Problem location focuses CSS'
  )
  await input(document.querySelector('[aria-label="高级 CSS"]'), '.card{border-width:2px}')
  await settle(() => !button('应用主题').disabled, 'Valid CSS does not recover preview')
  await click('简单模式')
  await click('专业模式')
  await click('高级 CSS')
  expect(
    document.querySelector('[aria-label="高级 CSS"]').value.includes('border-width:2px'),
    'Mode switch preserves CSS'
  )
  await click('参数设计器')
  await click('＋ 新增参数')
  const formInput = (label) =>
    [...document.querySelectorAll('.workshop-designer-form label')]
      .find((item) => item.textContent.startsWith(label))
      ?.querySelector('input')
  await input(formInput('名称'), '')
  await click('简单模式')
  await click('专业模式')
  await click('参数设计器')
  expect(
    formInput('名称'),
    'Designer not restored: ' + document.querySelector('.workshop-properties').innerText
  )
  expect(formInput('名称').value === '', 'Designer buffer survives mode switch')
  await input(formInput('名称'), 'Custom accent')
  await click('保存参数声明')
  await click('保存')
  await settle(
    () => lastSaved.editor?.controls.some((item) => item.label === 'Custom accent'),
    'Designer declaration not saved'
  )
  await click('图层与蒙版')
  await settle(() => document.querySelector('.workshop-canvas-overlay'), 'Overlay missing')
  const overlay = document.querySelector('.workshop-canvas-overlay')
  const frame = document.querySelector('iframe')
  const decoration = frame.contentDocument.querySelector('.app-shell > .workshop-decoration > div')
  await settle(
    () =>
      decoration?.getBoundingClientRect().width > 0 &&
      decoration?.getBoundingClientRect().height > 0,
    'Layer has no visible bounds'
  )
  const rect = decoration.getBoundingClientRect(),
    root = overlay.getBoundingClientRect(),
    zoom = root.width / 1180
  const x = root.left + (rect.left + rect.width / 2) * zoom,
    y = root.top + (rect.top + rect.height / 2) * zoom
  expect(
    document.elementFromPoint(x, y)?.closest('.workshop-canvas-overlay') === overlay,
    'Layer pointer is outside editable canvas: ' +
      JSON.stringify({
        x,
        y,
        root: root.toJSON(),
        layer: rect.toJSON(),
        hit: document.elementFromPoint(x, y)?.outerHTML.slice(0, 240)
      })
  )
  const pointer = async (type, dx = 0, dy = 0) => {
    await nativePointer({
      type: { pointerdown: 'mouseDown', pointermove: 'mouseMove', pointerup: 'mouseUp' }[type],
      button: 'left',
      modifiers: type === 'pointerup' ? [] : ['leftButtonDown'],
      clickCount: 1,
      x: Math.round(x + dx),
      y: Math.round(y + dy)
    })
    await tick()
  }
  await pointer('pointerdown')
  for (let i = 1; i <= 15; i++) {
    await pointer('pointermove', i * 3, i)
    await tick()
  }
  await pointer('pointerup', 45, 15)
  await tick()
  await click('保存')
  await settle(() => lastSaved.layers.pureWhite.app[0].x !== 40, 'Drag did not change layer')
  await click('撤销')
  await click('保存')
  await settle(
    () => lastSaved.layers.pureWhite.app[0].x === 40,
    'One undo did not restore entire drag'
  )
  await pointer('pointerdown')
  await pointer('pointermove', 20, 20)
  overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await tick()
  await pointer('pointerup')
  await click('保存')
  await tick()
  expect(lastSaved.layers.pureWhite.app[0].x === 40, 'Esc did not cancel layer edit')
  await choose('页面', 'settings')
  await click('画布编辑')
  const sample = frame.contentDocument.querySelector('.settings-preview-page input')
  expect(sample && !sample.closest('[inert]'), 'Local control samples are inert')
  sample.value = 'Only example'
  sample.dispatchEvent(new Event('input', { bubbles: true }))
  sample.focus()
  expect(frame.contentDocument.activeElement === sample, 'Sample cannot focus')
  expect(
    frame.contentDocument.querySelector('.settings-preview-page button[disabled]'),
    'Disabled sample missing'
  )
  await choose('页面', 'library')
  await choose('预览状态', 'selected')
  await tick()
  expect(
    frame.contentDocument.querySelectorAll('.track-row').length < 48,
    'Library preview is not virtualized'
  )
  for (const state of ['empty', 'loading', 'done', 'listening', 'normal']) {
    await choose('预览状态', state)
    expect(
      frame.contentDocument.querySelector('.app-shell').dataset.workshopState === state,
      'State not applied: ' + state
    )
  }
  await click('完整检查')
  await tick()
  await click('专业模式')
  await click('高级 CSS')
  await input(document.querySelector('[aria-label="高级 CSS"]'), '.card{border-width:3px}')
  await settle(
    () =>
      !button('取消检查') &&
      document.querySelector('.workshop-diagnostics').textContent.includes('尚未检查'),
    'Editing did not cancel full check'
  )
  await settle(() => !button('应用主题').disabled, 'Current preview did not settle')
  await click('整窗试用')
  await settle(() => document.getElementById('workshop-trial'), 'Trial missing')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await tick()
  expect(!document.getElementById('workshop-trial'), 'Esc did not exit trial')
  expect(
    window.__businessWrites.length === 0,
    'Preview wrote to real settings or playback: ' + window.__businessWrites
  )
  expect(writes > 0, 'Autosave/write path never exercised')
  await schedulerChecks()
  expect(
    parseFloat(document.querySelector('.workshop-preview-metric').textContent.split('：')[1]) <= 32,
    'Preview p95 exceeds 32ms'
  )
  await click('简单模式')
  await click('背景')
  await choose('页面', 'dashboard')
  await choose('预览状态', 'normal')
}

async function schedulerChecks() {
  const element = document.createElement('div')
  document.body.append(element)
  let editor,
    diagnostics,
    deferred,
    inspected = 0
  const apiForHistory = {
    ...api,
    save: async (project) => ({ ...project, revision: project.revision + 1 })
  }
  const probe = createApp({
    setup() {
      editor = useThemeWorkshopEditor(apiForHistory)
      editor.adopt(workshopTemplate('11111111-1111-1111-1111-111111111111', 'minimal'))
      const candidate = shallowRef(),
        project = editor.previewProject,
        generation = editor.generation
      diagnostics = useWorkshopDiagnostics(project, generation, candidate, async () => {
        inspected++
        if (deferred) await deferred
        return [
          {
            id: 'old',
            code: 'old',
            severity: 'warning',
            message: project.value.css,
            location: { kind: 'preview' }
          }
        ]
      })
      return () => h('div')
    }
  })
  probe.mount(element)
  await diagnostics.flush()
  await tick()
  const valid = diagnostics.css.value
  for (let i = 0; i < 40; i++)
    editor.change((project) => {
      project.css = '.x{width:' + i + 'px}'
    }, true)
  await tick()
  await diagnostics.flush()
  expect(diagnostics.css.value.includes('width:39px'), 'Frame batching lost latest input')
  expect(editor.historyLength.value === 1, 'Continuous input created separate history steps')
  await delay(350)
  expect(editor.historyLength.value === 2, 'Continuous edits were not merged')
  let resolve
  deferred = new Promise((done) => {
    resolve = done
  })
  diagnostics.scheduleRuntime()
  await delay(300)
  editor.change((project) => {
    project.css = '.x{color red}'
  })
  await tick()
  await diagnostics.flush()
  const last = diagnostics.css.value
  resolve()
  deferred = undefined
  await tick()
  expect(
    last !== valid && diagnostics.css.value === last && !diagnostics.previewValid.value,
    'Last valid preview lost'
  )
  expect(
    !diagnostics.report.value.diagnostics.some((item) => item.code === 'old'),
    'Stale diagnostics were applied'
  )
  editor.change((project) => {
    project.css = ''
  })
  await tick()
  await diagnostics.flush()
  editor.beginGesture()
  for (let i = 0; i < 20; i++)
    editor.change((project) => {
      project.name = 'Drag ' + i
    }, true)
  editor.endGesture()
  const after = editor.historyLength.value
  editor.undo(-1)
  expect(editor.draft.value.name === '简洁配色', 'Gesture undo did not restore one snapshot')
  expect(after >= 2 && inspected > 0, 'Probe did not exercise history and diagnostics')
  for (let i = 0; i < 55; i++)
    editor.change((project) => {
      project.name = 'Edit ' + i
    })
  expect(editor.historyLength.value === 40, 'History limit differs from 40')
  probe.unmount()
  element.remove()
}
