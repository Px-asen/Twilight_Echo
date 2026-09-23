import { THEME_TOKEN_DEFINITIONS, type ThemeTone } from './theme.ts'

export const WORKSHOP_IMAGE_SLOTS = {
  'navigation.home': '[data-theme-icon-slot="navigation.home"]',
  'navigation.songs': '[data-theme-icon-slot="navigation.songs"]',
  'navigation.artists': '[data-theme-icon-slot="navigation.artists"]',
  'navigation.albums': '[data-theme-icon-slot="navigation.albums"]',
  'navigation.genres': '[data-theme-icon-slot="navigation.genres"]',
  'navigation.playlists': '[data-theme-icon-slot="navigation.playlists"]',
  'navigation.folders': '[data-theme-icon-slot="navigation.folders"]',
  'navigation.recent': '[data-theme-icon-slot="navigation.recent"]',
  'navigation.analytics': '[data-theme-icon-slot="navigation.analytics"]',
  'navigation.streaming': '[data-theme-icon-slot="navigation.streaming"]',
  'navigation.radio': '[data-theme-icon-slot="navigation.radio"]',
  'navigation.import': '[data-theme-icon-slot="navigation.import"]',
  'library.empty': '[data-theme-icon-slot="library.empty"]'
} as const

export interface ThemeEditorControl {
  id: string
  label: string
  group: string
  type: 'color' | 'number' | 'select' | 'boolean' | 'image' | 'text'
  variable?: string
  token?: string
  slot?: keyof typeof WORKSHOP_IMAGE_SLOTS
  selector?: string
  targets?: { local: string; streaming: string }
  defaults: Record<ThemeTone, string>
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: string[]
  checkedValue?: string
  uncheckedValue?: string
  description?: string
}

export interface ThemeEditorDescriptor {
  schemaVersion: 1
  controls: ThemeEditorControl[]
}

const tokens = new Set(THEME_TOKEN_DEFINITIONS.map((token) => token.id))
const bounded = (value: unknown, max = 160): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const selector = (value: unknown): value is string =>
  bounded(value, 1024) && !/[{};]|<\/?style/i.test(value)

export function normalizeThemeEditor(value: unknown): ThemeEditorDescriptor | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as ThemeEditorDescriptor
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.controls)) return undefined
  const ids = new Set<string>()
  const controls: ThemeEditorControl[] = []
  for (const control of raw.controls.slice(0, 512)) {
    if (!control || typeof control !== 'object') continue
    if (
      !bounded(control.id, 100) ||
      !/^[a-zA-Z0-9._-]+$/.test(control.id) ||
      ['__proto__', 'constructor', 'prototype'].includes(control.id) ||
      ids.has(control.id) ||
      !bounded(control.label) ||
      !bounded(control.group) ||
      !['color', 'number', 'select', 'boolean', 'image', 'text'].includes(control.type)
    )
      continue
    const bindings = [control.variable, control.token, control.slot].filter((v) => v !== undefined)
    if (bindings.length !== 1) continue
    if (control.variable !== undefined && !/^--[a-zA-Z0-9_-]{1,128}$/.test(control.variable))
      continue
    if (control.token !== undefined && !tokens.has(control.token)) continue
    if (control.slot !== undefined && !Object.hasOwn(WORKSHOP_IMAGE_SLOTS, control.slot)) continue
    if (control.selector !== undefined && !selector(control.selector)) continue
    if (
      control.targets &&
      (!selector(control.targets.local) || !selector(control.targets.streaming))
    )
      continue
    if (
      !['dark', 'pureWhite'].every(
        (tone) => typeof control.defaults?.[tone as ThemeTone] === 'string'
      )
    )
      continue
    if (
      ['min', 'max', 'step'].some((key) => {
        const value = control[key as 'min' | 'max' | 'step']
        return value !== undefined && !Number.isFinite(value)
      })
    )
      continue
    if (control.min !== undefined && control.max !== undefined && control.min > control.max)
      continue
    if (control.step !== undefined && control.step <= 0) continue
    if (control.unit !== undefined && !/^(?:px|%|ms|s|deg|em|rem)?$/.test(control.unit)) continue
    if (
      control.options !== undefined &&
      (!Array.isArray(control.options) ||
        control.options.length > 64 ||
        !control.options.every((v) => bounded(v, 256)))
    )
      continue
    if (control.type === 'select' && !control.options?.length) continue
    if (control.checkedValue !== undefined && !bounded(control.checkedValue, 256)) continue
    if (control.uncheckedValue !== undefined && !bounded(control.uncheckedValue, 256)) continue
    if (control.description !== undefined && !bounded(control.description, 512)) continue
    ids.add(control.id)
    controls.push({ ...control })
  }
  return { schemaVersion: 1, controls }
}

export function workshopControlKey(
  control: ThemeEditorControl,
  unlinked: Record<string, boolean> | undefined,
  target: 'local' | 'streaming'
): string {
  return control.targets && unlinked?.[control.id] ? `${control.id}.${target}` : control.id
}
