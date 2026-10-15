import {
  sameEditorRect,
  sameEditorSize,
  type EditorNode,
  type EditorPoint,
  type EditorRect,
  type EditorSize
} from './viewportGeometry.ts'
import { measureAppearanceSurfaces } from './appearanceSurfaces.ts'

export const APPEARANCE_LAYER_ORDER = [
  'outer',
  'background',
  'content',
  'navigation',
  'player',
  'title'
] as const
export type AppearanceLayer = (typeof APPEARANCE_LAYER_ORDER)[number]
/** Small pointer offsets from the separately adjustable base rotation. */
export type AppearanceLayerTilt = { x: number; y: number }
export const APPEARANCE_LAYER_TILT_LIMITS = { x: 4, y: 6 } as const
export type AppearanceLayerAngles = { x: number; y: number }
export const APPEARANCE_LAYER_DEFAULT_ANGLES = { x: 0, y: 0 } as const
export const APPEARANCE_LAYER_ANGLE_LIMITS = { x: 30, y: 60 } as const
/** Clear foreground controls while retaining the native wallpaper and decoration. */
export function appearanceBackgroundForegroundCss(scene: string): string {
  const targets = (root: string) => [
    `${root} :is(.title-bar,.side-menu,.player-bar-shell,.sidebar-bookmark)`,
    `${root} .main-content > * > :not(.ambient,.workshop-decoration,.streaming-content)`,
    `${root} .main-content > .streaming-page > .streaming-content > :not(.workshop-decoration)`
  ]
  const normal = targets(scene).join(',')
  const focused = targets(
    `${scene}:is([data-preview-focus="background"],[data-preview-focus="inner-panel"])`
  ).join(',')
  const reduced = ['off', 'reduced']
    .flatMap((mode) => targets(`html[data-te-motion="${mode}"] ${scene}`))
    .join(',')
  const systemReduced = targets(`html:not([data-te-motion="full"]) ${scene}`).join(',')
  return `${normal}{transition:opacity var(--te-motion-panel,220ms) ease,translate var(--te-motion-panel,220ms) ease!important}${focused}{opacity:0!important;translate:0 -32px!important;pointer-events:none!important}${reduced}{transition:none!important}@media(prefers-reduced-motion:reduce){${systemReduced}{transition:none!important}}`
}
export type AppearanceLayerPose = {
  tilt?: AppearanceLayerTilt
  angles?: AppearanceLayerAngles
  spacing?: number
}
export type AppearanceLayerPolygon = {
  id: string
  points: [EditorPoint, EditorPoint, EditorPoint, EditorPoint]
}
export type AppearanceLayerProjection = {
  nodes: AppearanceLayerNode[]
  polygons: AppearanceLayerPolygon[]
  layerCount: number
  fit: { x: number; y: number; scale: number }
}
export type AppearanceLayerNode = EditorNode & { pose?: string }
export type AppearanceLayerInput = {
  scene: HTMLElement
  size: EditorSize
  nodes: readonly AppearanceLayerNode[]
  spacing?: number
  tilt?: AppearanceLayerTilt
  angles?: AppearanceLayerAngles
  selected?: string
  /** Change when appearance or static DOM changes without changing its measured bounds. */
  revision?: unknown
  /** Runtime owns image/UV interpretation; this adapter only attaches native paint to its plane. */
  skinOverflow?: (
    element: HTMLElement,
    offset: { left: number; top: number }
  ) => HTMLElement | undefined
}

const selectors: Record<AppearanceLayer, string> = {
  outer: '.app-shell',
  background: '.appearance-window-background',
  content: '.app-shell-content',
  navigation: '.app-shell-navigation',
  player: '.app-shell-player',
  title: '.app-shell-title'
}
const pinnedSelectors: Partial<Record<AppearanceLayer, string>> = {
  navigation: '.side-menu',
  player: '.player-bar-shell',
  title: '.title-bar'
}
const radians = Math.PI / 180

