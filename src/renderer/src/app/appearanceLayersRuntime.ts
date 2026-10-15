import {
  APPEARANCE_LAYER_SCOPES,
  normalizeAppearanceLayers,
  type AppearanceSkinLayer,
  type AppearanceLayersSettings,
  type AppearanceLayerScope,
  type AppearanceLayerTone
} from '../../../shared/appearanceLayers'
import { componentMaterialDefinitions, componentMaterialStyles } from './componentMaterials'
import { readingMaterialTreatment } from '../../../shared/materials'
import { CARD_SURFACE_SELECTOR, STRUCTURAL_CONTROL_SELECTOR } from '../../../shared/cardSurfaces'

// Skins paint as native backgrounds. Only the portion outside the component is
// portaled; its body is cut out so it cannot cover text or native controls.
const selectors: Record<AppearanceLayerScope, string> = {
  'outer-panel': '.app-shell',
  'inner-panel': '.app-shell-content',
  controls:
    'button, input, select, textarea, a[href], [role="button"], [role="slider"], [role="switch"], [data-te-appearance-control]',
  navigation: '.side-menu, .playback-queue-sidebar',
  material: '.title-bar',
  'player-bar': '.player-bar',
  card: CARD_SURFACE_SELECTOR
}
const EFFECT_LIMIT = 80
const SKIN_PROPERTIES = [
  '--te-skin-image',
  '--te-skin-left',
  '--te-skin-top',
  '--te-skin-width',
  '--te-skin-height',
  '--te-skin-body-width',
  '--te-skin-body-height',
  '--te-skin-placement'
] as const
const TRANSPARENT_IMAGE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E'

/** Rebind a native skin's overflow to its own preview plane before 3D transforms. */
export function createAppearanceSkinOverflow(
  element: HTMLElement,
  offset = { left: 0, top: 0 }
): HTMLElement | undefined {
  const style = element.style
  if (
    !element.dataset.teAppearanceSkin ||
    style.getPropertyValue('--te-skin-placement') !== 'outside'
  )
    return
  const number = (name: (typeof SKIN_PROPERTIES)[number]) =>
    parseFloat(style.getPropertyValue(name))
  const left = number('--te-skin-left')
  const top = number('--te-skin-top')
  const width = number('--te-skin-width')
  const height = number('--te-skin-height')
  const bodyWidth = number('--te-skin-body-width')
  const bodyHeight = number('--te-skin-body-height')
  if (![left, top, width, height, bodyWidth, bodyHeight].every(Number.isFinite)) return
  if (width <= 0 || height <= 0 || bodyWidth <= 0 || bodyHeight <= 0) return
  const node = element.ownerDocument.createElement('div')
  node.className = 'te-appearance-skin-overflow'
  node.dataset.appearanceScope = element.dataset.teAppearanceSkin
  node.setAttribute('aria-hidden', 'true')
  node.inert = true
  const holeLeft = -left
  const holeTop = -top
  node.style.cssText = `left:${offset.left + left}px;top:${offset.top + top}px;width:${width}px;height:${height}px;background-image:${style.getPropertyValue('--te-skin-image')};clip-path:path(evenodd,"M0 0H${width}V${height}H0Z M${holeLeft} ${holeTop}H${holeLeft + bodyWidth}V${holeTop + bodyHeight}H${holeLeft}Z");`
  return node
}

