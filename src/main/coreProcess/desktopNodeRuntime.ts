import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { CoreSupervisorOptions } from './supervisor.ts'

export type DesktopCoreHost = 'electron' | 'node'

export function desktopCoreHost(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): DesktopCoreHost {
  const flag = argv.findIndex(
    (argument) => argument === '--core-host' || argument.startsWith('--core-host=')
  )
  const selected =
    flag < 0
      ? env.TWILIGHT_CORE_HOST || 'electron'
      : argv[flag] === '--core-host'
        ? argv[flag + 1]
        : argv[flag].slice('--core-host='.length)
  if (selected !== 'electron' && selected !== 'node')
    throw new Error(`Unsupported Core host: ${String(selected)}`)
  return selected
}

export const DESKTOP_NODE_ENTRIES = [
  'bootstrap',
  'musicCore',
  'audioEngineService',
  'audioAnalysisService',
  'libraryDatabaseService',
  'libraryScanService',
  'modelPackWorker',
  'pluginHost'
] as const

export interface DesktopNodeRuntime {
  root: string
  executable: string
  bootstrap: string
  resourcesPath: string
  nodeVersion: string
  entries: CoreSupervisorOptions['entries']
}

export function resolveDesktopNodeRuntime(options: {
  packaged: boolean
  appPath: string
  resourcesPath: string
  platform?: NodeJS.Platform
  arch?: string
}): DesktopNodeRuntime {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const location = options.packaged
    ? join(options.resourcesPath, 'core-node')
    : join(options.appPath, 'out', 'desktop-core')
  const missing = (cause: unknown): never => {
    throw new Error(
      `Packaged Node Core runtime is unavailable at ${location}. Build/stage the desktop Core runtime before selecting --core-host=node. ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  try {
    const root = realpathSync(location)
    const ownedFile = (name: string): string => {
      const file = realpathSync(join(root, name))
      const inside = relative(root, file)
      if (
        !inside ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside) ||
        !statSync(file).isFile()
      )
        throw new Error(`Runtime file is outside its package: ${name}`)
      return file
    }
    const manifest = JSON.parse(readFileSync(ownedFile('desktop-core-runtime.json'), 'utf8'))
    if (
      manifest.schemaVersion !== 1 ||
      manifest.platform !== platform ||
      manifest.arch !== arch ||
      !/^v24\.\d+\.\d+$/.test(manifest.nodeVersion)
    )
      throw new Error('Node Core runtime platform/version does not match this application')
    const executable = ownedFile(`runtime/${platform === 'win32' ? 'node.exe' : 'node'}`)
    ownedFile('runtime/LICENSE.txt')
    const files = Object.fromEntries(
      DESKTOP_NODE_ENTRIES.map((name) => [name, ownedFile(`out/server/${name}.cjs`)])
    )
    return {
      root,
      executable,
      bootstrap: files.bootstrap,
      resourcesPath: options.packaged ? options.resourcesPath : join(options.appPath, 'resources'),
      nodeVersion: manifest.nodeVersion,
      entries: {
        core: files.musicCore,
        audio: files.audioEngineService,
        'audio-test': files.audioEngineService,
        database: files.libraryDatabaseService,
        scan: files.libraryScanService,
        analysis: files.audioAnalysisService,
        'model-install': files.modelPackWorker,
        plugin: files.pluginHost
      }
    }
  } catch (cause) {
    return missing(cause)
  }
}

export function desktopNodeEnvironment(
  runtime: DesktopNodeRuntime,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...source }
  // Loading stays inside the staged dependency closure, independent of the
  // user's Node installation, preload hooks or Electron's Node-mode switch.
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.ELECTRON_RUN_AS_NODE
  env.TWILIGHT_DESKTOP_NODE_HOST = '1'
  env.TWILIGHT_DESKTOP_RESOURCES_PATH = runtime.resourcesPath
  return env
}
