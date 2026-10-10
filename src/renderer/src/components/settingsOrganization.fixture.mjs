import { createApp, h, nextTick, ref } from 'vue'
import { createPinia, defineStore } from 'pinia'
import SettingsPage from './SettingsPage.vue'
import { useSettingsStore as realSettingsStore } from '../stores/useSettingsStore.ts'
import { useAppNavigation } from '../app/useAppNavigation.ts'
import { appearanceEditorOpen } from '../composables/appearanceEditorState.ts'
import { LEGACY_SETTINGS_TARGETS, SETTINGS_SEARCH_INDEX } from './settings-page/types.ts'
import { DEFAULT_LYRICS_APPEARANCE } from '../../../shared/lyricsAppearance.ts'
import '../assets/base.css'

const actual = realSettingsStore()
export const settings = actual.settings
settings.value.libraryFolders = ['D:\\Music\\收藏与长路径示例\\Twilight Echo']
settings.value.miniPlayer.showInTaskbar = false
const patches = []
const noop = async () => null
let failSettingsSave = false
const updateSettings = async (patch) => {
  if (failSettingsSave) throw new Error('测试保存失败')
  patches.push(patch)
  settings.value = { ...settings.value, ...patch }
  return settings.value
}
export function useSettingsStore() {
  return {
    ...actual,
    updateSettings,
    loadSettings: noop,
    appVersion: ref('1.3.0'),
    getShortcutStatuses: async () => [],
    windowTransparencySupported: ref(false)
  }
}
export function useMusicStore() {
  return new Proxy(
    {
      libraryScanStatus: ref({ state: 'idle', current: 0, total: 0 }),
      libraryScanProgress: ref(null),
      libraryMetadataEnrichmentStatus: ref({ state: 'idle' }),
      flushPlaylists: async () => true
    },
    { get: (target, key) => (key in target ? target[key] : noop) }
  )
}
export function useThemeStore() {
  return {
    activeTheme: ref({ kind: 'builtin', id: 'builtin:twilight-echo-default' }),
    load: noop,
    setActive: noop
  }
}
const contributions = ref([
  {
    pluginId: 'test.settings',
    id: 'settings',
    kind: 'settingsPanel',
    title: '测试插件',
    command: 'configure'
  }
])
export function useExtensionRegistry() {
  return { uiContributions: contributions, themeContributions: ref([]), syncExtensions: noop }
}
const processing = ref(settings.value.audioProcessing)
const config = ref(settings.value.audioOutputConfig)
const audioStore = defineStore('settings-organization-dsp', () => ({
  audioOutput: ref('wasapi'),
  audioDevice: ref('auto'),
  exclusiveMode: ref(false),
  audioProcessing: processing,
  audioOutputConfig: config,
  audioOutputOptions: ref([{ id: 'wasapi', label: 'WASAPI', supportsExclusive: true }]),
  audioDeviceOptions: ref([]),
  audioOutputDeviceOptions: ref([]),
  audioOutputConfigApplyStatus: ref({ state: 'idle' }),
  playbackInfo: ref(null),
  outputInfo: ref(null),
  loudnormStatus: ref(null),
  audioEngineError: ref(null),
  setAudioProcessing: async (patch) => {
    processing.value = { ...processing.value, ...patch }
  },
  setAudioOutputConfig: async (patch) => {
    config.value = { ...config.value, ...patch }
  },
  setReplayGainMode: async (value) => {
    processing.value = { ...processing.value, dspEnabled: true, volumeNormalization: value }
  },
  setCrossfeedStrength: noop,
  selectImpulseResponse: noop,
  clearImpulseResponse: noop,
  toggleExclusiveMode: noop,
  setAudioOutput: noop,
  setAudioDevice: noop,
  refreshAudioOutputState: noop,
  toggleGapless: noop
}))
export function useAudioOutputDspStore() {
  return audioStore()
}
export function usePlayerStore() {
  return {
    volume: ref(0.7),
    setVolume: noop,
    setUnityVolume: noop,
    queueWorkspace: { flush: noop }
  }
}
export const waitForListeningStatsReady = noop
export function useListeningStatsStore() {
  return { listeningStats: ref({}) }
}

