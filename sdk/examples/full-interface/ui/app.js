import { connectExperience } from './bridge.js'

const $ = (id) => document.getElementById(id)
let bridge
let state = null
let offset = 0
let total = 0
let listGeneration = 0
let detailGeneration = 0
let queueGeneration = 0
let preferences = {}
let scrubbing = false
let volumeEditing = false
const required = [
  'library.list',
  'library.album',
  'library.search',
  'player.state',
  'player.queue',
  'player.play',
  'player.playQueue',
  'player.toggle',
  'player.previous',
  'player.next',
  'player.seek',
  'player.volume',
  'preferences.read',
  'preferences.write',
  'host.environment',
  'host.exit',
  'host.panel'
]

function errorMessage(error) {
  $('error').hidden = false
  $('error').textContent = error.message || String(error)
}
function run(task) {
  $('error').hidden = true
  Promise.resolve().then(task).catch(errorMessage)
}
function time(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}
function tone(value) {
  document.documentElement.dataset.tone = value
  parent.postMessage({ type: 'twilight-experience-tone', tone: value }, '*')
}
function renderPlayer(value) {
  if (!value) return
  state = value
  $('now-title').textContent = value.currentTrack?.title || '尚未播放'
  $('now-artist').textContent = value.currentTrack?.artist || '从专辑中选择一首歌曲'
  $('toggle').textContent = value.loading ? '加载中' : value.playing ? '暂停' : '播放'
  $('toggle').disabled = value.loading || !value.currentTrack
  $('previous').disabled = $('next').disabled = !value.currentTrack
  $('seek').disabled = !value.duration
  if (!scrubbing) {
    $('seek').max = String(value.duration || 1)
    $('seek').value = String(value.currentTime || 0)
    $('elapsed').textContent = time(value.currentTime)
  }
  $('duration').textContent = time(value.duration)
  if (!volumeEditing) {
    $('volume').value = String(value.volume)
    $('volume-value').textContent = `${Math.round(value.volume * 100)}%`
  }
  for (const button of $('queue').querySelectorAll('button'))
    button.setAttribute(
      'aria-current',
      String(button.dataset.entryId === value.currentTrack?.queueEntryId)
    )
  if (value.error) errorMessage(new Error(value.error))
}
function trackRow(track, index, action) {
  const li = document.createElement('li')
  const button = document.createElement('button')
  button.className = 'track'
  const number = document.createElement('span')
  number.className = 'number'
  number.textContent = String(index + 1).padStart(2, '0')
  const label = document.createElement('span')
  label.className = 'label'
  const title = document.createElement('strong')
  title.textContent = track.title
  const artist = document.createElement('small')
  artist.textContent = track.artist || '未知艺术家'
  label.append(title, artist)
  const duration = document.createElement('span')
  duration.className = 'time'
  duration.textContent = time(track.duration)
  button.append(number, label, duration)
  button.addEventListener('click', () => run(action))
  li.append(button)
  return li
}
async function openAlbum(album) {
  const generation = ++detailGeneration
  const full = await bridge.call('library.album', { id: album.id })
  if (generation !== detailGeneration) return
  $('detail-title').textContent = `${full.title} · ${full.trackCount} 首`
  $('tracks').replaceChildren(
    ...full.tracks.map((track, index) =>
      trackRow(track, index, async () =>
        renderPlayer(await bridge.call('player.play', { id: track.id, albumId: full.id }))
      )
    )
  )
  $('detail').hidden = false
  $('detail').scrollIntoView({ behavior: 'instant', block: 'start' })
}
function albumCard(album) {
  const button = document.createElement('button')
  button.className = 'album'
  const cover = document.createElement('span')
  cover.className = 'cover'
  cover.textContent = '♫'
  if (album.coverUrl) {
    const img = document.createElement('img')
    img.src = album.coverUrl
    img.alt = ''
    img.loading = 'lazy'
    img.addEventListener(
      'error',
      () => {
        cover.textContent = '♫'
      },
      { once: true }
    )
    cover.textContent = ''
    cover.append(img)
  }
  const title = document.createElement('strong')
  title.textContent = album.title
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.textContent = `${album.artist || '未知艺术家'} · ${album.trackCount} 首`
  button.title = `${album.title} — ${album.artist || '未知艺术家'}`
  button.append(cover, title, meta)
  button.addEventListener('click', () => run(() => openAlbum(album)))
  return button
}
async function loadAlbums(append = false) {
  const generation = ++listGeneration
  ++detailGeneration
  $('more').disabled = true
  $('detail').hidden = true
  if (!append) {
    offset = 0
    $('albums').replaceChildren()
  }
  $('status').textContent = '正在读取专辑…'
  try {
    const page = await bridge.call('library.list', { offset, limit: 24 })
    if (generation !== listGeneration) return
    total = page.total
    offset += page.albums.length
    $('albums').append(...page.albums.map(albumCard))
    $('status').textContent = total
      ? `已显示 ${offset} / ${total} 张专辑`
      : '曲库为空。返回默认界面导入歌曲后，点击「全部专辑」。'
    $('more').hidden = offset >= total || !page.albums.length
  } finally {
    if (generation === listGeneration) $('more').disabled = false
  }
}
async function search() {
  const query = $('query').value.trim()
  if (!query) return loadAlbums()
  const generation = ++listGeneration
  ++detailGeneration
  $('more').hidden = true
  $('detail').hidden = true
  $('status').textContent = '正在搜索…'
  const result = await bridge.call('library.search', { query })
  if (generation !== listGeneration) return
  $('albums').replaceChildren(...result.albums.map(albumCard))
  $('tracks').replaceChildren(
    ...result.tracks.map((track, index) =>
      trackRow(track, index, async () =>
        renderPlayer(
          await bridge.call('player.play', { id: track.id, ids: result.tracks.map((t) => t.id) })
        )
      )
    )
  )
  $('detail-title').textContent = '歌曲搜索结果'
  $('detail').hidden = !result.tracks.length
  $('status').textContent =
    `找到 ${result.albums.length} 张专辑、${result.tracks.length} 首歌曲（当前接口最多返回 80 张 / 100 首）`
}
async function loadQueue() {
  const generation = ++queueGeneration
  const tracks = await bridge.call('player.queue')
  if (generation !== queueGeneration) return
  $('queue-empty').hidden = !!tracks.length
  $('queue').replaceChildren(
    ...tracks.map((track, index) => {
      const row = trackRow(track, index, async () =>
        renderPlayer(await bridge.call('player.playQueue', { entryId: track.queueEntryId }))
      )
      row.firstChild.dataset.entryId = track.queueEntryId
      return row
    })
  )
  if (state) renderPlayer(state)
}

