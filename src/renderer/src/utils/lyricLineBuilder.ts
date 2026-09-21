import { isAmlTtml, parseAmlTtml } from '@renderer/utils/amllTtml.ts'
import { parseTimedLrc, parsePlainLyrics, parsePlainLyricLines } from '@renderer/utils/lyrics.ts'
import type {
  ParsedTimedLyricLine,
  LyricLine,
  LyricWord,
  LyricVoiceMetadata,
  LyricVoiceLayer,
  BuildLyricLinesOptions
} from '@renderer/utils/lyrics.ts'
import { splitEmbeddedLyricLayers } from '@renderer/utils/embeddedLyricLayers.ts'
const LAYER_MATCH_TOLERANCE_MS = 1500

/**
 * Pair translation / romanization lines to the original timed lines.
 *
 * NetEase YRC word lyrics carry line timestamps that can drift from the
 * companion tlyric by up to ~1s (same song, same line order). A plain
 * exact-millisecond join therefore hides every translation for word-level
 * lyrics. Exact matches are tried first; remaining lines fall back to an
 * order-preserving nearest match within a bounded tolerance.
 */
function matchTimedLayer(
  originalLines: readonly ParsedTimedLyricLine[],
  layerLines: readonly ParsedTimedLyricLine[],
  toleranceMs: number = LAYER_MATCH_TOLERANCE_MS
): Map<number, string> {
  const result = new Map<number, string>()
  if (originalLines.length === 0 || layerLines.length === 0) return result

  // Exact millisecond pairing (the standard LRC alignment).
  const exactByTime = new Map<number, string>()
  for (const line of layerLines) {
    const key = Math.round(line.time * 1000)
    if (!exactByTime.has(key)) exactByTime.set(key, line.text)
  }
  const usedLayerKeys = new Set<number>()
  for (const line of originalLines) {
    const key = Math.round(line.time * 1000)
    const text = exactByTime.get(key)
    if (text != null && !usedLayerKeys.has(key)) {
      result.set(key, text)
      usedLayerKeys.add(key)
    }
  }

  // Order-preserving nearest fallback for drifted word-level payloads.
  const toleranceSeconds = toleranceMs / 1000
  let layerIndex = 0
  for (const line of originalLines) {
    const key = Math.round(line.time * 1000)
    if (result.has(key)) continue
    while (
      layerIndex < layerLines.length &&
      usedLayerKeys.has(Math.round(layerLines[layerIndex].time * 1000))
    ) {
      layerIndex++
    }
    let bestIndex = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (let i = layerIndex; i < layerLines.length; i++) {
      const layerKey = Math.round(layerLines[i].time * 1000)
      if (usedLayerKeys.has(layerKey)) continue
      const delta = Math.abs(key - layerKey)
      if (delta > toleranceMs) {
        if (layerLines[i].time - line.time > toleranceSeconds) break
        continue
      }
      if (delta < bestDelta) {
        bestDelta = delta
        bestIndex = i
      }
    }
    if (bestIndex >= 0) {
      const matched = layerLines[bestIndex]
      result.set(key, matched.text)
      usedLayerKeys.add(Math.round(matched.time * 1000))
      if (bestIndex > layerIndex) layerIndex = bestIndex
    }
  }
  return result
}

function replaceTtmlAuxiliaryLayer(
  lines: readonly LyricLine[],
  layerLyrics: string | null | undefined,
  layer: 'translation' | 'romanization'
): LyricLine[] {
  const timedLayer = parseTimedLrc(layerLyrics)
  const timedOriginals = lines.flatMap((line) =>
    line.time == null ? [] : [{ time: line.time, text: line.text }]
  )
  const timedMatches = matchTimedLayer(timedOriginals, timedLayer)
  const plainLayer = timedLayer.length > 0 ? [] : parsePlainLyrics(layerLyrics)

  return lines.map((line, index) => {
    const replacement =
      line.time == null
        ? (plainLayer[index] ?? null)
        : (timedMatches.get(Math.round(line.time * 1000)) ?? null)
    return {
      ...line,
      [layer]: replacement,
      ...(line.voices
        ? {
            voices: line.voices.map((voice) => ({
              ...voice,
              [layer]: null
            }))
          }
        : {})
    }
  })
}

function voiceKey(metadata: LyricVoiceMetadata, sourceIndex: number, time: number | null): string {
  const identity = [
    metadata.role,
    metadata.lane,
    metadata.speaker ?? '',
    sourceIndex,
    time ?? 'plain'
  ]
  return identity.map((part) => encodeURIComponent(String(part))).join(':')
}

function compatibleVoiceText(voices: readonly LyricVoiceLayer[]): string {
  const leads = voices.filter((voice) => voice.role === 'lead')
  const visible = leads.length > 0 ? leads : voices
  return visible
    .map((voice) => voice.text)
    .filter(Boolean)
    .join(' · ')
}

