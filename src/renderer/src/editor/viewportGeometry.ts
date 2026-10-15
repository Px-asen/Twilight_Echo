export type EditorSize = { width: number; height: number }
export type EditorPoint = { x: number; y: number }
export type EditorRect = EditorSize & { left: number; top: number }
export type EditorCamera = EditorPoint & { scale: number }
export type EditorNode = {
  id: string
  rect: EditorRect
  focus?: 'part' | 'scene'
  maxScale?: number
}
export type EditorNodeDefinition<Id extends string = string> = {
  id: Id
  selector: string
  label: string
  focus?: 'part' | 'scene'
  maxScale?: number
}

export function sameEditorSize(a: EditorSize, b: EditorSize): boolean {
  return a.width === b.width && a.height === b.height
}

export function sameEditorRect(a: EditorRect, b: EditorRect): boolean {
  return a.left === b.left && a.top === b.top && sameEditorSize(a, b)
}

/** Four non-overlapping panels fade the scene outside a node, without filtering or duplicating it. */
export function editorContextRects(
  scene: EditorSize,
  target: EditorRect,
  padding = 10
): EditorRect[] {
  const left = Math.max(0, Math.min(scene.width, target.left - padding))
  const top = Math.max(0, Math.min(scene.height, target.top - padding))
  const right = Math.max(left, Math.min(scene.width, target.left + target.width + padding))
  const bottom = Math.max(top, Math.min(scene.height, target.top + target.height + padding))
  return [
    { left: 0, top: 0, width: scene.width, height: top },
    { left: 0, top: bottom, width: scene.width, height: scene.height - bottom },
    { left: 0, top, width: left, height: bottom - top },
    { left: right, top, width: scene.width - right, height: bottom - top }
  ]
}

export function projectEditorRect(rect: EditorRect, camera: EditorCamera): EditorRect {
  return {
    left: rect.left * camera.scale + camera.x,
    top: rect.top * camera.scale + camera.y,
    width: rect.width * camera.scale,
    height: rect.height * camera.scale
  }
}

// Panels are measured by the host. The viewport engine has no knowledge of their UI.
export function availableEditorRect(size: EditorSize, obstacles: EditorRect[] = []): EditorRect {
  let spaces: EditorRect[] = [
    {
      left: 12,
      top: 12,
      width: Math.max(1, size.width - 24),
      height: Math.max(1, size.height - 24)
    }
  ]
  for (const panel of obstacles) {
    spaces = spaces.flatMap((space) => {
      const right = space.left + space.width,
        bottom = space.top + space.height
      const left = Math.max(space.left, panel.left - 12),
        top = Math.max(space.top, panel.top - 12)
      const panelRight = Math.min(right, panel.left + panel.width + 12)
      const panelBottom = Math.min(bottom, panel.top + panel.height + 12)
      if (left >= panelRight || top >= panelBottom) return [space]
      return [
        { left: space.left, top: space.top, width: left - space.left, height: space.height },
        { left: panelRight, top: space.top, width: right - panelRight, height: space.height },
        { left: space.left, top: space.top, width: space.width, height: top - space.top },
        { left: space.left, top: panelBottom, width: space.width, height: bottom - panelBottom }
      ].filter((rect) => rect.width > 0 && rect.height > 0)
    })
  }
  return (
    spaces.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? {
      left: 0,
      top: 0,
      width: Math.max(1, size.width),
      height: Math.max(1, size.height)
    }
  )
}

export function fitEditorCamera(rect: EditorRect, space: EditorRect, maxScale = 2): EditorCamera {
  const padding = Math.min(20, space.width / 8, space.height / 8)
  const scale = Math.max(
    0.001,
    Math.min(
      maxScale,
      (space.width - padding * 2) / Math.max(1, rect.width),
      (space.height - padding * 2) / Math.max(1, rect.height)
    )
  )
  return {
    scale,
    x: space.left + space.width / 2 - (rect.left + rect.width / 2) * scale,
    y: space.top + space.height / 2 - (rect.top + rect.height / 2) * scale
  }
}

export function interpolateEditorCamera(
  from: EditorCamera,
  to: EditorCamera,
  progress: number
): EditorCamera {
  const t = Math.min(1, Math.max(0, progress))
  const eased = 1 - Math.pow(1 - t, 3)
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
    scale: Math.exp(Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * eased)
  }
}

export function measureEditorNodes<Id extends string>(
  document: Document,
  definitions: readonly EditorNodeDefinition<Id>[]
): EditorNode[] {
  const ids = new Set<string>()
  return definitions.flatMap((definition) => {
    if (ids.has(definition.id)) throw new Error(`Duplicate editor node: ${definition.id}`)
    ids.add(definition.id)
    let rect: DOMRect | undefined
    for (const element of document.querySelectorAll(definition.selector)) {
      const bounds = element.getBoundingClientRect()
      if (bounds.width > 0 && bounds.height > 0) {
        rect = bounds
        break
      }
    }
    if (!rect || rect.width <= 0 || rect.height <= 0) return []
    return [
      {
        ...definition,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    ]
  })
}
