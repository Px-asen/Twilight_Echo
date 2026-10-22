import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { computed, effectScope, reactive, ref, shallowRef, watch } from 'vue'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'
import type { Track } from '../types/music'
import { resolveLibraryArtistTracks } from '../utils/libraryCollectionView.ts'
import { movePlaylistEntry, orderPlaylistEntries } from './streaming-page/playlistLibraryView.ts'

test('preview playlist order is local while live order still restores and persists', () => {
  const source = readFileSync(
    new URL('./song-list/useLocalPlaylistOrder.ts', import.meta.url),
    'utf8'
  )
  const saved = new Map([['te-local-playlist-order:test', '["c","b","a"]']])
  let reads = 0,
    writes = 0
  const exports: {
    useLocalPlaylistOrder?: (
      source: ReturnType<typeof ref<Array<{ id: string }>>>,
      key: () => string,
      report: () => void,
      options?: { persist?: boolean }
    ) => {
      playlists: { value: Array<{ id: string }> }
      move: (from: string, to: string, visible: Array<{ id: string }>) => void
    }
  } = {}
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      require: (id: string) => {
        if (id === 'vue') return { computed, shallowRef, watch }
        if (id === '@renderer/components/streaming-page/playlistLibraryView')
          return { movePlaylistEntry, orderPlaylistEntries }
        throw new Error(`Unexpected dependency: ${id}`)
      },
      localStorage: {
        getItem: (key: string) => {
          reads++
          return saved.get(key) ?? null
        },
        setItem: (key: string, value: string) => {
          writes++
          saved.set(key, value)
        }
      }
    }
  )
  const scope = effectScope()
  try {
    const entries = ref(['a', 'b', 'c'].map((id) => ({ id })))
    const preview = scope.run(() =>
      exports.useLocalPlaylistOrder!(
        entries,
        () => 'test',
        () => {},
        { persist: false }
      )
    )!
    assert.deepEqual(
      preview.playlists.value.map((entry) => entry.id),
      ['a', 'b', 'c']
    )
    preview.move('a', 'c', preview.playlists.value)
    assert.deepEqual(
      preview.playlists.value.map((entry) => entry.id),
      ['b', 'c', 'a']
    )
    assert.deepEqual([reads, writes], [0, 0])
    const live = scope.run(() =>
      exports.useLocalPlaylistOrder!(
        entries,
        () => 'test',
        () => {}
      )
    )!
    assert.deepEqual(
      live.playlists.value.map((entry) => entry.id),
      ['c', 'b', 'a']
    )
    live.move('c', 'a', live.playlists.value)
    assert.deepEqual([reads, writes], [1, 1])
    assert.equal(saved.get('te-local-playlist-order:test'), '["b","a","c"]')
  } finally {
    scope.stop()
  }
})

test('local artist navigation resolves collaborations and reacts to the selected performer', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const script = parse(source).descriptor.scriptSetup!.content
  const ast = ts.createSourceFile('SongList.ts', script, ts.ScriptTarget.Latest, true)
  let expression = ''
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const declaration = statement.declarationList.declarations.find(
      (node) => node.name.getText(ast) === 'baseDisplayTracks'
    )
    if (declaration?.initializer) expression = declaration.initializer.getText(ast)
  }
  assert.ok(expression)
  const solo = { id: 'solo', artist: 'Alice' } as Track
  const duet = { id: 'duet', artist: 'Alice / Bob' } as Track
  const tracks = ref([solo, duet])
  const props = reactive({ category: 'artists', filter: 'artist:Alice' })
  const code = ts.transpileModule(`const result = ${expression}; result`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const result = runInNewContext(code, {
    computed,
    props,
    databaseTableCandidate: ref(false),
    libraryStorage: { mode: ref('json') },
    tracks,
    resolveLibraryArtistTracks
  }) as { value: Track[] }
  assert.deepEqual(
    result.value.map((track) => track.id),
    ['solo', 'duet']
  )
  props.filter = 'artist:Bob'
  assert.deepEqual(
    result.value.map((track) => track.id),
    ['duet']
  )
  tracks.value = [solo]
  assert.deepEqual(result.value, [])
})