export function normalizeAppearanceLayerTilt(tilt?: AppearanceLayerTilt): AppearanceLayerTilt {
  const clamp = (value: number | undefined, limit: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(-limit, Math.min(limit, value))
      : 0
  return {
    x: clamp(tilt?.x, APPEARANCE_LAYER_TILT_LIMITS.x),
    y: clamp(tilt?.y, APPEARANCE_LAYER_TILT_LIMITS.y)
  }
}
export function normalizeAppearanceLayerAngles(
  angles?: AppearanceLayerAngles
): AppearanceLayerAngles {
  const clamp = (value: number | undefined, limit: number, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(-limit, Math.min(limit, value))
      : fallback
  return {
    x: clamp(angles?.x, APPEARANCE_LAYER_ANGLE_LIMITS.x, APPEARANCE_LAYER_DEFAULT_ANGLES.x),
    y: clamp(angles?.y, APPEARANCE_LAYER_ANGLE_LIMITS.y, APPEARANCE_LAYER_DEFAULT_ANGLES.y)
  }
}
function composedAngles(tilt: AppearanceLayerTilt, angles: AppearanceLayerAngles) {
  return normalizeAppearanceLayerAngles({ x: angles.x + tilt.x, y: angles.y + tilt.y })
}
function rotationFor(tilt: AppearanceLayerTilt, angles: AppearanceLayerAngles): string {
  const rotation = composedAngles(tilt, angles)
  return `perspective(2400px) rotateX(${rotation.x}deg) rotateY(${rotation.y}deg)`
}
/** Shared by the native sheets and their lightweight CSS hit regions. */
export function appearanceLayerRotation(
  tilt?: AppearanceLayerTilt,
  angles?: AppearanceLayerAngles
): string {
  return rotationFor(normalizeAppearanceLayerTilt(tilt), normalizeAppearanceLayerAngles(angles))
}

function layerFor(id?: string): AppearanceLayer | undefined {
  if (id === 'outer-panel') return 'outer'
  if (id === 'background') return 'background'
  if (id === 'navigation') return 'navigation'
  if (id === 'material' || id === 'title') return 'title'
  if (id === 'player-bar' || id === 'player') return 'player'
  if (id === 'card' || id === 'content' || id === 'inner-panel' || id === 'controls')
    return 'content'
  return undefined
}
function spacingFor(value = 56): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(80, value)) : 56
}
function layerOffset(layer: AppearanceLayer, spacing: number) {
  // The base recedes while the native controls float above it. Keep this in
  // local coordinates so CSS and the projected hit regions share one pose.
  // Side navigation is attached to the title strip, not an intermediate card.
  // Keep its public layer identity while sharing chrome depth and hit geometry.
  const depth = layer === 'navigation' ? 'title' : layer
  return {
    y: (layer === 'outer' || layer === 'background' ? 0.15 : -0.3) * spacing,
    z: APPEARANCE_LAYER_ORDER.indexOf(depth) * spacing
  }
}
function layerTransform(layer: AppearanceLayer, spacing: number): string {
  const offset = layerOffset(layer, spacing)
  return `translate3d(0, ${offset.y}px, ${offset.z}px)`
}
export function appearanceLayerTransform(layer: AppearanceLayer, spacing: number): string {
  return layerTransform(layer, spacingFor(spacing))
}
function partOffset(id: string, spacing: number) {
  if (id === 'chrome-controls') return { y: -0.4 * spacing, z: 5.18 * spacing }
  if (id === 'player-controls') return { y: -0.4 * spacing, z: 4.18 * spacing }
  if (id === 'card') return { y: -0.55 * spacing, z: 2.5 * spacing }
  if (id === 'controls') return { y: -0.7 * spacing, z: 2.85 * spacing }
  return layerOffset(layerFor(id) ?? 'content', spacing)
}
export function appearancePartTransform(id: string, spacing: number): string {
  const offset = partOffset(id, spacingFor(spacing))
  return `translate3d(0, ${offset.y}px, ${offset.z}px)`
}
function corners(rect: EditorRect): AppearanceLayerPolygon['points'] {
  return [
    { x: rect.left, y: rect.top },
    { x: rect.left + rect.width, y: rect.top },
    { x: rect.left + rect.width, y: rect.top + rect.height },
    { x: rect.left, y: rect.top + rect.height }
  ]
}
function bounds(points: readonly EditorPoint[]): EditorRect {
  const left = Math.min(...points.map((point) => point.x))
  const top = Math.min(...points.map((point) => point.y))
  return {
    left,
    top,
    width: Math.max(...points.map((point) => point.x)) - left,
    height: Math.max(...points.map((point) => point.y)) - top
  }
}
function validSize(size: EditorSize): boolean {
  return (
    Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
  )
}
function emptyProjection(): AppearanceLayerProjection {
  return { nodes: [], polygons: [], layerCount: 0, fit: { x: 0, y: 0, scale: 1 } }
}

/** CSS applies the layer offset, Y rotation, X rotation, then perspective. */
export function projectAppearanceLayers(
  size: EditorSize,
  nodes: readonly AppearanceLayerNode[],
  spacing = 56,
  tilt?: AppearanceLayerTilt,
  angles?: AppearanceLayerAngles
): AppearanceLayerProjection {
  if (!validSize(size)) return emptyProjection()
  const distance = spacingFor(spacing)
  const rotation = composedAngles(
    normalizeAppearanceLayerTilt(tilt),
    normalizeAppearanceLayerAngles(angles)
  )
  const sinX = Math.sin(rotation.x * radians),
    cosX = Math.cos(rotation.x * radians),
    sinY = Math.sin(rotation.y * radians),
    cosY = Math.cos(rotation.y * radians)
  const center = { x: size.width / 2, y: size.height / 2 }
  function project(point: EditorPoint, layer: AppearanceLayer, id?: string): EditorPoint {
    const { y: lift, z: depth } = id ? partOffset(id, distance) : layerOffset(layer, distance)
    const x = point.x - center.x,
      y = point.y - center.y + lift
    const rotatedX = cosY * x + sinY * depth
    const rotatedZ = -sinY * x + cosY * depth
    const finalY = cosX * y - sinX * rotatedZ
    const finalZ = sinX * y + cosX * rotatedZ
    const perspective = 1 / (1 - finalZ / 2400)
    return {
      x: center.x + rotatedX * perspective,
      y: center.y + finalY * perspective
    }
  }
  const viewportCorners = corners({ left: 0, top: 0, ...size })
  const extent = bounds([
    ...APPEARANCE_LAYER_ORDER.flatMap((layer) => {
      // Chrome paints only its actual native bounds. A thin title bar must not
      // contribute an imaginary full-window plane to the contain calculation.
      const rect = nodes.find((node) => layerFor(node.id) === layer)?.rect
      const points =
        layer === 'outer' || layer === 'background' || layer === 'content'
          ? viewportCorners
          : rect && rect.width > 0 && rect.height > 0
            ? corners(rect)
            : []
      return points.map((point) => project(point, layer))
    }),
    ...nodes
      .filter((node) => node.id === 'card' || node.id === 'controls')
      .flatMap((node) =>
        corners(node.rect).map((point) => project(point, 'content', node.pose ?? node.id))
      )
  ])
  const scale = Math.min(size.width / extent.width, size.height / extent.height)
  const fit = {
    x: (size.width - extent.width * scale) / 2 - extent.left * scale,
    y: (size.height - extent.height * scale) / 2 - extent.top * scale,
    scale
  }
  const polygons = nodes.map((node): AppearanceLayerPolygon => {
    const layer = layerFor(node.id) ?? 'content'
    const points = corners(node.rect).map((point) => {
      const projected = project(point, layer, node.pose ?? node.id)
      return { x: fit.x + projected.x * scale, y: fit.y + projected.y * scale }
    }) as AppearanceLayerPolygon['points']
    return { id: node.id, points }
  })
  return {
    nodes: nodes.map((node, index) => ({ ...node, rect: bounds(polygons[index].points) })),
    polygons,
    layerCount: APPEARANCE_LAYER_ORDER.length,
    fit
  }
}

