import { createApp, h, nextTick, ref, watchEffect } from 'vue'
import Inspector from '@renderer/components/AppearanceSurfaceInspector.vue'
import Bookmark from '@renderer/components/SidebarBookmark.vue'
import {
  cloneAppearance,
  defaultCardAppearance,
  normalizeAppBackgroundSettings
} from '@shared/appAppearance.ts'
import { normalizeLiquidGlass } from '@shared/liquidGlass.ts'
import { defaultAppearanceLayers } from '@shared/appearanceLayers.ts'
import { mountAppearanceLayers } from '@renderer/app/appearanceLayersRuntime.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/materials.css'
import '@renderer/assets/appearance.css'
import 'primeicons/primeicons.css'
import '@renderer/components/settings-page/SettingsPage.css'
import '@renderer/components/settings-page/SettingsLayout.css'
import '@renderer/components/settings-page/SettingsMarketLayout.css'
import '@renderer/components/settings-page/BackgroundAppearanceCustomizer.css'
import '@renderer/components/theme-studio/ThemeStudioPage.css'

const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const settle = async () => {
  await nextTick()
  for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
}
const initial = () =>
  cloneAppearance({
    appBackground: normalizeAppBackgroundSettings(),
    cardAppearance: defaultCardAppearance(),
    surfaceMaterial: 'standard',
    liquidGlass: normalizeLiquidGlass(),
    appearanceLayers: defaultAppearanceLayers()
  })
const draft = ref(initial()),
  part = ref('card'),
  tone = ref('dark'),
  busy = ref(false),
  horizontal = ref(false)
let updates = 0
const runtime = mountAppearanceLayers(document)
watchEffect(() => {
  runtime.update(draft.value.appearanceLayers, tone.value)
  document.documentElement.dataset.theme = tone.value === 'dark' ? 'dark' : 'pureWhite'
})
createApp({
  setup: () => () =>
    h(Inspector, {
      draft: draft.value,
      part: part.value,
      tone: tone.value,
      busy: busy.value,
      horizontal: horizontal.value,
      currentColor: '#789abc',
      'onUpdate:draft': (value) => {
        draft.value = value
        updates++
      }
    })
}).mount('#inspector-mount')
for (const selector of ['.advanced-property-probe', '.material-scope-probe', '.popup-probe'])
  document.querySelector(selector).remove()
const surface = document.createElement('section')
surface.innerHTML =
  '<aside id="nav" class="side-menu" style="width:180px;height:180px;position:fixed;left:300px;top:350px;background:#345678"></aside><section id="card" data-te-material="content" class="feature-card" style="position:fixed;left:500px;top:350px;width:180px;height:180px;background:#345678;border-radius:18px">Card</section><div id="title" class="title-bar-background"></div><div id="player" class="player-bar"></div><button id="control" style="position:fixed;left:700px;top:350px;background:#345678">Button</button><button id="selected" aria-pressed="true" style="background:rgb(12,34,56)">Selected</button><div id="bookmark-mount"></div>'
document.body.append(surface)
const settingsStructure = document.createElement('main')
settingsStructure.className = 'settings-preview-page'
settingsStructure.dataset.settingsLayout = 'categories'
settingsStructure.innerHTML =
  '<section class="settings-section preview-section"><div class="settings-group"><button class="settings-group-trigger">Group</button><button class="device-panel-disclosure">Device group</button></div></section>'
surface.append(settingsStructure)
// Caption tools inherit the shared caption material; a generic widget recipe
// must not add a second pane beneath their own state feedback.
const captionStructure = document.createElement('div')
captionStructure.className = 'title-bar'
captionStructure.innerHTML =
  '<button class="settings-btn" style="background:transparent;backdrop-filter:none">DSP</button><button class="page-dock-action" style="background:transparent;backdrop-filter:none">Preview</button><button class="control-btn" style="background:transparent;backdrop-filter:none">Minimize</button>'
