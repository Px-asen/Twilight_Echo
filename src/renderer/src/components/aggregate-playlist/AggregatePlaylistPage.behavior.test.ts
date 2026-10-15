import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

/**
 * 聚合歌单页的真实渲染断言：Vite 编译真正的 SFC（含 scoped CSS），在真实
 * Electron BrowserWindow 里挂载，对真实 DOM 做判定。分组、音源隐藏、置顶、
 * 行内换源和歌单持久化全部走产品代码；只有播放器和设置被替换成探针，好让
 * "换源之后播的是哪一路"变成可断言的事实。
 */

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
// 本文件比 components/ 下的同类测试多嵌套一层目录，所以要往上五级才到仓库根。
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)))

test('real Vue and Electron DOM drive aggregate playlist grouping, filtering and pinning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-aggregate-playlist-'))
  try {
    const entryPath = join(directory, 'aggregate-entry.ts')
    const playerStubPath = join(directory, 'player-stub.ts')
    const bundleDirectory = join(directory, 'bundle')
    const htmlPath = join(directory, 'aggregate.html')
    const runnerPath = join(directory, 'aggregate-runner.cjs')

    await writeFile(entryPath, runtimeEntrySource(), 'utf8')
    await writeFile(playerStubPath, playerStubSource(), 'utf8')

    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      plugins: [
        vue(),
        {
          name: 'twilight-aggregate-store-probes',
          enforce: 'pre',
          resolveId(source: string) {
            // 只把播放出口换成探针；设置 / 音源 / 歌单 store 全用真实实现。
            if (/(?:^|[./])usePlayerStore(?:\.ts)?$/.test(source)) return playerStubPath
            return null
          }
        }
      ],
      resolve: {
        alias: {
          '@renderer': join(workspaceRoot, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        'process.env': '{}'
      },
      build: {
        outDir: bundleDirectory,
        emptyOutDir: true,
        minify: false,
        cssCodeSplit: false,
        lib: {
          entry: entryPath,
          name: 'AggregatePlaylistRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })

    const bundleFiles = await readdir(bundleDirectory)
    const bundleName = bundleFiles.find((name) => name.endsWith('.iife.js'))
    const stylesheetName = bundleFiles.find((name) => name.endsWith('.css'))
    assert.ok(bundleName, 'Vite should bundle the real aggregate playlist SFC')
    assert.ok(stylesheetName, 'Vite should retain the actual page and typography styles')
    await writeFile(htmlPath, runtimeHtml(bundleName, stylesheetName), 'utf8')
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      timeout: 90_000,
      windowsHide: true
    })
    assert.match(stderr, /AGGREGATE_RUNTIME_OK/)
    assert.doesNotMatch(stderr, /AGGREGATE_RUNTIME_FAILED/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

function playerStubSource(): string {
  return `import { ref } from 'vue'

export function usePlayerStore() {
  return {
    currentTrack: ref(null),
    playTrack: (track, queue) => {
      window.__aggregateFixture.playCalls.push({
        id: track.id,
        source: track.source,
        queue: (queue || []).map((item) => item.id)
      })
    }
  }
}
`
}

function runtimeEntrySource(): string {
  const pagePath = join(
    workspaceRoot,
    'src/renderer/src/components/aggregate-playlist/AggregatePlaylistPage.vue'
  ).replaceAll('\\', '/')
  const storePath = join(workspaceRoot, 'src/renderer/src/stores/useMusicStore.ts').replaceAll(
    '\\',
    '/'
  )
  const baseStylePath = join(workspaceRoot, 'src/renderer/src/assets/base.css').replaceAll(
    '\\',
    '/'
  )
  const typographyStylePath = join(
    workspaceRoot,
    'src/renderer/src/assets/typography.css'
  ).replaceAll('\\', '/')

  return `import { createApp, h, nextTick, ref } from 'vue'
import ${JSON.stringify(baseStylePath)}
import ${JSON.stringify(typographyStylePath)}
import AggregatePlaylistPage from ${JSON.stringify(pagePath)}
import { useMusicStore } from ${JSON.stringify(storePath)}
import { goBack } from '@renderer/app/useBackStack.ts'

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

const tick = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

const all = (selector) => Array.from(document.querySelectorAll(selector))
const text = (selector) => (document.querySelector(selector)?.textContent || '').trim()
const click = async (element, label) => {
  expect(element, 'missing control ' + label)
  element.click()
  await tick()
}

const music = useMusicStore()

window.runAggregateRuntime = async () => {
  await music.loadPlaylists()
  // 本地音源只有在本地库里真的有这个文件时才算可用（resolvePlaylistTrack 会把
  // 找不到的本地快照丢掉），所以夹具必须把本地库也装上。
  music.tracks.value = window.__aggregateFixture.localTracks
  music.refreshLibraryIndex()

  const mount = document.createElement('div')
  document.body.appendChild(mount)
  const pageApp = createApp({ render: () => h(AggregatePlaylistPage, { hasPlayer: false, surface: 'local' }) })
  pageApp.mount(
    mount
  )
  await tick()

  // ── 网格：只列聚合歌单，置顶的排在前面 ────────────────────────────────
  const cardNames = () =>
    all('.aggregate-card:not(.aggregate-create-card) .aggregate-card-name').map((node) =>
      node.textContent.trim()
    )
  expect(
    JSON.stringify(cardNames()) === JSON.stringify(['置顶集', '跨源精选']),
    '聚合网格应只含聚合歌单且置顶优先，实际：' + JSON.stringify(cardNames())
  )

  // ── 置顶：后置顶的排到更前面 ──────────────────────────────────────────
  const cardByName = (name) =>
    all('.aggregate-card:not(.aggregate-create-card)').find((card) =>
      card.textContent.includes(name)
    )
  await click(
    cardByName('跨源精选').querySelector('.aggregate-card-actions .aggregate-card-btn'),
    'pin the second playlist'
  )
  expect(
    JSON.stringify(cardNames()) === JSON.stringify(['跨源精选', '置顶集']),
    '最近置顶的应排到最前，实际：' + JSON.stringify(cardNames())
  )

  // ── 进详情：同一首歌的两个音源合并成一行 ──────────────────────────────
  await click(cardByName('跨源精选'), 'open aggregate playlist')
  const rowTitles = () => all('.aggregate-row .aggregate-row-title').map((n) => n.textContent.trim())
  expect(
    JSON.stringify(rowTitles()) === JSON.stringify(['Moon River', 'Only Online']),
    '三条曲目应折叠为两行，实际：' + JSON.stringify(rowTitles())
  )
  expect(text('.aggregate-subtitle').includes('2 首'), '统计文案应报可见行数')

  // 合并那一行默认走本地无损。
  const firstVariantLabel = () => all('.aggregate-variant-btn')[0].textContent.trim()
  expect(firstVariantLabel().includes('本地音乐'), '默认应优先本地无损，实际：' + firstVariantLabel())

  // Keyboard playback is explicit and independent of the pointer activation preference.
  const keyboardRow = all('.aggregate-row')[0]
  document.documentElement.style.setProperty('--te-font-size-body', '14px')
  mount.style.setProperty('--te-font-size-body', '20px')
  await tick(); await tick()
  const rowStride = () => {
    const rows = all('.aggregate-row')
    return rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top
  }
  const titleSize = () => parseFloat(getComputedStyle(keyboardRow.querySelector('.aggregate-row-title')).fontSize)
  expect(keyboardRow.style.height === '98px', 'local preview font controls the virtual row instead of the application theme')
  expect(Math.abs(rowStride() - 98) < 0.1, 'actual adjacent rows use the same 98px stride as the virtual window')
  expect(Math.abs(titleSize() - 20 * 13 / 14) < 0.1, 'local preview typography also scales the rendered title')
  mount.style.removeProperty('--te-font-size-body')
  await tick(); await tick()
  expect(keyboardRow.style.height === '68px', 'removing the local font restores the inherited row scale')
  expect(Math.abs(rowStride() - 68) < 0.1, 'default adjacent rows use the same 68px stride as the virtual window')
  expect(Math.abs(titleSize() - 13) < 0.1, 'removing the local font restores the inherited title size')
  keyboardRow.focus()
  expect(document.activeElement === keyboardRow, 'the actual table row is keyboard focusable')
  const beforeKeyboard = window.__aggregateFixture.playCalls.length
  keyboardRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick()
  expect(window.__aggregateFixture.playCalls.length === beforeKeyboard + 1, 'Enter plays one recording')
  all('.aggregate-variant-btn')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await tick()
  expect(window.__aggregateFixture.playCalls.length === beforeKeyboard + 1, 'nested source control does not also play the row')

  // ── 行内换源：偏好写进歌单，播放队列跟着换 ────────────────────────────
  await click(all('.aggregate-variant-btn')[0], 'open variant menu')
  const optionLabels = all('.aggregate-variant-option').map((node) => node.textContent.trim())
  const ncmOption = all('.aggregate-variant-option').find((node) => node.textContent.includes('ncm'))
  expect(ncmOption, '换源菜单里应有 ncm 选项，实际菜单项：' + JSON.stringify(optionLabels))
  await click(ncmOption, 'choose ncm variant')
  expect(
    all('.aggregate-variant-btn')[0].classList.contains('is-pinned'),
    '显式选过的音源要有钉住样式'
  )

  await click(all('.aggregate-row')[0], 'play first row')
  const lastPlay = window.__aggregateFixture.playCalls.at(-1)
  expect(lastPlay && lastPlay.id === 'ncm:moon', '换源后应播放 ncm 版本，实际：' + JSON.stringify(lastPlay))
  expect(
    JSON.stringify(lastPlay.queue) === JSON.stringify(['ncm:moon', 'ncm:only']),
    '播放队列应按每行当前选定音源展开，实际：' + JSON.stringify(lastPlay.queue)
  )

  // ── 隐藏音源：只剩 ncm 的那行整体消失，合并行回落到本地 ────────────────
  const ncmChip = all('.aggregate-source-chip').find((node) => node.textContent.includes('ncm'))
  await click(ncmChip, 'hide ncm source')
  expect(
    JSON.stringify(rowTitles()) === JSON.stringify(['Moon River']),
    '隐藏 ncm 后只应剩下仍有可见音源的行，实际：' + JSON.stringify(rowTitles())
  )
  expect(
    all('.aggregate-variant-btn')[0].textContent.includes('本地音乐'),
    '被隐藏的偏好音源应回落到最佳可见音源'
  )
  expect(text('.aggregate-subtitle').includes('已隐藏'), '统计文案应说明有歌被隐藏')

  // 最后一个可见音源不允许再隐藏，否则歌单会变成空的。
  const localChip = all('.aggregate-source-chip').find((node) => node.textContent.includes('本地音乐'))
  await click(localChip, 'try hiding the last visible source')
  expect(text('.aggregate-notice').includes('至少要保留'), '应拦下把全部音源隐藏的操作')
  expect(rowTitles().length === 1, '被拦下的隐藏不应改变列表')

  // ── 持久化：置顶 / 隐藏 / 换源都落到了 playlists.json ──────────────────
  await music.flushPlaylists()
  const saved = window.__aggregateFixture.authoritative.find((item) => item.id === 'pl-aggregate')
  expect(saved && saved.kind === 'aggregate', '聚合标记应持久化')
  expect(JSON.stringify(saved.hiddenSources) === JSON.stringify(['ncm']), '隐藏音源应持久化')
  expect(
    saved.variantPreferences && saved.variantPreferences['local:moon'] === 'ncm',
    '行内音源偏好应持久化，实际：' + JSON.stringify(saved.variantPreferences)
  )
  expect(saved.pinnedAt, '本次新置顶的时间戳应持久化')
  const pinnedSaved = window.__aggregateFixture.authoritative.find((item) => item.id === 'pl-pinned')
  expect(pinnedSaved && pinnedSaved.pinnedAt, '既有的置顶时间戳不应被这次写入抹掉')

  expect(goBack(), '标题栏应能返回聚合歌单网格')
  await tick()
  expect(all('.aggregate-card:not(.aggregate-create-card)').length === 2, '返回应恢复聚合歌单网格')
  pageApp.unmount()
  const selectedId = ref(null)
  const navigationCalls = []
  let backCalls = 0
  const controlledApp = createApp({ render: () => h(AggregatePlaylistPage, {
    hasPlayer: false, surface: 'local', initialPlaylistId: selectedId.value,
    navigatePlaylist: id => {navigationCalls.push(id);selectedId.value=id},
    returnFromDetail: () => {backCalls++;selectedId.value=null}
  }) })
  controlledApp.mount(mount);await tick()
  await click(all('.aggregate-card:not(.aggregate-create-card)').find(node=>node.textContent.includes('跨源精选')), '打开受控歌单详情')
  expect(navigationCalls[0]==='pl-aggregate'&&document.querySelector('.aggregate-detail-header'), '歌单详情没有接入页面参数')
  expect(goBack(), '标题栏应能返回受控歌单目录')
  await tick()
  expect(backCalls===1&&all('.aggregate-card:not(.aggregate-create-card)').length===2, '详情返回没有恢复应用导航目标')
  controlledApp.unmount()
  console.error('AGGREGATE_RUNTIME_OK')
}
`
}

function runtimeHtml(bundleName: string, stylesheetName: string): string {
  return `<!doctype html><html><head><link rel="stylesheet" href="bundle/${stylesheetName}"></head><body><div id="app"></div><script>
const localMoon = {
  id: 'local:moon', title: 'Moon River', artist: 'Audrey', album: 'Breakfast',
  filePath: 'D:\\\\Music\\\\Moon.flac', fileName: 'Moon.flac', duration: 180,
  size: 1, cover: null, lyrics: null, source: 'local', format: 'flac'
}
const ncmMoon = {
  id: 'ncm:moon', title: 'Moon River', artist: 'Audrey', album: 'Breakfast',
  filePath: '', fileName: 'Moon.mp3', duration: 181,
  size: 1, cover: null, lyrics: null, source: 'ncm', ncmSongId: 991, format: 'mp3'
}
const ncmOnly = {
  id: 'ncm:only', title: 'Only Online', artist: 'Nobody', album: 'Cloud',
  filePath: '', fileName: 'Only.mp3', duration: 200,
  size: 1, cover: null, lyrics: null, source: 'ncm', ncmSongId: 992, format: 'mp3'
}

window.__aggregateFixture = {
  revision: 1,
  playCalls: [],
  localTracks: [localMoon],
  authoritative: [
    { id: 'pl-favorite', name: 'Favorite', trackIds: [], isDefault: true, createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'pl-plain', name: '普通歌单', trackIds: [], createdAt: '2026-08-01T00:00:00.000Z' },
    {
      id: 'pl-aggregate', name: '跨源精选', kind: 'aggregate',
      trackIds: ['local:moon', 'ncm:moon', 'ncm:only'],
      trackSnapshots: { 'local:moon': localMoon, 'ncm:moon': ncmMoon, 'ncm:only': ncmOnly },
      createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z'
    },
    {
      id: 'pl-pinned', name: '置顶集', kind: 'aggregate', trackIds: [],
      pinnedAt: '2026-08-10T00:00:00.000Z', createdAt: '2026-08-03T00:00:00.000Z'
    }
  ]
}
const fixture = window.__aggregateFixture
const clone = (value) => JSON.parse(JSON.stringify(value))
const envelope = () => ({ version: 2, revision: fixture.revision, savedAt: new Date().toISOString(), data: clone(fixture.authoritative) })
window.api = {
  data: {
    loadPlaylists: async () => envelope(),
    savePlaylists: async (data, expectedRevision) => {
      if (expectedRevision !== fixture.revision) throw new Error('unexpected revision ' + expectedRevision)
      fixture.revision += 1
      fixture.authoritative = clone(data)
      return envelope()
    }
  }
}
</script><script src="bundle/${bundleName}"></script></body></html>`
}

function electronRunnerSource(): string {
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript('window.runAggregateRuntime()')
    app.exit(0)
  } catch (error) {
    console.error('AGGREGATE_RUNTIME_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
