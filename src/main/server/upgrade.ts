import '../../adapters-node/index.ts'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdir, open, readFile, realpath, unlink, access, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { loadJsonFileWithBackup, writeJsonValueAtomic } from '../../core/persistence/jsonFile.ts'
import { lockServerProfile, readServerProfile, unlockStoppedServerProfile } from './profile.ts'
import { newDestination, snapshotLockedServerProfile, restoreServerProfile } from './maintenance.ts'
import { requestServerAdmin } from './admin.ts'
import { rebaseUpgradedSettings } from './upgradeConfiguration.ts'

export interface ServerPackage {
  application: string
  applicationVersion: string
}
export interface ServerInstance extends ServerPackage {
  data: string
}
export interface ServiceConfiguration {
  binaryPath: string
  state: string
  account: string
  administrator: boolean
}
export interface UpgradeService {
  query(name: string): Promise<ServiceConfiguration>
  configure(name: string, expectedPath: string, binaryPath: string): Promise<void>
  copyProfileAccess(source: string, destination: string): Promise<void>
}
export interface UpgradeReceipt {
  format: 'twilight-server-upgrade'
  version: 1
  id: string
  createdAt: string
  phase: 'preparing' | 'prepared' | 'active' | 'failed' | 'recovery-required' | 'rolled-back'
  ownerPid: number
  source: ServerInstance
  target: ServerInstance
  active: ServerInstance
  snapshot: string
  rollbackData: string
  service?: { name: string; originalBinaryPath: string }
  health?: unknown
  error?: string
  pending?: {
    kind: 'upgrade' | 'rollback'
    from: ServerInstance
    to: ServerInstance
    previousBinaryPath?: string
  }
}

function isInstance(value: unknown): value is ServerInstance {
  const instance = value as ServerInstance
  return (
    !!instance &&
    typeof instance.application === 'string' &&
    isAbsolute(instance.application) &&
    typeof instance.data === 'string' &&
    isAbsolute(instance.data) &&
    typeof instance.applicationVersion === 'string'
  )
}