function setStyles(element: HTMLElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values))
    if (
      element.style.getPropertyValue(name) !== value ||
      element.style.getPropertyPriority(name) !== 'important'
    )
      element.style.setProperty(name, value, 'important')
}
function pinRect(element: HTMLElement, rect: EditorRect): void {
  setStyles(element, {
    position: 'absolute',
    inset: 'auto',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    'min-width': '0',
    'min-height': '0',
    'max-width': 'none',
    'max-height': 'none',
    margin: '0',
    'box-sizing': 'border-box'
  })
}
let cloneSequence = 0
function prepareClone(clone: HTMLElement): void {
  const elements = [clone, ...clone.querySelectorAll<Element>('*')]
  const ids = new Map<string, string>()
  const prefix = `appearance-layer-${++cloneSequence}-`
  for (const element of elements) {
    const id = element.getAttribute('id')
    if (id) ids.set(id, `${prefix}${ids.size}`)
  }
  function localUrls(value: string): string {
    return value.replace(/url\(\s*(['"]?)#([^'"\s)]+)\1\s*\)/g, (match, _quote, id: string) =>
      ids.has(id) ? `url(#${ids.get(id)})` : match
    )
  }
  for (const element of elements) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name)
      else if (attribute.name === 'id') {
        if (ids.has(attribute.value)) element.setAttribute('id', ids.get(attribute.value)!)
        else element.removeAttribute('id')
      } else {
        let value = localUrls(attribute.value)
        if ((attribute.name === 'href' || attribute.name === 'xlink:href') && value.startsWith('#'))
          value = ids.has(value.slice(1)) ? `#${ids.get(value.slice(1))}` : value
        if (/^(?:aria-(?:labelledby|describedby|controls|owns|details)|for)$/.test(attribute.name))
          value = value
            .split(/\s+/)
            .map((id) => ids.get(id) ?? id)
            .join(' ')
        if (value !== attribute.value) element.setAttribute(attribute.name, value)
      }
    }
    if (element.tagName === 'STYLE') element.textContent = localUrls(element.textContent ?? '')
    if (element.tagName === 'VIDEO' || element.tagName === 'AUDIO') {
      element.removeAttribute('autoplay')
      element.removeAttribute('src')
    }
  }
  for (const executable of clone.querySelectorAll(
    'script,iframe,object,embed,animate,animateMotion,animateTransform,set'
  ))
    executable.remove()
  clone.setAttribute('inert', '')
  clone.setAttribute('aria-hidden', 'true')
}

function materialStyle(
  document: Document,
  layer: AppearanceLayer,
  control: HTMLElement
): CSSStyleDeclaration | undefined {
  const computed = document.defaultView?.getComputedStyle.bind(document.defaultView)
  if (!computed) return undefined
  const surfaces: [Element, string?][] =
    layer === 'navigation'
      ? [[control, '::before'], [control]]
      : layer === 'title'
        ? [[control.querySelector('.title-bar-background') ?? control], [control]]
        : [
            [control.querySelector('.player-bar-warp') ?? control],
            [control.querySelector('.player-bar') ?? control],
            [control]
          ]
  for (const [surface, pseudo] of surfaces) {
    const style = computed(surface, pseudo)
    const backdrop =
      style.getPropertyValue('backdrop-filter') || style.getPropertyValue('-webkit-backdrop-filter')
    if (backdrop && backdrop !== 'none') return style
  }
  return undefined
}

function createAppTintSheet(
  document: Document,
  source: HTMLElement,
  size: EditorSize,
  pseudo: '::before' | '::after' = '::before'
): HTMLElement | undefined {
  const native = document.defaultView?.getComputedStyle(source, pseudo)
  if (!native || native.display === 'none' || !native.content || native.content === 'none')
    return undefined
  const sheet = document.createElement('div')
  const edge = pseudo === '::after'
  if (edge) sheet.dataset.appearanceAppEdge = ''
  else sheet.dataset.appearanceAppTint = ''
  sheet.setAttribute('inert', '')
  sheet.setAttribute('aria-hidden', 'true')
  pinRect(sheet, { left: 0, top: 0, ...size })
  setStyles(sheet, {
    'z-index': String(APPEARANCE_LAYER_ORDER.indexOf(edge ? 'content' : 'background')),
    // The native window clips its foundation wash and inset shadows at its edge.
    overflow: 'hidden',
    'transform-style': 'flat',
    'pointer-events': 'none'
  })
  const painter = document.createElement('div')
  const paint: Record<string, string> = { position: 'absolute', 'pointer-events': 'none' }
  for (const property of [
    'top',
    'right',
    'bottom',
    'left',
    'width',
    'height',
    'box-sizing',
    'margin',
    'opacity',
    'background',
    'border',
    'border-radius',
    'box-shadow',
    'filter',
    'backdrop-filter',
    'mix-blend-mode',
    'clip-path',
    'mask',
    'transform',
    'transform-origin'
  ]) {
    const value = native.getPropertyValue(property)
    if (value) paint[property] = value
  }
  setStyles(painter, paint)
  sheet.append(painter)
  return sheet
}

