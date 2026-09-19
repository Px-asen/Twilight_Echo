import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

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
  assert.match(source, /媒体库管理/)
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
  assert.match(source, /playlistSourceSummaryLabel\(playlist\)/)
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
  assert.match(source, /加入收藏/)
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
    'class="playlist-lifecycle-actions"'
  ]) {
    const index = tableHeader.indexOf(marker)
    assert.ok(index > 0, `${marker} missing from library header`)
    assert.ok(index < searchIndex, `${marker} should precede the search box`)
  }
})

test('library playback controls render below the table header', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

  assert.doesNotMatch(source, /class="header-play-actions"/)
  const tableHeaderStart = source.lastIndexOf('<div class="song-list-header">')
  const playActionsIndex = source.indexOf('class="library-play-actions"', tableHeaderStart)
  const tableHeaderEnd = source.indexOf(
    '</div>\n          <div class="library-play-actions"',
    tableHeaderStart
  )

  assert.ok(tableHeaderStart > 0)
  assert.ok(tableHeaderEnd > tableHeaderStart)
  assert.ok(playActionsIndex > tableHeaderEnd)
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
    table.indexOf('<tr\n                  v-for='),
    table.indexOf('</tr>', table.indexOf('<tr\n                  v-for='))
  )

  assert.ok(header.indexOf('class="col-index"') < header.indexOf('class="col-cover-header"'))
  assert.ok(row.indexOf('class="col-index"') < row.indexOf('class="col-cover"'))
  assert.match(source, /const isAlbumDetail = computed\(/)
  assert.match(source, /isAlbumDetail\.value[\s\S]*track\.trackNumber/)
  assert.match(source, /return visibleRange\.value\.start \+ visibleIndex \+ 1/)
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
  assert.match(source, /gridWindowStart \+ index/)
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

test('selected tracks append as one queue command without starting playback', () => {
  const source = readFileSync(new URL('./SongList.vue', import.meta.url), 'utf8')
  const body = source.match(
    /function appendActionTracksToQueue\(actionTracks: Track\[\]\): void \{([\s\S]*?)\n\}/
  )?.[1]
  assert.ok(body)
  const batches: unknown[] = []
  const message = { value: '' }
  let cleared = 0
  let closed = 0
  const append = new Function(
    'actionTracks',
    'playbackStore',
    'repairMessage',
    'clearSelection',
    'closeContextMenu',
    body
  )
  const tracks = [{ id: 'local:2' }, { id: 'ncm:1' }]
  const store = { appendQueueTracks: (items: unknown) => batches.push(items) }
  append(
    tracks,
    store,
    message,
    () => cleared++,
    () => closed++
  )
  assert.deepEqual(batches, [tracks])
  assert.equal(cleared, 1)
  assert.equal(closed, 1)
  assert.equal(message.value, '已添加 2 首到播放队列')
  append(
    [],
    store,
    message,
    () => cleared++,
    () => closed++
  )
  assert.equal(batches.length, 1)
  assert.match(source, /@click="appendActionTracksToQueue\(contextActionTracks\)"/)
  assert.match(source, /@click="appendActionTracksToQueue\(selectionActionTracks\)"/)
})