test('song list omits header kickers from all non-dashboard local library views', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /viewKicker/)
  assert.doesNotMatch(source, /class="view-kicker"/)
  assert.doesNotMatch(source, /class="kicker-rule"/)
  assert.doesNotMatch(styles, /\.view-kicker/)
  assert.doesNotMatch(styles, /\.kicker-rule/)
})

test('folder view renders explicit empty and filtered-empty states instead of a blank page', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /category === 'folders' && folders\.length === 0/)
  assert.match(source, /暂无可显示的文件夹/)
  assert.match(source, /点击「导入歌曲」选择并扫描音乐文件夹/)
  assert.match(source, /gridTotalCount === 0/)
  assert.match(source, /没有符合搜索条件的内容/)
})

test('song list exposes local metadata match confidence from provider enrichment', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /function metadataMatchLabel\(track: Track\): string/)
  assert.match(source, /function metadataMatchTitle\(track: Track\): string/)
  assert.match(source, /track\.metadataMatch/)
  assert.match(source, /class="metadata-match-chip"/)
  assert.match(source, /v-if="track\.metadataMatch"/)
  assert.match(source, /:title="metadataMatchTitle\(track\)"/)
})

test('song list wires clear metadata match action into the context menu', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /clearTrackMetadataMatch/)
  assert.match(source, /clearMetadataMatch:/)
  assert.match(source, /canClearMetadataMatchSelectedTrack/)
  assert.match(source, /handleClearMetadataMatch/)
  assert.match(source, /取消流媒体匹配/)
})

test('song list manual matching uses ranked metadata match candidates', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /buildMetadataMatchCandidates/)
  assert.match(source, /const candidates = buildMetadataMatchCandidates\(/)
  assert.match(source, /const rematched = candidates\[0\]\?\.track/)
})

test('playlist rows expose a free source picker instead of only automatic rematching', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /TrackSourcePicker/)
  assert.match(source, /const sourcePickerTrack = shallowRef<Track \| null>\(null\)/)
  assert.match(source, /replaceTrackReference\(original\.id, replacement\)/)
  assert.match(source, /v-if="isPlaylistDetail && selectedTrack && contextActionCount <= 1"/)
  assert.match(source, /选择播放来源/)
})

test('song list wires local metadata rematch into the context menu', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /async function handleMetadataRematch\(track: Track\): Promise<void>/)
  assert.match(source, /applyTrackMetadataMatch/)
  assert.match(source, /rematchMetadata: handleMetadataRematch/)
  assert.match(source, /canRematchMetadataSelectedTrack/)
  assert.match(source, /handleRematchMetadata/)
  assert.match(source, /重新匹配流媒体元数据/)
})

test('song list local music search skips providers by default and can opt into online results', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /useUnifiedMusicSearch/)
  assert.match(source, /const searchOnlineSongs = ref\(false\)/)
  assert.match(
    source,
    /const shouldUseUnifiedSearch = computed\(\s*\(\) =>\s+showOnlineSearchToggle\.value && searchOnlineSongs\.value\s+\)/
  )
  assert.match(source, /unifiedSearch\.search\(q/)
  assert.match(source, /unifiedSearch\.items\.value\.map\(\(item\) => item\.track\)/)
  assert.match(source, /props\.category === 'allSongs'/)
  assert.match(source, /v-model="searchOnlineSongs"/)
  assert.match(source, /搜索网络歌曲/)
  assert.match(styles, /\.online-search-toggle/)
})

test('song list exposes unified search loading errors and provider health in the local search UI', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /unifiedSearchStatusText/)
  assert.match(source, /unifiedSearchHealthItems/)
  assert.match(source, /unified-search-status/)
  assert.match(source, /unified-search-health-chip/)
  assert.match(source, /unifiedSearch\.loading\.value/)
  assert.match(source, /unifiedSearch\.error\.value/)
  assert.match(source, /providerHealth\.value/)
  assert.match(source, /health\.lastError/)
})

