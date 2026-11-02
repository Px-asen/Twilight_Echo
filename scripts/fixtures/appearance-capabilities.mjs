import { installCorePluginFixture } from '@renderer/extensions/corePlugins.fixture.ts'
import { createApp, h, ref, nextTick } from 'vue'
import { createPinia } from 'pinia'
import AppearancePage from '@renderer/components/AppearancePage.vue'
import PlayerBarSettings from '@renderer/components/settings-page/PlayerBarSettings.vue'
import PageDock from '@renderer/components/PageDock.vue'
import { providePageDock } from '@renderer/app/pageDock.ts'
import { SETTINGS_SEARCH_INDEX } from '@renderer/components/settings-page/types.ts'
import { useSettingsStore } from '@renderer/stores/useSettingsStore.ts'
import { bootstrapThemeRuntime, useThemeStore } from '@renderer/stores/useThemeStore.ts'
import { createDefaultThemeLibraryDocument, getBuiltInThemePreset } from '@shared/theme.ts'
import { customThemeSnapshot } from '@main/themes/customThemeSnapshot.ts'
import {
  copyWorkshopDraft,
  workshopProjectSummary,
  compileWorkshopTheme
} from '@shared/themeWorkshop.ts'
import { diagnoseWorkshopProject } from '@shared/themeWorkshopDiagnostics.ts'
import { fixtureThemes } from '@renderer/extensions/registry.ts'
import '@renderer/assets/main.css'
import '@renderer/assets/icon-fonts.ts'
import '@renderer/components/settings-page/SettingsPage.css'

