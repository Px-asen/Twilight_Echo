import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { normalizePluginPlaylistImportRequest } from '../../shared/pluginPlaylistImport.ts'

const source = readFileSync(new URL('./manager.ts', import.meta.url), 'utf8').replaceAll(
  '\r\n',
  '\n'
)

/**
 * The core manager keeps extension-less imports, so tests reach private
 * dispatch logic the same way managerContract.test.ts does: extract the
 * methods plus their module-level helpers and run them in a fresh context.
 */
function extractManager(): {
  handleApiCall: (id: string, message: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>
} & {
  [key: string]: unknown
} {
  const ast = ts.createSourceFile('manager.ts', source, ts.ScriptTarget.Latest, true)
  const classNode = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'TwilightPluginManager'
  )!
  const methods = ast.statements.length // keep ast referenced
  assert.ok(methods > 0)
  const wanted = ['handleApiCall', 'handleLibraryTracksApiCall']
  const methodText = classNode.members
    .filter((node): node is ts.MethodDeclaration =>
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      wanted.includes(node.name.text)
    )
    .map((node) => node.getText(ast))
    .join('\n')
  const helpers = ast.statements
    .filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        !!node.name &&
        /^normalizePlugin/.test(node.name.text)
    )
    .map((node) => node.getText(ast))
    .join('\n')
  const constants = ast.statements
    .filter(
      (node): node is ts.VariableStatement =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) && /^PLUGIN_(LIBRARY|TRACK)/.test(declaration.name.text)
        )
    )
    .map((node) => node.getText(ast))
    .join('\n')
  const code = ts.transpileModule(
    `class ExtractedManager {\n${methodText}\n}\n${constants}\n${helpers}\nExtractedManager`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const sandbox: Record<string, unknown> = {
    Error,
    String,
    Number,
    Array,
    Object,
    JSON,
    Set,
    normalizePluginPlaylistImportRequest
  }
  const Manager = runInNewContext(code, sandbox) as new () => ReturnType<typeof extractManager>
  return new Manager()
}

type CallResult = { ok: boolean; value?: unknown; error?: string }

function createManager(overrides: Record<string, unknown>): ReturnType<typeof extractManager> {
  const manager = Object.assign(extractManager(), {
    running: new Map([
      [
        'com.example.assistant',
        {
          descriptor: {
            id: 'com.example.assistant',
            permissions: overrides.__permissions as string[]
          }
        }
      ]
    ]),
    requirePermission: function (this: { running: Map<string, { descriptor: { permissions: string[] } }> }, id: string, permission: string, capability: string) {
      const running = this.running.get(id)
      if (!running) throw new Error('插件未运行')
      if (!running.descriptor.permissions.includes(permission))
        throw new Error(`插件 com.example.assistant 未声明 ${permission} 权限，不能调用 ${capability}`)
    },
    libraryApi: overrides.libraryApi,
    appSettingsApi: overrides.appSettingsApi,
    hostCaptureApi: overrides.hostCaptureApi,
    player: {
      play: () => {},
      pause: () => {},
      togglePause: () => {},
      stop: () => {},
      next: () => {},
      previous: () => {},
      ...(overrides.player ?? {})
    },
    settings: { get: async () => null, set: async () => {}, delete: async () => {} },
    importPlaylists: undefined,
    getPlaybackInfo: async () => null
  })
  return manager
}

async function call(
  manager: ReturnType<typeof extractManager>,
  namespace: string,
  method: string,
  args: unknown[]
): Promise<CallResult> {
  return (await manager.handleApiCall('com.example.assistant', {
    kind: 'api-call',
    requestId: 'test',
    namespace,
    method,
    args
  })) as CallResult
}

const fullLibraryApi = {
  queryTracks: async () => ({ tracks: [], total: 0 }),
  getTracksByIds: async () => ({ tracks: [], total: 0 }),
  patchTracks: async () => ({ tracks: [], total: 0 }),
  getCover: async () => null,
  listPlaylists: async () => ({ items: [] }),
  createPlaylist: async () => ({ ok: true }),
  addTracksToPlaylist: async () => ({ ok: true }),
  removeTracksFromPlaylist: async () => ({ ok: true })
}

test('library reads and writes are permission-gated and normalized', async () => {
  const denied = createManager({
    __permissions: ['library:read'],
    libraryApi: fullLibraryApi
  })
  const deniedWrite = await call(denied, 'library', 'patchTracks', [
    [{ id: 't1', expectedVersion: 1, patch: { genre: 'Jazz' } }]
  ])
  assert.equal(deniedWrite.ok, false)
  assert.match(String(deniedWrite.error), /library:write/)

  const allowed = createManager({
    __permissions: ['library:read', 'library:write'],
    libraryApi: fullLibraryApi
  })
  const query = await call(allowed, 'library', 'queryTracks', [
    { search: 'coltrane', limit: 50, nonsense: true }
  ])
  assert.equal(query.ok, true)

  const patch = await call(allowed, 'library', 'patchTracks', [
    [{ id: 't1', expectedVersion: 2, patch: { genre: 'Jazz', filePath: '/evil' } }]
  ])
  assert.equal(patch.ok, true)

  const badQuery = await call(allowed, 'library', 'queryTracks', [{ limit: 9999 }])
  assert.equal(badQuery.ok, false)

  const badIds = await call(allowed, 'library', 'getTracksByIds', [[]])
  assert.equal(badIds.ok, false)

  const unavailable = createManager({ __permissions: ['library:read'] })
  const noService = await call(unavailable, 'library', 'queryTracks', [{}])
  assert.equal(noService.ok, false)
  assert.match(String(noService.error), /宿主未提供音乐库访问/)
})