test('song list unified search health chips include plugin and playback URL diagnostics', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /unifiedSearchHealthDetail\(health\)/)
  assert.match(source, /health\.pluginStatus/)
  assert.match(source, /health\.successRate/)
  assert.match(source, /health\.playbackUrlSuccessRate/)
  assert.match(source, /health\.playbackUrlLastError/)
  assert.match(source, /播放 URL/)
  assert.match(source, /插件/)
})

test('song list hides local source badges and keeps provider source badges', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /unifiedSearchSourceNames/)
  assert.match(source, /trackSourceLabel\(track\)/)
  assert.match(source, /trackSourceClass\(track\)/)
  assert.match(source, /class="track-source-chip"/)
  assert.match(source, /v-if="getLogicalTrackSource\(track\) !== 'local'"/)
  assert.doesNotMatch(source, /本地无损/)
  assert.match(source, /item\.sourceName/)
})

test('song list playlist cards expose mixed-source composition', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /summarizePlaylistSources/)
  assert.match(source, /formatPlaylistSourceSummary/)
  assert.match(source, /function playlistSourceSummaryLabel\(playlist: GridItem\): string/)
  assert.match(source, /class="playlist-source-summary"/)
  assert.match(source, /playlistSourceSummaryLabel\(item\)/)
  assert.match(styles, /\.playlist-source-summary/)
})

test('song list surfaces library repair status for moved or unresolved local files', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /libraryRepairReport/)
  assert.match(source, /libraryRepairStatusText/)
  assert.match(source, /已自动重定位/)
  assert.match(source, /本地文件未找到/)
  assert.match(source, /重新匹配音源/)
  assert.match(source, /class="library-repair-status"/)
  assert.match(styles, /\.library-repair-status/)
})

test('song list consolidates sort and filter controls into a 筛选器 button panel', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /libraryFilterPanelOpen/)
  assert.match(source, /toggleLibraryFilterPanel/)
  assert.match(source, /resetLibraryFilters/)
  assert.match(source, /activeLibraryFilterCount/)
  assert.match(source, /onDocumentPointerDown/)
  assert.match(source, /class="library-filter-trigger"/)
  assert.match(source, />筛选器</)
  assert.match(source, /class="library-filter-panel"/)
  assert.match(source, /class="library-view-controls"/)
  assert.match(source, /setLibraryFilter\('lossless'/)
  assert.match(source, /setLibraryFilter\('dsd'/)
  assert.match(source, /setLibraryFilter\(\s*'sampleRate'/)
  assert.match(source, /setLibraryFilter\(\s*'bitDepth'/)
  assert.match(source, /setLibraryFilter\(\s*'folder'/)
  assert.match(source, /setLibraryFilter\(\s*'provider'/)
  assert.match(source, /setSortKey/)
  assert.match(source, /setSortDirection/)
  assert.match(styles, /\.library-filter-trigger/)
  assert.match(styles, /\.library-filter-panel/)
  // Controls should live inside the panel, not as a permanent header strip.
  assert.match(source, /library-filter-panel[\s\S]*library-view-controls/)
})

test('artist and album grids expose combinable sorting, genre filtering, and A-Z navigation', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /applyLibraryCollectionView/)
  assert.match(source, /collectionViewState/)
  assert.match(source, /名称 A-Z/)
  assert.match(source, /名称 Z-A/)
  assert.match(source, /添加时间：最新优先/)
  assert.match(source, /添加时间：最旧优先/)
  assert.match(source, /按流派筛选/)
  assert.match(source, /AZ_INDEX_LETTERS/)
  assert.match(source, /jumpToCollectionLetter/)
  assert.match(source, /collectionLetterDisabled/)
  assert.match(source, /activeCollectionLetter === letter/)
  assert.match(source, /aria-current/)
  assert.match(styles, /\.collection-view-controls/)
  assert.match(styles, /\.az-index/)
  assert.match(styles, /\.az-index\s*\{[^}]*position: sticky/)
  assert.doesNotMatch(styles, /\.az-index\s*\{[^}]*position: fixed/)
  assert.match(styles, /\.az-index button\.active/)
  assert.match(styles, /\.az-index button:disabled/)
})

test('song list supports batch favorite plus explicit local remove and recycle-bin actions', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /useTrackMultiSelect/)
  assert.match(source, /track-selected/)
  assert.match(source, /selection-toolbar/)
  assert.match(source, /handleToolbarFavorite/)
  assert.match(source, /handleToolbarRemoveFromLibrary/)
  assert.match(source, /handleToolbarMoveToTrash/)
  assert.match(source, /handleBatchFavorite/)
  assert.match(source, /runLocalLibraryRemoval/)
  assert.match(source, /window\.confirm/)
  assert.match(source, /mode === 'library'/)
  assert.match(source, /文件仍保留在磁盘/)
  assert.match(source, /从音乐库移除/)
  assert.match(source, /移到回收站/)
  assert.match(source, /handleContextFavorite/)
  assert.match(source, /加入应用收藏/)
  // Multi-select is opt-in via modifier keys / checkbox / context menu — not plain play.
  assert.match(source, /onTrackSelectToggle/)
  assert.match(source, /track-select-checkbox/)
  assert.match(source, /track-cover-cell/)
  assert.match(source, /closest\('\.track-select-checkbox'\)/)
  assert.match(styles, /\.track-selected/)
  assert.match(styles, /\.selection-toolbar/)
  assert.match(styles, /\.track-select-checkbox/)
  assert.match(styles, /\.track-cover-cell/)
})

