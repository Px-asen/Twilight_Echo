import type { LyricWord } from './lyrics.ts'

/**
 * Karaoke sources disagree about what a "word" is. Enhanced LRC and YRC both
 * emit one entry per *syllable* and keep whitespace inside the entry text, so a
 * single English word can arrive as `lo` + `ve`. Emphasis and the karaoke mask
 * must operate on the visual word instead, otherwise `love` scales as two
 * independent halves.
 *
 * Two rules matter, and the second is easy to get wrong:
 *
 * 1. Syllables not separated by whitespace group into one visual word.
 * 2. A CJK character always *terminates* the current group. CJK lines carry no
 *    spaces, so without this every Chinese line would merge into a single unit
 *    and emphasize as one giant word.
 */

/** A word whose end time has been resolved to a concrete number. */
export interface ResolvedLyricWord extends LyricWord {
  endTime: number
}

export interface LyricWhitespaceChunk {
  kind: 'space'
  text: string
}

export interface LyricSingleWordChunk {
  kind: 'word'
  word: ResolvedLyricWord
}

/** Syllables that render as one visual word, plus their merged span. */
export interface LyricWordGroupChunk {
  kind: 'group'
  words: ResolvedLyricWord[]
  merged: ResolvedLyricWord
}

export type LyricWordChunk = LyricWhitespaceChunk | LyricSingleWordChunk | LyricWordGroupChunk

/**
 * Anchored and full-string by design: it is applied to raw word text, so `" 我"`
 * is intentionally not CJK. Hiragana and Katakana fall inside the range; Hangul
 * (U+AC00 and above) does not.
 */
const CJK_EXP = /^[\p{Unified_Ideograph}\u0800-\u9FFC]+$/u
const CONTAINS_CJK_EXP = /[\p{Unified_Ideograph}\u0800-\u9FFC]/u
const OPENING_PUNCTUATION_EXP = /^[（「『【《〈〔“‘([<{]+$/u
const CLOSING_PUNCTUATION_EXP = /^[、。，！？；：）」』】》〉〕”’～…—.!?,;:)\]]+$/u

/** At most one run of non-space characters. */
const SINGLE_WORD_RUN = /^\s*[^\s]*\s*$/

const WHITESPACE_ONLY = /^\s+$/

export function isCJK(text: string): boolean {
  return CJK_EXP.test(text)
}

/**
 * `LyricWord.endTime` is nullable across every parser. Resolve it once here so
 * downstream animation code never has to guess: explicit end, else the next
 * word's start, else the line end.
 */
export function resolveLyricWordTimings(
  words: readonly LyricWord[],
  lineEndTime: number | null = null
): ResolvedLyricWord[] {
  const resolved: ResolvedLyricWord[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const candidates = [word.endTime, words[index + 1]?.time ?? null, lineEndTime]
    let endTime = word.time
    for (const candidate of candidates) {
      if (candidate == null || !Number.isFinite(candidate)) continue
      if (candidate <= word.time) continue
      endTime = candidate
      break
    }
    resolved.push({ ...word, endTime })
  }
  return resolved
}

function spacer(text: string): ResolvedLyricWord {
  return { text, time: 0, endTime: 0 }
}

/**
 * A single entry may still contain internal spaces (`"sugar so"`). Split it and
 * distribute its span across the pieces by character count, inserting explicit
 * separators so the chunker can see the word boundaries.
 */
function presplitInternalSpaces(words: readonly ResolvedLyricWord[]): ResolvedLyricWord[] {
  const result: ResolvedLyricWord[] = []
  for (const word of words) {
    const segments = word.text.split(/(\s+)/u).filter(Boolean)
    if (segments.length === 1) {
      result.push({ ...word })
      continue
    }

    const realLength = word.text.replace(/\s/g, '').length
    const span = word.endTime - word.time
    let charPos = 0
    for (const segment of segments) {
      if (WHITESPACE_ONLY.test(segment)) {
        result.push(spacer(segment))
        continue
      }
      const ratioStart = realLength > 0 ? charPos / realLength : 0
      const ratioEnd = realLength > 0 ? (charPos + segment.length) / realLength : 1
      result.push({
        text: segment,
        time: word.time + ratioStart * span,
        endTime: word.time + ratioEnd * span
      })
      charPos += segment.length
    }
  }
  return result
}

function mergeChunkWords(words: ResolvedLyricWord[]): ResolvedLyricWord {
  let text = ''
  let time = Number.POSITIVE_INFINITY
  let endTime = Number.NEGATIVE_INFINITY
  for (const word of words) {
    text += word.text
    time = Math.min(time, word.time)
    endTime = Math.max(endTime, word.endTime)
  }
  return { text, time, endTime }
}

/**
 * Split resolved words into render chunks. Whitespace-only entries stay separate
 * so the render layer can emit them as plain text nodes without a mask or an
 * emphasis animation.
 */
export function chunkAndSplitLyricWords(words: readonly ResolvedLyricWord[]): LyricWordChunk[] {
  const flat = presplitInternalSpaces(words)
  const chunks: LyricWordChunk[] = []
  let group: ResolvedLyricWord[] = []

  const flush = (): void => {
    if (group.length === 1) {
      chunks.push({ kind: 'word', word: group[0] })
    } else if (group.length > 1) {
      chunks.push({ kind: 'group', words: group, merged: mergeChunkWords(group) })
    }
    group = []
  }

  for (const word of flat) {
    if (word.text.length === 0) continue

    if (WHITESPACE_ONLY.test(word.text)) {
      flush()
      chunks.push({ kind: 'space', text: word.text })
      continue
    }

    if (group.length > 0 && CLOSING_PUNCTUATION_EXP.test(word.text)) {
      group.push(word)
      continue
    }

    const attachedToOpeningPunctuation =
      group.length > 0 && group.every((entry) => OPENING_PUNCTUATION_EXP.test(entry.text))

    group.push(word)
    const joined = group.map((entry) => entry.text).join('')
    // A second non-space run means a boundary was crossed; CJK always breaks
    // unless it is attaching to leading opening punctuation.
    if (
      !SINGLE_WORD_RUN.test(joined) ||
      (!attachedToOpeningPunctuation && (isCJK(word.text) || CONTAINS_CJK_EXP.test(word.text)))
    ) {
      group.pop()
      flush()
      group = [word]
    }
  }
  flush()

  return chunks
}

/** Every timed word in a chunk, in render order. */
export function chunkWords(chunk: LyricWordChunk): ResolvedLyricWord[] {
  if (chunk.kind === 'space') return []
  return chunk.kind === 'word' ? [chunk.word] : chunk.words
}

/** The span a chunk occupies, used for emphasis strength and mask timing. */
export function chunkSpan(chunk: LyricWordChunk): ResolvedLyricWord | null {
  if (chunk.kind === 'space') return null
  return chunk.kind === 'word' ? chunk.word : chunk.merged
}
