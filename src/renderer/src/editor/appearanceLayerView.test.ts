import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { build } from 'vite'
import { resolveMotionMode, type MotionPreference } from '../../../shared/motion.ts'
import { createWorkshopProject } from '../../../shared/themeWorkshop.ts'
import { compileWorkshopLayers } from '../../../shared/themeWorkshopLayerCss.ts'
import { createWorkshopLayer } from '../../../shared/themeWorkshopLayers.ts'
import {
  APPEARANCE_LAYER_ORDER,
  appearanceLayerTransform,
  createAppearanceLayerView,
  normalizeAppearanceLayerAngles,
  normalizeAppearanceLayerTilt,
  projectAppearanceLayers
} from './appearanceLayerView.ts'
import type { EditorNode, EditorRect, EditorSize } from './viewportGeometry.ts'

const size = { width: 1280, height: 800 }
const ids = ['background', 'card', 'navigation', 'player-bar', 'material']
const fullNodes = (viewport: EditorSize): EditorNode[] =>
  ids.map((id) => ({ id, rect: { left: 0, top: 0, ...viewport }, maxScale: 2 }))
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`)
}

test('the CSS layer order and perspective projection preserve all node metadata', () => {
  assert.deepEqual(
    [...APPEARANCE_LAYER_ORDER],
    ['outer', 'background', 'content', 'navigation', 'player', 'title']
  )
  const input = fullNodes(size)
  input[0].focus = 'scene'
  const result = projectAppearanceLayers(size, input, 56, undefined, { x: 8, y: -12 })
  assert.equal(result.layerCount, 6)
  assert.deepEqual(
    result.nodes.map(({ id }) => id),
    ids
  )
  assert.equal(result.nodes[0].focus, 'scene')
  assert.equal(result.nodes[0].maxScale, 2)
  // An independently composed CSS matrix P * Rx * Ry, about the scene centre.
  const matrix = [
    [0.9781476007338057, 0, -0.20791169081775931, 0],
    [-0.028935714736957927, 0.9902680687415704, -0.1361318347907717, 0],
    [0.205888308534897, 0.13917310096006544, 0.9686283355228664, 0],
    [-0.205888308534897 / 2400, -0.13917310096006544 / 2400, -0.9686283355228664 / 2400, 1]
  ]
  for (let index = 0; index < ids.length; index++) {
    const point = [
      -size.width / 2,
      -size.height / 2 + (index === 0 ? 8.4 : index === 1 ? -30.8 : -16.8),
      (index === 1 ? 2.5 : index === 2 ? 5 : index + 1) * 56,
      1
    ]
    const transformed = matrix.map((row) =>
      row.reduce((sum, coefficient, axis) => sum + coefficient * point[axis], 0)
    )
    const expected = {
      x: size.width / 2 + transformed[0] / transformed[3],
      y: size.height / 2 + transformed[1] / transformed[3]
    }
    const actual = result.polygons[index].points[0]
    close((actual.x - result.fit.x) / result.fit.scale, expected.x)
    close((actual.y - result.fit.y) / result.fit.scale, expected.y)
    assert.notEqual(result.nodes[index].rect, input[index].rect)
  }
})

test('navigation and caption share attached chrome depth while content remains below them', () => {
  for (const spacing of [0, 24, 56, 80]) {
    assert.equal(
      appearanceLayerTransform('navigation', spacing),
      appearanceLayerTransform('title', spacing)
    )
    const rect = { left: 10, top: 40, width: 224, height: 400 }
    const projection = projectAppearanceLayers(
      size,
      ['navigation', 'material', 'card'].map((id) => ({ id, rect })),
      spacing,
      undefined,
      { x: 12, y: -24 }
    )
    assert.deepEqual(projection.polygons[0].points, projection.polygons[1].points)
    if (spacing > 0)
      assert.notDeepEqual(projection.polygons[0].points, projection.polygons[2].points)
  }
})

test('one uniform fit contains the layered assembly at desktop, short and narrow sizes', () => {
  for (const viewport of [size, { width: 1370, height: 500 }, { width: 620, height: 380 }]) {
    for (const spacing of [0, 56, 80]) {
      const result = projectAppearanceLayers(viewport, fullNodes(viewport), spacing)
      for (const polygon of result.polygons) {
        for (const point of polygon.points) {
          assert.ok(point.x >= -1e-8 && point.x <= viewport.width + 1e-8)
          assert.ok(point.y >= -1e-8 && point.y <= viewport.height + 1e-8)
        }
        const node = result.nodes.find(({ id }) => id === polygon.id)!
        close(node.rect.left, Math.min(...polygon.points.map(({ x }) => x)))
        close(node.rect.top, Math.min(...polygon.points.map(({ y }) => y)))
      }
    }
  }
})

test('outer shell and inner background project on different native planes', () => {
  const nodes = ['outer-panel', 'inner-panel', 'card'].map((id) => ({
    id,
    rect: { left: 0, top: 0, ...size }
  }))
  const result = projectAppearanceLayers(size, nodes, 56, undefined, { x: 8, y: -12 })
  assert.notDeepEqual(result.polygons[0].points, result.polygons[1].points)
  assert.notDeepEqual(result.polygons[1].points, result.polygons[2].points)
  const folded = projectAppearanceLayers(size, nodes, 0)
  assert.deepEqual(folded.polygons[0].points, folded.polygons[1].points)
})

test('native chrome rises relative to the receding base without cropping or imaginary full planes', () => {
  const viewport = { width: 1281, height: 802 }
  const input: EditorNode[] = [
    { id: 'background', rect: { left: 4, top: 44, width: 1273, height: 754 } },
    {
      id: 'card',
      rect: { left: 47.546875, top: 206.390625, width: 1175.90625, height: 366.390625 }
    },
    { id: 'navigation', rect: { left: 4, top: 44, width: 260, height: 754 } },
    { id: 'player-bar', rect: { left: 50.5, top: 690, width: 1180, height: 90 } },
    { id: 'material', rect: { left: 0, top: 0, width: 1281, height: 40 } }
  ]
  const centerY = (node: EditorNode) => node.rect.top + node.rect.height / 2
  const neutral = projectAppearanceLayers(viewport, input, 0, undefined, { x: 0, y: 0 })
  assert.deepEqual(neutral.fit, { x: 0, y: 0, scale: 1 })
  for (const [index, node] of neutral.nodes.entries())
    assert.deepEqual(node.rect, input[index].rect)
  const rotated = projectAppearanceLayers(viewport, input, 0)
  const expanded = projectAppearanceLayers(viewport, input)
  const baseDelta = centerY(expanded.nodes[0]) - centerY(rotated.nodes[0])
  assert.ok(baseDelta > 0, 'the base must visibly recede downwards')
  const relativeDeltas = expanded.nodes.slice(1).map((node, index) => {
    const delta = centerY(node) - centerY(rotated.nodes[index + 1]) - baseDelta
    assert.ok(delta < -20, `${node.id} does not float upwards relative to the base`)
    return { id: node.id, delta }
  })
  const imaginaryPlanes = fullNodes(viewport)
  assert.ok(
    projectAppearanceLayers(viewport, input, 56, undefined, { x: 0, y: -12 }).fit.scale >
      projectAppearanceLayers(viewport, imaginaryPlanes, 56, undefined, { x: 0, y: -12 }).fit.scale,
    'native thin chrome should not reserve a full-window plane'
  )
  let boundedCorners = 0
  for (const angles of [
    { x: 8, y: -12 },
    { x: -30, y: -60 },
    { x: -30, y: 60 },
    { x: 30, y: -60 },
    { x: 30, y: 60 }
  ])
    for (const spacing of [0, 56, 80]) {
      const projection = projectAppearanceLayers(viewport, input, spacing, { x: 4, y: -6 }, angles)
      for (const polygon of projection.polygons)
        for (const point of polygon.points) {
          assert.ok(point.x >= -1e-8 && point.x <= viewport.width + 1e-8)
          assert.ok(point.y >= -1e-8 && point.y <= viewport.height + 1e-8)
          boundedCorners++
        }
    }
  console.info('Layer assembly:', JSON.stringify({ baseDelta, relativeDeltas, boundedCorners }))
})

test('spacing clamps to the supported range and cards rise above the content plane', () => {
  const input = fullNodes(size)
  assert.deepEqual(
    projectAppearanceLayers(size, input, -20),
    projectAppearanceLayers(size, input, 0)
  )
  assert.deepEqual(
    projectAppearanceLayers(size, input, 90),
    projectAppearanceLayers(size, input, 80)
  )
  assert.deepEqual(
    projectAppearanceLayers(size, input, Number.NaN),
    projectAppearanceLayers(size, input, 56)
  )
  assert.notDeepEqual(
    projectAppearanceLayers(size, [{ ...input[1], id: 'card' }]).polygons[0].points,
    projectAppearanceLayers(size, [{ ...input[1], id: 'content' }]).polygons[0].points
  )
  const flat = projectAppearanceLayers(size, input, 0)
  for (const polygon of flat.polygons) assert.deepEqual(polygon.points, flat.polygons[0].points)
  assert.equal(projectAppearanceLayers({ width: 0, height: 800 }, input).layerCount, 0)
})

test('neutral, edge and bounded combined angles share one finite projection and preserve inputs', () => {
  const input = fullNodes(size)
  const tilt = Object.freeze({ x: 100, y: -100 })
  const angles = Object.freeze({ x: 29, y: -59 })
  assert.deepEqual(normalizeAppearanceLayerTilt(tilt), { x: 4, y: -6 })
  assert.deepEqual(normalizeAppearanceLayerAngles({ x: -200, y: 200 }), { x: -30, y: 60 })
  assert.deepEqual(normalizeAppearanceLayerTilt({ x: Number.NaN, y: Infinity }), { x: 0, y: 0 })
  assert.deepEqual(normalizeAppearanceLayerAngles(), { x: 0, y: 0 })
  assert.deepEqual(normalizeAppearanceLayerAngles({ x: Infinity, y: Number.NaN }), { x: 0, y: 0 })
  assert.deepEqual(
    projectAppearanceLayers(size, input),
    projectAppearanceLayers(size, input, 56, { x: 0, y: 0 }, { x: 0, y: 0 })
  )
  assert.deepEqual(
    projectAppearanceLayers(size, input, 80, tilt, angles),
    projectAppearanceLayers(size, input, 80, { x: 0, y: 0 }, { x: 30, y: -60 })
  )
  assert.deepEqual(tilt, { x: 100, y: -100 })
  assert.deepEqual(angles, { x: 29, y: -59 })
  const flat = projectAppearanceLayers(size, input, 0, { x: 0, y: 0 }, { x: 0, y: 0 })
  for (const polygon of flat.polygons)
    assert.deepEqual(polygon.points, [
      { x: 0, y: 0 },
      { x: 1280, y: 0 },
      { x: 1280, y: 800 },
      { x: 0, y: 800 }
    ])
  for (const angles of [
    { x: -30, y: -60 },
    { x: 30, y: 60 }
  ]) {
    const result = projectAppearanceLayers(size, input, 80, { x: 4, y: -6 }, angles)
    for (const polygon of result.polygons)
      for (const point of polygon.points) {
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
        assert.ok(point.x >= -1e-8 && point.x <= size.width + 1e-8)
        assert.ok(point.y >= -1e-8 && point.y <= size.height + 1e-8)
      }
  }
})

class ElementFixture {
  ownerDocument: DocumentFixture
  tagName: string
  parent: ElementFixture | null = null
  children: ElementFixture[] = []
  attributeValues = new Map<string, string>()
  styles = new Map<string, { value: string; priority: string }>()
  textContent = ''
  rect: EditorRect = { left: 0, top: 0, width: 0, height: 0 }
  constructor(document: DocumentFixture, tagName: string) {
    this.ownerDocument = document
    this.tagName = tagName.toUpperCase()
  }
  get style() {
    return {
      getPropertyValue: (name: string) => this.styles.get(name)?.value ?? '',
      getPropertyPriority: (name: string) => this.styles.get(name)?.priority ?? '',
      setProperty: (name: string, value: string, priority = '') => {
        this.ownerDocument.counts.writes++
        this.styles.set(name, { value, priority })
      }
    }
  }
  get dataset() {
    return new Proxy({} as Record<string, string>, {
      set: (_target, name: string, value: string) => {
        this.setAttribute(
          `data-${name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}`,
          value
        )
        return true
      }
    })
  }
  get attributes() {
    return [...this.attributeValues].map(([name, value]) => ({ name, value }))
  }
  get className(): string {
    return this.getAttribute('class') ?? ''
  }
  set className(value: string) {
    this.setAttribute('class', value)
  }
  get classList() {
    return { contains: (name: string) => this.className.split(/\s+/).includes(name) }
  }
  getAttribute(name: string): string | null {
    return this.attributeValues.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attributeValues.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attributeValues.delete(name)
  }
  append(...elements: ElementFixture[]): void {
    for (const element of elements) {
      element.remove()
      element.parent = this
      this.children.push(element)
    }
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  querySelectorAll(selector: string): ElementFixture[] {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')])
    return descendants.filter((element) =>
      selector.split(',').some((part) => {
        if (part === '*') return true
        if (part.startsWith('.')) return element.className.split(' ').includes(part.slice(1))
        return element.tagName === part.toUpperCase()
      })
    )
  }
  querySelector(selector: string): ElementFixture | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
  getBoundingClientRect(): EditorRect {
    this.ownerDocument.counts.rects++
    return { ...this.rect }
  }
  cloneNode(): ElementFixture {
    this.ownerDocument.counts.clones++
    function copy(element: ElementFixture): ElementFixture {
      const clone = new ElementFixture(element.ownerDocument, element.tagName)
      clone.attributeValues = new Map(element.attributeValues)
      clone.styles = new Map(element.styles)
      clone.textContent = element.textContent
      clone.rect = { ...element.rect }
      clone.append(...element.children.map(copy))
      return clone
    }
    return copy(this)
  }
  snapshot(): unknown {
    return {
      tag: this.tagName,
      attributes: this.attributes,
      styles: [...this.styles],
      text: this.textContent,
      children: this.children.map((child) => child.snapshot())
    }
  }
}
class DocumentFixture {
  hidden = false
  counts = { rects: 0, clones: 0, writes: 0 }
  head = new ElementFixture(this, 'head')
  body = new ElementFixture(this, 'body')
  listeners = new Set<() => void>()
  createElement(tagName: string): ElementFixture {
    return new ElementFixture(this, tagName)
  }
  addEventListener(_name: string, listener: () => void): void {
    this.listeners.add(listener)
  }
  removeEventListener(_name: string, listener: () => void): void {
    this.listeners.delete(listener)
  }
}
function fixture() {
  const document = new DocumentFixture()
  const scene = document.createElement('div')
  scene.className = 'app-shell appearance-preview-scene'
  scene.setAttribute('data-v-real-scene', '')
  scene.style.setProperty('visibility', 'hidden')
  const wrappers = new Map<string, ElementFixture>()
  for (const [name, className, childClass, rect] of [
    ['background', 'appearance-window-background', '', { left: 0, top: 0, ...size }],
    ['title', 'app-shell-title', 'title-bar', { left: 10, top: 8, width: 1260, height: 32 }],
    [
      'navigation',
      'app-shell-navigation',
      'side-menu',
      { left: 8, top: 40, width: 260, height: 752 }
    ],
    [
      'content',
      'app-shell-content',
      'feature-card',
      { left: 14, top: 50, width: 1252, height: 750 }
    ],
    [
      'player',
      'app-shell-player',
      'player-bar-shell',
      { left: 60, top: 710, width: 1160, height: 80 }
    ]
  ] as const) {
    const wrapper = document.createElement('div')
    wrapper.className = className
    wrapper.rect = { ...rect }
    if (childClass) {
      const child = document.createElement('div')
      child.className = childClass
      child.rect = { ...rect }
      wrapper.append(child)
    }
    wrappers.set(name, wrapper)
    scene.append(wrapper)
  }
  const content = wrappers.get('content')!
  const mask = document.createElement('span')
  mask.className = 'appearance-reference-mask'
  mask.setAttribute('data-v-real-scene', '')
  content.append(mask)
  const icon = document.createElement('i')
  icon.className = 'ph ph-house'
  content.append(icon)
  const filter = document.createElement('filter')
  filter.setAttribute('id', 'original-glass')
  const surface = document.createElement('div')
  surface.setAttribute('style', 'filter:url("#original-glass")')
  surface.setAttribute('onclick', 'personalAction()')
  const use = document.createElement('use')
  use.setAttribute('href', '#original-glass')
  content.append(filter, surface, use)
  document.body.append(scene)
  const view = createAppearanceLayerView(document as unknown as Document)
  const input = {
    scene: scene as unknown as HTMLElement,
    size,
    nodes: fullNodes(size),
    revision: 1
  }
  return { document, scene, view, input, wrappers }
}
const asFixture = (element: HTMLElement | null) => element as unknown as ElementFixture

test('an inert static clone keeps production styles, masks and icons without modifying its source', () => {
  const { document, scene, view, input, wrappers } = fixture()
  const decoration = document.createElement('div')
  decoration.className = 'workshop-decoration'
  const paint = document.createElement('div')
  paint.setAttribute('style', 'background:var(--workshop-app-pattern)')
  decoration.append(paint)
  scene.append(decoration)
  const original = scene.snapshot()
  assert.equal(view.element, null)
  assert.equal(document.counts.clones, 0)
  assert.equal(view.sync(input).layerCount, 6)
  const host = asFixture(view.element)
  assert.equal(host.getAttribute('aria-hidden'), 'true')
  assert.equal(host.getAttribute('inert'), '')
  assert.equal(host.style.getPropertyValue('width'), '1280px')
  const clone = host.querySelector('.appearance-preview-scene')!
  assert.notEqual(clone, scene)
  assert.equal(clone.style.getPropertyValue('visibility'), 'visible')
  assert.equal(clone.getAttribute('data-v-real-scene'), '')
  assert.equal(
    clone.style.getPropertyValue('transform'),
    'perspective(2400px) rotateX(0deg) rotateY(0deg)'
  )
  assert.ok(clone.querySelector('.appearance-reference-mask'))
  assert.ok(clone.querySelector('.ph'))
  const background = clone.querySelector('.appearance-window-background')!
  const appDecoration = clone.children.find((child) => child.className === 'workshop-decoration')!
  assert.equal(appDecoration.parent, clone)
  assert.equal(appDecoration.style.getPropertyValue('z-index'), '1')
  assert.equal(
    appDecoration.style.getPropertyValue('transform'),
    background.style.getPropertyValue('transform')
  )
  assert.equal(
    appDecoration.children[0].getAttribute('style'),
    'background:var(--workshop-app-pattern)'
  )
  assert.deepEqual(
    clone.children
      .map((child) => child.getAttribute('data-appearance-layer'))
      .filter((name) => name !== null),
    [...APPEARANCE_LAYER_ORDER]
  )
  const counts = { ...document.counts }
  view.setPose({ spacing: 80 })
  assert.equal(appDecoration.style.getPropertyValue('transform'), 'translate3d(0, 12px, 80px)')
  assert.equal(document.counts.clones, counts.clones)
  assert.equal(document.counts.rects, counts.rects)
  for (const [name, selector] of [
    ['title', '.title-bar'],
    ['navigation', '.side-menu'],
    ['player', '.player-bar-shell']
  ]) {
    const plane = clone.children.find(
      (child) => child.getAttribute('data-appearance-layer') === name
    )!
    const target = plane.querySelector(selector)!
    const rect = wrappers.get(name)!.rect
    assert.equal(plane.style.getPropertyValue('left'), '0px')
    assert.equal(plane.style.getPropertyValue('top'), '0px')
    assert.equal(plane.style.getPropertyValue('width'), '1280px')
    assert.equal(plane.style.getPropertyValue('height'), '800px')
    assert.equal(target.style.getPropertyValue('left'), `${rect.left}px`)
    assert.equal(target.style.getPropertyValue('top'), `${rect.top}px`)
    assert.equal(target.style.getPropertyValue('width'), `${rect.width}px`)
    assert.equal(target.style.getPropertyValue('height'), `${rect.height}px`)
    assert.equal(target.style.getPropertyPriority('position'), 'important')
    assert.equal(target.style.getPropertyValue('transform'), 'none')
  }
  const content = clone.querySelector('.app-shell-content')!
  assert.equal(content.style.getPropertyValue('left'), '14px')
  assert.equal(content.style.getPropertyValue('top'), '50px')
  const filter = clone.querySelector('filter')!
  assert.notEqual(filter.getAttribute('id'), 'original-glass')
  assert.equal(clone.querySelector('use')!.getAttribute('href'), `#${filter.getAttribute('id')}`)
  const surface = content.children.find((child) => child.getAttribute('style'))!
  assert.equal(surface.getAttribute('style'), `filter:url(#${filter.getAttribute('id')})`)
  assert.equal(surface.getAttribute('onclick'), null)
  assert.deepEqual(scene.snapshot(), original)
  view.dispose()
})

