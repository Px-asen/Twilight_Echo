import '../../adapters-node/index.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDefaultSettings } from '../../core/settings/normalization.ts'
import { exportAppSettingsForBackup } from '../../core/settings/backupFormat.ts'
import { createDefaultThemeLibraryDocument } from '../../shared/theme.ts'
import { DspAssetLibrary } from '../../core/audio/dspAssetLibrary.ts'
import { createDspProfile, exportDspProfileArchive } from '../../core/audio/dspProfileArchive.ts'
import type { DspScene } from '../../shared/dspGraph.ts'

export async function configurationFixture(directory: string) {
  await mkdir(directory, { recursive: true })
  const impulseFile = join(directory, 'half.wav'),
    impulse = Buffer.alloc(46)
  impulse.write('RIFF')
  impulse.writeUInt32LE(38, 4)
  impulse.write('WAVEfmt ', 8)
  impulse.writeUInt32LE(16, 16)
  impulse.writeUInt16LE(1, 20)
  impulse.writeUInt16LE(1, 22)
  impulse.writeUInt32LE(48000, 24)
  impulse.writeUInt32LE(96000, 28)
  impulse.writeUInt16LE(2, 32)
  impulse.writeUInt16LE(16, 34)
  impulse.write('data', 36)
  impulse.writeUInt32LE(2, 40)
  impulse.writeInt16LE(16384, 44)
  await writeFile(impulseFile, impulse)
  const assets = new DspAssetLibrary(join(directory, 'source-assets'), {
    now: Date.now,
    newId: randomUUID
  })
  const asset = await assets.importFile({
    kind: 'impulseResponse',
    sourcePath: impulseFile,
    name: 'Half amplitude IR'
  })
  const scene: DspScene = {
    id: 'room',
    name: 'Room',
    enabled: true,
    priority: 20,
    rules: { sourceKinds: ['pcm'] },
    graph: {
      version: 2,
      nodes: [
        {
          id: 'room-convolver',
          type: 'convolver',
          enabled: true,
          params: { impulseResponseAssetId: asset.id, wet: 1, dry: 0 }
        }
      ],
      outputStage: {
        targetSampleRate: 48000,
        resamplerQuality: 'high',
        dither: 'off',
        safetyClamp: true,
        headroomEnabled: true,
        headroomGainDb: -6
      }
    }
  }
  const settings = createDefaultSettings(process.platform)
  Object.assign(settings, {
    softwareVolume: 0.42,
    playbackResumeMode: 'trackAndPosition',
    remoteControlEnabled: true,
    audioDevice: 'old-desktop-DAC',
    cachePath: 'Z:/old-desktop-cache',
    libraryFolders: ['Z:/old-music'],
    dspScenes: [scene],
    dspPinnedSceneId: 'room',
    audioEqAutoPreamp: { enabled: false, manualDb: null }
  })
  Object.assign(settings.audioProcessing, {
    dspEnabled: true,
    directMode: false,
    eqEnabled: false,
    eqPreamp: 0,
    convolverEnabled: true,
    convolverIrPath: '',
    crossfeedEnabled: false,
    volumeNormalization: 'off'
  })
  const settingsFile = join(directory, 'settings.json'),
    dspProfile = join(directory, 'room.tedsp')
  await writeFile(
    settingsFile,
    exportAppSettingsForBackup(settings, createDefaultThemeLibraryDocument())
  )
  await exportDspProfileArchive(
    {
      outputPath: dspProfile,
      profile: createDspProfile({
        name: 'Room',
        scenes: [scene],
        pinnedSceneId: 'room',
        assetIds: [asset.id]
      })
    },
    assets
  )
  return { settingsFile, dspProfile, impulseFile, impulse, asset, scene, settings }
}
