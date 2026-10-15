import { createApp, h, ref, nextTick } from 'vue'
import AppearancePage from '__RENDERER__/components/AppearancePage.vue'
import PageDock from '__RENDERER__/components/PageDock.vue'
import { providePageDock } from '__RENDERER__/app/pageDock.ts'
import { storeThemeStudioRecovery } from '__RENDERER__/components/theme-studio/themeStudioRecovery.ts'
import { SETTINGS_SEARCH_INDEX } from '__RENDERER__/components/settings-page/types.ts'
import { useThemeStore, resetThemeFixture } from '__RENDERER__/stores/useThemeStore'
import {
  BUILT_IN_THEME_PRESET_IDS,
  TWILIGHT_DEFAULT_THEME
} from '__RENDERER__/../../shared/theme.ts'
import '__RENDERER__/assets/main.css'

const DockHost = {
  props: ['pageProps'],
  setup(props) {
    const dock = providePageDock('appearance')
    return () =>
      h('div', { style: 'height:100%' }, [
        h(PageDock, {
          actions: dock.actions.value,
          style: 'position:fixed;top:0;right:0;z-index:30'
        }),
        h(AppearancePage, props.pageProps)
      ])
  }
}
const renderAppearance = (props) => h(DockHost, { pageProps: props })
const target = ref({ revision: 0 }),
  active = ref(true),
  store = useThemeStore()
let workspace,
  app,
  closed = 0,
  selected = 'adjust',
  responsiveCleanup
Object.assign(window, {
  allowLeave: {},
  leaveCalls: [],
  actions: [],
  dailyContexts: [],
  editorRefs: {},
  themeCreates: [],
  themeMutations: [],
  realSaves: [],
  saveAttempts: 0,
  deleteAttempts: 0,
  previewCalls: [],
  fixturePreviewCounter: 0,
  pluginCalls: []
})
let pluginChanged = () => {}
let installed = [
  { id: 'plugin.one', name: 'Installed theme', type: ['theme'], enabled: true, builtIn: false }
]
const catalog = [
  {
    id: 'remote.theme',
    name: 'Cloud skin',
    author: 'Theme author',
    version: '1.0.0',
    type: ['theme'],
    description: 'A theme from the shared catalog',
    installState: 'not-installed'
  },
  {
    id: 'remote.provider',
    name: 'Forbidden provider',
    type: ['provider'],
    installState: 'not-installed'
  },
  { id: 'remote.dsp', name: 'Forbidden DSP', type: ['dsp'], installState: 'not-installed' }
]
window.api = {
  themeWorkshop: {
    list: async () => {
      if (window.failProjectList) throw Error('project list failed')
      return [{ id: 'project-one', name: 'Project one' }]
    }
  },
  plugins: {
    list: async () => installed,
    listIndex: async () => {
      window.pluginCalls.push('list')
      if (window.failIndex) throw Error('offline')
      return catalog
    },
    refreshIndex: async () => {
      window.pluginCalls.push('refresh')
      if (window.failIndex) throw Error('offline')
      return catalog
    },
    getIndexStatus: async () => ({ loadedFrom: window.failIndex ? 'cache' : 'remote' }),
    onChanged: (fn) => {
      pluginChanged = fn
      return () => {
        pluginChanged = () => {}
      }
    },
    installFromIndex: async (id) => {
      window.pluginCalls.push('install:' + id)
      if (window.holdPlugin)
        await new Promise((resolve) => {
          window.releasePlugin = resolve
        })
      return {}
    },
    enable: async (id) => {
      window.pluginCalls.push('enable:' + id)
    },
    uninstall: async (id) => {
      window.pluginCalls.push('remove:' + id)
      installed = installed.filter((plugin) => plugin.id !== id)
    }
  }
}
const settle = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 35))
  await nextTick()
}
const until = async (predicate, message) => {
  const deadline = Date.now() + 3500
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(message)
    await settle()
  }
}
const expect = (value, message) => {
  if (!value) throw Error(message)
}
const command = (label, host = document) =>
  [...host.querySelectorAll('.appearance-page button')].find(
    (button) => button.textContent.trim() === label
  )
