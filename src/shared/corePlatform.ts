import type { DynamicIslandConfig } from './dynamicIsland.ts'
import type { ThemeAssetReference, ThemeAssetType, ThemeProfileV2 } from './theme.ts'
import { normalizeThemeProfile } from './theme.ts'
import type { CoreModelPackPlatformOperations } from './coreModelPack.ts'
import { inspectJsonValueWithLimits } from './jsonSafety.ts'
import { isSecureValueEnvelope, type SecureValueEnvelope } from './secureValue.ts'
import { TWILIGHT_MEDIA_PROVIDER_METHODS } from './mediaProviderMethods.ts'
import type {
  TwilightMediaProviderMethod,
  TwilightPluginManifest,
  TwilightPluginInstallEvidence
} from './pluginTypes.ts'
import type { CoreNetworkSftpRequest, CoreNetworkMountRequest } from './coreNetwork.ts'
import type { CoreDspImport } from './coreDsp.ts'
import type { Vst3HelpersAvailability } from './dspGraph.ts'
import type { CoreCastSafetyTarget } from './coreCast.ts'
import type { CoreSettingsPaths } from './coreSettings.ts'
import type { CoreAutoMixWorkerRequest } from './coreAutoMix.ts'
import type { CorePlayerPresentation } from './coreSystemPlayer.ts'
import type { CorePlatformId } from './audioEngineTypes.ts'
import { PERSONAL_MUSIC_ARTWORK_MAX_BYTES } from './personalMusicArtwork.ts'
import { isAuthorizedProviderQueueCover } from './coreQueueSubmission.ts'
/** Platform capabilities, not a generic main-process method invocation surface. */
export interface CorePlatformOperations extends CoreModelPackPlatformOperations {
  'audio.confirmWindowsRestart': { input: Record<string, never>; output: boolean }
  'audio.restartWindowsServices': { input: Record<string, never>; output: void }
  'remote.confirmDevice': {
    input: { deviceName: string; address: string; verificationCode?: string }
    output: boolean
  }
  'themes.importArchive': { input: Record<string, never>; output: ThemeProfileV2 | null }
  'themes.exportArchive': { input: { profile: ThemeProfileV2 }; output: string | null }
  'themes.deleteAssets': { input: { id: string }; output: void }
  'themes.importAsset': {
    input: { id: string; type: ThemeAssetType }
    output: ThemeAssetReference | null
  }
  'themes.copyAssets': { input: { sourceId: string; targetId: string }; output: void }
  'themes.validateAssets': { input: { id: string; assets: ThemeAssetReference[] }; output: boolean }
  'ncm.chooseUploadFiles': { input: Record<string, never>; output: string[] }
  'ncm.chooseDownloadFile': { input: { fileName: string }; output: string | null }
  'backup.chooseFile': { input: { kind: 'import' | 'export' }; output: string | null }
  'backup.chooseFolder': { input: Record<string, never>; output: string | null }
  'automix.environment': {
    input: Record<string, never>
    output: { candidates: string[]; workerDirectory: string; temporaryDirectory: string }
  }
  'automix.probe': {
    input: { packDirectory: string }
    output: { cpu: boolean; gpu: boolean; gpuName?: string }
  }
  'automix.runWorker': { input: CoreAutoMixWorkerRequest; output: void }
  'settings.authorizePaths': { input: CoreSettingsPaths; output: CoreSettingsPaths }
  'cast.arm': { input: { target: CoreCastSafetyTarget }; output: void }
  'cast.disarm': { input: { deviceId: string }; output: void }
  'dsp.environment': {
    input: Record<string, never>
    output: {
      platform: CorePlatformId
      temporaryDirectory: string
      searchPaths: string[]
      helpers: Vst3HelpersAvailability
    }
  }
  'dsp.chooseFile': { input: { kind: CoreDspImport['kind'] }; output: string | null }
  'dsp.chooseExportFile': { input: Record<string, never>; output: string | null }
  'dsp.chooseVst3Directory': { input: Record<string, never>; output: string | null }
  'dsp.authorizeImpulse': { input: { path: string }; output: string }
  'dsp.authorizeVst3Paths': { input: { paths: string[] }; output: string[] }
  'dsp.registerVst3Paths': { input: { paths: string[] }; output: string[] }
  'cache.authorizeRoot': { input: Record<string, never>; output: string }
  'cache.clearPlatform': { input: Record<string, never>; output: void }
  'downloads.authorizedRoots': {
    input: { libraryFolders: string[]; downloadFolder: string }
    output: { libraryRoots: string[]; downloadRoot: string | null }
  }
  'downloads.grantResult': { input: { path: string }; output: string }
  'downloads.reveal': { input: { path: string }; output: void }
  'downloads.cover': {
    input: { handle: string }
    output: { bytes: Uint8Array; mime: string } | null
  }
  'network.environment': {
    input: Record<string, never>
    output: { platform: CorePlatformId; tempRoot: string; gvfsRoot: string | null }
  }
  'network.protectCredential': { input: { plain: string }; output: string }
  'network.unprotectCredential': { input: { encrypted: string }; output: string }
  'network.sftp': {
    input: CoreNetworkSftpRequest
    output: { stdout: string; stderr: string; code: number }
  }
  'network.mountCommand': {
    input: CoreNetworkMountRequest
    output: { stdout: string; stderr: string; code: number }
  }
  'lyrics.chooseImportFile': { input: Record<string, never>; output: string | null }
  'lyrics.chooseExportFile': { input: Record<string, never>; output: string | null }
  'paths.authorizeAudioFile': { input: { path: string }; output: string }
  'paths.areAudioFilesAuthorized': { input: { paths: string[] }; output: boolean[] }
  'playlists.chooseImportFile': { input: Record<string, never>; output: string | null }
  'ncm.officialLogin': { input: Record<string, never>; output: string }
  'overlay.show': { input: { pluginId: string }; output: void }
  'overlay.hide': { input: { pluginId: string }; output: void }
  'overlay.isOwner': { input: { pluginId: string }; output: boolean }
  'overlay.configure': { input: { pluginId: string; config: unknown }; output: DynamicIslandConfig }
  'host.captureScreenshot': { input: Record<string, never>; output: string | null }
  'paths.authorizeAudio': { input: { source: string }; output: string }
  'paths.prepareAudio': { input: { source: string }; output: string | null }
  'paths.authorizeLibraryDirectory': { input: { path: string }; output: string }
  'files.trashAudio': { input: { path: string }; output: void }
  'artwork.normalizeCachedCover': { input: { handle: string }; output: string }
  'artwork.remotePreview': { input: { cover: string | null }; output: string | null }
  'artwork.resolveQueueCovers': {
    input: { covers: string[] }
    output: Record<string, { cover: string | null; coverSource: string | null }>
  }
  'artwork.present': {
    input: { cover: string | null; coverSource: string | null; imageExpiresAt?: number; retainMetadata?: boolean }
    output: Pick<CorePlayerPresentation, 'cover' | 'coverSource'>
  }
  'media.resolveAudio': { input: { handle: string }; output: { source: string } }
  'media.protectProviderResult': {
    input: { value: unknown; method: TwilightMediaProviderMethod }
    output: unknown
  }
  'credentials.protect': { input: { scope: string; value: unknown }; output: SecureValueEnvelope }
  'credentials.unprotect': { input: { scope: string; value: SecureValueEnvelope }; output: unknown }
  'plugins.exportExperience': { input: { name: string; content: string }; output: { saved: boolean } }
  'plugins.prepareDisable': { input: { id: string }; output: void }
  'plugins.chooseInstallSource': { input: { kind: 'package' | 'directory' }; output: string | null }
  'plugins.confirmInstall': {
    input: { manifest: TwilightPluginManifest; evidence: TwilightPluginInstallEvidence }
    output: boolean
  }
  'plugins.showLog': { input: { path: string }; output: void }
  'plugins.notifyStateIssue': { input: { type: 'warning' | 'error'; detail: string }; output: void }
}
export type CorePlatformRequest = {
  [K in keyof CorePlatformOperations]: {
    kind: 'core:platform'
    epoch: string
    requestId: string
    name: K
    payload: CorePlatformOperations[K]['input']
  }
}[keyof CorePlatformOperations]
export type CorePlatformResponse = {
  kind: 'core:platform-response'
  requestId: string
  epoch: string
} & ({ ok: true; value: unknown } | { ok: false; error: string })
export interface CorePlatformCancel {
  kind: 'core:platform-cancel'
  epoch: string
  requestId: string
}