function addMaterialContext(
  document: Document,
  group: HTMLElement,
  plane: HTMLElement,
  control: HTMLElement,
  rect: EditorRect,
  planeRect: EditorRect,
  controlRect: EditorRect,
  size: EditorSize,
  material: CSSStyleDeclaration,
  templates: HTMLElement[],
  clippedPaint: readonly SamplingArtwork[],
  excludedSurface?: string
): HTMLElement | undefined {
  if (!(rect.width > 0 && rect.height > 0) || !templates.length) return
  const crop = document.createElement('div')
  crop.dataset.appearanceMaterialContext = ''
  crop.setAttribute('inert', '')
  crop.setAttribute('aria-hidden', 'true')
  const inside = control.classList.contains('title-bar')
  pinRect(crop, {
    ...rect,
    left: rect.left - (inside ? controlRect.left : planeRect.left),
    top: rect.top - (inside ? controlRect.top : planeRect.top)
  })
  setStyles(crop, {
    overflow: 'hidden',
    'border-radius': material.borderRadius || '0',
    'clip-path': material.clipPath || 'none',
    'pointer-events': 'none',
    'z-index': '-1'
  })
  const context = document.createElement('div')
  // Retain the native App selectors and privacy masks in a flat sampling
  // context. These are copies of the already prepared display, never a mount.
  for (const attribute of [...group.attributes])
    if (attribute.name !== 'style' && attribute.name !== 'data-appearance-layer-scene')
      context.setAttribute(attribute.name, attribute.value)
  context.dataset.appearanceMaterialScene = ''
  const bleed = materialSamplingBleed(document, material)
  const sample =
    bleed === undefined
      ? { left: 0, top: 0, ...size }
      : {
          left: rect.left - bleed,
          top: rect.top - bleed,
          width: rect.width + bleed * 2,
          height: rect.height + bleed * 2
        }
  pinRect(context, {
    left: sample.left - rect.left,
    top: sample.top - rect.top,
    width: sample.width,
    height: sample.height
  })
  setStyles(context, {
    display: 'block',
    overflow: bleed === undefined ? 'visible' : 'hidden',
    visibility: 'visible',
    opacity: '1',
    isolation: 'isolate',
    contain: 'none',
    background: 'transparent',
    'box-shadow': 'none',
    filter: 'none',
    'backdrop-filter': 'none',
    // Native fixed descendants must sample inside this crop, not paint at the
    // iframe viewport once for every material surface.
    transform: 'translateZ(0)',
    'transform-style': 'flat'
  })
  for (const template of templates) {
    const copy = template.cloneNode(true) as HTMLElement
    setStyles(copy, {
      left: `${parseFloat(template.style.left) - sample.left}px`,
      top: `${parseFloat(template.style.top) - sample.top}px`,
      transform: 'none',
      opacity: '1'
    })
    context.append(copy)
  }
  if (excludedSurface)
    for (const self of context.querySelectorAll<HTMLElement>(
      `[data-appearance-surface-key="${excludedSurface}"]`
    ))
      setStyles(self, { visibility: 'hidden' })
  // The native artwork is clipped before its blur reaches the material. An
  // unrelated title/player sampling strip must not render the entire cover.
  context.dataset.appearanceSamplingBleed = bleed === undefined ? 'complete' : String(bleed)
  for (const [index, painter] of [
    ...context.querySelectorAll<HTMLElement>('.feature-backdrop')
  ].entries()) {
    const artwork = clippedPaint[index]
    const bounds = artwork?.rect
    if (
      bleed !== undefined &&
      artwork?.cullable &&
      bounds &&
      (bounds.left + bounds.width <= sample.left ||
        sample.left + sample.width <= bounds.left ||
        bounds.top + bounds.height <= sample.top ||
        sample.top + sample.height <= bounds.top)
    ) {
      painter.dataset.appearanceSamplingCulled = ''
      setStyles(painter, { display: 'none' })
    } else if (bleed !== undefined && artwork?.image) {
      cropSamplingArtwork(document, painter, artwork, sample)
    }
  }
  for (const element of context.querySelectorAll<HTMLElement>('*'))
    for (const attribute of ['data-appearance-layer', 'data-preview-module'])
      element.removeAttribute(attribute)
  prepareClone(context)
  crop.append(context)
  // The real title host clips and isolates its painter. Its sampling backdrop
  // must be inside that host, below the painter and above no native control.
  if (inside) control.prepend(crop)
  else plane.insertBefore(crop, control)
  return crop
}

type SamplingArtwork = {
  rect: EditorRect
  cullable?: boolean
  image?: {
    rect: EditorRect
    filter: string
    opacity: string
    bleed: number
    objectFit: string
    objectPosition: string
  }
}
function cropSamplingArtwork(
  document: Document,
  painter: HTMLElement,
  artwork: SamplingArtwork,
  sample: EditorRect
): void {
  const image = painter.querySelector<HTMLImageElement>('img')
  const native = artwork.image
  if (!image || !native) return
  const left = Math.max(sample.left, artwork.rect.left) - native.bleed
  const top = Math.max(sample.top, artwork.rect.top) - native.bleed
  const right =
    Math.min(sample.left + sample.width, artwork.rect.left + artwork.rect.width) + native.bleed
  const bottom =
    Math.min(sample.top + sample.height, artwork.rect.top + artwork.rect.height) + native.bleed
  // Filter the same native pixels, with enough original blur input beyond the
  // glass sample. The full image keeps its object-fit geometry inside this ROI.
  const crop = document.createElement('div')
  crop.dataset.appearanceSamplingArtwork = ''
  pinRect(crop, {
    left: left - artwork.rect.left,
    top: top - artwork.rect.top,
    width: right - left,
    height: bottom - top
  })
  setStyles(crop, {
    overflow: 'hidden',
    filter: native.filter,
    opacity: native.opacity,
    transform: 'translateZ(0)',
    'pointer-events': 'none'
  })
  pinRect(image, { ...native.rect, left: native.rect.left - left, top: native.rect.top - top })
  setStyles(image, {
    filter: 'none',
    opacity: '1',
    transform: 'none',
    'object-fit': native.objectFit,
    'object-position': native.objectPosition
  })
  image.replaceWith(crop)
  crop.append(image)
}