const expect = (value, message) => {
  if (!value) throw Error(message)
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const settingsStore = useSettingsStore()
const themes = useThemeStore()
let confirmed = plain({ ...settingsStore.settings.value, theme: 'dark' })
const initialSettings = plain(confirmed)
let library = {
  version: 2,
  revision: 0,
  savedAt: new Date(0).toISOString(),
  data: createDefaultThemeLibraryDocument()
}
let failSave = false,
  failThemeSave = false,
  failImport = false,
  allowLeave = false
const advancedProjects = new Map(),
  directExports = [],
  pluginExports = [],
  transfers = []
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
let advancedSaveFailed = false
const currentProject = () => [...advancedProjects.values()][0]
const writes = [],
  themeWrites = [],
  errors = []
window.addEventListener('unhandledrejection', (event) =>
  errors.push(String(event.reason?.stack ?? event.reason))
)
window.confirm = () => allowLeave
const snapshot = () => ({
  settings: confirmed,
  defaults: confirmed,
  paths: {},
  appVersion: 'test',
  platform: 'win32',
  windowTransparencySupported: false,
  restartReasons: []
})
const acceptLibrary = () => {
  library = { ...library, revision: library.revision + 1 }
  return plain(library)
}
window.api = {
  diagnostics: { record: () => {} },
  themeWorkshop: {
    list: async () => [...advancedProjects.values()].map(workshopProjectSummary),
    sources: async () => [],
    get: async (id) => copyWorkshopDraft(advancedProjects.get(id)),
    createFromAppearance: async (input) => {
      // Match the Electron serialization boundary, including rejection of Vue proxies.
      const value = structuredClone(input)
      transfers.push(value)
      const existing = currentProject()
      const next =
        value.selection.kind === 'plugin' && existing
          ? {
              ...copyWorkshopDraft(existing),
              base: {
                ...existing.base,
                structured: {
                  ...existing.base.structured,
                  appearance: value.appearance,
                  appearanceLayers: value.appearance.appearanceLayers
                }
              }
            }
          : await customThemeSnapshot(
              crypto.randomUUID(),
              value,
              value.profile ?? getBuiltInThemePreset(value.selection.id),
              undefined,
              async () => png
            )
      next.revision++
      advancedProjects.set(next.id, next)
      return copyWorkshopDraft(next)
    },
    exportAppearance: async (input) => {
      directExports.push(structuredClone(input))
      return 'D:\\themes\\custom.tep'
    },
    save: async (project) => {
      if (advancedSaveFailed) throw Error('高级草稿保存失败示例')
      const next = {
        ...copyWorkshopDraft(project),
        revision: project.revision + 1,
        updatedAt: new Date().toISOString()
      }
      advancedProjects.set(next.id, next)
      return copyWorkshopDraft(next)
    },
    preflight: async (id) => diagnoseWorkshopProject(advancedProjects.get(id)),
    exportProject: async (id, format) => {
      pluginExports.push({ project: copyWorkshopDraft(advancedProjects.get(id)), format })
      return 'D:\\themes\\advanced.' + (format === 'tep' ? 'tep' : 'teworkshop')
    },
    importAsset: async () => null,
    apply: async (id) => {
      const project = advancedProjects.get(id),
        compiled = compileWorkshopTheme(project)
      const pluginId = 'com.twilightecho.theme.user-' + project.id
      fixtureThemes.value = [
        {
          pluginId,
          id: 'custom',
          name: project.name,
          structured: compiled.structured,
          variables: compiled.variables
        }
      ]
      return { pluginId, themeId: 'custom', project: copyWorkshopDraft(project) }
    }
  },
  settings: {
    get: async () => snapshot(),
    onChanged: () => () => {},
    update: async (patch) => {
      if (failSave) throw Error('外观保存失败示例')
      writes.push(plain(patch))
      confirmed = { ...confirmed, ...plain(patch) }
      return snapshot()
    },
    importBackgroundImage: async () => {
      if (failImport) throw Error('图片导入失败示例')
      return 'background://fixture.png'
    }
  },
  fonts: { listInstalled: async () => ['Fixture Sans'] },
  plugins: {
    onChanged: () => () => {},
    list: async () => [],
    listIndex: async () => [],
    getIndexStatus: async () => ({})
  },
  themes: {
    onChanged: () => () => {},
    onSystemToneChanged: () => () => {},
    getBootstrap: async () => ({ library: plain(library) }),
    getSystemTone: async () => 'dark',
    validateAssets: async () => [],
    save: async (profile) => {
      if (failThemeSave) throw Error('主题保存失败示例')
      themeWrites.push(plain(profile))
      library.data.profiles = [
        ...library.data.profiles.filter((p) => p.id !== profile.id),
        plain(profile)
      ]
      return acceptLibrary()
    },
    setActive: async (selection) => {
      library.data.activeTheme = plain(selection)
      return acceptLibrary()
    },
    copyAssets: async () => [],
    importAsset: async () => null,
    exportTheme: async () => ({ canceled: true }),
    importTheme: async () => null
  }
}
const startup = {
  settings: snapshot(),
  systemTone: 'dark',
  themeBootstrap: { library: plain(library) }
}
settingsStore.hydrateStartupSnapshot(startup)
const boot = installCorePluginFixture().then(() => bootstrapThemeRuntime(startup))
const target = ref({
  revision: 1,
  appearanceTab: 'adjust',
  entry: SETTINGS_SEARCH_INDEX.find((e) => e.id === 'global-font')
})
let app = createApp({
  setup() {
    const dock = providePageDock('appearance')
    return () => [
      h('div', { style: 'position:fixed;top:4px;left:12px;z-index:100' }, [
        h(PageDock, { actions: dock.actions.value })
      ]),
      h(AppearancePage, { navigationTarget: target.value })
    ]
  }
}).use(createPinia())
app.config.errorHandler = (error) => errors.push(String(error?.stack ?? error))
void boot.then(() => app.mount('#app'))
const tick = async () => {
  await nextTick()
  for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve))
}
const until = async (predicate, message) => {
  const deadline = Date.now() + 6000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(message + '\n' + errors.join('\n'))
    await tick()
  }
  await tick()
}
const visible = (el) => el && el.checkVisibility() && !el.closest('[inert]')
const button = (label, root = document) =>
  [...root.querySelectorAll('button')].find(
    (el) =>
      visible(el) &&
      (el.textContent.trim() === label ||
        el.querySelector('.settings-group-title')?.textContent.trim() === label ||
        el.querySelector('.setting-copy > strong')?.textContent.trim() === label)
  )
