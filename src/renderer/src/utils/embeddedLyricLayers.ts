import type { ParsedTimedLyricLine } from '@renderer/utils/lyrics.ts'

type Layer = 'translation' | 'romanization'
const LABEL =
  /^(?:\[(translation|译文|翻译|romanization|romaji|注音|罗马音)\]|(译文|翻译|注音|罗马音)[:：])\s*/i

function script(text: string): string {
  if (/[\u3040-\u30ff]/u.test(text)) return 'japanese'
  if (/[\uac00-\ud7af]/u.test(text)) return 'korean'
  if (/\p{Script=Han}/u.test(text)) return 'han'
  if (/\p{Script=Latin}/u.test(text)) return 'latin'
  return 'other'
}

export function splitEmbeddedLyricLayers(lines: readonly ParsedTimedLyricLine[]): {
  original: ParsedTimedLyricLine[]
  translation: ParsedTimedLyricLine[]
  romanization: ParsedTimedLyricLine[]
} {
  const result = {
    original: [] as ParsedTimedLyricLine[],
    translation: [] as ParsedTimedLyricLine[],
    romanization: [] as ParsedTimedLyricLine[]
  }
  const groups = new Map<number, ParsedTimedLyricLine[]>()
  for (const line of lines) {
    const label = line.voice ? null : LABEL.exec(line.text)
    if (label) {
      const layer: Layer = /romanization|romaji|注音|罗马音/i.test(label[1] ?? label[2])
        ? 'romanization'
        : 'translation'
      result[layer].push({ ...line, text: line.text.slice(label[0].length) })
      continue
    }
    const key = Math.round(line.time * 1000)
    const group = groups.get(key)
    if (group) group.push(line)
    else groups.set(key, [line])
  }

  function layers(group: ParsedTimedLyricLine[]): Layer[] | null {
    if (group.length < 2 || group.length > 3 || group.some((line) => line.voice)) return null
    const primary = script(group[0].text)
    const secondary = script(group[1].text)
    if (primary === secondary || primary === 'other' || secondary === 'other') return null
    if (group.length === 2) return ['translation']
    if (!['japanese', 'korean'].includes(primary)) return null
    const third = script(group[2].text)
    if (secondary === 'han' && third === 'latin') return ['translation', 'romanization']
    if (secondary === 'latin' && third === 'han') return ['romanization', 'translation']
    return null
  }

  const patterns = new Map<string, number>()
  for (const group of groups.values()) {
    if (!layers(group)) continue
    const pattern = group.map((line) => script(line.text)).join(':')
    patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1)
  }
  for (const group of groups.values()) {
    const inferred = layers(group)
    const pattern = group.map((line) => script(line.text)).join(':')
    if (!inferred || (patterns.get(pattern) ?? 0) < 2) {
      result.original.push(...group)
      continue
    }
    result.original.push(group[0])
    inferred.forEach((layer, index) => result[layer].push(group[index + 1]))
  }
  return result
}