surface.append(captionStructure)
const checkSettingsStructure = () => {
  for (const element of settingsStructure.querySelectorAll(
    '.preview-section,.settings-group-trigger,.device-panel-disclosure'
  )) {
    expect(
      !element.hasAttribute('data-te-appearance-body') &&
        getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)' &&
        getComputedStyle(element).backgroundImage === 'none',
      'settings structure acquires fixed card/control paint: ' +
        JSON.stringify({
          className: element.className,
          body: element.getAttribute('data-te-appearance-body'),
          background: getComputedStyle(element).backgroundColor,
          image: getComputedStyle(element).backgroundImage
        })
    )
  }
  for (const button of captionStructure.querySelectorAll('button')) {
    expect(
      !button.hasAttribute('data-te-appearance-body') &&
        getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)' &&
        getComputedStyle(button).backdropFilter === 'none',
      'caption tool acquires a second generic control material: ' + button.className
    )
  }
}
const extraCards = [
  'fresh-tile',
  'gallery-tile',
  'station-card',
  'chart-card',
  'theme-selection-card'
].map((name) => {
  const card = document.createElement('section')
  card.className = name
  card.style.cssText =
    'position:fixed;left:1050px;top:350px;width:80px;height:50px;background:#345678'
  surface.append(card)
  return card
})
createApp({ setup: () => () => h(Bookmark, { open: false }) }).mount('#bookmark-mount')
const targets = {
  controls: '#control',
  navigation: '#nav',
  material: '#title',
  'player-bar': '#player',
  card: '#card'
}
const snapshot = () => JSON.stringify(draft.value)
const click = async (selector) => {
  const e = document.querySelector(selector)
  expect(e, 'missing ' + selector)
  e.click()
  await settle()
}
const choose = async (value) => {
  const e = document.querySelector('[aria-label="部件材质"]')
  e.value = value
  e.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}