function readSamplingArtwork(document: Document, painter: HTMLElement): SamplingArtwork {
  const rect = painter.getBoundingClientRect()
  const result: SamplingArtwork = {
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }
  const computed = document.defaultView?.getComputedStyle.bind(document.defaultView)
  const image = painter.querySelector<HTMLImageElement>('img')
  if (!computed || !image) return result
  const clipping = computed(painter)
  const style = computed(image)
  // Future custom optics or transformed artwork keep their complete native
  // filter input. Only the current clipped, linear CSS cover bloom is cropped.
  const supported =
    /^(?:(?:blur|brightness|saturate|contrast|grayscale|hue-rotate|invert|opacity|sepia)\([^()]+\)\s*)+$/.test(
      style.filter
    )
  const identity = (css: CSSStyleDeclaration) =>
    (css.transform === 'none' ||
      css.transform === 'matrix(1, 0, 0, 1, 0, 0)' ||
      css.transform === 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)') &&
    (!css.scale || css.scale === 'none' || css.scale === '1') &&
    (!css.rotate || css.rotate === 'none') &&
    (!css.translate || css.translate === 'none') &&
    (!css.zoom || Number(css.zoom) === 1)
  let current: HTMLElement | null = painter
  while (current) {
    const ancestor = computed(current)
    if (
      !identity(ancestor) ||
      (current !== painter && (ancestor.filter !== 'none' || ancestor.backdropFilter !== 'none'))
    )
      return result
    current = current.parentElement
  }
  result.cullable =
    ['hidden', 'clip'].includes(clipping.overflowX) &&
    ['hidden', 'clip'].includes(clipping.overflowY) &&
    clipping.filter === 'none' &&
    clipping.boxShadow === 'none' &&
    clipping.backdropFilter === 'none'
  if (
    !supported ||
    !identity(style) ||
    style.boxShadow !== 'none' ||
    style.maskImage !== 'none' ||
    style.clipPath !== 'none' ||
    style.mixBlendMode !== 'normal' ||
    style.backgroundImage !== 'none' ||
    style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
    ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) =>
        parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 ||
        parseFloat(style.getPropertyValue(`padding-${side.toLowerCase()}`)) > 0
    ) ||
    ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].some(
      (corner) =>
        parseFloat(style[`border${corner}Radius` as keyof CSSStyleDeclaration] as string) > 0
    ) ||
    !result.cullable ||
    !['hidden', 'clip'].includes(clipping.overflowX) ||
    !['hidden', 'clip'].includes(clipping.overflowY)
  )
    return result
  const imageRect = image.getBoundingClientRect()
  result.image = {
    rect: {
      left: imageRect.left,
      top: imageRect.top,
      width: imageRect.width,
      height: imageRect.height
    },
    filter: style.filter,
    opacity: style.opacity,
    objectFit: style.objectFit,
    objectPosition: style.objectPosition,
    bleed: Math.ceil(
      [...style.filter.matchAll(/blur\(([\d.]+)px\)/g)].reduce(
        (sum, match) => sum + Number(match[1]) * 3,
        0
      )
    )
  }
  return result
}

function materialSamplingBleed(
  document: Document,
  material: CSSStyleDeclaration
): number | undefined {
  const filters = `${material.backdropFilter} ${material.filter}`
  if (
    filters
      .replace(
        /url\([^)]+\)|(?:blur|brightness|saturate|contrast|grayscale|hue-rotate|invert|opacity|sepia)\([^()]+\)|none/g,
        ''
      )
      .trim()
  )
    return undefined
  let bleed = [...filters.matchAll(/blur\(([\d.]+)px\)/g)].reduce(
    (sum, match) => sum + Number(match[1]) * 3,
    0
  )
  for (const match of filters.matchAll(/url\(["']?(?:[^)#]*#)?([^"')]+)["']?\)/g)) {
    const filter = document.getElementById(match[1])
    // Unknown custom optics can sample anywhere; keep its complete input.
    if (!filter || filter.getAttribute('primitiveUnits') === 'objectBoundingBox') return undefined
    const known = new Set([
      'feImage',
      'feDisplacementMap',
      'feColorMatrix',
      'feBlend',
      'feGaussianBlur'
    ])
    if (
      [...filter.children].some(
        (node) => !known.has(node.tagName) || node.hasAttribute('primitiveUnits')
      )
    )
      return undefined
    const maps = [...filter.querySelectorAll('feDisplacementMap')]
    if (
      maps.some(
        (node) =>
          node.getAttribute('in') !== 'SourceGraphic' ||
          !Number.isFinite(Number(node.getAttribute('scale') ?? 0))
      )
    )
      return undefined
    const displacement = maps.map((node) => Math.abs(Number(node.getAttribute('scale')) || 0))
    bleed += Math.max(0, ...displacement) / 2
    for (const node of filter.querySelectorAll('feGaussianBlur')) {
      const deviation = (node.getAttribute('stdDeviation') ?? '').trim().split(/\s+/).map(Number)
      if (!deviation.every((value) => Number.isFinite(value) && value >= 0)) return undefined
      bleed += Math.max(0, ...deviation) * 3
    }
  }
  return Math.ceil(bleed)
}