test('double-click activation keeps plain clicks out of multi-select mode', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  const handlerMatch = source.match(
    /function onRowClick\([\s\S]*?\n}\n\nfunction onTrackSelectToggle/
  )

  assert.ok(handlerMatch)
  const handler = handlerMatch[0]
  assert.match(handler, /multiSelect\.onRowClick\(track, index, event\)/)
  assert.match(handler, /trackActivationMode === 'doubleClick'\) return/)
  assert.doesNotMatch(handler, /selectOnly\(/)
  assert.match(source, /multiSelect\.shouldSuppressRowDoubleClick\(event\)/)
})

test('song list exposes exclusion management and restore controls', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /excludedTracks/)
  assert.match(source, /showExcludedTracksDialog/)
  assert.match(source, /restoreExcludedTracks/)
  assert.match(source, /handleRestoreExclusions/)
  assert.match(source, /已从音乐库移除/)
  assert.match(source, /全部恢复/)
  assert.match(styles, /\.excluded-tracks-dialog/)
  assert.match(styles, /\.excluded-track-row/)
})

test('all songs header hides track count and total duration', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  const start = source.indexOf('const viewStatsText = computed(')
  assert.ok(start > 0)
  const body = source.slice(start, source.indexOf('})', start))
  assert.match(body, /props\.category === 'allSongs'\) return ''/)
})

test('all songs merges duplicate check and excluded management into one 库管理 dropdown', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')

  assert.match(source, /libraryToolsMenuOpen/)
  assert.match(source, /openLibraryDuplicates/)
  assert.match(source, /openLibraryExcluded/)
  assert.match(source, /class="library-tools-dropdown"/)
  assert.match(source, /class="library-tools-menu"/)
  assert.match(styles, /\.library-tools-dropdown/)
  assert.match(styles, /\.library-tools-menu/)
  // Only one all-songs trigger remains in the header.
  const triggers = source.match(/class="excluded-tracks-trigger[^"]*"/g) ?? []
  assert.equal(triggers.length, 1)
})

test('library header places the search box last so it renders right-most', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  const tableHeader = source.slice(source.lastIndexOf('<div class="header-right">'))
  const searchIndex = tableHeader.indexOf('class="search-box"')
  assert.ok(searchIndex > 0)
  for (const marker of [
    'class="library-tools-dropdown"',
    'class="recent-source-dropdown"',
    'class="library-filter-dropdown"',
    '<PlaylistLifecycleToolbar'
  ]) {
    const index = tableHeader.indexOf(marker)
    assert.ok(index > 0, `${marker} missing from library header`)
    assert.ok(index < searchIndex, `${marker} should precede the search box`)
  }
})

