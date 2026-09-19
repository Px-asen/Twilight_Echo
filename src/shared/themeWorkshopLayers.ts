export const WORKSHOP_SURFACES = [
  { id: 'app', label: '整个窗口' },
  { id: 'local.home', label: '本地首页' },
  { id: 'streaming.home', label: '流媒体首页' },
  { id: 'local.library', label: '本地歌曲列表' },
  { id: 'streaming.library', label: '流媒体歌曲列表' },
  { id: 'settings', label: '设置' },
  { id: 'player', label: '播放栏' }
] as const

export type WorkshopSurface = (typeof WORKSHOP_SURFACES)[number]['id']
export const WORKSHOP_LAYER_LIMIT = 8
export const WORKSHOP_LAYER_STATES = ['always', 'empty', 'loading', 'done', 'listening'] as const

export interface WorkshopLayer {
  id: string
  name: string
  kind: 'image' | 'gradient'
  assetId?: string
  visible: boolean
  condition: (typeof WORKSHOP_LAYER_STATES)[number]
  attachment: 'fixed' | 'scroll'
  x: number
  y: number
  width: number
  height: number
  scale: number
  fit: 'cover' | 'contain'
  opacity: number
  blur: number
  rotation: number
  colorStart: string
  colorEnd: string
  angle: number
  maskColor: string
  maskOpacity: number
  fade: { top: number; right: number; bottom: number; left: number }
  crop: { top: number; right: number; bottom: number; left: number }
}

export function createWorkshopLayer(id: string, kind: WorkshopLayer['kind']): WorkshopLayer {
  return {
    id,
    name: kind === 'image' ? '图片图层' : '渐变图层',
    kind,
    visible: true,
    condition: 'always',
    attachment: 'fixed',
    x: 50,
    y: 50,
    width: 100,
    height: 100,
    scale: 1,
    fit: 'cover',
    opacity: 1,
    blur: 0,
    rotation: 0,
    colorStart: '#e1f2ef',
    colorEnd: '#b8d9e8',
    angle: 135,
    maskColor: '#ffffff',
    maskOpacity: 0,
    fade: { top: 0, right: 0, bottom: 0, left: 0 },
    crop: { top: 0, right: 0, bottom: 0, left: 0 }
  }
}

const inRange = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

export function isWorkshopLayer(value: unknown): value is WorkshopLayer {
  if (!value || typeof value !== 'object') return false
  const layer = value as WorkshopLayer
  if (
    typeof layer.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(layer.id) ||
    typeof layer.name !== 'string' ||
    layer.name.length > 160 ||
    !['image', 'gradient'].includes(layer.kind) ||
    typeof layer.visible !== 'boolean' ||
    !WORKSHOP_LAYER_STATES.includes(layer.condition) ||
    !['fixed', 'scroll'].includes(layer.attachment) ||
    !['cover', 'contain'].includes(layer.fit) ||
    (layer.assetId !== undefined && typeof layer.assetId !== 'string')
  )
    return false
  if (
    !inRange(layer.x, -100, 200) ||
    !inRange(layer.y, -100, 200) ||
    !inRange(layer.width, 1, 300) ||
    !inRange(layer.height, 1, 300) ||
    !inRange(layer.scale, 0.1, 5) ||
    !inRange(layer.opacity, 0, 1) ||
    !inRange(layer.blur, 0, 40) ||
    !inRange(layer.rotation, -180, 180) ||
    !inRange(layer.angle, 0, 360) ||
    !inRange(layer.maskOpacity, 0, 1)
  )
    return false
  if (
    ![layer.colorStart, layer.colorEnd, layer.maskColor].every(
      (color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color)
    )
  )
    return false
  return [layer.fade, layer.crop].every(
    (edges) =>
      edges &&
      ['top', 'right', 'bottom', 'left'].every((edge) =>
        inRange(edges[edge as keyof typeof edges], 0, 49)
      )
  )
}
