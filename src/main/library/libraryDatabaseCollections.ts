import type { SQLInputValue } from 'node:sqlite'
import type {
  LibraryCollectionKind,
  LibraryCollectionPage,
  LibraryCollectionSummary,
  LibraryQuery
} from '../../shared/libraryDatabase.ts'
import { splitGenreValues } from '../../shared/genreSeparators.ts'
import { normalizeLibraryPath } from '../../shared/libraryIdentity.ts'
import {
  getCollectionAncestors,
  getCollectionDirectory,
  collectionIndexLetter,
  resolveAlbumArtistNames
} from '../../shared/libraryCollections.ts'
import { getPinyinInitials } from '../../shared/pinyinInitials.ts'
import { resolveAlbumReleaseDate } from '../../shared/releaseDate.ts'
import { SymSpellIndex, getMaxSymSpellTolerance } from '../../shared/searchRelevance.ts'
import { libraryPageBounds } from './libraryDatabaseValidation.ts'

type Row = Record<string, string | number | null>
export type LibrarySqlSelection = { sql: string; params: SQLInputValue[] }
type Select = (sql: string, params: SQLInputValue[]) => Row[]
type Summary = LibraryCollectionSummary & {
  firstSeq: number
  coverSeq: number
  coverSourceSeq: number
  matched: boolean
  genreMatched: boolean
  nameVariants: number
  owners: Set<string>
  artists: Set<string>
}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
export const normalizeCollectionSearch = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const compareNames = new Intl.Collator(['zh-CN', 'en'], { numeric: true, sensitivity: 'base' })
  .compare
const compareFileNames = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' }).compare
const compareZh = new Intl.Collator('zh').compare
const compareAlbumRows = (a: Row, b: Row): number =>
  Number(a.disc_no) - Number(b.disc_no) ||
  Number(a.track_no) - Number(b.track_no) ||
  compareFileNames(text(a.file_name), text(b.file_name)) ||
  compareZh(text(a.title), text(b.title)) ||
  Number(a.seq) - Number(b.seq)

/** Only summaries and lightweight sort keys cross the SQL seam, never member Track objects. */
export class LibraryDatabaseCollections {
  private readonly grouped = new Map<string, Summary[]>()
  private artistTotal: { revision: number; total: number } | null = null
  private collectionSymSpell: { groupsRef: Summary[]; index: SymSpellIndex } | null = null
  private readonly cache = new Map<
    string,
    { rows: Summary[]; letterOffsets: Record<string, number> }
  >()
  clear(): void {
    this.cache.clear()
    this.grouped.clear()
    this.artistTotal = null
    this.collectionSymSpell = null
  }
  clearTransientCaches(): void {
    this.cache.clear()
    this.grouped.clear()
    this.collectionSymSpell = null
  }