test('library playback controls render in the title group while albums use dedicated controls', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

  assert.doesNotMatch(source, /class="header-play-actions"/)
  const tableHeaderStart = source.lastIndexOf('<div class="song-list-header"')
  const headerLeftStart = source.indexOf(
    '<div v-if="!currentAlbum" class="header-left">',
    tableHeaderStart
  )
  const titleGroupStart = source.indexOf('<div class="title-group">', headerLeftStart)
  const headerRightStart = source.indexOf('<div class="header-right">', tableHeaderStart)
  const albumHeaderIndex = source.indexOf('<AlbumDetailHeader', tableHeaderStart)
  const playActionsIndex = source.indexOf('class="library-play-actions"', tableHeaderStart)
  const tableHeaderEnd = source.lastIndexOf('</div>', albumHeaderIndex)

  assert.ok(tableHeaderStart > 0)
  assert.ok(headerLeftStart > tableHeaderStart)
  assert.ok(titleGroupStart > headerLeftStart)
  assert.ok(playActionsIndex > titleGroupStart)
  assert.ok(headerRightStart > playActionsIndex)
  assert.ok(tableHeaderEnd > headerRightStart)
  assert.ok(albumHeaderIndex > tableHeaderEnd)
  const titleGroup = source.slice(titleGroupStart, headerRightStart)
  assert.match(titleGroup, /class="library-play-actions"[\s\S]*<\/div>\s*<\/div>\s*<\/div>\s*$/)
  for (const handler of ['playAllTracks', 'shufflePlayTracks']) {
    assert.match(
      titleGroup,
      new RegExp(
        `:disabled="tableTrackCount === 0 \\|\\| databaseReadPending"\\s+@click="${handler}"`
      )
    )
  }
  const albumHeader = source.slice(albumHeaderIndex, source.indexOf('/>', albumHeaderIndex))
  assert.match(albumHeader, /v-if="currentAlbum"/)
  assert.match(albumHeader, /:can-play="tableTrackCount > 0 && !databaseReadPending"/)
  assert.match(albumHeader, /@play="playAllTracks"/)
  assert.match(albumHeader, /@shuffle="shufflePlayTracks"/)
})

test('song list context menu exposes play next, view artist, and view album actions', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')

  assert.match(source, /playNextTrack/)
  assert.match(source, /playNext: playNextTrack/)
  assert.match(source, /canPlayNextSelectedTrack/)
  assert.match(source, /handlePlayNext/)
  assert.match(source, /下一首播放/)

  assert.match(source, /canViewSelectedContext/)
  assert.match(source, /handleViewArtist/)
  assert.match(source, /handleViewAlbum/)
  assert.match(source, /查看歌手/)
  assert.match(source, /查看专辑/)

  assert.match(source, /emit\('selectView', 'artists', `artist:\$\{artist\}`\)/)
  assert.match(source, /emit\('selectView', 'albums', `album:\$\{albumItem\.id\}`\)/)
})

test('track table places the list number before artwork and reserves metadata track numbers for album details', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  const table = source.slice(source.indexOf('<table class="track-table">'))
  const header = table.slice(table.indexOf('<thead>'), table.indexOf('</thead>'))
  const row = table.slice(
    table.indexOf('class="track-row"'),
    table.indexOf('</tr>', table.indexOf('class="track-row"'))
  )

  assert.ok(header.indexOf('class="col-index"') < header.indexOf('class="col-cover-header"'))
  assert.ok(row.indexOf('class="col-index"') < row.indexOf('class="col-cover"'))
  assert.match(source, /const isAlbumDetail = computed\(/)
  assert.match(source, /isAlbumDetail\.value[\s\S]*track\.trackNumber/)
  assert.match(source, /visibleRange\.value\.start \+\s*visibleIndex \+\s*1/)
  assert.doesNotMatch(
    source.slice(
      source.indexOf('function trackListNumber'),
      source.indexOf('const currentPlaylist =')
    ),
    /page\?\.offset/
  )
  assert.match(row, /trackListNumber\(track, Number\(index\)\)/)
  assert.doesNotMatch(row, /track\.trackNumber\s*\?\?/)
})

