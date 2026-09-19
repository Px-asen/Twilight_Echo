import { normalizeThemeShellLayout } from './themeLayout.ts'
import { normalizeStructuredPluginTheme, findUnsupportedThemeModeIds } from './theme.ts'
import { normalizeThemeEditor } from './themeEditor.ts'
import { isWorkshopLayer, WORKSHOP_SURFACES, WORKSHOP_LAYER_LIMIT } from './themeWorkshopLayers.ts'
import type { WorkshopProject } from './themeWorkshop.ts'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): boolean =>
  record(value) &&
  Object.entries(value).every(
    ([key, v]) => !['__proto__', 'constructor', 'prototype'].includes(key) && typeof v === 'string'
  )

export function isWorkshopProject(value: unknown): value is WorkshopProject {
  if (!record(value)) return false
  const p = value as unknown as WorkshopProject
  if (
    p.schemaVersion !== 1 ||
    typeof p.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(p.id) ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 0
  )
    return false
  if (
    ![p.name, p.author, p.description, p.version, p.updatedAt, p.css].every(
      (v) => typeof v === 'string'
    )
  )
    return false
  if (!p.name.trim() || p.name.length > 160 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(p.version))
    return false
  if (
    !record(p.base) ||
    ![p.base.author, p.base.license, p.base.css].every((v) => typeof v === 'string') ||
    !strings(p.base.variables)
  )
    return false
  if (p.base.structured && !normalizeStructuredPluginTheme(p.base.structured)) return false
  if (
    p.base.editor &&
    normalizeThemeEditor(p.base.editor)?.controls.length !== p.base.editor.controls?.length
  )
    return false
  if (
    !['pureWhite', 'dark'].every(
      (t) => record(p.values) && strings(p.values[t]) && record(p.tokens) && strings(p.tokens[t])
    )
  )
    return false
  if (
    p.unlinked &&
    (!record(p.unlinked) || !Object.values(p.unlinked).every((v) => typeof v === 'boolean'))
  )
    return false
  if (p.modes && (!record(p.modes) || findUnsupportedThemeModeIds(p.modes).length > 0)) return false
  if (
    p.fonts &&
    (!strings(p.fonts) ||
      Object.keys(p.fonts).some((key) => !['sans', 'display', 'rounded'].includes(key)))
  )
    return false
  if (p.layout && !normalizeThemeShellLayout(p.layout)) return false
  if (
    p.assets &&
    (!Array.isArray(p.assets) ||
      p.assets.length > 128 ||
      !p.assets.every(
        (a) =>
          record(a) &&
          ['image', 'font'].includes(a.type) &&
          [a.id, a.name, a.license, a.source].every((v) => typeof v === 'string') &&
          (a.type === 'image'
            ? /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/
            : /^data:font\/woff2;base64,[A-Za-z0-9+/=]+$/
          ).test(a.dataUrl)
      ))
  )
    return false
  if (p.layers) {
    if (!record(p.layers)) return false
    for (const tone of ['pureWhite', 'dark'] as const) {
      if (!record(p.layers[tone])) return false
      for (const [surface, layers] of Object.entries(p.layers[tone])) {
        if (
          !WORKSHOP_SURFACES.some((s) => s.id === surface) ||
          !Array.isArray(layers) ||
          layers.length > WORKSHOP_LAYER_LIMIT ||
          !layers.every(isWorkshopLayer)
        )
          return false
      }
    }
  }
  return true
}
