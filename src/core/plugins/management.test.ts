import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorePluginManagement } from './management.ts'
import type { TwilightPluginDescriptor, TwilightPluginManifest } from '../../shared/pluginTypes.ts'

const manifest: TwilightPluginManifest = { id: 'com.example.fixture', name: 'Fixture', version: '1.0.0',
  description: 'Test', author: 'Tests', license: 'MIT', type: ['tool'], permissions: [],
  engines: { twilightEcho: '*' }, apiVersion: 4 }

test('preview cancellation and disconnect retire the owning candidate without activation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-plugin-management-'))
  let activations = 0, cancelled = 0
  const management = new CorePluginManagement({ uploadRoot: join(directory, 'uploads'), appVersion: '1.4.0', remoteEnabled: true, headless: true,
    manager: {
      list: async () => [], editManaged: async () => {},
      installFromPath: async (path, options) => {
        assert.equal(await readFile(path, 'utf8'), 'fixture')
        if (!await options!.confirm!(manifest, {} as never)) { cancelled++; throw new Error('Cancelled') }
        options!.signal!.throwIfAborted(); activations++
        return { plugin: { ...manifest, enabled: false } as TwilightPluginDescriptor, warning: 'Test fixture' }
      }
    } })
  t.after(async () => { await management.shutdown(); await rm(directory, { recursive: true, force: true }) })
  await management.initialize()
  const preview = async (owner: string) => {
    const upload = await management.begin(owner, false, { fileName: 'fixture.tep', byteSize: 7 })
    await assert.rejects(management.chunk('other', false, upload.uploadId, 0, Buffer.from('fixture').toString('base64')), { code: 'NOT_FOUND' })
    await management.chunk(owner, false, upload.uploadId, 0, Buffer.from('fixture').toString('base64'))
    return management.preview(owner, false, upload.uploadId, new AbortController().signal)
  }
  const first = await preview('one'), second = await preview('two')
  assert.equal(activations, 0)
  assert.deepEqual(await readdir(join(directory, 'uploads')), [])
  await assert.rejects(management.install('other', false, first.previewId, new AbortController().signal), { code: 'NOT_FOUND' })
  await management.disconnect('one')
  assert.equal(cancelled, 1)
  await assert.rejects(management.install('one', false, first.previewId, new AbortController().signal), { code: 'NOT_FOUND' })
  await management.install('two', false, second.previewId, new AbortController().signal)
  assert.equal(activations, 1)
  const third = await preview('three')
  await management.cancel('three', third.previewId)
  assert.equal(cancelled, 2)
})
