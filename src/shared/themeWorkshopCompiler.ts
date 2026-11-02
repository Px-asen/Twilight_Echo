import { compileWorkshopLayers } from './themeWorkshopLayerCss.ts'
import {
  normalizeThemeTokenOverrides,
  themeTokensToCssVariables,
  themeModesToDataAttributes,
  themeShellLayoutToDataAttributes,
  themeShellLayoutToCssVariables,
  resolveThemeModes,
  type ThemeTone,
  type StructuredPluginTheme
} from './theme.ts'
import {
  WORKSHOP_IMAGE_SLOTS,
  type ThemeEditorControl,
  type ThemeEditorDescriptor
} from './themeEditor.ts'
import {
  workshopEditor,
  type WorkshopProject,
  type WorkshopCompiledTheme
} from './themeWorkshop.ts'

export function validateWorkshopValue(control: ThemeEditorControl, value: string): void {
  if (control.type === 'image') {
    if (
      value !== 'none' &&
      !/^url\(['"]?data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+['"]?\)$/.test(value)
    )
      throw new Error(`无效图片参数：${control.label}`)
    return
  }
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[{};]|url\(|@import|<\/?style/i.test(value)
  )
    throw new Error(`无效参数：${control.label}`)
  if (control.type === 'number') {
    const unit = control.unit ?? control.defaults.pureWhite.match(/[a-z%]+$/i)?.[0] ?? ''
    const raw = unit ? (value.endsWith(unit) ? value.slice(0, -unit.length) : '') : value
    const number = Number(raw)
    if (
      !raw.trim() ||
      !Number.isFinite(number) ||
      (control.min !== undefined && number < control.min) ||
      (control.max !== undefined && number > control.max)
    )
      throw new Error(`无效数值：${control.label}`)
  }
  if (
    control.type === 'color' &&
    !/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|(?:rgba?|hsla?)\([^{};]+\)|transparent|currentcolor)$/i.test(
      value
    )
  )
    throw new Error(`无效颜色：${control.label}`)
  if (
    control.token &&
    normalizeThemeTokenOverrides({ [control.token]: value })[control.token] === undefined
  )
    throw new Error(`无效标准参数：${control.label}`)
  if (control.type === 'select' && !control.options?.includes(value))
    throw new Error(`无效选项：${control.label}`)
  if (
    control.type === 'boolean' &&
    ![control.checkedValue ?? '1', control.uncheckedValue ?? '0'].includes(value)
  )
    throw new Error(`无效开关：${control.label}`)
}

function rule(
  tone: ThemeTone,
  selector: string | undefined,
  declarations: Record<string, string>
): string {
  const root = `html[data-theme='${tone}']`
  const target =
    !selector || selector === 'html' || selector === ':root' ? root : `${root} ${selector}`
  return `${target} {${Object.entries(declarations)
    .map(([key, value]) => `${key}:${value} !important`)
    .join(';')}}`
}

function workshopStructuredTheme(
  project: WorkshopProject
): Extract<StructuredPluginTheme, { schemaVersion: 3 }> {
  const source = project.base.structured
  const structured: StructuredPluginTheme = {
    ...source,
    schemaVersion: 3,
    variants: Object.fromEntries(
      (['pureWhite', 'dark'] as const).map((tone) => [
        tone,
        {
          tokens: {
            ...source?.variants[tone]?.tokens,
            ...normalizeThemeTokenOverrides(project.tokens[tone])
          }
        }
      ])
    ),
    modes: project.modes ?? (source && source.schemaVersion !== 1 ? source.modes : undefined),
    layout:
      project.layout === null
        ? undefined
        : (project.layout ?? (source?.schemaVersion === 3 ? source.layout : undefined))
  }
  return structured
}

export function compileWorkshopTheme(project: WorkshopProject): WorkshopCompiledTheme {
  const structured = workshopStructuredTheme(project)
  const replaceAssets = (value: string): string => {
    for (const asset of project.assets ?? [])
      if (asset.originalDataUrl) value = value.replaceAll(asset.originalDataUrl, asset.dataUrl)
    return value
  }
  const blocks = [replaceAssets(project.base.css)]
  const inheritedControls = new Set(project.base.editor?.controls.map((control) => control.id))
  for (const tone of ['pureWhite', 'dark'] as const) {
    blocks.push(
      rule(tone, undefined, {
        ...Object.fromEntries(
          Object.entries(project.base.variables).map(([key, value]) => [key, replaceAssets(value)])
        ),
        ...themeTokensToCssVariables(structured.variants[tone]?.tokens ?? {}),
        ...themeShellLayoutToCssVariables(structured.layout)
      })
    )
    for (const control of workshopEditor(project)?.controls ?? []) {
      const targets =
        control.targets && project.unlinked?.[control.id]
          ? Object.entries(control.targets)
          : [['', control.selector]]
      for (const [target, selector] of targets) {
        const value = project.values[tone][target ? `${control.id}.${target}` : control.id]
        const rawValue =
          value ??
          (project.editor && !inheritedControls.has(control.id)
            ? control.defaults[tone]
            : undefined)
        const effectiveValue = rawValue === undefined ? undefined : replaceAssets(rawValue)
        if (effectiveValue === undefined) continue
        validateWorkshopValue(control, effectiveValue)
        if (control.slot) {
          blocks.push(
            rule(tone, WORKSHOP_IMAGE_SLOTS[control.slot], {
              'background-image': effectiveValue,
              'background-size': 'contain',
              'background-repeat': 'no-repeat',
              'background-position': 'center'
            })
          )
          if (effectiveValue !== 'none')
            blocks.push(
              rule(tone, `${WORKSHOP_IMAGE_SLOTS[control.slot]} > *`, { visibility: 'hidden' })
            )
        } else
          blocks.push(
            rule(
              tone,
              selector,
              control.token
                ? themeTokensToCssVariables({ [control.token]: effectiveValue })
                : { [control.variable!]: effectiveValue }
            )
          )
      }
    }
  }
  for (const [family, assetId] of Object.entries(project.fonts ?? {})) {
    const asset = project.assets?.find((a) => a.id === assetId && a.type === 'font')
    if (asset)
      blocks.push(
        `@font-face{font-family:'workshop-${family}';src:url('${asset.dataUrl}') format('woff2');font-display:swap}html:root[data-theme]{--te-font-${family}:'workshop-${family}',sans-serif!important}`
      )
  }
  blocks.push(compileWorkshopLayers(project), project.css)
  return { css: blocks.join('\n'), structured, variables: {} }
}

export function compileWorkshopProject(project: WorkshopProject): string {
  return compileWorkshopTheme(project).css
}

export function workshopRuntimeAttributes(project: WorkshopProject): Record<string, string> {
  const theme = workshopStructuredTheme(project)
  return {
    ...themeModesToDataAttributes(resolveThemeModes(theme.modes)),
    ...themeShellLayoutToDataAttributes(theme.layout)
  }
}

export function exportWorkshopEditor(project: WorkshopProject): ThemeEditorDescriptor | undefined {
  const editor = workshopEditor(project)
  if (!editor) return undefined
  const controls: ThemeEditorControl[] = []
  for (const control of editor.controls) {
    const targets =
      control.targets && project.unlinked?.[control.id]
        ? Object.entries(control.targets)
        : [['', control.selector]]
    for (const [target, selector] of targets) {
      const id = target ? `${control.id}.${target}` : control.id
      controls.push({
        ...control,
        id,
        selector,
        targets: target ? undefined : control.targets,
        defaults: {
          pureWhite: project.values.pureWhite[id] ?? control.defaults.pureWhite,
          dark: project.values.dark[id] ?? control.defaults.dark
        }
      })
    }
  }
  return { schemaVersion: 1, controls }
}
