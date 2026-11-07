import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, copyFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createAutoMixProcessPlatform } from './autoMixProcessPlatform.ts'

test('main resolves fixed model/probe workers and joins their actual exit on Core cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'core-automix-process-'))
  const material = await mkdtemp(join(tmpdir(), 'twilight-automix-material-'))
  const pack = join(root, 'pack'),
    worker = join(root, 'worker')
  await mkdir(join(pack, 'runtime'), { recursive: true })
  await mkdir(worker)
  await copyFile(process.execPath, join(pack, 'runtime/python.exe'))
  await writeFile(
    join(worker, 'probe.py'),
    `console.log('TWILIGHT_STEM_CAPABILITIES='+JSON.stringify({cpu:true,gpu:false}))`
  )
  await writeFile(
    join(worker, 'worker.py'),
    `const fs=require('node:fs'),path=require('node:path');fs.writeFileSync(path.join(path.dirname(process.argv[2]),'started'),'');setInterval(()=>{},1000)`
  )
  const file = join(material, 'request.json')
  await writeFile(file, '{}')
  const platform = createAutoMixProcessPlatform({
    candidates: () => [pack],
    workerDirectory: worker,
    temporaryDirectory: tmpdir()
  })
  const controller = new AbortController()
  try {
    await assert.rejects(
      platform.operations['automix.probe']({ packDirectory: root }, controller.signal),
      /Unknown AutoMix/
    )
    assert.deepEqual(
      await platform.operations['automix.probe']({ packDirectory: pack }, controller.signal),
      { cpu: true, gpu: false, gpuName: undefined }
    )
    await assert.rejects(
      platform.operations['automix.runWorker'](
        { packDirectory: pack, requestPath: join(root, 'worker.py'), budgetMs: 1000 },
        controller.signal
      ),
      /ENOENT|material ticket/
    )
    const work = platform.operations['automix.runWorker'](
      { packDirectory: pack, requestPath: file, budgetMs: 90000 },
      controller.signal
    )
    const failed = assert.rejects(work, /stems_cancelled/)
    let started = false
    for (let i = 0; i < 500; i++) {
      try {
        await access(join(material, 'started'))
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
    assert.equal(
      idle,
      false,
      'supervision cannot report recovery while the worker still owns output files'
    )
    controller.abort()
    await Promise.all([failed, joined])
    assert.equal(idle, true)
  } finally {
    controller.abort()
    await platform.idle()
    await rm(root, { recursive: true, force: true })
    await rm(material, { recursive: true, force: true })
  }
})
