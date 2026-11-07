import '../../adapters-node/index.ts'
import { mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import type { CoreSupervisorOptions } from '../coreProcess/supervisor.ts'
import { CanonicalPathGrantSet, resolveCanonicalExistingPath } from '../security/pathGrants.ts'
import { classifyAudioSource } from '../security/audioSourcePolicy.ts'
import { SUPPORTED_EXTENSIONS } from '../../shared/audioFormats.ts'
import { resolveVst3HelpersAvailability } from '../dsp/vst3Catalog.ts'
import { createServerArtwork } from './artwork.ts'
import { createServerCredentials } from './credentials.ts'

/** Host-owned configuration is the grant source; Core settings cannot widen it. */
export async function createServerPlatform(options: {
  root: string
  libraryRoots: string[]
  vst3Roots?: string[]
  applicationRoot?: string
  confirmDevice?: NonNullable<CoreSupervisorOptions['platform']>['remote.confirmDevice']
}): Promise<NonNullable<CoreSupervisorOptions['platform']>> {
  const library = new CanonicalPathGrantSet()
  for (const root of options.libraryRoots) await library.grantRoot(root)
  const vst3 = new CanonicalPathGrantSet()
  for (const root of options.vst3Roots ?? []) await vst3.grantRoot(root)
  const cacheRoot = join(options.root, 'music-cache')
  const temporaryDirectory = join(options.root, 'temporary')
  await mkdir(cacheRoot, { recursive: true })
  await mkdir(temporaryDirectory, { recursive: true })
  const cache = new CanonicalPathGrantSet()
  await cache.grantRoot(cacheRoot)
  const requireWithin = async (
    grants: CanonicalPathGrantSet,
    path: string,
    kind: 'file' | 'directory'
  ) => {
    const allowed = await grants.resolveWithinRoots(path, kind)
    if (!allowed) throw new Error('路径不在 Server 配置授权的目录中')
    return allowed
  }
  const audioFile = async (path: string) => {
    const canonical = await resolveCanonicalExistingPath(path, 'file')
    if (!library.isCanonicalWithinRoots(canonical) && !cache.isCanonicalWithinRoots(canonical))
      throw new Error('音频文件不在 Server 授权目录中')
    if (!SUPPORTED_EXTENSIONS.includes(extname(canonical).toLowerCase()))
      throw new Error('不支持的音频文件格式')
    return canonical
  }
  const audioSource = async (source: string) => {
    const candidate = classifyAudioSource(source)
    return candidate.kind === 'remote' ? candidate.source : audioFile(candidate.source)
  }
  return {
    ...createServerArtwork(join(cacheRoot, 'cover-cache')),
    ...createServerCredentials(options.root, options.applicationRoot ? join(options.applicationRoot, 'out/server-service/twilight_server_credentials.node') : undefined),
    'plugins.prepareDisable': async () => undefined,
    'plugins.notifyStateIssue': async ({ type, detail }) => { console.error('[server.plugins]', type, detail) },
    ...(options.confirmDevice ? { 'remote.confirmDevice': options.confirmDevice } : {}),
    'dsp.environment': async () => ({
      platform: process.platform,
      temporaryDirectory,
      searchPaths: options.vst3Roots ?? [],
      fixedSearchPaths: true,
      helpers: resolveVst3HelpersAvailability()
    }),
    'dsp.registerVst3Paths': async ({ paths }) =>
      Promise.all(paths.map((path) => requireWithin(vst3, path, 'directory'))),
    'dsp.authorizeVst3Paths': async ({ paths }) =>
      Promise.all(paths.map((path) => requireWithin(vst3, path, 'directory'))),
    'dsp.authorizeImpulse': async ({ path }) => {
      const canonical = await requireWithin(library, path, 'file')
      if (!['.wav', '.flac', '.aiff', '.aif'].includes(extname(canonical).toLowerCase()))
        throw new Error('不支持的脉冲响应格式')
      return canonical
    },
    'paths.authorizeAudioFile': ({ path }) => audioFile(path),
    'paths.authorizeAudio': ({ source }) => audioSource(source),
    'paths.prepareAudio': async ({ source }) => {
      try {
        return await audioSource(source)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    'paths.areAudioFilesAuthorized': async ({ paths }) =>
      Promise.all(
        paths.map(async (path) => {
          try {
            await audioFile(path)
            return true
          } catch {
            return false
          }
        })
      ),
    'paths.authorizeLibraryDirectory': ({ path }) => requireWithin(library, path, 'directory'),
    'settings.authorizePaths': async (paths) => {
      const result = { ...paths }
      if (paths.libraryFolders)
        result.libraryFolders = await Promise.all(
          paths.libraryFolders.map((path) => requireWithin(library, path, 'directory'))
        )
      if (paths.musicCachePath !== undefined)
        result.musicCachePath = await requireWithin(cache, paths.musicCachePath, 'directory')
      if (paths.downloadFolder)
        result.downloadFolder = await requireWithin(library, paths.downloadFolder, 'directory')
      return result
    },
    'downloads.authorizedRoots': async ({ libraryFolders, downloadFolder }) => ({
      libraryRoots: await Promise.all(
        libraryFolders.map((path) => requireWithin(library, path, 'directory'))
      ),
      downloadRoot: downloadFolder
        ? await requireWithin(library, downloadFolder, 'directory')
        : null
    }),
    'downloads.grantResult': ({ path }) => audioFile(path),
    'cache.authorizeRoot': async () => cacheRoot,
    'network.environment': async () => ({
      platform: process.platform,
      tempRoot: temporaryDirectory,
      gvfsRoot: null
    })
  }
}