test('app settings and screenshot capture require app:settings and host services', async () => {
  const denied = createManager({
    __permissions: ['network'],
    appSettingsApi: { get: () => ({ theme: 'dark' }), update: async () => ({}) },
    hostCaptureApi: { captureScreenshot: async () => 'data:image/jpeg;base64,x' }
  })
  assert.equal((await call(denied, 'appSettings', 'get', [])).ok, false)
  assert.equal((await call(denied, 'host', 'captureScreenshot', [])).ok, false)

  const allowed = createManager({
    __permissions: ['app:settings'],
    appSettingsApi: { get: () => ({ theme: 'dark' }), update: async () => ({ theme: 'light' }) },
    hostCaptureApi: { captureScreenshot: async () => 'data:image/jpeg;base64,x' }
  })
  const read = await call(allowed, 'appSettings', 'get', [])
  assert.equal(read.ok, true)
  assert.deepEqual(read.value, { theme: 'dark' })

  const update = await call(allowed, 'appSettings', 'update', [{ theme: 'light' }])
  assert.equal(update.ok, true)

  const shot = await call(allowed, 'host', 'captureScreenshot', [])
  assert.equal(shot.ok, true)
  assert.match(String(shot.value), /^data:image\/jpeg;base64,/)

  const noService = createManager({ __permissions: ['app:settings'] })
  assert.match(
    String((await call(noService, 'host', 'captureScreenshot', [])).error),
    /截图能力/
  )
})

test('real host playTracks calls reach the manager with positional arguments and default index', async () => {
  const played: Array<{ ids: string[]; startIndex: number }> = []
  const manager = createManager({
    __permissions: ['player:control'],
    player: {
      playTracks: async (ids: string[], startIndex: number) => {
        played.push({ ids, startIndex })
      }
    }
  })
  const hostSource = readFileSync(new URL('../../main/plugins/host.ts', import.meta.url), 'utf8')
  const hostAst = ts.createSourceFile('host.ts', hostSource, ts.ScriptTarget.Latest, true)
  const functions = hostAst.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      !!node.name &&
      ['createContext', 'callPlayerApi'].includes(node.name.text)
  )
  assert.equal(functions.length, 2)
  const code = ts.transpileModule(functions.map((node) => node.getText(hostAst)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const player = runInNewContext(
    `${code}\ncreateContext('com.example.assistant', 4, 'unused', []).twilight.player`,
    {
      INTERNAL_NCM_PLUGIN_ID: 'com.twilightecho.provider.ncm',
      QISHUI_PLUGIN_ID: 'com.twilightecho.provider.qishui',
      QQMUSIC_PLUGIN_ID: 'com.twilightecho.provider.qqmusic',
      createSettingsApi: () => ({}),
      callApi: async (namespace: string, method: string, args: unknown[]) => {
        const result = await call(manager, namespace, method, args)
        if (!result.ok) throw new Error(result.error)
        return result.value
      }
    }
  ) as { playTracks(ids: string[], startIndex?: number): Promise<void> }

  await player.playTracks(['a', 'b'], 1)
  await player.playTracks(['c'])
  assert.deepEqual(played, [
    { ids: ['a', 'b'], startIndex: 1 },
    { ids: ['c'], startIndex: 0 }
  ])
})

test('extended player transport validates arguments before reaching the host', async () => {
  const manager = createManager({
    __permissions: ['player:control'],
    player: {
      playTracks: async () => {
        throw new Error('should not be reached with invalid args')
      },
      setVolume: async () => {
        throw new Error('should not be reached with invalid args')
      },
      seek: async () => {
        throw new Error('should not be reached with invalid args')
      },
      setPlayMode: async () => {
        throw new Error('should not be reached with invalid args')
      }
    }
  })
  const badIds = await call(manager, 'player', 'playTracks', [[], 0])
  assert.equal(badIds.ok, false)
  assert.match(String(badIds.error), /曲目 id 列表/)

  for (const startIndex of [0.5, 2]) {
    const badIndex = await call(manager, 'player', 'playTracks', [['a', 'b'], startIndex])
    assert.equal(badIndex.ok, false)
    assert.match(String(badIndex.error), /起始索引越界/)
  }

  const badMode = await call(manager, 'player', 'setPlayMode', ['party'])
  assert.equal(badMode.ok, false)

  const badVolume = await call(manager, 'player', 'setVolume', [1.5])
  assert.equal(badVolume.ok, false)
  assert.match(String(badVolume.error), /音量必须在 0\.\.1/)

  const noTransportManager = createManager({ __permissions: ['player:control'] })
  const noTransport = await call(noTransportManager, 'player', 'playTracks', [
    ['a', 'b'],
    1
  ])
  assert.equal(noTransport.ok, false)
  assert.match(String(noTransport.error), /队列播放能力/)
})
