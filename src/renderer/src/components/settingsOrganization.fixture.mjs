import { createApp, h, nextTick, ref } from 'vue'
import { createPinia, defineStore } from 'pinia'
import SettingsPage from './SettingsPage.vue'
import AppearancePage from './AppearancePage.vue'
import { useSettingsStore as realSettingsStore } from '../stores/useSettingsStore.ts'
import { useAppNavigation } from '../app/useAppNavigation.ts'
import {
  appearanceEditorOpen,
  appearanceFullWindowPreview
} from '../composables/appearanceEditorState.ts'
import { LEGACY_SETTINGS_TARGETS, SETTINGS_SEARCH_INDEX } from './settings-page/types.ts'
import { DEFAULT_LYRICS_APPEARANCE } from '../../../shared/lyricsAppearance.ts'
import '../assets/base.css'
import '../assets/typography.css'
import './settings-page/SettingsPage.css'
import 'primeicons/primeicons.css'
import { providePageDock } from '../app/pageDock.ts'

// Settings keep their real resource disclosure; the fixture has no installed stem pack.
const fallbackAudioEngine = window.api.audioEngine
window.api.audioEngine = new Proxy(fallbackAudioEngine, {
  get(target, method) {
    if (method === 'getAutoMixStemCapabilities')
      return async () => ({ status: 'missing', cpu: false, gpu: false, packs: [] })
    if (method === 'getAutoMixStemInstallStatus')
      return async () => ({ phase: 'idle', completedBytes: 0, totalBytes: 0 })
    return target[method]
  }
})

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
const activeFixtureTheme = ref({ kind: 'builtin', id: 'builtin:twilight-echo-default' })
export function useThemeStore() {
  return {
    activeTheme: activeFixtureTheme,
    profiles: ref([]),
    load: noop,
    setActive: async (selection) => {
      activeFixtureTheme.value = selection
    }
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
const fixtureSkins = ref([])
export const syncExtensions = noop
let skinChanged = () => {}
window.api.plugins = {
  ...window.api.plugins,
  list: async () =>
    fixtureSkins.value.map((skin) => ({
      id: skin.pluginId,
      name: skin.name,
      type: ['theme'],
      enabled: true
    })),
  listIndex: async () => [],
  getIndexStatus: async () => ({ loadedFrom: 'bundled' }),
  onChanged: (listener) => {
    skinChanged = listener
    return () => {
      skinChanged = () => {}
    }
  }
}
export function useExtensionRegistry() {
  return { uiContributions: contributions, themeContributions: fixtureSkins, syncExtensions: noop }
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

export const navigation = useAppNavigation()
const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const settle = async () => {
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 60))
  await nextTick()
}
let dock
const app = createApp({
  setup() {
    dock = providePageDock('appearance')
    return () =>
      h('div', [
        h(SettingsPage, {
          active: !navigation.showAppearancePage.value,
          initialSection: navigation.settingsInitialSection.value,
          navigationTarget: navigation.settingsNavigationTarget.value,
          onSectionChange: navigation.rememberSettingsSection,
          onOpenAppearance: navigation.openAppearancePage,
          style: { display: navigation.showAppearancePage.value ? 'none' : '' }
        }),
        h(AppearancePage, {
          active: navigation.showAppearancePage.value,
          navigationTarget: navigation.appearanceNavigationTarget.value,
          style: { display: navigation.showAppearancePage.value ? '' : 'none' }
        })
      ])
  }
})
app.use(createPinia())
window.organizationRendererErrors = []
app.config.errorHandler = (error) => {
  window.organizationRendererErrors.push(String(error))
  console.error(error)
}
app.mount('#app')

window.runSettingsOrganizationTests = async () => {
  navigation.openSettingsPage('general')
  await settle()
  const page = document.querySelector('.settings-preview-page')
  const top = [...page.querySelectorAll('.settings-preview-stack > .preview-section')]
  expect(
    top.length === 7,
    'expected seven retained panels serving eight settings categories, got ' + top.length
  )
  expect(
    page.querySelectorAll('[data-settings-category]').length === 8,
    'eight settings categories must share one navigation'
  )
  expect(
    !page.querySelector('[data-settings-category="appearance"]'),
    'appearance remains a settings category'
  )
  expect(!page.querySelector('.settings-page-header'), 'duplicate category introduction remains')
  expect(
    !page.querySelector('.settings-section-description'),
    'duplicate section introduction remains'
  )
  navigation.openAppearancePage()
  await settle()
  expect(navigation.showAppearancePage.value, 'appearance must open independently')
  const appearance = document.querySelector('.appearance-page')
  expect(
    appearance.querySelector('.appearance-page-title')?.textContent === '外观',
    'appearance lost its own title'
  )
  expect(
    !appearance.querySelector(
      '.settings-workspace-navigation, [data-settings-category], #settings-search-input'
    ),
    'appearance contains settings navigation'
  )
  navigation.closeAppearancePage()
  await settle()
  expect(
    navigation.showSettingsPage.value,
    'appearance back must restore the retained settings page'
  )
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
  const visible = (selector) => !!page.querySelector(selector)?.getClientRects().length
  for (const motion of ['full', 'reduced', 'off']) {
    document.documentElement.dataset.teMotion = motion
    for (const section of ['playback', 'audio', 'system', 'about']) {
      navigation.openSettingsPage(section)
      await settle()
      const panel = page.querySelector('#' + section)
      expect(
        !document
          .getAnimations()
          .some((animation) => animation.effect?.target?.matches?.('.section-title-row')),
        'hidden duplicate headings must not animate'
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(
        getComputedStyle(panel).opacity === '1' && !panel.getAnimations().length,
        'category retained an opacity layer: ' + motion + '/' + section
      )
    }
  }
  navigation.openSettingsPage('system')
  await settle()
  expect(!visible('#about'), 'system still contains version and about')
  navigation.openSettingsPage('about')
  await settle()
  expect(
    visible('#about') && !visible('#system') && !page.querySelector('#system #about'),
    'version and about must be a separate settings page'
  )
  navigation.openSettingsPage('playback')
  await settle()
  expect(
    visible('[data-setting-id="track-activation"]') && visible('#playback-transitions'),
    'playback must contain daily habits and transitions'
  )
  expect(
    !visible('[data-setting-id="audio-device"]') && !visible('#dsp'),
    'playback still contains audio hardware or DSP'
  )
  navigation.openSettingsPage('audio')
  await settle()
  expect(
    visible('[data-setting-id="audio-device"]') && visible('#dsp'),
    'audio must contain output devices and DSP'
  )
  expect(
    !visible('[data-setting-id="track-activation"]') && !visible('#playback-transitions'),
    'audio contains playback habits'
  )
  const search = async (title) => {
    if (navigation.showAppearancePage.value) navigation.closeAppearancePage()
    await settle()
    const entry = SETTINGS_SEARCH_INDEX.find((entry) => entry.title === title)
    if (entry.section === 'appearance') {
      // Global commands keep their direct Appearance targets; local Settings search stays scoped.
      const input = page.querySelector('#settings-search-input')
      input.value = title
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      expect(
        !page.querySelector('[role="option"]'),
        'settings search exposes appearance-only options'
      )
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      navigation.openAppearancePage(entry)
    } else {
      const input = page.querySelector('#settings-search-input')
      input.value = title
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()
      const result = [...page.querySelectorAll('[role="option"]')].find(
        (item) => item.querySelector('.settings-nav-result-title').textContent === title
      )
      expect(result, 'search result missing for ' + title)
      result.click()
    }
    await settle()
    const destination =
      entry.section === 'appearance' ? document.querySelector('.appearance-page') : page
    if (entry.appearanceArea) return null
    const deadline = Date.now() + 1500
    while (
      ![entry.id, entry.fallbackId, entry.disclosureId].includes(
        destination.querySelector('.search-target-flash')?.dataset.settingId ||
          destination.querySelector('.search-target-flash')?.id
      )
    ) {
      expect(Date.now() < deadline, 'search did not finish revealing ' + title)
      await settle()
    }
    expect(
      destination.querySelector('.search-target-flash'),
      'missing highlighted search target for ' + title
    )
    return destination.querySelector('.search-target-flash')
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
    if (SETTINGS_SEARCH_INDEX.find((entry) => entry.title === title).section === 'appearance') {
      expect(
        navigation.showAppearancePage.value && target.closest('.appearance-page'),
        'appearance destination did not open its workspace'
      )
      continue
    }
    expect(
      page.querySelector('[aria-current="page"]').textContent.includes(
        {
          缓冲大小: '音频',
          'VST3 搜索目录': '音频',
          流派分隔符: '媒体库',
          'BPM 分析缓存': '媒体库',
          开发者模式: '系统',
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
  expect(
    navigation.showAppearancePage.value && !appearanceEditorOpen.value,
    'appearance search must open its independent workspace'
  )
  appearanceEditorOpen.value = false
  expect(
    window.organizationRendererErrors.length === 0,
    'renderer errors: ' + window.organizationRendererErrors.join('; ')
  )
  // Every built-in target can be opened using its metadata, including closed native details.
  for (const entry of SETTINGS_SEARCH_INDEX.filter((entry) => !entry.appearanceArea)) {
    navigation.openSettingsPage(entry.section, { entry })
    await settle()
    const destination =
      entry.section === 'appearance' ? document.querySelector('.appearance-page') : page
    const target = destination.querySelector('.search-target-flash')
    expect(
      target &&
        [
          entry.id === 'theme-workshop' ? 'plugin-theme' : entry.id,
          entry.fallbackId,
          entry.disclosureId
        ].includes(target.dataset.settingId || target.id),
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
      'resized type/density caused inaccurate search positioning: ' +
        density +
        '/' +
        JSON.stringify({
          top: target.top,
          bottom: target.bottom,
          pageTop: page.getBoundingClientRect().top,
          height: innerHeight,
          scroll: page.scrollTop,
          scrollHeight: page.scrollHeight,
          clientHeight: page.clientHeight,
          overflow: getComputedStyle(page).overflowY,
          navigation: page.querySelector('nav').className
        })
    )
    expect(
      getComputedStyle(page.querySelector('.preview-section')).paddingTop === '0px' &&
        getComputedStyle(page.querySelector('.settings-preview-stack')).gap === '24px',
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

// These checks measure the real settings controls, including expanded groups.
// Native playback, accounts and update services remain outside this layout fixture.
window.inspectSettingsLayout = async (theme, section, fontSize) => {
  document.documentElement.style.setProperty('--te-font-size-body', fontSize + 'px')
  await window.prepareSettingsEvidence(theme, section)
  const page = document.querySelector('[data-settings-layout="categories"]')
  const visible = (element) => {
    if (!element.getClientRects().length || getComputedStyle(element).visibility !== 'visible')
      return false
    // Chromium gives descendants of a closed native details element rectangles
    // even though they cannot be painted or reached by the keyboard.
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (
        parent.matches('details:not([open])') &&
        !parent.querySelector(':scope > summary')?.contains(element)
      )
        return false
    return true
  }
  for (let depth = 0; depth < 3; depth++) {
    const closed = [
      ...page.querySelectorAll('.settings-group-trigger[aria-expanded="false"]')
    ].filter(visible)
    if (!closed.length) break
    closed.forEach((trigger) => trigger.click())
    await settle()
  }
  const stack = page.querySelector('.settings-preview-stack')
  const expandedDetails = [...stack.querySelectorAll('details')].filter(visible)
  expandedDetails.forEach((details) => {
    details.open = true
  })
  await settle()
  const controls = [...stack.querySelectorAll('button, input, select, textarea, [role="switch"]')]
    .filter(visible)
    .filter((element) => !element.matches('[type="hidden"]'))
  const issues = []
  const describe = (element) =>
    element.getAttribute('aria-label') ||
    element.closest('[data-setting-id]')?.getAttribute('data-setting-id') ||
    element.textContent.trim().slice(0, 48) ||
    element.outerHTML.slice(0, 100)
  const measure = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      name: describe(element),
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      fontSize: parseFloat(style.fontSize),
      lineHeight: style.lineHeight
    }
  }
  for (const control of controls) {
    const rect = control.getBoundingClientRect()
    if (rect.left < -1 || rect.right > innerWidth + 1)
      issues.push({ type: 'horizontal-overflow', ...measure(control) })
    if (
      control.matches(
        'select, input:not([type="range"]):not([type="checkbox"]):not([type="color"])'
      )
    ) {
      const style = getComputedStyle(control)
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
      const required = lineHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      if (control.clientHeight + 1 < required)
        issues.push({ type: 'text-height', required, ...measure(control) })
      if (
        !control.getAttribute('aria-label') &&
        !control.getAttribute('aria-labelledby') &&
        !control.labels?.length &&
        !control.title
      )
        issues.push({ type: 'unnamed-field', ...measure(control) })
    }
  }
  for (const row of [...stack.querySelectorAll('.setting-item, .mini-setting')].filter(visible)) {
    const copy = row.querySelector(':scope > .setting-copy, :scope > div:first-child')
    if (!copy || !visible(copy)) continue
    const copyRect = copy.getBoundingClientRect()
    for (const control of [...row.children].filter((child) => child !== copy && visible(child))) {
      const rect = control.getBoundingClientRect()
      if (
        Math.min(copyRect.right, rect.right) > Math.max(copyRect.left, rect.left) + 1 &&
        Math.min(copyRect.bottom, rect.bottom) > Math.max(copyRect.top, rect.top) + 1
      )
        issues.push({ type: 'row-overlap', ...measure(control) })
    }
  }
  const groupTitles = [
    ...stack.querySelectorAll('.settings-group-title, .preview-section > .section-block > h3')
  ].filter(visible)
  const fieldTitle = [
    ...stack.querySelectorAll('.setting-copy > strong, .mini-setting > div > strong')
  ].find(visible)
  if (fieldTitle) {
    const fieldSize = parseFloat(getComputedStyle(fieldTitle).fontSize)
    for (const title of groupTitles)
      if (parseFloat(getComputedStyle(title).fontSize) <= fieldSize)
        issues.push({ type: 'group-hierarchy', fieldSize, ...measure(title) })
  }
  const desktopHeading = page.querySelector('#desktopLyrics .desktop-lyrics-heading > h3')
  if (desktopHeading && visible(desktopHeading)) {
    const options = [...page.querySelectorAll('#desktopLyrics .quick-control-row .check-field')]
    if (desktopHeading.getBoundingClientRect().bottom > options[0].getBoundingClientRect().top + 1)
      issues.push({ type: 'lyrics-heading-placement', ...measure(desktopHeading) })
    for (const option of options) {
      const label = option.querySelector('span').getBoundingClientRect()
      const checkbox = option.querySelector('input').getBoundingClientRect()
      const row = option.getBoundingClientRect()
      const style = getComputedStyle(option)
      const contentLeft =
        row.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)
      const contentRight =
        row.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
      if (
        Math.abs(label.left - contentLeft) > 1 ||
        Math.abs(checkbox.right - contentRight) > 1 ||
        label.right + 8 > checkbox.left
      )
        issues.push({ type: 'lyrics-checkbox-alignment', ...measure(option) })
    }
    for (const field of [...page.querySelectorAll('#desktopLyrics .field:has(> select)')].filter(
      visible
    )) {
      const label = field.querySelector(':scope > span')
      const row = field.getBoundingClientRect()
      const control = field.querySelector('select').getBoundingClientRect()
      const style = getComputedStyle(field)
      const contentRight =
        row.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)
      if (
        !label?.textContent.trim() ||
        Math.abs(control.right - contentRight) > 1 ||
        label.getBoundingClientRect().right + 8 > control.left
      )
        issues.push({ type: 'lyrics-select-alignment', ...measure(field) })
    }
  }
  const categorySelect = page.querySelector('.settings-market-category-select')
  if (visible(categorySelect)) {
    const style = getComputedStyle(categorySelect)
    const required =
      (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2) +
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom)
    if (categorySelect.clientHeight + 1 < required)
      issues.push({ type: 'category-height', required, ...measure(categorySelect) })
    if (parseFloat(style.fontSize) < fontSize)
      issues.push({ type: 'category-text-scaling', ...measure(categorySelect) })
  }
  page.scrollTop = 0
  await settle()
  const first = controls[0]
  if (first && first.getBoundingClientRect().top >= innerHeight - 32)
    issues.push({ type: 'first-control-hidden', ...measure(first) })
  const last = controls.at(-1)
  if (last) {
    last.scrollIntoView({ block: 'end', inline: 'nearest' })
    await settle()
    const rect = last.getBoundingClientRect()
    if (rect.bottom > innerHeight + 1 || rect.top < page.getBoundingClientRect().top - 1)
      issues.push({ type: 'last-control-unreachable', ...measure(last) })
  }
  page.scrollTop = 0
  await settle()
  if (section === 'general') {
    const closeBehavior = page.querySelector('[data-setting-id="close-window"] select')
    const style = getComputedStyle(closeBehavior)
    const context = document.createElement('canvas').getContext('2d')
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    const required =
      context.measureText(closeBehavior.selectedOptions[0].textContent.trim()).width +
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      24
    if (closeBehavior.clientWidth + 1 < required)
      issues.push({ type: 'selected-label-clipped', required, ...measure(closeBehavior) })
    const search = page.querySelector('.settings-market-search input')
    search.value = '缓存'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    const clear = page.querySelector('.settings-market-search button')
    const rect = clear.getBoundingClientRect()
    if (Math.min(rect.width, rect.height) < 32)
      issues.push({ type: 'search-clear-target', ...measure(clear) })
    clear.click()
    await settle()
  }
  const result = {
    theme,
    section,
    fontSize,
    width: innerWidth,
    height: innerHeight,
    contentWidth: stack.getBoundingClientRect().width,
    controlCount: controls.length,
    firstControlTop: first?.getBoundingClientRect().top ?? null,
    fields: controls
      .filter((control) => control.matches('select, input[type="number"], input[type="text"]'))
      .map(measure),
    groupTitles: groupTitles.map(measure),
    issues
  }
  expandedDetails.forEach((details) => {
    details.open = false
  })
  return result
}

async function setPreviewTone(theme) {
  const action = dock.actions.value.find((item) => item.id === 'preview-tone')
  expect(action, 'appearance preview tone action missing from the page dock')
  if (action.pressed !== (theme === 'dark')) await action.run()
  await settle()
}
window.runAppearanceWorkspaceTests = async () => {
  await updateSettings({ theme: 'pureWhite' })
  document.documentElement.dataset.theme = 'pureWhite'
  await settle()
  navigation.openAppearancePage()
  await settle()
  const page = document.querySelector('.appearance-page')
  page.querySelector('#appearance-selection-tab').click()
  await settle()
  expect(
    page.querySelector('#appearance-theme-selection'),
    'appearance should open theme selection'
  )
  expect(
    !page.querySelector('[data-theme-key^="plugin:"]'),
    'empty plugin skins should remain unavailable'
  )
  fixtureSkins.value = [{ pluginId: 'test.skin', id: 'sample', name: '测试插件皮肤' }]
  skinChanged()
  await settle()
  await settle()
  const themeButton = page.querySelector('[data-theme-key="plugin:test.skin:sample"]')
  expect(themeButton && !themeButton.disabled, 'enabled plugin skin missing from theme selection')
  themeButton.click()
  await settle()
  expect(
    activeFixtureTheme.value.kind === 'plugin' && activeFixtureTheme.value.themeId === 'sample',
    'plugin skin did not use canonical selection'
  )
  page.querySelector('[data-theme-key="preset:builtin:twilight-echo-default"]').click()
  await settle()
  expect(activeFixtureTheme.value.kind === 'builtin', 'returning to builtin failed')
  fixtureSkins.value = []
  page.querySelector('#appearance-customize-tab').click()
  await settle()
  await setPreviewTone('pureWhite')
  const editor = page.querySelector('.appearance-editor--embedded')
  const button = (label) =>
    [...editor.querySelectorAll('button')].find((item) => item.textContent.trim() === label)
  if (!button('应用外观').disabled) {
    button('应用外观').click()
    await settle()
  }
  await setPreviewTone('dark')
  expect(
    settings.value.theme === 'pureWhite' && !button('应用外观').disabled,
    'page dock dark selection must create an unapplied appearance change'
  )
  button('应用外观').click()
  await settle()
  expect(
    settings.value.theme === 'dark' && button('应用外观').disabled,
    'page dock dark selection must persist when applied'
  )
  await setPreviewTone('pureWhite')
  button('放弃调整').click()
  await settle()
  expect(
    settings.value.theme === 'dark' &&
      dock.actions.value.find((item) => item.id === 'preview-tone').pressed &&
      button('应用外观').disabled,
    'discard must restore the confirmed tone and page dock state'
  )
  await setPreviewTone('pureWhite')
  button('应用外观').click()
  await settle()
  editor.querySelector('[data-part="inner-panel"]').click()
  await settle()
  let color = editor.querySelector('.appearance-inspector input[type="color"]')
  const editColor = async (value) => {
    color.value = value
    color.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  const before = JSON.stringify(settings.value.appBackground)
  await editColor('#345678')
  navigation.openSettingsPage('general')
  await settle()
  expect(navigation.showSettingsPage.value, 'draft prevented returning to settings')
  navigation.openAppearancePage()
  await settle()
  color = editor.querySelector('.appearance-inspector input[type="color"]')
  expect(
    color?.value === '#345678' && JSON.stringify(settings.value.appBackground) === before,
    'independent page navigation reset or persisted the appearance draft'
  )
  const confirmedTheme = JSON.stringify(activeFixtureTheme.value)
  let discardPrompt = ''
  window.confirm = (message) => {
    discardPrompt = message
    return false
  }
  page.querySelector('#appearance-selection-tab').click()
  await settle()
  expect(
    discardPrompt.includes('放弃') &&
      JSON.stringify(activeFixtureTheme.value) === confirmedTheme &&
      page.querySelector('.appearance-editor--embedded') === editor &&
      color.value === '#345678',
    'theme switching can overwrite an unsaved appearance draft'
  )
  window.confirm = () => true
  expect(
    JSON.stringify(settings.value.appBackground) === before,
    'preview persisted without applying'
  )
  expect(
    editor
      .querySelector('.appearance-window-preview')
      .style.getPropertyValue('--appearance-color') === '#345678',
    'draft color did not reach the preview'
  )
  button('放弃调整').click()
  await settle()
  expect(
    JSON.stringify(settings.value.appBackground) === before && button('应用外观').disabled,
    'discard did not restore the confirmed appearance'
  )
  await editColor('#234567')
  failSettingsSave = true
  button('应用外观').click()
  await settle()
  expect(
    editor.textContent.includes('测试保存失败') && !button('应用外观').disabled,
    'failed appearance save lost its retryable draft'
  )
  failSettingsSave = false
  button('应用外观').click()
  await settle()
  expect(
    settings.value.appBackground.global.light === '#234567' && button('应用外观').disabled,
    'apply did not persist the draft or settle its dirty state'
  )
  await editColor('#456789')
  settings.value = { ...settings.value, fontFamily: 'default' }
  await settle()
  expect(
    editor
      .querySelector('.appearance-window-preview')
      .style.getPropertyValue('--appearance-color') === '#456789',
    'unrelated font changes discarded the background draft'
  )
  settings.value = {
    ...settings.value,
    appBackground: {
      ...settings.value.appBackground,
      global: { ...settings.value.appBackground.global, light: '#56789a' }
    }
  }
  await settle()
  expect(
    button('应用外观').disabled && editor.textContent.includes('外观已在其他位置更改'),
    'stale draft could overwrite a newer appearance'
  )
  button('放弃调整').click()
  await settle()
  expect(color.value === '#56789a', 'discard did not use the latest confirmed settings')
  const preview = editor.querySelector('.appearance-window-preview')
  const box = preview.getBoundingClientRect()
  editor.querySelector('[aria-label="调整标题栏材质"]').click()
  await settle()
  expect(
    editor.querySelector('[data-part="material"]').getAttribute('aria-pressed') === 'true',
    'preview region did not select its controls'
  )
  const next = preview.getBoundingClientRect()
  expect(
    Math.abs(box.width - next.width) < 1 && Math.abs(box.height - next.height) < 1,
    'changing editor tabs resized the preview'
  )
  button('全窗口预览').click()
  await settle()
  const toolbar = document.querySelector('.appearance-full-preview-toolbar')
  expect(
    appearanceFullWindowPreview.value && toolbar && !page.contains(toolbar),
    'full preview toolbar remained inside the hidden appearance page'
  )
  const returnButton = Array.from(toolbar.querySelectorAll('button')).find(
    (item) => item.textContent === '返回编辑'
  )
  returnButton.click()
  await settle()
  expect(
    !appearanceFullWindowPreview.value && editor.getClientRects().length,
    'full preview could not return to editing'
  )
  expect(!appearanceEditorOpen.value, 'workspace opened the legacy modal')
  return 'APPEARANCE_WORKSPACE_OK: preview, discard, retry, conflict protection, contextual controls and full-window return verified'
}

window.prepareAppearanceWorkspaceEvidence = async (theme) => {
  await window.prepareSettingsEvidence(theme, 'general')
  navigation.openAppearancePage()
  await settle()
  const page = document.querySelector('.appearance-page')
  page.querySelector('#appearance-customize-tab').click()
  await settle()
  page.querySelector('[data-part="overview"]').click()
  await setPreviewTone(theme)
  page.scrollTop = 0
  await settle()
  const scene = page.querySelector('.appearance-window-preview')
  const preview = scene.getBoundingClientRect()
  const picker = page.querySelector('.appearance-workspace-pages').getBoundingClientRect()
  expect(
    page.scrollHeight <= page.clientHeight + 1,
    `appearance page must fit without scrolling at ${innerWidth}x${innerHeight}: ${page.scrollHeight}/${page.clientHeight}`
  )
  expect(
    preview.top >= 0 &&
      preview.bottom <= innerHeight &&
      picker.left >= 0 &&
      picker.right <= innerWidth &&
      picker.bottom <= preview.top + 1,
    'preview or unified theme picker is clipped'
  )
  expect(
    Math.abs(
      Number(scene.dataset.sourceWidth) / Number(scene.dataset.sourceHeight) -
        innerWidth / innerHeight
    ) < 0.02,
    'preview lost real window proportions'
  )
  expect(
    !page.querySelector('.settings-nav-categories, #settings-search-input'),
    'appearance must remain independent at every window size'
  )
  const tools = page.querySelector('.appearance-part-tools')
  const footer = page.querySelector('.appearance-character-footer')
  expect(tools.parentElement === footer, 'appearance objects must share the action row')
  const footerBox = footer.getBoundingClientRect()
  for (const child of [...footer.children].filter(
    (item) => getComputedStyle(item).position !== 'absolute'
  )) {
    const box = child.getBoundingClientRect()
    expect(
      box.top >= footerBox.top - 1 && box.bottom <= footerBox.bottom + 1 && box.height > 0,
      'appearance footer no longer fits one line'
    )
  }
  tools.scrollLeft = tools.scrollWidth
  await settle()
  const lastTool = tools.querySelector('nav:last-child button:last-child')
  const toolBox = tools.getBoundingClientRect(),
    lastBox = lastTool.getBoundingClientRect()
  expect(
    lastBox.right <= toolBox.right + 1 && lastBox.left >= toolBox.left - 1,
    'last appearance tool is unreachable in the narrow action row'
  )
  tools.scrollLeft = 0
  await settle()
  return [...page.querySelectorAll('button, select, input, .appearance-mini-window')]
    .filter((item) => item.getClientRects().length)
    .filter((item) => !item.closest('.settings-nav-categories'))
    .filter((item) => !item.closest('.appearance-part-tools'))
    .filter((item) => {
      const box = item.getBoundingClientRect()
      return box.left < -1 || box.right > innerWidth + 1
    })
    .map((item) => item.outerHTML.slice(0, 180))
}
window.checkUnifiedTypography = async (theme, bodySize) => {
  await window.prepareSettingsEvidence(theme, 'general')
  document.documentElement.style.setProperty('--te-font-size-body', bodySize + 'px')
  await settle()
  const settingsPage = document.querySelector('.settings-preview-page')
  const family = getComputedStyle(settingsPage).fontFamily
  const check = (element, size, role) => {
    expect(
      element && Math.abs(parseFloat(getComputedStyle(element).fontSize) - size) < 0.1,
      role + ' does not use the shared text scale'
    )
    expect(getComputedStyle(element).fontFamily === family, role + ' uses a different font family')
  }
  check(settingsPage.querySelector('.settings-market-heading'), bodySize * 2, 'settings heading')
  check(
    settingsPage.querySelector('.settings-market-search input'),
    (bodySize * 15) / 14,
    'settings search'
  )
  check(settingsPage.querySelector('.setting-copy strong'), (bodySize * 15) / 14, 'setting label')
  navigation.openAppearancePage()
  await settle()
  const appearancePage = document.querySelector('.appearance-page')
  check(appearancePage.querySelector('.appearance-page-title'), bodySize * 2, 'appearance heading')
  check(
    appearancePage.querySelector('#appearance-selection-tab'),
    (bodySize * 15) / 14,
    'appearance page navigation'
  )
  const heading = appearancePage.querySelector('.appearance-page-title').getBoundingClientRect()
  expect(heading.height > 0, 'short windows lost the appearance page title')
  document.documentElement.style.removeProperty('--te-font-size-body')
  return 'UNIFIED_TYPOGRAPHY_OK: ' + theme + '/' + bodySize
}
window.runSettingsInteractionTests = async (theme) => {
  await window.organizationResize(1440, 900)
  await window.prepareSettingsEvidence(theme, 'general')
  const page = document.querySelector('.settings-preview-page')
  const category = page.querySelector('[data-settings-category="general"]')
  category.focus()
  await window.organizationKey('Home')
  await settle()
  expect(category === document.activeElement, 'category keyboard focus moved away')
  expect(category.matches(':focus-visible'), 'selected category lost its keyboard focus')
  expect(getComputedStyle(category).outlineWidth === '2px', 'category focus is not visible')
  await window.organizationResize(760, 692)
  await settle()
  const compactCategory = page.querySelector('.settings-market-category-select')
  expect(document.activeElement === compactCategory, 'narrow navigation hid the focused category')
  expect(compactCategory.value === 'general', 'resizing changed the selected category')
  await window.organizationResize(1440, 900)
  await settle()
  expect(document.activeElement === category, 'wide navigation lost category focus')

  const input = page.querySelector('#settings-search-input')
  const setQuery = async (value) => {
    input.focus()
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  }
  await setQuery('缓存')
  const results = [...page.querySelectorAll('[role="option"]')]
  expect(results.length > 1, 'interaction fixture needs several cache results')
  expect(
    getComputedStyle(results[0].querySelector('.settings-nav-result-title')).fontSize ===
      getComputedStyle(input).fontSize,
    'search results do not share the input text size'
  )
  expect(!input.hasAttribute('aria-activedescendant'), 'typing preselected a keyboard result')
  expect(getComputedStyle(input).outlineStyle === 'none', 'search has two focus frames')
  expect(
    getComputedStyle(input.parentElement).outlineWidth === '2px',
    'search container lost the keyboard focus frame'
  )
  await window.organizationKey('Down')
  await settle()
  expect(
    input.getAttribute('aria-activedescendant') === results[0].id,
    'Down skipped the first result'
  )
  const hovered = results.at(-1).getBoundingClientRect()
  await window.organizationPointer(hovered.left + 12, hovered.top + hovered.height / 2)
  await settle()
  expect(
    input.getAttribute('aria-activedescendant') === results[0].id &&
      results[0].getAttribute('aria-selected') === 'true',
    'pointer hover replaced the keyboard search target'
  )
  await window.organizationKey('Up')
  await settle()
  expect(
    input.getAttribute('aria-activedescendant') === results.at(-1).id,
    'Up did not wrap results'
  )
  await window.organizationKey('Escape')
  await settle()
  expect(document.activeElement === input && !input.value, 'Escape did not retain search focus')
  await setQuery('不存在的设置测试词')
  expect(input.getAttribute('aria-expanded') === 'true', 'empty-result feedback is not announced')
  expect(page.querySelector('#settings-search-results[role="status"]'), 'no-result status missing')
  category.focus()
  await settle()
  expect(
    !page.querySelector('#settings-search-results'),
    'search remained open after focus left it'
  )
  await setQuery('缓存')
  await window.organizationKey('Tab')
  await settle()
  const clear = page.querySelector('.settings-market-search button')
  expect(document.activeElement === clear, 'clear search is not reachable by Tab')
  expect(
    getComputedStyle(input.parentElement).outlineStyle === 'none' &&
      getComputedStyle(clear).outlineWidth === '2px',
    'clear search shows a duplicate or missing focus frame'
  )
  clear.click()
  await settle()
  expect(document.activeElement === input && !input.value, 'clearing search lost its input target')

  const group = page.querySelector('[data-setting-id="startup-home"] .segmented-control')
  const selected = group.querySelector('[aria-pressed="true"]')
  const unselected = group.querySelector('[aria-pressed="false"]')
  expect(selected && unselected, 'startup choices lost their selected state')
  unselected.focus()
  await window.organizationKey('Tab')
  unselected.focus()
  expect(selected.getAttribute('aria-pressed') === 'true', 'moving focus changed the setting')
  expect(unselected.matches(':focus-visible'), 'unselected option has no keyboard focus')
  expect(
    getComputedStyle(selected).backgroundColor !== getComputedStyle(unselected).backgroundColor,
    'selection is visually indistinguishable from keyboard focus'
  )
  expect(
    getComputedStyle(selected, '::after').opacity === '1',
    'selected option has no persistent selection marker'
  )
  expect(getComputedStyle(unselected).outlineWidth === '2px', 'option keyboard outline missing')
  const previouslySelected = settings.value.startupHomePage
  await window.organizationKey('Enter')
  await settle()
  expect(
    unselected.getAttribute('aria-pressed') === 'true' && unselected.matches(':focus-visible'),
    'activating a focused option did not retain combined selected and focused states'
  )
  await updateSettings({ startupHomePage: previouslySelected })

  const launchSwitch = page.querySelector('[data-setting-id="launch-at-login"] button')
  const wasEnabled = settings.value.launchAtLogin
  settings.value.launchAtLogin = true
  await settle()
  launchSwitch.focus()
  expect(launchSwitch.getAttribute('aria-checked') === 'true', 'enabled switch state missing')
  expect(launchSwitch.matches(':focus-visible'), 'enabled switch lost keyboard focus')
  expect(
    getComputedStyle(launchSwitch).boxShadow === 'none',
    'enabled switch resembles a focus halo'
  )
  expect(
    getComputedStyle(launchSwitch).outlineWidth === '2px',
    'enabled switch focus frame missing'
  )
  const previousMotion = document.documentElement.dataset.teMotion
  document.documentElement.dataset.teMotion = 'full'
  const switchBounds = launchSwitch.getBoundingClientRect()
  await window.organizationPointer(
    switchBounds.left + switchBounds.width / 2,
    switchBounds.top + switchBounds.height / 2
  )
  await settle()
  expect(getComputedStyle(launchSwitch).scale === '1', 'hover enlarged the switch input target')
  expect(
    Math.abs(launchSwitch.getBoundingClientRect().width - switchBounds.width) < 1,
    'switch focus and pointer geometry diverged'
  )
  document.documentElement.dataset.teMotion = previousMotion
  settings.value.launchAtLogin = wasEnabled

  navigation.openSettingsPage('lyrics')
  await settle()
  const range = page.querySelector('#lyrics .range-pill > input[type="range"]')
  expect(range, 'real lyrics range missing')
  range.focus()
  expect(
    getComputedStyle(range).outlineStyle === 'none' &&
      getComputedStyle(range.parentElement).outlineWidth === '2px',
    'lyrics range has a duplicate or missing focus frame'
  )
  await window.organizationResize(760, 692)
  await window.prepareSettingsEvidence(theme, 'system')
  const backup = page.querySelector('.personal-backup')
  const setting = page.querySelector('[data-setting-id="settings-backup"] .setting-copy')
  expect(backup && setting, 'real backup settings missing')
  expect(
    Math.abs(backup.getBoundingClientRect().left - setting.getBoundingClientRect().left) < 1,
    'personal backup does not share the setting label boundary'
  )
  const resetActions = page.querySelector('.reset-group-actions')
  expect(
    Math.abs(
      resetActions.firstElementChild.getBoundingClientRect().left -
        resetActions.getBoundingClientRect().left
    ) < 1,
    'narrow reset actions lost the shared left boundary'
  )
  await window.organizationResize(1440, 900)
  await window.prepareSettingsEvidence(theme, 'general')
  group.querySelector('[aria-pressed="true"]').focus()
  return 'SETTINGS_INTERACTION_OK: ' + theme
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
  document.querySelector('.settings-preview-page').scrollTop = 0
}
