import { createApp, h, nextTick, ref } from 'vue'
import '../assets/base.css'
import AppNoticeHost from './AppNoticeHost.vue'
import PersonalBackupSection from './settings-page/PersonalBackupSection.vue'
import { createInitialAppUpdateSnapshot } from '../../../shared/appUpdate'
import { useDownloadTasks } from '../stores/useDownloadTasks'
import { applyPersonalRendererRestore } from '../app/personalRestore'
import { ListeningStatsDatabase } from '../stores/listeningStatsDatabase'
const durableStatistics = async () => {
  const database = new ListeningStatsDatabase(indexedDB)
  try {
    return await database.load()
  } finally {
    await database.close()
  }
}

const expect = (v, message) => {
  if (!v) throw new Error(message)
}
const settle = async () => {
  await nextTick()
  await new Promise((r) => setTimeout(r, 40))
}
let app
async function mount(component) {
  app?.unmount()
  app = createApp({ render: () => h(component) })
  app.mount('#app')
  await settle()
}
const button = (text) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
async function click(text) {
  const b = button(text)
  expect(b, `missing button ${text}`)
  b.click()
  await settle()
}
let resolveList,
  connects = 0,
  stopped = 0,
  scanned = 0,
  cancelled = 0,
  action = '',
  played = '',
  staged
let downloadSnapshot = {
    protocolVersion: 1,
    epoch: 'ux-downloads',
    sequence: 0,
    phase: 'ready',
    migrationRequired: false,
    downloads: { revision: 1, active: 1, total: 2 }
  },
  coreMessage,
  downloadPageItems,
  downloadPageRequests = 0
const completed = {
  id: 'done',
  providerId: 'test',
  track: { id: 'song', title: '已下载歌曲', artist: '歌手' },
  status: 'completed',
  progress: 1,
  requestedQuality: 'lossless',
  actualQuality: 'lossless',
  fileSize: 123,
  createdAt: '2026-10-03',
  updatedAt: '2026-10-03',
  error: null
}
const pending = {
  ...completed,
  id: 'pending',
  status: 'downloading',
  track: { ...completed.track, title: '正在下载' },
  progress: 0.5
}
downloadPageItems = [completed, pending]
const scan = ref({ state: 'running', current: 2, total: 10, error: '' })
window.__uxMusic = {
  tracks: ref([]),
  libraryScanStatus: scan,
  libraryMetadataEnrichmentStatus: ref({ state: 'idle' }),
  cancelLibraryScan: async () => {
    cancelled++
    scan.value = { ...scan.value, state: 'cancelled' }
  },
  pauseLibraryScan: async () => {
    scanned++
    scan.value = { ...scan.value, state: 'paused' }
  },
  resumeLibraryScan: async () => {
    scan.value = { ...scan.value, state: 'running' }
  },
  startFullLibraryScan: async () => {},
  flushSaveLibrary: async () => {},
  flushPlaylists: async () => true
}
window.__uxPlayer = {
  playTrack: async (track) => {
    played = track.filePath
  },
  queueWorkspace: { flush: async () => {} }
}
let restoreRequest = null,
  acknowledged = ''
