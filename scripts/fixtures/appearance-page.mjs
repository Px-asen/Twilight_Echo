import { createApp, h, ref, nextTick } from 'vue'
import Page from '__RENDERER__/components/AppearancePage.vue'
import { cloneAppearance } from '__SHARED__/appAppearance.ts'
import { getBuiltInThemePreset, TWILIGHT_DEFAULT_THEME_ID } from '__SHARED__/theme.ts'

const plain = (value) => JSON.parse(JSON.stringify(value))
const check = (condition, message) => {
  if (!condition) throw Error(message)
}
const calls = (window.calls = [])
window.projects = []
window.allowLeave = true
window.failCapture = false
window.failExport = false
window.dailyDraft = cloneAppearance({})
window.dailyDraft.surfaceMaterial = 'liquidGlass'
window.dailyDraft.appearanceLayers.scopes.card.dark.body = {
  enabled: true,
  color: '#123456',
  opacity: 72
}
window.studioDraft = {
  ...plain(getBuiltInThemePreset(TWILIGHT_DEFAULT_THEME_ID)),
  id: 'user:unsaved',
  name: '未应用的编辑',
  overrides: { pureWhite: {}, dark: { 'color.primary.500': '#abcdef' } }
}
window.api = {
  themeWorkshop: {
    list: async () => window.projects,
    exportAppearance: async (input) => {
      calls.push({ action: 'export', input: plain(input) })
      if (window.failExport) throw Error('导出失败示例')
      if (window.holdExport) await new Promise((resolve) => (window.finishExport = resolve))
      return 'D:/themes/我的主题.tep'
    },
    createFromAppearance: async (input) => {
      calls.push({ action: 'capture', input: plain(input) })
      if (window.failCapture) throw Error('草稿保存失败示例')
      const project = { id: crypto.randomUUID(), name: '高级草稿', version: '1.0.0', revision: 1 }
      window.projects.unshift(project)
      return project
    }
  }
}
const page = ref()
const target = ref({ revision: 0 })
const active = ref(true)
const mounted = ref(true)
const suspendReady = ref(false)
const app = createApp({
  setup: () => () => mounted.value ? h(Page, { ref: page, navigationTarget: target.value, active: active.value, onSuspendReady: value => { suspendReady.value = value } }) : null
})
const errors = []
app.config.errorHandler = (error) => errors.push(error.stack ?? String(error))
app.mount('#app')
const tick = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  await nextTick()
}
const until = async (test, message) => {
  for (let i = 0; i < 120; i++) {
    if (test()) {
      await tick()
      return
    }
    await tick()
  }
  throw Error(message + '\n' + errors.join('\n'))
}
const buttons = () => [...document.querySelectorAll('button')]
const button = (text) => buttons().find((el) => el.textContent.trim() === text)
const menu = async () => {
  const details = document.querySelector('.appearance-theme-tools')
  details.open = true
  const advanced = document.querySelector('.appearance-advanced-tools')
  if (advanced) advanced.open = true
  await tick()
}
const click = async (text) => {
  await menu()
  check(button(text), 'missing button ' + text)
  button(text).click()
  await tick()
}
const ready = () => !!button('导出 .TEP') && !button('导出 .TEP').disabled
window.runCustomization = async () => {
  await until(ready, 'workspace not ready')
  check(document.querySelector('h1').textContent === '自定义主题', 'wrong default page')
  check(
    !document.querySelector('#appearance-selection-tab,#appearance-workshop-tab,dialog'),
    'legacy page or enable dialog remains'
  )
  await click('导出 .TEP')
  await until(() => calls.some((c) => c.action === 'export'), 'daily export missing')
  check(
    calls.at(-1).input.appearance.appearanceLayers.scopes.card.dark.body.color === '#123456',
    'daily draft not exported'
  )
  check(
    !calls.some((c) => ['cancel-daily', 'leave-daily', 'apply', 'save-profile'].includes(c.action)),
    'export commits or discards daily draft'
  )
  window.failExport = true
  await click('导出 .TEP')
  await until(
    () => document.querySelector('[role="alert"]')?.textContent.includes('导出失败'),
    'failure not visible'
  )
  check(
    window.dailyDraft.appearanceLayers.scopes.card.dark.body.opacity === 72,
    'export failure loses draft'
  )
  window.failExport = false
  window.holdExport = true
  await click('导出 .TEP')
  await until(() => !!window.finishExport, 'export not held')
  check(
    button('导出 .TEP').disabled && !(await page.value.requestLeave()),
    'export busy permits navigation'
  )
  window.finishExport()
  window.holdExport = false
  await until(ready, 'export did not recover')
  window.failCapture = true
  await click('图层与蒙版')
  await until(
    () => document.querySelector('[role="alert"]')?.textContent.includes('草稿保存失败'),
    'capture failure missing'
  )
  check(
    document.querySelector('.daily-fixture') && !calls.some((c) => c.action === 'cancel-daily'),
    'failed capture discards daily editor'
  )
  window.failCapture = false
  await click('图层与蒙版')
  await until(
    () =>
      document.querySelector('.advanced-fixture') &&
      calls.some((c) => c.action === 'tools' && c.tool === 'layers'),
    'advanced tools not merged'
  )
  check(
    calls.filter((c) => c.action === 'cancel-daily').length === 1,
    'daily transfer not released exactly once'
  )
  const captures = calls.filter((c) => c.action === 'capture').length
  await click('自定义 CSS')
  await until(
    () => calls.some((c) => c.action === 'tools' && c.tool === '高级 CSS'),
    'CSS unreachable'
  )
  check(
    calls.filter((c) => c.action === 'capture').length === captures,
    'switching advanced tools forks another project'
  )
  await click('导出 .TEP')
  await until(
    () => calls.some((c) => c.action === 'export-plugin'),
    'advanced export bypasses validation path'
  )
  document.querySelector('.appearance-theme-tools').open = false
  await tick()
  await click('常用调整')
  await until(() => !!document.querySelector('.daily-fixture'), 'cannot return to daily adjustment')
  await click('主题属性与历史')
  await until(
    () => !!document.querySelector('.studio-fixture') && ready(),
    'theme properties missing'
  )
  await click('导出 .TEP')
  await until(
    () => calls.some((c) => c.action === 'export' && c.input.profile?.name === '未应用的编辑'),
    'unsaved theme snapshot missing'
  )
  check(!calls.some((c) => c.action === 'save-profile'), 'export requires applying the theme')
  await click('参数设计')
  await until(
    () => calls.some((c) => c.action === 'tools' && c.tool === '参数设计器') && ready(),
    'parameter designer missing'
  )
  const transfer = calls.filter((c) => c.action === 'capture').at(-1)
  check(
    transfer.input.profile.overrides.dark['color.primary.500'] === '#abcdef',
    'advanced handoff loses standard edits'
  )
  check(
    calls.some((c) => c.action === 'release-studio') &&
      !calls.some((c) => c.action === 'leave-studio'),
    'handoff asks to discard transferred draft'
  )
  window.allowLeave = false
  check(!(await page.value.requestLeave()), 'denied leave ignored')
  check(document.querySelector('.advanced-fixture'), 'denied leave unmounted editor')
  window.allowLeave = true
  active.value = false
  await until(() => suspendReady.value, 'hidden workspace never became safe to suspend')
  mounted.value = false
  await tick()
  check(!document.querySelector('.appearance-page') && !page.value, 'suspended workspace retained its component or DOM')
  mounted.value = true
  active.value = true
  await until(ready, 'resumed workspace not ready')
  await page.value.ready()
  check(document.querySelector('.advanced-fixture'), 'resume forgot the selected advanced editor')
  check(calls.filter(c => c.action === 'capture').length === captures + 1, 'resume created another project')
  window.allowLeave = false
  check(!(await page.value.requestLeave()), 'restored workspace bypassed rejected leave')
  window.allowLeave = true
  check(!errors.length, errors.join('\n'))
  document.querySelector('.appearance-theme-tools').open = false
  console.log('CUSTOM_THEME_WORKSPACE_OK')
}
