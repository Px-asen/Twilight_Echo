import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { computed, markRaw, ref } from 'vue'
import ts from 'typescript'
import {
  UNKNOWN_NCM_ALBUM_CLASSIFICATION,
  filterNcmAlbums,
  formatNcmAlbumClassification,
  getNcmAlbumFilterOptions
} from './ncmAlbumClassification.ts'

const albums = [
  { id: 1, name: 'Second Nature', trackCount: 12, releaseType: '专辑' },
  { id: 2, name: 'Live EP', artist: 'Artist', trackCount: 4, releaseType: 'EP', isExplicit: true },
  { id: 3, name: 'Remix EP', trackCount: 5, releaseType: 'EP' },
  { id: 4, name: 'LONG SEASON', trackCount: 1, releaseType: 'Single' },
  { id: 5, name: 'Legacy release', trackCount: 3, releaseType: 'EP/Single' },
  { id: 6, name: 'Unlabelled EP', trackCount: 4 },
  { id: 7, name: 'New metadata', trackCount: 8, releaseType: 'Mixtape' }
]

test('release filters retain legacy, unknown, and new upstream values', () => {
  assert.equal(filterNcmAlbums(albums, ''), albums)
  assert.deepEqual(
    filterNcmAlbums(albums, 'EP').map((album) => album.id),
    [2, 3]
  )
  assert.deepEqual(
    filterNcmAlbums(albums, 'Single').map((album) => album.id),
    [4]
  )
  assert.deepEqual(filterNcmAlbums(albums, 'Compilation'), [])
  assert.deepEqual(
    filterNcmAlbums(albums, 'EP/Single').map((album) => album.id),
    [5]
  )
  assert.deepEqual(
    filterNcmAlbums(albums, UNKNOWN_NCM_ALBUM_CLASSIFICATION).map((album) => album.id),
    [6]
  )
  assert.deepEqual(
    filterNcmAlbums(albums, 'Mixtape').map((album) => album.id),
    [7]
  )
})

test('filter options come from actual metadata and labels do not reclassify named works', () => {
  const types = getNcmAlbumFilterOptions(albums)
  assert.deepEqual(
    types.find((option) => option.value === 'EP'),
    {
      value: 'EP',
      label: 'EP',
      count: 2
    }
  )
  assert.equal(types.find((option) => option.value === 'Single')?.label, '单曲')
  assert.equal(types.find((option) => option.value === 'EP/Single')?.label, 'EP / 单曲')
  assert.equal(types.at(-1)?.value, UNKNOWN_NCM_ALBUM_CLASSIFICATION)
  assert.equal(
    types.some((option) => option.value === 'LP'),
    false
  )
  assert.equal(types.find((option) => option.value === 'Mixtape')?.count, 1)
  assert.equal(formatNcmAlbumClassification(albums[0]), '专辑')
  assert.equal(formatNcmAlbumClassification(albums[3]), '单曲')
  assert.equal(formatNcmAlbumClassification(albums[5]), '')
  assert.deepEqual(getNcmAlbumFilterOptions([]), [])
})

