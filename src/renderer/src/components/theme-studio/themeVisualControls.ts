export type StudioColor = { hex: string; opacity: number }

export function parseStudioColor(value: string): StudioColor | null {
  if (value === 'transparent') return { hex: '#000000', opacity: 0 }
  const hex = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1]
  if (hex) {
    const expanded = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex
    return {
      hex: `#${expanded.slice(0, 6)}`,
      opacity: expanded.length === 8 ? Math.round(parseInt(expanded.slice(6), 16) / 2.55) : 100
    }
  }
  const rgb = value.match(
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/i
  )
  if (!rgb) return null
  const channels = rgb.slice(1, 4).map(Number)
  if (channels.some((channel) => channel > 255)) return null
  const alpha = rgb[4] == null ? 1 : Number(rgb[4]) / (rgb[5] ? 100 : 1)
  if (alpha > 1) return null
  return {
    hex: `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`,
    opacity: Math.round(alpha * 100)
  }
}

export function studioColorValue(color: StudioColor): string {
  if (color.opacity === 100) return color.hex
  const channels = [1, 3, 5].map((index) => parseInt(color.hex.slice(index, index + 2), 16))
  return `rgba(${channels.join(', ')}, ${color.opacity / 100})`
}

const colorPattern = /#[\da-f]{3,8}\b|rgba?\([^()]+\)|transparent/gi

export function gradientColors(value: string): string[] {
  return value.match(colorPattern) ?? []
}

export function replaceGradientColor(value: string, index: number, color: string): string {
  let current = 0
  return value.replace(colorPattern, (match) => (current++ === index ? color : match))
}

export function gradientAngle(value: string): number {
  const direction = value.match(/^linear-gradient\(\s*([^,]+),/)?.[1]
  if (direction?.endsWith('deg')) return parseFloat(direction)
  return { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }[direction ?? ''] ?? 180
}

export function replaceGradientAngle(value: string, angle: number): string {
  return value.replace(
    /^linear-gradient\(\s*(?:(?:-?[\d.]+deg|to [a-z ]+)\s*,\s*)?/,
    `linear-gradient(${angle}deg, `
  )
}

export const studioShadowOptions = [
  { label: '无阴影', value: 'none' },
  { label: '轻微', value: '0 2px 8px rgba(0, 0, 0, 0.12)' },
  { label: '柔和', value: '0 10px 28px rgba(0, 0, 0, 0.2)' },
  { label: '明显', value: '0 20px 54px rgba(0, 0, 0, 0.35)' }
]

export const studioEasingOptions = [
  { label: '匀速', value: 'linear' },
  { label: '平滑', value: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  { label: '轻快', value: 'cubic-bezier(0.22, 1, 0.36, 1)' }
]

const studioLabels: Record<string, string> = {
  'background.overlayOpacity': '背景遮暗程度',
  'shell.control.text': '窗口按钮颜色',
  'shell.control.hoverSurface': '窗口按钮指向时的底色',
  'navigation.indicator': '当前菜单标记',
  'library.selection.indicator': '选中歌曲标记',
  'library.titleOverlayOpacity': '标题底色不透明度',
  'material.surfaceOpacity': '面板不透明度',
  'material.cardSaturation': '卡片色彩鲜艳度',
  'typography.rounded': '歌词字体',
  'typography.sans': '正文字体',
  'typography.metaWeight': '辅助文字粗细',
  'playback.cover.surface': '封面底色',
  'playback.backdrop.scrim': '播放页背景遮暗',
  'motion.enter': '进入动画节奏',
  'motion.soft': '切换动画节奏',
  'color.neutral.50': '底层背景',
  'color.neutral.200': '细边框颜色',
  'color.neutral.300': '明显边框颜色',
  'color.neutral.700': '辅助正文颜色'
}

export const studioModeLabels: Record<string, string> = {
  'appearance.accentSource': '主题色',
  'appearance.backgroundTreatment': '背景样式',
  'appearance.toneScheduling': '自动切换深浅色',
  'appearance.contrastGuard': '文字可读性',
  'appearance.effectsMode': '背景特效',
  'navigation.style': '侧边栏样式',
  'navigation.iconScale': '侧边栏图标大小',
  'navigation.logo': '显示播放器标志',
  'library.density': '歌曲列表间距',
  'library.selection': '歌曲选中样式',
  'library.titleOverlay': '显示标题底色',
  'player.layout': '播放器布局',
  'player.controls': '播放按钮样式',
  'player.titleAlign': '歌曲标题对齐',
  'player.progress': '播放进度条样式',
  'artwork.transition': '切歌时的封面动画',
  'artwork.shadow': '显示封面阴影',
  'equalizer.panel': '均衡器背景',
  'equalizer.slider': '均衡器滑块形状',
  'equalizer.knob': '旋钮标记',
  'equalizer.spectrum': '频谱样式',
  'equalizer.button': '均衡器按钮样式',
  'icons.family': '图标样式',
  'typography.titleCase': '英文标题大小写',
  'typography.lyricAccent': '歌词使用主题色',
  'typography.titleColor': '主题色文字'
}

export function studioTokenLabel(label: string, id = ''): string {
  if (studioLabels[id]) return studioLabels[id]
  return label
    .replace('媒体库页面表面', '媒体库背景')
    .replace(/媒体库列表/g, '歌曲列表')
    .replace(/媒体库行/g, '歌曲')
    .replace(/媒体库选中/g, '选中歌曲')
    .replace(/主强调色/g, '主题色')
    .replace(/字重/g, '文字粗细')
    .replace(/悬浮/g, '指向时')
    .replace(/准线/g, '参考线')
    .replace(/表面/g, '底色')
    .replace(/令牌/g, '外观值')
}

export function studioTokenGroup(id: string): string {
  if (id.startsWith('playback.lyrics.')) return '歌词颜色'
  if (id.startsWith('playback.equalizer.')) return '均衡器'
  if (id.startsWith('playback.control.')) return '播放按钮'
  if (id.startsWith('playback.progress.') || id.startsWith('playback.time.')) return '进度与时间'
  if (id.startsWith('playback.track.') || id.startsWith('playback.text.')) return '歌曲信息'
  if (id.startsWith('playback.cover.') || id.startsWith('playback.artwork.')) return '专辑封面'
  if (id.startsWith('playback.backdrop.')) return '播放页背景'
  if (id.startsWith('typography.')) return '文字外观'
  if (id.startsWith('motion.')) return '动画节奏'
  if (id.startsWith('shape.') || id.startsWith('layout.')) return '圆角与尺寸'
  if (id.startsWith('material.')) return '透明度与质感'
  if (id.startsWith('library.selection.')) return '选中歌曲'
  if (id.startsWith('library.')) return '歌曲列表'
  if (id.startsWith('navigation.')) return '侧边栏配色'
  if (id.startsWith('settings.')) return '设置页配色'
  if (id.startsWith('shell.')) return '窗口按钮'
  return '界面配色'
}

export function matchesStudioSearch(query: string, ...terms: string[]): boolean {
  const text = terms.join(' ').toLowerCase()
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
}
