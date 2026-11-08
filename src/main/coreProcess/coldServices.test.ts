import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('Core boot evaluates no installer, import matching, backup, duplicate or market implementation', () => {
  const entry = new URL('./entry.ts', import.meta.url).href
  const script = `
    import { registerHooks } from 'node:module'
    import { EventEmitter } from 'node:events'
    const loaded = []
    registerHooks({
      resolve(specifier, context, next) {
        try { return next(specifier, context) }
        catch (error) {
          if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier))
            return next(specifier + '.ts', context)
          throw error
        }
      },
      load(url, context, next) { loaded.push(url); return next(url, context) }
    })
    const parent = new EventEmitter(), messages = []
    parent.postMessage = message => messages.push(message)
    Object.defineProperty(process, 'parentPort', { value: parent })
    await import(${JSON.stringify(entry)})
    console.log(JSON.stringify({ loaded, messages }))
  `
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      new URL('../../../scripts/register-renderer-aliases.mjs', import.meta.url).href,
      '--input-type=module',
      '-e',
      script
    ],
    { encoding: 'utf8', windowsHide: true }
  )
  assert.equal(result.status, 0, result.stderr)
  const actual = JSON.parse(result.stdout) as { loaded: string[]; messages: { kind: string }[] }
  assert.ok(actual.messages.some((message) => message.kind === 'core:booted'))
  for (const name of [
    'audio/modelPackService',
    'audio/autoMixStemInstaller',
    'persistence/personalBackup',
    'persistence/personalBackupService',
    'settings/backupService',
    'library/duplicatesService',
    'library/libraryHealthService',
    'ncm/cloudTransferService',
    'playlists/importJobs',
    'playlists/previews',
    'playlists/fileParser',
    'plugins/marketplace',
    'plugins/indexService'
  ])
    assert.equal(
      actual.loaded.some((url) => url.endsWith(`/core/${name}.ts`)),
      false,
      name
    )
})
