import assert from 'node:assert/strict'
import test from 'node:test'
import type { UiContribution } from '../../extensions/registry'
import {
  groupPluginSettingsFields,
  missingRequiredPluginSettingsField,
  normalizePluginSettingsForm,
  pluginSettingsFormValues
} from './pluginSettingsForm.ts'
import { usePluginSettingsPanels } from './usePluginSettingsPanels.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function form(fields: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { kind: 'settings-form', submitCommand: 'save', fields, ...extra }
}

const panel = {
  pluginId: 'com.example',
  id: 'diy',
  kind: 'settingsPanel',
  title: 'DIY',
  command: 'open'
} as UiContribution

test('legacy text/select forms keep their shape', () => {
  const normalized = normalizePluginSettingsForm(
    form([
      { key: 'name', label: 'Name', type: 'text', value: 'x', required: true },
      { key: 'secret', label: 'Secret', type: 'password', value: 'leak' },
      { key: 'mode', label: 'Mode', type: 'select', value: 'b', options: [{ label: 'B', value: 'b' }] }
    ])
  )
  assert.ok(normalized)
  assert.equal(normalized.live, false)
  assert.equal(normalized.resetCommand, '')
  assert.deepEqual(pluginSettingsFormValues(normalized), { name: 'x', secret: '', mode: 'b' })
  assert.equal(missingRequiredPluginSettingsField(normalized, { name: ' ' })?.key, 'name')
})

test('toggle, range and color fields are normalized into safe string values', () => {
  const normalized = normalizePluginSettingsForm(
    form(
      [
        { key: 'on', label: 'On', type: 'toggle', value: true },
        { key: 'off', label: 'Off', type: 'toggle', value: 'yes' },
        { key: 'size', label: 'Size', type: 'range', min: 10, max: 20, step: 2, unit: 'px', value: '99' },
        { key: 'bad-range', label: 'Bad', type: 'range', min: 5, max: 5 },
        { key: 'color', label: 'Color', type: 'color', value: '#ABCDEF' },
        { key: 'bad-color', label: 'Bad color', type: 'color', value: 'url(x)' },
        { key: 'html', label: 'Html', type: 'html' }
      ],
      { live: true, resetCommand: 'reset' }
    )
  )
  assert.ok(normalized)
  assert.equal(normalized.live, true)
  assert.equal(normalized.resetCommand, 'reset')
  assert.deepEqual(
    normalized.fields.map((field) => field.key),
    ['on', 'off', 'size', 'color', 'bad-color']
  )
  assert.deepEqual(pluginSettingsFormValues(normalized), {
    on: 'true',
    off: 'false',
    size: '20',
    color: '#abcdef',
    'bad-color': '#000000'
  })
  const size = normalized.fields.find((field) => field.key === 'size')
  assert.deepEqual([size?.min, size?.max, size?.step, size?.unit], [10, 20, 2, 'px'])
})

test('forms are bounded to 40 fields and reject malformed envelopes', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({
    key: `f${index}`,
    label: `F${index}`,
    type: 'toggle'
  }))
  assert.equal(normalizePluginSettingsForm(form(many))?.fields.length, 40)
  assert.equal(normalizePluginSettingsForm({ kind: 'other', submitCommand: 'x', fields: many }), null)
  assert.equal(normalizePluginSettingsForm(form([])), null)
  assert.equal(normalizePluginSettingsForm({ ...(form(many) as object), submitCommand: '' }), null)
})

test('consecutive fields sharing a group render under one heading', () => {
  const normalized = normalizePluginSettingsForm(
    form([
      { key: 'a', label: 'A', type: 'toggle', group: '外观' },
      { key: 'b', label: 'B', type: 'toggle', group: '外观' },
      { key: 'c', label: 'C', type: 'toggle', group: '布局' },
      { key: 'd', label: 'D', type: 'toggle' }
    ])
  )
  assert.ok(normalized)
  assert.deepEqual(
    groupPluginSettingsFields(normalized.fields).map((group) => [
      group.title,
      group.fields.map((field) => field.key)
    ]),
    [
      ['外观', ['a', 'b']],
      ['布局', ['c']],
      ['', ['d']]
    ]
  )
})

test('live forms debounce edits into one submit and adopt the canonical values', async () => {
  const calls: Array<[string, unknown[]]> = []
  const panels = usePluginSettingsPanels(async (command, args) => {
    calls.push([command, args])
    if (command === 'open') {
      return form([{ key: 'size', label: 'Size', type: 'range', min: 0, max: 10, value: '1' }], {
        live: true
      })
    }
    return {
      message: 'ok',
      form: form([{ key: 'size', label: 'Size', type: 'range', min: 0, max: 10, value: '7' }], {
        live: true
      })
    }
  })
  await panels.runPluginSettingsPanel(panel)
  const key = panels.pluginPanelStateKey(panel)
  panels.setPluginSettingsField(panel, 'size', '3')
  panels.setPluginSettingsField(panel, 'size', '6')
  await sleep(350)
  const submits = calls.filter(([command]) => command === 'save')
  assert.equal(submits.length, 1)
  assert.deepEqual(submits[0][1], [{ size: '6' }])
  assert.equal(panels.pluginSettingsValues.value[key]?.size, '7')
  assert.equal(panels.pluginSettingsResult.value[key], 'ok')
  assert.equal(panels.runningPluginSettingsCommand.value, '')
})

test('edits made during an in-flight live submit are sent afterwards, not dropped', async () => {
  const release = { current: null as (() => void) | null }
  const submitted: unknown[] = []
  const panels = usePluginSettingsPanels(async (command, args) => {
    if (command === 'open') {
      return form([{ key: 'v', label: 'V', type: 'text', value: '' }], { live: true })
    }
    submitted.push(args[0])
    if (submitted.length === 1) {
      await new Promise<void>((resolve) => {
        release.current = resolve
      })
    }
    return '已保存'
  })
  await panels.runPluginSettingsPanel(panel)
  panels.setPluginSettingsField(panel, 'v', 'first')
  await sleep(300)
  panels.setPluginSettingsField(panel, 'v', 'second')
  await sleep(300)
  assert.equal(submitted.length, 1)
  release.current?.()
  await sleep(20)
  assert.deepEqual(submitted, [{ v: 'first' }, { v: 'second' }])
})

test('reset runs the reset command and replaces the draft', async () => {
  const panels = usePluginSettingsPanels(async (command) => {
    const value = command === 'reset' ? 'default' : 'custom'
    const next = form([{ key: 'v', label: 'V', type: 'text', value }], { resetCommand: 'reset' })
    return command === 'open' ? next : { message: '已恢复', form: next }
  })
  await panels.runPluginSettingsPanel(panel)
  const key = panels.pluginPanelStateKey(panel)
  assert.equal(panels.pluginSettingsValues.value[key]?.v, 'custom')
  await panels.resetPluginSettingsForm(panel)
  assert.equal(panels.pluginSettingsValues.value[key]?.v, 'default')
  assert.equal(panels.pluginSettingsResult.value[key], '已恢复')
})

test('autoLoad panels open once per page visit', async () => {
  const opened: string[] = []
  const panels = usePluginSettingsPanels(async (command) => {
    opened.push(command)
    return form([{ key: 'v', label: 'V', type: 'text' }])
  })
  const autoPanel = { ...panel, autoLoad: true }
  const manualPanel = { ...panel, id: 'manual', command: 'manual', autoLoad: false }
  await panels.autoLoadPluginSettingsPanels([autoPanel, manualPanel])
  await panels.autoLoadPluginSettingsPanels([autoPanel, manualPanel])
  assert.deepEqual(opened, ['open'])
})
