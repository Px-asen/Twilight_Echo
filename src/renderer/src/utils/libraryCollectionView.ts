import type { Track } from '../types/music'
import { splitGenreValues } from '../../../shared/genreSeparators.ts'
import { getPinyinInitial } from './pinyinInitials.ts'

export const AZ_INDEX_LETTERS = Array.from({ length: 26 }, (_, index) =>
  String.fromCharCode(65 + index)
)

export type LibraryCollectionSort = 'name-asc' | 'name-desc' | 'added-newest' | 'added-oldest'

export interface LibraryCollectionItem {
  name: string
  id?: string
  tracks?: Track[]
}

export interface LibraryCollectionViewState {
  sort: LibraryCollectionSort
  genre: string | null
}

const DEFAULT_STATE: LibraryCollectionViewState = {
  sort: 'name-asc',
  genre: null
}

const VALID_SORTS = new Set<LibraryCollectionSort>([
  'name-asc',
  'name-desc',
  'added-newest',
  'added-oldest'
])
const compareNames = new Intl.Collator(['zh-CN', 'en'], {
  numeric: true,
  sensitivity: 'base'
}).compare

export function applyLibraryCollectionView<T extends LibraryCollectionItem>(
  items: readonly T[],
  state: LibraryCollectionViewState,
  genreSeparators?: string
): T[] {
  const genre = normalizeGenre(state.genre)
  const result = items.filter(
    (item) =>
      !genre || itemGenres(item, genreSeparators).some((value) => normalizeGenre(value) === genre)
  )
  const addedAt = state.sort.startsWith('added-')
    ? new Map(result.map((item) => [item, collectionAddedAt(item)]))
    : null
  // Native sort is stable; compute each collection's date once per view update.
  return result.sort((left, right) => {
    const byAddedAt = addedAt ? addedAt.get(left)! - addedAt.get(right)! : 0
    return (
      byAddedAt * (state.sort === 'added-oldest' ? 1 : -1) ||
      compareNames(left.name, right.name) * (state.sort === 'name-desc' ? -1 : 1)
    )
  })
}

export function availableCollectionGenres(
  items: readonly LibraryCollectionItem[],
  genreSeparators?: string
): string[] {
  const labels = new Map<string, string>()
  for (const item of items) {
    for (const genre of itemGenres(item, genreSeparators)) {
      const normalized = normalizeGenre(genre)
      if (normalized && !labels.has(normalized)) labels.set(normalized, genre.trim())
    }
  }
  return [...labels.values()].sort(compareNames)
}

export function collectionAddedAt(item: LibraryCollectionItem): number {
  let latest = 0
  for (const track of item.tracks ?? []) {
    if (typeof track.addedAt === 'number' && Number.isFinite(track.addedAt)) {
      latest = Math.max(latest, track.addedAt)
    }
  }
  return latest
}

export function collectionIndexLetter(name: string): string | null {
  const first = name.trim().normalize('NFKD').replace(/\p{M}/gu, '').charAt(0).toUpperCase()
  if (/^[A-Z]$/.test(first)) return first
  return getPinyinInitial(first).toUpperCase() || null
}

export function availableCollectionLetters(items: readonly LibraryCollectionItem[]): Set<string> {
  const result = new Set<string>()
  for (const item of items) {
    const letter = collectionIndexLetter(item.name)
    if (letter) result.add(letter)
  }
  return result
}

export function firstCollectionIndexForLetter(
  items: readonly LibraryCollectionItem[],
  letter: string
): number {
  const normalized = letter.toUpperCase()
  return items.findIndex((item) => collectionIndexLetter(item.name) === normalized)
}

/** Derive the A-Z highlight from scroll position instead of walking mounted cards. */
export function collectionLetterAtScroll(
  items: readonly LibraryCollectionItem[],
  scrollTop: number,
  gridOffsetTop: number,
  columns: number,
  rowStride: number,
  scanOffset = 104
): string | null {
  if (items.length === 0) return null
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeStride = Math.max(1, rowStride)
  const yInGrid = scrollTop + scanOffset - gridOffsetTop
  const row = Math.max(0, Math.floor(yInGrid / safeStride))
  const index = Math.min(items.length - 1, row * safeColumns)
  return collectionIndexLetter(items[index]?.name ?? '')
}

export class LibraryCollectionViewPreferences {
  private readonly storage: Storage | null
  private readonly storageKey: string

  constructor(
    storage: Storage | null = globalThis.localStorage ?? null,
    storageKey = 'twilight-echo:library-collection-view:v1'
  ) {
    this.storage = storage
    this.storageKey = storageKey
  }

  read(category: string): LibraryCollectionViewState {
    try {
      const raw = this.storage?.getItem(this.storageKey)
      if (!raw) return { ...DEFAULT_STATE }
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return normalizeState(parsed[category])
    } catch {
      return { ...DEFAULT_STATE }
    }
  }

  write(category: string, state: LibraryCollectionViewState): void {
    try {
      if (!this.storage) return
      const raw = this.storage.getItem(this.storageKey)
      const parsed = raw ? JSON.parse(raw) : {}
      const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      this.storage.setItem(
        this.storageKey,
        JSON.stringify({ ...values, [category]: normalizeState(state) })
      )
    } catch {
      // Collection view preferences are optional and must never block library rendering.
    }
  }
}

function itemGenres(item: LibraryCollectionItem, genreSeparators?: string): string[] {
  const genres = new Map<string, string>()
  for (const track of item.tracks ?? []) {
    for (const genre of splitGenreValues(track.genre, genreSeparators)) {
      const normalized = normalizeGenre(genre)
      if (genre && normalized && !genres.has(normalized)) genres.set(normalized, genre)
    }
  }
  return [...genres.values()]
}

function normalizeGenre(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase() ?? ''
}

function normalizeState(value: unknown): LibraryCollectionViewState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_STATE }
  const candidate = value as Partial<LibraryCollectionViewState>
  return {
    sort:
      typeof candidate.sort === 'string' && VALID_SORTS.has(candidate.sort as LibraryCollectionSort)
        ? (candidate.sort as LibraryCollectionSort)
        : DEFAULT_STATE.sort,
    genre:
      typeof candidate.genre === 'string' && candidate.genre.trim() ? candidate.genre.trim() : null
  }
}
