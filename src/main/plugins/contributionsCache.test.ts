import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  loadPluginContributionsCache,
  savePluginContributionsCache,
  type PluginContributionsCacheFile
} from './contributionsCache.ts'

const cache: PluginContributionsCacheFile = {
  'com.example.provider': {
    version: '1.2.3',
    mainSignature: '1024:1700000000000',
    providers: [
      {
        id: 'demo',
        name: 'Demo',
        capabilities: ['search', 'playbackUrl'],
        supportedMethods: ['searchSongs', 'getPlaybackUrl'],
        ui: { icon: 'pi pi-star', authType: 'qr' }
      }
    ],
    ui: [{ id: 'demo-page', kind: 'sidebarPage', title: 'Demo', command: 'demo.open' }],
    subscriptions: ['player:trackChange']
  }
}

test('plugin contributions cache round-trips provider and UI registrations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-contrib-'))
  try {
    const file = join(dir, 'plugin-contributions.json')
    await savePluginContributionsCache(file, cache)
    const loaded = await loadPluginContributionsCache(file)
    assert.equal(loaded['com.example.provider'].version, '1.2.3')
    assert.deepEqual(
      loaded['com.example.provider'].providers.map((provider) => provider.id),
      ['demo']
    )
    assert.deepEqual(loaded['com.example.provider'].providers[0].supportedMethods, [
      'searchSongs',
      'getPlaybackUrl'
    ])
    assert.equal(loaded['com.example.provider'].providers[0].ui?.authType, 'qr')
    assert.deepEqual(loaded['com.example.provider'].ui[0].command, 'demo.open')
    assert.deepEqual(loaded['com.example.provider'].subscriptions, ['player:trackChange'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plugin contributions cache drops malformed entries instead of trusting them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-contrib-'))
  try {
    const file = join(dir, 'plugin-contributions.json')
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        plugins: {
          'com.example.ok': {
            version: '1.0.0',
            mainSignature: '10:20',
            providers: [{ id: 'ok', name: 'Ok', capabilities: ['search'] }],
            ui: [],
            subscriptions: []
          },
          'com.example.bad-provider': {
            version: '1.0.0',
            mainSignature: '10:20',
            providers: [{ id: 'Bad Id', name: 'Bad', capabilities: ['search'] }],
            ui: [],
            subscriptions: []
          },
          'com.example.bad-ui': {
            version: '1.0.0',
            mainSignature: '10:20',
            providers: [],
            ui: [{ id: 'x', kind: 'not-a-kind', title: 'X' }],
            subscriptions: []
          },
          'com.example.no-version': {
            mainSignature: '10:20',
            providers: [],
            ui: [],
            subscriptions: []
          },
          'com.example.no-signature': {
            version: '1.0.0',
            providers: [],
            ui: [],
            subscriptions: []
          }
        }
      })
    )
    const loaded = await loadPluginContributionsCache(file)
    assert.deepEqual(Object.keys(loaded), ['com.example.ok'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plugin contributions cache treats missing, corrupt, or foreign-schema files as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'te-contrib-'))
  try {
    const file = join(dir, 'plugin-contributions.json')
    assert.deepEqual(await loadPluginContributionsCache(file), {})
    await writeFile(file, '{not json')
    assert.deepEqual(await loadPluginContributionsCache(file), {})
    await writeFile(file, JSON.stringify({ schemaVersion: 99, plugins: cache }))
    assert.deepEqual(await loadPluginContributionsCache(file), {})
    await savePluginContributionsCache(file, cache)
    assert.match(await readFile(file, 'utf-8'), /"schemaVersion": 1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
