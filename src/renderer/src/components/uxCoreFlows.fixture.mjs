import { createApp, h, nextTick, ref } from 'vue'
import StreamingSearch from './StreamingSearch.vue'
import RadioPodcastPage from './RadioPodcastPage.vue'
import ProviderDownloadsPanel from './streaming-page/ProviderDownloadsPanel.vue'
import AppNoticeHost from './AppNoticeHost.vue'
import ImportDialog from './ImportDialog.vue'
import { usePodcastStore } from '../stores/usePodcastStore'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'

const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}
const copy = (value) => JSON.parse(JSON.stringify(value))
const settle = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 40))
}
let app
async function mount(component, props) {
  app?.unmount()
  app = createApp({ render: () => h(component, props()) })
  app.mount('#app')
  await settle()
}
const findButton = (label, root = document) =>
  [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === label)
const makeSubscription = (id, progress = 900) => ({
  id,
  feedUrl: `https://example.test/${id}`,
  title: id,
  createdAt: '2026-10-03',
  updatedAt: '2026-10-03',
  episodes: [
    {
      guid: 'episode',
      title: 'Episode',
      mediaUrl: 'https://example.test/audio.mp3',
      durationSeconds: 1800,
      progressSeconds: progress
    }
  ]
})
let doc = { schemaVersion: 1, subscriptions: [makeSubscription('original')] }
let revision = 1
let failSave = false
let conflictSave = false
let failLoad = false
let saves = 0
let radioDoc = { schemaVersion: 1, stations: [] }
let radioRevision = 1
let failRadioSave = false
let pendingRadioSave
const requests = new Map()
window.api = {
  radio: {
    loadStations: async () => ({ data: copy(radioDoc), revision: radioRevision }),
    saveStations: async (next, expectedRevision) => {
      if (pendingRadioSave) await pendingRadioSave
      if (failRadioSave) throw new Error('电台保存失败')
      expect(expectedRevision === radioRevision, 'radio revision mismatch')
      radioDoc = copy(next)
      return { data: copy(radioDoc), revision: ++radioRevision }
    },
    importPlaylist: async () => copy(radioDoc.stations),
    searchDirectory: ({ query }) =>
      new Promise((resolve, reject) => requests.set(query, { resolve, reject }))
  },
  podcast: {
    refreshAll: async () => {
      throw new Error('播客刷新失败')
    },
    loadSubscriptions: async () => {
      if (failLoad) throw new Error('read failed')
      return { data: copy(doc), revision }
    },
    saveSubscriptions: async (next, expectedRevision) => {
      saves++
      if (failSave) {
        failSave = false
        throw new Error('write failed')
      }
      if (conflictSave) {
        conflictSave = false
        doc.subscriptions.push(makeSubscription('concurrent'))
        revision++
      }
      if (expectedRevision !== revision)
        throw {
          code: 'ERR_PERSISTENCE_REVISION_CONFLICT',
          message: '数据已变化',
          current: { data: copy(doc), revision }
        }
      doc = copy(next)
      revision++
      return { data: copy(doc), revision }
    }
  }
}