const receiptOptions = {
  label: 'Server upgrade receipt',
  maxBytes: 1024 * 1024,
  validate: (value: unknown): value is UpgradeReceipt => {
    const r = value as UpgradeReceipt
    return (
      !!r &&
      r.format === 'twilight-server-upgrade' &&
      r.version === 1 &&
      typeof r.id === 'string' &&
      ['preparing', 'prepared', 'active', 'failed', 'recovery-required', 'rolled-back'].includes(
        r.phase
      ) &&
      [r.source, r.target, r.active].every(isInstance) &&
      isAbsolute(r.snapshot) &&
      isAbsolute(r.rollbackData) &&
      Number.isSafeInteger(r.ownerPid) &&
      r.ownerPid > 0 &&
      (!r.service ||
        (/^[A-Za-z0-9_-]{1,128}$/.test(r.service.name) &&
          typeof r.service.originalBinaryPath === 'string')) &&
      (r.pending === undefined ||
        (!!r.pending &&
          ['upgrade', 'rollback'].includes(r.pending.kind) &&
          isInstance(r.pending.from) &&
          isInstance(r.pending.to) &&
          (!r.service || typeof r.pending.previousBinaryPath === 'string')))
    )
  }
}
export function readUpgradeReceipt(work: string): UpgradeReceipt {
  const loaded = loadJsonFileWithBackup(join(work, 'upgrade.json'), receiptOptions)
  if (loaded.status === 'missing') throw new Error('升级记录不存在')
  return loaded.value
}
function saveReceipt(work: string, receipt: UpgradeReceipt) {
  writeJsonValueAtomic(join(work, 'upgrade.json'), receipt, receiptOptions)
}
async function lockOperation(work: string) {
  const path = join(work, 'upgrade.lock'),
    lock = await open(path, 'wx', 0o600)
  await lock.writeFile(JSON.stringify({ pid: process.pid }))
  return async () => {
    await lock.close()
    await unlink(path)
  }
}
export async function unlockUpgrade(work: string) {
  const receipt = readUpgradeReceipt(work)
  let operationPid: number | undefined
  try {
    const { pid } = JSON.parse(await readFile(join(work, 'upgrade.lock'), 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('升级锁 PID 无效')
    operationPid = pid
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (operationPid !== undefined) {
    try {
      process.kill(operationPid, 0)
      throw new Error(`升级进程 ${operationPid} 仍存在，不能解除锁定`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  try {
    const source = JSON.parse(await readFile(join(receipt.source.data, 'server.lock'), 'utf8'))
    if (source.pid === (operationPid ?? receipt.ownerPid))
      await unlockStoppedServerProfile(receipt.source.data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const data of new Set(
    [
      receipt.target.data,
      receipt.rollbackData,
      receipt.pending?.from.data,
      receipt.pending?.to.data
    ].filter((data): data is string => !!data && data !== receipt.source.data)
  )) {
    try {
      await access(join(data, 'server.lock'))
      await unlockStoppedServerProfile(data)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (operationPid !== undefined) await unlink(join(work, 'upgrade.lock'))
}

export async function readServerPackage(application: string): Promise<ServerPackage> {
  if (!isAbsolute(application)) throw new Error('版本目录必须是绝对路径')
  const root = await realpath(application)
  const manifest = JSON.parse(await readFile(join(root, 'server-package.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (
    manifest.format !== 'twilight-server-package' ||
    manifest.version !== 1 ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    manifest.applicationVersion !== pkg.version ||
    !/^v24\./.test(manifest.nodeVersion) ||
    manifest.entry !== 'out/server/server.cjs' ||
    manifest.service !== 'out/server-service/twilight-server-service.exe'
  )
    throw new Error('版本目录不是本平台支持的自包含 Server 包')
  for (const relative of ['runtime/node.exe', manifest.entry, manifest.service])
    await access(join(root, relative))
  return { application: root, applicationVersion: pkg.version }
}
function samePath(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase()
}
function quoteWindows(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`
}
export function serviceBinaryPath(instance: ServerInstance, name: string) {
  return [
    join(instance.application, 'out/server-service/twilight-server-service.exe'),
    '--node',
    join(instance.application, 'runtime/node.exe'),
    '--entry',
    join(instance.application, 'out/server/server.cjs'),
    '--data',
    instance.data,
    '--service-name',
    name
  ]
    .map(quoteWindows)
    .join(' ')
}

export function createWindowsUpgradeService(
  application = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
): UpgradeService {
  const call = async (operation: string, request: unknown) => {
    const result = await promisify(execFile)(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(application, 'scripts/server-service-upgrade.ps1'),
        '-Operation',
        operation
      ],
      {
        windowsHide: true,
        timeout: 180_000,
        env: { ...process.env, TWILIGHT_SERVICE_UPGRADE_REQUEST: JSON.stringify(request) }
      }
    )
    return JSON.parse(result.stdout)
  }
  return {
    query: (name) => call('Query', { name }),
    configure: async (name, expectedPath, binaryPath) => {
      await call('Configure', { name, expectedPath, binaryPath })
    },
    copyProfileAccess: async (source, destination) => {
      await call('CopyProfileAccess', { source, destination })
    }
  }
}

/** Owns only this temporary candidate host, not an existing service or player. */
export async function probeServerInstance(instance: ServerInstance): Promise<unknown> {
  const host = spawn(
    join(instance.application, 'out/server-service/twilight-server-service.exe'),
    [
      '--console',
      '--node',
      join(instance.application, 'runtime/node.exe'),
      '--entry',
      join(instance.application, 'out/server/server.cjs'),
      '--data',
      instance.data
    ],
    {
      cwd: instance.application,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let diagnostic = ''
  host.stderr.on('data', (data) => {
    diagnostic += data
  })
  const exited = once(host, 'exit'),
    lines = createInterface({ input: host.stdout })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = new Promise<void>((resolveReady) =>
      lines.on('line', (line) => {
        if (line.startsWith('STATE RUNNING ')) resolveReady()
      })
    )
    await Promise.race([
      ready,
      exited.then(([code]) => {
        throw new Error(`候选版本启动失败 ${code}：${diagnostic}`)
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('候选版本启动未在期限内就绪')), 180_000)
      })
    ])
    clearTimeout(timer)
    const health = (await requestServerAdmin(instance.data, { kind: 'status' })) as {
      phase: string
      epoch: string
    }
    if (health.phase !== 'ready') throw new Error('候选 Core 未就绪')
    const query = (name: string) =>
      requestServerAdmin(instance.data, {
        kind: 'rpc',
        request: {
          kind: 'query',
          name,
          payload: {},
          epoch: health.epoch,
          requestId: randomUUID()
        } as import('../../shared/coreProtocol.ts').CoreRequestEnvelope
      })
    const state = (await query('state.snapshot')) as {
      migrationRequired: boolean
      playback: { state: string }
      queue: unknown
    }
    if (state.migrationRequired || state.playback.state === 'playing')
      throw new Error('候选 Core 未完成迁移或恢复时自动播放')
    const output = (await query('zones.state')) as { selectedOutputId: string; connected: boolean }
    if (output.selectedOutputId !== 'bridge' || output.connected)
      throw new Error('候选版本没有保持 Bridge 断连')
    const zones = (await query('zones.list')) as import('../../shared/coreZones.ts').ZonesView
    if (
      zones.error ||
      zones.zones.some(
        (zone) =>
          !zone.playback ||
          zone.playback.state === 'playing' ||
          !zone.output ||
          !zone.output.selected ||
          zone.output.connected
      )
    )
      throw new Error('候选版本不能以断连暂停状态恢复所有 Zone')
    const groups = (await query('groups.list')) as {
      error: string | null
      groups: { error: string | null }[]
    }
    if (groups.error || groups.groups.some((group) => group.error))
      throw new Error('候选版本不能恢复同步组')
    host.stdin.write('stop\n')
    const [code] = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('候选版本未确认正常停止')), 60_000)
      })
    ])
    if (code !== 0) throw new Error(`候选版本停止失败 ${code}：${diagnostic}`)
    for (const name of ['server.lock', 'server-run.json']) {
      try {
        await access(join(instance.data, name))
        throw new Error(`候选版本遗留 ${name}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return {
      phase: health.phase,
      playback: state.playback.state,
      queue: state.queue,
      zones: zones.zones.length,
      groups: groups.groups.length,
      connected: false,
      cleanStop: true
    }
  } finally {
    clearTimeout(timer)
    lines.close()
    if (host.exitCode === null && host.signalCode === null) {
      host.kill()
      await exited
    }
  }
}

async function serviceAt(
  service: UpgradeService,
  name: string,
  expected: string,
  stopped: boolean
) {
  const current = await service.query(name)
  if (!samePath(current.binaryPath, expected))
    throw new Error('服务入口与升级记录不一致，未修改其他服务配置')
  if (stopped && current.state !== 'Stopped')
    throw new Error('请先正常停止 Windows Service，再执行升级或回退')
  return current
}
const launcher = String.raw`#requires -Version 7.0
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$receipt = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'upgrade.json') -Raw | ConvertFrom-Json
if ($receipt.pending -or $receipt.phase -in @('preparing', 'prepared', 'recovery-required')) { throw '升级尚未提交，请先执行 upgrade-status 并恢复未完成的操作。' }
if (@($args | Where-Object { $_ -eq '--data' -or $_ -like '--data=*' }).Count) { throw '此入口使用升级记录中的活动数据目录，不接受 --data 覆盖。' }
$node = Join-Path $receipt.active.application 'runtime/node.exe'
$entry = Join-Path $receipt.active.application 'out/server/server.cjs'
& $node $entry @args --data $receipt.active.data
exit $LASTEXITCODE
`

export async function upgradeServer(
  options: {
    sourceApplication: string
    targetApplication: string
    data: string
    work: string
    serviceName?: string
    apply?: boolean
  },
  dependencies: { probe?: typeof probeServerInstance; service?: UpgradeService } = {}
) {
  if (!isAbsolute(options.data)) throw new Error('数据目录必须是绝对路径')
  const source = {
      ...(await readServerPackage(options.sourceApplication)),
      data: await realpath(options.data)
    },
    targetPackage = await readServerPackage(options.targetApplication)
  if (samePath(source.application, targetPackage.application))
    throw new Error('新旧版本必须位于不同目录，不能原地覆盖')
  const work = await newDestination(source.data, options.work)
  await newDestination(source.application, work)
  await newDestination(targetPackage.application, work)
  await readServerProfile(source.data)
  if (options.serviceName && !/^[A-Za-z0-9_-]{1,128}$/.test(options.serviceName))
    throw new Error('服务名称无效')
  const service = dependencies.service ?? createWindowsUpgradeService()
  const previousService = options.serviceName
    ? await serviceAt(
        service,
        options.serviceName,
        serviceBinaryPath(source, options.serviceName),
        options.apply === true
      )
    : undefined
  if (options.apply && previousService && !previousService.administrator)
    throw new Error('服务入口切换需要管理员 PowerShell')
  const receipt: UpgradeReceipt = {
    format: 'twilight-server-upgrade',
    version: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    phase: 'preparing',
    ownerPid: process.pid,
    source,
    target: { ...targetPackage, data: join(work, 'candidate') },
    active: source,
    snapshot: join(work, 'before-upgrade'),
    rollbackData: join(work, 'rollback'),
    ...(options.serviceName
      ? { service: { name: options.serviceName, originalBinaryPath: previousService!.binaryPath } }
      : {})
  }
  if (!options.apply)
    return {
      applied: false,
      work,
      source,
      target: receipt.target,
      snapshot: receipt.snapshot,
      service: receipt.service,
      requiresStopped: true
    }
  const unlock = await lockServerProfile(source.data)
  let releaseOperation: (() => Promise<void>) | undefined
  let workCreated = false
  let transition: UpgradeReceipt['pending']
  try {
    await mkdir(work, { mode: 0o700 })
    workCreated = true
    releaseOperation = await lockOperation(work)
    saveReceipt(work, receipt)
    await writeFile(join(work, 'server.ps1'), launcher, { flag: 'wx', mode: 0o600 })
    await writeFile(
      join(work, 'service-console.ps1'),
      launcher.replace(
        '& $node $entry @args --data $receipt.active.data',
        `& (Join-Path $receipt.active.application 'out/server-service/twilight-server-service.exe') --console --node $node --entry $entry --data $receipt.active.data @args`
      ),
      { flag: 'wx', mode: 0o600 }
    )
    await snapshotLockedServerProfile(source.data, receipt.snapshot, source.applicationVersion)
    await restoreServerProfile(receipt.snapshot, receipt.target.data, source.applicationVersion)
    await rebaseUpgradedSettings(source.data, receipt.target.data)
    if (receipt.service) await service.copyProfileAccess(source.data, receipt.target.data)
    const probe = dependencies.probe ?? probeServerInstance
    const baseline = await probe({ ...source, data: receipt.target.data })
    receipt.health = { baseline, candidate: await probe(receipt.target) }
    receipt.phase = 'prepared'
    transition = receipt.pending = {
      kind: 'upgrade',
      from: source,
      to: receipt.target,
      previousBinaryPath: receipt.service?.originalBinaryPath
    }
    saveReceipt(work, receipt)
    if (receipt.service)
      await service.configure(
        receipt.service.name,
        receipt.service.originalBinaryPath,
        serviceBinaryPath(receipt.target, receipt.service.name)
      )
    receipt.active = receipt.target
    receipt.phase = 'active'
    receipt.pending = undefined
    saveReceipt(work, receipt)
    return { applied: true, work, receipt }
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error)
    receipt.active = source
    receipt.phase = 'failed'
    receipt.pending = undefined
    if (transition && receipt.service) {
      try {
        const current = await service.query(receipt.service.name)
        if (!samePath(current.binaryPath, receipt.service.originalBinaryPath)) {
          receipt.phase = 'recovery-required'
          receipt.pending = transition
        }
      } catch (inspection) {
        receipt.phase = 'recovery-required'
        receipt.pending = transition
        receipt.error += `；服务入口结果需重新确认：${String(inspection)}`
      }
    }
    if (workCreated) {
      try {
        saveReceipt(work, receipt)
      } catch (writeError) {
        throw new Error(
          `${receipt.error}；无法更新升级记录：${String(writeError)}；工作目录：${work}`
        )
      }
    }
    throw new Error(`${receipt.error}；升级记录：${join(work, 'upgrade.json')}`)
  } finally {
    await releaseOperation?.()
    await unlock()
  }
}

export async function rollbackServer(
  workPath: string,
  apply = false,
  dependencies: { probe?: typeof probeServerInstance; service?: UpgradeService } = {}
) {
  const work = await realpath(workPath),
    receipt = readUpgradeReceipt(work)
  if (receipt.phase === 'rolled-back') throw new Error('此升级已经回退，请读取当前记录')
  if (receipt.pending) throw new Error('尚有未确认的版本切换，请先执行 upgrade-recover')
  if (!apply)
    return {
      applied: false,
      work,
      target: { ...receipt.source, data: receipt.rollbackData },
      snapshot: receipt.snapshot,
      losesPostUpgradeChanges: true
    }
  const releaseOperation = await lockOperation(work)
  const unlocks: (() => Promise<void>)[] = []
  const service = dependencies.service ?? createWindowsUpgradeService()
  try {
    receipt.ownerPid = process.pid
    saveReceipt(work, receipt)
    let before: ServiceConfiguration | undefined
    if (receipt.service) {
      before = await service.query(receipt.service.name)
      if (!before.administrator) throw new Error('服务入口切换需要管理员 PowerShell')
      if (before.state !== 'Stopped') throw new Error('请先正常停止 Windows Service，再执行回退')
      if (
        !samePath(before.binaryPath, receipt.service.originalBinaryPath) &&
        !samePath(before.binaryPath, serviceBinaryPath(receipt.target, receipt.service.name))
      )
        throw new Error('服务入口已被其他操作修改，未回退')
    }
    unlocks.push(await lockServerProfile(receipt.source.data))
    try {
      await access(receipt.target.data)
      unlocks.push(await lockServerProfile(receipt.target.data))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const original = await readServerPackage(receipt.source.application)
    if (original.applicationVersion !== receipt.source.applicationVersion)
      throw new Error('旧版本目录内容已变化，未回退')
    receipt.rollbackData = join(work, `rollback-${randomUUID()}`)
    saveReceipt(work, receipt)
    await restoreServerProfile(receipt.snapshot, receipt.rollbackData, original.applicationVersion)
    await rebaseUpgradedSettings(receipt.source.data, receipt.rollbackData)
    const restored = { ...original, data: receipt.rollbackData }
    if (receipt.service) await service.copyProfileAccess(receipt.source.data, restored.data)
    receipt.health = await (dependencies.probe ?? probeServerInstance)(restored)
    if (receipt.service) await serviceAt(service, receipt.service.name, before!.binaryPath, true)
    const previousInstance =
      before &&
      receipt.service &&
      samePath(before.binaryPath, serviceBinaryPath(receipt.target, receipt.service.name))
        ? receipt.target
        : receipt.service
          ? receipt.source
          : receipt.active
    receipt.pending = {
      kind: 'rollback',
      from: previousInstance,
      to: restored,
      previousBinaryPath: before?.binaryPath
    }
    receipt.phase = 'recovery-required'
    saveReceipt(work, receipt)
    if (receipt.service) {
      await service.configure(
        receipt.service.name,
        before!.binaryPath,
        serviceBinaryPath(restored, receipt.service.name)
      )
    }
    receipt.active = restored
    receipt.phase = 'rolled-back'
    receipt.error = undefined
    receipt.pending = undefined
    saveReceipt(work, receipt)
    return { applied: true, work, receipt, losesPostUpgradeChanges: true }
  } finally {
    for (const unlock of unlocks.reverse()) await unlock()
    await releaseOperation()
  }
}

/** Complete only a previously probed, journaled transition. No blind replay of
 * a Configure whose result is unknown: query the effective SCM path first. */
export async function recoverUpgrade(
  workPath: string,
  apply = false,
  dependencies: { probe?: typeof probeServerInstance; service?: UpgradeService } = {}
) {
  const work = await realpath(workPath),
    receipt = readUpgradeReceipt(work),
    pending = receipt.pending
  if (!pending) throw new Error('没有尚未提交的版本切换')
  if (!apply) return { applied: false, pending, service: receipt.service, requiresStopped: true }
  const release = await lockOperation(work)
  let unlock: (() => Promise<void>) | undefined
  try {
    receipt.ownerPid = process.pid
    saveReceipt(work, receipt)
    unlock = await lockServerProfile(pending.from.data)
    const service = dependencies.service ?? createWindowsUpgradeService()
    const candidate = await readServerPackage(pending.to.application)
    if (candidate.applicationVersion !== pending.to.applicationVersion)
      throw new Error('候选版本目录内容已变化，未继续切换')
    let current: ServiceConfiguration | undefined
    if (receipt.service) {
      current = await service.query(receipt.service.name)
      if (!current.administrator || current.state !== 'Stopped')
        throw new Error('请在管理员 PowerShell 正常停止服务后恢复切换')
      if (
        !samePath(current.binaryPath, pending.previousBinaryPath!) &&
        !samePath(current.binaryPath, serviceBinaryPath(pending.to, receipt.service.name))
      )
        throw new Error('服务入口已被其他操作修改，未恢复切换')
    }
    receipt.health = await (dependencies.probe ?? probeServerInstance)(pending.to)
    if (receipt.service) await serviceAt(service, receipt.service.name, current!.binaryPath, true)
    if (
      receipt.service &&
      !samePath(current!.binaryPath, serviceBinaryPath(pending.to, receipt.service.name))
    )
      await service.configure(
        receipt.service.name,
        current!.binaryPath,
        serviceBinaryPath(pending.to, receipt.service.name)
      )
    receipt.active = pending.to
    receipt.phase = pending.kind === 'upgrade' ? 'active' : 'rolled-back'
    receipt.error = undefined
    receipt.pending = undefined
    saveReceipt(work, receipt)
    return { applied: true, work, receipt }
  } finally {
    await unlock?.()
    await release()
  }
}