test('spacing and selection update existing planes without cloning, measuring or changing the source', () => {
  const { document, scene, view, input } = fixture()
  const original = scene.snapshot()
  view.sync(input)
  const counts = { ...document.counts }
  const host = view.element
  const clone = asFixture(host).querySelector('.appearance-preview-scene')!
  view.sync({ ...input, spacing: 80, selected: 'background' })
  assert.equal(view.element, host)
  assert.equal(document.counts.clones, counts.clones)
  assert.equal(document.counts.rects, counts.rects)
  assert.equal(clone.children.length, 6)
  for (const [index, plane] of clone.children.entries()) {
    assert.equal(
      plane.style.getPropertyValue('transform'),
      `translate3d(0, ${index <= 1 ? 12 : -24}px, ${(index === 3 ? 5 : index) * 80}px)`
    )
    assert.equal(plane.style.getPropertyValue('opacity'), index <= 2 ? '1' : '0')
    assert.equal(plane.style.getPropertyValue('translate'), index <= 2 ? 'none' : '0 -32px')
  }
  assert.equal(clone.getAttribute('data-preview-focus'), 'background')
  view.sync({ ...input, spacing: 80, selected: 'card' })
  for (const plane of clone.children) assert.equal(plane.style.getPropertyValue('opacity'), '1')
  view.sync({ ...input, spacing: 80, selected: 'overview' })
  for (const plane of clone.children) assert.equal(plane.style.getPropertyValue('opacity'), '1')
  const writes = document.counts.writes
  view.sync({ ...input, spacing: 80, selected: 'overview' })
  assert.equal(
    document.counts.writes,
    writes,
    'identical sync must not write unchanged inline styles'
  )
  assert.deepEqual(scene.snapshot(), original)
  view.dispose()
})

