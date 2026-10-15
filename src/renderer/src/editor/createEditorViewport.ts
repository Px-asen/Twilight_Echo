import {
  availableEditorRect,
  fitEditorCamera,
  interpolateEditorCamera,
  projectEditorRect,
  sameEditorRect,
  sameEditorSize,
  type EditorCamera,
  type EditorNode,
  type EditorPoint,
  type EditorRect,
  type EditorSize
} from './viewportGeometry.ts'

export type EditorFrameClock = {
  now: () => number
  request: (callback: (time: number) => void) => number
  cancel: (handle: number) => void
}

/** Generic scene viewport: the adapter owns rendering, node registration and property editing. */
export function createEditorViewport(options: {
  clock: EditorFrameClock
  render: (camera: EditorCamera) => void
  motion?: (running: boolean) => void
  duration?: number
}) {
  let scene: EditorSize = { width: 1, height: 1 }
  let size: EditorSize = { width: 1, height: 1 }
  let nodes: readonly EditorNode[] = []
  let obstacles: EditorRect[] = []
  let selected: string | undefined
  let zoom = 1
  let offset: EditorPoint = { x: 0, y: 0 }
  let camera: EditorCamera = { x: 0, y: 0, scale: 1 }
  let goal = camera
  let sceneReady = false,
    viewportReady = false
  let frame = 0,
    initialized = false,
    rendered = false,
    active = true,
    animated = true,
    disposed = false
  let moving = false
  function markMoving(value: boolean): void {
    if (moving === value) return
    moving = value
    options.motion?.(value)
  }
  function stop(): void {
    if (frame) options.clock.cancel(frame)
    frame = 0
    markMoving(false)
  }
  function publish(value: EditorCamera): void {
    if (rendered && camera.x === value.x && camera.y === value.y && camera.scale === value.scale)
      return
    camera = value
    rendered = true
    options.render(value)
  }
  function move(next: EditorCamera, animate = true): void {
    if (disposed || !sceneReady || !viewportReady) return
    if (
      Math.abs(next.x - goal.x) < 0.01 &&
      Math.abs(next.y - goal.y) < 0.01 &&
      Math.abs(next.scale - goal.scale) < 0.00001 &&
      initialized
    )
      return
    stop()
    goal = next
    if (!active) return
    if (!initialized || !animated || !animate) {
      initialized = true
      publish(next)
      return
    }
    const start = { ...camera },
      started = options.clock.now()
    markMoving(true)
    const tick = (time: number): void => {
      frame = 0
      if (!active || disposed) return
      const progress = Math.min(1, (time - started) / (options.duration ?? 340))
      publish(progress >= 1 ? goal : interpolateEditorCamera(start, goal, progress))
      if (progress < 1) frame = options.clock.request(tick)
      else markMoving(false)
    }
    frame = options.clock.request(tick)
  }
  function target(): { rect: EditorRect; maxScale: number } {
    const node = nodes.find((item) => item.id === selected && item.focus !== 'scene')
    return node
      ? { rect: node.rect, maxScale: node.maxScale ?? 2 }
      : { rect: { left: 0, top: 0, ...scene }, maxScale: 2 }
  }
  function base(): EditorCamera {
    const { rect, maxScale } = target()
    return fitEditorCamera(rect, availableEditorRect(size, obstacles), maxScale)
  }
  function desired(): EditorCamera {
    const initial = base(),
      { rect } = target(),
      space = availableEditorRect(size, obstacles)
    const scale = initial.scale * zoom
    const center = { x: space.left + space.width / 2, y: space.top + space.height / 2 }
    const value = {
      scale,
      x: center.x - (rect.left + rect.width / 2) * scale + offset.x,
      y: center.y - (rect.top + rect.height / 2) * scale + offset.y
    }
    // Keep part of the selected object reachable when manually panning a magnified scene.
    const projected = projectEditorRect(rect, value)
    const visible = Math.min(32, space.width / 4, space.height / 4)
    value.x +=
      Math.max(0, space.left + visible - projected.left - projected.width) -
      Math.max(0, projected.left - space.left - space.width + visible)
    value.y +=
      Math.max(0, space.top + visible - projected.top - projected.height) -
      Math.max(0, projected.top - space.top - space.height + visible)
    return value
  }
  return {
    setScene(value: EditorSize, entries: readonly EditorNode[]): void {
      if (
        !Number.isFinite(value.width) ||
        !Number.isFinite(value.height) ||
        value.width <= 0 ||
        value.height <= 0
      )
        return
      sceneReady = true
      if (
        sameEditorSize(scene, value) &&
        nodes.length === entries.length &&
        nodes.every((node, index) => {
          const entry = entries[index]
          return (
            node.id === entry.id &&
            node.focus === entry.focus &&
            node.maxScale === entry.maxScale &&
            sameEditorRect(node.rect, entry.rect)
          )
        })
      ) {
        if (!initialized) move(desired())
        return
      }
      scene = { ...value }
      nodes = entries.map((node) => ({ ...node, rect: { ...node.rect } }))
      move(desired())
    },
    resize(value: EditorSize, panels: EditorRect[] = []): void {
      if (
        !Number.isFinite(value.width) ||
        !Number.isFinite(value.height) ||
        value.width <= 0 ||
        value.height <= 0
      )
        return
      viewportReady = true
      if (
        sameEditorSize(size, value) &&
        obstacles.length === panels.length &&
        obstacles.every((panel, index) => sameEditorRect(panel, panels[index]))
      ) {
        if (!initialized) move(desired())
        return
      }
      size = { ...value }
      obstacles = panels.map((panel) => ({ ...panel }))
      move(desired())
    },
    focus(id?: string): void {
      if (selected === id) return
      selected = id
      zoom = 1
      offset = { x: 0, y: 0 }
      move(desired())
    },
    fit(): void {
      zoom = 1
      offset = { x: 0, y: 0 }
      move(desired())
    },
    zoomBy(factor: number, anchor?: EditorPoint): void {
      if (!Number.isFinite(factor) || factor <= 0) return
      const space = availableEditorRect(size, obstacles)
      const pivot = anchor ?? { x: space.left + space.width / 2, y: space.top + space.height / 2 }
      const previous = goal
      zoom = Math.min(4, Math.max(0.35, zoom * factor))
      const scale = base().scale * zoom,
        ratio = scale / previous.scale
      offset = { x: 0, y: 0 }
      const centered = desired()
      offset = {
        x: pivot.x - (pivot.x - previous.x) * ratio - centered.x,
        y: pivot.y - (pivot.y - previous.y) * ratio - centered.y
      }
      move(desired())
    },
    panBy(delta: EditorPoint): void {
      if (frame) {
        zoom = camera.scale / base().scale
        const { rect } = target(),
          space = availableEditorRect(size, obstacles)
        offset = {
          x:
            camera.x - (space.left + space.width / 2 - (rect.left + rect.width / 2) * camera.scale),
          y: camera.y - (space.top + space.height / 2 - (rect.top + rect.height / 2) * camera.scale)
        }
      }
      offset = { x: offset.x + delta.x, y: offset.y + delta.y }
      move(desired(), false)
      const centered = base(),
        space = availableEditorRect(size, obstacles),
        { rect } = target()
      offset = {
        x:
          goal.x -
          (space.left + space.width / 2 - (rect.left + rect.width / 2) * centered.scale * zoom),
        y:
          goal.y -
          (space.top + space.height / 2 - (rect.top + rect.height / 2) * centered.scale * zoom)
      }
    },
    setAnimated(value: boolean): void {
      if (disposed || animated === value) return
      animated = value
      if (!value) {
        stop()
        if (active && initialized) publish(goal)
      }
    },
    setActive(value: boolean): void {
      if (disposed || active === value) return
      active = value
      stop()
      if (active && initialized) publish(goal)
    },
    snapshot: () => ({
      camera: { ...camera },
      goal: { ...goal },
      selected,
      zoom,
      pending: !!frame
    }),
    dispose(): void {
      disposed = true
      stop()
    }
  }
}
