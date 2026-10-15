import { themeContrastRatio } from '../../../../shared/theme.ts'
import type { WorkshopDiagnostic } from '../../../../shared/themeWorkshopDiagnostics.ts'

export function inspectWorkshopPreview(
  doc: Document,
  scope: ParentNode = doc
): WorkshopDiagnostic[] {
  const view = doc.defaultView
  if (!view) return []
  const diagnostics: WorkshopDiagnostic[] = []
  const targets = [
    ['主要文字', '.main-content h2, .main-content .song-title, .main-content .track-title'],
    ['导航文字', '.side-menu button, .side-menu .menu-item'],
    ['控件文字', '.settings-preview-page button, .settings-preview-page label'],
    ['播放栏文字', '.player-bar .track-title, .player-bar .song-title, .player-bar button']
  ]
  for (const [label, selector] of targets) {
    const element = [...scope.querySelectorAll<HTMLElement>(selector)].find(
      (item) =>
        item.getBoundingClientRect().width > 0 &&
        item.textContent?.trim() &&
        !item.matches(':disabled')
    )
    if (!element) continue
    const style = view.getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    let parent: Element | null = element
    let background = 'transparent'
    let ambiguous = false
    while (parent) {
      const current = view.getComputedStyle(parent)
      if (
        current.backgroundImage !== 'none' ||
        current.filter !== 'none' ||
        current.backdropFilter !== 'none'
      )
        ambiguous = true
      const before = view.getComputedStyle(parent, '::before')
      if (before.backgroundImage !== 'none' && before.content !== 'none') ambiguous = true
      if (
        current.backgroundColor !== 'transparent' &&
        current.backgroundColor !== 'rgba(0, 0, 0, 0)'
      ) {
        background = current.backgroundColor
        break
      }
      parent = parent.parentElement
    }
    if (/rgba\([^)]*,\s*0\.\d+\)/.test(background)) ambiguous = true
    const large =
      parseFloat(style.fontSize) >= 24 ||
      (parseFloat(style.fontSize) >= 18.6667 && Number(style.fontWeight) >= 700)
    const minimum = large ? 3 : 4.5
    const ratio = ambiguous
      ? null
      : themeContrastRatio(
          style.color,
          background,
          view.getComputedStyle(doc.documentElement).backgroundColor === 'rgba(0, 0, 0, 0)'
            ? '#ffffff'
            : view.getComputedStyle(doc.documentElement).backgroundColor
        )
    const id = `preview.contrast:${label}`
    if (ratio === null)
      diagnostics.push({
        id,
        code: 'preview.manual-contrast',
        severity: 'info',
        message: `${label} 的背景包含图片、渐变或透明效果，需人工确认可读性`,
        location: { kind: 'preview', id: selector }
      })
    else if (ratio < minimum)
      diagnostics.push({
        id,
        code: 'preview.contrast',
        severity: 'warning',
        message: `${label} 实际对比度为 ${ratio.toFixed(2)}:1，建议至少 ${minimum}:1`,
        location: { kind: 'preview', id: selector }
      })
  }
  for (const selector of [
    '.app-shell-title',
    '.app-shell-navigation',
    '.app-shell-content',
    '.app-shell-player'
  ]) {
    const element = scope.querySelector<HTMLElement>(selector)
    if (!element || !element.clientWidth || !element.clientHeight) continue
    const style = view.getComputedStyle(element)
    if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue
    if (element.scrollWidth > element.clientWidth + 2)
      diagnostics.push({
        id: `preview.overflow:${selector}`,
        code: 'preview.overflow',
        severity: 'warning',
        message: `${selector.replace('.app-shell-', '')} 区域出现横向溢出，请检查布局或字体尺寸`,
        location: { kind: 'preview', id: selector }
      })
  }
  return diagnostics
}
