import '../../adapters-node/index.ts'
import { readFile } from 'node:fs/promises'
import {
  extractEmbeddedLyrics,
  loadLocalCompanionLyrics as loadCoreLocalCompanionLyrics,
  loadLocalLyrics as loadCoreLocalLyrics,
  type EmbeddedLyricsMetadata,
  type LocalLyricsFilePort
} from '../../core/lyrics/loadLyrics.ts'

export { extractEmbeddedLyrics, type EmbeddedLyricsMetadata, type LocalLyricsFilePort }

export const nodeLocalLyricsFilePort: LocalLyricsFilePort = {
  readFile: (path) => readFile(path),
  parseAudioFileMetadata: async (filePath, options) => {
    const { parseFile } = await import('music-metadata')
    return parseFile(filePath, options) as Promise<EmbeddedLyricsMetadata>
  }
}

export function loadLocalLyrics(
  directory: string,
  fileName: string,
  filePath: string | null,
  io: LocalLyricsFilePort = nodeLocalLyricsFilePort
): Promise<string | null> {
  return loadCoreLocalLyrics(directory, fileName, filePath, io)
}

export function loadLocalCompanionLyrics(
  directory: string,
  fileName: string,
  kind: 'translated' | 'romanized',
  io: Pick<LocalLyricsFilePort, 'readFile'> = nodeLocalLyricsFilePort
): Promise<string | null> {
  return loadCoreLocalCompanionLyrics(directory, fileName, kind, io)
}