  query(
    kind: LibraryCollectionKind,
    query: LibraryQuery,
    revision: number,
    roots: string[],
    selection: LibrarySqlSelection,
    aliases: Map<string, string[]>,
    select: Select
  ): LibraryCollectionPage {
    if (!['albums', 'artists', 'genres', 'folders'].includes(kind))
      throw new Error('Unknown library collection')
    if (
      query.collectionSearchMode &&
      query.collectionSearchMode !==
        (kind === 'albums' ? 'albumTerms' : kind === 'artists' ? 'artistName' : null)
    )
      throw new Error('Collection search mode does not match the requested collection')
    const q = normalizeCollectionSearch(query.search ?? '')
    if (
      query.collectionCountOnly &&
      kind === 'artists' &&
      !q &&
      !query.collectionSearchMode &&
      !query.collectionGenre?.trim() &&
      !selection.sql
    ) {
      // Use the same credited members as the page, without hydrating Track objects.
      if (this.artistTotal?.revision !== revision) {
        const rows = select(
          `SELECT count(DISTINCT credit.value) AS total FROM tracks,
          json_each(library_artist_names(json_extract(payload,'$.artist'),json_extract(payload,'$.artists'),json_extract(payload,'$.identityTags'))) credit`,
          []
        )
        this.artistTotal = { revision, total: Number(rows[0].total) }
      }
      return { items: [], total: this.artistTotal.total, revision, offset: 0, letterOffsets: {} }
    }
    const key = JSON.stringify([
      revision,
      kind,
      selection,
      query.collectionSearchMode === 'albumTerms'
        ? (query.search ?? '').trim().split(/\s+/u).map(normalizeCollectionSearch).filter(Boolean)
        : q,
      query.genreSeparators,
      roots,
      query.collectionGenre,
      query.collectionNamesOnly,
      query.collectionSearchMode,
      query.collectionSort,
      query.sort,
      query.direction
    ])
    let cached = this.cache.get(key)
    if (!cached) {
      // Label searches and different sort orders share the same aggregate. Do
      // not reparse every payload just because the three order windows changed.
      const memberSearch = !query.collectionNamesOnly && !query.collectionSearchMode ? q : ''
      const groupKey = JSON.stringify([
        revision,
        kind,
        selection,
        memberSearch,
        query.genreSeparators,
        roots,
        query.collectionGenre
      ])
      let groups = this.grouped.get(groupKey)
      if (!groups) {
        groups = this.group(kind, query, roots, selection, aliases, memberSearch, select)
        this.grouped.set(groupKey, groups)
        while (this.grouped.size > 3) this.grouped.delete(this.grouped.keys().next().value!)
      } else {
        this.grouped.delete(groupKey)
        this.grouped.set(groupKey, groups)
      }
      const filtered = this.filter(groups, query, q)
      if (query.collectionCountOnly)
        return { items: [], total: filtered.length, revision, offset: 0, letterOffsets: {} }
      const direction = query.direction === 'desc' ? -1 : 1
      const compareCollectionNames =
        !query.collectionSearchMode && (kind === 'albums' || kind === 'artists')
          ? compareNames
          : compareZh
      const rows = filtered.sort((a, b) =>
        query.collectionSort === 'trackCount'
          ? (a.trackCount - b.trackCount) * direction ||
            compareZh(a.name, b.name) ||
            a.id.localeCompare(b.id)
          : query.collectionSort === 'label'
            ? compareZh(a.name, b.name) * direction || a.id.localeCompare(b.id)
            : (query.sort === 'addedAt' ? ((a.addedAt ?? 0) - (b.addedAt ?? 0)) * direction : 0) ||
              compareCollectionNames(a.name, b.name) * (query.sort === 'addedAt' ? 1 : direction) ||
              compareZh(a.name, b.name) ||
              compareZh(a.id, b.id)
      )
      const letterOffsets: Record<string, number> = {}
      rows.forEach((row, index) => {
        const letter = collectionIndexLetter(row.name)
        if (letter && letterOffsets[letter] === undefined) letterOffsets[letter] = index
      })
      cached = { rows, letterOffsets }
      this.cache.set(key, cached)
      while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!)
    }
    const { rows, letterOffsets } = cached
    if (query.collectionCountOnly)
      return { items: [], total: rows.length, revision, offset: 0, letterOffsets: {} }
    const { offset, limit } = libraryPageBounds(query.offset, query.limit)
    const items = rows.slice(offset, offset + limit).map(
      (row): LibraryCollectionSummary => ({
        id: row.id,
        name: row.name,
        trackCount: row.trackCount,
        duration: row.duration,
        cover: row.cover,
        ...(row.coverSource !== undefined ? { coverSource: row.coverSource } : {}),
        addedAt: row.addedAt,
        ...(row.path !== undefined ? { path: row.path } : {}),
        ...(row.artist !== undefined ? { artist: row.artist } : {}),
        ...(row.genre !== undefined ? { genre: text(row.genre) || null } : {})
      })
    )
    if (kind === 'albums' && items.length) this.enrichAlbumPage(items, selection, aliases, select)
    return { items, total: rows.length, revision, offset, letterOffsets: { ...letterOffsets } }
  }

  private group(
    kind: LibraryCollectionKind,
    query: LibraryQuery,
    roots: string[],
    selection: LibrarySqlSelection,
    aliases: Map<string, string[]>,
    q: string,
    select: Select
  ): Summary[] {
    const columns = {
      albums: 'album_key',
      artists: "library_artist_names(json_extract(payload,'$.artist'),json_extract(payload,'$.artists'),json_extract(payload,'$.identityTags'))",
      genres: "COALESCE(json_extract(payload,'$.genre'),'未知流派')",
      folders:
        "library_normalize_path(library_collection_directory(json_extract(payload,'$.filePath'),json_extract(payload,'$.dir'),?))"
    }
    const match = q
      ? "max(CASE WHEN instr(search_text,?)>0 OR instr(search_file,?)>0 OR instr(library_search_key(json_extract(payload,'$.filePath')),?)>0 THEN 1 ELSE 0 END)"
      : '1'
    const genreMatch = query.collectionGenre?.trim()
      ? "max(library_has_collection_genre(json_extract(payload,'$.genre'),?,?))"
      : '1'
    const rows = select(
      `WITH groups AS (
      SELECT ${columns[kind]} AS id,count(*) AS trackCount,max(added_at) AS addedAt,
        sum(CASE WHEN duration>0 THEN duration ELSE 0 END) AS duration,
        min(seq) AS firstSeq,min(CASE WHEN COALESCE(json_extract(payload,'$.cover'),'')<>'' THEN seq END) AS coverSeq,
        min(CASE WHEN COALESCE(json_extract(payload,'$.coverSource'),'')<>'' THEN seq END) AS coverSourceSeq,
        ${match} AS matched${kind === 'albums' ? ",count(DISTINCT json_extract(payload,'$.album')) AS nameVariants,json_group_array(DISTINCT artist) AS artists,json_group_array(DISTINCT json_extract(payload,'$.albumArtist')) AS owners" : ''}
        ,${genreMatch} AS genreMatched
      FROM tracks ${selection.sql} GROUP BY 1
    ) SELECT g.*,json_extract(first.payload,'$.album') AS album,json_extract(first.payload,'$.filePath') AS filePath,
      json_extract(first.payload,'$.dir') AS dir,json_extract(art.payload,'$.cover') AS cover,
      json_extract(art.payload,'$.coverSource') AS coverSource
      FROM groups g JOIN tracks first ON first.seq=g.firstSeq LEFT JOIN tracks art ON art.seq=COALESCE(g.coverSeq,g.coverSourceSeq)
      ORDER BY g.firstSeq`,
      [
        ...(kind === 'folders' ? [JSON.stringify(roots)] : []),
        ...(q ? [q, q, q] : []),
        ...(query.collectionGenre?.trim()
          ? [query.collectionGenre.trim(), query.genreSeparators ?? '']
          : []),
        ...selection.params
      ]
    )
    const groups = new Map<string, Summary>()
    const rootPaths = new Map(roots.map((path) => [normalizeLibraryPath(path), path]))
    const canonical = new Map<string, string>()
    if (kind === 'albums')
      for (const [id, keys] of aliases) for (const key of keys) canonical.set(key, id)
    for (const row of rows) {
      const raw = text(row.id)
      let targets: Array<{ id: string; name: string; path?: string }>
      if (kind === 'folders') {
        const directory = getCollectionDirectory(text(row.filePath), text(row.dir), roots)
        targets = getCollectionAncestors(directory, roots).map((path) => {
          const id = normalizeLibraryPath(path)
          return { id, name: id.split(/[\\/]/).pop() || path, path: rootPaths.get(id) ?? path }
        })
      } else if (kind === 'genres') {
        const names = splitGenreValues(raw, query.genreSeparators)
        targets = (names.length ? names : ['未知流派']).map((id) => ({ id, name: id }))
      } else if (kind === 'artists') {
        targets = (JSON.parse(raw) as string[]).map((id) => ({ id, name: id }))
      } else
        targets = [
          {
            id: canonical.get(raw) ?? raw,
            name: kind === 'albums' ? text(row.album) || '未知专辑' : raw
          }
        ]
      for (const target of targets) {
        let group = groups.get(target.id)
        if (!group) {
          group = {
            ...target,
            trackCount: 0,
            duration: 0,
            cover: null,
            addedAt: 0,
            firstSeq: Number(row.firstSeq),
            coverSeq: Infinity,
            coverSourceSeq: Infinity,
            matched: false,
            genreMatched: false,
            nameVariants: 0,
            owners: new Set(),
            artists: new Set()
          }
          groups.set(target.id, group)
        }
        group.trackCount += Number(row.trackCount)
        group.duration += Number(row.duration)
        group.addedAt = Math.max(group.addedAt ?? 0, Number(row.addedAt))
        group.matched ||= Boolean(row.matched)
        group.genreMatched ||= Boolean(row.genreMatched)
        if (typeof row.cover === 'string' && Number(row.coverSeq) < group.coverSeq) {
          group.cover = row.cover
          group.coverSeq = Number(row.coverSeq)
          if (typeof row.coverSource === 'string' && row.coverSource) {
            group.coverSource = row.coverSource
            group.coverSourceSeq = Number(row.coverSeq)
          }
        } else if (
          !group.cover &&
          typeof row.coverSource === 'string' &&
          row.coverSource &&
          Number(row.coverSourceSeq) < group.coverSourceSeq
        ) {
          group.coverSource = row.coverSource
          group.coverSourceSeq = Number(row.coverSourceSeq)
        }
        if (kind === 'albums') {
          group.nameVariants += Number(row.nameVariants)
          for (const owner of JSON.parse(text(row.owners)) as unknown[])
            group.owners.add(text(owner))
          for (const artist of JSON.parse(text(row.artists)) as unknown[])
            group.artists.add(text(artist))
          group.artist = resolveAlbumArtistNames(group.owners, group.artists)
        }
      }
    }
    if (kind === 'albums') {
      // Album tags may differ in spelling inside one release. Only those groups
      // need a lightweight track-order comparison to choose their display name.
      const variants = new Set(
        [...groups.values()].filter((group) => group.nameVariants > 1).map((group) => group.id)
      )
      const keys = [...canonical].filter(([, id]) => variants.has(id)).map(([key]) => key)
      if (keys.length) {
        const first = new Map<string, Row>()
        for (const row of select(
          `SELECT album_key,json_extract(payload,'$.album') AS album,seq,disc_no,track_no,file_name,title FROM tracks
          ${selection.sql} ${selection.sql ? 'AND' : 'WHERE'} album_key IN (SELECT value FROM json_each(?))`,
          [...selection.params, JSON.stringify(keys)]
        )) {
          const id = canonical.get(text(row.album_key))!,
            old = first.get(id)
          if (!old || compareAlbumRows(row, old) < 0) first.set(id, row)
        }
        for (const [id, row] of first) groups.get(id)!.name = text(row.album) || '未知专辑'
      }
    }
    return [...groups.values()]
  }

  private filter(groups: Summary[], query: LibraryQuery, q: string): Summary[] {
    if (query.collectionSearchMode) {
      const terms = (query.search ?? '')
        .trim()
        .split(/\s+/u)
        .map(normalizeCollectionSearch)
        .filter(Boolean)
      const matchTerms = (activeTerms: string[], activeQuery: string) =>
        groups.filter((group) => {
          if (!group.genreMatched || !activeTerms.length) return false
          if (query.collectionSearchMode === 'artistName')
            return normalizeCollectionSearch(group.name).includes(activeQuery)
          const blob = [group.name, group.artist ?? '']
            .flatMap((value) => [normalizeCollectionSearch(value), getPinyinInitials(value)])
            .join('\0')
          return activeTerms.every((term) => blob.includes(term))
        })
      const direct = matchTerms(terms, q)
      if (direct.length > 0 || !terms.some((term) => getMaxSymSpellTolerance(term) > 0)) {
        return direct
      }
      let symSpell =
        this.collectionSymSpell?.groupsRef === groups ? this.collectionSymSpell.index : null
      if (!symSpell) {
        symSpell = new SymSpellIndex()
        for (const group of groups) {
          if (!group.genreMatched) continue
          symSpell.addText(group.name, 3)
          if (group.artist) symSpell.addText(group.artist, 2)
        }
        this.collectionSymSpell = { groupsRef: groups, index: symSpell }
      }
      const suggestion = symSpell.suggestQuery(query.search ?? '')
      if (!suggestion) return direct
      return matchTerms(
        suggestion.tokens,
        normalizeCollectionSearch(suggestion.correctedQuery)
      )
    }
    return groups.filter(
      (group) =>
        group.genreMatched &&
        (!q ||
          (!query.collectionNamesOnly && group.matched) ||
          [group.name, group.path ?? '', group.artist ?? ''].some(
            (value) =>
              normalizeCollectionSearch(value).includes(q) || getPinyinInitials(value).includes(q)
          ))
    )
  }

  private enrichAlbumPage(
    items: LibraryCollectionSummary[],
    selection: LibrarySqlSelection,
    aliases: Map<string, string[]>,
    select: Select
  ): void {
    const itemByKey = new Map<string, LibraryCollectionSummary>()
    for (const item of items)
      for (const key of aliases.get(item.id) ?? [item.id]) itemByKey.set(key, item)
    const members = new Map<LibraryCollectionSummary, Row[]>()
    for (const row of select(
      `SELECT album_key,seq,disc_no,track_no,file_name,title,
      json_extract(payload,'$.cover') AS cover,json_extract(payload,'$.coverSource') AS coverSource,
      json_extract(payload,'$.releaseDate') AS releaseDate,
      json_extract(payload,'$.genre') AS genre FROM tracks ${selection.sql}
      ${selection.sql ? 'AND' : 'WHERE'} album_key IN (SELECT value FROM json_each(?))`,
      [...selection.params, JSON.stringify([...itemByKey.keys()])]
    )) {
      const item = itemByKey.get(text(row.album_key))!,
        rows = members.get(item) ?? []
      rows.push(row)
      members.set(item, rows)
    }
    for (const [item, rows] of members) {
      rows.sort(compareAlbumRows)
      const cover = rows.find((row) => row.cover) ?? rows.find((row) => row.coverSource)
      item.cover = typeof cover?.cover === 'string' ? cover.cover : null
      if (cover?.coverSource !== undefined) item.coverSource = cover.coverSource as string | null
      item.genre = text(rows[0]?.genre) || null
      const releaseDate = resolveAlbumReleaseDate(
        rows.map((row) => ({ releaseDate: text(row.releaseDate) }))
      )
      if (releaseDate !== undefined) item.releaseDate = releaseDate
    }
  }
}