test('model revision rebuilds once and clear fully restores the untouched two-dimensional source', () => {
  const { document, scene, view, input } = fixture()
  const original = scene.snapshot()
  view.sync(input)
  const host = asFixture(view.element)
  const copies = document.counts.clones
  view.sync({ ...input, revision: 2 })
  assert.equal(document.counts.clones, copies + 1)
  assert.equal(host.parent, null)
  assert.equal(document.head.children.length, 1)
  assert.equal(document.listeners.size, 1)
  view.clear()
  assert.equal(view.element, null)
  assert.deepEqual(document.body.children, [scene])
  assert.equal(document.head.children.length, 0)
  assert.equal(document.listeners.size, 0)
  assert.deepEqual(scene.snapshot(), original)
  view.sync(input)
  assert.equal(document.counts.clones, copies + 2)
  view.dispose()
  assert.equal(view.sync(input).layerCount, 0)
  assert.deepEqual(document.body.children, [scene])
})

test('cached pointer and pose updates write two transforms and never measure or clone planes', () => {
  const { document, scene, view, input } = fixture()
  assert.equal(view.setTilt({ x: 4, y: 6 }).layerCount, 0)
  view.sync(input)
  const host = view.element
  const clone = asFixture(host).querySelector('.appearance-preview-scene')!
  const planes = clone.children.map((plane) => plane.snapshot())
  const original = scene.snapshot()
  const before = { ...document.counts }
  const result = view.setTilt({ x: 4, y: 6 })
  assert.deepEqual(result, projectAppearanceLayers(size, input.nodes, 56, { x: 4, y: 6 }))
  assert.equal(document.counts.writes, before.writes + 2)
  assert.equal(document.counts.clones, before.clones)
  assert.equal(document.counts.rects, before.rects)
  assert.deepEqual(
    clone.children.map((plane) => plane.snapshot()),
    planes
  )
  for (let index = 0; index < 100; index++) view.setTilt({ x: 4, y: 6 })
  assert.equal(document.counts.writes, before.writes + 2)
  assert.equal(
    clone.style.getPropertyValue('transform'),
    'perspective(2400px) rotateX(4deg) rotateY(6deg)'
  )

  const flat = view.setPose({ angles: { x: 0, y: 0 }, tilt: { x: 0, y: 0 }, spacing: 0 })
  assert.deepEqual(flat, projectAppearanceLayers(size, input.nodes, 0, undefined, { x: 0, y: 0 }))
  for (const plane of clone.children)
    assert.equal(plane.style.getPropertyValue('transform'), 'translate3d(0, 0px, 0px)')
  assert.equal(view.element, host)
  const neutralCounts = { ...document.counts }
  view.setPose({})
  assert.deepEqual(document.counts, neutralCounts)
  view.setPose({ angles: { x: 100, y: -100 }, spacing: 80, tilt: { x: 4, y: -6 } })
  assert.equal(
    clone.style.getPropertyValue('transform'),
    'perspective(2400px) rotateX(30deg) rotateY(-60deg)'
  )
  view.sync({ ...input, selected: 'card' })
  assert.equal(
    clone.style.getPropertyValue('transform'),
    'perspective(2400px) rotateX(30deg) rotateY(-60deg)'
  )
  assert.equal(clone.children[1].style.getPropertyValue('transform'), 'translate3d(0, 12px, 80px)')
  assert.equal(document.counts.clones, before.clones)
  assert.equal(document.counts.rects, before.rects)
  view.sync({ ...input, revision: 2 })
  assert.equal(
    asFixture(view.element)
      .querySelector('.appearance-preview-scene')!
      .style.getPropertyValue('transform'),
    'perspective(2400px) rotateX(30deg) rotateY(-60deg)'
  )
  assert.deepEqual(scene.snapshot(), original)
  view.clear()
  const clearedCounts = { ...document.counts }
  assert.equal(view.setPose({ angles: { x: 0, y: 0 } }).layerCount, 0)
  assert.deepEqual(document.counts, clearedCounts)
  view.dispose()
})

