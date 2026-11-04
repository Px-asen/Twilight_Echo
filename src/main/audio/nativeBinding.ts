import { existsSync, readFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { NativeAudioBinding } from './audioEngineTypes.ts'

const require = createRequire(import.meta.url)

type ElectronModule = typeof import('electron')

export function resolveElectronApp(
  electronVersion = process.versions.electron,
  loadModule: () => ElectronModule | string = () => require('electron')
): ElectronModule['app'] | null {
  // In plain Node, importing the SDK only yields an executable path and may
  // lazily download its binary. App discovery belongs to an Electron runtime.
  if (!electronVersion) return null
  try {
    const electronModule = loadModule()
    if (typeof electronModule === 'object' && electronModule && 'app' in electronModule) {
      return electronModule.app
    }
  } catch {
    // Node-side tests can import this module without an Electron runtime.
  }
  return null
}

const electronApp = resolveElectronApp()

interface NativeAddonLocationContext {
  binary?: string
  modulePath?: string
  resourcesPath?: string
  appPath?: string
  cwd?: string
}

export function getNativeAddonCandidates(context: NativeAddonLocationContext = {}): string[] {
  const binary = context.binary ?? 'twilight_audio_node.node'
  const modulePath = context.modulePath ?? fileURLToPath(import.meta.url)
  // Electron utility processes do not expose the main process's resourcesPath
  // or app singleton. Resolve their own archive first, without consulting the
  // launch directory: a stale checkout must never replace a packaged addon.
  const archive = modulePath.match(/^(.*[/\\][^/\\]+\.asar)(?:[/\\]|$)/i)?.[1]
  if (archive) return [join(dirname(archive), 'audio-engine', binary)]

  // The same anchoring supports built development workers and direct TS tools.
  const moduleRoot = modulePath.match(/^(.*)[/\\](?:out[/\\](?:main|server)|src[/\\]main)[/\\]/i)?.[1]
  const appPath =
    context.appPath ?? electronApp?.getAppPath?.() ?? moduleRoot ?? context.cwd ?? process.cwd()
  const resourcesPath = context.resourcesPath ?? process.resourcesPath
  return [
    ...new Set([
      ...(resourcesPath ? [join(resourcesPath, 'audio-engine', binary)] : []),
      join(appPath, 'resources', 'audio-engine', binary),
      join(appPath, 'audio-engine', 'build', 'default', binary),
      join(appPath, 'audio-engine', 'build', 'mingw-static', binary),
      join(appPath, 'audio-engine', 'build', 'windows-msvc', binary),
      join(appPath, '..', 'audio-engine', 'build', 'default', binary),
      join(appPath, '..', 'audio-engine', 'build', 'mingw-static', binary),
      join(appPath, '..', 'audio-engine', 'build', 'windows-msvc', binary)
    ])
  ]
}

export function rendererFallbackAllowed(): boolean {
  // Retained for older preload clients. Native playback is the only renderer
  // audio route; a missing native engine is a real playback error.
  return false
}

export type NativeBindingLoadAttempt = { candidate: string; error: string }

export type NativeBindingLoadResult = {
  binding: NativeAudioBinding | null
  runtime?: Record<string, string>
  /** Candidates that existed on disk but could not be required. */
  attempts: NativeBindingLoadAttempt[]
  candidateCount: number
}

export function nativeRuntimeIdentity(candidate: string): Record<string, string> {
  const directory = dirname(candidate)
  const runtime: Record<string, string> = { addonPath: candidate }
  for (const name of [
    'twilight_audio_node.node',
    'twilight-audio-engine.dll',
    'automix-native/beat-this.tamg',
    'automix-native/yamnet.tamg'
  ]) {
    try {
      runtime[name] = createHash('sha256')
        .update(readFileSync(join(directory, name)))
        .digest('hex')
    } catch {
      runtime[name] = 'unavailable'
    }
  }
  return runtime
}

const MAX_NATIVE_FAILURE_DETAIL = 240

export function loadNativeBindingWithDiagnostics(
  getCandidates: () => string[] = getNativeAddonCandidates
): NativeBindingLoadResult {
  const candidates = getCandidates()
  const attempts: NativeBindingLoadAttempt[] = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      // Native addons must be loaded dynamically because the file is produced by CMake.
      return {
        binding: require(candidate) as NativeAudioBinding,
        runtime: nativeRuntimeIdentity(candidate),
        attempts,
        candidateCount: candidates.length
      }
    } catch (err) {
      attempts.push({ candidate, error: err instanceof Error ? err.message : String(err) })
      console.warn('原生音频模块加载失败：', candidate, err)
    }
  }
  return { binding: null, attempts, candidateCount: candidates.length }
}

export function loadNativeBinding(
  getCandidates: () => string[] = getNativeAddonCandidates
): NativeAudioBinding | null {
  return loadNativeBindingWithDiagnostics(getCandidates).binding
}

/**
 * Why the addon is unavailable, phrased for the crash notice the user sees.
 * A file that is absent and a file that fails to dlopen (on Windows, almost
 * always a runtime DLL missing beside it) need completely different repairs, so
 * the reason carries the real loader error instead of collapsing both cases into
 * a bare "未加载 twilight_audio_node.node".
 */
export function describeNativeBindingFailure(result: NativeBindingLoadResult): string {
  if (result.binding) return ''
  const prefix = '未加载 twilight_audio_node.node'
  const [firstAttempt] = result.attempts
  if (!firstAttempt) {
    if (result.candidateCount === 0) return `${prefix}（没有可用的模块路径）`
    return `${prefix}（${result.candidateCount} 个候选路径均不存在）`
  }
  // The Windows loader puts its description on the first line and the module
  // path on the next, so keep the line that names the actual failure.
  const reason = firstAttempt.error.split('\n')[0].trim() || '未知错误'
  const detail = `${firstAttempt.candidate}：${reason}`
  return `${prefix}（${detail.length > MAX_NATIVE_FAILURE_DETAIL ? `${detail.slice(0, MAX_NATIVE_FAILURE_DETAIL)}…` : detail}）`
}