/** Static display adapter. Call sync for model changes, never from camera frames. */
export function createAppearanceLayerView(document: Document) {
  let element: HTMLElement | null = null
  let group: HTMLElement | null = null
  let fitElement: HTMLElement | null = null
  let style: HTMLStyleElement | null = null
  let source: HTMLElement | undefined
  let size: EditorSize | undefined
  let entries: AppearanceLayerNode[] = []
  let spacing = 56
  let tilt: AppearanceLayerTilt = { x: 0, y: 0 }
  let angles: AppearanceLayerAngles = { ...APPEARANCE_LAYER_DEFAULT_ANGLES }
  let revision: unknown
  let skinOverflow: AppearanceLayerInput['skinOverflow']
  let disposed = false
  const layers = new Map<AppearanceLayer, HTMLElement>()
  const skinPlanes = new Map<AppearanceLayer, HTMLElement>()
  const detailPlanes: { id: string; plane: HTMLElement }[] = []
  let backgroundDecorations: HTMLElement[] = []
  let appTint: HTMLElement | undefined
  let appEdge: HTMLElement | undefined
  function clear(): void {
    element?.remove()
    style?.remove()
    document.removeEventListener('visibilitychange', visibilityChanged)
    element = group = fitElement = style = null
    source = size = undefined
    entries = []
    spacing = 56
    tilt = { x: 0, y: 0 }
    angles = { ...APPEARANCE_LAYER_DEFAULT_ANGLES }
    revision = undefined
    skinOverflow = undefined
    layers.clear()
    skinPlanes.clear()
    detailPlanes.length = 0
    backgroundDecorations = []
    appTint = undefined
    appEdge = undefined
  }
  function visibilityChanged(): void {
    if (document.hidden) clear()
  }
  function setPose(value: AppearanceLayerPose): AppearanceLayerProjection {
    if (disposed || document.hidden || !size || !group || !fitElement) return emptyProjection()
    if (value.tilt) tilt = normalizeAppearanceLayerTilt(value.tilt)
    if (value.angles) angles = normalizeAppearanceLayerAngles(value.angles)
    const distance = value.spacing === undefined ? spacing : spacingFor(value.spacing)
    if (distance !== spacing) {
      spacing = distance
      for (const [name, plane] of layers)
        setStyles(plane, {
          transform: layerTransform(name, spacing)
        })
      for (const [name, plane] of skinPlanes)
        setStyles(plane, { transform: layerTransform(name, spacing) })
      for (const decoration of backgroundDecorations)
        setStyles(decoration, { transform: layerTransform('background', spacing) })
      if (appTint) setStyles(appTint, { transform: layerTransform('background', spacing) })
      if (appEdge) setStyles(appEdge, { transform: layerTransform('content', spacing) })
      for (const { id, plane } of detailPlanes)
        setStyles(plane, { transform: appearancePartTransform(id, spacing) })
    }
    const projection = projectAppearanceLayers(size, entries, spacing, tilt, angles)
    // Pointer and transition frames share the existing native clone and cached geometry.
    setStyles(group, { transform: rotationFor(tilt, angles) })
    setStyles(fitElement, {
      transform: `translate(${projection.fit.x}px, ${projection.fit.y}px) scale(${projection.fit.scale})`
    })
    return { ...projection, layerCount: layers.size }
  }
  return {
    get element(): HTMLElement | null {
      return element
    },
    setPose,
    setTilt: (value: AppearanceLayerTilt) => setPose({ tilt: value }),
    sync(input: AppearanceLayerInput): AppearanceLayerProjection {
      if (disposed || document.hidden || !validSize(input.size)) {
        clear()
        return emptyProjection()
      }
      if (input.scene.ownerDocument !== document)
        throw new Error('Layer scene and display must share the preview document')
      const nextTilt = normalizeAppearanceLayerTilt(input.tilt ?? tilt)
      const nextAngles = normalizeAppearanceLayerAngles(input.angles ?? angles)
      const nextSpacing = input.spacing === undefined ? spacing : spacingFor(input.spacing)
      const rebuild =
        source !== input.scene ||
        !size ||
        !sameEditorSize(size, input.size) ||
        revision !== input.revision ||
        skinOverflow !== input.skinOverflow ||
        entries.length !== input.nodes.length ||
        entries.some((node, index) => {
          const next = input.nodes[index]
          return (
            node.id !== next.id ||
            node.focus !== next.focus ||
            node.maxScale !== next.maxScale ||
            node.pose !== next.pose ||
            !sameEditorRect(node.rect, next.rect)
          )
        })
      if (rebuild) {
        clear()
        source = input.scene
        size = { ...input.size }
        entries = input.nodes.map((node) => ({ ...node, rect: { ...node.rect } }))
        revision = input.revision
        skinOverflow = input.skinOverflow
        element = document.createElement('div')
        element.className = 'appearance-layer-view'
        element.setAttribute('inert', '')
        element.setAttribute('aria-hidden', 'true')
        pinRect(element, { left: 0, top: 0, ...size })
        setStyles(element, { overflow: 'visible', 'pointer-events': 'none', visibility: 'visible' })
        fitElement = document.createElement('div')
        setStyles(fitElement, { position: 'absolute', inset: '0', 'transform-origin': '0 0' })
        group = source.cloneNode(true) as HTMLElement
        const detailSurfaces = measureAppearanceSurfaces(source, size)
        const liveElements = [source, ...source.querySelectorAll<HTMLElement>('*')]
        const copiedElements = [group, ...group.querySelectorAll<HTMLElement>('*')]
        const copies = new Map(liveElements.map((live, index) => [live, copiedElements[index]]))
        // Pair before sanitization removes executable SVG/HTML descendants;
        // removals must never shift the source-to-display correspondence.
        prepareClone(group)
        const detailRects = new Map<HTMLElement, EditorRect>(
          detailSurfaces.map((surface) => [surface.element, surface.rect])
        )
        for (const [index, surface] of detailSurfaces.entries())
          copies.get(surface.element)?.setAttribute('data-appearance-surface-key', String(index))
        // Keep root markers for native descendant rules (including title paint).
        // The important transparent background below prevents this rotation
        // group from duplicating the real shell skin on its separate sheet.
        group.dataset.appearanceLayerScene = ''
        backgroundDecorations = [...group.children].filter((child) =>
          child.classList.contains('workshop-decoration')
        ) as HTMLElement[]
        appTint = createAppTintSheet(document, source, size)
        appEdge = createAppTintSheet(document, source, size, '::after')
        pinRect(group, { left: 0, top: 0, ...size })
        setStyles(group, {
          display: 'block',
          overflow: 'visible',
          visibility: 'visible',
          opacity: '1',
          isolation: 'auto',
          contain: 'none',
          filter: 'none',
          'backdrop-filter': 'none',
          'mix-blend-mode': 'normal',
          'clip-path': 'none',
          mask: 'none',
          background: 'transparent',
          'box-shadow': 'none',
          'transform-style': 'preserve-3d',
          'transform-origin': '50% 50% 0',
          transform: rotationFor(nextTilt, nextAngles)
        })
        const materials: {
          plane: HTMLElement
          control: HTMLElement
          rect: EditorRect
          planeRect: EditorRect
          controlRect: EditorRect
          style: CSSStyleDeclaration
        }[] = []
        const skinBindings: {
          name: AppearanceLayer
          live: HTMLElement
          plane: HTMLElement
          rect: EditorRect
        }[] = []
        for (const name of APPEARANCE_LAYER_ORDER) {
          const live =
            name === 'outer' ? source : source.querySelector<HTMLElement>(selectors[name])
          const plane =
            name === 'outer'
              ? document.createElement(source.tagName)
              : group.querySelector<HTMLElement>(selectors[name])
          if (!live || !plane) continue
          if (name === 'outer') {
            // Only the shell's own paint belongs here, without a second copy
            // of its descendants or any change to their native selectors.
            for (const attribute of source.attributes)
              plane.setAttribute(attribute.name, attribute.value)
            plane.dataset.appearanceOuterSurface = ''
            prepareClone(plane)
          }
          const rect =
            name === 'content' ? live.getBoundingClientRect() : { left: 0, top: 0, ...size }
          pinRect(plane, rect)
          plane.dataset.appearanceLayer = name
          setStyles(plane, {
            'z-index': String(APPEARANCE_LAYER_ORDER.indexOf(name)),
            // Each native module is one painted sheet. Its children must not
            // interleave with a different sheet when the assembly is coplanar.
            isolation: 'isolate',
            'transform-style': 'flat'
          })
          if (name === 'outer') {
            setStyles(plane, {
              overflow: 'visible',
              contain: 'none',
              visibility: 'visible',
              opacity: '1'
            })
          } else if (name !== 'content' && name !== 'background') {
            setStyles(plane, { overflow: 'visible' })
            const selector = pinnedSelectors[name]!
            const control = plane.querySelector<HTMLElement>(selector)
            const liveControl = live.querySelector<HTMLElement>(selector)
            if (control && liveControl) {
              const controlRect = liveControl.getBoundingClientRect()
              // Native fixed descendants and percentage/container rules need
              // the original window-sized containing block, even for thin bars.
              pinRect(control, controlRect)
              setStyles(control, { transform: 'none' })
              const material = materialStyle(document, name, liveControl)
              if (material)
                materials.push({
                  plane,
                  control,
                  rect: entries.find((node) => layerFor(node.id) === name)?.rect ?? controlRect,
                  planeRect: rect,
                  controlRect,
                  style: material
                })
            }
          }
          // Paint order at zero spacing also follows the actual stacked chrome.
          group.append(plane)
          if (name === 'background') {
            for (const decoration of backgroundDecorations) {
              // Workshop CSS selects a direct App child, including its state
              // conditions and tint pseudo element. Keep that selector intact
              // while this small decoration sheet follows the background pose.
              pinRect(decoration, { left: 0, top: 0, ...size })
              setStyles(decoration, {
                'z-index': String(APPEARANCE_LAYER_ORDER.indexOf('background')),
                'transform-style': 'flat',
                transform: layerTransform('background', nextSpacing)
              })
              group.append(decoration)
            }
            // One native App tint sits above App decoration, below content.
            // Keeping it inside a prepared background sheet prevents fixed
            // pseudo surfaces from escaping each material sampling crop.
            if (appTint) group.append(appTint)
          }
          layers.set(name, plane)
          skinBindings.push({ name, live, plane, rect })
        }
        for (const { name, live, plane, rect } of skinBindings) {
          const targets = (root: HTMLElement) =>
            [root, ...root.querySelectorAll<HTMLElement>('[data-te-appearance-skin]')].filter(
              (target) => target.getAttribute('data-te-appearance-skin') !== null
            )
          const originals = targets(live)
          const copies = targets(plane)
          for (const [index, copy] of copies.entries()) {
            if (copy.style.getPropertyValue('--te-skin-placement') !== 'outside') continue
            const original = originals[index]
            if (!original) continue
            const bounds = original.getBoundingClientRect()
            const overflow = skinOverflow?.(copy, {
              left: bounds.left - rect.left,
              top: bounds.top - rect.top
            })
            if (!overflow) continue
            let skinPlane = skinPlanes.get(name)
            if (!skinPlane) {
              skinPlane = document.createElement('div')
              skinPlane.dataset.appearanceSkinPlane = name
              skinPlane.setAttribute('inert', '')
              skinPlane.setAttribute('aria-hidden', 'true')
              pinRect(skinPlane, rect)
              setStyles(skinPlane, {
                overflow: 'visible',
                'pointer-events': 'none',
                'z-index': String(APPEARANCE_LAYER_ORDER.indexOf(name)),
                'transform-style': 'flat',
                transform: layerTransform(name, nextSpacing)
              })
              skinPlanes.set(name, skinPlane)
              group.append(skinPlane)
            }
            // A sibling sheet bypasses the native region's clipping. Its hole
            // keeps the real text, controls, dimensions and hit target intact.
            skinPlane.append(overflow)
          }
        }
        // The native inset edge sits above content and below attached chrome.
        // Root pseudos are disabled on clones, so preserve this painter too.
        if (appEdge) group.append(appEdge)
        // Sample the native, flat content before extracting its surfaces. A
        // card samples everything behind itself; a button also samples its card.
        const flatContent = detailSurfaces.length
          ? (layers.get('content')?.cloneNode(true) as HTMLElement)
          : undefined
        const templates = [
          layers.get('outer'),
          skinPlanes.get('outer'),
          layers.get('background'),
          skinPlanes.get('background'),
          ...backgroundDecorations,
          appTint,
          flatContent ?? layers.get('content'),
          skinPlanes.get('content'),
          appEdge
        ].filter((template): template is HTMLElement => Boolean(template))
        // Buttons sample the native chrome beneath them as well as the content.
        // Capture before adding any sampled material contexts to avoid recursion.
        const detailTemplates = [
          ...templates,
          ...(detailSurfaces.some(
            (surface) => surface.pose === 'chrome-controls' || surface.pose === 'player-controls'
          )
            ? ['navigation', 'player', 'title']
            : []
          ).flatMap((name) => {
            const plane = layers.get(name as AppearanceLayer)
            return plane ? [plane.cloneNode(true) as HTMLElement] : []
          })
        ]
        const clippedPaint =
          materials.length || detailSurfaces.length
            ? [...source.querySelectorAll<HTMLElement>('.feature-backdrop')].map((painter) =>
                readSamplingArtwork(document, painter)
              )
            : []
        for (const material of materials)
          addMaterialContext(
            document,
            group,
            material.plane,
            material.control,
            material.rect,
            material.planeRect,
            material.controlRect,
            size,
            material.style,
            templates,
            clippedPaint
          )
        for (const [index, surface] of detailSurfaces.entries()) {
          const nativeCopy = copies.get(surface.element)
          if (!nativeCopy) continue
          const plane = document.createElement('div')
          plane.dataset.appearanceDetail = surface.id
          pinRect(plane, { left: 0, top: 0, ...size })
          setStyles(plane, {
            overflow: 'visible',
            isolation: 'isolate',
            'transform-style': 'flat',
            'pointer-events': 'none',
            'z-index': surface.id === 'navigation' ? '3' : '2'
          })
          const ancestry: HTMLElement[] = []
          for (
            let parent = surface.element.parentElement;
            parent && parent !== source;
            parent = parent.parentElement
          )
            ancestry.unshift(parent)
          let parent: HTMLElement = plane
          let origin = { left: 0, top: 0 }
          for (const ancestor of ancestry) {
            const branch = ancestor.cloneNode(false) as HTMLElement
            const rect = detailRects.get(ancestor) ?? ancestor.getBoundingClientRect()
            detailRects.set(ancestor, rect)
            branch.dataset.appearanceDetailBranch = ''
            pinRect(branch, {
              left: rect.left - origin.left,
              top: rect.top - origin.top,
              width: rect.width,
              height: rect.height
            })
            setStyles(branch, {
              // Ancestry keeps selectors and inherited tokens, not a second
              // flex/grid layout that re-aligns already measured controls.
              display: 'block',
              padding: '0',
              'align-self': 'start',
              'justify-self': 'start',
              background: 'transparent',
              border: '0',
              'box-shadow': 'none',
              filter: 'none',
              'backdrop-filter': 'none',
              overflow: 'visible',
              isolation: 'auto',
              'transform-style': 'flat',
              transform: 'none',
              opacity: '1',
              visibility: 'visible',
              contain: 'none'
            })
            parent.append(branch)
            parent = branch
            origin = rect
          }
          const control = nativeCopy.cloneNode(true) as HTMLElement
          pinRect(control, {
            ...surface.rect,
            left: surface.rect.left - origin.left,
            top: surface.rect.top - origin.top
          })
          setStyles(control, { transform: 'none', 'align-self': 'start', 'justify-self': 'start' })
          // Child controls have their own depth; don't paint them twice.
          if (surface.id === 'card' || surface.id === 'controls')
            for (const child of control.querySelectorAll<HTMLElement>(
              '[data-appearance-surface-key]'
            ))
              if (detailSurfaces[Number(child.dataset.appearanceSurfaceKey)]?.id === 'controls')
                setStyles(child, { visibility: 'hidden' })
          parent.append(control)
          prepareClone(plane)
          const bookmark = surface.element.matches('.sidebar-bookmark')
          const material = document.defaultView?.getComputedStyle(
            surface.element,
            bookmark ? '::before' : undefined
          )
          if (material && material.backdropFilter !== 'none' && material.opacity !== '0') {
            addMaterialContext(
              document,
              group,
              parent,
              control,
              surface.rect,
              { left: origin.left, top: origin.top, ...size },
              surface.rect,
              size,
              material,
              detailTemplates,
              clippedPaint,
              String(index)
            )
          }
          group.append(plane)
          detailPlanes.push({ id: surface.pose ?? surface.id, plane })
        }
        for (const surface of detailSurfaces) {
          const copy = copies.get(surface.element)
          if (copy) setStyles(copy, { visibility: 'hidden' })
        }
        fitElement.append(group)
        element.append(fitElement)
        style = document.createElement('style')
        style.textContent =
          '.appearance-layer-view,.appearance-layer-view *,.appearance-layer-view *::before,.appearance-layer-view *::after{animation:none!important;transition:none!important;pointer-events:none!important}.appearance-layer-view :is([data-appearance-layer-scene],[data-appearance-material-scene])::before,.appearance-layer-view :is([data-appearance-layer-scene],[data-appearance-material-scene])::after{display:none!important}' +
          '.appearance-layer-view [data-appearance-outer-surface]::before,.appearance-layer-view [data-appearance-outer-surface]::after{display:none!important}' +
          '.appearance-layer-view [data-appearance-detail-branch]::before,.appearance-layer-view [data-appearance-detail-branch]::after{display:none!important}' +
          appearanceBackgroundForegroundCss(
            '.appearance-layer-view [data-appearance-layer-scene]'
          ) +
          '.appearance-layer-view [data-appearance-layer]{transition:opacity var(--te-motion-panel,220ms) ease,translate var(--te-motion-panel,220ms) ease!important}html:is([data-te-motion="off"],[data-te-motion="reduced"]) .appearance-layer-view [data-appearance-layer]{transition:none!important}@media(prefers-reduced-motion:reduce){html:not([data-te-motion="full"]) .appearance-layer-view [data-appearance-layer]{transition:none!important}}' +
          '.appearance-layer-view [data-appearance-layer-scene]:is([data-preview-focus="background"],[data-preview-focus="inner-panel"]) [data-appearance-material-context]{display:none!important}'
        document.head.append(style)
        document.body.append(element)
        document.addEventListener('visibilitychange', visibilityChanged)
      }
      spacing = nextSpacing
      group!.dataset.previewFocus = input.selected ?? 'overview'
      const backgroundFocus = input.selected === 'background' || input.selected === 'inner-panel'
      for (const [name, plane] of layers)
        setStyles(plane, {
          transform: layerTransform(name, spacing),
          // Normal focus uses the same single post-composite context mask as
          // the flat view. Fading glass planes would change their paint color.
          opacity:
            backgroundFocus && name !== 'outer' && name !== 'background' && name !== 'content'
              ? '0'
              : '1',
          translate:
            backgroundFocus && name !== 'outer' && name !== 'background' && name !== 'content'
              ? '0 -32px'
              : 'none'
        })
      for (const decoration of backgroundDecorations)
        setStyles(decoration, { transform: layerTransform('background', spacing) })
      for (const [name, plane] of skinPlanes) {
        const native = layers.get(name)!
        setStyles(plane, {
          transform: layerTransform(name, spacing),
          opacity: native.style.getPropertyValue('opacity'),
          translate: native.style.getPropertyValue('translate')
        })
      }
      if (appTint) setStyles(appTint, { transform: layerTransform('background', spacing) })
      if (appEdge) setStyles(appEdge, { transform: layerTransform('content', spacing) })
      for (const { id, plane } of detailPlanes)
        setStyles(plane, {
          transform: appearancePartTransform(id, spacing),
          opacity: backgroundFocus ? '0' : '1'
        })
      return setPose({ tilt: nextTilt, angles: nextAngles })
    },
    clear,
    dispose(): void {
      clear()
      disposed = true
    }
  }
}
