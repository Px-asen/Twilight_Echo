import '../../adapters-node/index.ts'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import type { AppSettings, PlaybackResumeMode } from '../../shared/appSettings.ts'
import { MAX_SETTINGS_BACKUP_BYTES } from '../../shared/coreSettingsBackup.ts'
import { remapPersonalPaths, type PathMapping } from '../../shared/personalBackup.ts'
import { normalizeAppSettings, createDefaultSettings } from '../../core/settings/normalization.ts'
import {
  importAppSettingsBackup,
  SETTINGS_BACKUP_SCHEMA_VERSION
} from '../../core/settings/backupFormat.ts'
import { importDspProfileArchive } from '../../core/audio/dspProfileArchive.ts'
import { DspAssetLibrary } from '../../core/audio/dspAssetLibrary.ts'
import { authorizeDspSettings } from '../../core/audio/dspSettingsAuthorization.ts'
import { CanonicalPathGrantSet } from '../security/pathGrants.ts'

// Business preferences transfer; a Server never adopts desktop device, path or trust settings.
export const SERVER_SETTINGS_FIELDS = [
  'language',
  'genreSeparators',
  'watchLibrary',
  'musicIdentification',
  'onlineLyricsFallback',
  'playbackResumeMode',
  'previousButtonAction',
  'autoMixMode',
  'autoMixStemMode',
  'autoMixStemDevice',
  'autoMixStemCacheMiB',
  'playMode',
  'softwareVolume',
  'sleepTimer',
  'ncmPlaybackQuality',
  'audioProcessing',
  'audioEqAutoPreamp',
  'audioEqBuiltInPresets',
  'audioEqPresets',
  'headphoneCompensation',
  'dspScenes',
  'dspPinnedSceneId'
] as const satisfies readonly (keyof AppSettings)[]

/** Runs only in the newly owned migration profile (the preview profile is temporary). */
export async function prepareMigratedConfiguration(
  root: string,
  options: {
    settingsFile?: string
    dspProfile?: string
    impulseFile?: string
    resumeMode: PlaybackResumeMode
    libraryRoots: string[]
    mappings: PathMapping[]
  }
) {
  const environment = {
    platform: process.platform,
    defaultCachePath: join(root, 'music-cache'),
    resolvePath: resolve
  }
  const normalize = (settings: Partial<AppSettings>) => normalizeAppSettings(settings, environment)
  let settings = normalize({
    ...createDefaultSettings(process.platform),
    playbackResumeMode: options.resumeMode
  })
  let importedFields: Array<(typeof SERVER_SETTINGS_FIELDS)[number]> = []
  if (options.settingsFile) {
    if (!isAbsolute(options.settingsFile)) throw new Error('--settings 必须是绝对路径')
    if ((await stat(options.settingsFile)).size > MAX_SETTINGS_BACKUP_BYTES)
      throw new Error('Settings backup is too large')
    const json = await readFile(options.settingsFile, 'utf8')
    const imported = importAppSettingsBackup(json, settings, normalize)
    const parsed = JSON.parse(json)
    const supplied =
      parsed.schemaVersion === SETTINGS_BACKUP_SCHEMA_VERSION && 'settings' in parsed
        ? parsed.settings
        : parsed
    importedFields = SERVER_SETTINGS_FIELDS.filter((field) => Object.hasOwn(supplied, field))
    settings = normalize({
      ...settings,
      ...Object.fromEntries(importedFields.map((field) => [field, imported.settings[field]]))
    })
  }
  const assets = new DspAssetLibrary(join(root, 'dsp-assets'), { now: Date.now, newId: randomUUID })
  const importedAssets: Array<{ id: string; kind: string; name: string }> = []
  if (options.dspProfile) {
    if (!isAbsolute(options.dspProfile)) throw new Error('--dsp 必须是绝对路径')
    const imported = await importDspProfileArchive(options.dspProfile, assets, root)
    importedAssets.push(
      ...imported.importedAssets.map(({ id, kind, name }) => ({ id, kind, name }))
    )
    settings = normalize({
      ...settings,
      dspScenes: imported.profile.scenes,
      dspPinnedSceneId: imported.profile.pinnedSceneId
    })
  }
  const ownedImpulses = new Set<string>()
  if (options.impulseFile) {
    if (!isAbsolute(options.impulseFile)) throw new Error('--impulse 必须是绝对路径')
    const asset = await assets.importFile({
      kind: 'impulseResponse',
      sourcePath: options.impulseFile
    })
    const path = await assets.getPath(asset.id)
    const previousPath = settings.audioProcessing.convolverIrPath
    ownedImpulses.add(path)
    importedAssets.push({ id: asset.id, kind: asset.kind, name: asset.name })
    settings = normalize({
      ...settings,
      audioProcessing: { ...settings.audioProcessing, convolverIrPath: path }
    })
    for (const scene of settings.dspScenes)
      for (const node of scene.graph.nodes)
        if (
          node.type === 'convolver' &&
          !node.params.impulseResponseAssetId &&
          previousPath &&
          node.params.impulseResponsePath === previousPath
        )
          node.params.impulseResponsePath = path
  }
  const grants = new CanonicalPathGrantSet()
  for (const root of options.libraryRoots) await grants.grantRoot(root)
  settings = await authorizeDspSettings(settings, assets, async (path) => {
    if (ownedImpulses.has(path)) return path
    const mapped = remapPersonalPaths({ filePath: path }, options.mappings) as { filePath: string }
    const canonical = await grants.resolveWithinRoots(mapped.filePath, 'file')
    if (
      !canonical ||
      !['.wav', '.flac', '.aif', '.aiff'].includes(extname(canonical).toLowerCase())
    )
      throw new Error('脉冲响应不在明确授权的目录中；请映射原路径，或用 --impulse 显式迁入文件')
    return canonical
  })
  return {
    settings,
    report: {
      settingsImported: !!options.settingsFile,
      importedFields,
      profileImported: !!options.dspProfile,
      sceneIds: settings.dspScenes.map((scene) => scene.id),
      pinnedSceneId: settings.dspPinnedSceneId,
      assets: importedAssets,
      vst3References: [
        ...new Set(
          settings.dspScenes.flatMap((scene) =>
            scene.graph.nodes.flatMap((node) => (node.vst3 ? [node.vst3.catalogId] : []))
          )
        )
      ]
    }
  }
}
