import type {
  PluginSettingsField,
  PluginSettingsFieldType,
  PluginSettingsForm,
  PluginSettingsOption
} from './types'

const MAX_FIELDS = 40
const MAX_OPTIONS = 30
const MAX_VALUE_LENGTH = 4096
const FIELD_TYPES: readonly PluginSettingsFieldType[] = [
  'text',
  'password',
  'url',
  'select',
  'toggle',
  'range',
  'color'
]
const HEX_COLOR = /^#[\da-f]{6}$/i

export interface PluginSettingsFieldGroup {
  title: string
  fields: PluginSettingsField[]
}

/**
 * Validate a plugin-supplied `settings-form` DTO. Anything malformed is
 * dropped: the host only ever renders its own controls with bounded text.
 */
export function normalizePluginSettingsForm(value: unknown): PluginSettingsForm | null {
  const record = asRecord(value)
  if (!record || record.kind !== 'settings-form') return null
  const submitCommand = normalizeCommand(record.submitCommand)
  if (!submitCommand || !Array.isArray(record.fields)) return null
  const fields = record.fields.slice(0, MAX_FIELDS).flatMap((raw) => {
    const field = normalizeField(raw)
    return field ? [field] : []
  })
  if (fields.length === 0) return null
  return {
    submitCommand,
    resetCommand: normalizeCommand(record.resetCommand),
    live: record.live === true,
    fields,
    notice: typeof record.notice === 'string' ? record.notice.slice(0, 500) : ''
  }
}

/** Initial draft values for a form; password fields always start empty. */
export function pluginSettingsFormValues(form: PluginSettingsForm): Record<string, string> {
  return Object.fromEntries(form.fields.map((field) => [field.key, field.value]))
}

/** Split fields into consecutive runs that share the same `group` heading. */
export function groupPluginSettingsFields(
  fields: readonly PluginSettingsField[]
): PluginSettingsFieldGroup[] {
  const groups: PluginSettingsFieldGroup[] = []
  for (const field of fields) {
    const last = groups.at(-1)
    if (last && last.title === field.group) last.fields.push(field)
    else groups.push({ title: field.group, fields: [field] })
  }
  return groups
}

export function missingRequiredPluginSettingsField(
  form: PluginSettingsForm,
  values: Record<string, string>
): PluginSettingsField | null {
  return form.fields.find((field) => field.required && !values[field.key]?.trim()) ?? null
}

function normalizeField(raw: unknown): PluginSettingsField | null {
  const field = asRecord(raw)
  if (!field) return null
  const key = typeof field.key === 'string' ? field.key.trim() : ''
  const label = typeof field.label === 'string' ? field.label.trim() : ''
  const type = field.type as PluginSettingsFieldType
  if (
    !/^[A-Za-z0-9_.:-]{1,80}$/.test(key) ||
    !label ||
    label.length > 100 ||
    !FIELD_TYPES.includes(type)
  ) {
    return null
  }
  const base = {
    key,
    label,
    type,
    required: field.required === true,
    placeholder: typeof field.placeholder === 'string' ? field.placeholder.slice(0, 200) : '',
    description: typeof field.description === 'string' ? field.description.slice(0, 200) : '',
    group: typeof field.group === 'string' ? field.group.trim().slice(0, 60) : '',
    options: [] as PluginSettingsOption[],
    min: 0,
    max: 0,
    step: 1,
    unit: ''
  }

  switch (type) {
    case 'select': {
      const options = normalizeOptions(field.options)
      if (options.length === 0) return null
      return { ...base, options, value: stringValue(field.value) }
    }
    case 'toggle':
      return { ...base, value: field.value === true || field.value === 'true' ? 'true' : 'false' }
    case 'color': {
      const color = typeof field.value === 'string' ? field.value.trim() : ''
      return { ...base, value: HEX_COLOR.test(color) ? color.toLowerCase() : '#000000' }
    }
    case 'range': {
      const min = finiteNumber(field.min)
      const max = finiteNumber(field.max)
      if (min === null || max === null || min >= max) return null
      const rawStep = finiteNumber(field.step)
      const step = rawStep !== null && rawStep > 0 ? rawStep : 1
      const current = finiteNumber(typeof field.value === 'string' ? Number(field.value) : field.value)
      return {
        ...base,
        min,
        max,
        step,
        unit: typeof field.unit === 'string' ? field.unit.slice(0, 8) : '',
        value: String(Math.min(max, Math.max(min, current ?? min)))
      }
    }
    case 'password':
      return { ...base, value: '' }
    default:
      return { ...base, value: stringValue(field.value) }
  }
}

function normalizeOptions(raw: unknown): PluginSettingsOption[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, MAX_OPTIONS).flatMap((rawOption): PluginSettingsOption[] => {
    const option = asRecord(rawOption)
    if (!option) return []
    const label = typeof option.label === 'string' ? option.label.trim() : ''
    const value = typeof option.value === 'string' ? option.value : ''
    if (!label || label.length > 100 || value.length > 200) return []
    return [{ label, value }]
  })
}

function normalizeCommand(value: unknown): string {
  const command = typeof value === 'string' ? value.trim() : ''
  return command.length > 0 && command.length <= 160 ? command : ''
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_VALUE_LENGTH) : ''
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