function bindControls() {
  for (const id of ['query', 'search', 'refresh', 'theme', 'settings', 'exit', 'volume'])
    $(id).disabled = false
  $('refresh').onclick = () => {
    $('query').value = ''
    run(() => loadAlbums())
  }
  $('more').onclick = () => run(() => loadAlbums(true))
  $('search').onclick = () => run(search)
  $('query').onkeydown = (event) => {
    if (event.key === 'Enter') run(search)
  }
  $('theme').onclick = () =>
    run(async () => {
      const next = document.documentElement.dataset.tone === 'night' ? 'day' : 'night'
      const saved = await bridge.call('preferences.write', {
        value: { ...preferences, tone: next }
      })
      preferences = saved
      tone(next)
    })
  $('settings').onclick = () => run(() => bridge.call('host.panel', { name: 'settings' }))
  $('exit').onclick = () => run(() => bridge.call('host.exit'))
  for (const id of ['toggle', 'previous', 'next'])
    $(id).onclick = () =>
      run(async () => {
        await bridge.call(`player.${id}`)
        renderPlayer(await bridge.call('player.state'))
      })
  $('seek').oninput = () => {
    scrubbing = true
    $('elapsed').textContent = time(Number($('seek').value))
  }
  $('seek').onchange = () =>
    run(async () => {
      const value = Number($('seek').value)
      try {
        await bridge.call('player.seek', { value })
      } finally {
        scrubbing = false
        renderPlayer(await bridge.call('player.state'))
      }
    })
  $('volume').oninput = () => {
    volumeEditing = true
    $('volume-value').textContent = `${Math.round(Number($('volume').value) * 100)}%`
  }
  $('volume').onchange = () =>
    run(async () => {
      const value = Number($('volume').value)
      try {
        await bridge.call('player.volume', { value })
      } finally {
        volumeEditing = false
        renderPlayer(await bridge.call('player.state'))
      }
    })
}

async function boot() {
  bridge = await connectExperience()
  const capabilities = await bridge.call('host.capabilities')
  const missing = required.filter((method) => !capabilities.methods.includes(method))
  if (missing.length)
    throw new Error(`宿主缺少接口，请更新宿主或检查插件权限：${missing.join(', ')}`)
  bridge.on('player', renderPlayer)
  bridge.on('queue', () => run(loadQueue))
  // Invalidate a displayed library rather than replacing the user's view during a scan.
  bridge.on('library', () => {
    $('status').textContent = '曲库已更新。点击「全部专辑」或重新搜索以刷新。'
  })
  const [saved, environment, player] = await Promise.all([
    bridge.call('preferences.read'),
    bridge.call('host.environment'),
    bridge.call('player.state')
  ])
  preferences = saved
  tone(saved.tone === 'night' ? 'night' : 'day')
  document.documentElement.dataset.reducedMotion = String(environment.reducedMotion)
  bindControls()
  renderPlayer(player)
  await Promise.all([loadAlbums(), loadQueue()])
}
boot().catch((error) => {
  $('status').textContent = '界面未能完成加载。可使用宿主顶部返回按钮退出。'
  errorMessage(error)
})
