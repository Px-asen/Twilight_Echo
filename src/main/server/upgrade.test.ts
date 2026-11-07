import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { initializeServerProfile, lockServerProfile } from './profile.ts'
import {
  upgradeServer,
  rollbackServer,
  recoverUpgrade,
  readUpgradeReceipt,
  serviceBinaryPath,
  unlockUpgrade,
  type ServerInstance,
  type UpgradeService,
  type ServiceConfiguration
} from './upgrade.ts'

async function files(root: string, prefix = ''): Promise<Array<[string, Buffer]>> {
  const result: Array<[string, Buffer]> = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) result.push(...(await files(root, path)))
    else result.push([path, await readFile(join(root, path))])
  }
  return result.sort(([a], [b]) => a.localeCompare(b))
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-upgrade-'))
  t.after(async () => {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  const packageAt = async (name: string, version: string) => {
    const directory = join(root, name)
    for (const folder of ['runtime', 'out/server', 'out/server-service'])
      await mkdir(join(directory, folder), { recursive: true })
    for (const name of [
      'runtime/node.exe',
      'out/server/server.cjs',
      'out/server-service/twilight-server-service.exe'
    ])
      await writeFile(join(directory, name), 'unit fixture; native behavior is injected')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version }))
    await writeFile(
      join(directory, 'server-package.json'),
      JSON.stringify({
        format: 'twilight-server-package',
        version: 1,
        applicationVersion: version,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        entry: 'out/server/server.cjs',
        service: 'out/server-service/twilight-server-service.exe'
      })
    )
    return directory
  }
  const sourceApplication = await packageAt("Old ' 中文", '1.4.0'),
    targetApplication = await packageAt('New version', '1.4.1'),
    data = join(root, 'original'),
    work = join(root, 'upgrade')
  await initializeServerProfile(data, [])
  const database = new DatabaseSync(join(data, 'music-library.sqlite'))
  database.exec("CREATE TABLE evidence(value); INSERT INTO evidence VALUES('before upgrade')")
  database.close()
  await mkdir(join(data, 'dsp-assets'))
  await writeFile(join(data, 'dsp-assets/ir.wav'), 'impulse fixture')
  await writeFile(join(data, 'remote-tls.json'), 'private test identity')
  await writeFile(
    join(data, 'settings.json'),
    JSON.stringify({
      cachePath: join(data, 'music-cache'),
      musicCachePath: join(data, 'music-cache'),
      language: 'zh-CN',
      audioProcessing: { convolverIrPath: join(data, 'dsp-assets/ir.wav') },
      dspScenes: [],
      libraryFolders: ['D:/Music'],
      downloadFolder: 'D:/Downloads'
    })
  )
  const probes: ServerInstance[] = []
  const probe = async (instance: ServerInstance) => {
    probes.push(instance)
    assert.equal(
      await readFile(join(instance.data, 'remote-tls.json'), 'utf8'),
      'private test identity'
    )
    const settings = JSON.parse(await readFile(join(instance.data, 'settings.json'), 'utf8'))
    assert.equal(settings.cachePath, join(instance.data, 'music-cache'))
    assert.equal(settings.audioProcessing.convolverIrPath, join(instance.data, 'dsp-assets/ir.wav'))
    assert.deepEqual(settings.libraryFolders, ['D:/Music'])
    assert.equal(settings.downloadFolder, 'D:/Downloads')
    return { phase: 'ready', connected: false, cleanStop: true }
  }
  const source = { application: sourceApplication, applicationVersion: '1.4.0', data }
  const state: ServiceConfiguration = {
    binaryPath: serviceBinaryPath(source, 'TestServer'),
    state: 'Stopped',
    account: 'LocalService',
    administrator: true
  }
  const calls: string[] = []
  const service: UpgradeService = {
    query: async () => ({ ...state }),
    configure: async (_name, expected, next) => {
      assert.equal(state.binaryPath, expected)
      assert.equal(state.state, 'Stopped')
      calls.push(next)
      state.binaryPath = next
    },
    copyProfileAccess: async (from, to) => {
      assert.equal(from, data)
      assert.ok(to.startsWith(work))
      calls.push('profile-access-copy')
    }
  }
  return {
    root,
    data,
    work,
    sourceApplication,
    targetApplication,
    probes,
    probe,
    service,
    state,
    calls,
    options: { sourceApplication, targetApplication, data, work }
  }
}

