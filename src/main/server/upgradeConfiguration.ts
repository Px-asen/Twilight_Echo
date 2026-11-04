import { readFile, readdir, writeFile, access } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CoreSettingsRepository } from '../../core/persistence/settingsRepository.ts'
import { MAX_SETTINGS_FILE_BYTES } from '../../core/persistence/settingsFile.ts'
import { tryParseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { isRecord } from '../../shared/personalBackup.ts'

function rebase(value: unknown, source: string, destination: string): unknown {
  if (typeof value !== 'string' || !isAbsolute(value)) return value
  const suffix = relative(source, value)
  return suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
    ? value
    : resolve(destination, suffix)
}

/** Only owned cache and DSP-store paths move. Music, download destinations,
 * external plugins/IRs and user-authored text retain their original meaning. */
export async function rebaseUpgradedSettings(source: string, destination: string) {
  const directories = ['']
  for (const kind of ['zones', 'groups']) {
    try {
      for (const entry of await readdir(join(destination, kind), { withFileTypes: true }))
        if (entry.isDirectory()) directories.push(join(kind, entry.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const subdirectory of directories) {
    const directory = join(destination, subdirectory),
      settingsFile = join(directory, 'settings.json')
    const settings = new CoreSettingsRepository({
      filePath: settingsFile,
      environment: {
        platform: process.platform,
        defaultCachePath: join(destination, 'music-cache'),
        resolvePath: resolve
      },
      changed: () => undefined
    })
    if (settings.issue?.kind === 'corrupt') throw new Error('配置及其备份损坏，未以默认设置升级')
    for (const suffix of ['', '.bak']) {
      const file = settingsFile + suffix
      try {
        await access(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const parsed = tryParseJsonWithNestingLimit(await readFile(file, 'utf8'))
      // Preserve an already unusable backup as evidence; it cannot become the active config.
      if (!parsed.ok || !isRecord(parsed.value)) continue
      const value = parsed.value
      for (const key of ['cachePath', 'musicCachePath'])
        if (key in value) value[key] = rebase(value[key], source, destination)
      const oldAssets = join(source, subdirectory, 'dsp-assets'),
        newAssets = join(directory, 'dsp-assets')
      if (isRecord(value.audioProcessing) && value.audioProcessing.convolverIrPath)
        value.audioProcessing.convolverIrPath = rebase(
          value.audioProcessing.convolverIrPath,
          oldAssets,
          newAssets
        )
      if (Array.isArray(value.dspScenes))
        for (const scene of value.dspScenes) {
          if (!isRecord(scene) || !isRecord(scene.graph) || !Array.isArray(scene.graph.nodes))
            continue
          for (const node of scene.graph.nodes)
            if (isRecord(node) && isRecord(node.params) && node.params.impulseResponsePath)
              node.params.impulseResponsePath = rebase(
                node.params.impulseResponsePath,
                oldAssets,
                newAssets
              )
        }
      const json = JSON.stringify(value)
      if (Buffer.byteLength(json) > MAX_SETTINGS_FILE_BYTES)
        throw new Error('重绑托管路径后设置超过原文件容量，未截断升级')
      await writeFile(file, json)
    }
  }
}
