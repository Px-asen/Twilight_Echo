import { EventEmitter, once } from 'node:events'
import { join } from 'node:path'
import { access, writeFile, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type {
  CoreClientIdentity,
  CoreRequestEnvelope,
  CoreSnapshot
} from '../../shared/coreProtocol.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import type { CoreSupervisor } from '../coreProcess/supervisor.ts'
import { createNodeCoreSupervisor } from './nodeSupervisor.ts'
import { createServerPlatform } from './platform.ts'
import { lockServerProfile, readServerProfile } from './profile.ts'
import type { NodeSupervisedProcess } from './nodeHost.ts'

export class NodeServerRuntime extends EventEmitter {
  private supervisor: CoreSupervisor | undefined
  private unlock: (() => Promise<void>) | undefined
  private readonly children = new Map<NodeSupervisedProcess, string>()
  private readonly identity: CoreClientIdentity = {
    id: `server-admin:${randomUUID()}`,
    role: 'server-admin',
    permissions: [
      'playback:read',
      'playback:write',
      'library:read',
      'library:write',
      'settings:read',
      'settings:write',
      'migration:write',
      'statistics:read',
      'statistics:write',
      'downloads:read',
      'downloads:write',
      'plugins:read', 'plugins:manage'
    ]
  }

  async start(options: {
    root: string
    applicationRoot: string
    entryDirectory: string
    bridgeOnly?: boolean
  }): Promise<void> {
    const profile = await readServerProfile(options.root)
    this.unlock = await lockServerProfile(options.root)
    try {
      const libraryFilePath = join(options.root, 'music-library.json')
      try {
        await access(libraryFilePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await writeFile(
          libraryFilePath,
          JSON.stringify({
            version: 2,
            revision: 0,
            folders: profile.libraryRoots,
            exclusions: [],
            tracks: []
          }),
          { flag: 'wx' }
        )
      }
      const platform = await createServerPlatform({
        root: options.root,
        applicationRoot: options.applicationRoot,
        libraryRoots: profile.libraryRoots,
        vst3Roots: profile.vst3Roots,
        // Requests stay pending for the authenticated local administrator's remote.decidePairing.
        confirmDevice: async (_request, signal) => {
          signal.throwIfAborted()
          return new Promise<boolean>((resolve) =>
            signal.addEventListener('abort', () => resolve(false), { once: true })
          )
        }
      })
      const supervisor = (this.supervisor = createNodeCoreSupervisor({
        applicationRoot: options.applicationRoot,
        entryDirectory: options.entryDirectory,
        platform,
        configuration: {
          root: options.root,
          libraryFilePath,
          coverCacheDir: join(options.root, 'music-cache', 'cover-cache'),
          libraryStorage: 'sqlite',
          bridgeOnly: options.bridgeOnly,
          resumeMode: 'trackAndPosition',
          remoteStaticRoot: join(options.applicationRoot, 'resources', 'remote'),
          plugins: {
            appVersion: JSON.parse(await readFile(join(options.applicationRoot, 'package.json'), 'utf8')).version,
            headless: true, remoteManagement: profile.remotePluginManagement === true,
            bundledPlugins: [{ id: 'com.twilightecho.provider.ncm', sourcePath: join(options.applicationRoot, 'resources/plugins/ncm-provider'), defaultEnabled: false }]
          }
        },
        observe: (child, service) => {
          this.children.set(child, service)
          child.once('exit', () => this.children.delete(child))
          child.child.stdout!.on('data', (data) => this.emit('log', service, String(data)))
          child.child.stderr!.on('data', (data) => this.emit('log', service, String(data)))
        }
      }))
      supervisor.on('status', (status) => this.emit('status', status))
      supervisor.on('failure', (error) => this.emit('failure', error))
      supervisor.connect(this.identity)
      const initialized = once(supervisor, 'initialized')
      const started = supervisor.start()
      await Promise.race([initialized, started])
      const snapshot = (await this.call('query', 'state.snapshot')) as CoreSnapshot
      if (snapshot.migrationRequired) {
        // This profile was explicitly initialized empty, not adopted from a desktop installation.
        await this.call('command', 'migration.begin', {
          id: profile.id,
          manifest: { version: 1, counts: emptyCoreStateCounts() }
        })
        await this.call('command', 'migration.commit', { id: profile.id })
      }
      await started
    } catch (error) {
      await this.supervisor?.forceShutdown()
      await this.unlock()
      this.unlock = undefined
      throw error
    }
  }

  health() {
    return {
      ...this.supervisor?.getStatus(),
      error: this.supervisor?.getLastError() ?? null,
      processes: [...this.children].map(([child, service]) => ({ service, pid: child.child.pid }))
    }
  }

  request(request: CoreRequestEnvelope): Promise<unknown> {
    if (!this.supervisor) throw new Error('Server 尚未启动')
    return this.supervisor.request(this.identity.id, request)
  }

  call(kind: 'query' | 'command', name: string, payload: unknown = {}): Promise<unknown> {
    return this.request({
      kind,
      name,
      payload,
      epoch: this.supervisor?.getStatus().epoch,
      requestId: randomUUID()
    } as CoreRequestEnvelope)
  }

  async stop(force = false, beforeUnlock?: () => Promise<void>): Promise<void> {
    if (force) await this.supervisor?.forceShutdown()
    else await this.supervisor?.shutdown()
    await beforeUnlock?.()
    await this.unlock?.()
    this.unlock = undefined
    this.emit('closed')
  }
}