const source = readFileSync(new URL('../StreamingPage.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true)
const selectedVariables = new Set([
  'currentArtistAlbums',
  'showNcmAlbumFilters',
  'filteredArtistAlbums',
  'socialCollections',
  'detailHeaderInfo'
])
const selectedFunctions = new Set(['clearDetailState', 'captureDetailState', 'applyDetailState'])
const statements = ast.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) && selectedFunctions.has(node.name?.text ?? '')) ||
    (ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        selectedVariables.has(declaration.name.getText(ast))
      ))
)
const pageCode = ts.transpileModule(statements.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

function artistPage() {
  const bindings = {
    computed,
    markRaw,
    filterNcmAlbums,
    formatNcmAlbumClassification,
    NCM_PROVIDER_ID: 'ncm',
    providerStore: {
      getProvider: (id: string) => ({ name: id === 'ncm' ? '网易云' : 'QQ音乐' })
    },
    activeProvider: ref('ncm'),
    currentDetail: ref<Record<string, unknown>>({
      type: 'artist',
      artist: { id: 1, name: 'Artist' }
    }),
    activeArtistTab: ref('albums'),
    artistAlbumReleaseType: ref('EP'),
    artistAlbums: ref(albums),
    artistPlaylists: ref([]),
    artistIntro: ref(''),
    artistFollowed: ref(null),
    detailTracks: ref([]),
    detailUsers: ref([]),
    detailLoading: ref(false),
    detailError: ref(''),
    followActionLoading: ref(false),
    followActionError: ref(''),
    likedCount: ref(null),
    likedTracksNextOffset: ref(0),
    likedTracksTotal: ref(null),
    likedTracksHasMore: ref(false),
    playlistTrackPaging: { snapshot: () => undefined, restore: () => {} },
    resetLikedTracksPaging: () => {}
  }
  const page = runInNewContext(
    `${pageCode}\n({ showNcmAlbumFilters, socialCollections, detailHeaderInfo, clearDetailState, captureDetailState, applyDetailState })`,
    bindings
  )
  return { ...bindings, page }
}

test('artist albums preserve the release filter on back navigation and show labels in album details', () => {
  const f = artistPage()
  assert.equal(f.page.showNcmAlbumFilters.value, true)
  assert.equal(f.page.socialCollections.value.length, 2)
  assert.equal(f.page.socialCollections.value[0].id, 2)
  assert.equal(f.page.socialCollections.value[0].meta, 'EP · 4 首')
  assert.equal(f.page.socialCollections.value[0].isExplicit, true)
  assert.equal(f.page.socialCollections.value[1].isExplicit, undefined)

  const snapshot = f.page.captureDetailState()
  f.page.clearDetailState()
  assert.equal(f.artistAlbumReleaseType.value, '')
  f.currentDetail.value = { type: 'album', album: albums[1], providerId: 'ncm' }
  assert.equal(f.page.detailHeaderInfo.value.desc, 'Artist · 网易云 · EP · 共 4 首歌曲')
  assert.equal(f.page.detailHeaderInfo.value.isExplicit, true)
  f.currentDetail.value = { type: 'artist', artist: { id: 1, name: 'Artist' } }
  f.page.applyDetailState(snapshot)
  assert.equal(f.artistAlbumReleaseType.value, 'EP')
  assert.equal(f.page.socialCollections.value[0].id, 2)
  assert.equal(f.page.socialCollections.value[0].isExplicit, true)
})

test('external artists, playlists, and album details keep their existing presentation', () => {
  const f = artistPage()
  f.activeArtistTab.value = 'playlists'
  assert.equal(f.page.showNcmAlbumFilters.value, false)
  f.activeArtistTab.value = 'albums'
  f.activeProvider.value = 'qq'
  assert.equal(f.page.showNcmAlbumFilters.value, false)
  assert.equal(f.page.socialCollections.value.length, albums.length)
  assert.ok(f.page.socialCollections.value.every((album: { meta?: string }) => album.meta == null))
  assert.ok(
    f.page.socialCollections.value.every(
      (album: { isExplicit?: boolean }) => album.isExplicit == null
    )
  )
  f.currentDetail.value = { type: 'album', album: albums[1], providerId: 'qq' }
  assert.equal(f.page.detailHeaderInfo.value.desc, 'Artist · QQ音乐 · 共 4 首歌曲')
  assert.equal(f.page.detailHeaderInfo.value.isExplicit, undefined)
})

test('album metadata follows the detail provider when opened from a different search source', () => {
  const f = artistPage()
  f.activeProvider.value = 'qq'
  f.currentDetail.value = { type: 'album', album: albums[1], providerId: 'ncm' }
  assert.equal(f.page.detailHeaderInfo.value.desc, 'Artist · 网易云 · EP · 共 4 首歌曲')
  assert.equal(f.page.detailHeaderInfo.value.isExplicit, true)

  f.activeProvider.value = 'ncm'
  f.currentDetail.value = { type: 'album', album: albums[1], providerId: 'local' }
  assert.equal(f.page.detailHeaderInfo.value.desc, 'Artist · 本地音乐 · 共 4 首歌曲')
  assert.equal(f.page.detailHeaderInfo.value.isExplicit, undefined)
})