test('upgrade previews read-only, proves old and new versions against a clone, then rollback restores an independent pre-upgrade profile', async (t) => {
  const f = await fixture(t),
    original = await files(f.data)
  const preview = await upgradeServer(f.options, { probe: f.probe })
  assert.equal(preview.applied, false)
  await assert.rejects(access(f.work), { code: 'ENOENT' })
  assert.equal(f.probes.length, 0)
  await upgradeServer({ ...f.options, apply: true }, { probe: f.probe })
  const receipt = readUpgradeReceipt(f.work)
  assert.equal(receipt.phase, 'active')
  assert.equal(receipt.pending, undefined)
  assert.deepEqual(
    f.probes.map((p) => p.applicationVersion),
    ['1.4.0', '1.4.1']
  )
  assert.deepEqual(await files(f.data), original)
  await writeFile(join(receipt.target.data, 'only-newer-data'), 'retain after rollback')
  const before = await readFile(join(f.work, 'upgrade.json'))
  assert.equal((await rollbackServer(f.work)).losesPostUpgradeChanges, true)
  assert.deepEqual(await readFile(join(f.work, 'upgrade.json')), before)
  const rolled = await rollbackServer(f.work, true, { probe: f.probe })
  assert.ok(rolled.receipt)
  assert.equal(rolled.receipt.phase, 'rolled-back')
  assert.equal(rolled.receipt.active.applicationVersion, '1.4.0')
  assert.notEqual(rolled.receipt.active.data, f.data)
  assert.notEqual(rolled.receipt.active.data, receipt.target.data)
  await assert.rejects(access(join(rolled.receipt.active.data, 'only-newer-data')), {
    code: 'ENOENT'
  })
  assert.equal(
    await readFile(join(receipt.target.data, 'only-newer-data'), 'utf8'),
    'retain after rollback'
  )
  assert.deepEqual(await files(f.data), original)
  await assert.rejects(rollbackServer(f.work, true, { probe: f.probe }), /已经回退/)
})

test('registered service switches only after both probes, retains its account, and rollback switches to the restored old-version copy', async (t) => {
  const f = await fixture(t)
  const service = {
    ...f.service,
    configure: async (...args: Parameters<UpgradeService['configure']>) => {
      assert.ok(f.probes.length >= 2)
      await f.service.configure(...args)
    }
  }
  await upgradeServer(
    { ...f.options, serviceName: 'TestServer', apply: true },
    { probe: f.probe, service }
  )
  const active = readUpgradeReceipt(f.work)
  assert.equal(f.state.binaryPath, serviceBinaryPath(active.target, 'TestServer'))
  assert.equal(f.state.account, 'LocalService')
  await rollbackServer(f.work, true, { probe: f.probe, service })
  assert.equal(
    f.state.binaryPath,
    serviceBinaryPath(readUpgradeReceipt(f.work).active, 'TestServer')
  )
  assert.equal(f.state.state, 'Stopped')
})

test('a failed candidate never changes SCM or the original profile and retains its snapshot for recovery', async (t) => {
  const f = await fixture(t),
    before = await files(f.data),
    originalPath = f.state.binaryPath
  await assert.rejects(
    upgradeServer(
      { ...f.options, serviceName: 'TestServer', apply: true },
      {
        service: f.service,
        probe: async (instance) => {
          await f.probe(instance)
          if (instance.applicationVersion === '1.4.1') throw new Error('new Core startup failed')
          return { phase: 'ready' }
        }
      }
    ),
    /new Core startup failed/
  )
  assert.equal(f.state.binaryPath, originalPath)
  assert.equal(f.calls.filter((call) => call !== 'profile-access-copy').length, 0)
  assert.equal(readUpgradeReceipt(f.work).phase, 'failed')
  assert.ok(await readFile(join(f.work, 'before-upgrade/snapshot.json')))
  assert.deepEqual(await files(f.data), before)
  await assert.rejects(access(join(f.work, 'upgrade.lock')), { code: 'ENOENT' })
})

