import { createApp, h, nextTick, ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import { useAppNavigation } from '../app/useAppNavigation'
import { createNavigationSessionPersistence } from '../app/useNavigationSessionPersistence'
import { NAVIGATION_SESSION_KEY } from '../app/navigationSession'
import { mountWorkshopDecorations } from './theme-workshop/workshopDecorations.ts'
import '../assets/base.css'

const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const settle = async () => {
  await nextTick()
  for (let frame = 0; frame < 3; frame++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
  await new Promise((resolve) => setTimeout(resolve, 100))
}
const noop = async () => []
let resolveLoad
const loading = new Promise((resolve) => {
  resolveLoad = resolve
})
window.settingsScrollMocks = {
  useSettingsStore: new Proxy(
    {
      settings: ref({ cachePolicy: {}, desktopLyrics: {} }),
      paths: ref(null),
      appVersion: ref('1.0.0'),
      restartRequired: ref(false),
      restartReasons: ref([]),
      lastSettingsError: ref(null),
      loadSettings: () => loading,
      formattedCacheSize: ref('0 B'),
      formattedBpmAnalysisCacheSize: ref('0 B'),
      formattedLoudnessAnalysisCacheSize: ref('0 B')
    },
    { get: (target, key) => (key in target ? target[key] : noop) }
  ),
  useMusicStore: new Proxy(
    {
      libraryScanStatus: ref({ state: 'idle' }),
      libraryScanProgress: ref(null),
      libraryMetadataEnrichmentStatus: ref({ state: 'idle' })
    },
    { get: (target, key) => (key in target ? target[key] : noop) }
  ),
  useThemeStore: { load: noop },
  useAudioOutputDspStore: { refreshAudioOutputState: noop },
  registry: { uiContributions: ref([]), syncExtensions: noop }
}
window.api = { library: { getWatcherStatus: async () => null } }
const expanded = ref(false)
window.makeSettingsSection = (key) => () =>
  h(
    ['general', 'appearance', 'library', 'connections', 'system', 'about'].includes(key)
      ? 'section'
      : 'div',
    {
      id: key,
      class: ['general', 'appearance', 'library', 'connections', 'system', 'about'].includes(key)
        ? 'glass-card preview-section settings-section'
        : 'settings-fixture-block'
    },
    [
      h('h2', key),
      ...(key === 'about'
        ? [
            h('button', { 'data-setting-id': 'app-update' }, '检查更新'),
            h('button', { 'data-setting-id': 'app-update-install' }, '下载更新'),
            h('strong', { 'data-setting-id': 'app-version' }, 'Version 1.0.0')
          ]
        : []),
      h(
        'button',
        {
          class: 'test-disclosure',
          onClick: () => {
            expanded.value = !expanded.value
          }
        },
        '展开'
      ),
      key === 'general' && expanded.value
        ? h('div', { style: { height: '370px' } }, '更多设置')
        : null,
      h(
        'div',
        { class: 'setting-list' },
        Array.from({ length: key === 'appearance' ? 2 : 45 }, (_, index) =>
          h(
            'div',
            {
              class: 'setting-item',
              ...(key === 'system' && index === 20
                ? { 'data-setting-id': 'hardware-acceleration' }
                : key === 'playback-basics' && index === 20
                  ? { 'data-setting-id': 'gapless' }
                  : {}),
              style: { minHeight: '60px' }
            },
            [
              h('div', { class: 'setting-copy' }, [
                h(
                  'strong',
                  key === 'system' && index === 20
                    ? '硬件加速'
                    : key === 'playback-basics' && index === 20
                      ? '无缝播放 (Gapless Playback)'
                      : `${key} 设置 ${index}`
                ),
                h(
                  'span',
                  '这是一段测试设置说明，用来验证调整窗口宽度和字体之后，设置卡片仍能按正确的位置滚动和定位。'.repeat(
                    2
                  )
                )
              ]),
              h('input', { defaultValue: '保留的设置值', 'aria-label': `${key}-${index}` })
            ]
          )
        )
      )
    ]
  )

window.runSettingsScrollTests = async () => {
  localStorage.removeItem(NAVIGATION_SESSION_KEY)
  let appNavigation = useAppNavigation()
  let persistence = createNavigationSessionPersistence(appNavigation)
  persistence.start()
  appNavigation.openSettingsPage()
  const removeDecorations = mountWorkshopDecorations(document)
  const mounted = ref(true)
  const app = createApp({
    render: () =>
      mounted.value
        ? h(SettingsPage, {
            initialSection: appNavigation.settingsInitialSection.value,
            navigationTarget: appNavigation.settingsNavigationTarget.value,
            onSectionChange: appNavigation.rememberSettingsSection
          })
        : null
  })
  app.mount('#app')
  await settle()
  const page = document.querySelector('.settings-preview-page')
  const sections = [...page.querySelectorAll('.preview-section')]
  const nav = (key) => page.querySelector(`[data-settings-category="${key}"]`)
  const visibleSections = () => sections.filter((section) => section.getClientRects().length)
  const select = async (key) => {
    const selector = page.querySelector('.settings-market-category-select')
    if (selector.getClientRects().length) {
      selector.value = key
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    } else nav(key).click()
    await settle()
    expect(
      visibleSections().length === 1 && visibleSections()[0].id === key,
      'category did not select exactly one mounted panel: ' + key
    )
    expect(nav(key).getAttribute('aria-current') === 'page', 'active category missing: ' + key)
  }
  // Playback and Audio retain one mounted workspace so switching preserves drafts.
  expect(
    sections.length === 7,
    'missing settings panels: ' + sections.map((section) => section.id).join(', ')
  )
  await select('connections')
  resolveLoad()
  await settle()
  expect(visibleSections()[0].id === 'connections', 'slow startup reset the selected category')
  expect(appNavigation.session.value.settingsSection === 'connections', 'category not remembered')
  await select('general')
  const general = document.querySelector('#general')
  const draft = general.querySelector('input')
  draft.value = '未保存的输入'
  general.querySelector('.test-disclosure').click()
  await settle()
  const before = page.scrollHeight
  general.querySelector('.test-disclosure').click()
  await settle()
  expect(
    before >= page.scrollHeight + 360,
    'disclosure did not update category height: ' +
      before +
      '/' +
      page.scrollHeight +
      '; nav=' +
      page.querySelector('nav').className
  )
  general.querySelector('.test-disclosure').click()
  await settle()
  const geometry = () => {
    const rect = page.querySelector('.settings-preview-stack').getBoundingClientRect()
    return [rect.left, rect.width]
  }
  expect(page.scrollHeight > page.clientHeight, 'long category did not overflow')
  const generalGeometry = geometry()
  await select('library')
  expect(
    geometry().every((value, index) => Math.abs(value - generalGeometry[index]) <= 1),
    'category switch changed horizontal geometry'
  )
  await select('general')
  expect(
    general.querySelector('input') === draft && draft.value === '未保存的输入',
    'category switch remounted the draft control'
  )
  expect(expanded.value, 'category switch reset disclosure state')
  page.scrollTop = 300
  page.dispatchEvent(new Event('scroll'))
  await settle()
  expect(nav('general').getAttribute('aria-current') === 'page', 'scroll changed category')
  await select('connections')
  await select('general')
  expect(Math.abs(page.scrollTop - 300) <= 1, 'category switch lost its saved scroll position')
  expect(
    page.style.getPropertyValue('--te-workshop-scroll-y') === '',
    'decoration scrolling invalidated controls through inheritance'
  )

  const search = async (query) => {
    const input = page.querySelector('#settings-search-input')
    input.value = query
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    const result = page.querySelector('#settings-result-0')
    expect(result, 'missing search result: ' + query)
    result.click()
    await settle()
    const target = page.querySelector('.search-target-flash')
    expect(target?.getClientRects().length, 'search target stayed hidden: ' + query)
    return target
  }
  for (const [query, id] of [
    ['检查更新', 'app-update'],
    ['版本信息', 'app-version'],
    ['下载 / 安装更新', 'app-update-install']
  ]) {
    const target = await search(query)
    expect(target.dataset.settingId === id, 'search alias fell back to category: ' + query)
    if (target.tagName === 'BUTTON') {
      expect(document.activeElement === target, 'native target not focused: ' + query)
      expect(
        target.tabIndex === 0 && !target.hasAttribute('tabindex'),
        'search removed the native button from Tab order: ' + query
      )
    }
  }
  for (const query of ['交叉淡化', 'crossfade']) {
    const target = await search(query)
    expect(target.dataset.settingId === 'gapless', 'legacy playback alias lost: ' + query)
  }
  for (const width of [760, 1000, 1440]) {
    await window.resizeTestWindow(width)
    await settle()
    await select('system')
    const target = await search('硬件加速')
    const rect = target.getBoundingClientRect(),
      pageRect = page.getBoundingClientRect()
    const usableTop = pageRect.top
    expect(
      rect.top >= usableTop - 2 && rect.bottom <= pageRect.bottom,
      'search result outside usable viewport at ' + width
    )
    expect(page.scrollWidth <= page.clientWidth + 1, 'horizontal overflow at ' + width)
    await select('general')
    expect(general.querySelector('input').value === '未保存的输入', 'resize lost draft')
  }
  // End must reveal a focused item inside the sidebar's own scroll container.
  await window.resizeTestWindow(1000, 480)
  await settle()
  await select('general')
  nav('general').focus({ preventScroll: true })
  nav('general').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  await settle()
  const strip = page.querySelector('.settings-nav-categories')
  const itemRect = nav('about').getBoundingClientRect(),
    stripRect = strip.getBoundingClientRect()
  expect(
    strip.scrollWidth <= strip.clientWidth + 1,
    'market categories overflow the horizontal navigation'
  )
  expect(
    document.activeElement === nav('about') && visibleSections()[0].id === 'about',
    'End did not focus and select the last category'
  )
  expect(
    itemRect.top >= stripRect.top - 1 && itemRect.bottom <= stripRect.bottom + 1,
    'focused category remained clipped in the sidebar'
  )
  nav('about').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
  await settle()
  expect(
    document.activeElement === nav('general') && strip.scrollTop === 0,
    'Home did not reveal the first category'
  )
  expect(
    [...strip.querySelectorAll('button')].filter((button) => button.tabIndex === 0).length === 1,
    'category navigation does not have one Tab stop'
  )

  const fades = (element) =>
    element
      .getAnimations()
      .filter((animation) =>
        animation.effect.getKeyframes().some((frame) => frame.opacity !== undefined)
      )
  const pointerSelect = async (key) => {
    nav(key).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await nextTick()
  }
  document.documentElement.dataset.teMotion = 'full'
  await pointerSelect('library')
  const firstFade = fades(document.querySelector('#library'))[0]
  expect(
    firstFade && fades(document.querySelector('#library')).length === 1,
    'pointer switch did not animate the selected category'
  )
  expect(
    visibleSections().length === 1 && visibleSections()[0].id === 'library',
    'animation delayed the selected category or left an old panel visible'
  )
  expect(firstFade.effect.getTiming().duration <= 300, 'category fade blocks navigation too long')
  await pointerSelect('playback')
  const playback = document.querySelector('#playback')
  const playbackFade = fades(playback)[0]
  expect(
    firstFade.playState === 'idle' && playbackFade && fades(playback).length === 1,
    'rapid switches stacked category animations'
  )
  playbackFade.pause()
  playbackFade.currentTime = Number(playbackFade.effect.getTiming().duration) / 4
  const interruptedOpacity = Number(getComputedStyle(playback).opacity)
  await pointerSelect('audio')
  const audio = document.querySelector('#audio')
  expect(
    audio === playback &&
      playbackFade.playState === 'idle' &&
      fades(audio).length === 1 &&
      Math.abs(Number(fades(audio)[0].effect.getKeyframes()[0].opacity) - interruptedOpacity) <
        0.01,
    'shared playback/audio panel restarted the fade instead of continuing from its visible opacity'
  )
  await pointerSelect('general')
  expect(
    general.querySelector('input') === draft && draft.value === '未保存的输入' && expanded.value,
    'animated category switch lost the input draft or disclosure state'
  )
  document.documentElement.dataset.teMotion = 'reduced'
  await nextTick()
  expect(
    fades(general).length === 0 && getComputedStyle(general).opacity === '1',
    'changing motion preference left a category partially transparent'
  )
  await pointerSelect('library')
  const reducedFade = fades(document.querySelector('#library'))[0]
  expect(
    reducedFade &&
      reducedFade.effect.getTiming().duration <= 120 &&
      reducedFade.effect.getKeyframes().every((frame) => frame.transform === undefined),
    'reduced motion did not retain a short fade without movement'
  )
  document.documentElement.dataset.teMotion = 'off'
  await nextTick()
  await pointerSelect('general')
  expect(
    reducedFade.playState === 'idle' &&
      !fades(general).length &&
      getComputedStyle(general).opacity === '1',
    'disabled motion still faded the selected category'
  )
  document.documentElement.dataset.teMotion = 'full'
  nav('general').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  await nextTick()
  expect(
    visibleSections()[0].id === 'about' &&
      document.activeElement === nav('about') &&
      !fades(document.querySelector('#about')).length,
    'keyboard category navigation animated or failed to restore focus'
  )
  document.documentElement.dataset.teMotion = 'off'

  await select('system')
  persistence.stop()
  mounted.value = false
  await settle()
  appNavigation = useAppNavigation()
  persistence = createNavigationSessionPersistence(appNavigation)
  expect(persistence.restored && appNavigation.showSettingsPage.value, 'settings not restored')
  expect(appNavigation.settingsInitialSection.value === 'system', 'saved category not restored')
  mounted.value = true
  await settle()
  expect(
    document.querySelector('[aria-current="page"]').textContent.includes('系统'),
    'reopened settings selected wrong category'
  )
  persistence.stop()
  app.unmount()
  removeDecorations()
  return 'SETTINGS_SCROLL_OK: category fades/interruption/motion preferences; eight categories and independent appearance entry; startup/drafts/geometry/search/Tab/market navigation/scroll restore verified'
}