const source = () => {
  if (selected !== 'adjust')
    return window.editorRefs[selected === 'studio' ? 'ThemeStudioPage' : 'ThemeWorkshopPage'].key
      .value
  const value = store.activeTheme.value
  return value.kind === 'builtin'
    ? 'preset:' + value.id
    : value.kind === 'user'
      ? 'profile:' + value.id
      : 'plugin:' + value.pluginId + ':' + value.themeId
}
const isSelection = () => !!document.querySelector('#appearance-theme-selection')
const choiceReady = () =>
  isSelection() &&
  !document.querySelector('#appearance-selection-tab').disabled &&
  !!document.querySelector('[data-theme-plugin-id="remote.theme"]')
const creatorReady = () =>
  !!document.querySelector('.fixture-ThemeStudioPage') &&
  !document.querySelector('#appearance-customize-tab').disabled
const choosePage = async () => {
  document.querySelector('#appearance-selection-tab').click()
  await settle()
}
const customizePage = async () => {
  document.querySelector('#appearance-customize-tab').click()
  await until(
    () => document.querySelector('.fixture-AppearanceSettingsSection'),
    'customization did not mount'
  )
}
const pick = async (key) => {
  const button = document.querySelector('[data-theme-key="' + key + '"]')
  expect(button, 'missing theme ' + key)
  button.click()
  await settle()
}
const openOptions = async () => {
  const menu = document.querySelector('.appearance-theme-tools')
  expect(menu, 'missing theme options')
  if (!menu.open) menu.querySelector('summary').click()
  await settle()
  return menu
}
const category = async (key) => {
  await openOptions()
  const control = document.querySelector('[aria-label="主题制作分类"]')
  control.value = key
  control.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}
const neutral = (value) => {
  const channels = value
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number)
  return channels?.length === 3 && Math.max(...channels) - Math.min(...channels) <= 12
}
const channels = (value) =>
  value.startsWith('color(')
    ? value
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map((value) => Number(value) * 255)
    : value
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
const contrast = (a, b) => {
  const lum = (value) =>
    channels(value)
      .map((value) => {
        value /= 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  return (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
}
const editorOptionContrast = () => {
  const page = document.querySelector('.appearance-page')
  expect(page.dataset.appearanceWorkspace === 'customize', 'editor workspace not identified')
  const backgroundOf = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
    }
    return getComputedStyle(document.body).backgroundColor
  }
  const controls = [
    ...page.querySelectorAll(
      '.appearance-page-topline button, .appearance-page-topline summary, .appearance-creation-actions button, .appearance-category-tools select'
    )
  ].filter((element) => !element.disabled && element.getClientRects().length)
  expect(controls.length >= 2, 'editor has no readable enabled options')
  const text = controls.map((element) => {
    const value = contrast(getComputedStyle(element).color, backgroundOf(element))
    expect(value >= 4.5, 'enabled option looks disabled: ' + element.textContent.trim())
    return value
  })
  const boundaries = [...page.querySelectorAll('select')]
    .filter((element) => !element.disabled && element.getClientRects().length)
    .map((element) => {
      const style = getComputedStyle(element)
      const value = Math.min(
        contrast(style.borderTopColor, backgroundOf(element)),
        contrast(style.borderTopColor, backgroundOf(element.parentElement))
      )
      expect(parseFloat(style.borderTopWidth) > 0 && value >= 3, 'option boundary is too faint')
      return value
    })
  return {
    controls: controls.length,
    minimumTextContrast: Math.min(...text),
    minimumBoundaryContrast: boundaries.length ? Math.min(...boundaries) : null
  }
}
const mount = (props = {}) => {
  const live = props.navigationTarget === target.value
  selected = 'adjust'
  app = createApp({
    setup: () => () =>
      renderAppearance({
        ...props,
        ...(live ? { navigationTarget: target.value, active: active.value } : {}),
        ref: (value) => {
          workspace = value
        },
        onTabChange: (value) => {
          selected = value
        }
      })
  })
  app.mount('#app')
}
mount({ navigationTarget: target.value, active: active.value, onBack: () => closed++ })

window.checkEditorContrast = async (tone) => {
  document.documentElement.dataset.theme = tone
  if (isSelection()) await customizePage()
  await settle()
  const page = document.querySelector('.appearance-page'),
    button = document.querySelector('[data-dock-action="preview-tone"]'),
    style = getComputedStyle(page),
    actual = getComputedStyle(document.body).backgroundColor,
    background = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? actual : style.backgroundColor
  expect(
    neutral(style.color) && contrast(style.color, background) >= 4.5,
    'editor text loses contrast'
  )
  const difference = Math.max(
    ...channels(background).map((value, index) => Math.abs(value - channels(actual)[index]))
  )
  expect(
    difference < 1,
    'editor background has not returned to the app background: ' +
      tone +
      ' ' +
      style.backgroundColor +
      ' ' +
      actual
  )
  expect(
    getComputedStyle(document.documentElement).getPropertyValue('--appearance-edit-text').trim() ===
      '',
    'editor colors leak into root'
  )
  const rect = button.getBoundingClientRect()
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    background,
    actual,
    options: editorOptionContrast()
  }
}
window.checkEditorHover = async () => {
  const button = document.querySelector('[data-dock-action="preview-tone"]:hover')
  expect(
    button &&
      contrast(getComputedStyle(button).color, getComputedStyle(document.body).backgroundColor) >=
        4.5,
    'hover contrast lost'
  )
}