const navigation = useAppNavigation()
const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const settle = async () => {
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 60))
  await nextTick()
}
const app = createApp({
  render: () =>
    h(SettingsPage, {
      initialSection: navigation.settingsInitialSection.value,
      navigationTarget: navigation.settingsNavigationTarget.value,
      onSectionChange: navigation.rememberSettingsSection
    })
})
app.use(createPinia())
window.organizationRendererErrors = []
app.config.errorHandler = (error) => {
  window.organizationRendererErrors.push(String(error))
  console.error(error)
}
app.mount('#app')

window.runSettingsOrganizationTests = async () => {
  await settle()
  const page = document.querySelector('.settings-preview-page')
  const top = [...page.querySelectorAll('.settings-preview-stack > .preview-section')]
  expect(top.length === 7, 'expected seven top-level categories, got ' + top.length)
  expect(
    page.querySelectorAll('button[aria-label="防破音保护"]').length === 1,
    'clip guard must have one control'
  )
  expect(!document.querySelector('.settings-command-actions'), 'duplicate backup toolbar remains')
  for (const id of [
    'scan-diagnostics',
    'cache-details',
    'dsd-routing',
    'dsp-details',
    'vst3-settings',
    'advanced-engine-parameters',
    'plugin-settings',
    'developer-options'
  ]) {
    expect(
      document.querySelector('#' + id + ' > button').getAttribute('aria-expanded') === 'false',
      id + ' must start collapsed'
    )
  }
  const search = async (title) => {
    const input = page.querySelector('#settings-search-input')
    input.value = title
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    const result = [...page.querySelectorAll('[role="option"]')].find(
      (item) => item.querySelector('.settings-nav-result-title').textContent === title
    )
    expect(result, 'search result missing for ' + title)
    result.click()
    await settle()
    const entry = SETTINGS_SEARCH_INDEX.find((entry) => entry.title === title)
    if (entry.appearanceArea) return null
    const deadline = Date.now() + 1500
    while (
      ![entry.id, entry.fallbackId, entry.disclosureId].includes(
        page.querySelector('.search-target-flash')?.dataset.settingId ||
          page.querySelector('.search-target-flash')?.id
      )
    ) {
      expect(Date.now() < deadline, 'search did not finish revealing ' + title)
      await settle()
    }
    expect(
      page.querySelector('.search-target-flash'),
      'missing highlighted search target for ' + title
    )
    return page.querySelector('.search-target-flash')
  }
  for (const title of [
    '缓冲大小',
    'VST3 搜索目录',
    '流派分隔符',
    'BPM 分析缓存',
    '开发者模式',
    '显示翻译',
    '背景透明度 (Background Opacity)',
    '迷你播放器显示在任务栏',
    '播放条按钮编排'
  ]) {
    const target = await search(title)
    expect(target.getClientRects().length, title + ' stayed hidden')
    expect(
      page.querySelector('[aria-current="page"]').textContent.includes(
        {
          缓冲大小: '播放与音效',
          'VST3 搜索目录': '播放与音效',
          流派分隔符: '媒体库与存储',
          'BPM 分析缓存': '媒体库与存储',
          开发者模式: '系统与关于',
          显示翻译: '歌词',
          '背景透明度 (Background Opacity)': '歌词',
          迷你播放器显示在任务栏: '外观',
          播放条按钮编排: '外观'
        }[title]
      ),
      'incorrect active category for ' + title
    )
  }
  const before = JSON.stringify(settings.value)
  await search('路由设备')
  expect(
    page.querySelector('.search-target-flash').dataset.settingId === 'dsd-compatible-route',
    'disabled DSD route should explain its dependency'
  )
  expect(JSON.stringify(settings.value) === before, 'search enabled a setting')
  await search('Preamp')
  expect(
    page.querySelector('.search-target-flash').dataset.settingId === 'dsp-master' &&
      !processing.value.dspEnabled,
    'DSP dependency search must explain and focus its master without enabling it'
  )
  expect(page.querySelector('.settings-inline-notice'), 'missing prerequisite explanation')
  document.querySelector('[data-settings-category="general"]').click()
  await settle()
  expect(
    !page.querySelector('.settings-inline-notice'),
    'category retained unrelated search notice'
  )
  await search('Preamp')
  await search('版本信息')
  expect(
    !page.querySelector('.settings-inline-notice'),
    'new search retained stale prerequisite notice'
  )
  const genre = document.querySelector('[data-setting-id="genre-separators"] input')
  genre.value = '保留输入 / 未提交'
  genre.dispatchEvent(new Event('input', { bubbles: true }))
  const trigger = document.querySelector('#scan-diagnostics > button')
  trigger.click()
  await settle()
  trigger.click()
  await settle()
  expect(
    document.querySelector('[data-setting-id="genre-separators"] input') === genre &&
      genre.value === '保留输入 / 未提交',
    'disclosure remounted or lost input'
  )
  for (const [legacy, target] of Object.entries(LEGACY_SETTINGS_TARGETS)) {
    navigation.openSettingsPage(legacy)
    await settle()
    expect(
      navigation.session.value.settingsSection === target.section,
      'legacy navigation lost selection: ' + legacy
    )
    const anchor = document.querySelector('#' + target.anchor)
    expect(
      anchor === document.activeElement || anchor.contains(document.activeElement),
      'legacy navigation lost focus: ' + legacy
    )
  }
  document.querySelector('[data-setting-id="clip-guard"] button').click()
  await settle()
  expect(
    processing.value.clipGuard === false && processing.value.dspEnabled === false,
    'clip guard should not enable DSP'
  )
  const lyricsBefore = JSON.stringify(settings.value.lyricsAppearance)
  window.confirm = () => true
  document.querySelector('[data-setting-id="reset-settings"] button').click()
  await settle()
  expect(
    JSON.stringify(settings.value.lyricsAppearance) === lyricsBefore,
    'appearance reset affected lyrics'
  )
  settings.value.lyricsAppearance = { ...settings.value.lyricsAppearance, fontSize: 36 }
  const appearanceBefore = JSON.stringify(settings.value.playerBar)
  document.querySelectorAll('[data-setting-id="reset-settings"] button')[2].click()
  await settle()
  expect(
    settings.value.lyricsAppearance.fontSize === DEFAULT_LYRICS_APPEARANCE.fontSize &&
      JSON.stringify(settings.value.playerBar) === appearanceBefore,
    'lyric reset must be independent'
  )
  const desktopSize = document.querySelector('[data-setting-id="desktop-font-size"] select')
  desktopSize.value = '42'
  desktopSize.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(settings.value.desktopLyrics.fontSize === 42, 'desktop lyric edit did not persist')
  const mini = document.querySelector('[data-setting-id="mini-taskbar"] button')
  mini.click()
  await settle()
  expect(settings.value.miniPlayer.showInTaskbar, 'mini-player taskbar setting did not persist')
  await search('背景与界面材质')
  expect(appearanceEditorOpen.value, 'appearance search did not open editor')
  appearanceEditorOpen.value = false
  expect(
    window.organizationRendererErrors.length === 0,
    'renderer errors: ' + window.organizationRendererErrors.join('; ')
  )
  // Every built-in target can be opened using its metadata, including closed native details.
  for (const entry of SETTINGS_SEARCH_INDEX.filter((entry) => !entry.appearanceArea)) {
    navigation.openSettingsPage(entry.section, { entry })
    await settle()
    const target = page.querySelector('.search-target-flash')
    expect(
      target &&
        [entry.id, entry.fallbackId, entry.disclosureId].includes(
          target.dataset.settingId || target.id
        ),
      'index target missing or incorrect: ' + entry.id
    )
    expect(
      target.getClientRects().length && !target.closest('[inert]'),
      'search focused hidden content: ' + entry.id
    )
  }
  const ids = [...page.querySelectorAll('[data-setting-id]')].map(
    (element) => element.dataset.settingId
  )
  expect(new Set(ids).size === ids.length, 'duplicate DOM setting identities')
  contributions.value = []
  await search('插件设置')
  expect(
    document.querySelector('#plugin-settings').textContent.includes('没有额外设置'),
    'empty plugins must remain a useful destination'
  )
  // A new category click supersedes an earlier reveal while its animation is pending.
  document.documentElement.dataset.teMotion = 'full'
  document.querySelector('#scan-diagnostics > button').click()
  await new Promise((resolve) => setTimeout(resolve, 240))
  navigation.openSettingsPage('library', {
    entry: SETTINGS_SEARCH_INDEX.find((entry) => entry.id === 'genre-separators')
  })
  await nextTick()
  page.querySelector('.preview-nav-item').click()
  await new Promise((resolve) => setTimeout(resolve, 350))
  await settle()
  expect(
    navigation.session.value.settingsSection === 'general' &&
      !document.activeElement.closest('[inert]'),
    'stale search overrode the latest category or focused hidden input'
  )
  // Disabled transparency keeps the switch unavailable and its platform reason visible.
  await search('系统窗口透明')
  expect(
    document.querySelector('[data-setting-id="window-transparency"] button').disabled,
    'unsupported native transparency was enabled'
  )
  expect(
    document
      .querySelector('[data-setting-id="window-transparency"]')
      .textContent.includes('当前系统暂不支持'),
    'missing transparency reason'
  )
  const key = (keyCode) => window.organizationKey(keyCode)
  navigation.openSettingsPage('system')
  await settle()
  const developer = document.querySelector('#developer-options > button')
  if (developer.getAttribute('aria-expanded') === 'true') developer.click()
  await new Promise((resolve) => setTimeout(resolve, 220))
  await settle()
  document.documentElement.dataset.teMotion = 'reduced'
  developer.focus()
  await key('Space')
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(developer.getAttribute('aria-expanded') === 'true', 'keyboard could not expand a group')
  await key('Tab')
  expect(
    document.activeElement.closest('#developer-options-content'),
    'Tab did not reach the expanded controls'
  )
  developer.click()
  await nextTick()
  expect(
    document.activeElement === developer &&
      document.querySelector('#developer-options-content').inert,
    'collapse did not restore focus or deactivate its content'
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  await key('Tab')
  expect(
    !document.activeElement.closest('#developer-options-content'),
    'Tab entered collapsed content'
  )
  await search('缓冲大小')
  expect(
    document.activeElement === document.querySelector('[data-setting-id="buffer-size"] select'),
    'search failed to focus its real control in reduced motion: ' +
      document.activeElement.outerHTML.slice(0, 300) +
      ' target=' +
      page.querySelector('.search-target-flash')?.outerHTML.slice(0, 300)
  )
  document.documentElement.dataset.teMotion = 'off'
  for (const density of ['compact', 'comfortable', 'standard']) {
    document.documentElement.dataset.density = density
    document.documentElement.style.setProperty(
      '--te-font-size-body',
      density === 'comfortable' ? '18px' : '14px'
    )
    await search('BPM 分析缓存')
    const target = page.querySelector('.search-target-flash').getBoundingClientRect()
    expect(
      target.top >= page.getBoundingClientRect().top && target.bottom <= innerHeight,
      'resized type/density caused inaccurate search positioning'
    )
    expect(
      getComputedStyle(page.querySelector('.preview-section')).paddingTop === '24px' &&
        getComputedStyle(page.querySelector('.settings-preview-stack')).gap === '20px',
      'settings card rhythm changed with density'
    )
  }
  document.documentElement.style.removeProperty('--te-font-size-body')
  // Saving failure stays visible and rolls back the mini-player draft.
  await search('迷你播放器显示在任务栏')
  failSettingsSave = true
  const miniBeforeFailure = settings.value.miniPlayer.showInTaskbar
  document.querySelector('[data-setting-id="mini-taskbar"] button').click()
  await settle()
  expect(
    document.querySelector('#mini-player').textContent.includes('测试保存失败') &&
      document
        .querySelector('[data-setting-id="mini-taskbar"] button')
        .getAttribute('aria-checked') === String(miniBeforeFailure),
    'mini-player failed save must remain visible and restore its confirmed value'
  )
  failSettingsSave = false
  // The personal-data preview remains above the settings overlay and preserves confirmation.
  let stagedRestore = null
  window.api.data = {
    previewPersonalBackup: async () => ({
      version: 1,
      createdAt: '2026-10-09T00:00:00Z',
      rows: [{ domain: 'playlists', incoming: 2, current: 1, conflicts: 1 }],
      roots: []
    }),
    stagePersonalRestore: async (options) => {
      stagedRestore = options
    }
  }
  await search('个人数据备份与迁移')
  document.querySelectorAll('[data-setting-id="personal-backup"] .buttons button')[1].click()
  await settle()
  const dialog = document.querySelector('.restore-dialog')
  expect(dialog, 'personal backup preview failed to open')
  const dialogRect = dialog.getBoundingClientRect()
  expect(
    dialog.contains(document.elementFromPoint(dialogRect.left + 40, dialogRect.top + 40)),
    'backup preview was covered by settings'
  )
  expect(stagedRestore === null, 'preview staged a restore before confirmation')
  dialog.querySelector('.buttons button:last-child').click()
  await settle()
  expect(
    stagedRestore?.domains[0] === 'playlists' && !document.querySelector('.restore-dialog'),
    'backup restore confirmation lost its selected domain'
  )
  // Cache cleanup still requires an explicit confirmation and uses the existing store operation.
  let cacheCleared = 0
  window.api.settings = {
    clearCache: async () => {
      cacheCleared += 1
      return 0
    }
  }
  await search('缓存占用')
  window.confirm = () => false
  page.querySelector('[data-setting-id="cache-usage"] button').click()
  await settle()
  expect(cacheCleared === 0, 'cache cleanup bypassed cancellation')
  window.confirm = () => true
  page.querySelector('[data-setting-id="cache-usage"] button').click()
  await settle()
  expect(cacheCleared === 1, 'cache cleanup lost its confirmed operation')
  expect(
    window.organizationRendererErrors.length === 0,
    'renderer errors after navigation: ' + window.organizationRendererErrors.join('; ')
  )
  return 'SETTINGS_ORGANIZATION_OK: real sections, search, legacy navigation, preserved input and persistence verified'
}

window.prepareSettingsEvidence = async (theme, section, material = 'solid') => {
  document.documentElement.dataset.theme = theme
  document.documentElement.dataset.teMotion = 'off'
  for (const id of [
    'scan-diagnostics',
    'cache-details',
    'dsd-routing',
    'dsp-details',
    'vst3-settings',
    'advanced-engine-parameters',
    'plugin-settings',
    'developer-options'
  ]) {
    const trigger = document.querySelector('#' + id + ' > button')
    if (trigger?.getAttribute('aria-expanded') === 'true') trigger.click()
  }
  document.querySelector('#desktop-lyrics-advanced').open = false
  navigation.openSettingsPage(section)
  await settle()
  // Native theme variables normally come from the app theme controller.
  const dark = theme === 'dark'
  const root = document.documentElement
  root.dataset.density = 'standard'
  root.dataset.teCardCustom = material === 'glass' ? 'on' : 'off'
  root.dataset.teSurfaceMaterial = material === 'glass' ? 'liquidGlass' : 'standard'
  for (const [key, value] of Object.entries({
    '--te-settings-text': dark ? '#f2f3f7' : '#202634',
    '--te-settings-text-muted': dark ? '#b4bdce' : '#69758a',
    '--te-card-bg': dark ? '#252b39' : '#ffffff',
    '--te-settings-control-bg': dark ? '#303746' : '#f0f2f6',
    '--te-subtle-bg': dark ? '#2b3241' : '#f6f7fa',
    '--te-card-border': dark ? '#465065' : '#e4e8ef',
    '--te-settings-search-bg': dark ? '#303746' : '#eef1f6',
    '--te-primary-500': '#3974ff',
    '--te-primary-rgb': '57,116,255'
  }))
    root.style.setProperty(key, value)
  document.body.style.background = dark ? '#151a25' : '#f3f5f9'
  if (material !== 'solid') {
    const wallpaper =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="#172e54"/><stop offset=".45" stop-color="#547e9c"/><stop offset="1" stop-color="#e9b69a"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h1440v900H0z"/><circle cx="1150" cy="260" r="130" fill="#f4d2ab"/><path fill="#174956" d="M0 530 380 400 780 640 1200 390 1440 500v400H0z"/><path fill="#153b48" d="m0 700 530-190 510 250 400-150v290H0z"/></svg>'
    document.body.style.backgroundImage =
      'url("data:image/svg+xml,' + encodeURIComponent(wallpaper) + '")'
    document.body.style.backgroundSize = 'cover'
    document.body.style.backgroundAttachment = 'fixed'
  }
  if (material === 'glass') {
    for (const [key, value] of Object.entries({
      '--te-card-bg': dark ? 'rgb(32 42 54 / .90)' : 'rgb(255 255 255 / .90)',
      '--te-card-blur': '20px',
      '--te-lg-context-label': dark ? '#f2f3f7' : '#202634',
      '--te-lg-context-rim': '#fff',
      '--te-lg-context-surface': dark ? 'rgb(32 42 54 / .90)' : 'rgb(255 255 255 / .90)',
      '--te-lg-context-material': dark ? '#252b39' : '#fff',
      '--te-lg-context-surface-solid': dark ? '#252b39' : '#fff',
      '--te-lg-context-shadow': 'rgb(12 20 32 / .12)'
    }))
      root.style.setProperty(key, value)
  }
  pageToTop(section)
  await settle()
  const active = document.querySelector('.settings-nav-categories [aria-current="page"]')
  const strip = document.querySelector('.settings-nav-categories')
  const activeRect = active.getBoundingClientRect(),
    stripRect = strip.getBoundingClientRect()
  expect(
    !strip.getClientRects().length ||
      (activeRect.left >= stripRect.left - 2 && activeRect.right <= stripRect.right + 2),
    'active category is clipped at ' + innerWidth + '/' + section
  )
  return [
    ...document.querySelectorAll(
      '.settings-preview-page button, .settings-preview-page select, .settings-preview-page input'
    )
  ]
    .filter(
      (element) => element.getClientRects().length && !element.closest('.settings-nav-categories')
    )
    .filter((element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > innerWidth || rect.right > innerWidth + 2 || rect.left < -2
    })
    .map((element) => element.outerHTML.slice(0, 150))
}
window.checkSettingsSearchPopup = async () => {
  const input = document.querySelector('#settings-search-input')
  input.value = '缓存'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  const popup = document.querySelector('#settings-search-results'),
    rect = popup.getBoundingClientRect()
  expect(
    rect.left >= 0 && rect.right <= innerWidth && rect.top >= 32 && rect.bottom <= innerHeight,
    'search popup is clipped at ' + innerWidth
  )
  const point = document.elementFromPoint(rect.left + 16, rect.top + 16)
  expect(popup.contains(point), 'search popup is covered by settings content')
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}
function pageToTop(section) {
  document.querySelector('[data-settings-category="' + section + '"]').click()
}
