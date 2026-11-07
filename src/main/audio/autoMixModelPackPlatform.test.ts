import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createAutoMixModelPackPlatform } from './autoMixModelPackPlatform.ts'
import { decodeWithPlatform } from '../../core/audio/modelPackService.ts'

const lzmaData = Buffer.from('Audio inference fixture\n'.repeat(1000))
const lzmaPayload = Buffer.from(
  'CQQFAF0AAIAAACCdSIa5aXTNhCAXFKneWLVRa/Z+k2MvvCV5VrhQhlILYAz6OhLUoeVHaEjZJqf6L7S6t3Pe2+x6FUK57LeEkgz0Hv9ZRHy+rasEFJ09drtwMat+uT5r///sU+AA',
  'base64'
)

test(
  'Core disk tickets use the bundled decoder, enforce size and clean native output',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'core-model-platform-'))
    const platform = createAutoMixModelPackPlatform({
      root,
      workerDirectory: resolve('resources/automix-stems'),
      chooseArchive: async () => null
    })
    t.after(async () => {
      await platform.idle()
      await rm(root, { recursive: true, force: true })
    })
    const signal = new AbortController().signal
    const decode = platform.operations['automix.decodeArchiveEntry']
    const output: Buffer[] = []
    for await (const bytes of decodeWithPlatform(
      root,
      Readable.from([lzmaPayload]),
      lzmaData.length,
      decode,
      signal
    ))
      output.push(bytes)
    assert.deepEqual(Buffer.concat(output), lzmaData)
    assert.deepEqual(await readdir(root), [])
    await assert.rejects(async () => {
      for await (const _chunk of decodeWithPlatform(
        root,
        Readable.from([lzmaPayload]),
        1,
        decode,
        signal
      )) {
        /* consume */
      }
    }, /size|stream/)
    assert.deepEqual(await readdir(root), [])
    await assert.rejects(decode({ directory: tmpdir(), bytes: lzmaData.length }, signal), /ticket/)
    await assert.rejects(
      decode({ directory: root, bytes: Number.MAX_SAFE_INTEGER }, signal),
      /size/
    )
  }
)

test('unpublished pack probes are restricted to the fixed managed root and joined on cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'core-model-probe-'))
  const pack = join(root, '1234567890abcdef12345678'),
    worker = join(root, 'workers')
  await mkdir(join(pack, 'runtime'), { recursive: true })
  await mkdir(worker)
  await copyFile(process.execPath, join(pack, 'runtime/python.exe'))
  await writeFile(
    join(worker, 'probe.py'),
    `console.log('TWILIGHT_STEM_CAPABILITIES='+JSON.stringify({cpu:true,gpu:false}))`
  )
  const platform = createAutoMixModelPackPlatform({
    root,
    workerDirectory: worker,
    chooseArchive: async () => 'picked.zip'
  })
  const controller = new AbortController()
  t.after(async () => {
    controller.abort()
    await platform.idle()
    await rm(root, { recursive: true, force: true })
  })
  assert.equal(await platform.operations['automix.chooseArchive'](), 'picked.zip')
  const probe = platform.operations['automix.probeInstall']
  await assert.rejects(probe({ packDirectory: worker }, controller.signal), /ticket/)
  assert.deepEqual(await probe({ packDirectory: pack }, controller.signal), {
    cpu: true,
    gpu: false,
    gpuName: undefined
  })
  await writeFile(
    join(worker, 'probe.py'),
    `require('node:fs').writeFileSync('probe-started','');setInterval(()=>{},1000)`
  )
  const running = probe({ packDirectory: pack }, controller.signal)
  const failure = assert.rejects(running, /abort/i)
  let started = false
  for (let i = 0; i < 100; i++) {
    try {
      await readFile(join(pack, 'probe-started'))
      started = true
      break
    } catch {
      await delay(5)
    }
  }
  assert.equal(started, true)
  let idle = false
  const joined = platform.idle().then(() => {
    idle = true
  })
  await delay(5)
  assert.equal(idle, false)
  controller.abort()
  await Promise.all([failure, joined])
  assert.equal(idle, true)
})