window.fixture = async () => {
  await choosePage()
  await until(choiceReady, 'choice page not ready')
  expect(
    !document.querySelector('.fixture-AppearanceSettingsSection') &&
      !document.querySelector('.fixture-ThemeStudioPage') &&
      !document.querySelector('.appearance-theme-tools'),
    'selection eagerly mounts editor controls'
  )
  expect(
    !document.body.textContent.includes('Forbidden provider') &&
      !document.body.textContent.includes('Forbidden DSP') &&
      window.pluginCalls.includes('list') &&
      !window.pluginCalls.some((call) => call.startsWith('install:')),
    'theme catalog leaks other categories or installs automatically'
  )
  const search = document.querySelector('[aria-label="搜索主题"]')
  search.value = 'Personal'
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(
    document.querySelector('[data-theme-key="profile:personal"]') &&
      !document.querySelector('[data-theme-key^="preset:"]'),
    'theme search does not filter'
  )
  search.value = ''
  search.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  window.failActivation = true
  await pick('profile:personal')
  expect(
    source() === 'preset:builtin:twilight-echo-default' &&
      document.querySelector('[role="alert"]').textContent.includes('theme activation failed'),
    'failed selection changes confirmed theme'
  )
  window.failActivation = false
  await pick('profile:personal')
  expect(
    source() === 'profile:personal' && isSelection(),
    'personal selection unexpectedly opens editor'
  )
  window.holdPlugin = true
  document.querySelector('[data-theme-plugin-id="remote.theme"] button').click()
  await until(() => window.releasePlugin, 'install did not run')
  expect(
    document.querySelector('#appearance-customize-tab').disabled &&
      command('新建主题').disabled &&
      document.querySelector('[data-dock-action="new-theme"]').disabled,
    'plugin mutation races page/creation'
  )
  window.holdPlugin = false
  window.releasePlugin()
  await until(choiceReady, 'install does not unlock')
  window.failIndex = true
  document.querySelector('[data-dock-action="sync-themes"]').click()
  await settle()
  expect(
    document.querySelector('[data-theme-plugin-id="remote.theme"]') &&
      document.querySelector('[role="alert"]').textContent.includes('offline'),
    'offline sync loses available catalog'
  )
  window.failIndex = false
  window.dispatchEvent(new Event('online'))
  await settle()
  expect(window.pluginCalls.includes('refresh'), 'online catalog does not revalidate')
  await pick('plugin:plugin.one:theme')
  const confirm = window.confirm
  window.confirm = () => true
  document.querySelector('[aria-label="删除主题插件 Installed theme"]').click()
  await until(
    () =>
      source().startsWith('preset:') &&
      !document.querySelector('[data-theme-key="plugin:plugin.one:theme"]'),
    'removed active plugin does not recover'
  )
  window.confirm = confirm
  installed = [
    { id: 'plugin.one', name: 'Installed theme', type: ['theme'], enabled: true, builtIn: false }
  ]
  pluginChanged()
  await new Promise((resolve) => setTimeout(resolve, 140))
  await customizePage()
  expect(
    !document.querySelector('[data-theme-key]') && !command('新建主题') && !command('删除主题'),
    'selection commands remain in custom pane'
  )
  window.allowLeave.AppearanceSettingsSection = false
  await choosePage()
  expect(!isSelection() && selected === 'adjust', 'page switch dismisses daily draft')
  window.allowLeave.AppearanceSettingsSection = true
  document.querySelector('[data-daily-more]').click()
  await until(creatorReady, 'contextual creator did not mount')
  editorOptionContrast()
  expect(
    document.querySelector('.fixture-domain').textContent === 'player' &&
      document.querySelector('.fixture-AppearanceWindowPreview').dataset.selected === 'player-bar',
    'contextual creator lost selected control'
  )
  const card = document.querySelector('[data-preview-part="card"]')
  card.focus()
  card.click()
  await settle()
  expect(
    document.querySelector('[data-context-field]').textContent === 'card' &&
      document.activeElement === card,
    'context select loses property or focus'
  )
  expect(
    ['inner-panel', 'outer-panel', 'controls'].every((part) =>
      document.querySelector('[data-creator-part="' + part + '"]')
    ),
    'inner/outer/all-controls missing'
  )
  expect(
    !document.querySelector('[data-creator-part="background"]') &&
      document.querySelector('[data-creator-part="inner-panel"]').textContent.trim() ===
        '内框背景' &&
      document.querySelector('[data-creator-part="outer-panel"]').textContent.trim() === '外框',
    'background still competes with the merged inner-background target'
  )
  window.fixtureLegacyBackground()
  await settle()
  expect(
    document.querySelector('[data-context-field]').textContent === 'inner-panel' &&
      document.querySelector('.fixture-domain').textContent === 'shell' &&
      document.querySelector('.fixture-AppearanceWindowPreview').dataset.selected ===
        'inner-panel' &&
      document.querySelector('[data-creator-part="inner-panel"]').getAttribute('aria-pressed') ===
        'true',
    'legacy background navigation does not synchronize the merged editor and preview'
  )
  card.click()
  await settle()
  const leaves = window.leaveCalls.length
  await category('font')
  expect(
    window.leaveCalls.length === leaves &&
      document.querySelector('.fixture-domain').textContent === 'typography',
    'category change discards theme'
  )
  document.querySelector('.appearance-theme-tools summary').click()
  await settle()
  window.editorRefs.ThemeStudioPage.dirty.value = true
  window.failCreationSave = true
  command('应用主题').click()
  await settle()
  expect(
    document.querySelector('[role="alert"]').textContent.includes('theme save failed') &&
      window.editorRefs.ThemeStudioPage.dirty.value,
    'failed creator save loses draft'
  )
  window.failCreationSave = false
  command('应用主题').click()
  await settle()
  expect(!window.editorRefs.ThemeStudioPage.dirty.value, 'creator save cannot retry')
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
  )
  await settle()
  expect(window.actions.at(-1).action === 'undo', 'theme undo lost')
  const input = document.createElement('input')
  document.body.append(input)
  const count = window.actions.length
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
  await settle()
  expect(window.actions.length === count, 'theme steals input undo')
  input.remove()
  window.allowLeave.ThemeStudioPage = false
  await choosePage()
  expect(selected === 'studio' && !isSelection(), 'choice bypasses theme draft')
  await workspace.requestClose()
  expect(selected === 'studio', 'back bypasses theme draft')
  window.allowLeave.ThemeStudioPage = true
  await choosePage()
  await until(choiceReady, 'choice cannot return')
  document.querySelector('.theme-selection-projects summary').click()
  await pick('workshop:project-one')
  await until(() => document.querySelector('.fixture-ThemeWorkshopPage'), 'project did not mount')
  await category('layers')
  expect(
    document.querySelector('.fixture-domain').textContent === '图层与蒙版',
    'workshop layers lost'
  )
  window.allowLeave.ThemeWorkshopPage = false
  await choosePage()
  expect(selected === 'workshop', 'choice loses project draft')
  window.allowLeave.ThemeWorkshopPage = true
  await choosePage()
  await until(choiceReady, 'choice return failed')
  target.value = {
    revision: 1,
    appearanceTab: 'adjust',
    entry: { id: 'plugin-theme', section: 'appearance' }
  }
  await settle()
  expect(
    isSelection() && document.activeElement === document.querySelector('[aria-label="搜索主题"]'),
    'theme search does not focus choice'
  )
  target.value = {
    revision: 2,
    appearanceTab: 'adjust',
    entry: SETTINGS_SEARCH_INDEX.find((entry) => entry.id === 'player-page-mode')
  }
  await settle()
  const searchTarget = document.querySelector('.search-target-flash')
  expect(
    !isSelection() &&
      searchTarget?.dataset.settingId === 'player-page-mode' &&
      document.activeElement === searchTarget.querySelector('select') &&
      !searchTarget.closest('[inert]'),
    'nested settings search is hidden'
  )
  await choosePage()
  await workspace.requestClose()
  expect(closed === 1, 'choice back cannot exit')
  app.unmount()
  storeThemeStudioRecovery(null)
  const recovered = store.createProfile('Recovered draft', TWILIGHT_DEFAULT_THEME)
  storeThemeStudioRecovery({
    draft: recovered,
    selectedKey: 'profile:' + recovered.id,
    tone: 'dark',
    dirty: true
  })
  mount()
  await until(creatorReady, 'recoverable draft did not open custom pane')
  expect(source() === 'profile:' + recovered.id, 'recovery selection lost')
  app.unmount()
  storeThemeStudioRecovery(null)
}

