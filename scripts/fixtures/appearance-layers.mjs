import { createApp, h, ref, watch, nextTick } from 'vue'
import AppearanceLayerSettings from '__RENDERER__/components/AppearanceLayerSettings.vue'
import {
  mountAppearanceLayers,
  createAppearanceSkinOverflow
} from '__RENDERER__/app/appearanceLayersRuntime.ts'
import { normalizeAppearanceLayers } from '__RENDERER__/../../shared/appearanceLayers.ts'
import {
  cardCssVariables,
  cloneAppearance,
  defaultCardAppearance
} from '__RENDERER__/../../shared/appAppearance.ts'
import '__RENDERER__/assets/appearance.css'
import '__RENDERER__/assets/appearance-layers.css'

const expect = (value, message) => {
  if (!value) throw Error(message)
}
const settle = async (ms = 50) => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, ms))
  await nextTick()
}
const draft = ref(cloneAppearance({})),
  scope = ref('controls'),
  busy = ref(false)
// Hidden offscreen Electron probes exercise a visible document without opening a user window.
Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
const runtime = mountAppearanceLayers(document)
watch(draft, () => runtime.update(draft.value.appearanceLayers, 'dark'), {
  immediate: true,
  deep: true
})
const app = createApp({
  setup: () => () =>
    h(AppearanceLayerSettings, {
      draft: draft.value,
      scope: scope.value,
      tone: 'dark',
      busy: busy.value,
      'onUpdate:draft': (value) => {
        draft.value = value
      }
    })
})
app.mount('#editor')
const target = document.querySelector('#target'),
  clip = document.querySelector('.clip')
const decorationFor = (element) =>
  [...document.querySelectorAll('.te-appearance-effect[data-appearance-scope="controls"]')].find(
    (node) => {
      const bounds = element.getBoundingClientRect()
      return (
        Math.abs(parseFloat(node.style.left) - bounds.left) < 0.2 &&
        Math.abs(parseFloat(node.style.top) - bounds.top) < 0.2 &&
        Math.abs(parseFloat(node.style.width) - bounds.width) < 0.2
      )
    }
  )
const effect = () => decorationFor(target)
const input = async (label, value, kind = 'input') => {
  const element = document.querySelector('#editor [aria-label="' + label + '"]')
  element.value = value
  element.dispatchEvent(new Event(kind, { bubbles: true }))
  await settle()
}
const button = (label) =>
  [...document.querySelectorAll('#editor button')].find(
    (element) => element.textContent.trim() === label
  )
let initial
window.prepareLayers = async () => {
  const errors = []
  window.addEventListener('error', (event) => errors.push(event.message))
  await settle()
  expect(
    !document.querySelector('.te-appearance-effects') &&
      !target.hasAttribute('data-te-appearance-control'),
    'disabled defaults add active effects'
  )
  initial = {
    rect: target.getBoundingClientRect().toJSON(),
    color: getComputedStyle(target).color,
    background: getComputedStyle(target).backgroundColor
  }
  const layers = normalizeAppearanceLayers(undefined)
  layers.scopes.controls.dark.body = { enabled: true, color: '#ff0000', opacity: 0 }
  layers.scopes.controls.dark.effect = {
    enabled: true,
    color: '#ff0088',
    opacity: 100,
    spread: 8,
    blur: 0,
    motion: 'none',
    placement: 'outside'
  }
  layers.scopes['inner-panel'].dark.body = { enabled: true, color: '#204030', opacity: 100 }
  layers.scopes['outer-panel'].dark.body = { enabled: true, color: '#303040', opacity: 100 }
  draft.value = { ...draft.value, appearanceLayers: layers }
  await settle(250)
  expect(
    getComputedStyle(target).backgroundColor.endsWith('/ 0)') ||
      getComputedStyle(target).backgroundColor === 'rgba(0, 0, 0, 0)',
    'alpha zero is lost ' +
      JSON.stringify({
        color: getComputedStyle(target).backgroundColor,
        scope: target.dataset.teAppearanceBody,
        hidden: document.hidden,
        errors,
        host: document.querySelector('.te-appearance-effects')?.outerHTML
      })
  )
  expect(
    getComputedStyle(target).color === initial.color &&
      JSON.stringify(target.getBoundingClientRect().toJSON()) === JSON.stringify(initial.rect),
    'body alpha changes native text or geometry'
  )
  expect(
    document.querySelector('.app-shell').dataset.teAppearanceBody === 'outer-panel' &&
      document.querySelector('.app-shell-content').dataset.teAppearanceBody === 'inner-panel',
    'panel scopes are coupled'
  )
  expect(
    document.querySelector('a').dataset.teAppearanceBody === 'controls' &&
      document.querySelector('[role="slider"]').dataset.teAppearanceBody === 'controls',
    'non-button controls lack layers'
  )
  const host = document.querySelector('.te-appearance-effects')
  expect(
    effect() &&
      host.parentElement === document.body &&
      !clip.contains(host) &&
      host.inert &&
      getComputedStyle(host).pointerEvents === 'none',
    'effect remains clipped or interactive'
  )
  const bounds = target.getBoundingClientRect()
  expect(
    document.elementFromPoint(bounds.left + 30, bounds.top + 30) === target,
    'effect steals native click'
  )
  expect(
    ![...host.children].some((node) => parseFloat(node.style.width) === 20),
    'fully clipped control still emits a floating decoration'
  )
  let clicked = 0
  target.addEventListener('click', () => clicked++)
  target.click()
  expect(clicked === 1, 'native click lost')
  return {
    x: clip.getBoundingClientRect().right + 4,
    y: bounds.top + 30,
    width: innerWidth,
    height: innerHeight
  }
}
let imageSnapshot,
  imageClicks = 0,
  skinPanel,
  skinClip,
  skinStage,
  skinButton,
  validSkinHandle