test('an uncertain SCM Configure is reconciled by fresh state, not replayed; recovery finishes the already-applied path once', async (t) => {
  const f = await fixture(t)
  let writes = 0
  const service = {
    ...f.service,
    configure: async (...args: Parameters<UpgradeService['configure']>) => {
      writes++
      await f.service.configure(...args)
      throw new Error('SCM acknowledgement lost')
    }
  }
  await assert.rejects(
    upgradeServer(
      { ...f.options, serviceName: 'TestServer', apply: true },
      { service, probe: f.probe }
    ),
    /acknowledgement lost/
  )
  const pending = readUpgradeReceipt(f.work)
  assert.equal(pending.phase, 'recovery-required')
  assert.equal(pending.pending!.kind, 'upgrade')
  await recoverUpgrade(f.work, true, { service, probe: f.probe })
  assert.equal(writes, 1)
  assert.equal(readUpgradeReceipt(f.work).phase, 'active')
  assert.equal(readUpgradeReceipt(f.work).pending, undefined)
})

test('rollback journals its uncertain SCM result and recovery adopts the already-checked rollback copy without another Configure', async (t) => {
  const f = await fixture(t)
  await upgradeServer(
    { ...f.options, serviceName: 'TestServer', apply: true },
    { service: f.service, probe: f.probe }
  )
  let writes = 0
  const service = {
    ...f.service,
    configure: async (...args: Parameters<UpgradeService['configure']>) => {
      writes++
      await f.service.configure(...args)
      throw new Error('rollback reply lost')
    }
  }
  await assert.rejects(rollbackServer(f.work, true, { service, probe: f.probe }), /reply lost/)
  assert.equal(readUpgradeReceipt(f.work).pending!.kind, 'rollback')
  await assert.rejects(rollbackServer(f.work, true, { service, probe: f.probe }), /upgrade-recover/)
  await recoverUpgrade(f.work, true, { service, probe: f.probe })
  assert.equal(writes, 1)
  assert.equal(readUpgradeReceipt(f.work).phase, 'rolled-back')
})

test('active source locks, existing work directories, running or unrelated services are refused before creating new data', async (t) => {
  const f = await fixture(t),
    unlock = await lockServerProfile(f.data)
  await assert.rejects(upgradeServer({ ...f.options, apply: true }, { probe: f.probe }), {
    code: 'EEXIST'
  })
  await unlock()
  for (const state of [{ state: 'Running' }, { state: 'Stopped', binaryPath: 'another service' }]) {
    Object.assign(f.state, state)
    await assert.rejects(
      upgradeServer(
        { ...f.options, serviceName: 'TestServer', apply: true },
        { service: f.service, probe: f.probe }
      )
    )
    await assert.rejects(access(f.work), { code: 'ENOENT' })
  }
  await mkdir(f.work)
  await writeFile(join(f.work, 'keep'), 'existing operator data')
  await assert.rejects(
    upgradeServer({ ...f.options, apply: true }, { probe: f.probe }),
    /目标已存在/
  )
  assert.equal(await readFile(join(f.work, 'keep'), 'utf8'), 'existing operator data')
})

test('recovery lock failure releases only its operation lock and never removes a live profile lock', async (t) => {
  const f = await fixture(t)
  const service = {
    ...f.service,
    configure: async (...args: Parameters<UpgradeService['configure']>) => {
      await f.service.configure(...args)
      throw new Error('lost')
    }
  }
  await assert.rejects(
    upgradeServer(
      { ...f.options, serviceName: 'TestServer', apply: true },
      { service, probe: f.probe }
    )
  )
  const unlock = await lockServerProfile(f.data)
  await assert.rejects(recoverUpgrade(f.work, true, { service, probe: f.probe }), {
    code: 'EEXIST'
  })
  await assert.rejects(access(join(f.work, 'upgrade.lock')), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(join(f.data, 'server.lock'), 'utf8')).pid, process.pid)
  await writeFile(join(f.work, 'upgrade.lock'), JSON.stringify({ pid: process.pid }))
  await assert.rejects(unlockUpgrade(f.work), /仍存在/)
  await unlock()
})

