import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('loading DSP and model-pack services keeps ZIP dependencies out of the idle Core', () => {
  const adapter = new URL('../../adapters-node/index.ts', import.meta.url).href
  const profiles = new URL('./dspProfileArchive.ts', import.meta.url).href
  const installer = new URL('./autoMixStemInstaller.ts', import.meta.url).href
  const script = `
    import { createRequire } from 'node:module'
    await import(${JSON.stringify(adapter)})
    const require = createRequire(import.meta.url)
    const { createDspProfile } = await import(${JSON.stringify(profiles)})
    const { validateStemArchivePath } = await import(${JSON.stringify(installer)})
    const profile = createDspProfile({ id: 'test', name: 'Idle', scenes: [], pinnedSceneId: null, assetIds: [] })
    validateStemArchivePath('manifest.json')
    console.log(JSON.stringify({ name: profile.name, modules: Object.keys(require.cache) }))
  `
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      cwd: new URL('../../../', import.meta.url),
      encoding: 'utf8',
      windowsHide: true
    }
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout) as { name: string; modules: string[] }
  assert.equal(output.name, 'Idle')
  assert.deepEqual(
    output.modules.filter((path) => /[/\\](?:yauzl|extract-zip|buffer-crc32)[/\\]/.test(path)),
    []
  )
})