export function validCorePlatformPayload(request: CorePlatformRequest): boolean {
  if (
    !request.payload ||
    typeof request.payload !== 'object' ||
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    request.requestId.length > 128
  )
    return false
  const payload = request.payload
  const themeId = (value: unknown) =>
    typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  switch (request.name) {
    case 'remote.confirmDevice': {
      const value = payload as CorePlatformOperations['remote.confirmDevice']['input']
      const keys = Object.keys(payload).length
      return (keys === 2 || (keys === 3 && typeof value.verificationCode === 'string' && /^\d{6}$/.test(value.verificationCode))) &&
        typeof value.deviceName === 'string' &&
        // eslint-disable-next-line no-control-regex -- Native approval prompts only accept printable device labels.
        value.deviceName.length > 0 && value.deviceName.length <= 80 && !/[\x00-\x1f\x7f]/.test(value.deviceName) &&
        typeof value.address === 'string' && value.address.length <= 64 && /^[a-fA-F0-9:.]*$/.test(value.address)
    }
    case 'artwork.remotePreview': {
      const { cover } = payload as CorePlatformOperations['artwork.remotePreview']['input']
      return (
        Object.keys(payload).length === 1 &&
        (cover === null ||
          (typeof cover === 'string' &&
            cover.length <= Math.ceil(PERSONAL_MUSIC_ARTWORK_MAX_BYTES / 3) * 4 + 32 &&
            (/^cover:\/\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp)$/.test(cover) ||
              cover.startsWith('twilight-media://image/') ||
              /^data:image\/(?:png|jpe?g|webp);base64,/i.test(cover))))
      )
    }
    case 'artwork.present': {
      const value = payload as CorePlatformOperations['artwork.present']['input']
      return (
        Object.keys(payload).every(k => ['cover','coverSource','imageExpiresAt','retainMetadata'].includes(k)) &&
        (value.retainMetadata === undefined || typeof value.retainMetadata === 'boolean') &&
        (value.imageExpiresAt === undefined || (Number.isSafeInteger(value.imageExpiresAt) && value.imageExpiresAt > 0)) &&
        [value.cover, value.coverSource].every(
          (field) =>
            field === null ||
            (typeof field === 'string' && field.length <= 2 * 1024 * 1024 && !field.includes('\0'))
        )
      )
    }
    case 'artwork.resolveQueueCovers': {
      const { covers } = payload as CorePlatformOperations['artwork.resolveQueueCovers']['input']
      return (
        Object.keys(payload).length === 1 &&
        Array.isArray(covers) &&
        covers.length <= 200 &&
        covers.every(isAuthorizedProviderQueueCover)
      )
    }
    case 'themes.importArchive':
      return Object.keys(payload).length === 0
    case 'themes.exportArchive':
      return (
        Object.keys(payload).length === 1 &&
        !!normalizeThemeProfile((payload as { profile: ThemeProfileV2 }).profile)
      )
    case 'themes.deleteAssets':
      return Object.keys(payload).length === 1 && themeId((payload as { id: string }).id)
    case 'themes.importAsset': {
      const value = payload as { id: string; type: ThemeAssetType }
      return (
        Object.keys(payload).length === 2 &&
        themeId(value.id) &&
        ['image', 'font'].includes(value.type)
      )
    }
    case 'themes.copyAssets': {
      const value = payload as { sourceId: string; targetId: string }
      return Object.keys(payload).length === 2 && themeId(value.sourceId) && themeId(value.targetId)
    }
    case 'automix.chooseArchive':
      return Object.keys(payload).length === 0
    case 'automix.decodeArchiveEntry': {
      const value = payload as { directory: string; bytes: number }
      return (
        Object.keys(payload).length === 2 &&
        typeof value.directory === 'string' &&
        value.directory.length > 0 &&
        value.directory.length <= 32768 &&
        !value.directory.includes('\0') &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes >= 0 &&
        value.bytes <= 8 * 1024 * 1024 * 1024
      )
    }
    case 'themes.validateAssets': {
      const value = payload as { id: string; assets: ThemeAssetReference[] }
      return (
        Object.keys(payload).length === 2 &&
        typeof value.id === 'string' &&
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.id) &&
        Array.isArray(value.assets) &&
        value.assets.length <= 256 &&
        value.assets.every(
          (asset) =>
            asset &&
            typeof asset.id === 'string' &&
            typeof asset.path === 'string' &&
            ['image', 'font'].includes(asset.type)
        )
      )
    }
    case 'ncm.chooseUploadFiles':
      return Object.keys(payload).length === 0
    case 'ncm.chooseDownloadFile': {
      const { fileName } = payload as { fileName: string }
      return (
        Object.keys(payload).length === 1 &&
        typeof fileName === 'string' &&
        fileName.length > 0 &&
        fileName.length <= 255 &&
        !/[\\/\0\r\n]/.test(fileName)
      )
    }
    case 'backup.chooseFile':
      return (
        Object.keys(payload).length === 1 &&
        ['import', 'export'].includes(String((payload as { kind: string }).kind))
      )
    case 'backup.chooseFolder':
      return Object.keys(payload).length === 0
    case 'automix.environment':
      return Object.keys(payload).length === 0
    case 'automix.probe':
    case 'automix.probeInstall':
    case 'automix.runWorker': {
      const value = payload as CoreAutoMixWorkerRequest
      const path = (v: unknown) =>
        typeof v === 'string' && v.length > 0 && v.length <= 32768 && !v.includes('\0')
      return (
        path(value.packDirectory) &&
        (request.name !== 'automix.runWorker'
          ? Object.keys(payload).length === 1
          : Object.keys(payload).length === 3 &&
            path(value.requestPath) &&
            Number.isInteger(value.budgetMs) &&
            value.budgetMs >= 1000 &&
            value.budgetMs <= 90000)
      )
    }
    case 'settings.authorizePaths': {
      const paths = payload as CoreSettingsPaths
      return (
        Object.keys(paths).every((key) =>
          ['libraryFolders', 'downloadFolder', 'musicCachePath'].includes(key)
        ) &&
        (paths.libraryFolders === undefined ||
          (Array.isArray(paths.libraryFolders) &&
            paths.libraryFolders.length <= 256 &&
            paths.libraryFolders.every(
              (path) =>
                typeof path === 'string' &&
                path.length > 0 &&
                path.length <= 32768 &&
                !path.includes('\0')
            ))) &&
        [paths.downloadFolder, paths.musicCachePath].every(
          (path) =>
            path === undefined ||
            (typeof path === 'string' && path.length <= 32768 && !path.includes('\0'))
        )
      )
    }
    case 'cast.arm': {
      const target = (payload as { target: CoreCastSafetyTarget }).target
      if (
        Object.keys(payload).length !== 1 ||
        !target ||
        typeof target.deviceId !== 'string' ||
        !target.deviceId ||
        target.deviceId.length > 512
      )
        return false
      if (target.protocol === 'dlna')
        return (
          Object.keys(target).length === 3 &&
          typeof target.controlUrl === 'string' &&
          target.controlUrl.length <= 8192 &&
          /^https?:\/\//i.test(target.controlUrl)
        )
      return (
        target.protocol === 'chromecast' &&
        Object.keys(target).length === 5 &&
        typeof target.host === 'string' &&
        target.host.length > 0 &&
        target.host.length <= 255 &&
        Number.isInteger(target.port) &&
        target.port > 0 &&
        target.port <= 65535 &&
        typeof target.receiverSessionId === 'string' &&
        target.receiverSessionId.length > 0 &&
        target.receiverSessionId.length <= 512
      )
    }
    case 'cast.disarm':
      return (
        Object.keys(payload).length === 1 &&
        typeof (payload as { deviceId: string }).deviceId === 'string' &&
        (payload as { deviceId: string }).deviceId.length > 0 &&
        (payload as { deviceId: string }).deviceId.length <= 512
      )
    case 'audio.confirmWindowsRestart':
    case 'audio.restartWindowsServices':
    case 'dsp.environment':
    case 'dsp.chooseExportFile':
    case 'dsp.chooseVst3Directory':
      return Object.keys(payload).length === 0
    case 'dsp.chooseFile':
      return (
        Object.keys(payload).length === 1 &&
        [
          'impulseResponse',
          'correctionProfile',
          'vst3Preset',
          'vst3State',
          'profile',
          'frequencyResponse',
          'impulsePath'
        ].includes(String((payload as { kind: string }).kind))
      )
    case 'dsp.authorizeVst3Paths':
    case 'dsp.registerVst3Paths': {
      const paths = (payload as { paths: string[] }).paths
      return (
        Object.keys(payload).length === 1 &&
        Array.isArray(paths) &&
        paths.length <= 32 &&
        paths.every(
          (path) =>
            typeof path === 'string' &&
            path.length > 0 &&
            path.length <= 32768 &&
            !path.includes('\0')
        )
      )
    }
    case 'downloads.authorizedRoots': {
      const value = payload as CorePlatformOperations['downloads.authorizedRoots']['input']
      return (
        Object.keys(value).length === 2 &&
        Array.isArray(value.libraryFolders) &&
        value.libraryFolders.length <= 256 &&
        value.libraryFolders.every(
          (path) => typeof path === 'string' && path.length <= 32768 && !path.includes('\0')
        ) &&
        typeof value.downloadFolder === 'string' &&
        value.downloadFolder.length <= 32768 &&
        !value.downloadFolder.includes('\0')
      )
    }
    case 'downloads.cover': {
      const value = payload as { handle: string }
      return (
        Object.keys(value).length === 1 &&
        typeof value.handle === 'string' &&
        /^twilight-media:\/\/image\/[a-zA-Z0-9_-]{1,256}$/.test(value.handle)
      )
    }
    case 'paths.areAudioFilesAuthorized': {
      const value = payload as CorePlatformOperations['paths.areAudioFilesAuthorized']['input']
      return (
        Object.keys(value).length === 1 &&
        Array.isArray(value.paths) &&
        value.paths.length <= 256 &&
        value.paths.every(
          (path) =>
            typeof path === 'string' &&
            path.length > 0 &&
            path.length <= 32768 &&
            !path.includes('\0')
        )
      )
    }
    case 'network.environment':
    case 'cache.authorizeRoot':
    case 'cache.clearPlatform':
      return Object.keys(payload).length === 0
    case 'network.protectCredential':
    case 'network.unprotectCredential': {
      const field = request.name === 'network.protectCredential' ? 'plain' : 'encrypted'
      const value = (payload as unknown as Record<string, unknown>)[field]
      return (
        Object.keys(payload).length === 1 && typeof value === 'string' && value.length <= 16 * 1024
      )
    }
    case 'network.sftp': {
      const value = payload as CoreNetworkSftpRequest
      return (
        inspectJsonValueWithLimits(value, 32 * 1024).ok &&
        !!value.connection &&
        [
          value.connection.host,
          value.connection.username,
          value.connection.keyPath,
          value.operation?.path
        ].every(
          (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v)
        ) &&
        Number.isInteger(value.connection.port) &&
        value.connection.port > 0 &&
        value.connection.port <= 65535 &&
        (value.operation.kind === 'list' ||
          (value.operation.kind === 'download' &&
            typeof value.operation.local === 'string' &&
            value.operation.local.length <= 4096))
      )
    }
    case 'network.mountCommand': {
      const value = payload as CoreNetworkMountRequest
      return (
        ['net', 'gio', 'mount', 'umount'].includes(value.command) &&
        Array.isArray(value.args) &&
        value.args.length <= 5 &&
        value.args.every((v) => typeof v === 'string' && v.length <= 4096 && !/[\0\r\n]/.test(v))
      )
    }
    case 'ncm.officialLogin':
    case 'playlists.chooseImportFile':
    case 'lyrics.chooseImportFile':
    case 'lyrics.chooseExportFile':
    case 'host.captureScreenshot':
      return Object.keys(payload).length === 0
    case 'overlay.show':
    case 'overlay.hide':
    case 'overlay.isOwner':
    case 'overlay.configure': {
      const value = payload as { pluginId: string; config?: unknown }
      return (
        typeof value.pluginId === 'string' &&
        /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(value.pluginId) &&
        value.pluginId.length <= 128 &&
        Object.keys(value).length === (request.name === 'overlay.configure' ? 2 : 1) &&
        inspectJsonValueWithLimits(payload, 128 * 1024).ok
      )
    }
    case 'credentials.protect':
    case 'credentials.unprotect': {
      const value = payload as CorePlatformOperations['credentials.protect']['input']
      return (
        Object.keys(value).length === 2 &&
        typeof value.scope === 'string' &&
        value.scope.startsWith('plugin-settings:') &&
        value.scope.length <= 8192 &&
        !value.scope.includes('\0') &&
        inspectJsonValueWithLimits(value.value, 1024 * 1024).ok &&
        (request.name !== 'credentials.unprotect' || isSecureValueEnvelope(value.value))
      )
    }
    case 'media.protectProviderResult': {
      const value = payload as CorePlatformOperations['media.protectProviderResult']['input']
      return (
        (TWILIGHT_MEDIA_PROVIDER_METHODS as readonly string[]).includes(value.method) &&
        inspectJsonValueWithLimits(payload, 16 * 1024 * 1024).ok
      )
    }
    case 'plugins.prepareDisable':
      return Object.keys(payload).length === 1 && typeof (payload as { id: string }).id === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test((payload as { id: string }).id)
    case 'plugins.exportExperience': {
      const value = payload as { name: string; content: string }
      return Object.keys(payload).length === 2 && typeof value.name === 'string' && /^[a-zA-Z0-9_.-]{1,100}\.(md|json|txt)$/.test(value.name) && typeof value.content === 'string' && new TextEncoder().encode(value.content).length <= 4 * 1024 * 1024
    }
    case 'plugins.chooseInstallSource':
      return (
        Object.keys(payload).length === 1 &&
        ['package', 'directory'].includes((payload as { kind: string }).kind)
      )
    case 'plugins.confirmInstall': {
      const value = payload as CorePlatformOperations['plugins.confirmInstall']['input']
      return (
        !!value.manifest &&
        !!value.evidence &&
        Object.keys(value).length === 2 &&
        inspectJsonValueWithLimits(payload, 512 * 1024).ok
      )
    }
    case 'plugins.notifyStateIssue': {
      const value = payload as CorePlatformOperations['plugins.notifyStateIssue']['input']
      return (
        ['warning', 'error'].includes(value.type) &&
        typeof value.detail === 'string' &&
        value.detail.length <= 8192
      )
    }
  }
  const fields = {
    'dsp.authorizeImpulse': 'path',
    'downloads.grantResult': 'path',
    'downloads.reveal': 'path',
    'paths.authorizeAudioFile': 'path',
    'paths.authorizeAudio': 'source',
    'paths.prepareAudio': 'source',
    'paths.authorizeLibraryDirectory': 'path',
    'files.trashAudio': 'path',
    'artwork.normalizeCachedCover': 'handle',
    'media.resolveAudio': 'handle',
    'plugins.showLog': 'path'
  }
  if (
    !Object.hasOwn(fields, request.name) ||
    typeof request.requestId !== 'string' ||
    !request.requestId ||
    request.requestId.length > 128
  )
    return false
  const field = fields[request.name as keyof typeof fields]
  if (
    !request.payload ||
    typeof request.payload !== 'object' ||
    Object.keys(request.payload).length !== 1
  )
    return false
  const value = (request.payload as Record<string, unknown>)[field]
  if (typeof value !== 'string' || !value || value.length > 32_768 || value.includes('\0'))
    return false
  return (
    request.name !== 'artwork.normalizeCachedCover' ||
    /^cover:\/\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)$/.test(value)
  )
}
