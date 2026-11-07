import type {
  CoreClientIdentity,
  CoreClientMessage,
  CoreRequestEnvelope,
  CoreServiceKind
} from './coreProtocol.ts'
import type {
  CorePlatformRequest,
  CorePlatformResponse,
  CorePlatformCancel
} from './corePlatform.ts'
import type { AudioEngineConfig } from './audioEngineTypes.ts'
import type { PlaybackResumeMode, NcmPlaybackQuality } from './appSettings.ts'
import type { DownloadPreferences } from './downloadPreferences.ts'
import type { CoreSettingsState } from './coreSettings.ts'
import type { ThemeLibrarySnapshot } from './theme.ts'
import type { AudioDiagnosticEnvironment } from './coreAudioDiagnostics.ts'

/** Private supervisor messages, never exposed by preload. Entries and environments are main-owned. */
export interface CoreProcessConfiguration {
  diagnostics?: { directory: string; environment: AudioDiagnosticEnvironment }
  epoch: string
  root: string
  libraryFilePath: string
  coverCacheDir: string
  remoteStaticRoot?: string
  libraryStorage: 'sqlite'
  recovery: boolean
  /** Windows Service hosts decode for remote Bridges; they never own a Session 0 DAC. */
  bridgeOnly?: boolean
  musicCachePath?: string
  streamingAudioCache?: 'off' | 'provider'
  ncmPlaybackQuality?: NcmPlaybackQuality
  autoMixEnabled?: boolean
  onlineLyricsFallback?: boolean
  downloadFolder?: string
  downloadPreferences?: DownloadPreferences
  plugins?: {
    remoteManagement?: boolean
    headless?: boolean
    appVersion: string
    index?: { localPath: string; remoteUrl?: string }
    bundledPlugins?: Array<{ id: string; sourcePath: string; defaultEnabled?: boolean }>
    hostIdleTimeoutMs?: number
    developerMode?: boolean
    proxy?: {
      proxyMode: 'auto' | 'custom' | 'off'
      proxyHost: string
      proxyPort: number
      proxyAllowDirectFallback: boolean
    }
  }
  resumeMode?: PlaybackResumeMode
  audioConfig?: AudioEngineConfig
}
export type CoreParentMessage =
  | CorePlatformResponse
  | { kind: 'core:initialize'; configuration: CoreProcessConfiguration }
  | { kind: 'core:service-connected'; leaseId: string }
  | { kind: 'core:service-exit'; leaseId: string; code: number | null; error?: string }
  | { kind: 'core:service-error'; leaseId: string; error: string }
  | { kind: 'core:connect'; identity: CoreClientIdentity }
  | { kind: 'core:disconnect'; clientId: string }
  | { kind: 'core:request'; clientId: string; request: CoreRequestEnvelope }
  | { kind: 'core:cancel'; clientId: string; requestId: string; epoch: string }
  | { kind: 'core:shutdown'; requestId: string }
export type CoreChildMessage =
  | { kind: 'core:themes'; epoch: string; snapshot: ThemeLibrarySnapshot }
  | { kind: 'core:settings'; epoch: string; state: CoreSettingsState }
  | CorePlatformRequest
  | CorePlatformCancel
  | { kind: 'core:booted' }
  | { kind: 'core:initialized'; epoch: string }
  | { kind: 'core:ready'; epoch: string }
  | { kind: 'core:fatal'; epoch: string; error: string }
  | { kind: 'core:service-open'; epoch: string; leaseId: string; service: CoreServiceKind }
  | { kind: 'core:service-close'; epoch: string; leaseId: string }
  | { kind: 'core:client-message'; clientId: string; message: CoreClientMessage }
  | {
      kind: 'core:shutdown-complete'
      requestId: string
      epoch: string
      ok: boolean
      error?: string
    }

export interface ServicePeerAttach {
  kind: 'core:attach-service'
}
export type AudioSupervisorRequest = { kind: 'supervisor:stop-audio'; requestId: string }
export type AudioSupervisorReply = {
  kind: 'supervisor:audio-stopped'
  requestId: string
  stopped: boolean
}
