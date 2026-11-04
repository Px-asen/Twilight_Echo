import { parseArgs } from 'node:util'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { requestServerAdmin } from './admin.ts'
import { manageServerDsp } from './dspManagement.ts'
import { manageServerPlugins } from './pluginManagement.ts'
import { runServerHost } from './host.ts'
import { initializeServerProfile, unlockStoppedServerProfile } from './profile.ts'
import type { CoreRequestEnvelope } from '../../shared/coreProtocol.ts'
import type { RemoteControlStatus } from '../../shared/remoteControl.ts'
import { backupServerProfile, restoreServerProfile } from './maintenance.ts'
import { migratePersonalBackup } from './migration.ts'
import { exportDesktopMigration, migrateDesktopBundle } from './desktopMigration.ts'
import {
  upgradeServer,
  rollbackServer,
  recoverUpgrade,
  readUpgradeReceipt,
  unlockUpgrade
} from './upgrade.ts'

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: 'string' },
      library: { type: 'string', multiple: true },
      request: { type: 'string' },
      id: { type: 'string' },
      code: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean' },
      to: { type: 'string' },
      from: { type: 'string' },
      options: { type: 'string' },
      apply: { type: 'boolean' },
      'remove-data': { type: 'boolean' },
      settings: { type: 'string' },
      dsp: { type: 'string' },
      impulse: { type: 'string' },
      stopped: { type: 'boolean' },
      'bridge-only': { type: 'boolean' },
      'asset-root': { type: 'string', multiple: true },
      work: { type: 'string' },
      service: { type: 'string' }
      , zone: { type: 'string' }, kind: { type: 'string' }, 'asset-offset': { type: 'string' }, 'plugin-offset': { type: 'string' }
      , scene: { type: 'string' }, node: { type: 'string' }, offset: { type: 'string' }, name: { type: 'string' }
    }
  })
  if (values.help || !positionals.length) {
    console.log(
      [
        'Twilight Echo Server（Node 24+）',
        '用法：node out/server/server.cjs <操作> --data <绝对路径>',
        '新建：init [--library <目录>]；--library 可以重复指定。',
        '迁移：migrate --from <个人备份 JSON 或整包目录> [--library <目录>] [--options <恢复选项 JSON>] [--apply]',
        '迁移附加项：--settings <设置备份 JSON>、--dsp <场景.tedsp>、--impulse <旧式卷积文件>。默认预览，目标须为新目录。',
        '运行：start [--bridge-only]、status、health、stop [--force]、unlock。health 仅在 Core ready 时返回成功；容器通过 SIGTERM 正常停止。',
        '维护：backup --to <新备份目录>、restore --from <备份目录>。',
        '升级：upgrade --from <旧包目录> --to <新包目录> --data <停止的 Profile> --work <新私有工作目录> [--service <服务名>] [--apply]。',
        '回退／恢复：rollback、upgrade-recover --work <工作目录> [--apply]；upgrade-status、upgrade-unlock --work <工作目录>。',
        '整包导出：export-migration --from <离线桌面数据目录> --to <新包目录> --stopped [--asset-root <外部 IR 根目录>]。',
        '遥控：remote-on、remote-off、remote-status、allow-pairing --id <请求 ID> --code <手机验证码>。',
        '高级管理：rpc --request <JSON 文件>。'
        , 'DSP 日常管理：dsp-library、dsp-import --from <资料文件>、dsp-remove --id <资料 ID>、dsp-edit --request <编辑 JSON>、vst3-scan；均可加 --zone <声区 ID>，默认 local。'
        , 'DSP 整包：dsp-profile-import --from <配置.tedsp> [--apply]（默认预览，确认后新增未启用场景）；dsp-profile-export --to <新配置.tedsp>。'
        , 'VST3 参数：dsp-parameters --scene <场景 ID> --node <节点 ID> [--offset 100]；修改使用 dsp-edit 的 parameter 操作。'
        , '扩展：plugins [--offset 100]、plugin-install --from <扩展.tep> [--apply]、plugin-enable／plugin-disable --id <ID>。'
        , '卸载：plugin-uninstall --id <ID> [--remove-data] [--apply]。安装和卸载默认预览；--apply 安装会执行可信扩展代码，权限等同于 Server 账号。'
      ].join('\n')
    )
    return
  }
  const command = positionals[0]
  if (
    ['upgrade', 'rollback', 'upgrade-status', 'upgrade-recover', 'upgrade-unlock'].includes(command)
  ) {
    if (!values.work || !isAbsolute(values.work))
      throw new Error('请用 --work 指定绝对升级工作目录')
    let result: unknown
    if (command === 'upgrade') {
      if (!values.from || !values.to || !values.data)
        throw new Error('upgrade 需要 --from 旧包、--to 新包和 --data 原 Profile')
      result = await upgradeServer({
        sourceApplication: values.from,
        targetApplication: values.to,
        data: values.data,
        work: values.work,
        serviceName: values.service,
        apply: values.apply
      })
    } else if (command === 'rollback') result = await rollbackServer(values.work, values.apply)
    else if (command === 'upgrade-recover') result = await recoverUpgrade(values.work, values.apply)
    else if (command === 'upgrade-unlock') {
      await unlockUpgrade(values.work)
      result = { unlocked: true }
    } else result = readUpgradeReceipt(values.work)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'export-migration') {
    if (!values.from || !values.to)
      throw new Error('export-migration 需要 --from 离线数据目录和 --to 新包目录')
    console.log(
      JSON.stringify(
        await exportDesktopMigration({
          source: values.from,
          destination: values.to,
          stopped: values.stopped === true,
          assetRoots: values['asset-root']
        }),
        null,
        2
      )
    )
    return
  }
  const root = values.data
  if (!root) throw new Error('请用 --data 指定独立的 Server 数据目录')
  if (!isAbsolute(root)) throw new Error('--data 必须是绝对路径')
  if (command === 'migrate') {
    if (!values.from) throw new Error('migrate 需要 --from 个人备份 JSON 或整包目录')
    if (!isAbsolute(values.from)) throw new Error('--from 必须是绝对路径')
    const restoreOptions = values.options
      ? JSON.parse(await readFile(values.options, 'utf8'))
      : undefined
    console.log(
      JSON.stringify(
        await (
          (await stat(values.from)).isDirectory() ? migrateDesktopBundle : migratePersonalBackup
        )({
          file: values.from,
          destination: root,
          libraryRoots: values.library ?? [],
          restoreOptions,
          apply: values.apply,
          settingsFile: values.settings,
          dspProfile: values.dsp,
          impulseFile: values.impulse
        }),
        null,
        2
      )
    )
    return
  }
  if (command === 'backup' || command === 'restore') {
    const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const { version } = JSON.parse(await readFile(join(applicationRoot, 'package.json'), 'utf8'))
    if (command === 'backup') {
      if (!values.to) throw new Error('backup 需要 --to 新备份目录')
      console.log(JSON.stringify(await backupServerProfile(root, values.to, version)))
    } else {
      if (!values.from || !isAbsolute(values.from))
        throw new Error('restore 需要 --from 绝对备份路径')
      console.log(JSON.stringify(await restoreServerProfile(values.from, root, version)))
    }
    return
  }
  if (command === 'init') {
    await initializeServerProfile(root, values.library ?? [])
    console.log('Server 数据目录已初始化；尚未启动服务。')
    return
  }
  if (command === 'unlock') {
    await unlockStoppedServerProfile(root)
    console.log('已解除停止进程的旧锁。')
    return
  }
  if (command === 'start' || command === 'service-child') {
    await runServerHost(root, command === 'service-child', command === 'service-child' || values['bridge-only'] === true)
    return
  }
  if (command === 'status' || command === 'health') {
    const status = await requestServerAdmin(root, { kind: 'status' }) as { phase?: string }
    console.log(JSON.stringify(status, null, 2))
    if (command === 'health' && status.phase !== 'ready') process.exitCode = 1
    return
  }
  if (command === 'stop') {
    console.log(
      JSON.stringify(await requestServerAdmin(root, { kind: 'stop', force: values.force }))
    )
    return
  }
  if (command === 'rpc') {
    if (!values.request) throw new Error('rpc 需要 --request JSON 文件（包含 epoch 和 requestId）')
    const request = JSON.parse(await readFile(values.request, 'utf8')) as CoreRequestEnvelope
    console.log(
      JSON.stringify((await requestServerAdmin(root, { kind: 'rpc', request })) ?? null, null, 2)
    )
    return
  }
  const health = (await requestServerAdmin(root, { kind: 'status' })) as { epoch: string }
  const rpc = (kind: 'query' | 'command', name: string, payload: unknown = {}) =>
    requestServerAdmin(root, {
      kind: 'rpc',
      request: {
        kind,
        name,
        payload,
        epoch: health.epoch,
        requestId: randomUUID()
      } as CoreRequestEnvelope
    })
  let result: unknown
  if (['dsp-library', 'dsp-import', 'dsp-remove', 'dsp-edit', 'vst3-scan', 'dsp-profile-import', 'dsp-profile-export', 'dsp-parameters'].includes(command))
    result = await manageServerDsp(command, values, rpc)
  else if (['plugins', 'plugin-install', 'plugin-enable', 'plugin-disable', 'plugin-uninstall'].includes(command))
    result = await manageServerPlugins(command, values, rpc)
  else if (command === 'remote-on' || command === 'remote-off')
    result = await rpc('command', 'remote.setEnabled', { enabled: command === 'remote-on' })
  else if (command === 'remote-status') result = await rpc('query', 'remote.status')
  else if (command === 'allow-pairing') {
    const status = (await rpc('query', 'remote.status')) as RemoteControlStatus
    const pending = status.pairingRequests?.find((request) => request.id === values.id)
    if (!pending || !values.code || pending.verificationCode !== values.code)
      throw new Error('配对请求已失效或手机验证码不一致')
    result = await rpc('command', 'remote.decidePairing', { requestId: pending.id, allow: true })
  } else throw new Error(`未知操作：${command}`)
  console.log(JSON.stringify(result, null, 2))
}

void main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