const countImageClick = () => imageClicks++
const closeTo = (actual, expected, message) =>
  expect(
    Math.abs(actual - expected) < 0.6,
    message + ': expected ' + expected + ', received ' + actual
  )
const skinEffect = () =>
  document.querySelector(
    '.te-appearance-effects > .te-appearance-skin-overflow[data-appearance-scope="player-bar"]'
  )
async function changeImage(patch) {
  const next = cloneAppearance(draft.value)
  Object.assign(next.appearanceLayers.scopes['player-bar'].dark.skin, patch)
  draft.value = next
  await settle(100)
}
function imageSamples(placement, opacity, body = false) {
  const bounds = skinPanel.getBoundingClientRect()
  const background = [32, 64, 48, 255]
  const inside = body ? [0, 255, 0, 255] : background
  const opaque = opacity === 100 ? [240, 32, 96, 255] : [136, 48, 72, 255]
  const semi = body ? [120, 143, 48, 255] : opacity === 100 ? [136, 48, 72, 255] : [84, 56, 60, 255]
  const sample = (name, x, y, expected) => ({
    name,
    x: bounds.left + x,
    y: bounds.top + y,
    expected
  })
  return {
    width: innerWidth,
    height: innerHeight,
    samples: [
      sample('transparent-source-in-body-retains-background', 15, 8, inside),
      sample('semi-transparent-source-in-body-blends', 100, 8, semi),
      sample('opaque-source-is-the-component-background', 185, 8, opaque),
      sample(
        'opaque-source-beyond-parent-right-clip',
        230,
        8,
        placement === 'outside' ? opaque : background
      ),
      sample(
        'opaque-source-beyond-parent-top-clip',
        185,
        -15,
        placement === 'outside' ? opaque : background
      ),
      sample('source-ends-at-the-UV-extension', 280, 8, background)
    ]
  }
}
window.prepareImageLayers = async (handle) => {
  imageSnapshot = cloneAppearance(draft.value)
  validSkinHandle = handle
  skinStage = document.createElement('div')
  skinStage.id = 'skin-stage'
  skinStage.style.cssText =
    'position:absolute;left:430px;top:330px;width:360px;height:240px;background:#204030'
  skinStage.innerHTML =
    '<div id="skin-clip" style="position:absolute;left:60px;top:60px;width:200px;height:80px;overflow:hidden;background:#204030"><div id="skin-panel" class="player-bar" style="position:relative;width:200px;height:80px;background:#203040;border:0;border-radius:0"><button id="skin-button" type="button" style="position:relative;display:block;margin:0;border:0;padding:0;width:100%;height:100%;background:transparent;color:#eef1f4;font:16px sans-serif"><span id="skin-text">Native playback 播放</span></button></div></div><a id="skin-next" href="#skin-next" style="position:absolute;left:8px;bottom:8px">Next native action</a>'
  document.body.append(skinStage)
  skinPanel = document.querySelector('#skin-panel')
  skinClip = document.querySelector('#skin-clip')
  skinButton = document.querySelector('#skin-button')
  draft.value = { ...draft.value, appearanceLayers: normalizeAppearanceLayers(undefined) }
  await settle()
  const textBounds = document.querySelector('#skin-text').getBoundingClientRect().toJSON()
  const before = {
    width: innerWidth,
    height: innerHeight,
    textBounds,
    color: getComputedStyle(skinButton).color,
    panel: skinPanel.getBoundingClientRect().toJSON()
  }
  skinButton.addEventListener('click', countImageClick)
  return before
}
window.enableImageLayers = async () => {
  await changeImage({
    enabled: true,
    image: validSkinHandle,
    scale: 100,
    x: 0,
    y: 0,
    opacity: 100,
    placement: 'outside',
    fit: 'fill',
    frame: { top: 20, right: 20, bottom: 20, left: 20 }
  })
  const sourceImage = new Image()
  sourceImage.crossOrigin = 'anonymous'
  sourceImage.src = validSkinHandle
  await sourceImage.decode()
  await settle()
  expect(
    sourceImage.naturalWidth === 120 && sourceImage.naturalHeight === 60,
    'PNG source dimensions changed during import'
  )
  const source = document.createElement('canvas')
  source.width = 120
  source.height = 60
  const context = source.getContext('2d')
  context.drawImage(sourceImage, 0, 0)
  const sourceAlpha = [20, 60, 100].map((x) => context.getImageData(x, 30, 1, 1).data[3])
  expect(JSON.stringify(sourceAlpha) === '[0,128,255]', 'PNG source alpha was flattened')
  const overflow = skinEffect()
  expect(
    skinPanel.dataset.teAppearanceSkin === 'player-bar' &&
      getComputedStyle(skinPanel).backgroundImage.includes('background://'),
    'Skin body is not a native component background'
  )
  expect(
    overflow &&
      !skinClip.contains(overflow) &&
      overflow.inert &&
      getComputedStyle(overflow).pointerEvents === 'none',
    'Skin overflow is clipped or interactive'
  )
  expect(
    getComputedStyle(overflow).clipPath.includes('evenodd'),
    'Overflow does not protect the component foreground with a body hole'
  )
  expect(
    !document.querySelector('.te-appearance-effects img') &&
      !skinButton.hasAttribute('data-te-appearance-skin'),
    'Skin creates a sticker on native foreground controls'
  )
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-width')),
    1000 / 3,
    'UV full source width'
  )
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-height')),
    400 / 3,
    'UV full source height'
  )
  return {
    ...imageSamples('outside', 100),
    sourceAlpha,
    textBounds: document.querySelector('#skin-text').getBoundingClientRect().toJSON(),
    color: getComputedStyle(skinButton).color
  }
}
window.startImageInteraction = () => {
  imageClicks = 0
  const bounds = skinPanel.getBoundingClientRect()
  const point = { x: bounds.left + 185, y: bounds.top + 10 }
  expect(
    document.elementFromPoint(point.x, point.y) === skinButton,
    'Skin blocks the native foreground hit target'
  )
  skinButton.focus()
  return point
}
window.checkImageInteraction = () => {
  expect(imageClicks === 2, 'Skin blocks pointer or Space activation: ' + imageClicks + ' clicks')
  const tabToLink = document.activeElement === document.querySelector('#skin-next')
  expect(tabToLink, 'Skin overflow enters the native Tab order')
  return { clicks: imageClicks, tabToLink }
}
window.setImagePresentation = async (placement, opacity) => {
  await changeImage({ placement, opacity })
  expect(
    (placement === 'inside') === !skinEffect(),
    'Inside/outside changes do not remove or create the overflow plane'
  )
  return imageSamples(placement, opacity)
}
window.setImageBodyLayer = async () => {
  await changeImage({ opacity: 100, placement: 'outside' })
  const next = cloneAppearance(draft.value)
  next.appearanceLayers.scopes['player-bar'].dark.body = {
    enabled: true,
    color: '#00ff00',
    opacity: 100
  }
  draft.value = next
  await settle()
  return imageSamples('outside', 100, true)
}
window.checkImageGeometry = async () => {
  const cleanBody = cloneAppearance(draft.value)
  cleanBody.appearanceLayers.scopes['player-bar'].dark.body.enabled = false
  draft.value = cleanBody
  await changeImage({ fit: 'contain', opacity: 100, scale: 100, x: 0, y: 0 })
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-width')),
    800 / 3,
    'Contain keeps source aspect ratio'
  )
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-height')),
    400 / 3,
    'Contain maps the UV body inside the component'
  )
  await changeImage({ fit: 'cover' })
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-width')),
    1000 / 3,
    'Cover fills the UV body width'
  )
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-height')),
    500 / 3,
    'Cover keeps source aspect ratio while cropping'
  )
  await changeImage({ fit: 'fill', scale: 150, x: 25, y: -50 })
  let bounds = skinPanel.getBoundingClientRect()
  let overflowBounds = skinEffect().getBoundingClientRect()
  closeTo(overflowBounds.width, 500, 'PNG resized width')
  closeTo(overflowBounds.height, 200, 'PNG resized height')
  closeTo(overflowBounds.left, bounds.left - 100, 'UV horizontal anchor')
  closeTo(overflowBounds.top, bounds.top - 100, 'UV vertical anchor')
  const beforeMove = overflowBounds.toJSON()
  skinClip.style.left = '108px'
  await settle()
  overflowBounds = skinEffect().getBoundingClientRect()
  closeTo(overflowBounds.left - beforeMove.left, 48, 'Skin follows parent layout movement')
  skinPanel.style.width = skinClip.style.width = '240px'
  skinPanel.style.height = skinClip.style.height = '100px'
  await settle()
  bounds = skinPanel.getBoundingClientRect()
  overflowBounds = skinEffect().getBoundingClientRect()
  closeTo(overflowBounds.width, 600, 'Skin follows target resize width')
  closeTo(overflowBounds.height, 250, 'Skin follows target resize height')
  closeTo(overflowBounds.left, bounds.left - 120, 'Skin horizontal offset after resize')
  closeTo(overflowBounds.top, bounds.top - 125, 'Skin vertical offset after resize')
  const resized = overflowBounds.toJSON()
  skinStage.classList.add('appearance-preview-scene')
  skinStage.inert = true
  await settle()
  expect(
    getComputedStyle(skinPanel).pointerEvents === 'auto' &&
      skinPanel.dataset.teAppearanceSkin === 'player-bar' &&
      skinEffect(),
    'The intentionally inert native preview source loses its background skin'
  )
  skinStage.classList.remove('appearance-preview-scene')
  await settle()
  expect(
    !skinPanel.hasAttribute('data-te-appearance-skin') && !skinEffect(),
    'An unrelated inert component bypasses occlusion protection'
  )
  skinStage.classList.add('appearance-preview-scene')
  await settle()
  expect(skinEffect(), 'The inert preview source does not regain its skin')
  skinStage.inert = false
  skinStage.style.visibility = 'hidden'
  await changeImage({ x: 10, frame: { top: 10, right: 20, bottom: 10, left: 20 } })
  expect(
    skinPanel.dataset.teAppearanceSkin === 'player-bar' && !skinEffect(),
    'A hidden 3D source loses its skin metadata or leaves a viewport portal'
  )
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-width')),
    600,
    'Hidden source keeps updated UV width'
  )
  closeTo(
    parseFloat(skinPanel.style.getPropertyValue('--te-skin-height')),
    187.5,
    'Hidden source updates its new UV frame'
  )
  const clone = skinPanel.cloneNode(true)
  clone.id = 'skin-preview-clone'
  for (const node of clone.querySelectorAll('[id]')) node.removeAttribute('id')
  const plane = document.createElement('div')
  plane.dataset.appearanceLayerScene = ''
  plane.style.cssText = 'position:absolute;left:430px;top:200px;width:240px;height:100px'
  plane.append(clone)
  document.body.append(plane)
  const copiedOverflow = createAppearanceSkinOverflow(clone)
  expect(copiedOverflow, 'A clone cannot rebind its local skin overflow')
  plane.append(copiedOverflow)
  expect(
    copiedOverflow.inert && getComputedStyle(copiedOverflow).pointerEvents === 'none',
    'A rebound skin overflow is interactive'
  )
  closeTo(parseFloat(copiedOverflow.style.width), 600, 'Rebound clone keeps UV geometry')
  closeTo(
    parseFloat(copiedOverflow.style.left),
    -156,
    'Rebound clone uses local position rather than viewport coordinates'
  )
  await settle()
  expect(!skinEffect(), 'A 3D clone is unexpectedly re-portaled by the global runtime')
  plane.remove()
  skinStage.style.visibility = ''
  skinStage.classList.remove('appearance-preview-scene')
  await settle()
  expect(skinEffect(), 'Skin does not return from the hidden 3D source')
  const added = document.createElement('div')
  added.className = 'player-bar'
  added.style.cssText =
    'position:absolute;left:5px;top:5px;width:80px;height:30px;--te-skin-left:7px!important'
  added.dataset.teAppearanceSkin = 'previous-skin'
  skinStage.append(added)
  await settle()
  expect(
    added.dataset.teAppearanceSkin === 'player-bar',
    'New component does not receive its own skin'
  )
  added.remove()
  await settle()
  expect(
    added.dataset.teAppearanceSkin === 'previous-skin' &&
      added.style.getPropertyValue('--te-skin-left') === '7px' &&
      added.style.getPropertyPriority('--te-skin-left') === 'important',
    'Removed component does not restore its previous attributes and custom properties'
  )
  await changeImage({ image: 'background://missing.png' })
  await settle(100)
  expect(
    !skinPanel.hasAttribute('data-te-appearance-skin') && !skinEffect(),
    'Missing skin leaves a broken or stale background'
  )
  await changeImage({ image: validSkinHandle })
  expect(
    skinPanel.dataset.teAppearanceSkin === 'player-bar' && skinEffect(),
    'Replacing a missing skin cannot recover'
  )
  const legacy = cloneAppearance(draft.value)
  Object.assign(legacy.appearanceLayers.scopes.controls.dark.effect, {
    enabled: true,
    image: validSkinHandle
  })
  Object.assign(legacy.appearanceLayers.scopes.controls.dark.skin, {
    enabled: true,
    image: validSkinHandle
  })
  draft.value = legacy
  await settle()
  expect(
    !skinButton.hasAttribute('data-te-appearance-skin') &&
      getComputedStyle(skinButton).backgroundImage === 'none' &&
      !document.querySelector('.te-appearance-effects img'),
    'Legacy or new controls images are still rendered as stickers'
  )
  await changeImage({ image: '' })
  expect(
    !skinPanel.hasAttribute('data-te-appearance-skin') &&
      !skinEffect() &&
      getComputedStyle(skinPanel).backgroundImage === 'none' &&
      getComputedStyle(skinPanel).backgroundColor === 'rgb(32, 48, 64)',
    'Removing the skin fails to restore the original native background'
  )
  return {
    scale: 150,
    x: 25,
    y: -50,
    frame: { top: 20, right: 20, bottom: 20, left: 20 },
    parentMovement: 48,
    resized,
    hiddenSourceUpdated: true,
    inertPreviewSourcePainted: true,
    unrelatedInertOcclusionPreserved: true,
    cloneRebound: true,
    controlsImagesSuppressed: true,
    removedTargetCleaned: true,
    missingImageRecovered: true
  }
}
window.finishImageLayers = async () => {
  skinButton.removeEventListener('click', countImageClick)
  skinStage.remove()
  draft.value = imageSnapshot
  await settle()
  expect(
    !document.querySelector('.te-appearance-skin-overflow') &&
      !document.querySelector('[data-te-appearance-skin]'),
    'Skin cleanup leaves a background or overflow marker'
  )
  expect(
    effect() && getComputedStyle(effect()).boxShadow !== 'none',
    'Skin testing changes the original color effects'
  )
}
let windowSkinSnapshot, windowSkinShell, oldShellVisibility
window.prepareWholeWindowSkin = async () => {
  windowSkinSnapshot = cloneAppearance(draft.value)
  oldShellVisibility = document.querySelector('.app-shell').style.visibility
  document.querySelector('.app-shell').style.visibility = 'hidden'
  windowSkinShell = document.createElement('div')
  windowSkinShell.className = 'app-shell'
  windowSkinShell.style.cssText =
    'position:absolute;left:20px;top:360px;width:300px;height:160px;background:#ffffff;overflow:hidden'
  windowSkinShell.innerHTML =
    '<div class="app-shell-title" style="position:absolute;left:0;top:0;width:100%;height:40px"><div class="title-bar" style="position:relative;height:40px;background:#002200"><div class="title-bar-background" style="position:absolute;inset:0;background:#0000ff"></div><button id="window-skin-title-action" style="position:absolute;right:0;top:0;width:90px;height:40px;border:0;background:transparent;color:#eef1f4">Close</button></div></div><div class="app-shell-content" style="position:absolute;inset:60px 20px 20px;background:#28343c;border-radius:12px">Inner content</div>'
  document.body.append(windowSkinShell)
  const layers = normalizeAppearanceLayers(undefined)
  Object.assign(layers.scopes['outer-panel'].dark.skin, {
    enabled: true,
    image: validSkinHandle,
    placement: 'inside'
  })
  draft.value = { ...draft.value, appearanceLayers: layers }
  await settle(150)
  const title = windowSkinShell.querySelector('.title-bar')
  const painter = windowSkinShell.querySelector('.title-bar-background')
  const inner = windowSkinShell.querySelector('.app-shell-content')
  expect(
    windowSkinShell.dataset.teAppearanceSkin === 'outer-panel' &&
      !title.hasAttribute('data-te-appearance-skin'),
    'The outer skin is not one full shell image or has been copied to the title'
  )
  expect(
    getComputedStyle(title).backgroundImage === 'none' &&
      getComputedStyle(painter).backgroundColor === 'rgba(0, 0, 0, 0)',
    'The title material repaints or tints the continuous outer skin'
  )
  expect(
    document.elementFromPoint(280, 380) === windowSkinShell.querySelector('button'),
    'An outer skin blocks native title controls'
  )
  return {
    width: innerWidth,
    height: innerHeight,
    outerIncludesTitle: true,
    nativeTitleHit: true,
    innerRadius: getComputedStyle(inner).borderRadius,
    samples: [
      { name: 'whole-title-transparent-hole', x: 50, y: 368, expected: [16, 18, 24, 255] },
      { name: 'whole-title-semitransparent-region', x: 170, y: 368, expected: [128, 25, 60, 255] },
      { name: 'whole-title-opaque-region', x: 300, y: 368, expected: [240, 32, 96, 255] },
      {
        name: 'inner-rounded-surface-remains-separate',
        x: 170,
        y: 460,
        expected: [40, 52, 60, 255]
      }
    ]
  }
}
window.finishWholeWindowSkin = async () => {
  windowSkinShell.remove()
  document.querySelector('.app-shell').style.visibility = oldShellVisibility
  draft.value = windowSkinSnapshot
  await settle()
}
let homeSnapshot, homeStage, homePreview
const homeCards = () => [...homeStage.querySelectorAll('[data-home-card]')]
const homeOverflows = () => [
  ...document.querySelectorAll('.te-appearance-effects > [data-appearance-scope="card"]')
]
const homeInteractions = { hero: 0, online: 0, local: 0 }
const homeTargets = () => homeCards().map((card) => card.querySelector('button') || card)
const homeBounds = (card) => ({
  id: card.dataset.homeCard,
  bounds: card.getBoundingClientRect().toJSON(),
  textBounds: card.querySelector('.home-card-label').getBoundingClientRect().toJSON(),
  color: getComputedStyle(card.querySelector('.home-card-label')).color
})
const homeSamples = (cards, outside) =>
  cards.flatMap((card) => {
    const bounds = card.getBoundingClientRect()
    const scaleX = bounds.width / card.offsetWidth
    const scaleY = bounds.height / card.offsetHeight
    return [
      ['transparent-body', 10, 8, [32, 64, 48, 255]],
      ['semitransparent-body', 90, 8, [136, 48, 72, 255]],
      ['opaque-body', 165, 8, [240, 32, 96, 255]],
      ['opaque-right-overflow', 205, 8, outside ? [240, 32, 96, 255] : [32, 64, 48, 255]],
      ['opaque-top-overflow', 165, -15, outside ? [240, 32, 96, 255] : [32, 64, 48, 255]]
    ].map(([name, x, y, expected]) => ({
      name: `${card.dataset.homeCard}/${name}`,
      x: bounds.left + x * scaleX,
      y: bounds.top + y * scaleY,
      expected
    }))
  })