test('hidden documents destroy the static tree and do not clone until visible again', () => {
  const { document, view, input } = fixture()
  view.sync(input)
  const copies = document.counts.clones
  document.hidden = true
  for (const listener of [...document.listeners]) listener()
  assert.equal(view.element, null)
  assert.equal(document.listeners.size, 0)
  assert.equal(document.head.children.length, 0)
  assert.equal(view.sync(input).layerCount, 0)
  assert.equal(document.counts.clones, copies)
  document.hidden = false
  assert.equal(view.sync(input).layerCount, 6)
  assert.equal(document.counts.clones, copies + 1)
  view.dispose()
})

test('a scene from another document is rejected before any display DOM is created', () => {
  const { document, view, input } = fixture()
  const other = new DocumentFixture().createElement('div')
  assert.throws(
    () => view.sync({ ...input, scene: other as unknown as HTMLElement }),
    /share the preview document/
  )
  assert.equal(document.counts.clones, 0)
  assert.equal(view.element, null)
  view.dispose()
})

test('motion preference CSS keeps explicit full motion under the system reduce media query', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-layer-motion-'))
  try {
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: resolve('src/renderer/src/editor/appearanceLayerView.ts'),
          name: 'AppearanceLayers',
          formats: ['iife'],
          fileName: 'layers'
        }
      }
    })
    const bundle = (await readdir(join(directory, 'bundle'))).find((file) => file.endsWith('.js'))!
    const popover = parse(
      await readFile('src/renderer/src/components/AppearancePopover.vue', 'utf8')
    )
    const popoverCss = compileStyle({
      source: popover.descriptor.styles[0].content,
      filename: 'AppearancePopover.vue',
      id: 'data-v-motion-policy',
      scoped: true
    })
    assert.deepEqual(popoverCss.errors, [])
    const cases = (['full', 'system', 'reduced', 'off'] satisfies MotionPreference[]).map(
      (preference) => ({ preference, resolved: resolveMotionMode(preference, true) })
    )
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><style>
      html,body{margin:0}.appearance-preview-scene{position:absolute;inset:0;width:1280px;height:800px}
      .appearance-window-background,.app-shell-content{position:absolute;inset:0}
      .title-bar{width:1280px;height:40px}.side-menu{width:260px;height:680px}
      .feature-card{width:600px;height:200px}.player-bar-shell{width:1100px;height:80px}
      ${popoverCss.code}
      </style></head><body><div class="appearance-preview-scene">
      <div class="appearance-window-background" data-node="background"></div>
      <div class="app-shell-title"><div class="title-bar" data-node="material"></div></div>
      <div class="app-shell-navigation"><div class="side-menu" data-node="navigation"></div></div>
      <div class="app-shell-content"><main class="main-content"><section><div class="feature-card" data-node="card"></div></section></main></div>
      <div class="app-shell-player"><div class="player-bar-shell" data-node="player-bar"></div></div></div>
      <div class="appearance-popover-enter-active" data-v-motion-policy></div>
      <script src="bundle/${bundle}"></script><script>
      window.checkMotionPolicy=()=>{
        if(!matchMedia('(prefers-reduced-motion: reduce)').matches)throw Error('system reduce media query is not active');
        const source=document.querySelector('.appearance-preview-scene'),style=document.createElement('style');
        style.textContent=AppearanceLayers.appearanceBackgroundForegroundCss('body > .appearance-preview-scene');document.head.append(style);
        const nodes=[...source.querySelectorAll('[data-node]')].map(element=>{const r=element.getBoundingClientRect();return {id:element.dataset.node,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}});
        const view=AppearanceLayers.createAppearanceLayerView(document);view.sync({scene:source,size:{width:1280,height:800},nodes,selected:'overview'});
        const targets={flat:source.querySelector('.side-menu'),layer:view.element.querySelector('[data-appearance-layer="navigation"]'),layerForeground:view.element.querySelector('.side-menu'),popover:document.querySelector('.appearance-popover-enter-active')};
        try{return [...${JSON.stringify(cases)},{preference:'unresolved-system',resolved:null}].map(item=>{
          if(item.resolved===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=item.resolved;
          return {...item,targets:Object.fromEntries(Object.entries(targets).map(([name,element])=>{const css=getComputedStyle(element);return [name,{property:css.transitionProperty,duration:css.transitionDuration}]}))};
        })}finally{view.dispose();style.remove()}
      };
      </script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron'),path=require('node:path');
      app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-prefers-reduced-motion');
      app.whenReady().then(async()=>{let win;try{
        win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{offscreen:true,backgroundThrottling:false}});
        await win.loadFile(path.join(__dirname,'index.html'));console.log('LAYER_MOTION',JSON.stringify(await win.webContents.executeJavaScript('(()=>{try{return window.checkMotionPolicy()}catch(error){return {error:error.stack}}})()')));win.destroy();app.exit(0);
      }catch(error){console.error(error);win?.destroy();app.exit(1)}});`
    )
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 30_000 }
    )
    const matrix = JSON.parse(result.stdout.match(/LAYER_MOTION (.+)/)![1])
    assert.ok(Array.isArray(matrix), JSON.stringify(matrix))
    for (const item of matrix) {
      for (const [target, value] of Object.entries(item.targets) as [
        string,
        { property: string; duration: string }
      ][]) {
        const durations = value.duration.split(',').map((value) => Number.parseFloat(value))
        if (item.resolved === 'full') {
          assert.ok(
            durations.every((duration) => duration > 0),
            `${target}: full was suppressed`
          )
          assert.match(value.property, /opacity/)
          assert.match(value.property, target === 'popover' ? /transform/ : /translate/)
        } else if (target === 'popover' && item.resolved === 'reduced') {
          assert.equal(value.property, 'opacity')
          assert.deepEqual(durations, [0.1])
        } else
          assert.ok(
            durations.every((duration) => duration === 0),
            `${target}: ${item.preference}`
          )
      }
    }
    console.info('Layer and popover motion policy:', JSON.stringify(matrix))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Chromium projects every DOM corner and pointer frames touch only two cached transforms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-layer-projection-'))
  try {
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: resolve('src/renderer/src/editor/appearanceLayerView.ts'),
          name: 'AppearanceLayers',
          formats: ['iife'],
          fileName: 'layers'
        }
      }
    })
    const bundle = (await readdir(join(directory, 'bundle'))).find((file) => file.endsWith('.js'))!
    const workshop = createWorkshopProject('preview-app-layer', 'Preview layer')
    const pattern = createWorkshopLayer('pattern', 'gradient')
    Object.assign(pattern, { opacity: 0.45, colorStart: '#345678', colorEnd: '#96abcd' })
    const conditional = createWorkshopLayer('condition', 'gradient')
    Object.assign(conditional, { condition: 'loading', blur: 5, maskOpacity: 0.2 })
    workshop.layers = {
      pureWhite: { app: [pattern, conditional] },
      dark: { app: [pattern, conditional] }
    }
    const mainCss = await readFile('src/renderer/src/assets/main.css', 'utf8')
    const nativeShellStart = mainCss.indexOf('.app-shell {')
    // Other native surfaces may use the same layout guard before shell geometry.
    // Keep the whole painter, including its transparent-window override.
    const nativeShellEnd = mainCss.indexOf(
      "html:not([data-te-shell-layout='custom']) .app-shell:not(.is-immersive) .app-shell-content {"
    )
    assert.ok(nativeShellStart >= 0 && nativeShellEnd > nativeShellStart)
    const nativeShellCss = mainCss.slice(nativeShellStart, nativeShellEnd)
    assert.ok(nativeShellCss.includes("html[data-window-transparent='on'] .app-shell::before"))
    const probeProject = createWorkshopProject('app-tint-probe', 'Native App tint')
    const probe = createWorkshopLayer('probe', 'gradient')
    Object.assign(probe, {
      x: 94,
      y: 8,
      width: 5.5,
      height: 5.5,
      colorStart: '#de3f75',
      colorEnd: '#de3f75'
    })
    probeProject.layers = { pureWhite: { app: [probe] }, dark: { app: [probe] } }
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><style>
      html,body{margin:0}.appearance-preview-scene{position:absolute;left:0;top:0;width:1280px;height:800px}
      .appearance-window-background,.app-shell-title,.app-shell-navigation,.app-shell-player{position:absolute;inset:0}
      .appearance-window-background{z-index:-2}
      .app-shell-content{position:absolute;left:14px;top:50px;width:1252px;height:750px}
      .title-bar{position:absolute;left:10px;top:8px;width:1260px;height:32px}
      .side-menu{position:absolute;left:8px;top:40px;width:260px;height:752px}
      .dashboard-wrapper,.home-inner{position:absolute;inset:0}
      .dashboard-wrapper{background:rgba(90,110,130,.08)}
      .ambient{position:absolute;inset:0;pointer-events:none;background:linear-gradient(120deg,transparent 65%,rgba(90,180,250,.12))}
      .feature-card{position:absolute;left:66px;top:90px;width:600px;height:280px}
      .player-bar-shell{position:absolute;left:60px;top:710px;width:1160px;height:80px}
      .point{position:absolute;width:0;height:0;left:0;top:0}.point[data-corner="1"],.point[data-corner="2"]{left:100%}.point[data-corner="2"],.point[data-corner="3"]{top:100%}
      .workshop-decoration{position:absolute;inset:0;overflow:hidden;z-index:-1;pointer-events:none}.workshop-decoration>div{display:none;position:absolute}
      ${compileWorkshopLayers(workshop)}
      </style></head><body><div class="appearance-preview-scene" inert>
      <div class="appearance-window-background" data-node="background"></div>
      <div class="app-shell-title"><div class="title-bar" data-node="material"></div></div>
      <div class="app-shell-navigation"><div class="side-menu" data-node="navigation"></div></div>
      <div class="app-shell-content"><main class="main-content" style="position:absolute;inset:0"><div class="dashboard-wrapper"><div class="ambient"></div><div class="home-inner"><div class="feature-card" data-node="card"></div></div></div></main></div>
      <div class="app-shell-player"><div class="player-bar-shell" data-node="player-bar"></div></div>
      </div><script type="application/json" id="native-app-css">${JSON.stringify(
        nativeShellCss + '\n' + compileWorkshopLayers(probeProject)
      ).replaceAll(
        '<',
        '\\u003c'
      )}</script><script src="bundle/${bundle}"></script><script>${browserProjectionFixture}</script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), browserProjectionRunner)
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 30_000 }
    )
    const counters = JSON.parse(result.stdout.match(/LAYER_PROJECTION (.+)/)![1])
    assert.equal(counters.initialClones, 1)
    assert.ok(
      counters.initialSourceMeasures >= 4 && counters.initialSourceMeasures <= 16,
      'surface preparation has bounded native measurements'
    )
    assert.equal(counters.cornerCases, 1340)
    assert.equal(counters.pointerClones, 0)
    assert.equal(counters.pointerSourceMeasures, 0)
    assert.equal(counters.pointerWrites, 120)
    assert.equal(counters.pointerWriteTargets, 2)
    console.info('Layer Chromium projection:', JSON.stringify(counters))
    const material = JSON.parse(result.stdout.match(/LAYER_MATERIAL (.+)/)![1])
    console.info('Layer Chromium material:', JSON.stringify(material))
    for (const sample of material.samples) {
      assert.equal(sample.contexts, sample.mode === 'layered' ? 3 : 0)
      for (const region of sample.regions)
        assert.ok(
          sample.background === 'striped' && !sample.opaque
            ? region.meanDelta > 2
            : region.meanDelta < 0.2,
          `${sample.mode} ${sample.background} ${region.id} changes pixels incorrectly`
        )
    }
    for (const state of material.colors) {
      assert.equal(state.visibleContexts, state.selected === 'background' ? 0 : 3)
      for (const region of state.collapsed)
        assert.ok(
          region.meanColorDelta < 1,
          `${state.selected} ${region.id} changes material color`
        )
      for (const region of state.roundtrip)
        assert.equal(
          region.meanDelta,
          0,
          `${state.selected} ${region.id} fails to restore flat color`
        )
    }
    assert.equal(material.lifecycle.pointerClones, 0)
    assert.equal(material.lifecycle.pointerSourceMeasures, 0)
    assert.equal(material.lifecycle.materialWrites, 0)
    assert.equal(material.lifecycle.hiddenContexts, 0)
    assert.equal(material.lifecycle.hiddenClones, 0)
    assert.equal(material.lifecycle.masks, 3)
    const background = JSON.parse(result.stdout.match(/LAYER_BACKGROUND (.+)/)![1])
    console.info('Layer Chromium background:', JSON.stringify(background))
    assert.equal(background.cases.length, 2)
    for (const sample of background.cases) {
      assert.equal(sample.pageOpacity, '1')
      assert.equal(sample.ambientOpacity, '1')
      assert.equal(sample.foregroundOpacity, '0')
      assert.equal(sample.background.meanDelta, 0)
      assert.ok(sample.foreground.meanDelta > 10)
    }
    assert.ok(background.flatLayeredDifference < 0.2)
    const sampling = JSON.parse(result.stdout.match(/LAYER_SAMPLING (.+)/)![1])
    assert.equal(sampling.nativeCropped, true)
    assert.equal(sampling.unsafeOptics.length, 9)
    assert.ok(sampling.unsafeOptics.every((sample) => sample.complete && sample.preserved))
    assert.equal(sampling.unsafeArtwork.length, 5)
    assert.ok(sampling.unsafeArtwork.every((sample) => sample.preserved))
    assert.equal(sampling.directChildPixelsPreserved, true)
    assert.equal(sampling.sourceRestored, true)
    console.info('Layer Chromium sampling boundaries:', JSON.stringify(sampling))
    const workshopResult = JSON.parse(result.stdout.match(/LAYER_WORKSHOP (.+)/)![1])
    console.info('Layer Chromium workshop:', JSON.stringify(workshopResult))
    assert.equal(workshopResult.copies, 4)
    assert.equal(workshopResult.sourceUnchanged, true)
    assert.equal(workshopResult.conditionRestored, true)
    assert.equal(workshopResult.pointerClones, 0)
    assert.equal(workshopResult.pointerSourceMeasures, 0)
    assert.ok(workshopResult.paintChanged > 1, 'the native App decoration never painted')
    assert.ok(workshopResult.paintRestored < 0.2, 'the 3D App decoration changes native color')
    for (const tint of workshopResult.nativeTints) {
      assert.equal(tint.tintCopies, 4)
      assert.ok(tint.visiblePaintDifference > 1, 'the compiled App probe is never visible')
      assert.ok(tint.collapsedDifference < 0.2, 'native App tint changes neutral 3D color')
      assert.equal(tint.roundtripDifference, 0)
      assert.equal(tint.sourceUnchanged, true)
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-layer-projection-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const browserProjectionFixture = `
window.checkLayerProjection=async()=>{
 const {createAppearanceLayerView}=AppearanceLayers,source=document.querySelector('.appearance-preview-scene'),viewport={width:1280,height:800},expect=(value,message)=>{if(!value)throw Error(message)};
 for(const control of source.querySelectorAll('[data-node]'))for(let corner=0;corner<4;corner++){const point=document.createElement('i');point.className='point';point.dataset.corner=String(corner);control.append(point)}
 const nodes=[...source.querySelectorAll('[data-node]')].map(control=>{const rect=control.getBoundingClientRect();return {id:control.dataset.node,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}}});
 const nativeClone=Node.prototype.cloneNode,nativeRect=Element.prototype.getBoundingClientRect;let clones=0,sourceMeasures=0,cornerCases=0;
 Node.prototype.cloneNode=function(deep){if(this===source)clones++;return nativeClone.call(this,deep)};Element.prototype.getBoundingClientRect=function(){if(this===source||source.contains(this))sourceMeasures++;return nativeRect.call(this)};
 const view=createAppearanceLayerView(document),input={scene:source,size:viewport,nodes};
 try{
  view.sync(input);const initialClones=clones,initialSourceMeasures=sourceMeasures,clone=view.element.querySelector('[data-appearance-layer-scene]'),fit=clone.parentElement;
  const check=projection=>{for(const polygon of projection.polygons){const points=clone.querySelector((polygon.id==='card'?'[data-appearance-detail="card"] ':'')+'[data-node="'+polygon.id+'"]').querySelectorAll('.point');for(let index=0;index<4;index++){const actual=points[index].getBoundingClientRect(),expected=polygon.points[index];expect(Math.abs(actual.x-expected.x)<0.04&&Math.abs(actual.y-expected.y)<0.04,'DOM corner differs from projected point: '+JSON.stringify({id:polygon.id,index,actual:{x:actual.x,y:actual.y},expected,rotation:clone.style.transform,fit:fit.style.transform}));cornerCases++;}}};
  for(const pose of [{angles:{x:0,y:0},tilt:{x:0,y:0},spacing:0},{angles:{x:8,y:-12},tilt:{x:0,y:0},spacing:56},{angles:{x:8,y:-12},tilt:{x:4,y:6},spacing:56},{angles:{x:8,y:-12},tilt:{x:-4,y:-6},spacing:80},{angles:{x:30,y:60},tilt:{x:4,y:6},spacing:80},{angles:{x:-30,y:-60},tilt:{x:-4,y:-6},spacing:80},{angles:{x:NaN,y:Infinity},tilt:{x:NaN,y:Infinity},spacing:NaN}])check(view.setPose(pose));
  view.setPose({angles:{x:8,y:-12},tilt:{x:0,y:0},spacing:56});const planes=[...clone.querySelectorAll('[data-appearance-layer]')],planeStyles=planes.map(plane=>plane.style.cssText),sourceBefore=source.outerHTML;clones=0;sourceMeasures=0;let writes=0;const targets=new Set(),observer=new MutationObserver(records=>{for(const record of records){writes++;targets.add(record.target);expect(record.target===clone||record.target===fit,'pointer writes styles inside a layer')}});observer.observe(view.element,{attributes:true,subtree:true,attributeFilter:['style']});
  let lastTilt;for(let frame=0;frame<60;frame++){lastTilt={x:Math.sin(frame*Math.PI/30)*4,y:Math.cos(frame*Math.PI/30)*6};check(view.setTilt(lastTilt))}for(let repeat=0;repeat<100;repeat++)view.setTilt(lastTilt);await new Promise(resolve=>setTimeout(resolve,0));observer.disconnect();expect(view.element.querySelector('[data-appearance-layer-scene]')===clone,'pointer reuses no static clone');expect(JSON.stringify(planes.map(plane=>plane.style.cssText))===JSON.stringify(planeStyles)&&source.outerHTML===sourceBefore,'pointer modifies a native plane or its source');return {initialClones,initialSourceMeasures,cornerCases,pointerClones:clones,pointerSourceMeasures:sourceMeasures,pointerWrites:writes,pointerWriteTargets:targets.size};
 }finally{Node.prototype.cloneNode=nativeClone;Element.prototype.getBoundingClientRect=nativeRect;view.dispose()}
};
let materialView;
window.configureLayerMaterial=async(mode,blur,background='striped',opaque=false,neutral=false,selected='overview')=>{
 const source=document.querySelector('body > .appearance-preview-scene'),size={width:1280,height:800};materialView?.dispose();source.style.visibility='';source.dataset.previewFocus='overview';source.classList.add('app-shell');
 if(!document.querySelector('#material-probe-style')){
  const style=document.createElement('style');style.id='material-probe-style';style.textContent='.appearance-window-background,.app-shell-content{background:var(--material-probe-background)}.app-shell::before{content:"";position:fixed;top:50px;left:14px;width:1252px;height:750px;z-index:0;background:rgba(24,28,36,.18)}.app-shell-content{z-index:1}.app-shell-navigation{z-index:2}.app-shell-player{z-index:3}.app-shell-title{z-index:4}.side-menu{isolation:isolate}.side-menu::before{content:"";position:absolute;inset:0;z-index:-1;background:rgba(230,240,255,var(--material-probe-opacity));border-radius:12px;backdrop-filter:blur(var(--material-probe-blur))}.title-bar-background,.player-bar-warp{position:absolute;inset:0;background:rgba(230,240,255,var(--material-probe-opacity));border-radius:12px;backdrop-filter:blur(var(--material-probe-blur))}.feature-card{background:rgba(24,28,36,.95)}.appearance-reference-mask{position:absolute;left:20px;top:20px;width:30px;height:5px;background:#888;border-radius:2px}';style.textContent+=AppearanceLayers.appearanceBackgroundForegroundCss('body > .appearance-preview-scene');document.documentElement.dataset.teMotion='off';document.head.append(style);
  for(const [parent,className] of [['.title-bar','title-bar-background'],['.player-bar-shell','player-bar-warp'],['.app-shell-content','appearance-reference-mask']]){const element=document.createElement('div');element.className=className;source.querySelector(parent).append(element)}
 }
 document.documentElement.style.setProperty('--material-probe-blur',blur+'px');document.documentElement.style.setProperty('--material-probe-opacity',opaque?'1':'.08');document.documentElement.style.setProperty('--material-probe-background',background==='striped'?'repeating-linear-gradient(90deg,#101010 0 3px,#eeeeee 3px 6px)':'#445566');
 const nodes=[...source.querySelectorAll('[data-node]')].map(control=>{const rect=control.getBoundingClientRect();return {id:control.dataset.node,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}}});
 // Cache untransformed node bounds, as the real preview does before changing focus.
 source.dataset.previewFocus=selected;
 if(mode==='layered'){materialView=AppearanceLayers.createAppearanceLayerView(document);materialView.sync({scene:source,size,nodes,spacing:neutral?0:56,angles:neutral?{x:0,y:0}:{x:8,y:-12},selected});source.style.visibility='hidden'}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const scope=mode==='layered'?materialView.element:source,contexts=scope.querySelectorAll('[data-appearance-material-context]');
 for(const context of contexts){if(context.getAttribute('inert')!==''||!context.querySelector('.appearance-reference-mask')||context.querySelectorAll('[data-appearance-layer],[data-preview-module]').length)throw Error('material context loses isolation, masks or native layer semantics');}
 const regions=['navigation','player-bar','material','card'].map(id=>{const control=scope.querySelector('[data-node="'+id+'"]'),rect=control.getBoundingClientRect(),points=[...control.querySelectorAll(':scope > .point')].slice(0,4).map(point=>{const r=point.getBoundingClientRect();return {x:r.left,y:r.top}});return {id,left:rect.left,top:rect.top,width:rect.width,height:rect.height,points}});
 return {contexts:contexts.length,visibleContexts:[...contexts].filter(context=>getComputedStyle(context).display!=='none').length,viewport:{width:innerWidth,height:innerHeight},card:regions.pop(),regions};
};
window.restoreLayerMaterial=async()=>{materialView?.dispose();document.querySelector('body > .appearance-preview-scene').style.visibility='';await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))};
window.backgroundLayerPaint=async(mode,selected)=>{
 const state=await window.configureLayerMaterial(mode,30,'solid',false,true,selected),scope=mode==='layered'?materialView.element.querySelector('[data-appearance-layer-scene]'):document.querySelector('body > .appearance-preview-scene');
 const opacity=selector=>getComputedStyle(scope.querySelector(selector)).opacity;
 return {...state,pageOpacity:opacity('.dashboard-wrapper'),ambientOpacity:opacity('.ambient'),foregroundOpacity:opacity('.home-inner'),regions:[{id:'native-background',points:[{x:900,y:400},{x:1000,y:400},{x:1000,y:480},{x:900,y:480}]}]};
};
window.checkLayerMaterialLifecycle=async()=>{
 const source=document.querySelector('body > .appearance-preview-scene'),root=materialView.element,contexts=[...root.querySelectorAll('[data-appearance-material-context]')],nativeClone=Node.prototype.cloneNode,nativeRect=Element.prototype.getBoundingClientRect;let clones=0,measures=0,writes=0;
 Node.prototype.cloneNode=function(deep){clones++;return nativeClone.call(this,deep)};Element.prototype.getBoundingClientRect=function(){if(this===source||source.contains(this))measures++;return nativeRect.call(this)};
 const observer=new MutationObserver(records=>{writes+=records.length});for(const context of contexts)observer.observe(context,{attributes:true,subtree:true,childList:true});
 try{for(let frame=0;frame<60;frame++)materialView.setTilt({x:Math.sin(frame/10)*4,y:Math.cos(frame/10)*6});await new Promise(resolve=>setTimeout(resolve,0));observer.disconnect();const masks=contexts.filter(context=>context.querySelector('.appearance-reference-mask')).length;Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));const hiddenContexts=document.querySelectorAll('[data-appearance-material-context]').length,previous=clones;materialView.sync({scene:source,size:{width:1280,height:800},nodes:[]});return {pointerClones:previous,pointerSourceMeasures:measures,materialWrites:writes,hiddenContexts,hiddenClones:clones-previous,masks};}finally{observer.disconnect();Node.prototype.cloneNode=nativeClone;Element.prototype.getBoundingClientRect=nativeRect;delete document.hidden;materialView.dispose();source.style.visibility=''}
};
window.checkSamplingBoundaries=async()=>{
 await window.restoreLayerMaterial();const source=document.querySelector('body > .appearance-preview-scene'),before=source.outerHTML,viewport={width:1280,height:800},card=source.querySelector('.feature-card'),cardStyle=card.getAttribute('style');
 const painter=document.createElement('div');painter.className='feature-backdrop';painter.style.cssText='position:absolute;inset:0;overflow:hidden;pointer-events:none';const image=document.createElement('img');image.src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="%23a45b76"/></svg>';image.style.cssText='position:absolute;inset:-18%;width:136%;height:136%;filter:blur(64px) saturate(1.3);opacity:.5;transform:translateZ(0);object-fit:cover';painter.append(image);card.prepend(painter);
 const style=document.createElement('style');document.head.append(style);const defs=document.createElementNS('http://www.w3.org/2000/svg','svg');defs.style.cssText='position:absolute;width:0;height:0';document.body.append(defs);const unsafeOptics=[],unsafeArtwork=[];let view;
 const inspect=()=>{view?.dispose();const nodes=[...source.querySelectorAll('[data-node]')].map(control=>{const r=control.getBoundingClientRect();return {id:control.dataset.node,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}});view=AppearanceLayers.createAppearanceLayerView(document);view.sync({scene:source,size:viewport,nodes,spacing:0,angles:{x:0,y:0},selected:'overview'});const plane=view.element.querySelector('[data-appearance-layer="navigation"]'),context=plane.querySelector('[data-appearance-material-scene]'),copy=context.querySelector('.feature-backdrop');return {context,copy};};
 const nativeRule='.side-menu::before{backdrop-filter:blur(5px)!important}';style.textContent=nativeRule;await image.decode();let state=inspect();const nativeCropped=!!state.copy.querySelector('[data-appearance-sampling-artwork]');if(!nativeCropped)throw Error('native clipped artwork is no longer optimized');
 try{
  for(const [name,markup,optics]of [['missing','','url(#missing-optics)'],['offset','<feOffset dx="100"/>',''],['morphology','<feMorphology radius="12"/>',''],['convolve','<feConvolveMatrix order="9"/>',''],['object-units','<feGaussianBlur stdDeviation=".08"/>',''],['chained','<feDisplacementMap in="SourceGraphic" scale="40" result="first"/><feDisplacementMap in="first" scale="40"/>',''],['invalid','<feGaussianBlur stdDeviation="NaN"/>',''],['shadow','','drop-shadow(100px 0 12px black)'],['primitive-units','<feGaussianBlur primitiveUnits="objectBoundingBox" stdDeviation=".08"/>','']]){
   defs.innerHTML='<defs><filter id="sampling-optics"'+(name==='object-units'?' primitiveUnits="objectBoundingBox"':'')+'>'+markup+'</filter></defs>';style.textContent='.side-menu::before{backdrop-filter:'+(optics||'url(#sampling-optics)')+'!important}';state=inspect();const complete=state.context.dataset.appearanceSamplingBleed==='complete'&&parseFloat(state.context.style.width)===1280&&parseFloat(state.context.style.height)===800,preserved=!state.copy.querySelector('[data-appearance-sampling-artwork]')&&!state.copy.hasAttribute('data-appearance-sampling-culled');if(!complete||!preserved)throw Error('unknown optics lose native input: '+name);unsafeOptics.push({name,complete,preserved});
  }
  style.textContent=nativeRule;const originals={painter:painter.style.cssText,image:image.style.cssText,card:card.style.cssText};
  for(const [name,target,property,value]of [['overflow',painter,'overflow','visible'],['painter-filter',painter,'filter','blur(30px)'],['ancestor-transform',card,'transform','scale(1.2)'],['individual-transform',image,'scale','1.2'],['image-border',image,'border','2px solid red']]){target.style.setProperty(property,value);state=inspect();const preserved=!state.copy.querySelector('[data-appearance-sampling-artwork]')&&!state.copy.hasAttribute('data-appearance-sampling-culled');if(!preserved)throw Error('unsafe artwork was clipped or relocated: '+name);unsafeArtwork.push({name,preserved});painter.style.cssText=originals.painter;image.style.cssText=originals.image;card.style.cssText=originals.card;}
  style.textContent=nativeRule+'.feature-backdrop > img{object-fit:contain!important;object-position:17% 83%!important}';state=inspect();const copyImage=state.copy.querySelector('img'),computed=getComputedStyle(copyImage),directChildPixelsPreserved=computed.objectFit===getComputedStyle(image).objectFit&&computed.objectPosition===getComputedStyle(image).objectPosition;if(!directChildPixelsPreserved)throw Error('ROI wrapper changes direct-child image pixels');return {nativeCropped,unsafeOptics,unsafeArtwork,directChildPixelsPreserved};
 }finally{view?.dispose();painter.remove();style.remove();defs.remove();if(cardStyle===null)card.removeAttribute('style');else card.setAttribute('style',cardStyle);if(source.outerHTML!==before)throw Error('sampling boundary validation mutates the native scene');}
};
window.checkLayerWorkshop=async()=>{
 const source=document.querySelector('body > .appearance-preview-scene'),size={width:1280,height:800},expect=(value,message)=>{if(!value)throw Error(message)};
 document.documentElement.dataset.theme='pureWhite';source.dataset.previewFocus='overview';source.dataset.workshopState='loading';
 const decoration=document.createElement('div');decoration.className='workshop-decoration';decoration.append(document.createElement('div'),document.createElement('div'));source.prepend(decoration);
 const snapshot=element=>[...element.children].map(child=>{const css=getComputedStyle(child),after=getComputedStyle(child,'::after');return {display:css.display,left:css.left,top:css.top,width:css.width,height:css.height,opacity:css.opacity,filter:css.filter,transform:css.transform,background:css.backgroundImage,mask:css.maskImage,crop:css.clipPath,after:{color:after.backgroundColor,opacity:after.opacity}}}),original=source.outerHTML,expected=JSON.stringify(snapshot(decoration)),nodes=[...source.querySelectorAll('[data-node]')].map(control=>{const r=control.getBoundingClientRect();return {id:control.dataset.node,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}});
 const view=AppearanceLayers.createAppearanceLayerView(document),input={scene:source,size,nodes,spacing:0,angles:{x:0,y:0},selected:'overview'};let nativeClone,nativeRect;
 try{
  view.sync(input);const clone=view.element.querySelector('[data-appearance-layer-scene]'),copy=clone.querySelector(':scope > .workshop-decoration');expect(Boolean(copy),'App decoration no longer matches its native direct-child selector');
  expect(JSON.stringify(snapshot(copy))===expected,'App layer or conditional tint styles change in the 3D clone');
  const copies=view.element.querySelectorAll('.workshop-decoration').length;expect(copies===4,'Each tight material context needs one small native App decoration copy');for(const context of view.element.querySelectorAll('[data-appearance-material-scene]'))expect(JSON.stringify(snapshot(context.querySelector(':scope > .workshop-decoration')))===expected,'Glass sampling loses the compiled App layer styles');
  const sourceUnchanged=source.outerHTML===original;expect(sourceUnchanged,'App layer cloning changed its source');view.setPose({spacing:56});expect(copy.style.transform===clone.querySelector('[data-appearance-layer="background"]').style.transform,'App decoration does not follow the background pose');
  nativeClone=Node.prototype.cloneNode;nativeRect=Element.prototype.getBoundingClientRect;let pointerClones=0,pointerSourceMeasures=0;Node.prototype.cloneNode=function(deep){pointerClones++;return nativeClone.call(this,deep)};Element.prototype.getBoundingClientRect=function(){if(this===source||source.contains(this))pointerSourceMeasures++;return nativeRect.call(this)};
  for(let frame=0;frame<60;frame++)view.setTilt({x:Math.sin(frame/10)*4,y:Math.cos(frame/10)*6});Node.prototype.cloneNode=nativeClone;Element.prototype.getBoundingClientRect=nativeRect;nativeClone=nativeRect=null;
  source.removeAttribute('data-workshop-state');view.sync({...input,revision:1});const conditionRestored=getComputedStyle(view.element.querySelector('[data-appearance-layer-scene] > .workshop-decoration > :nth-child(2)')).display==='none';expect(conditionRestored,'Native App layer state conditions no longer hide inactive layers');
  return {copies,sourceUnchanged,conditionRestored,pointerClones,pointerSourceMeasures};
 }finally{if(nativeClone)Node.prototype.cloneNode=nativeClone;if(nativeRect)Element.prototype.getBoundingClientRect=nativeRect;view.dispose();decoration.remove();source.removeAttribute('data-workshop-state')}
};
window.configureWorkshopPaint=async(mode)=>{
 const source=document.querySelector('body > .appearance-preview-scene');materialView?.dispose();source.style.visibility='';source.dataset.previewFocus='overview';
 let decoration=source.querySelector(':scope > .workshop-decoration');if(!decoration){decoration=document.createElement('div');decoration.className='workshop-decoration';decoration.append(document.createElement('div'));source.prepend(decoration)}decoration.style.display=mode==='empty'?'none':'';
 if(mode==='layered'){const nodes=[...source.querySelectorAll('[data-node]')].map(control=>{const r=control.getBoundingClientRect();return {id:control.dataset.node,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}});materialView=AppearanceLayers.createAppearanceLayerView(document);materialView.sync({scene:source,size:{width:1280,height:800},nodes,spacing:0,angles:{x:0,y:0},selected:'overview'});source.style.visibility='hidden'}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {viewport:{width:innerWidth,height:innerHeight},regions:[{id:'workshop',points:[{x:600,y:44},{x:1000,y:44},{x:1000,y:48},{x:600,y:48}]}]};
};
window.configureNativeAppTint=async(mode,tone,transparent)=>{
 const source=document.querySelector('body > .appearance-preview-scene');materialView?.dispose();source.style.visibility='';source.dataset.previewFocus='overview';document.documentElement.dataset.theme=tone;document.documentElement.dataset.windowTransparent=transparent?'on':'off';
 document.documentElement.style.setProperty('--te-titlebar-inset','40px');document.documentElement.style.setProperty('--te-app-bg',tone==='dark'?'#17181a':'#f4f4f7');document.documentElement.style.setProperty('--te-shell-control-text',tone==='dark'?'#eeeeee':'#181818');
 document.documentElement.style.setProperty('--te-window-foundation-tint','rgb(0 0 0 / 10%)');
 let style=document.querySelector('#native-app-tint-style');if(!style){style=document.createElement('style');style.id='native-app-tint-style';style.textContent=JSON.parse(document.querySelector('#native-app-css').textContent);document.head.append(style)}
 const decoration=source.querySelector(':scope > .workshop-decoration');decoration.style.display=mode==='empty'?'none':'';const before=source.outerHTML;
 let sourceUnchanged=true;if(mode==='layered'){const nodes=[...source.querySelectorAll('[data-node]')].map(control=>{const r=control.getBoundingClientRect();return {id:control.dataset.node,rect:{left:r.left,top:r.top,width:r.width,height:r.height}}});materialView=AppearanceLayers.createAppearanceLayerView(document);materialView.sync({scene:source,size:{width:1280,height:800},nodes,spacing:0,angles:{x:0,y:0},selected:'overview'});sourceUnchanged=source.outerHTML===before;source.style.visibility='hidden'}
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return {viewport:{width:innerWidth,height:innerHeight},nativeTint:getComputedStyle(source,'::before').backgroundColor,tintCopies:mode==='layered'?materialView.element.querySelectorAll('[data-appearance-app-tint]').length:0,sourceUnchanged,regions:[{id:'native-app-tint',points:[{x:1180,y:45.5},{x:1220,y:45.5},{x:1220,y:48.5},{x:1180,y:48.5}]}]};
};
`
const browserProjectionRunner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));
let width,height;
function bitmap(image){const png=image.toPNG();width=png.readUInt32BE(16);height=png.readUInt32BE(20);const pixels=image.toBitmap();if(pixels.length!==width*height*4)throw Error('Screenshot bitmap does not match its native pixel dimensions');return pixels}
function compare(first,second,state,includeCard=false){
 return [...state.regions,...(includeCard?[state.card]:[])].map(rect=>{
  let delta=0,count=0;const sums=[0,0,0],next=[0,0,0],ratio=width/state.viewport.width,[a,b,c,d]=rect.points;
  // Sample the painted quad, not its enclosing rectangle or an adjacent glass
  // surface. In a rotated thin bar most of that rectangle is empty space.
  for(let row=0;row<12;row++)for(let column=0;column<64;column++){
   const u=.4+column/63*.4,v=rect.id==='navigation'?.7+row/11*.15:.3+row/11*.4,x=Math.round(((1-u)*(1-v)*a.x+u*(1-v)*b.x+u*v*c.x+(1-u)*v*d.x)*ratio),y=Math.round(((1-u)*(1-v)*a.y+u*(1-v)*b.y+u*v*c.y+(1-u)*v*d.y)*ratio);
   if(x<0||y<0||x>=width||y>=height)continue;
   for(let channel=0;channel<3;channel++){const at=(y*width+x)*4+channel;delta+=Math.abs(first[at]-second[at]);sums[channel]+=first[at];next[channel]+=second[at];count++}
  }
  return {id:rect.id,meanDelta:count?delta/count:0,meanColorDelta:count?sums.reduce((sum,value,channel)=>sum+Math.abs(value-next[channel]),0)/count:0};
 })
}
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));console.log('LAYER_PROJECTION',JSON.stringify(await win.webContents.executeJavaScript('window.checkLayerProjection()')));
 const samples=[];
 for(const mode of ['flat','layered'])for(const [background,opaque]of [['striped',false],['solid',false],['striped',true]]){
  const images=[];let state;
  for(const blur of [0,30]){state=await win.webContents.executeJavaScript('window.configureLayerMaterial('+JSON.stringify(mode)+','+blur+','+JSON.stringify(background)+','+opaque+')');await new Promise(resolve=>setTimeout(resolve,40));images.push(bitmap(await win.webContents.capturePage()))}
  samples.push({mode,background,opaque,contexts:state.contexts,regions:compare(images[0],images[1],state)})
 }
 const colors=[];
 for(const selected of ['overview','card','background']){
  const args=',30,"solid",false,true,'+JSON.stringify(selected)+')';
  const source=await win.webContents.executeJavaScript('window.configureLayerMaterial("flat"'+args),before=bitmap(await win.webContents.capturePage()),layered=await win.webContents.executeJavaScript('window.configureLayerMaterial("layered"'+args),during=bitmap(await win.webContents.capturePage());
  await win.webContents.executeJavaScript('window.restoreLayerMaterial()');const after=bitmap(await win.webContents.capturePage());
  colors.push({selected,visibleContexts:layered.visibleContexts,collapsed:compare(before,during,layered,true),roundtrip:compare(before,after,source,true)})
 }
 const background={cases:[]},backgroundImages=[];let backgroundState;
 for(const mode of ['flat','layered']){const beforeState=await win.webContents.executeJavaScript('window.backgroundLayerPaint('+JSON.stringify(mode)+',"overview")'),before=bitmap(await win.webContents.capturePage());backgroundState=await win.webContents.executeJavaScript('window.backgroundLayerPaint('+JSON.stringify(mode)+',"background")');const after=bitmap(await win.webContents.capturePage()),differences=compare(before,after,backgroundState,true);backgroundImages.push(after);background.cases.push({mode,pageOpacity:backgroundState.pageOpacity,ambientOpacity:backgroundState.ambientOpacity,foregroundOpacity:backgroundState.foregroundOpacity,background:differences[0],foreground:differences[1]});}
 background.flatLayeredDifference=compare(backgroundImages[0],backgroundImages[1],backgroundState)[0].meanDelta;console.log('LAYER_BACKGROUND',JSON.stringify(background));
 await win.webContents.executeJavaScript('window.configureLayerMaterial("layered",30)');
 const lifecycle=await win.webContents.executeJavaScript('window.checkLayerMaterialLifecycle()');console.log('LAYER_MATERIAL',JSON.stringify({samples,colors,lifecycle}));const sampling=await win.webContents.executeJavaScript('window.checkSamplingBoundaries()');console.log('LAYER_SAMPLING',JSON.stringify({...sampling,sourceRestored:true}));const workshop=await win.webContents.executeJavaScript('window.checkLayerWorkshop()'),paint=[];let paintState;for(const mode of ['empty','flat','layered']){paintState=await win.webContents.executeJavaScript('window.configureWorkshopPaint('+JSON.stringify(mode)+')');paint.push(bitmap(await win.webContents.capturePage()))}workshop.paintChanged=compare(paint[0],paint[1],paintState)[0].meanDelta;workshop.paintRestored=compare(paint[1],paint[2],paintState)[0].meanDelta;
 workshop.nativeTints=[];for(const tone of ['dark','pureWhite'])for(const transparent of [false,true]){const images=[];let nativeState;for(const mode of ['empty','flat','layered','flat']){nativeState=await win.webContents.executeJavaScript('window.configureNativeAppTint('+JSON.stringify(mode)+','+JSON.stringify(tone)+','+transparent+')');images.push(bitmap(await win.webContents.capturePage()));if(mode==='layered')var layeredTintState=nativeState}workshop.nativeTints.push({tone,transparent,nativeTint:nativeState.nativeTint,tintCopies:layeredTintState.tintCopies,sourceUnchanged:layeredTintState.sourceUnchanged,visiblePaintDifference:compare(images[0],images[1],nativeState)[0].meanDelta,collapsedDifference:compare(images[1],images[2],nativeState)[0].meanDelta,roundtripDifference:compare(images[1],images[3],nativeState)[0].meanDelta})}console.log('LAYER_WORKSHOP',JSON.stringify(workshop));win.destroy();app.exit(0)
}catch(error){console.error(error);win?.destroy();app.exit(1)}});
`
