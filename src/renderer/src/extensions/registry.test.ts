import assert from 'node:assert/strict'
import test from 'node:test'
import type { CoreBridgeApi } from '../../../shared/coreBridge.ts'
import type { CoreSnapshot } from '../../../shared/coreProtocol.ts'
import type { InstalledExperience } from '../../../shared/pluginExperience.ts'
import { disposeCoreConnection, useCoreConnection } from '../stores/coreConnection.ts'
import { useExtensionRegistry } from './registry.ts'

test('registry separates widgets and panels from navigation/startup pages and retires disabled widgets', async () => {
  const base: InstalledExperience = {
    pluginId: 'com.example.devices',
    id: 'battery',
    name: 'Battery',
    version: '1.0.0',
    entry: 'ui/index.html',
    url: 'plugin-ui://com.example.devices/1.0.0/ui/index.html',
    bridgeVersion: 2,
    permissions: ['ui:inject']
  }
  let experiences: InstalledExperience[] = [
    { ...base, id: 'page' },
    { ...base, launch: 'sidebar', sidebar: { height: 128 } },
    { ...base, id: 'panel', launch: 'panel' }
  ]
  const api: CoreBridgeApi = {
    connect: async () => ({
      ok: true,
      value: {
        connectionId: 'widgets',
        snapshot: {
          protocolVersion: 1,
          epoch: 'widgets',
          sequence: 0,
          phase: 'ready'
        } as CoreSnapshot
      }
    }),
    request: async (_id, request) => ({
      ok: true,
      value: request.name === 'extensions.experiences' ? experiences : []
    }),
    cancel: async () => ({ ok: true, value: undefined }),
    disconnect: async () => ({ ok: true, value: undefined }),
    onMessage: () => () => {},
    onStatus: () => () => {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { core: api } } })
  try {
    await useCoreConnection().attach()
    const registry = useExtensionRegistry({ listen: false })
    await registry.syncExtensions()
    assert.deepEqual(
      registry.uiContributions.value.map((entry) => entry.id),
      ['page']
    )
    assert.deepEqual(registry.sidebarExperiences.value, [experiences[1]])
    assert.equal(registry.experiences.value.length, 3)
    experiences = experiences.map((entry) => ({ ...entry, version: '2.0.0' }))
    await registry.syncExtensions()
    assert.equal(registry.sidebarExperiences.value[0].version, '2.0.0')
    experiences = []
    await registry.syncExtensions()
    assert.deepEqual(registry.sidebarExperiences.value, [])
    assert.deepEqual(registry.uiContributions.value, [])
  } finally {
    disposeCoreConnection()
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