window.prepareHomeCardSkins = async () => {
  homeSnapshot = cloneAppearance(draft.value)
  homeStage = document.createElement('div')
  homeStage.id = 'home-skin-stage'
  homeStage.className = 'home-skin-stage'
  homeStage.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#204030'
  const cover =
    '<span class="online-playlist-cover" style="position:absolute;left:10px;top:40px;width:40px;height:30px;background:#405060"></span>'
  const foreground =
    '<span style="position:absolute;left:10px;top:10px">Music</span><span class="home-card-label" style="position:absolute;right:8px;top:35px;color:#eef1f4;font:16px sans-serif">Play</span>'
  // Use the real home host/cover classes and semantics: a hero with a native
  // action, an online playlist button, and a local card sharing that class.
  homeStage.innerHTML = `
    <div class="home-card-clip" style="left:80px"><section class="online-hero" data-home-card="hero"><button type="button" aria-label="Play main recommendation">${foreground}</button></section></div>
    <div class="home-card-clip" style="left:320px" aria-busy="true"><button class="online-playlist" data-home-card="online" type="button" aria-label="Play online playlist">${cover}${foreground}</button></div>
    <div class="home-card-clip" style="left:560px"><button class="home-local-card online-playlist" data-home-card="local" type="button" aria-label="Play local collection">${cover}${foreground}</button></div>
    <div class="online-loading-content" aria-hidden="true" style="position:absolute;left:80px;top:310px"><div class="online-skeleton"><div class="online-playlist" data-home-placeholder="loading">${cover}</div></div></div>
    <div class="online-skeleton" aria-hidden="true" style="position:absolute;left:320px;top:310px"><div class="online-playlist" data-home-placeholder="skeleton">${cover}</div></div>
    <a id="home-card-next" href="#home-card-next" style="position:absolute;left:560px;top:440px">Next native action</a>`
  const styles = document.createElement('style')
  styles.textContent =
    '.home-skin-stage .home-card-clip{position:absolute;top:110px;width:180px;height:90px;overflow:hidden;background:#204030}.home-skin-stage [data-home-card],.home-skin-stage [data-home-placeholder]{position:relative;display:block;box-sizing:border-box;width:180px;height:90px;margin:0;border:0;border-radius:0;padding:0;background:#204030;color:#eef1f4;font:14px sans-serif}.home-skin-stage .online-hero>button{position:relative;display:block;box-sizing:border-box;width:100%;height:100%;margin:0;border:0;padding:0;background:transparent;color:inherit;font:inherit}'
  homeStage.append(styles)
  document.body.append(homeStage)
  draft.value = { ...draft.value, appearanceLayers: normalizeAppearanceLayers(undefined) }
  for (const [index, target] of homeTargets().entries())
    target.addEventListener('click', () => homeInteractions[['hero', 'online', 'local'][index]]++)
  await settle()
  return { width: innerWidth, height: innerHeight, cards: homeCards().map(homeBounds) }
}
window.enableHomeCardSkins = async () => {
  const next = cloneAppearance(draft.value)
  Object.assign(next.appearanceLayers.scopes.card.dark.skin, {
    enabled: true,
    image: validSkinHandle,
    placement: 'outside',
    fit: 'fill',
    frame: { top: 20, right: 20, bottom: 20, left: 20 }
  })
  draft.value = next
  await settle(100)
  for (const card of homeCards()) {
    expect(
      card.dataset.teAppearanceBody === 'card' && card.dataset.teAppearanceSkin === 'card',
      `Home ${card.dataset.homeCard} does not receive the common card skin`
    )
    expect(
      getComputedStyle(card).backgroundImage.includes('background://'),
      `Home ${card.dataset.homeCard} is not painted as a native background`
    )
    closeTo(parseFloat(card.style.getPropertyValue('--te-skin-left')), -60, 'Home UV left')
    closeTo(parseFloat(card.style.getPropertyValue('--te-skin-top')), -30, 'Home UV top')
    closeTo(parseFloat(card.style.getPropertyValue('--te-skin-width')), 300, 'Home UV width')
    closeTo(parseFloat(card.style.getPropertyValue('--te-skin-height')), 150, 'Home UV height')
  }
  expect(
    !homeStage.querySelector(
      '.online-playlist-cover[data-te-appearance-body],.online-playlist-cover[data-te-appearance-skin]'
    ),
    'A home cover is incorrectly treated as another whole card'
  )
  expect(
    !homeStage.querySelector(
      '[data-home-placeholder][data-te-appearance-body],[data-home-placeholder][data-te-appearance-skin]'
    ),
    'Loading placeholders receive live card skins'
  )
  expect(homeOverflows().length === 3, 'Home cards do not have one overflow plane each')
  // A widget can carry legacy and current aliases without being painted twice.
  homeCards()[0].classList.add('feature-card')
  homeCards()[2].classList.add('playlist-card')
  await settle()
  expect(homeOverflows().length === 3, 'Repeated card aliases create duplicate overflow planes')
  for (const overflow of homeOverflows())
    expect(
      overflow.inert &&
        getComputedStyle(overflow).pointerEvents === 'none' &&
        getComputedStyle(overflow).clipPath.includes('evenodd'),
      'Home overflow is interactive or lacks the native foreground cutout'
    )
  return {
    width: innerWidth,
    height: innerHeight,
    cards: homeCards().map(homeBounds),
    samples: homeSamples(homeCards(), true),
    matchingCards: 3,
    overflowPlanes: homeOverflows().length,
    duplicateAliasesDeduplicated: true,
    coversExcluded: true,
    loadingExcluded: true,
    refreshingContentIncluded: true
  }
}
window.startHomeCardInteraction = (index) => {
  const card = homeCards()[index],
    target = homeTargets()[index]
  const bounds = card.getBoundingClientRect(),
    point = { x: bounds.left + 165, y: bounds.top + 65 }
  expect(
    document.elementFromPoint(point.x, point.y) === target,
    'Home skin blocks a native card action'
  )
  target.focus()
  return point
}
window.checkHomeCardInteraction = (index) => {
  const id = ['hero', 'online', 'local'][index]
  expect(
    homeInteractions[id] === 2,
    `Home ${id} mouse/Space actions changed: ${homeInteractions[id]}`
  )
  const expectedNext = homeTargets()[index + 1] || document.querySelector('#home-card-next')
  expect(document.activeElement === expectedNext, `Home ${id} decoration changed native Tab order`)
  return { id, clicks: homeInteractions[id], tabToNext: true }
}
window.setHomeCardInside = async () => {
  const next = cloneAppearance(draft.value)
  next.appearanceLayers.scopes.card.dark.skin.placement = 'inside'
  draft.value = next
  await settle()
  expect(homeOverflows().length === 0, 'Inside home skins leave floating overflow')
  return { width: innerWidth, height: innerHeight, samples: homeSamples(homeCards(), false) }
}
window.checkHomeCardPreview = async () => {
  const next = cloneAppearance(draft.value)
  next.appearanceLayers.scopes.card.dark.skin.placement = 'outside'
  draft.value = next
  homeStage.classList.add('appearance-preview-scene')
  homeStage.inert = true
  await settle()
  expect(homeOverflows().length === 3, 'Inert native home preview loses its card backgrounds')
  homeStage.style.visibility = 'hidden'
  await settle()
  expect(
    homeOverflows().length === 0 &&
      homeCards().every((card) => card.dataset.teAppearanceSkin === 'card'),
    'Hidden home source loses clone metadata or leaves a viewport portal'
  )
  homePreview = homeStage.cloneNode(true)
  homePreview.removeAttribute('id')
  homePreview.classList.remove('appearance-preview-scene')
  homePreview.dataset.appearanceLayerScene = ''
  homePreview.style.visibility = ''
  document.body.append(homePreview)
  const clones = [...homePreview.querySelectorAll('[data-home-card]')]
  for (const clone of clones) {
    const overflow = createAppearanceSkinOverflow(clone, {
      left: clone.parentElement.offsetLeft,
      top: clone.parentElement.offsetTop
    })
    expect(overflow, 'A home 3D clone cannot rebind its card overflow')
    homePreview.append(overflow)
  }
  // A real 3D transform must move the body and its rebound edge on one plane.
  homePreview.style.transformOrigin = '0 0'
  homePreview.style.transform = 'rotateY(20deg)'
  await settle()
  expect(
    homeOverflows().length === 0,
    'The runtime re-portals preview clones into viewport coordinates'
  )
  expect(
    homePreview.querySelectorAll('[data-te-appearance-skin="card"]').length === 3 &&
      homePreview.querySelectorAll('.te-appearance-skin-overflow').length === 3,
    '2D and 3D home cards have different skin mappings'
  )
  return {
    width: innerWidth,
    height: innerHeight,
    samples: homeSamples(clones, true),
    nativeMarkers: homeCards().map((card) => card.dataset.teAppearanceSkin),
    cloneMarkers: clones.map((card) => card.dataset.teAppearanceSkin),
    reboundPlanes: 3,
    hiddenSourceKept: true,
    noGlobalClonePortal: true,
    transform: getComputedStyle(homePreview).transform
  }
}
window.finishHomeCardSkins = async () => {
  homePreview.remove()
  homeStage.style.visibility = ''
  homeStage.inert = false
  await settle()
  expect(homeOverflows().length === 3, 'Home skins do not return from the 3D source')
  const detached = homeCards()
  homeStage.remove()
  draft.value = homeSnapshot
  await settle()
  expect(
    !homeOverflows().length &&
      detached.every(
        (card) =>
          !card.hasAttribute('data-te-appearance-skin') &&
          !card.hasAttribute('data-te-appearance-body')
      ),
    'Removing home cards leaves runtime mappings or overflow planes'
  )
  return { removedTargetCleaned: true, restoredFromPreview: true }
}
let combinedAttributes, combinedVariables
window.prepareHomeCardCombination = async () => {
  await window.prepareHomeCardSkins()
  homeCards()[0].classList.add('feature-card')
  homeCards()[1].classList.add('playlist-card')
  homeCards()[2].classList.add('album-card')
  const root = document.documentElement
  combinedAttributes = ['data-te-card-custom', 'data-te-surface-material'].map((name) => [
    name,
    root.getAttribute(name)
  ])
  const variables = cardCssVariables({
    ...defaultCardAppearance().dark,
    backgroundColor: '#163f72',
    backgroundOpacity: 100,
    borderWidth: 2,
    borderRadius: 0,
    blurRadius: 0,
    shadowStrength: 'none',
    hoverEffect: 'none',
    glassHighlight: false
  })
  combinedVariables = document.createElement('style')
  combinedVariables.textContent = `:root{${Object.entries(variables)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')};--te-material-content-filter:none}`
  document.head.append(combinedVariables)
}
window.setHomeCardCombination = async ({ custom, material, mode }) => {
  const root = document.documentElement
  root.dataset.teCardCustom = custom ? 'on' : 'off'
  root.dataset.teSurfaceMaterial = material
  const layers = normalizeAppearanceLayers(undefined)
  const hasSkin = mode === 'skin' || mode === 'body-skin'
  const hasBody = mode === 'body' || mode === 'body-skin'
  Object.assign(layers.scopes.card.dark.body, { enabled: hasBody, color: '#00ff00', opacity: 100 })
  Object.assign(layers.scopes.card.dark.skin, {
    enabled: hasSkin,
    image: validSkinHandle,
    fit: 'fill',
    placement: 'outside',
    frame: { top: 20, right: 20, bottom: 20, left: 20 }
  })
  draft.value = { ...draft.value, appearanceLayers: layers }
  await settle(80)
  const background = [32, 64, 48, 255]
  const bodyColor = hasBody ? [0, 255, 0, 255] : background
  const clearedColor = custom && material === 'standard' ? [22, 63, 114, 255] : background
  const samples = homeCards().flatMap((card) => {
    const bounds = card.getBoundingClientRect()
    const interior = hasSkin
      ? [bodyColor, hasBody ? [120, 143, 48, 255] : [136, 48, 72, 255], [240, 32, 96, 255]]
      : Array(3).fill(hasBody ? bodyColor : clearedColor)
    return [
      ['transparent-body', 10, 8, interior[0]],
      ['semitransparent-body', 90, 8, interior[1]],
      ['opaque-body', 165, 8, interior[2]],
      ['opaque-right-overflow', 205, 8, hasSkin ? [240, 32, 96, 255] : background],
      ['opaque-top-overflow', 165, -15, hasSkin ? [240, 32, 96, 255] : background]
    ].map(([name, x, y, expected]) => ({
      name: `${card.dataset.homeCard}/${name}`,
      x: bounds.left + x,
      y: bounds.top + y,
      expected
    }))
  })
  return {
    custom,
    material,
    mode,
    width: innerWidth,
    height: innerHeight,
    samples,
    overflowPlanes: homeOverflows().length,
    cards: homeCards().map((card) => {
      const style = getComputedStyle(card)
      return {
        ...homeBounds(card),
        classes: card.className,
        bodyScope: card.dataset.teAppearanceBody ?? null,
        skinScope: card.dataset.teAppearanceSkin ?? null,
        backgroundImage: style.backgroundImage,
        backgroundColor: style.backgroundColor,
        backgroundPosition: style.backgroundPosition,
        backgroundSize: style.backgroundSize,
        uv: ['--te-skin-left', '--te-skin-top', '--te-skin-width', '--te-skin-height'].map((name) =>
          parseFloat(card.style.getPropertyValue(name))
        )
      }
    })
  }
}
window.finishHomeCardCombination = async () => {
  for (const [name, value] of combinedAttributes) {
    if (value === null) document.documentElement.removeAttribute(name)
    else document.documentElement.setAttribute(name, value)
  }
  combinedVariables.remove()
  await window.enableHomeCardSkins()
  const cleanup = await window.finishHomeCardSkins()
  return { ...cleanup, originalCustomAttributesRestored: true }
}
window.checkLayers = async () => {
  button('效果层').click()
  await settle()
  await input('效果动态', 'breathe', 'change')
  expect(
    getComputedStyle(effect()).animationName === 'te-effect-breathe',
    'dynamic channel is not animated'
  )
  document.documentElement.dataset.teMotion = 'reduced'
  await settle()
  expect(getComputedStyle(effect()).animationName === 'none', 'reduced motion is ignored')
  document.documentElement.dataset.teMotion = 'full'
  await input('效果显示范围', 'inside', 'change')
  await input('效果动态', 'drift', 'change')
  expect(
    getComputedStyle(effect()).boxShadow.includes('inset') &&
      getComputedStyle(effect()).animationName === 'te-effect-breathe',
    'inside effect drifts beyond its control'
  )
  await input('效果显示范围', 'outside', 'change')
  await input('效果动态', 'none', 'change')
  document.querySelector('.app-shell').classList.add('shift')
  await settle()
  expect(
    Math.abs(parseFloat(effect().style.left) - target.getBoundingClientRect().left) < 0.2,
    'effect does not follow layout'
  )
  target.classList.add('move')
  await settle(100)
  expect(
    Math.abs(parseFloat(effect().style.left) - target.getBoundingClientRect().left) < 2,
    'effect does not follow animated transform'
  )
  await settle(200)
  target.classList.remove('move')
  await settle(300)
  const added = document.createElement('button')
  added.textContent = 'Added'
  added.style.cssText = 'position:absolute;left:200px;top:120px;width:90px;height:35px'
  document.querySelector('.app-shell-content').append(added)
  await settle()
  expect(added.dataset.teAppearanceBody === 'controls', 'dynamic control is not registered')
  added.remove()
  await settle()
  expect(!added.hasAttribute('data-te-appearance-body'), 'removed control retains a stale mark')
  busy.value = true
  await settle()
  const before = JSON.stringify(draft.value)
  button('主体层').click()
  await settle()
  expect(
    JSON.stringify(draft.value) === before && document.querySelector('#editor fieldset').disabled,
    'busy layer controls edit draft'
  )
  busy.value = false
  runtime.setActive(false)
  await settle()
  expect(
    document.querySelector('.te-appearance-effects').hidden,
    'hidden preview still displays effects'
  )
  runtime.setActive(true)
  await settle()
  for (let index = 0; index < 100; index++)
    document.querySelector('#extra').append(document.createElement('button'))
  await settle()
  expect(
    document.querySelectorAll('.te-appearance-effect').length <= 80,
    'effect budget is unbounded'
  )
  scope.value = 'inner-panel'
  await settle()
  await input('内框圆角', '22')
  expect(
    getComputedStyle(document.querySelector('.app-shell'))
      .getPropertyValue('--te-window-surface-radius')
      .trim() === '22px',
    'inner radius does not apply'
  )
  runtime.update(normalizeAppearanceLayers(undefined), 'dark')
  await settle()
  expect(
    !document.querySelector('.te-appearance-effects') &&
      target.dataset.teAppearanceBody === 'prior' &&
      getComputedStyle(target).backgroundColor === initial.background,
    'disabling channels does not restore original control'
  )
  runtime.dispose()
  app.unmount()
  expect(!document.querySelector('[data-appearance-layers]'), 'dispose leaves a theme stylesheet')
}
