import '../../adapters-node/index.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { rebaseUpgradedSettings } from './upgradeConfiguration.ts'

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-upgrade-settings-'))
  t.after(async () => {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  const source = join(root, 'source'),
    destination = join(root, 'candidate')
  await mkdir(source)
  return { root, source, destination }
}

test('main, Zone and group settings and valid backups rebind only owned cache and per-session IR paths', async (t) => {
  const f = await fixture(t)
  const sessions = ['', join('zones', 'zone-test'), join('groups', 'group-test')]
  for (const session of sessions) {
    const directory = join(f.source, session)
    await mkdir(directory, { recursive: true })
    const settings = {
      cachePath: join(f.source, 'music-cache'),
      musicCachePath: join(f.source, 'cache-legacy'),
      audioProcessing: { convolverIrPath: join(directory, 'dsp-assets', 'legacy.wav') },
      dspScenes: [
        {
          name: join(directory, 'dsp-assets', 'user text'),
          graph: {
            nodes: [
              {
                type: 'convolver',
                params: { impulseResponsePath: join(directory, 'dsp-assets', 'graph.wav') }
              },
              {
                type: 'convolver',
                params: { impulseResponsePath: join(f.root, 'external', 'ir.wav') }
              }
            ]
          }
        }
      ],
      libraryFolders: [join(f.source, 'music-that-stays-here')],
      downloadFolder: join(f.source, 'downloads-that-stay-here'),
      pluginPath: join(f.source, 'plugins-that-stay-here')
    }
    for (const suffix of ['', '.bak'])
      await writeFile(join(directory, 'settings.json') + suffix, JSON.stringify(settings))
  }
  await cp(f.source, f.destination, { recursive: true })
  await rebaseUpgradedSettings(f.source, f.destination)
  for (const session of sessions) {
    for (const suffix of ['', '.bak']) {
      const before = JSON.parse(
        await readFile(join(f.source, session, 'settings.json') + suffix, 'utf8')
      )
      const after = JSON.parse(
        await readFile(join(f.destination, session, 'settings.json') + suffix, 'utf8')
      )
      const expected = structuredClone(before)
      expected.cachePath = join(f.destination, 'music-cache')
      expected.musicCachePath = join(f.destination, 'cache-legacy')
      expected.audioProcessing.convolverIrPath = join(
        f.destination,
        session,
        'dsp-assets',
        'legacy.wav'
      )
      expected.dspScenes[0].graph.nodes[0].params.impulseResponsePath = join(
        f.destination,
        session,
        'dsp-assets',
        'graph.wav'
      )
      assert.deepEqual(after, expected)
    }
  }
})

test('external caches and sibling stores stay external; an already invalid backup stays intact', async (t) => {
  const f = await fixture(t)
  const settings = {
    cachePath: join(f.root, 'external-cache'),
    musicCachePath: join(f.source + '-sibling', 'music-cache'),
    audioProcessing: { convolverIrPath: join(f.source + '-sibling', 'dsp-assets', 'ir.wav') }
  }
  await writeFile(join(f.source, 'settings.json'), JSON.stringify(settings))
  await writeFile(join(f.source, 'settings.json.bak'), '{invalid backup')
  await cp(f.source, f.destination, { recursive: true })
  await rebaseUpgradedSettings(f.source, f.destination)
  assert.deepEqual(
    JSON.parse(await readFile(join(f.destination, 'settings.json'), 'utf8')),
    settings
  )
  assert.equal(await readFile(join(f.destination, 'settings.json.bak'), 'utf8'), '{invalid backup')
})

test('backup recovery changes only the clone and both corrupt copies refuse an upgrade', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.source, 'settings.json'), '{invalid current')
  await writeFile(
    join(f.source, 'settings.json.bak'),
    JSON.stringify({ cachePath: join(f.source, 'cache') })
  )
  await cp(f.source, f.destination, { recursive: true })
  await rebaseUpgradedSettings(f.source, f.destination)
  assert.equal(await readFile(join(f.source, 'settings.json'), 'utf8'), '{invalid current')
  for (const suffix of ['', '.bak'])
    assert.equal(
      JSON.parse(await readFile(join(f.destination, 'settings.json') + suffix, 'utf8')).cachePath,
      join(f.destination, 'cache')
    )
  assert.equal(
    await readFile(join(f.destination, 'settings.json.corrupt'), 'utf8'),
    '{invalid current'
  )
  const corrupt = join(f.root, 'both-corrupt')
  await mkdir(corrupt)
  await writeFile(join(corrupt, 'settings.json'), '{bad current')
  await writeFile(join(corrupt, 'settings.json.bak'), '{bad backup')
  await assert.rejects(rebaseUpgradedSettings(f.source, corrupt), /配置及其备份损坏/)
  assert.equal(await readFile(join(corrupt, 'settings.json'), 'utf8'), '{bad current')
})