test('collection grid window-mounts cards and derives A-Z from data', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./song-list/SongList.css', import.meta.url), 'utf8')
  const grid = readFileSync(
    new URL('./song-list/useSongListGridRendering.ts', import.meta.url),
    'utf8'
  )

  assert.match(source, /grid-virtual-spacer/)
  assert.match(source, /v-for="\{ item, index \} in visibleGridSlots"/)
  assert.match(source, /collectionLetterAtScroll/)
  assert.match(source, /loading="lazy"/)
  assert.doesNotMatch(source, /querySelectorAll<HTMLElement>\('\[data-collection-letter\]'\)/)
  assert.doesNotMatch(grid, /pumpGridRendering/)
  assert.match(grid, /getSongListGridVirtualRange/)
  assert.match(styles, /\.grid-virtual-spacer/)
  assert.match(styles, /\.artist-card:hover[\s\S]*backdrop-filter: blur\(20px\)/)
  assert.doesNotMatch(
    styles.slice(
      styles.indexOf('/* Unified Card Component Styles */'),
      styles.indexOf('.artist-card:hover')
    ),
    /backdrop-filter: blur\(20px\)/
  )
  assert.match(styles, /\.track-playing::before \{[\s\S]*backdrop-filter: blur\(18px\)/)
})

test('selected tracks await one queue command before reporting success, without starting playback', async () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const body = source.match(
    /async function appendActionTracksToQueue\(actionTracks\?: Track\[\]\): Promise<void> \{([\s\S]*?)\n\}/
  )?.[1]
  assert.ok(body)
  const batches: unknown[] = []
  const message = { value: '' }
  let cleared = 0
  let closed = 0
  const execute = new Function(
    'actionTracks',
    'playbackStore',
    'repairMessage',
    'clearSelection',
    'closeContextMenu',
    'libraryMutationPending',
    'multiSelect',
    'databaseTableEnabled',
    `return ${ts.transpileModule(`(async () => {${body}})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}`
  )
  const append = (...args: unknown[]) => execute(...args, { value: false })
  const tracks = [{ id: 'local:2' }, { id: 'ncm:1' }]
  let release!: () => void
  const store = {
    appendQueueTracksAsync: async (items: unknown) => {
      batches.push(items)
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
  }
  const pending = { value: false }
  const selection = { selectionVersion: { value: 0 } }
  const operation = append(
    tracks,
    store,
    message,
    () => cleared++,
    () => closed++,
    pending,
    selection
  )
  assert.deepEqual(batches, [tracks])
  assert.equal(pending.value, true)
  assert.equal(cleared, 0)
  assert.equal(message.value, '')
  release()
  await operation
  assert.equal(cleared, 1)
  assert.equal(closed, 1)
  assert.equal(message.value, '已添加 2 首到播放队列')
  await append(
    [],
    store,
    message,
    () => cleared++,
    () => closed++,
    pending,
    selection
  )
  assert.equal(batches.length, 1)
  await append(
    tracks,
    {
      appendQueueTracksAsync: async () => {
        throw new Error('reply lost')
      }
    },
    message,
    () => cleared++,
    () => closed++,
    pending,
    selection
  )
  assert.equal(message.value, 'reply lost')
  assert.equal(cleared, 1, 'failed/unknown insert retains the selection for inspection')
  assert.equal(pending.value, false)
  const later = append(
    tracks,
    store,
    message,
    () => cleared++,
    () => closed++,
    pending,
    selection
  )
  selection.selectionVersion.value++
  release()
  await later
  assert.equal(cleared, 1, 'an earlier completed command must not clear a newer selection')
  assert.match(source, /@click="appendActionTracksToQueue\(contextTracksForAction\(\)\)"/)
  assert.match(source, /@click="appendActionTracksToQueue\(\)"/)
})
