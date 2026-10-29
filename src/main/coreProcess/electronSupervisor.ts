import { openNcmOfficialLogin } from '../ncm/api.ts'
import {
  validateThemeProfileAssets,
  deleteThemeAssets,
  copyThemeAssets
} from '../themes/themeArchive.ts'
import {
  chooseAndImportThemeArchive,
  chooseAndExportThemeArchive,
  chooseAndImportThemeAsset
} from '../themes/coreThemePlatform.ts'
import { BrowserWindow, dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { prepareThemeWorkshopDisable } from '../ipc/themeWorkshop.ts'
import { THEME_WORKSHOP_ID } from '../../shared/themeWorkshop.ts'
import { resolveRemoteArtwork } from './remoteArtwork.ts'
import type { ThemeLibrarySnapshot } from '../../shared/theme.ts'
import {
  chooseNcmCloudUploadFiles,
  chooseNcmCloudDownloadFile
} from '../ncm/cloudTransferPlatform.ts'
import { choosePlaylistImportFile } from '../library/playlistImportDialog.ts'
import {
  choosePersonalBackupFile,
  choosePersonalRestoreFolder
} from '../persistence/personalBackupDialogs.ts'
import { chooseLyricsImportFile, chooseLyricsExportFile } from '../lyrics/dialogs.ts'
import {
  showDynamicIsland,
  hideDynamicIsland,
  configureDynamicIsland,
  isDynamicIslandOwner
} from '../integrations/dynamicIsland.ts'
import { MessageChannelMain, utilityProcess, session, app } from 'electron'
import { CastOutputSupervisor } from './castOutputSupervisor.ts'
import { dlnaStop } from '../../core/cast/dlnaClient.ts'
import { chromecastStopReceiver } from '../../core/cast/chromecastClient.ts'
import { join, sep } from 'node:path'
import { release } from 'node:os'
import { CoreSupervisor, type CoreSupervisorOptions, type SupervisedProcess } from './supervisor.ts'
import type { ServiceMessagePort } from '../services/servicePort.ts'
import { observeUtilityProcess } from '../diagnostics/utilityObservation.ts'
import { audioServiceEnv } from '../audioEngineServiceClient.ts'
import {
  resolveAuthorizedAudioSource,
  resolveAuthorizedLibraryDirectory,
  resolveAuthorizedAudioFile,
  filterAuthorizedLibraryRoots,
  resolveConfiguredDownloadRoot,
  grantCompletedDownloadAudioFile,
  resolveAuthorizedShowItemPath,
  resolveAuthorizedCacheRoot
} from '../security/localPaths.ts'
import { fetchDownloadCover } from '../plugins/downloadPlatform.ts'
import { trashLocalFileWithRetry } from '../security/localTrash.ts'
import {
  normalizeCachedCoverHandle,
  maintainCoverCache,
  migrateBase64Cover
} from '../library/coverCache.ts'
import { createArtworkProjection, createQueueCoverResolver } from './artworkProjection.ts'
import { mediaCoverCache, metadataArtworkCache } from '../cache/mediaCoverCache.ts'
import { clearProtocolAssetCache } from '../cache/protocolAssetCache.ts'
import { createPlatformCacheMaintenance } from '../cache/platformCacheMaintenance.ts'
import { createPluginManagerPlatform } from '../plugins/platform.ts'
import { protectJsonValue, unprotectJsonValue } from '../security/secureStorage.ts'
import { remoteMediaGrants } from '../security/remoteMediaGrants.ts'
import { assertLocalPluginInstallSourceAllowed } from '../plugins/installDialog.ts'
import { buildPluginProxyEnv } from '../plugins/proxyBootstrap.ts'
import { createNetworkCorePlatform } from '../network/corePlatform.ts'
import { resolveAuthorizationBatch } from '../security/authorizationBatch.ts'
import { createDspCorePlatform } from '../dsp/corePlatform.ts'
import { createAutoMixCorePlatform } from '../audio/autoMixCorePlatform.ts'
import { createAudioRecoveryCorePlatform } from '../audio/recoveryCorePlatform.ts'
import { projectCoreSettings } from './settingsProjection.ts'
import type { CoreSettingsState } from '../../shared/coreSettings.ts'
import {
  resolveAuthorizedLibraryRootSettings,
  resolveAuthorizedDownloadRootSetting
} from '../security/localPaths.ts'

export function createElectronCoreSupervisor(
  configuration: CoreSupervisorOptions['configuration']
): CoreSupervisor {
  const castOutput = new CastOutputSupervisor((target) =>
    target.protocol === 'dlna'
      ? dlnaStop(target.controlUrl)
      : chromecastStopReceiver(target.host, target.port, target.receiverSessionId)
  )
  const autoMixProcesses = createAutoMixCorePlatform(configuration.root)
  let musicCacheRoot = configuration.musicCachePath || join(configuration.root, 'music-cache')
  let projectedLaunchSettings = false
  let developerMode = configuration.plugins?.developerMode === true
  const authorizeCacheRoot = () => resolveAuthorizedCacheRoot(musicCacheRoot)
  let platformCacheMaintenance: ReturnType<typeof createPlatformCacheMaintenance> | undefined
  const clearPlatformCaches = (signal: AbortSignal) => {
    platformCacheMaintenance ??= createPlatformCacheMaintenance({
      root: musicCacheRoot,
      legacyCover: join(configuration.root, 'cover-cache'),
      authorizeRoot: authorizeCacheRoot,
      maintainRemote: (action) => mediaCoverCache.maintain(action),
      maintainCovers: maintainCoverCache,
      clearMemory: clearProtocolAssetCache,
      clearChromium: () => session.defaultSession.clearCache()
    })
    return platformCacheMaintenance(signal)
  }
  const plugins = createPluginManagerPlatform({
    userData: configuration.root,
    launchHost: () => {
      throw new Error('Plugin hosts must be launched by the Core service registry')
    }
  })
  const validateScope = (scope: string): void => {
    const prefix = `plugin-settings:${join(configuration.root, 'plugin-data')}${sep}`
    if (
      !scope.startsWith(prefix) ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+:[^\0\r\n]{1,128}$/.test(scope.slice(prefix.length))
    )
      throw new Error('Plugin credential scope is outside this profile')
  }
  const supervisor = new CoreSupervisor({
    configuration: {
      ...configuration,
      diagnostics: {
        directory: join(app.getPath('logs'), 'audio'),
        environment: {
          appName: app.getName(),
          appVersion: app.getVersion(),
          packaged: app.isPackaged,
          platform: process.platform,
          architecture: process.arch,
          osRelease: release(),
          locale: app.getLocale(),
          processVersions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            modules: process.versions.modules
          }
        }
      },
      remoteStaticRoot:
        configuration.remoteStaticRoot ??
        (app.isPackaged
          ? join(process.resourcesPath, 'remote')
          : join(app.getAppPath(), 'resources', 'remote'))
    },
    stopOutputs: async () => {
      await Promise.all([castOutput.stop(), autoMixProcesses.idle()])
    },
    platform: {
      ...createAudioRecoveryCorePlatform(),
      'remote.confirmDevice': async ({ deviceName, address, verificationCode }, signal) => {
        signal.throwIfAborted()
        const code = verificationCode
          ? `验证码：${verificationCode.slice(0, 3)} ${verificationCode.slice(3)}\n请确认手机上显示的验证码与此一致；不一致时请拒绝。\n`
          : ''
        const result = await dialog.showMessageBox({
          type: 'question', title: '连接 Twilight Echo',
          message: `允许“${deviceName}”连接这台电脑？`,
          detail: `${code}来源：${address}\n允许后可浏览曲库并控制电脑播放。仅允许你正在操作的设备。`,
          buttons: ['允许连接', '拒绝'], defaultId: 1, cancelId: 1, noLink: true, signal
        })
        signal.throwIfAborted()
        return result.response === 0
      },
      'themes.deleteAssets': ({ id }) => deleteThemeAssets(id),
      'themes.copyAssets': ({ sourceId, targetId }) => copyThemeAssets(sourceId, targetId),
      'themes.importArchive': () => chooseAndImportThemeArchive(),
      'themes.exportArchive': ({ profile }) => chooseAndExportThemeArchive(profile),
      'themes.importAsset': ({ id, type }) => chooseAndImportThemeAsset(id, type),
      'themes.validateAssets': async ({ id, assets }, signal) => {
        const valid = await validateThemeProfileAssets(id, assets)
        signal.throwIfAborted()
        return valid
      },
      'ncm.chooseUploadFiles': async (_payload, signal) => {
        const paths = await chooseNcmCloudUploadFiles()
        signal.throwIfAborted()
        return paths
      },
      'ncm.chooseDownloadFile': async ({ fileName }, signal) => {
        const path = await chooseNcmCloudDownloadFile(fileName)
        signal.throwIfAborted()
        return path
      },
      'backup.chooseFile': async ({ kind }, signal) => {
        const path = await choosePersonalBackupFile(kind)
        signal.throwIfAborted()
        return path
      },
      'backup.chooseFolder': async (_payload, signal) => {
        const path = await choosePersonalRestoreFolder()
        signal.throwIfAborted()
        return path
      },
      'settings.authorizePaths': async (paths, signal) => {
        const result = { ...paths }
        if (paths.libraryFolders !== undefined)
          result.libraryFolders = await resolveAuthorizedLibraryRootSettings(paths.libraryFolders)
        if (paths.downloadFolder !== undefined)
          result.downloadFolder = await resolveAuthorizedDownloadRootSetting(paths.downloadFolder)
        if (paths.musicCachePath !== undefined)
          result.musicCachePath = await resolveAuthorizedCacheRoot(paths.musicCachePath)
        signal.throwIfAborted()
        return result
      },
      'cast.arm': async ({ target }, signal) => {
        signal.throwIfAborted()
        castOutput.arm(target)
      },
      'cast.disarm': async ({ deviceId }) => {
        castOutput.disarm(deviceId)
      },
      ...createDspCorePlatform(),
      ...autoMixProcesses.operations,
      'cache.authorizeRoot': authorizeCacheRoot,
      'cache.clearPlatform': (_payload, signal) => clearPlatformCaches(signal),
      'downloads.authorizedRoots': async ({ libraryFolders, downloadFolder }) => ({
        libraryRoots: await filterAuthorizedLibraryRoots(libraryFolders),
        downloadRoot: await resolveConfiguredDownloadRoot(downloadFolder)
      }),
      'downloads.grantResult': async ({ path }) =>
        grantCompletedDownloadAudioFile(await resolveAuthorizedShowItemPath(path)),
      'downloads.reveal': async ({ path }) => {
        shell.showItemInFolder(await resolveAuthorizedAudioFile(path))
      },
      'downloads.cover': ({ handle }, signal) => fetchDownloadCover(handle, signal),
      ...createNetworkCorePlatform(configuration.root),
      'lyrics.chooseImportFile': async (_payload, signal) => {
        const path = await chooseLyricsImportFile()
        signal.throwIfAborted()
        return path
      },
      'lyrics.chooseExportFile': async (_payload, signal) => {
        const path = await chooseLyricsExportFile()
        signal.throwIfAborted()
        return path
      },
      'paths.authorizeAudioFile': ({ path }) => resolveAuthorizedAudioFile(path),
      'paths.areAudioFilesAuthorized': async ({ paths }, signal) => {
        const verdicts = await resolveAuthorizationBatch(paths, async (path) => {
          signal.throwIfAborted()
          try {
            await resolveAuthorizedAudioFile(path)
            return true
          } catch {
            return false
          }
        })
        return paths.map((path) => verdicts.get(path) === true)
      },
      'playlists.chooseImportFile': async (_payload, signal) => {
        const path = await choosePlaylistImportFile()
        signal.throwIfAborted()
        return path
      },
      'ncm.officialLogin': (_payload, signal) => openNcmOfficialLogin(signal),
      'overlay.show': async ({ pluginId }) => showDynamicIsland(pluginId),
      'overlay.hide': async ({ pluginId }) => hideDynamicIsland(pluginId),
      'overlay.configure': async ({ pluginId, config }) => configureDynamicIsland(pluginId, config),
      'overlay.isOwner': async ({ pluginId }) => isDynamicIslandOwner(pluginId),
      'host.captureScreenshot': async () => {
        const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null
        if (!window) return null
        const image = await window.webContents.capturePage()
        if (image.isEmpty()) return null
        // Keep vision payloads small: downscale to at most 1280px wide, JPEG q80.
        const size = image.getSize()
        const resized =
          size.width > 1280
            ? image.resize({ width: 1280 })
            : size.height > 1600
              ? image.resize({ height: 1600 })
              : image
        return `data:image/jpeg;base64,${resized.toJPEG(80).toString('base64')}`
      },
      'paths.authorizeAudio': ({ source }) => resolveAuthorizedAudioSource(source),
      'paths.prepareAudio': async ({ source }) => {
        try {
          return await resolveAuthorizedAudioSource(source)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      },
      'paths.authorizeLibraryDirectory': ({ path }) => resolveAuthorizedLibraryDirectory(path),
      'artwork.normalizeCachedCover': ({ handle }) => normalizeCachedCoverHandle(handle),
      'artwork.remotePreview': ({ cover }, signal) => resolveRemoteArtwork(cover, signal),
      'artwork.resolveQueueCovers': createQueueCoverResolver({
        normalizeCachedCover: normalizeCachedCoverHandle,
        migrateBase64Cover,
        resolve: (handle) => remoteMediaGrants.resolve(handle, 'image')
      }),
      'artwork.present': createArtworkProjection({
        retainMetadata: (source, signal) => metadataArtworkCache.retain(source, signal),
        normalizeCachedCover: normalizeCachedCoverHandle,
        migrateBase64Cover,
        grant: (source, expiresAt) => remoteMediaGrants.grant(source, 'image', expiresAt),
        resolve: (handle) => remoteMediaGrants.resolve(handle, 'image')
      }),
      'media.resolveAudio': async ({ handle }) => remoteMediaGrants.resolve(handle, 'audio'),
      'media.protectProviderResult': async ({ value, method }) =>
        plugins.protectProviderResult(value, method),
      'credentials.protect': async ({ scope, value }) => {
        validateScope(scope)
        return protectJsonValue(value, scope)
      },
      'credentials.unprotect': async ({ scope, value }) => {
        validateScope(scope)
        return unprotectJsonValue(value, scope)
      },
      'plugins.prepareDisable': async ({ id }) => {
        if (id === THEME_WORKSHOP_ID) await prepareThemeWorkshopDisable()
      },
      'plugins.exportExperience': async ({ name, content }) => {
        const owner = BrowserWindow.getFocusedWindow()
        const options = { title: '导出莱茵音乐资料', defaultPath: name }
        const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
        if (result.canceled || !result.filePath) return { saved: false }
        await writeFile(result.filePath, content, 'utf8')
        return { saved: true }
      },
      'plugins.chooseInstallSource': ({ kind }) => {
        assertLocalPluginInstallSourceAllowed(kind, developerMode)
        return plugins.chooseInstallSource(kind)
      },
      'plugins.confirmInstall': ({ manifest, evidence }) =>
        plugins.confirmInstall(manifest, evidence),
      'plugins.showLog': async ({ path }) => {
        await plugins.showLog(path)
      },
      'plugins.notifyStateIssue': ({ type, detail }) => plugins.notifyStateIssue(type, detail),
      'files.trashAudio': async ({ path }) => {
        await trashLocalFileWithRetry(await resolveAuthorizedAudioFile(path))
      }
    },
    entries: {
      core: join(__dirname, 'musicCore.js'),
      audio: join(__dirname, 'audioEngineService.js'),
      'audio-test': join(__dirname, 'audioEngineService.js'),
      database: join(__dirname, 'libraryDatabaseService.js'),
      scan: join(__dirname, 'libraryScanService.js'),
      analysis: join(__dirname, 'audioAnalysisService.js'),
      plugin: join(__dirname, 'pluginHost.js')
    },
    fork: (entry, args, serviceName) => {
      const child = utilityProcess.fork(entry, args, {
        serviceName,
        stdio: 'pipe',
        ...(['twilight-audio', 'twilight-audio-test'].includes(serviceName)
          ? { env: audioServiceEnv() }
          : {}),
        ...(serviceName === 'twilight-plugin' && configuration.plugins?.proxy
          ? { env: { ...process.env, ...buildPluginProxyEnv(configuration.plugins.proxy) } }
          : {})
      })
      observeUtilityProcess(child, serviceName)
      return child as unknown as SupervisedProcess
    },
    channel: () =>
      new MessageChannelMain() as unknown as {
        port1: ServiceMessagePort
        port2: ServiceMessagePort
      }
  })
  supervisor.on('settings', (state: CoreSettingsState) => {
    if (!projectedLaunchSettings) {
      musicCacheRoot = configuration.musicCachePath || state.settings.musicCachePath
      projectedLaunchSettings = true
    }
    developerMode = state.settings.developerMode
    projectCoreSettings(state)
  })
  supervisor.on('themes', (snapshot: ThemeLibrarySnapshot) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send('themes:changed', snapshot)
  })
  return supervisor
}