const choose = async (control, value) => {
  expect(control, 'missing control ' + value)
  control.value = value
  control.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
const click = async (label) => {
  const control = button(label)
  expect(control, 'missing button ' + label)
  control.click()
  await tick()
}
const showSetting = async (id) => {
  const entry = SETTINGS_SEARCH_INDEX.find((e) => e.id === id)
  expect(entry, 'missing setting ' + id)
  target.value = { revision: target.value.revision + 1, appearanceTab: 'adjust', entry }
  await until(
    () => document.querySelector('[data-appearance-properties]'),
    'properties did not open for ' + id
  )
}
const part = async (id) => {
  document.querySelector(`[data-part="${id}"]`).click()
  await tick()
}
const drawer = () => document.querySelector('[data-appearance-properties]')
const openThemeLink = async (domain) => {
  const link = document.querySelector(`[data-theme-domain="${domain}"]`)
  expect(link, 'theme link missing ' + domain)
  link.click()
  await tick()
}
window.runCapabilities = async () => {
  await until(() => drawer(), 'font properties did not mount')
  await choose(drawer().querySelector('[aria-label="界面字体"]'), 'local:Fixture Sans')
  expect(
    confirmed.fontFamily === 'local:Fixture Sans' && writes.length === 1,
    'font did not use immediate legacy setting'
  )
  await choose(drawer().querySelector('[aria-label="本机字体名称"]'), 'FOT-TsukuMin Pro')
  expect(
    confirmed.fontFamily === 'local:FOT-TsukuMin Pro' &&
      drawer().querySelector('[aria-label="界面字体"]').value === 'local:FOT-TsukuMin Pro',
    'manual local font input did not update settings and select option'
  )
  await click('清晰')
  expect(confirmed.fontRendering === 'crisp', 'font rendering disconnected')
  await showSetting('color-mode')
  const colorWrites = writes.length
  await click('浅色')
  expect(
    confirmed.theme === 'dark' && writes.length === colorWrites,
    'color mode saved outside draft'
  )
  document.querySelector('[aria-label="撤销外观调整"]').click()
  await tick()
  expect(button('深色', drawer()).classList.contains('active'), 'color mode not restored by undo')
  document.querySelector('[aria-label="重做外观调整"]').click()
  await tick()
  expect(button('浅色', drawer()).classList.contains('active'), 'color mode not restored by redo')
  await click('放弃调整')
  expect(button('深色', drawer()).classList.contains('active'), 'color mode not discarded')
  await part('player-bar')
  await click('调节')
  await click('更多播放栏设置')
  expect(drawer(), 'player properties not reachable from inspector')
  const baseline = plain(confirmed.playerBar),
    count = writes.length
  await click('迷你')
  expect(
    confirmed.playerBar.mode === baseline.mode && writes.length === count,
    'new player controls persisted before Apply'
  )
  await click('自动隐藏')
  await click('播放页与自动隐藏')
  expect(
    drawer().querySelector('[data-setting-id="player-bar-threshold"]').checkVisibility(),
    'auto-hide details unavailable after eligible shape'
  )
  const shape = document.querySelector('[aria-label="撤销外观调整"]')
  shape.click()
  await tick()
  shape.click()
  await tick()
  expect(button('标准', drawer()).classList.contains('active'), 'undo did not restore player shape')
  document.querySelector('[aria-label="重做外观调整"]').click()
  await tick()
  await click('常显')
  await click('应用外观')
  expect(confirmed.playerBar.mode === 'mini', 'Apply did not persist the draft player setting')
  await click('完全隐藏')
  await click('放弃调整')
  expect(
    confirmed.playerBar.visibility === baseline.visibility,
    'discard changed confirmed visibility'
  )
  expect(
    button('常显', drawer()).classList.contains('active'),
    'discard did not restore player controls'
  )
  await click('完全隐藏')
  failSave = true
  await click('应用外观')
  expect(
    [...document.querySelectorAll('[role="alert"]')].some((el) =>
      el.textContent.includes('外观保存失败')
    ),
    'save failure hidden'
  )
  failSave = false
  await click('应用外观')
  expect(confirmed.playerBar.visibility === 'hidden', 'retry lost player draft')
  await click('常显')
  await openThemeLink('player')
  expect(
    document.querySelector('.appearance-editor--character'),
    'rejected leave unmounted daily draft'
  )
  expect(button('常显', drawer()).classList.contains('active'), 'rejected leave lost player draft')
  allowLeave = true
  await openThemeLink('player')
  await until(
    () => visible(document.querySelector('[data-studio-setting="player.progress"]')),
    'theme player tools not opened after async editor load'
  )
  await choose(document.querySelector('[data-studio-setting="player.progress"]'), 'ring')
  failThemeSave = true
  await click('应用主题')
  expect(
    [...document.querySelectorAll('[role="alert"],.studio-message.error')].some((el) =>
      el.textContent.includes('主题保存失败')
    ),
    'theme save failure hidden'
  )
  failThemeSave = false
  await click('应用主题')
  expect(themeWrites.length === 1, 'theme retry did not preserve draft')
  await click('更多')
  await until(
    () => document.querySelector('[aria-label="搜索主题设置"]'),
    'theme search not available'
  )
  const search = document.querySelector('[aria-label="搜索主题设置"]')
  search.value = '歌词使用主题色'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  const hit = [...document.querySelectorAll('.studio-search-hits button')].find((el) =>
    el.textContent.includes('歌词使用主题色')
  )
  expect(hit, 'search did not find old theme capability')
  hit.click()
  await tick()
  expect(
    visible(document.querySelector('[data-studio-setting="typography.lyricAccent"]')),
    'search closed properties or opened wrong domain'
  )
  expect(
    document.activeElement.dataset.studioSetting === 'typography.lyricAccent',
    'search did not focus target'
  )
  // Every former theme domain remains editable inside this same floating panel.
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  for (const [domain, selectors] of [
    [
      'personalization',
      [
        'appearance.accentSource',
        'appearance.backgroundTreatment',
        'appearance.toneScheduling',
        'appearance.contrastGuard',
        'palettes'
      ]
    ],
    ['navigation', ['icons.family', 'navigation.style', 'navigation.logo']],
    ['library', ['library.density', 'library.selection', 'library.titleOverlay']],
    ['typography', ['typography.titleCase', 'typography.lyricAccent', 'typography.titleColor']],
    [
      'player',
      [
        'player.layout',
        'player.controls',
        'player.progress',
        'artwork.transition',
        'equalizer.panel',
        'equalizer.spectrum',
        'visibility'
      ]
    ]
  ]) {
    await choose(document.querySelector('[aria-label="主题属性分类"]'), domain)
    for (const id of selectors)
      expect(
        visible(document.querySelector(`[data-studio-setting="${id}"]`)),
        'missing theme capability ' + id
      )
  }
  await choose(document.querySelector('[aria-label="主题属性分类"]'), 'personalization')
  await choose(document.querySelector('[data-studio-setting="appearance.toneScheduling"]'), 'timed')
  const schedule = [...document.querySelectorAll('.schedule-time-grid input')]
  expect(schedule.length === 2, 'timed scheduling omitted its time range')
  await choose(schedule[0], '07:30')
  await choose(schedule[1], '21:15')
  await choose(
    document.querySelector('[data-studio-setting="appearance.backgroundTreatment"]'),
    'image'
  )
  expect(
    button('导入图片') && document.querySelectorAll('.asset-editor select').length > 1,
    'theme background bindings unavailable'
  )
  await click('应用主题')
  const savedProfile = themeWrites.at(-1)
  expect(
    savedProfile.modes.appearance?.toneScheduling === 'timed',
    'theme options bypassed theme draft save'
  )
  expect(
    savedProfile.toneSchedule.lightStartMinutes === 450 &&
      savedProfile.toneSchedule.darkStartMinutes === 1275,
    'timed range did not survive save'
  )
  await click('更多')
  for (const [domain, text] of [
    ['windows', '桌面歌词'],
    ['presets', '主题名称']
  ]) {
    await choose(document.querySelector('[aria-label="主题属性分类"]'), domain)
    expect(
      domain === 'presets'
        ? visible(document.querySelector('[aria-label="主题名称"]')) &&
            document.querySelector('.profile-history-section')
        : document.querySelector('.studio-context-popup').textContent.includes(text),
      'missing theme section ' + domain
    )
  }
  for (const domain of ['shell', 'motion', 'advanced']) {
    await choose(document.querySelector('[aria-label="主题属性分类"]'), domain)
    expect(
      document.querySelectorAll('.studio-context-popup .studio-appearance-group').length > 0,
      'missing editable parameters ' + domain
    )
  }
  await showSetting('player-page-mode')
  expect(
    drawer().querySelector('[data-setting-id="player-page-mode"]').checkVisibility(),
    'settings search failed to expand parent disclosures'
  )
  await showSetting('player-bar-layout')
  expect(
    visible(drawer().querySelector('[data-setting-id="player-bar-layout"]')),
    'layout search left buttons collapsed'
  )
  await showSetting('mini-taskbar')
  expect(
    visible(drawer().querySelector('[data-setting-id="mini-taskbar"]')),
    'mini player search left wrapper collapsed'
  )
  await showSetting('appearance-editor-87')
  expect(
    document.activeElement.closest('[data-setting-id="card-enabled"]'),
    'disabled card search did not locate enable condition'
  )
  const beforeCard = writes.length
  drawer().querySelector('[aria-label="启用自定义外观"]').click()
  await tick()
  await click('卡片细节')
  await showSetting('appearance-editor-87')
  expect(
    visible(drawer().querySelector('[data-setting-id="card-saturation"]')),
    'card search left detail collapsed'
  )
  expect(
    document.activeElement.closest('[data-setting-id="card-saturation"]'),
    'card search did not focus parameter'
  )
  const saturation = drawer().querySelector(
    '[data-setting-id="card-saturation"] input[type="range"]'
  )
  saturation.value = '137'
  saturation.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  expect(writes.length === beforeCard, 'card detail bypassed daily draft')
  await click('应用外观')
  expect(
    confirmed.cardAppearance.light.blurSaturation === 137 ||
      confirmed.cardAppearance.dark.blurSaturation === 137,
    'card detail not saved'
  )
  await showSetting('appearance-editor-107')
  expect(
    visible(drawer().querySelector('[aria-label="全局液态玻璃"]')),
    'glass search left wrapper collapsed'
  )
  drawer().querySelector('[aria-label="全局液态玻璃"]').click()
  await tick()
  await showSetting('appearance-editor-107')
  expect(
    document.activeElement.closest('[data-setting-id="glass-pointer"]'),
    'glass search did not focus pointer parameter'
  )
  await click('放弃调整')
  await showSetting('window-transparency')
  expect(
    drawer().querySelector('[aria-label="窗口透明"]').disabled,
    'unsupported transparency became actionable'
  )
  expect(drawer().textContent.includes('重启'), 'system transparency restart condition missing')
  await showSetting('ui-density')
  await click('紧凑')
  expect(confirmed.uiDensity === 'compact', 'density not saved')
  await choose(drawer().querySelector('[aria-label="界面动画"]'), 'off')
  expect(confirmed.motionPreference === 'off', 'motion setting not saved')
  await part('inner-panel')
  await click('调节')
  await click('页面背景设置')
  await choose(document.querySelector('[aria-label="背景应用范围"]'), 'settings')
  expect(
    document.querySelector('.appearance-checkbox input').checked,
    'page inheritance disconnected'
  )
  document.querySelector('.appearance-checkbox input').click()
  await tick()
  await click('图片')
  failImport = true
  const file = document.querySelector('.appearance-file-input'),
    transfer = new DataTransfer()
  file.click = () => {}
  document.querySelector('.appearance-image-actions button').click()
  transfer.items.add(new File(['invalid'], 'invalid.png', { type: 'image/png' }))
  file.files = transfer.files
  file.dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
  expect(
    [...document.querySelectorAll('[role="alert"]')].some((el) =>
      el.textContent.includes('图片导入失败')
    ),
    'image import failure missing'
  )
  failImport = false
  document.querySelector('.appearance-image-actions button').click()
  const retryFile = document.querySelector('.appearance-file-input'),
    retryTransfer = new DataTransfer()
  retryTransfer.items.add(new File(['valid'], 'wallpaper.png', { type: 'image/png' }))
  retryFile.files = retryTransfer.files
  expect(retryFile.files.length === 1, 'retry upload has no file')
  retryFile.dispatchEvent(new Event('change', { bubbles: true }))
  await until(
    () => document.querySelector('#workspace-blur'),
    'valid background image did not expose image effects'
  )
  const scaleEntry = SETTINGS_SEARCH_INDEX.find((e) => e.id === 'appearance-editor-75')
  target.value = { revision: target.value.revision + 1, appearanceTab: 'adjust', entry: scaleEntry }
  await until(
    () => visible(document.querySelector('#workspace-scale')),
    'background scale search opened the wrong group'
  )
  expect(
    document.activeElement.closest('.appearance-slider'),
    'background scale search did not focus its control'
  )
  const scale = document.querySelector('#workspace-scale')
  scale.value = '1.4'
  scale.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
  await click('应用外观')
  expect(
    !confirmed.appBackground.pages.settings.inherit &&
      confirmed.appBackground.pages.settings.image === 'background://fixture.png',
    'independent background not saved'
  )
  expect(
    Object.values(confirmed.appBackground.pages.settings.effects).some(
      (effect) => effect.scale === 1.4
    ),
    'image scale not saved'
  )
  expect(!errors.length, errors.join('\n'))
}
window.prepareCapabilityScreenshots = async () => {
  if (!button('放弃调整').disabled) await click('放弃调整')
  confirmed = plain(initialSettings)
  await settingsStore.loadSettings()
  await themes.setActive({ kind: 'builtin', id: 'builtin:twilight-echo-default' })
  await tick()
}
window.inspectCapabilityPanel = async (panel, tone, font) => {
  allowLeave = true
  const toneButton = document.querySelector('[data-dock-action="preview-tone"]')
  if ((toneButton.getAttribute('aria-pressed') === 'true') !== (tone === 'dark')) {
    toneButton.click()
    await tick()
  }
  await themes.setPreviewTone(tone)
  await tick()
  expect(
    document.documentElement.dataset.theme === tone,
    'visual mode did not update the actual theme'
  )
  document.documentElement.style.setProperty('--te-font-size-body', font + 'px')
  document.querySelector('.appearance-page').style.setProperty('--te-font-size-body', font + 'px')
  await showSetting(
    {
      'global-font': 'global-font',
      'player-bar': 'player-bar-mode',
      'outer-panel': 'window-transparency',
      card: 'appearance-editor-87',
      general: 'ui-density'
    }[panel]
  )
  await tick()
  const dialog = drawer().closest('.appearance-popover'),
    rect = dialog.getBoundingClientRect()
  expect(
    Math.abs(parseFloat(getComputedStyle(drawer()).fontSize) - (font * 15) / 14) < 0.1,
    'properties suppressed large text'
  )
  expect(
    rect.left >= 0 &&
      rect.right <= innerWidth + 1 &&
      rect.top >= 0 &&
      rect.bottom <= innerHeight + 1,
    'properties outside viewport: ' + panel
  )
  const content = dialog.querySelector('.appearance-popover-content')
  expect(
    content.scrollWidth <= content.clientWidth + 1,
    'properties overflow horizontally: ' + panel
  )
  const previewDocument =
    document.querySelector('.appearance-window-frame')?.contentDocument ??
    document.querySelector('iframe')?.contentDocument
  expect(previewDocument, 'visual evidence did not include the real preview')
  expect(
    previewDocument.documentElement.dataset.theme === tone &&
      previewDocument.documentElement.dataset.teAppCustomBackground === 'off' &&
      previewDocument.documentElement.dataset.teLocalTextTone === 'theme',
    'visual evidence retained a previous image or the wrong preview tone'
  )
}
const rootOptions = async () => {
  const options = document.querySelector('.appearance-theme-tools')
  if (!options.open) options.querySelector('summary').click()
  await tick()
  return options
}
const advancedTool = async (label, selector) => {
  const options = await rootOptions()
  const advanced = options.querySelector('.appearance-advanced-tools')
  if (!advanced.open) advanced.querySelector('summary').click()
  await click(label)
  await until(
    () => visible(document.querySelector(selector)),
    'advanced tool did not open: ' + label
  )
  await until(
    () => !document.querySelector('[aria-label="导出 .TEP"]').disabled,
    'advanced editor did not become ready'
  )
}
const inputValue = async (control, value) => {
  control.value = value
  control.dispatchEvent(new Event('input', { bubbles: true }))
  await tick()
}
window.runAdvancedCapabilities = async () => {
  document.documentElement.style.setProperty('--te-font-size-body', '14px')
  document.querySelector('.appearance-page').style.setProperty('--te-font-size-body', '14px')
  await themes.setPreviewTone('dark')
  await showSetting('player-bar-mode')
  await click('紧凑')
  const before = writes.length
  await click('导出 .TEP')
  expect(
    directExports.at(-1).appearance.playerBar.mode === 'compact',
    'direct export lost the unapplied real daily draft'
  )
  expect(writes.length === before, 'direct export saved daily settings')
  allowLeave = false
  await advancedTool('自定义 CSS', '[aria-label="高级 CSS"]')
  expect(
    transfers.length === 1 && transfers[0].appearance.playerBar.mode === 'compact',
    'advanced handoff lost daily edits'
  )
  expect(
    document.querySelectorAll('iframe').length === 1,
    'advanced tools mounted a second preview'
  )
  await inputValue(document.querySelector('[aria-label="高级 CSS"]'), '.card{border-width:3px}')
  advancedSaveFailed = true
  await click('保存项目')
  expect(
    document.body.textContent.includes('高级草稿保存失败'),
    'advanced save error hidden by root'
  )
  advancedSaveFailed = false
  await click('保存项目')
  expect(currentProject().css.includes('border-width:3px'), 'retry lost advanced CSS')
  await advancedTool('图层与蒙版', '.workshop-workspace[popover] button')
  expect(button('＋ 渐变'), 'layers menu was replaced by a part watcher')
  await click('＋ 渐变')
  await click('保存项目')
  expect(
    Object.values(currentProject().layers.dark).flat().length === 1,
    'advanced layers were not saved'
  )
  await advancedTool('参数设计', '.workshop-workspace[popover]')
  expect(button('＋ 新增参数'), 'parameter designer unavailable in root')
  await advancedTool('素材与字体文件', '.workshop-workspace[popover]')
  expect(button('＋ WOFF2 字体'), 'font and image tools unavailable in root')
  const options = await rootOptions()
  await choose(options.querySelector('[aria-label="主题制作分类"]'), 'layout')
  await until(
    () =>
      [...document.querySelectorAll('.workshop-properties label')].some(
        (el) => visible(el) && el.textContent.startsWith('窗口布局')
      ),
    'layout tool did not survive group synchronization'
  )
  await advancedTool('部件背景皮肤', '.appearance-layer-settings')
  expect(
    currentProject().base.structured.appearance.playerBar.mode === 'compact',
    'advanced tools dropped transferred appearance'
  )
  await click('导出 .TEP')
  expect(
    pluginExports.at(-1)?.format === 'tep',
    'root did not use advanced TEP preflight/export path'
  )
  const exported = pluginExports.at(-1).project
  expect(
    exported.css.includes('border-width:3px') &&
      Object.values(exported.layers.dark).flat().length === 1,
    'TEP export lost advanced content'
  )
  expect(advancedProjects.size === 1, 'switching advanced tools duplicated the project')

  // Apply the real structured appearance, then edit it again through daily controls.
  await click('应用主题')
  await until(
    () => !document.querySelector('[aria-label="返回常用调整"]').disabled,
    'applied project did not settle'
  )
  await click('常用调整')
  await showSetting('player-bar-mode')
  expect(
    button('紧凑', drawer()).classList.contains('active'),
    'applied plugin appearance did not become the daily baseline'
  )
  await click('迷你')
  const settingsWrites = writes.length
  await click('应用外观')
  expect(writes.length === settingsWrites, 'plugin daily edits leaked into global settings')
  expect(
    currentProject().base.structured.appearance.playerBar.mode === 'mini',
    'plugin daily apply failed'
  )
  expect(
    currentProject().css.includes('border-width:3px') &&
      Object.values(currentProject().layers.dark).flat().length === 1 &&
      advancedProjects.size === 1,
    'daily editing replaced the existing advanced project'
  )
  await advancedTool('自定义 CSS', '[aria-label="高级 CSS"]')
  expect(!errors.length, errors.join('\n'))
}
window.inspectAdvancedPanel = async (panel, tone, font) => {
  await themes.setPreviewTone(tone)
  const toneButton = document.querySelector('[data-dock-action="preview-tone"]')
  if ((toneButton.getAttribute('aria-pressed') === 'true') !== (tone === 'dark')) {
    toneButton.click()
    await tick()
  }
  document.documentElement.style.setProperty('--te-font-size-body', font + 'px')
  document.querySelector('.appearance-page').style.setProperty('--te-font-size-body', font + 'px')
  if (panel === 'layout') {
    const options = await rootOptions()
    await choose(options.querySelector('[aria-label="主题制作分类"]'), 'layout')
  } else {
    const [label, selector] = {
      css: ['自定义 CSS', '[aria-label="高级 CSS"]'],
      layers: ['图层与蒙版', '.workshop-workspace[popover]'],
      parameters: ['参数设计', '.workshop-workspace[popover]'],
      skin: ['部件背景皮肤', '.appearance-layer-settings']
    }[panel]
    await advancedTool(label, selector)
  }
  await tick()
  const popup = document.querySelector('.workshop-workspace[popover]'),
    rect = popup.getBoundingClientRect()
  expect(popup.matches(':popover-open'), 'advanced popup closed itself: ' + panel)
  expect(
    rect.left >= 0 &&
      rect.right <= innerWidth + 1 &&
      rect.top >= 0 &&
      rect.bottom <= innerHeight + 1,
    'advanced popup outside viewport: ' + panel
  )
  expect(
    popup.scrollWidth <= popup.clientWidth + 1,
    'advanced popup overflows horizontally: ' + panel
  )
  expect(
    Math.abs(parseFloat(getComputedStyle(popup).fontSize) - (font * 15) / 14) < 0.1,
    'advanced tool suppressed larger text'
  )
  const exportButton = document.querySelector('[aria-label="导出 .TEP"]'),
    exportRect = exportButton.getBoundingClientRect()
  expect(
    exportRect.left >= 0 && exportRect.right <= innerWidth && !exportButton.disabled,
    'TEP export unreachable at narrow width'
  )
  const footer = document.querySelector('.appearance-creation-actions')
  expect(footer.scrollWidth <= footer.clientWidth + 1, 'advanced actions overflow horizontally')
  for (const control of footer.querySelectorAll(':scope > div button')) {
    const bounds = control.getBoundingClientRect()
    expect(
      bounds.left >= 0 &&
        bounds.right <= innerWidth + 1 &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight + 1,
      'advanced action outside viewport: ' + control.textContent.trim()
    )
  }
  expect(!errors.length, errors.join('\n'))
}
window.closeAdvancedPanel = async () => {
  document.querySelector('.workshop-workspace[popover] [data-workshop-context-close]').click()
  await tick()
}
window.runLegacyPlayerSettings = async () => {
  app.unmount()
  await tick()
  app = createApp(PlayerBarSettings)
  app.mount('#app')
  await tick()
  const count = writes.length
  await click('紧凑')
  expect(
    confirmed.playerBar.mode === 'compact' && writes.length === count + 1,
    'legacy settings no longer persist immediately'
  )
  app.unmount()
  expect(!errors.length, errors.join('\n'))
}
