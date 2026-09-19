import { readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { parseFile, TimestampFormat, type IAudioMetadata } from 'music-metadata'
import { decodeLyrics } from '../../shared/lyricsEncoding.ts'

const TIMED_LRC = /\[\d{1,3}:\d{2}(?:[.:]\d{2,3})?\]/
const LYRIC_TAG_IDS = new Set(['LYRICS', 'UNSYNCEDLYRICS', 'USLT', 'SYLT', '©LYR', 'WM/LYRICS'])

function lyricText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null
  if (value && typeof value === 'object' && 'text' in value) return lyricText(value.text)
  return null
}

function lrcTimestamp(milliseconds: number): string {
  const time = Math.round(milliseconds)
  const minutes = String(Math.floor(time / 60_000)).padStart(2, '0')
  const seconds = String(Math.floor(time / 1_000) % 60).padStart(2, '0')
  const fraction = String(time % 1_000).padStart(3, '0')
  return `[${minutes}:${seconds}.${fraction}]`
}

export function extractEmbeddedLyrics(metadata: {
  common: Pick<IAudioMetadata['common'], 'lyrics'>
  native: IAudioMetadata['native']
}): string | null {
  for (const tags of Object.values(metadata.native)) {
    for (const tag of tags) {
      if (!LYRIC_TAG_IDS.has(tag.id.toUpperCase())) continue
      const text = lyricText(tag.value)
      if (text && TIMED_LRC.test(text)) return text
    }
  }

  const lyrics = metadata.common.lyrics ?? []
  for (const lyric of lyrics) {
    const text = lyricText(lyric)
    if (text && TIMED_LRC.test(text)) return text
  }
  for (const lyric of lyrics) {
    if (lyric.timeStampFormat !== TimestampFormat.milliseconds) continue
    const lines: string[] = []
    for (const entry of lyric.syncText ?? []) {
      if (
        typeof entry.timestamp !== 'number' ||
        !Number.isFinite(entry.timestamp) ||
        entry.timestamp < 0
      ) {
        continue
      }
      const timestamp = lrcTimestamp(entry.timestamp)
      for (const text of entry.text.split(/\r\n|\r|\n/)) lines.push(`${timestamp}${text}`)
    }
    if (lines.length > 0) return lines.join('\n')
  }
  for (const lyric of lyrics) {
    const text = lyricText(lyric)
    if (text) return text
  }
  return null
}

export async function loadLocalLyrics(
  directory: string,
  fileName: string,
  filePath: string | null
): Promise<string | null> {
  const lrcPath = join(directory, `${basename(fileName, extname(fileName))}.lrc`)
  const lyrics = await readFile(lrcPath)
    .then((bytes) => decodeLyrics(bytes).text)
    .catch(() => null)
  if (lyrics) return lyrics
  if (!filePath) return null
  return await parseFile(filePath, { skipCovers: true, duration: false })
    .then(extractEmbeddedLyrics)
    .catch(() => null)
}