const open = async () => {
  if (!document.querySelector('#appearance-secondary-properties'))
    await click('.appearance-parameters-button')
}
const range = async (key, value) => {
  const e = document.querySelector('#part-' + key)
  expect(e, 'missing slider ' + key)
  e.value = value
  e.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

window.runMaterialTests = async () => {
  await settle()
  draft.value.appearanceLayers.scopes.controls.dark.body.enabled = true
  draft.value.appearanceLayers.scopes.card.dark.body.enabled = true
  document.documentElement.dataset.teCardCustom = 'on'
  await settle()
  checkSettingsStructure()
  delete document.documentElement.dataset.teCardCustom
  const bookmark = document.querySelector('.sidebar-bookmark')
  expect(
    !bookmark.querySelector('.bookmark-shape') &&
      getComputedStyle(bookmark, '::before').opacity === '0' &&
      getComputedStyle(bookmark, '::after').opacity === '0' &&
      bookmark.getBoundingClientRect().width === 32 &&
      bookmark.getBoundingClientRect().height === 32,
    'sidebar toggle retains a protruding bookmark or a persistent material block'
  )
  expect(
    !bookmark.hasAttribute('data-te-appearance-body') &&
      getComputedStyle(bookmark).backgroundColor === 'rgba(0, 0, 0, 0)' &&
      getComputedStyle(bookmark).backdropFilter === 'none',
    'generic control paint adds a rectangular block behind bookmark'
  )
  draft.value = initial()
  await settle()
  const baseline = snapshot()
  let cases = 0
  for (const scope of Object.keys(targets)) {
    part.value = scope
    await settle()
    await open()
    await click('.appearance-parameters-button')
  }
  expect(updates === 0 && snapshot() === baseline, 'opening inspector changes preferences')
  for (const currentTone of ['light', 'dark'])
    for (const scope of Object.keys(targets)) {
      draft.value = initial()
      tone.value = currentTone
      part.value = scope
      await settle()
      const opposite = currentTone === 'light' ? 'dark' : 'light'
      const selectedBackground = getComputedStyle(
        document.querySelector('#selected')
      ).backgroundColor
      for (const mode of ['solid', 'frosted', 'liquidGlass', 'theme']) {
        await choose(mode)
        await open()
        const target = document.querySelector(targets[scope]),
          style = getComputedStyle(target)
        checkSettingsStructure()
        if (scope === 'card')
          for (const card of extraCards) {
            const extra = getComputedStyle(card)
            expect(
              extra.backgroundColor === style.backgroundColor &&
                extra.backdropFilter === style.backdropFilter,
              'card family missed material ' + card.className + '/' + mode
            )
          }
        expect(
          draft.value.surfaceMaterial === 'standard' && !draft.value.liquidGlass.navigationEnabled,
          'part changes global glass'
        )
        expect(
          draft.value.appearanceLayers.scopes[scope][opposite].material.mode === 'theme',
          'material leaks across tones'
        )
        for (const sibling of Object.keys(targets))
          if (sibling !== scope)
            expect(
              draft.value.appearanceLayers.scopes[sibling][currentTone].material.mode === 'theme',
              'material leaks across parts'
            )
        if (mode === 'frosted' || mode === 'liquidGlass') {
          expect(
            style.backdropFilter.includes('blur('),
            'glass absent from ' + scope + ': ' + style.backdropFilter
          )
          await range('opacity', 63)
          await range('blur', 17)
          await range('saturation', 123)
          expect(
            getComputedStyle(target).backdropFilter.includes('blur(17px)'),
            'slider detached from rendered material'
          )
          if (mode === 'liquidGlass') {
            await range('refraction', 4)
            expect(
              getComputedStyle(target).backdropFilter.includes('url(') &&
                document.querySelector('feDisplacementMap')?.getAttribute('scale') === '4',
              'refraction absent'
            )
          }
          const source = document.querySelector('[aria-label="材质底色来源"]')
          source.value = 'custom'
          source.dispatchEvent(new Event('change', { bubbles: true }))
          await settle()
          const color = document.querySelector('[aria-label="部件底色"]')
          color.value = '#234567'
          color.dispatchEvent(new Event('input', { bubbles: true }))
          await settle()
          expect(
            getComputedStyle(target).backgroundColor.includes('0.63'),
            'custom color cancelled glass alpha: ' + getComputedStyle(target).backgroundColor
          )
          if (scope === 'navigation') {
            const handle = getComputedStyle(document.querySelector('.sidebar-bookmark'), '::before')
            expect(
              handle.backgroundColor === getComputedStyle(target).backgroundColor &&
                handle.backdropFilter === getComputedStyle(target).backdropFilter,
              'handle differs from panel'
            )
          }
        }
        expect(
          getComputedStyle(document.querySelector('#selected')).backgroundColor ===
            selectedBackground,
          'material erases selected state'
        )
        cases++
      }
    }
  part.value = 'inner-panel'
  await settle()
  const opposite = draft.value.appBackground.global.light,
    previous = snapshot()
  await open()
  expect(snapshot() === previous, 'background disclosure changes preferences')
  const text = document.querySelector('[aria-label="背景文字明暗"]')
  text.value = 'light'
  text.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(
    draft.value.appBackground.global.kind === 'color' &&
      draft.value.appBackground.global.effects.dark.textTone === 'light' &&
      draft.value.appBackground.global.light === opposite,
    'manual text tone does not activate or changes opposite tone'
  )
  const color = document.querySelector('[aria-label="背景颜色"]')
  color.value = '#456789'
  color.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  expect(draft.value.appBackground.global.dark === '#456789', 'background color detached')
  part.value = 'card'
  await settle()
  await choose('frosted')
  await open()
  busy.value = true
  await settle()
  const beforeBusy = snapshot()
  await choose('liquidGlass')
  expect(
    snapshot() === beforeBusy && document.querySelector('fieldset').disabled,
    'busy editor changes draft'
  )
  busy.value = false
  await settle()
  for (const mode of ['reduced', 'full']) {
    document.documentElement.dataset.teEffectsMode = mode
    await settle()
    expect(
      (getComputedStyle(document.querySelector('#card')).backdropFilter === 'none') ===
        (mode === 'reduced'),
      'effects fallback inconsistent'
    )
  }
  return {
    independentMaterialCases: cases,
    customColorAlpha: true,
    handleMatchesPanel: true,
    busyGuard: true
  }
}
window.verifyLayout = async () => {
  horizontal.value = true
  document.querySelector('.fixture').style.width = 'min(440px,calc(100vw - 32px))'
  document.querySelector('.fixture').classList.add('horizontal-fixture')
  for (const currentTone of ['light', 'dark'])
    for (const font of [14, 20, 28])
      for (const scope of ['card', 'controls', 'navigation', 'inner-panel']) {
        tone.value = currentTone
        part.value = scope
        document.querySelector('.fixture').style.setProperty('--te-font-size-body', font + 'px')
        await settle()
        if (scope !== 'inner-panel') await choose('liquidGlass')
        await open()
        const popup = document.querySelector('.appearance-popover'),
          rect = popup.getBoundingClientRect(),
          content = popup.querySelector('.appearance-popover-content')
        expect(
          rect.left >= 11.5 &&
            rect.right <= innerWidth - 11.5 &&
            rect.top >= 53.5 &&
            rect.bottom <= innerHeight - 11.5,
          'panel escapes ' + innerWidth + 'x' + innerHeight + ': ' + JSON.stringify(rect)
        )
        expect(content.scrollWidth <= content.clientWidth + 1, 'panel overflows at font ' + font)
        const field = popup.querySelector('.appearance-material-field')
        if (field)
          expect(
            getComputedStyle(field).flexDirection === 'row',
            'legacy fields split the material label and control'
          )
        const inspector = document.querySelector('.appearance-inspector')
        expect(
          inspector.scrollWidth <= inspector.clientWidth + 1,
          'toolbar overflows at font ' + font
        )
        await click('.appearance-parameters-button')
      }
}
window.prepareKeyboard = async () => {
  part.value = 'card'
  await settle()
  document.querySelector('.appearance-parameters-button').focus()
}
window.prepareMaterialPixels = async (mode) => {
  draft.value = initial()
  part.value = 'card'
  tone.value = 'dark'
  draft.value.appearanceLayers.scopes.card.dark.material = {
    ...draft.value.appearanceLayers.scopes.card.dark.material,
    mode,
    colorSource: 'custom',
    color: '#202226',
    opacity: 10,
    blur: mode === 'frosted' ? 12 : 0,
    saturation: 100,
    refraction: 6
  }
  document.body.style.background =
    'repeating-linear-gradient(90deg, #e62a50 0px 4px, #151c44 4px 8px, #eeeeee 8px 12px)'
  await settle()
  expect(
    !document.querySelector('[data-te-appearance-body]'),
    'material-only setting activates geometry observers'
  )
  const { x, y, width, height } = document.querySelector('#card').getBoundingClientRect()
  return {
    x: Math.ceil(x + 20),
    y: Math.ceil(y + 20),
    width: Math.floor(width - 40),
    height: Math.floor(height - 40)
  }
}
window.verifyKeyboardOpen = async () => {
  await settle()
  expect(document.querySelector('.appearance-popover'), 'Enter fails to open panel')
}
window.verifyKeyboardClosed = async () => {
  await settle()
  expect(!document.querySelector('.appearance-popover'), 'Escape fails to close panel')
  expect(
    document.activeElement === document.querySelector('.appearance-parameters-button'),
    'Escape fails to restore trigger focus'
  )
}
window.verifyFallback = async (feature) => {
  for (const scope of ['card', 'navigation']) {
    part.value = scope
    await settle()
    await choose('liquidGlass')
    expect(
      getComputedStyle(document.querySelector(targets[scope])).backdropFilter === 'none',
      'fallback retains filter: ' + feature
    )
    if (scope === 'navigation')
      expect(
        getComputedStyle(document.querySelector('.sidebar-bookmark'), '::before').backdropFilter ===
          'none',
        'handle retains filter'
      )
  }
}
