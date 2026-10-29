import assert from 'node:assert/strict'
import test from 'node:test'
import type { InstalledExperience } from '../../../shared/pluginExperience.ts'
import { findFlyoutExperience, usePluginFlyout } from './usePluginFlyout.ts'

const widget: InstalledExperience = {
  id: 'battery',
  name: '设备电量',
  pluginId: 'com.example.devices',
  version: '1.0.0',
  entry: 'ui/index.html',
  url: 'plugin-ui://com.example.devices/1.0.0/ui/index.html',
  bridgeVersion: 2,
  permissions: ['ui:inject'],
  launch: 'sidebar'
}
const panel = { ...widget, id: 'assistant', launch: 'panel' as const }

test('titlebar targets still select the first panel, not a sidebar widget or full-window page', () => {
  const target = { pluginId: widget.pluginId, title: 'Assistant' }
  assert.equal(findFlyoutExperience([widget, { ...panel, launch: 'page' }, panel], target), panel)
  assert.equal(findFlyoutExperience([widget], target), null)
})

test('rail targets identify the exact widget even when one plugin contributes multiple views', () => {
  const target = { pluginId: widget.pluginId, experienceId: widget.id, title: widget.name }
  assert.equal(findFlyoutExperience([panel, widget], target), widget)
  assert.equal(findFlyoutExperience([panel], target), null)
  assert.equal(findFlyoutExperience([{ ...widget, pluginId: 'com.other.devices' }], target), null)
  assert.equal(findFlyoutExperience([{ ...widget, launch: 'page' }], target), null)
})

test('toggling a different view of the same plugin switches the flyout instead of closing it', () => {
  const flyout = usePluginFlyout()
  flyout.close()
  const first = { pluginId: widget.pluginId, title: 'Assistant' }
  const next = { pluginId: widget.pluginId, experienceId: widget.id, title: widget.name }
  flyout.toggle(first)
  flyout.toggle(next)
  assert.deepEqual(flyout.target.value, next)
  flyout.toggle(next)
  assert.equal(flyout.target.value, null)
})