for (const change of ['path', 'state'] as const)
  test(`rollback refuses an SCM ${change} changed by another owner while the old Core is probed`, async (t) => {
    const f = await fixture(t)
    await upgradeServer(
      { ...f.options, serviceName: 'TestServer', apply: true },
      { service: f.service, probe: f.probe }
    )
    const writes = f.calls.filter((call) => call !== 'profile-access-copy').length
    await assert.rejects(
      rollbackServer(f.work, true, {
        service: f.service,
        probe: async (instance) => {
          const result = await f.probe(instance)
          if (change === 'path') f.state.binaryPath = 'another administrator owns this entry'
          else f.state.state = 'Running'
          return result
        }
      }),
      change === 'path' ? /入口与升级记录不一致/ : /正常停止/
    )
    assert.equal(f.calls.filter((call) => call !== 'profile-access-copy').length, writes)
    assert.equal(readUpgradeReceipt(f.work).pending, undefined)
    assert.equal(readUpgradeReceipt(f.work).phase, 'active')
  })

test('recovery rechecks an already-applied SCM path after probing before accepting it', async (t) => {
  const f = await fixture(t)
  const service = {
    ...f.service,
    configure: async (...args: Parameters<UpgradeService['configure']>) => {
      await f.service.configure(...args)
      throw new Error('lost reply')
    }
  }
  await assert.rejects(
    upgradeServer(
      { ...f.options, serviceName: 'TestServer', apply: true },
      { service, probe: f.probe }
    ),
    /lost reply/
  )
  await assert.rejects(
    recoverUpgrade(f.work, true, {
      service,
      probe: async (instance) => {
        const result = await f.probe(instance)
        f.state.binaryPath = 'another administrator owns this entry'
        return result
      }
    }),
    /入口与升级记录不一致/
  )
  assert.equal(readUpgradeReceipt(f.work).phase, 'recovery-required')
  assert.ok(readUpgradeReceipt(f.work).pending)
})

test('explicit recovery clears dead owned locks with or without an operation lock but keeps live managed and unrelated source locks', async (t) => {
  const f = await fixture(t)
  await upgradeServer({ ...f.options, apply: true }, { probe: f.probe })
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true })
  await once(child, 'exit')
  assert.ok(child.pid)
  assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' })
  const receipt = readUpgradeReceipt(f.work)
  receipt.ownerPid = child.pid
  await writeFile(join(f.work, 'upgrade.json'), JSON.stringify(receipt))
  for (const directory of [f.work, f.data, receipt.target.data])
    await writeFile(
      join(directory, directory === f.work ? 'upgrade.lock' : 'server.lock'),
      JSON.stringify({ pid: child.pid })
    )
  await unlockUpgrade(f.work)
  for (const path of [
    join(f.work, 'upgrade.lock'),
    join(f.data, 'server.lock'),
    join(receipt.target.data, 'server.lock')
  ])
    await assert.rejects(access(path), { code: 'ENOENT' })
  await writeFile(join(receipt.target.data, 'server.lock'), JSON.stringify({ pid: child.pid }))
  const releaseSource = await lockServerProfile(f.data)
  await unlockUpgrade(f.work)
  await assert.rejects(access(join(receipt.target.data, 'server.lock')), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(join(f.data, 'server.lock'), 'utf8')).pid, process.pid)
  await releaseSource()
  const releaseTarget = await lockServerProfile(receipt.target.data)
  await assert.rejects(unlockUpgrade(f.work), /仍存在/)
  await releaseTarget()
})