window.managementFixture = async () => {
  resetThemeFixture()
  window.allowLeave = {}
  window.themeCreates = []
  window.themeMutations = []
  window.realSaves = []
  window.saveAttempts = 0
  window.deleteAttempts = 0
  const confirm = window.confirm
  let allowed = true,
    confirmCalls = 0
  window.confirm = () => {
    confirmCalls++
    return allowed
  }
  const newButton = () => command('新建主题'),
    deleteButton = () => command('删除主题'),
    defaultKey = 'preset:builtin:twilight-echo-default'
  const selection = async () => {
    await choosePage()
    await until(choiceReady, 'management choice did not mount')
  }
  const nextName = () => {
    let name = '新主题',
      index = 2
    while (store.profiles.value.some((profile) => profile.name === name)) name = '新主题 ' + index++
    return name
  }
  const create = async () => {
    const name = nextName()
    newButton().click()
    await until(creatorReady, 'new theme did not reach editor')
    const profile = store.profiles.value.find((value) => value.name === name)
    expect(
      profile && source() === 'profile:' + profile.id && store.activeTheme.value.id === profile.id,
      'new theme not persisted/active'
    )
    await selection()
    return profile
  }
  try {
    window.failProjectList = true
    mount()
    await until(choiceReady, 'catalog blocked by workshop metadata failure')
    expect(!newButton().disabled, 'workshop metadata failure blocks theme creation')
    window.failProjectList = false
    for (const id of BUILT_IN_THEME_PRESET_IDS) {
      await pick('preset:' + id)
      expect(deleteButton().disabled, 'builtin can be deleted')
    }
    await pick('profile:personal')
    allowed = false
    const before = window.deleteAttempts
    deleteButton().click()
    await settle()
    expect(
      window.deleteAttempts === before && source() === 'profile:personal',
      'cancel delete mutates theme'
    )
    allowed = true
    const first = await create(),
      second = await create()
    expect(first.name === '新主题' && second.name === '新主题 2', 'new names collide')
    window.failProfileSave = true
    const size = store.profiles.value.length
    newButton().click()
    await settle()
    expect(
      isSelection() &&
        store.profiles.value.length === size &&
        source() === 'profile:' + second.id &&
        document.querySelector('[role="alert"]').textContent.includes('profile save failed'),
      'failed save changes confirmed choice'
    )
    window.failProfileSave = false
    window.failPersistedSaveRuntime = true
    const persistedName = nextName()
    newButton().click()
    await settle()
    const persisted = store.profiles.value.find((profile) => profile.name === persistedName)
    expect(
      persisted &&
        isSelection() &&
        document.querySelector('[role="alert"]').textContent.includes('已保存') &&
        store.activeTheme.value.id === second.id,
      'saved runtime failure loses persisted theme'
    )
    window.failPersistedSaveRuntime = false
    const attempts = window.saveAttempts
    await pick('profile:' + persisted.id)
    expect(window.saveAttempts === attempts, 'save retry creates another profile')
    window.failActivation = true
    const failedName = nextName()
    newButton().click()
    await settle()
    const failed = store.profiles.value.find((profile) => profile.name === failedName)
    expect(
      failed &&
        isSelection() &&
        store.activeTheme.value.id === persisted.id &&
        document.querySelector('[role="alert"]').textContent.includes('theme activation failed'),
      'activation failure loses saved file'
    )
    window.failActivation = false
    await pick('profile:' + failed.id)
    window.holdSave = true
    const heldName = nextName(),
      creates = window.themeCreates.length,
      deletes = window.deleteAttempts
    newButton().click()
    await until(() => window.releaseSave, 'save not held')
    expect(
      newButton().disabled &&
        deleteButton().disabled &&
        document.querySelector('#appearance-customize-tab').disabled,
      'held save leaves actions enabled'
    )
    for (let index = 0; index < 10; index++) {
      newButton().click()
      deleteButton().click()
    }
    await settle()
    expect(
      window.themeCreates.length === creates + 1 && window.deleteAttempts === deletes,
      'busy repeats writes'
    )
    window.holdSave = false
    window.releaseSave()
    await until(creatorReady, 'held save not released')
    const held = store.profiles.value.find((profile) => profile.name === heldName)
    window.editorRefs.ThemeStudioPage.dirty.value = true
    window.allowLeave.ThemeStudioPage = false
    await choosePage()
    expect(!isSelection() && source() === 'profile:' + held.id, 'management page bypasses draft')
    window.allowLeave.ThemeStudioPage = true
    await selection()
    window.failDelete = true
    deleteButton().click()
    await settle()
    expect(
      store.profiles.value.some((profile) => profile.id === held.id) &&
        document.querySelector('[role="alert"]').textContent.includes('profile delete failed'),
      'delete failure loses choice'
    )
    window.failDelete = false
    window.holdDelete = true
    deleteButton().click()
    await until(() => window.releaseDelete, 'delete retry not held')
    const during = window.deleteAttempts,
      confirms = confirmCalls
    expect(newButton().disabled && deleteButton().disabled, 'held delete does not lock')
    for (let index = 0; index < 10; index++) deleteButton().click()
    await settle()
    expect(window.deleteAttempts === during && confirmCalls === confirms, 'held delete repeats')
    window.holdDelete = false
    window.releaseDelete()
    await until(
      () => source() === defaultKey && !newButton().disabled,
      'active deletion does not fall back'
    )
    expect(
      deleteButton().disabled && !store.profiles.value.some((profile) => profile.id === held.id),
      'delete incomplete'
    )
    await pick('profile:' + first.id)
    window.failDeletedRuntime = true
    deleteButton().click()
    await settle()
    expect(
      !store.profiles.value.some((profile) => profile.id === first.id) &&
        source() === defaultKey &&
        document.querySelector('[role="alert"]').textContent.includes('已删除'),
      'persisted delete failure reported as present'
    )
  } finally {
    window.releaseSave?.()
    window.releaseDelete?.()
    window.holdSave = false
    window.holdDelete = false
    window.failProfileSave = false
    window.failPersistedSaveRuntime = false
    window.failActivation = false
    window.failDelete = false
    window.failDeletedRuntime = false
    window.failProjectList = false
    window.allowLeave = {}
    window.confirm = confirm
    app?.unmount()
    storeThemeStudioRecovery(null)
  }
}

