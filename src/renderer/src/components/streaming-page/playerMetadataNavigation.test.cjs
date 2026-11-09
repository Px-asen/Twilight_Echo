const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const { parse } = require('@vue/compiler-sfc')

const page = fs.readFileSync(require('node:path').join(__dirname, '../StreamingPage.vue'), 'utf8')
const source = parse(page).descriptor.scriptSetup.content
const ast = ts.createSourceFile('page.ts', source, ts.ScriptTarget.Latest, true)

let metadataCallback
let openRequestedAlbum
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === 'watch' &&
    node.arguments[0]?.getText(ast).includes('props.metadataNavigationRequest?.key')
  ) {
    metadataCallback = node.arguments[1].getText(ast)
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'openRequestedAlbum') {
    openRequestedAlbum = node.getText(ast)
  }
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(metadataCallback)
assert.ok(openRequestedAlbum)

async function runAlbumRequest(change = () => {}) {
  const opened = []
  let providerAvailable = false
  const context = {
    props: {
      active: true,
      metadataNavigationRequest: {
        kind: 'album',
        key: 1,
        providerId: 'ncm',
        albumId: 'album-1',
        albumName: 'Album',
        artist: 'Artist',
        cover: null
      }
    },
    lastMetadataNavigationKey: 0,
    playbackNavigationInFlight: 0,
    detailNavigationToken: 0,
    activeProvider: { value: 'ncm' },
    providerStore: {
      syncProviders: async () => {
        providerAvailable = true
        change(context)
      }
    },
    mediaProviders: {
      get: () =>
        providerAvailable ? { name: 'NetEase', fetchAlbumTracks: async () => [] } : undefined
    },
    selectDetailProvider: async () => {},
    isCurrentDetailNavigation: (token, providerId) =>
      token === context.detailNavigationToken &&
      context.props.active !== false &&
      (providerId === undefined || providerId === context.activeProvider.value),
    openAlbum: async (...args) => opened.push(args),
    openRequestedArtist: async () => {},
    isCurrentPlaybackMetadataRequest: (key) =>
      context.props.active !== false && context.props.metadataNavigationRequest?.key === key,
    pushNotice: () => {}
  }
  const code = ts.transpileModule(`${openRequestedAlbum}\nconst callback = ${metadataCallback}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  await vm.runInNewContext(`${code}\ncallback()`, context)
  return opened
}

test('one cold album click waits for provider registration and then opens', async () => {
  const opened = await runAlbumRequest()
  assert.equal(opened.length, 1)
  assert.equal(opened[0][0].id, 'album-1')
  assert.equal(opened[0][3], true)
})

test('album request is discarded when another destination supersedes it during provider sync', async () => {
  const opened = await runAlbumRequest((context) => {
    context.props.metadataNavigationRequest = null
  })
  assert.equal(opened.length, 0)
})

test('album request is discarded after leaving the streaming surface', async () => {
  const opened = await runAlbumRequest((context) => {
    context.props.active = false
  })
  assert.equal(opened.length, 0)
})

test('album request is discarded after a newer in-page navigation starts', async () => {
  const opened = await runAlbumRequest((context) => {
    context.detailNavigationToken += 1
  })
  assert.equal(opened.length, 0)
})

test('repeated playback metadata destinations retain the originating playlist', async () => {
  const functions = []
  function extract(node) {
    if (ts.isFunctionDeclaration(node) && ['pushDetail', 'popDetail'].includes(node.name?.text)) {
      functions.push(node.getText(ast))
    }
    ts.forEachChild(node, extract)
  }
  extract(ast)
  const context = {
    detailNavigationToken: 0,
    detailLoadToken: 0,
    detailStack: { value: [] },
    streamingTransitionName: { value: '' },
    streamingContentRef: { value: null },
    retainDetailState: () => ({ id: Promise.resolve('playlist-snapshot') }),
    releaseDetailEntry: () => {},
    browseState: { value: { session: null } },
    detailBrowse: { reset() {} },
    applyDetailState: async (snapshot) => {
      context.restored = await snapshot.id
    }
  }
  const code = ts.transpileModule(functions.join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const runtime = vm.runInNewContext(`${code}\n({pushDetail,popDetail})`, context)
  runtime.pushDetail({ type: 'playlist', id: 'daily' })
  runtime.pushDetail({ type: 'artist', id: 'a' }, true)
  runtime.pushDetail({ type: 'album', id: 'b' }, true)
  runtime.pushDetail({ type: 'album', id: 'c' }, true)
  assert.equal(context.detailStack.value.length, 2)
  await runtime.popDetail()
  assert.equal(context.detailStack.value.at(-1).view.id, 'daily')
  assert.equal(context.restored, 'playlist-snapshot')
})

test('ordinary detail links still push nested history', () => {
  const fn = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'pushDetail'
  )
  const context = {
    detailNavigationToken: 0,
    detailStack: { value: [] },
    retainDetailState: () => ({ id: Promise.resolve('snapshot') })
  }
  const code = ts.transpileModule(fn.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const push = vm.runInNewContext(`${code}\npushDetail`, context)
  push({ type: 'playlist' })
  push({ type: 'artist' })
  push({ type: 'album' })
  assert.equal(context.detailStack.value.length, 3)
})

test('player artist and album open in the originating library tab', () => {
  const app = fs.readFileSync(require('node:path').join(__dirname, '../../App.vue'), 'utf8')
  const appAst = ts.createSourceFile(
    'app.ts',
    parse(app).descriptor.scriptSetup.content,
    ts.ScriptTarget.Latest,
    true
  )
  const functions = appAst.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ['handlePlayingAlbumClick', 'handlePlayerBarArtistClick'].includes(node.name?.text)
  )
  const openedTabs = []
  const track = {
    id: 'track-1',
    album: 'Album',
    albumId: 'album-1',
    albumArtist: 'Album Artist',
    artist: 'Artist',
    cover: null
  }
  const context = {
    currentTrack: { value: track },
    pageTarget: { value: { kind: 'streaming' } },
    streamingTab: { value: 'library' },
    streamingMetadataTab: { value: 'home' },
    streamingMetadataRequest: { value: null },
    streamingMetadataRequestKey: 0,
    musicStore: { albums: { value: [] } },
    getTrackSource: () => 'ncm',
    onSelectView: () => {},
    pushNotice: () => {},
    enterStreamingMode: (tab) => openedTabs.push(tab)
  }
  const code = ts.transpileModule(functions.map((fn) => fn.getText(appAst)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const runtime = vm.runInNewContext(
    `${code}\n({handlePlayingAlbumClick,handlePlayerBarArtistClick})`,
    context
  )

  runtime.handlePlayingAlbumClick()
  const albumRequest = { ...context.streamingMetadataRequest.value }
  track.albumId = 'changed-after-click'
  assert.equal(albumRequest.kind, 'album')
  assert.equal(albumRequest.albumId, 'album-1')
  assert.equal(context.streamingMetadataTab.value, 'library')

  runtime.handlePlayerBarArtistClick({ id: 'artist-1', name: 'Artist' })
  assert.equal(context.streamingMetadataRequest.value.kind, 'artist')
  assert.equal(context.streamingMetadataTab.value, 'library')
  assert.deepEqual(openedTabs, ['library', 'library'])
})

test('reactivating for metadata does not start a competing root refresh', () => {
  let activation
  let pending
  function find(node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'watch' &&
      node.arguments[0]?.getText(ast) === '() => props.active' &&
      node.arguments[1]?.getText(ast).includes('refreshStreamingSurface')
    ) {
      activation = node.arguments[1].getText(ast)
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'playbackNavigationPending') {
      pending = node.getText(ast)
    }
    ts.forEachChild(node, find)
  }
  find(ast)
  let refreshes = 0
  const context = {
    props: { metadataNavigationRequest: { kind: 'album', key: 2 } },
    lastMetadataNavigationKey: 1,
    playbackNavigationInFlight: 0,
    refreshStreamingSurface: () => {
      refreshes++
    }
  }
  const code = ts.transpileModule(`${pending}\nconst activation = ${activation}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const activate = vm.runInNewContext(`${code}\nactivation`, context)
  activate(true, false)
  assert.equal(refreshes, 0)
  context.lastMetadataNavigationKey = 2
  context.playbackNavigationInFlight = 1
  activate(true, false)
  assert.equal(refreshes, 0)
  context.playbackNavigationInFlight = 0
  activate(true, false)
  assert.equal(refreshes, 1)
})
