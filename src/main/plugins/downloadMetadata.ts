import { copyFile, rename, rm, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { loadTaglib, type Taglib } from '../library/taglib.ts'
import { createRemoteMediaRequestHandler } from '../security/remoteMediaGrants.ts'
import type {
  ProviderDownloadQuality,
  ProviderDownloadTrackInput
} from '../../shared/providerDownloads.ts'
import type { DownloadPreferences } from '../../shared/downloadPreferences.ts'

export function detectedDownloadQuality(format: {
  lossless?: boolean
  sampleRate?: number
  bitsPerSample?: number
  codec?: string
}): ProviderDownloadQuality | null {
  if (format.lossless === true) return (format.sampleRate ?? 0) > 48000 ? 'hi-res' : 'lossless'
  if (/aac/i.test(format.codec ?? '')) return 'aac'
  return null
}

export function downloadLyricFiles(raw: unknown): Array<{ suffix: string; text: string }> {
  if (!raw || typeof raw !== 'object') return []
  const value = raw as Record<string, unknown>
  const files: Array<{ suffix: string; text: string }> = []
  for (const [key, suffix] of [
    ['lyrics', '.lrc'],
    ['translatedLyrics', '.translated.lrc'],
    ['wordLyrics', '.word.lrc']
  ]) {
    const text = value[key]
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1024 * 1024) continue
    const wordSuffix = /<tt[\s>]/i.test(text)
      ? '.ttml'
      : /^\[\d+,\d+\]/m.test(text)
        ? '.yrc'
        : suffix
    files.push({ suffix: key === 'wordLyrics' ? wordSuffix : suffix, text })
  }
  return files
}

export async function prepareDownloadedMetadata(options: {
  partPath: string
  targetPath: string
  track: ProviderDownloadTrackInput
  preferences: DownloadPreferences
  getLyrics: () => Promise<unknown>
  signal: AbortSignal
}): Promise<{
  actualQuality: ProviderDownloadQuality | null
  warning: string | null
  lyrics: Array<{ suffix: string; text: string }>
}> {
  const { partPath, targetPath, track, preferences, signal } = options
  const warnings: string[] = []
  let actualQuality: ProviderDownloadQuality | null = null
  try {
    const { parseFile } = await import('music-metadata')
    const metadata = await parseFile(partPath, { skipCovers: true, duration: false })
    actualQuality = detectedDownloadQuality(metadata.format)
  } catch {
    warnings.push('无法核验文件音质，显示音源报告值')
  }
  let lyrics: Array<{ suffix: string; text: string }> = []
  if (preferences.saveLyrics || preferences.embedMetadata) {
    try {
      lyrics = downloadLyricFiles(await options.getLyrics())
      if (!lyrics.length && preferences.saveLyrics) warnings.push('音源未提供可保存的歌词')
    } catch {
      warnings.push('歌词获取失败，音频已保留')
    }
  }
  signal.throwIfAborted()
  if (preferences.embedMetadata) {
    const taggedPath = `${partPath}.tags${extname(targetPath)}`
    const { ByteVector, File, Picture, PictureType } = loadTaglib()
    let media: Taglib.File | undefined
    try {
      await copyFile(partPath, taggedPath)
      let cover: Uint8Array | undefined
      let coverType = ''
      if (track.cover?.startsWith('twilight-media://image/')) {
        const response = await createRemoteMediaRequestHandler({ fetch: globalThis.fetch })(
          new Request(track.cover, { signal })
        )
        coverType = response.headers.get('content-type')?.split(';')[0] ?? ''
        if (response.ok && ['image/jpeg', 'image/png'].includes(coverType)) {
          const bytes = new Uint8Array(await response.arrayBuffer())
          if (bytes.length <= 8 * 1024 * 1024) cover = bytes
        }
      }
      signal.throwIfAborted()
      media = File.createFromPath(taggedPath)
      media.tag.title = track.title
      media.tag.performers = [track.artist]
      if (track.album) media.tag.album = track.album
      const embedded =
        lyrics.find((entry) => entry.suffix === '.word.lrc') ??
        lyrics.find((entry) => entry.suffix === '.lrc')
      if (embedded) media.tag.lyrics = embedded.text
      if (media.tag.pictures.length === 0 && cover) {
        media.tag.pictures = [
          Picture.fromFullData(
            ByteVector.fromByteArray(cover),
            PictureType.FrontCover,
            coverType,
            ''
          )
        ]
      }
      if (media.tag.pictures.length === 0) warnings.push('没有可内嵌的封面')
      media.save()
      media.dispose()
      media = undefined
      await rename(taggedPath, partPath)
    } catch {
      signal.throwIfAborted()
      warnings.push('此文件未能补写标签，已保留原始音频')
    } finally {
      media?.dispose()
      await rm(taggedPath, { force: true })
    }
  }
  return {
    actualQuality,
    warning: warnings.length ? warnings.join('；') : null,
    lyrics: preferences.saveLyrics ? lyrics : []
  }
}

export async function saveDownloadedLyrics(
  targetPath: string,
  lyrics: Array<{ suffix: string; text: string }>
): Promise<string | null> {
  const stem = targetPath.slice(0, -extname(targetPath).length)
  try {
    for (const lyric of lyrics)
      await writeFile(`${stem}${lyric.suffix}`, lyric.text, { encoding: 'utf8', flag: 'wx' })
    return null
  } catch {
    return '部分歌词未保存（同名文件已存在或目录不可写），已有文件已保留'
  }
}