window.checkResponsiveCreation = async (mode, layered, tone) => {
  responsiveCleanup?.()
  resetThemeFixture()
  window.allowLeave = {}
  storeThemeStudioRecovery(null)
  document.documentElement.dataset.theme = tone
  mount({
    navigationTarget: {
      revision: 0,
      appearanceTab: mode === 'selection' ? 'adjust' : mode,
      ...(mode === 'adjust' ? { entry: { id: 'global-font', section: 'appearance' } } : {})
    }
  })
  responsiveCleanup = () => {
    app.unmount()
    responsiveCleanup = undefined
  }
  const child =
    mode === 'selection'
      ? '#appearance-theme-selection'
      : '.fixture-' +
        (mode === 'studio'
          ? 'ThemeStudioPage'
          : mode === 'workshop'
            ? 'ThemeWorkshopPage'
            : 'AppearanceSettingsSection')
  await until(
    () =>
      document.querySelector(child) &&
      !document.querySelector('#appearance-customize-tab').disabled,
    'responsive ' + mode + ' not ready'
  )
  await document.fonts.ready
  await settle()
  const page = document.querySelector('.appearance-page'),
    topline = page.querySelector('.appearance-page-topline')
  const rect = (element) => {
    const value = element.getBoundingClientRect()
    return {
      left: value.left,
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      width: value.width,
      height: value.height
    }
  }
  const verify = () => {
    expect(
      page.scrollWidth <= page.clientWidth + 1 &&
        topline.scrollWidth <= topline.clientWidth + 1 &&
        Math.abs(rect(page).bottom - innerHeight) <= 1,
      'responsive pane escapes window: ' +
        JSON.stringify({
          mode,
          tone,
          width: innerWidth,
          scroll: page.scrollWidth,
          client: page.clientWidth,
          bounds: rect(page)
        })
    )
    for (const id of ['appearance-selection-tab', 'appearance-customize-tab']) {
      const button = document.getElementById(id),
        bounds = rect(button)
      expect(
        bounds.left >= 0 &&
          bounds.right <= innerWidth &&
          bounds.top >= 0 &&
          bounds.bottom <= innerHeight,
        'page nav hidden'
      )
    }
  }
  if (mode === 'selection') {
    expect(
      !document.querySelector('.fixture-AppearanceWindowPreview') &&
        !document.querySelector('[data-dock-action="preview-tone"]') &&
        document.querySelector('[data-dock-action="sync-themes"]'),
      'choice retains preview tools'
    )
    verify()
    return {
      mode,
      layered: false,
      tone,
      width: innerWidth,
      height: innerHeight,
      topline: rect(topline),
      background: getComputedStyle(page).backgroundColor
    }
  }
  const preview = document.querySelector('.fixture-AppearanceWindowPreview'),
    previewId = Number(preview.dataset.previewId),
    beforeCalls = window.previewCalls.length
  document.querySelector('[data-preview-part="navigation"]').click()
  await settle()
  const toggle = document.querySelector('[data-dock-action="preview-3d"]')
  expect(
    toggle.textContent.trim() === '3D 预览' && toggle.getAttribute('aria-pressed') === 'false',
    '2D preview has the wrong view action'
  )
  toggle.click()
  await settle()
  expect(
    preview.dataset.layeredView === 'true' &&
      toggle.textContent.trim() === '2D 预览' &&
      toggle.getAttribute('aria-pressed') === 'true',
    'top toolbar does not offer a return to 2D'
  )
  toggle.click()
  await settle()
  expect(
    preview.dataset.layeredView === 'false' &&
      toggle.textContent.trim() === '3D 预览' &&
      toggle.getAttribute('aria-pressed') === 'false' &&
      JSON.stringify(
        window.previewCalls
          .slice(beforeCalls)
          .filter((call) => call.action === 'layered')
          .map((call) => call.value)
      ) === '[true,false]' &&
      !window.previewCalls.slice(beforeCalls).some((call) => call.action === 'camera-focus'),
    'top toolbar does not switch the current preview back to 2D'
  )
  toggle.click()
  await settle()
  const cameraMenu = await openOptions(),
    cameraButton = [...cameraMenu.querySelectorAll('.appearance-compact-view-tools button')].find(
      (button) => button.textContent.trim() === '相机缩放'
    )
  expect(cameraButton && !cameraButton.disabled, 'missing independent camera zoom action')
  cameraButton.click()
  await settle()
  expect(
    preview.dataset.layeredView === 'true' &&
      document.activeElement === preview.querySelector('[aria-label="相机缩放"]'),
    'independent camera action does not focus the current 3D preview'
  )
  toggle.click()
  await settle()
  if (layered) {
    toggle.click()
    await settle()
  }
  const menu = await openOptions(),
    viewScope = menu.querySelector('.appearance-compact-view-tools'),
    viewButton = (label) =>
      [...viewScope.querySelectorAll('button')].find(
        (button) => button.textContent.trim() === label
      )
  for (const label of ['缩小预览', '放大预览', '适合部件', '收起侧边栏', '展开侧边栏']) {
    const button = viewButton(label)
    expect(button && !button.disabled, 'missing preview operation ' + label)
    button.click()
    await settle()
  }
  if (layered) {
    const range = viewScope.querySelector('[aria-label="3D 层间距"]')
    range.value = '38'
    range.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(preview.dataset.layerSpacing === '38', 'layer spacing wrong preview')
  }
  viewButton('返回整窗').click()
  await settle()
  menu.querySelector('summary').click()
  await settle()
  document.querySelector('[data-preview-part="navigation"]').click()
  await settle()
  const calls = window.previewCalls.slice(beforeCalls)
  expect(
    calls.every((call) => call.id === previewId) &&
      ['zoom-in', 'zoom-out', 'fit', 'navigation', 'layered', 'camera-focus'].every((action) =>
        calls.some((call) => call.action === action)
      ),
    'preview dispatch points to stale scene'
  )
  if (mode !== 'adjust') {
    const context = document.querySelector('.appearance-context-tools'),
      canvas = document.querySelector('.appearance-creation-canvas')
    expect(
      canvas.contains(context) &&
        rect(context).width <= 400 &&
        rect(context).right <= rect(canvas).right + 1 &&
        context.querySelector('[data-context-field]').textContent === 'navigation',
      'context tools escape preview'
    )
  }
  verify()
  return {
    mode,
    layered,
    tone,
    width: innerWidth,
    height: innerHeight,
    topline: rect(topline),
    background: getComputedStyle(page).backgroundColor,
    calls,
    options: editorOptionContrast()
  }
}
window.finishResponsive = () => responsiveCleanup?.()