window.api = {
  core: {
    connect: async () => {
      connects++
      return { ok: true, value: { connectionId: 'ux', snapshot: structuredClone(downloadSnapshot) } }
    },
    request: async (_connectionId, request) => {
      if (request.kind === 'query' && request.name === 'downloads.page') {
        downloadPageRequests++
        const revision = downloadSnapshot.downloads.revision
        if (downloadPageRequests === 1)
          return new Promise((resolve) => {
            resolveList = () =>
              resolve({ ok: true, value: { ...downloadSnapshot.downloads, revision: 1, offset: 0, items: [] } })
          })
        return {
          ok: true,
          value: {
            ...downloadSnapshot.downloads,
            revision,
            offset: 0,
            items: downloadPageItems
          }
        }
      }
      if (request.kind === 'query' && request.name === 'downloads.indexed')
        return { ok: true, value: { indexed: false } }
      if (request.kind === 'command') {
        if (request.name === 'backup.preview')
          return {
            ok: true,
            value: {
              id: 'ux-backup-preview',
              version: 1,
              createdAt: '2026-10-03T00:00:00.000Z',
              rows: [
                { domain: 'playlists', incoming: 3, current: 2, conflicts: 1 },
                { domain: 'library', incoming: 5, current: 0, conflicts: 0 }
              ],
              roots: ['C:/Old']
            }
          }
        if (request.name === 'backup.chooseFolder') return { ok: true, value: 'D:/Music' }
        if (request.name === 'backup.stage') {
          staged = request.payload
          return { ok: true, value: undefined }
        }
        if (request.name === 'backup.export') return { ok: true, value: '/backup.zip' }
        if (request.name === 'downloads.cancel') {
          expect(request.payload.id === 'pending', 'wrong cancel target')
          cancelled++
        }
        if (request.name === 'downloads.play') played = request.payload.id
        if (request.name === 'downloads.reveal') action = 'reveal'
        if (request.name === 'downloads.result') action = request.payload.addToLibrary ? 'add' : 'read'
        return { ok: true, value: undefined }
      }
      throw new Error(`Unexpected Core request ${request.name}`)
  },
    cancel: async () => ({ ok: true, value: undefined }),
    disconnect: async () => ({ ok: true, value: undefined }),
    onMessage: (callback) => {
      coreMessage = callback
      return () => {
        stopped++
      }
    },
    onStatus: () => () => {}
  },
  app: {
    onUpdateState: () => () => {},
    getUpdateState: async () => createInitialAppUpdateSnapshot(),
    relaunch: async () => {}
  },
  shell: {
    showItemInFolder: async (path) => {
      action = path
    }
  },
  data: {
    previewPersonalBackup: async () => ({
      version: 1,
      createdAt: '2026-10-03T00:00:00.000Z',
      rows: [
        { domain: 'playlists', incoming: 3, current: 2, conflicts: 1 },
        { domain: 'library', incoming: 5, current: 0, conflicts: 0 }
      ],
      roots: ['C:/Old']
    }),
    chooseRestoreFolder: async () => 'D:/Music',
    stagePersonalRestore: async (options) => {
      staged = options
    },
    exportPersonalBackup: async () => true,
    readRendererRestore: async () => restoreRequest,
    acknowledgeRendererRestore: async (id) => {
      acknowledged = id
    }
  }
}
window.runUxFeatureTests = async () => {
  await mount({
    setup() {
      const host = ref(null)
      return () =>
        h('div', [
          h(
            'button',
            { class: 'task-entry', onClick: (event) => host.value.toggleHistory(event) },
            '任务与通知'
          ),
          h(AppNoticeHost, { ref: host })
        ])
    }
  })
  const second = useDownloadTasks().connect()
  expect(connects === 1, 'download subscription must be shared')
  await settle()
  downloadPageItems = [completed, pending]
  downloadSnapshot = {
    ...downloadSnapshot,
    sequence: 1,
    downloads: { revision: 2, active: 1, total: 2 }
  }
  coreMessage({
    connectionId: 'ux',
    message: {
      kind: 'state',
      epoch: downloadSnapshot.epoch,
      sequence: downloadSnapshot.sequence,
      snapshot: structuredClone(downloadSnapshot)
    }
  })
  resolveList([])
  await settle()
  expect(useDownloadTasks().tasks.value.length === 2, 'slow initial response overwrote new events')
  document.querySelector('.task-entry').focus()
  document.querySelector('.task-entry').click()
  await settle()
  expect(
    document.body.textContent.includes('已下载歌曲'),
    'global center omitted completed download'
  )
  await window.captureFeature('task-center')
  await click('暂停')
  expect(scanned === 1 && button('继续'), 'pause should route to scan service')
  await click('继续')
  await click('取消')
  expect(cancelled === 1, 'scan cancellation was not routed')
  await click('播放本地文件')
  expect(played === completed.id, 'play did not use the Core download task ID')
  await click('打开目录')
  expect(action === 'reveal', 'reveal did not use the Core download task ID')
  await click('加入曲库（复制）')
  expect(action === 'add', 'library action did not request indexing')
  downloadSnapshot = { ...downloadSnapshot, sequence: downloadSnapshot.sequence + 1, libraryLoudness: {
    status: {
      revision: 2,
      state: 'running',
      jobId: 'loudness',
      processed: 1,
      total: 3,
      failed: 0,
      currentTitle: '分析歌曲'
    }
  }}
  coreMessage({connectionId:'ux',message:{kind:'state',epoch:downloadSnapshot.epoch,sequence:downloadSnapshot.sequence,snapshot:structuredClone(downloadSnapshot)}})
  await settle()
  expect(
    document.body.textContent.includes('响度分析'),
    'loudness task missing'
  )
  await click('需处理')
  expect(
    !document.querySelector('.notice-history progress') &&
      !document.body.textContent.includes('响度分析') &&
      button('需处理').getAttribute('aria-pressed') === 'true',
    'attention filter retained active tasks'
  )
  await window.pressKey('Escape')
  await settle()
  expect(
    getComputedStyle(document.querySelector('.notice-history')).display === 'none' &&
      document.activeElement.matches('.task-entry'),
    'task center Escape/focus restoration broken'
  )
  second()
  await mount(PersonalBackupSection)
  expect(stopped === 0, 'download view disposed the window-wide Core connection')
  await click('选择备份并预览')
  expect(
    document.body.textContent.includes('歌单与收藏'),
    'backup count preview missing'
  )
  await window.captureFeature('personal-backup-preview')
  await click('选择此目录在本机的位置')
  const select = document.querySelector('.restore-dialog select')
  select.value = 'use-backup'
  select.dispatchEvent(new Event('change'))
  await settle()
  await click('确认，在下次启动时恢复')
  expect(
    staged.id === 'ux-backup-preview' &&
      staged.options.conflict === 'use-backup' &&
      staged.options.mappings[0].to === 'D:/Music' &&
      staged.options.domains.length === 2,
    'restore options not sent accurately'
  )
  expect(
    !document.querySelector('.restore-dialog') && button('现在重启恢复'),
    'staged restoration status missing'
  )
  localStorage.clear()
  restoreRequest = {
    id: 'migration',
    conflict: 'keep-local',
    data: { statistics: { days: { today: 5 }, tracks: {} } }
  }
  await applyPersonalRendererRestore()
  expect(
    acknowledged === 'migration' && (await durableStatistics()).days.today === 5,
    'renderer statistics restore failed'
  )
  await applyPersonalRendererRestore()
  expect((await durableStatistics()).days.today === 5, 'repeat restore double-counted statistics')
  restoreRequest = {
    id: 'quota-failure',
    conflict: 'use-backup',
    data: {
      statistics: { days: { today: 99 }, tracks: {} },
      versions: {
        version: 1,
        tracks: { versions: [], families: [] },
        albums: { versions: [], families: [] }
      }
    }
  }
  acknowledged = ''
  const setItem = Storage.prototype.setItem
  let fail = true
  Storage.prototype.setItem = function (key, value) {
    if (fail && key === 'twilight.music-versions.v1') {
      fail = false
      throw new DOMException('quota', 'QuotaExceededError')
    }
    return setItem.call(this, key, value)
  }
  let rejected = false
  try {
    await applyPersonalRendererRestore()
  } catch {
    rejected = true
  } finally {
    Storage.prototype.setItem = setItem
  }
  expect(
    rejected && !acknowledged && (await durableStatistics()).days.today === 5,
    'partial localStorage write did not roll back or was acknowledged'
  )
  await applyPersonalRendererRestore()
  expect(
    acknowledged === 'quota-failure' && (await durableStatistics()).days.today === 99,
    'restore failed to retry after quota recovery'
  )
  app.unmount()
  return 'UX_FEATURES_OK'
}