function compatibleVoiceWords(voices: readonly LyricVoiceLayer[]): LyricWord[] | undefined {
  const leads = voices.filter((voice) => voice.role === 'lead')
  const visible = leads.length > 0 ? leads : voices
  return visible.length === 1 ? visible[0].words : undefined
}

function groupTimedLyricLines(lines: readonly ParsedTimedLyricLine[]): Array<{
  rowKey?: string
  time: number
  text: string
  words?: LyricWord[]
  voices?: LyricVoiceLayer[]
}> {
  const result: Array<{
    rowKey?: string
    time: number
    text: string
    words?: LyricWord[]
    voices?: LyricVoiceLayer[]
  }> = []
  const groups = new Map<string, (typeof result)[number]>()

  lines.forEach((line, sourceIndex) => {
    if (!line.voice) {
      result.push({ time: line.time, text: line.text, words: line.words })
      return
    }

    const voice: LyricVoiceLayer = {
      ...line.voice,
      voiceKey: voiceKey(line.voice, sourceIndex, line.time),
      time: line.time,
      text: line.text,
      words: line.words
    }
    const explicitGroup = line.voice.group
    if (!explicitGroup) {
      result.push({
        rowKey: `voice:${sourceIndex}:${Math.round(line.time * 1000)}`,
        time: line.time,
        text: line.text,
        words: line.words,
        voices: [voice]
      })
      return
    }

    let group = groups.get(explicitGroup)
    if (!group) {
      group = {
        rowKey: `group:${encodeURIComponent(explicitGroup)}`,
        time: line.time,
        text: line.text,
        words: line.words,
        voices: []
      }
      groups.set(explicitGroup, group)
      result.push(group)
    }
    group.time = Math.min(group.time, line.time)
    group.voices?.push(voice)
    group.text = compatibleVoiceText(group.voices ?? [])
    group.words = compatibleVoiceWords(group.voices ?? [])
  })

  result.sort((left, right) => left.time - right.time)
  return result
}

export function buildLyricLines(
  lyrics: string | null | undefined,
  translatedLyrics: string | null | undefined,
  romanizedLyrics?: string | null | undefined,
  options: BuildLyricLinesOptions = {}
): LyricLine[] {
  if (isAmlTtml(lyrics)) {
    let parsed = parseAmlTtml(lyrics!)
    if (parsed.length > 0) {
      if (options.replaceTtmlTranslation || translatedLyrics != null) {
        parsed = replaceTtmlAuxiliaryLayer(parsed, translatedLyrics, 'translation')
      }
      if (options.replaceTtmlRomanization || romanizedLyrics != null) {
        parsed = replaceTtmlAuxiliaryLayer(parsed, romanizedLyrics, 'romanization')
      }
      return parsed
    }
  }
  const embedded = splitEmbeddedLyricLayers(parseTimedLrc(lyrics))
  const originalLines = groupTimedLyricLines(embedded.original)
  const translatedLines =
    translatedLyrics == null ? embedded.translation : parseTimedLrc(translatedLyrics)
  const romanizedLines =
    romanizedLyrics == null ? embedded.romanization : parseTimedLrc(romanizedLyrics)

  if (originalLines.length > 0) {
    const translatedMap = matchTimedLayer(originalLines, translatedLines)
    const romanizedMap = matchTimedLayer(originalLines, romanizedLines)

    return originalLines.map((line) => ({
      time: line.time,
      text: line.text,
      translation: translatedMap.get(Math.round(line.time * 1000)) ?? null,
      romanization: romanizedMap.get(Math.round(line.time * 1000)) ?? null,
      timed: true,
      words: line.words,
      ...(line.rowKey ? { rowKey: line.rowKey } : {}),
      ...(line.voices ? { voices: line.voices } : {})
    }))
  }

  if (translatedLines.length > 0) {
    return translatedLines.map((line) => ({
      time: line.time,
      text: line.text,
      translation: null,
      romanization: null,
      timed: true,
      words: line.words
    }))
  }

  const parsedPlainLines = parsePlainLyricLines(lyrics)
  const plainLines = parsedPlainLines.map((line) => line.text)
  const plainTranslatedLines = parsePlainLyrics(translatedLyrics)
  const plainRomanizedLines = parsePlainLyrics(romanizedLyrics)
  const sourceLines = plainLines.length > 0 ? plainLines : plainTranslatedLines

  return sourceLines.map((line, index) => {
    const voiceMetadata = plainLines.length > 0 ? parsedPlainLines[index]?.voice : undefined
    const voice = voiceMetadata
      ? {
          ...voiceMetadata,
          voiceKey: voiceKey(voiceMetadata, index, null),
          time: null,
          text: line
        }
      : null
    return {
      time: null,
      text: line,
      translation: plainLines.length > 0 ? (plainTranslatedLines[index] ?? null) : null,
      romanization: plainRomanizedLines[index] ?? null,
      timed: false,
      ...(voice
        ? { rowKey: `voice:${index}:plain`, voices: [voice satisfies LyricVoiceLayer] }
        : {})
    }
  })
}