export function mountAppearanceLayers(doc: Document) {
  const win = doc.defaultView
  if (!win)
    return {
      update() {
        return undefined
      },
      setActive() {
        return undefined
      },
      dispose() {
        return undefined
      }
    }
  const host = doc.createElement('div')
  host.className = 'te-appearance-effects'
  host.setAttribute('aria-hidden', 'true')
  host.inert = true
  const sheet = doc.createElement('style')
  sheet.dataset.appearanceLayers = ''
  const materialDefs = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  materialDefs.setAttribute('aria-hidden', 'true')
  materialDefs.setAttribute('width', '0')
  materialDefs.setAttribute('height', '0')
  materialDefs.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden'
  let settings: AppearanceLayersSettings = normalizeAppearanceLayers(undefined)
  let tone: AppearanceLayerTone = 'light'
  let active = true
  let disposed = false
  let frame: number | undefined
  let needsScan = true
  let observing = false
  const marked = new Map<HTMLElement, { scope: AppearanceLayerScope; previous: string | null }>()
  const effects = new Map<HTMLElement, HTMLElement>()
  const skins = new Map<
    HTMLElement,
    {
      previous: string | null
      properties: [string, string, string][]
    }
  >()
  const skinEffects = new Map<HTMLElement, HTMLElement>()
  const images = new Map<string, HTMLImageElement>()
  const moving = new Set<HTMLElement>()
  const observer = new win.MutationObserver((records) => {
    if (
      records.every(
        (record) =>
          host.contains(record.target) || record.target === sheet || sheet.contains(record.target)
      )
    )
      return
    needsScan =
      records.some(
        (record) =>
          record.type === 'childList' ||
          record.attributeName === 'class' ||
          record.attributeName === 'data-te-appearance-control'
      ) || needsScan
    schedule()
  })
  const resize = new win.ResizeObserver(() => schedule())
  function clearSkin(element: HTMLElement): void {
    const previous = skins.get(element)
    if (previous) {
      if (previous.previous === null) element.removeAttribute('data-te-appearance-skin')
      else element.setAttribute('data-te-appearance-skin', previous.previous)
      for (const [name, value, priority] of previous.properties) {
        if (value) element.style.setProperty(name, value, priority)
        else element.style.removeProperty(name)
      }
      skins.delete(element)
    }
    skinEffects.get(element)?.remove()
    skinEffects.delete(element)
  }
  function unmark(element: HTMLElement): void {
    const entry = marked.get(element)
    if (!entry) return
    if (element.getAttribute('data-te-appearance-body') === entry.scope) {
      if (entry.previous === null) element.removeAttribute('data-te-appearance-body')
      else element.setAttribute('data-te-appearance-body', entry.previous)
    }
    marked.delete(element)
    moving.delete(element)
    effects.get(element)?.remove()
    effects.delete(element)
    clearSkin(element)
    resize.unobserve(element)
  }
  function scan(): void {
    needsScan = false
    const next = new Map<HTMLElement, AppearanceLayerScope>()
    for (const scope of APPEARANCE_LAYER_SCOPES) {
      const layer = settings.scopes[scope][tone]
      if (
        !layer.body.enabled &&
        !layer.effect.enabled &&
        !(scope !== 'controls' && layer.skin.enabled)
      )
        continue
      for (const element of doc.querySelectorAll<HTMLElement>(selectors[scope])) {
        if (
          host.contains(element) ||
          (scope === 'controls' &&
            (element.matches('.sidebar-bookmark,' + STRUCTURAL_CONTROL_SELECTOR) ||
              element.closest('.title-bar'))) ||
          element.closest('[data-te-appearance-ignore],[data-appearance-layer-scene]') ||
          (scope === 'card' && element.closest('.online-loading-content,.online-skeleton'))
        )
          continue
        // Explicit per-widget declarations take precedence over generic controls.
        const declared = element.dataset.teAppearanceControl
        next.set(element, APPEARANCE_LAYER_SCOPES.find((id) => id === declared) ?? scope)
      }
    }
    for (const element of marked.keys()) if (!next.has(element)) unmark(element)
    for (const [element, scope] of next) {
      const old = marked.get(element)
      if (old && old.scope !== scope) unmark(element)
      if (!marked.has(element)) {
        marked.set(element, { scope, previous: element.getAttribute('data-te-appearance-body') })
        resize.observe(element)
      }
      element.setAttribute('data-te-appearance-body', scope)
    }
  }
  function paintSkin(
    element: HTMLElement,
    scope: AppearanceLayerScope,
    skin: AppearanceSkinLayer,
    bounds: DOMRect,
    portal = true
  ): boolean {
    let image = images.get(skin.image)
    if (!image) {
      image = new win!.Image()
      images.set(skin.image, image)
      image.onload = schedule
      image.onerror = schedule
      image.src = skin.image
    }
    if (!image.complete || !image.naturalWidth || !image.naturalHeight) return false
    const width = element.offsetWidth || bounds.width
    const height = element.offsetHeight || bounds.height
    const uvWidth = 1 - (skin.frame.left + skin.frame.right) / 100
    const uvHeight = 1 - (skin.frame.top + skin.frame.bottom) / 100
    let imageWidth = width / uvWidth
    let imageHeight = height / uvHeight
    if (skin.fit !== 'fill') {
      const fit = (skin.fit === 'contain' ? Math.min : Math.max)(
        width / (image.naturalWidth * uvWidth),
        height / (image.naturalHeight * uvHeight)
      )
      imageWidth = image.naturalWidth * fit
      imageHeight = image.naturalHeight * fit
    }
    imageWidth *= skin.scale / 100
    imageHeight *= skin.scale / 100
    const left = width * (0.5 + skin.x / 100) - imageWidth * (skin.frame.left / 100 + uvWidth / 2)
    const top = height * (0.5 + skin.y / 100) - imageHeight * (skin.frame.top / 100 + uvHeight / 2)
    const url = `url("${skin.image}")`
    const background =
      skin.opacity === 100
        ? url
        : `-webkit-cross-fade(${url},url('${TRANSPARENT_IMAGE}'),${100 - skin.opacity}%)`
    if (!skins.has(element))
      skins.set(element, {
        previous: element.getAttribute('data-te-appearance-skin'),
        properties: SKIN_PROPERTIES.map((name) => [
          name,
          element.style.getPropertyValue(name),
          element.style.getPropertyPriority(name)
        ])
      })
    if (element.dataset.teAppearanceSkin !== scope) element.dataset.teAppearanceSkin = scope
    const values = [
      background,
      `${left}px`,
      `${top}px`,
      `${imageWidth}px`,
      `${imageHeight}px`,
      `${width}px`,
      `${height}px`,
      skin.placement
    ]
    for (let index = 0; index < SKIN_PROPERTIES.length; index++) {
      const name = SKIN_PROPERTIES[index]
      if (element.style.getPropertyValue(name) !== values[index])
        element.style.setProperty(name, values[index])
    }
    if (skin.placement === 'outside' && portal) {
      const next = createAppearanceSkinOverflow(element)
      const previous = skinEffects.get(element)
      if (next) {
        // Convert native coordinates once. The clone helper keeps local coordinates
        // so a preview plane applies its own perspective instead of this projection.
        const scaleX = bounds.width / width
        const scaleY = bounds.height / height
        next.style.left = `${bounds.left + left * scaleX}px`
        next.style.top = `${bounds.top + top * scaleY}px`
        next.style.transformOrigin = '0 0'
        next.style.transform = `scale(${scaleX},${scaleY})`
        if (previous?.style.cssText !== next.style.cssText) {
          previous?.remove()
          host.append(next)
          skinEffects.set(element, next)
        }
      }
    } else {
      skinEffects.get(element)?.remove()
      skinEffects.delete(element)
    }
    return true
  }
  function paint(): void {
    frame = undefined
    if (disposed || !active || doc.hidden) return
    if (needsScan) scan()
    let count = 0
    let skinCount = 0
    const visible = new Set<HTMLElement>()
    const visibleSkins = new Set<HTMLElement>()
    for (const [element, { scope }] of marked) {
      const { effect, skin } = settings.scopes[scope][tone]
      const colorEnabled = effect.enabled && effect.opacity > 0 && count < EFFECT_LIMIT
      const skinEnabled =
        scope !== 'controls' &&
        skin.enabled &&
        !!skin.image &&
        skin.opacity > 0 &&
        skinCount < EFFECT_LIMIT
      if (!colorEnabled && !skinEnabled) continue
      const bounds = element.getBoundingClientRect()
      if (
        !element.isConnected ||
        !bounds.width ||
        !bounds.height ||
        bounds.bottom < 0 ||
        bounds.top > win!.innerHeight ||
        bounds.right < 0 ||
        bounds.left > win!.innerWidth
      )
        continue
      const style = win!.getComputedStyle(element)
      // The native source remains measurable while the editor shows its 3D
      // clone. Keep its background metadata current without a viewport portal.
      const previewSource = element.closest<HTMLElement>('.appearance-preview-scene')
      const hiddenPreviewSource = previewSource?.style.visibility === 'hidden'
      if (hiddenPreviewSource && skinEnabled) {
        if (paintSkin(element, scope, skin, bounds, false)) {
          visibleSkins.add(element)
          skinCount++
        }
        continue
      }
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const x = Math.max(0, Math.min(win!.innerWidth - 1, bounds.left + bounds.width / 2))
      const y = Math.max(0, Math.min(win!.innerHeight - 1, bounds.top + bounds.height / 2))
      const top = doc.elementFromPoint(x, y)
      if (
        !previewSource?.inert &&
        top &&
        top !== element &&
        !element.contains(top) &&
        !(style.pointerEvents === 'none' && top.contains(element))
      )
        continue
      if (skinEnabled && paintSkin(element, scope, skin, bounds)) {
        visibleSkins.add(element)
        skinCount++
      }
      if (!colorEnabled) continue
      let decoration = effects.get(element)
      if (!decoration) {
        decoration = doc.createElement('div')
        decoration.className = 'te-appearance-effect'
        host.append(decoration)
        effects.set(element, decoration)
      }
      decoration.dataset.appearanceScope = scope
      decoration.dataset.effectMotion = effect.motion
      decoration.dataset.effectPlacement = effect.placement
      decoration.dataset.effectKind = 'color'
      decoration.style.cssText = `left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px;border-radius:${style.borderRadius};--te-effect-color:${effect.color};--te-effect-alpha:${effect.opacity}%;--te-effect-spread:${effect.spread}px;--te-effect-blur:${effect.blur}px;`
      visible.add(element)
      count++
    }
    for (const [element, effect] of effects)
      if (!visible.has(element)) {
        effect.remove()
        effects.delete(element)
      }
    for (const element of skins.keys()) if (!visibleSkins.has(element)) clearSkin(element)
    for (const element of moving)
      if (
        !element.isConnected ||
        !element.getAnimations().some((item) => item.playState === 'running')
      )
        moving.delete(element)
    if (moving.size && (effects.size || skins.size)) schedule()
  }
  function motion(event: Event): void {
    const element = event.target
    if (
      !(element instanceof win!.HTMLElement) ||
      host.contains(element) ||
      (!marked.has(element) && ![...marked.keys()].some((control) => element.contains(control)))
    )
      return
    if (
      event instanceof win!.TransitionEvent &&
      !/^(transform|translate|scale|rotate|left|top|right|bottom|width|height|margin|padding)/.test(
        event.propertyName
      )
    )
      return
    moving.add(element)
    schedule()
  }
  function schedule(): void {
    if (frame === undefined && active && !doc.hidden && !disposed)
      frame = win!.requestAnimationFrame(paint)
  }
  function visibility(): void {
    host.hidden = !active || doc.hidden
    if (host.hidden && frame !== undefined) {
      win!.cancelAnimationFrame(frame)
      frame = undefined
    } else schedule()
  }
  function update(raw: unknown, nextTone: AppearanceLayerTone): void {
    const next = normalizeAppearanceLayers(raw)
    const controlMode = next.scopes.controls[nextTone].material.mode
    const cardMode = next.scopes.card[nextTone].material.mode
    const treatment = readingMaterialTreatment(
      controlMode !== 'theme'
        ? controlMode
        : cardMode !== 'theme'
          ? cardMode
          : (doc.documentElement.dataset.teSurfaceMaterial ?? 'standard')
    )
    doc.documentElement.style.setProperty('--te-reading-blur', `${treatment.blur}px`)
    doc.documentElement.style.setProperty('--te-reading-fade', String(treatment.fade))
    if (JSON.stringify(next) === JSON.stringify(settings) && tone === nextTone && sheet.isConnected)
      return
    settings = next
    tone = nextTone
    const handles = new Set(
      APPEARANCE_LAYER_SCOPES.filter((scope) => scope !== 'controls')
        .map((scope) => settings.scopes[scope][tone].skin)
        .filter((skin) => skin.enabled && skin.image && skin.opacity > 0)
        .map((skin) => skin.image)
    )
    for (const [handle, image] of images)
      if (!handles.has(handle)) {
        image.onload = image.onerror = null
        images.delete(handle)
      }
    const rules = APPEARANCE_LAYER_SCOPES.flatMap((scope) => {
      const body = settings.scopes[scope][tone].body
      const skin = settings.scopes[scope][tone].skin
      return [
        ...(body.enabled && settings.scopes[scope][tone].material.mode === 'theme'
          ? [
              `[data-te-appearance-body="${scope}"]{background-color:color-mix(in srgb,${body.color} ${body.opacity}%,transparent)!important;background-image:none!important}`
            ]
          : []),
        ...(scope !== 'controls' && skin.enabled
          ? [
              `[data-te-appearance-skin="${scope}"]{background-image:var(--te-skin-image)!important;background-position:var(--te-skin-left) var(--te-skin-top)!important;background-size:var(--te-skin-width) var(--te-skin-height)!important;background-repeat:no-repeat!important;background-origin:border-box!important;background-clip:border-box!important;border-color:transparent!important;box-shadow:none!important;backdrop-filter:none!important;${body.enabled ? '' : 'background-color:transparent!important;'}}`
            ]
          : [])
      ]
    }).join('\n')
    // Important declarations in a child layer beat its parent's general material
    // defaults. Explicit component backgrounds survive card/transparent shorthands.
    sheet.textContent =
      componentMaterialStyles(settings, tone) +
      `@layer te-appearance.components {${rules}} .app-shell {--te-window-surface-radius:${settings.innerRadius}px} ` +
      (settings.scopes['inner-panel'][tone].body.enabled
        ? '@layer te-appearance {[data-te-appearance-body="inner-panel"] :is(.main-content,.home,.song-list,.streaming-page){background-color:transparent!important;background-image:none!important}}'
        : '') +
      // The outer skin is one continuous image including the caption strip.
      // Keep independently configured title material as an explicit override.
      '@layer te-appearance {[data-te-appearance-skin="material"] > .title-bar-background{background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important}}' +
      (settings.scopes['outer-panel'][tone].skin.enabled &&
      !settings.scopes.material[tone].body.enabled &&
      !settings.scopes.material[tone].skin.enabled
        ? '@layer te-appearance {[data-te-appearance-skin="outer-panel"] > .app-shell-title :is(.title-bar,.title-bar-background){background:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important}}'
        : '')
    if (!sheet.isConnected) doc.head.append(sheet)
    const definitions = componentMaterialDefinitions(settings, tone)
    materialDefs.innerHTML = definitions ? `<defs>${definitions}</defs>` : ''
    if (definitions && !materialDefs.isConnected) doc.body.append(materialDefs)
    else if (!definitions) materialDefs.remove()
    const enabled = APPEARANCE_LAYER_SCOPES.some(
      (scope) =>
        settings.scopes[scope][tone].body.enabled ||
        settings.scopes[scope][tone].effect.enabled ||
        (scope !== 'controls' && settings.scopes[scope][tone].skin.enabled)
    )
    if (enabled) {
      if (!host.isConnected) doc.body.append(host)
      if (!observing) {
        observer.observe(doc.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            'class',
            'style',
            'hidden',
            'open',
            'inert',
            'data-te-appearance-control'
          ]
        })
        doc.addEventListener('scroll', schedule, true)
        doc.addEventListener('visibilitychange', visibility)
        win!.addEventListener('resize', schedule)
        doc.addEventListener('transitionrun', motion, true)
        doc.addEventListener('animationstart', motion, true)
        observing = true
      }
      needsScan = true
      visibility()
    } else {
      observer.disconnect()
      resize.disconnect()
      for (const element of marked.keys()) unmark(element)
      host.remove()
      moving.clear()
      removeListeners()
    }
  }
  function removeListeners(): void {
    doc.removeEventListener('scroll', schedule, true)
    doc.removeEventListener('visibilitychange', visibility)
    win!.removeEventListener('resize', schedule)
    doc.removeEventListener('transitionrun', motion, true)
    doc.removeEventListener('animationstart', motion, true)
    observing = false
  }
  return {
    update,
    setActive(value: boolean) {
      active = value
      visibility()
    },
    dispose() {
      disposed = true
      if (frame !== undefined) win!.cancelAnimationFrame(frame)
      observer.disconnect()
      resize.disconnect()
      removeListeners()
      for (const element of marked.keys()) unmark(element)
      for (const image of images.values()) image.onload = image.onerror = null
      images.clear()
      host.remove()
      sheet.remove()
      materialDefs.remove()
      doc.documentElement.style.removeProperty('--te-reading-blur')
      doc.documentElement.style.removeProperty('--te-reading-fade')
    }
  }
}