window.runUxCoreTests = async () => {
  const importMotion = document.createElement('style')
  importMotion.textContent =
    '.modal-overlay,.import-dialog{transition:none!important;animation:none!important}'
  document.head.append(importMotion)
  const showImport = ref(true)
  const imported = ['existing-A', 'existing-B']
  const selectedFolder = 'C:/new'
  let scanFailure = false
  let failedFolder = null
  let importSaves = 0
  let importRebuilds = 0
  window.auditMusic = {
    scannedFolders: ref(['C:/A', 'C:/B']),
    isScanning: ref(false),
    addFolder: (folder) => {
      const roots = window.auditMusic.scannedFolders.value
      if (!roots.includes(folder)) roots.push(folder)
    },
    addTracks: async (tracks) => imported.push(...tracks.map((track) => track.id)),
    saveLibrary: async () => importSaves++,
    refreshLibraryIndex: () => importRebuilds++,
    syncFolders: () => {
      throw new Error('Import must never prune unselected roots')
    }
  }
  window.api.dialog = { openFolder: async () => selectedFolder }
  window.api.fs = {
    onScanProgress: () => () => {},
    scanMusicFiles: async (folder) => {
      if (scanFailure || folder === failedFolder) throw new Error('Folder unavailable')
      return [{ id: `imported:${folder}` }]
    }
  }
  const importOpener = document.querySelector('#opener')
  importOpener.focus()
  await mount(ImportDialog, () => ({
    show: showImport.value,
    onClose: () => (showImport.value = false)
  }))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const importDialog = document.querySelector('[role="dialog"]')
  expect(importDialog.contains(document.activeElement), 'import dialog did not receive focus')
  const importLast = findButton('扫描所选文件夹')
  importLast.focus()
  await window.pressKey('Tab')
  expect(importDialog.contains(document.activeElement), 'Tab escaped import dialog')
  await window.pressKey('Escape')
  await settle()
  expect(
    !showImport.value && document.activeElement === importOpener,
    'Escape did not close and restore focus'
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  showImport.value = true
  await settle()
  findButton('添加文件夹').click()
  await settle()
  expect(
    !window.auditMusic.scannedFolders.value.includes('C:/new'),
    'choosing a folder persisted before scanning'
  )
  document.querySelector('[aria-label="关闭导入窗口"]').click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  showImport.value = true
  await settle()
  expect(
    document.querySelectorAll('.folder-item').length === 2,
    'cancelled folder draft survived reopening'
  )
  const checks = [...document.querySelectorAll('.folder-item input')]
  checks[0].click()
  findButton('扫描所选文件夹').click()
  await new Promise((resolve) => setTimeout(resolve, 120))
  await settle()
  expect(
    imported.join('|') === 'existing-A|existing-B|imported:C:/B',
    'unselected tracks removed or selected root skipped'
  )
  expect(
    window.auditMusic.scannedFolders.value.join('|') === 'C:/A|C:/B',
    'unselected root removed'
  )
  expect(
    importSaves > 0 && importRebuilds > 0 && !showImport.value,
    'successful import did not save and close'
  )
  await new Promise((resolve) => setTimeout(resolve, 250))
  showImport.value = true
  scanFailure = true
  await settle()
  findButton('扫描所选文件夹').click()
  await settle()
  expect(
    document.querySelector('[role="alert"]')?.textContent.includes('Folder unavailable'),
    'scan error hidden'
  )
  expect(
    !window.auditMusic.isScanning.value && showImport.value,
    'failed scan left busy state or closed'
  )
  scanFailure = false
  findButton('扫描所选文件夹').click()
  await new Promise((resolve) => setTimeout(resolve, 180))
  await settle()
  expect(!showImport.value, 'failed import could not retry')
  await new Promise((resolve) => setTimeout(resolve, 250))
  showImport.value = true
  failedFolder = 'C:/B'
  const savesBeforePartial = importSaves
  await settle()
  findButton('扫描所选文件夹').click()
  await new Promise((resolve) => setTimeout(resolve, 120))
  await settle()
  expect(
    showImport.value && importSaves > savesBeforePartial,
    'completed folder batches were not saved after a later failure'
  )
  expect(imported.includes('imported:C:/A'), 'completed folder batches were lost')
  importMotion.remove()

  const offset = ref(0),
    total = ref(31),
    type = ref('playlists'),
    loading = ref(false)
  let opened = 0,
    activated = 0,
    liked = 0,
    rowClicks = 0
  const artistRequests = []
  const albumRequests = []
  const activationMode = ref('doubleClick')
  const tracks = Array.from({ length: 61 }, (_, index) => ({
    id: String(index),
    title: `Song ${index}`,
    artist: 'Artist',
    artists: [
      { id: 101, name: 'Artist' },
      { id: 202, name: 'Guest Artist' }
    ],
    album: 'Album',
    albumId: '303',
    duration: 180
  }))
  const props = () => ({
    searchType: type.value,
    searchResults: tracks.slice(offset.value, Math.min(total.value, offset.value + 30)),
    searchPlaylistsResults: tracks
      .slice(offset.value, Math.min(total.value, offset.value + 30))
      .map((track) => ({ id: track.id, name: track.title, trackCount: 3 })),
    searchArtistsResults: tracks
      .slice(offset.value, Math.min(total.value, offset.value + 30))
      .map((track) => ({ id: track.id, name: track.title })),
    searchTotal: total.value,
    searchOffset: offset.value,
    searchLoading: loading.value,
    searchError: '',
    currentTrack: null,
    trackActivationMode: activationMode.value,
    likingTracks: new Set(),
    isTrackLiked: () => false,
    formatTime: () => '3:00',
    onPageChange: (event) => (offset.value = event.first),
    onOpenPlaylist: () => opened++,
    onOpenArtist: () => opened++,
    canOpenTrackArtist: (track) => track.id !== '1',
    canOpenTrackAlbum: (track) => Boolean(track.albumId),
    onOpenTrackArtist: (track, artist) => artistRequests.push({ track, artist }),
    onOpenTrackAlbum: (track) => albumRequests.push(track),
    onSearchTrackClick: () => rowClicks++,
    onSearchTrackActivate: () => activated++,
    onLikeTrack: () => liked++
  })
  await mount(StreamingSearch, props)
  for (const searchType of ['songs', 'playlists', 'artists']) {
    type.value = searchType
    for (const count of [0, 1, 29, 30, 31, 59, 60, 61]) {
      total.value = count
      offset.value = 0
      await settle()
      const visited = []
      while (findButton('下一页') && !findButton('下一页').disabled) {
        const before = offset.value
        findButton('下一页').click()
        await settle()
        expect(offset.value === before + 30, `${searchType}/${count} repeated or skipped a page`)
        visited.push(offset.value)
      }
      expect(
        offset.value === Math.max(0, Math.ceil(count / 30) - 1) * 30,
        `${searchType}/${count} wrong final offset`
      )
      if (count > 30)
        expect(
          document.querySelector('.pager-text').textContent.replace(/\s/g, '') ===
            `${Math.ceil(count / 30)}/${Math.ceil(count / 30)}`,
          'wrong final page label'
        )
      if (visited.length) {
        findButton('上一页').click()
        await settle()
        expect(offset.value === visited.at(-1) - 30, 'previous page overlap')
      }
    }
  }
  type.value = 'playlists'
  total.value = 31
  offset.value = 0
  await settle()
  offset.value = 30
  loading.value = true
  await settle()
  expect(findButton('下一页').disabled, 'paging while loading')
  loading.value = false
  offset.value = 0
  await settle()
  let card = document.querySelector('.playlist-grid-card')
  card.focus()
  await window.pressKey('Enter')
  expect(opened === 1, 'playlist Enter activation')
  await window.pressKey('Space')
  expect(opened === 2, 'playlist Space activation')
  type.value = 'artists'
  await settle()
  card = document.querySelector('.artist-card')
  card.focus()
  await window.pressKey('Enter')
  expect(opened === 3, 'artist keyboard activation')
  type.value = 'songs'
  await settle()
  const row = document.querySelector('.track-row')
  row.focus()
  await window.pressKey('Enter')
  await window.pressKey('Space')
  expect(activated === 2, 'song activation in double-click mode')
  await window.pressKey('ArrowDown')
  expect(document.activeElement === row.nextElementSibling, 'row arrow navigation')
  row.querySelector('.btn-like').focus()
  await window.pressKey('Space')
  expect(liked === 1 && activated === 2, 'favorite key bubbled into playback')

  for (const mode of ['singleClick', 'doubleClick']) {
    activationMode.value = mode
    await settle()
    const artistLink = row.querySelectorAll('.track-artist button')[1]
    const albumLink = row.querySelector('.col-album button')
    for (const link of [artistLink, albumLink]) {
      link.click()
      link.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      link.focus()
      await window.pressKey('Enter')
      await window.pressKey('Space')
    }
    expect(rowClicks === 0 && activated === 2, `${mode} metadata links triggered playback`)
  }
  expect(
    artistRequests.length === 6 &&
      artistRequests.every(({ track, artist }) => track.id === '0' && artist.id === 202),
    'guest artist link opened the wrong artist or emitted duplicate requests'
  )
  expect(
    albumRequests.length === 6 && albumRequests.every((track) => track.albumId === '303'),
    'album link lost the track album identity'
  )
  expect(
    row.nextElementSibling.querySelectorAll('.track-artist button').length === 0 &&
      row.nextElementSibling.querySelector('.track-artist').textContent.includes('Guest Artist'),
    'unsupported artist links must remain readable text'
  )
  delete tracks[0].artists
  delete tracks[0].albumId
  await mount(StreamingSearch, props)
  const legacyRow = document.querySelector('.track-row')
  legacyRow.querySelector('.track-artist button').click()
  expect(artistRequests.at(-1).artist === undefined, 'legacy artist lookup must use the track name')
  expect(
    !legacyRow.querySelector('.col-album button') &&
      legacyRow.querySelector('.col-album').textContent.trim() === 'Album',
    'missing album IDs must remain readable text'
  )

  const show = ref(true)
  const opener = document.querySelector('#opener')
  opener.focus()
  await mount(ProviderDownloadsPanel, () => ({
    show: show.value,
    tasks: [
      { id: 'download', status: 'failed', progress: 0, track: { title: 'Track', artist: 'Artist' } }
    ],
    onClose: () => (show.value = false)
  }))
  const dialog = document.querySelector('[role=dialog]')
  expect(dialog.contains(document.activeElement), 'download initial focus escaped')
  const buttons = dialog.querySelectorAll('button')
  buttons[buttons.length - 1].focus()
  await window.pressKey('Tab')
  expect(document.activeElement === buttons[0], 'download Tab wrap')
  await window.pressKey('Tab', true)
  expect(document.activeElement === buttons[buttons.length - 1], 'download Shift+Tab wrap')
  await window.pressKey('Escape')
  await settle()
  expect(!show.value && document.activeElement === opener, 'download Escape/focus restore')

  await mount(RadioPodcastPage, () => ({}))
  findButton('添加到我的电台').click()
  await settle()
  expect(
    document.querySelector('[role="alert"]')?.textContent.includes('请填写电台名称和流地址'),
    'empty station form reached IPC'
  )
  findButton('播客').click()
  await settle()
  expect(!document.querySelector('[role="alert"]'), 'station error leaked into podcast tab')
  findButton('订阅').click()
  await settle()
  expect(
    document.querySelector('[role="alert"]')?.textContent.includes('请输入 RSS 或 Atom'),
    'empty feed reached IPC'
  )
  findButton('电台').click()
  await settle()
  const search = async (query) => {
    const input = document.querySelector('.inline-search input')
    input.value = query
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    await window.pressKey('Enter')
  }
  const station = (name) => [
    { stationuuid: name, name, urlResolved: 'https://example.test/stream', tags: [] }
  ]
  await search('old')
  await search('new')
  requests.get('new').resolve(station('new result'))
  await settle()
  requests.get('old').resolve(station('old result'))
  await settle()
  expect(
    document.querySelector('.directory-results').textContent.includes('new result'),
    'old radio result overwrote current'
  )
  await search('old-error')
  await search('new-success')
  requests.get('new-success').resolve(station('success'))
  await settle()
  requests.get('old-error').reject(new Error('stale error'))
  await settle()
  expect(!document.body.textContent.includes('stale error'), 'stale radio error surfaced')
  await search('clear')
  const input = document.querySelector('.inline-search input')
  input.value = ''
  input.dispatchEvent(new Event('input', { bubbles: true }))
  requests.get('clear').resolve(station('cleared result'))
  await settle()
  expect(!document.querySelector('.directory-results'), 'cleared radio query returned')
  await search('leave')
  findButton('播客').click()
  await settle()
  requests.get('leave').resolve(station('left result'))
  await settle()
  findButton('电台').click()
  await settle()
  expect(!document.body.textContent.includes('left result'), 'hidden radio request committed')
  await search('pagehide')
  window.dispatchEvent(new Event('pagehide'))
  requests.get('pagehide').resolve(station('pagehide result'))
  await settle()
  expect(!document.body.textContent.includes('pagehide result'), 'pagehide request committed')

  const setInput = (selector, value) => {
    const input = document.querySelector(selector)
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  setInput('.radio-tools input[type="text"]', 'Test station')
  setInput('.radio-tools input[type="url"]', 'https://example.test/radio')
  findButton('添加到我的电台').click()
  await settle()
  expect(radioDoc.stations.length === 1, 'radio addition was not saved')
  setInput('.radio-tools textarea', '#EXTM3U\nhttps://example.test/radio')
  await settle()
  findButton('导入列表').click()
  await settle()
  expect(
    document.querySelector('[role="alert"]')?.textContent.includes('没有新增电台'),
    'duplicate import claimed new stations'
  )
  failRadioSave = true
  findButton('删除').click()
  await settle()
  expect(
    document.querySelector('[role="alert"]')?.textContent.includes('电台保存失败'),
    'radio delete failure stayed invisible'
  )
  expect(
    document.querySelector('.station-card') && !findButton('删除').disabled,
    'failed delete lost station or retry'
  )
  let rejectSave
  pendingRadioSave = new Promise((_resolve, reject) => {
    rejectSave = reject
  })
  findButton('删除').click()
  await settle()
  expect(findButton('删除').disabled, 'pending delete remained clickable')
  findButton('播客').click()
  await settle()
  rejectSave(new Error('延迟的电台错误'))
  await settle()
  expect(!document.querySelector('[role="alert"]'), 'late radio failure leaked into podcast tab')
  pendingRadioSave = null
  failRadioSave = false
  findButton('刷新全部').click()
  await settle()
  expect(
    document.querySelector('[role="alert"]')?.textContent.includes('播客刷新失败'),
    'refresh-all failure escaped form handling'
  )
  findButton('电台').click()
  await settle()
  findButton('删除').click()
  await settle()
  expect(
    radioDoc.stations.length === 0 && !document.querySelector('.station-card'),
    'radio delete retry failed'
  )

  findButton('播客').click()
  await settle()
  document.querySelector('.subscription-open').focus()
  await window.pressKey('Enter')
  await settle()
  expect(document.querySelector('.episode-panel'), 'podcast keyboard selection failed')
  useAppNoticeStore().clearNotices()
  findButton('取消订阅').click()
  await settle()
  expect(doc.subscriptions.length === 0, 'unsubscribe did not save')
  doc.subscriptions.push(makeSubscription('added-later', 120))
  revision++
  // The undo action must outlive the originating page, and remain retryable
  // through the real notice host, which consumes actions when clicked.
  await mount(AppNoticeHost, () => ({}))
  failSave = true
  findButton('撤销取消订阅').click()
  await settle()
  expect(findButton('重试恢复'), 'failed undo lost its retry action')
  findButton('重试恢复').click()
  await settle()
  expect(
    doc.subscriptions.find((sub) => sub.id === 'original')?.episodes[0].progressSeconds === 900,
    'undo lost progress'
  )
  expect(
    doc.subscriptions.find((sub) => sub.id === 'added-later')?.episodes[0].progressSeconds === 120,
    'undo replaced newer subscriptions'
  )

  const store = usePodcastStore(),
    snapshot = await store.unsubscribe('original')
  conflictSave = true
  let rejected = false
  try {
    await store.restoreSubscription(snapshot)
  } catch {
    rejected = true
  }
  expect(
    rejected &&
      !doc.subscriptions.some((sub) => sub.id === 'original') &&
      doc.subscriptions.some((sub) => sub.id === 'concurrent'),
    'undo overwrote a conflicting write'
  )
  await store.restoreSubscription(snapshot)
  const before = saves
  rejected = false
  try {
    await store.restoreSubscription(snapshot)
  } catch {
    rejected = true
  }
  expect(rejected && saves === before, 'undo overwrote an existing subscription')
  await store.unsubscribe('original')
  failLoad = true
  rejected = false
  try {
    await store.restoreSubscription(snapshot)
  } catch {
    rejected = true
  }
  expect(
    rejected && !doc.subscriptions.some((sub) => sub.id === 'original'),
    'read failure restored stale data'
  )
  failLoad = false
  useAppNoticeStore().clearNotices()
  app.unmount()
  return 'UX_CORE_OK'
}
