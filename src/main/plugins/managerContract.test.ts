import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { PluginRpcCoordinator } from './rpcCoordinator.ts'
import { protectProviderMedia, RemoteMediaGrantService } from '../security/remoteMediaGrants.ts'
import type { TwilightMediaProviderRegistration } from '../../../packages/plugin-api/src/index.ts'
import type { TwilightMediaProviderMethod } from './types.ts'
import type { TwilightProviderCallOptions } from './manager.ts'
import { createAfterglowSourceResolver } from '../app/afterglowSourceResolver.ts'
import { normalizePluginPlaylistImportRequest } from '../../shared/pluginPlaylistImport.ts'
import type { PluginNotice } from '../../shared/pluginNotice.ts'
import type { PlaylistImportApplyResult } from '../../shared/playlists.ts'

type ProviderRegistrationMethodKeys = Exclude<
  keyof TwilightMediaProviderRegistration,
  'id' | 'name' | 'capabilities' | 'health'
>
type MethodsMissingFromRegistration = Exclude<
  TwilightMediaProviderMethod,
  ProviderRegistrationMethodKeys
>
type MethodsMissingFromUnion = Exclude<ProviderRegistrationMethodKeys, TwilightMediaProviderMethod>
type AssertNever<T> = [T] extends [never] ? true : never
const registrationCoversUnion: AssertNever<MethodsMissingFromRegistration> = true
const unionCoversRegistration: AssertNever<MethodsMissingFromUnion> = true

const managerSource = readFileSync(new URL('../../core/plugins/manager.ts', import.meta.url), 'utf8')

test('official QQ login is restricted to its provider, uses host-owned URLs and propagates cancellation', async () => {
  const ast = ts.createSourceFile('manager.ts', managerSource, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TwilightPluginManager')!
  const method = declaration.members.find(node =>
    ts.isMethodDeclaration(node) && node.name.getText(ast) === 'handleApiCall')!
  const code = ts.transpileModule(`class Manager {${method.getText(ast)}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const id = 'com.twilightecho.provider.qqmusic'
  const Manager = runInNewContext(`${code}\nManager`, { Error, QQMUSIC_PLUGIN_ID: id }) as new () => {
    handleApiCall(id: string, message: unknown, signal?: AbortSignal): Promise<{ ok: boolean; value?: unknown }>
  }
  const controller = new AbortController()
  let calls = 0
  const manager = Object.assign(new Manager(), {
    requirePermission: (_id: string, permission: string) => assert.equal(permission, 'network'),
    qqmusicOfficialLogin: async (signal: AbortSignal) => { calls++; assert.equal(signal, controller.signal); return { loginType: 2 } }
  })
  const message = { requestId: 'official', namespace: 'auth', method: 'qqmusicOfficialLogin', args: [] }
  assert.equal((await manager.handleApiCall('other', message)).ok, false)
  assert.equal((await manager.handleApiCall(id, { ...message, args: ['https://evil.test'] })).ok, false)
  assert.equal(calls, 0)
  assert.equal((await manager.handleApiCall(id, message, controller.signal)).ok, true)
  assert.equal(calls, 1)
})

test('Core acknowledges plugin imports after persistence and emits one combined result notice', async () => {
  const ast = ts.createSourceFile('manager.ts', managerSource, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TwilightPluginManager')!
  const method = declaration.members.find(node =>
    ts.isMethodDeclaration(node) && node.name.getText(ast) === 'handleApiCall')!
  const code = ts.transpileModule(`class ImportManager extends EventEmitter {${method.getText(ast)}}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const Manager = runInNewContext(`${code}\nImportManager`, {
    EventEmitter, Error, normalizePluginPlaylistImportRequest
  }) as new () => EventEmitter & {
    handleApiCall(id: string, message: object): Promise<{ ok: boolean; error?: string }>
    importPlaylists(): Promise<PlaylistImportApplyResult[]>
  }
  let commit!: (results: PlaylistImportApplyResult[]) => void
  const pending = new Promise<PlaylistImportApplyResult[]>(resolve => { commit = resolve })
  const manager = Object.assign(new Manager(), {
    importPlaylists: () => pending,
    requirePermission: () => {}
  })
  const notices: PluginNotice[] = []
  manager.on('notice', notice => notices.push(notice))
  const message = { requestId:'import', namespace:'library', method:'importPlaylists', args:[{
    playlists:[{name:'One',paths:['one.flac']},{name:'Two',paths:['two.flac','missing.flac']}]
  }] }
  const response = manager.handleApiCall('com.example.import', message)
  assert.equal(notices.length,0)
  commit([{playlistId:'one',importedCount:1,unresolvedEntries:0,warnings:[]},
    {playlistId:'two',importedCount:1,unresolvedEntries:1,warnings:[]}])
  assert.equal((await response).ok,true)
  assert.equal(notices.length,1)
  assert.equal(notices[0].message,'已从 2 个歌单导入 2 首到本地歌单，1 首不在本地音乐库中')
  assert.equal(notices[0].kind,'success')
  manager.importPlaylists = async () => { throw Error('disk full') }
  assert.equal((await manager.handleApiCall('com.example.import',message)).error,'disk full')
  assert.equal(notices[1].kind,'error')
})

function playbackMetadataHarness(pluginId = 'com.twilightecho.provider.ncm') {
  const ast = ts.createSourceFile('manager.ts', managerSource, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(
    (node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'TwilightPluginManager'
  )
  assert.ok(declaration)
  const methods = declaration.members.filter(
    (node) =>
      ts.isMethodDeclaration(node) &&
      ['callProvider', 'handleProviderResult'].includes(node.name.getText(ast))
  )
  assert.equal(methods.length, 2)
  const code = ts.transpileModule(
    `class PlaybackMetadataManager {${methods.map((node) => node.getText(ast)).join('\n')}}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const grants = new RemoteMediaGrantService()
  let dispatched: { requestId: string } | undefined
  const running = {
    descriptor: { id: pluginId },
    providers: [{ id: 'ncm' }],
    process: {
      postMessage: (message: { requestId: string }) => {
        dispatched = message
      }
    }
  }
  const Manager = runInNewContext(`${code}\nPlaybackMetadataManager`, {
    randomUUID,
    findProviderRoute: () => running,
    getProviderCallTimeoutMs: () => 1000,
    resolveProviderIdempotencyKey: () => undefined,
    protectProviderMedia: (value: unknown, method: string) =>
      protectProviderMedia(value, method, grants),
    providerPlaybackIdentities: { record: () => undefined },
    isPluginHostedPlaybackUrl: () => false
  }) as new () => {
    callProvider: (
      provider: string,
      method: string,
      args: unknown[],
      options?: TwilightProviderCallOptions
    ) => Promise<unknown>
    handleProviderResult: (owner: string, message: unknown) => void
  }
  const manager = Object.assign(new Manager(), {
    platform: { protectProviderResult: (value: unknown, method: string) => protectProviderMedia(value, method, grants) },
    recordPlaybackIdentity: () => undefined,
    rpcCalls: new PluginRpcCoordinator(),
    contributingPlugins: () => [running],
    ensureRunningForCall: async () => running,
    assertRunningPlugin: () => undefined,
    recordProviderCallSuccess: () => undefined,
    recordProviderCallFailure: () => undefined
  })
  return {
    grants,
    resolve: async (
      value: unknown,
      requested: unknown = false,
      options: TwilightProviderCallOptions = {}
    ): Promise<unknown> => {
      const pending = manager.callProvider(
        'ncm',
        'getPlaybackUrl',
        [{ id: 'ncm:93' }, { quality: 'lossless', _twilightPlaybackMetadata: requested }],
        options
      )
      await new Promise<void>((done) => setImmediate(done))
      assert.ok(dispatched)
      manager.handleProviderResult(pluginId, {
        kind: 'provider-result',
        requestId: dispatched.requestId,
        ok: true,
        value
      })
      return pending
    }
  }
}

test('production provider protection and main-only expiry feed the Afterglow resolver without changing renderer results', async () => {
  const f = playbackMetadataHarness()
  let expiresAt = 500_000
  const upstream = 'https://m8.music.126.net/track.flac'
  const envelope = () => ({
    streamUrl: upstream,
    providerSource: { expiresAt, sourceUrl: upstream, sampleRate: 96000, secret: 'not-forwarded' }
  })
  let result: unknown
  const resolver = createAfterglowSourceResolver({
    now: () => 1_000,
    quality: 'lossless',
    grants: f.grants,
    callProvider: async (_provider, _method, _args, options) => {
      result = await f.resolve(envelope(), false, options)
      return result
    }
  })
  assert.deepEqual(await resolver.resolve({ id: 'ncm:93', source: 'ncm' }), {
    source: upstream,
    expiresAt
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    streamUrl: (result as { streamUrl: string }).streamUrl,
    providerSource: { expiresAt }
  })
  expiresAt = 999
  assert.equal(await resolver.resolve({ id: 'ncm:93', source: 'ncm' }), null)
  assert.equal(typeof (await f.resolve(envelope())), 'string')
})

test('NCM playback metadata keeps the authorized URL and exposes only source audio facts', async () => {
  const f = playbackMetadataHarness()
  const upstream = 'https://m8.music.126.net/track.flac'
  const result = (await f.resolve(
    {
      streamUrl: upstream,
      providerSource: { sampleRate: 96000, bitrate: 4608000, sourceUrl: upstream }
    },
    true
  )) as { streamUrl: string; sampleRate: number; bitrate: number }
  assert.match(result.streamUrl, /^twilight-media:\/\/audio\//)
  assert.equal(f.grants.resolve(result.streamUrl, 'audio').source, upstream)
  assert.equal(result.sampleRate, 96000)
  assert.equal(result.bitrate, 4608000)
  assert.deepEqual(Object.keys(result).sort(), ['bitrate', 'sampleRate', 'streamUrl'])
})

for (const [pluginId, requested] of [
  ['com.twilightecho.provider.ncm', false],
  ['com.twilightecho.provider.ncm', 'true'],
  ['com.example.provider', true]
] as const) {
  test(`playback URL remains a string without a trusted metadata opt-in (${pluginId}, ${requested})`, async () => {
    const f = playbackMetadataHarness(pluginId)
    const upstream = 'https://m8.music.126.net/track.flac'
    const result = await f.resolve(
      { streamUrl: upstream, providerSource: { sampleRate: 96000, bitrate: 4608000 } },
      requested
    )
    assert.equal(typeof result, 'string')
    assert.equal(f.grants.resolve(result as string, 'audio').source, upstream)
  })
}

test('metadata opt-in retains legacy provider string responses and authorized cached paths', async () => {
  const f = playbackMetadataHarness()
  const upstream = 'https://m8.music.126.net/track.flac'
  const legacy = await f.resolve(upstream, true)
  assert.equal(typeof legacy, 'string')
  assert.equal(f.grants.resolve(legacy as string, 'audio').source, upstream)
  const cached = (await f.resolve(
    { streamUrl: 'D:\\Cache\\93.flac', providerSource: { sampleRate: 44100 } },
    true
  )) as { streamUrl: string; sampleRate: number; bitrate?: number }
  assert.equal(cached.streamUrl, 'D:\\Cache\\93.flac')
  assert.equal(cached.sampleRate, 44100)
  assert.equal(cached.bitrate, undefined)
})
const statePersistenceSource = readFileSync(
  new URL('../../core/plugins/statePersistence.ts', import.meta.url),
  'utf8'
)
const operationQueueSource = readFileSync(new URL('../../core/plugins/operationQueue.ts', import.meta.url), 'utf8')
const rpcCoordinatorSource = readFileSync(new URL('../../core/plugins/rpcCoordinator.ts', import.meta.url), 'utf8')
const providerRoutingSource = readFileSync(new URL('../../core/plugins/providerRouting.ts', import.meta.url), 'utf8')
const updateTransactionSource = readFileSync(
  new URL('../../core/plugins/updateTransaction.ts', import.meta.url),
  'utf8'
)
const packageSecuritySource = readFileSync(new URL('../../core/plugins/packageSecurity.ts', import.meta.url), 'utf8')
const pluginTypesSource = readFileSync(new URL('../../shared/pluginTypes.ts', import.meta.url), 'utf8')
const themeContributionSource = readFileSync(
  new URL('../../core/plugins/themeContribution.ts', import.meta.url),
  'utf8'
)
const pluginHostSource = readFileSync(new URL('./host.ts', import.meta.url), 'utf8')
const pluginApiSource = readFileSync(
  new URL('../../../packages/plugin-api/src/index.ts', import.meta.url),
  'utf8'
)
function readPreloadSources(): string {
  const root = new URL('../../preload/', import.meta.url)
  return [
    'index.ts',
    'types.ts',
    'index.d.ts',
    'sleepTimerEvents.ts',
    'domains/dataApi.ts',
    'domains/audioEngineApi.ts',
    'domains/desktopLyricsApi.ts',
    'domains/libraryApi.ts',
    'domains/mediaSubscriptionsApi.ts',
    'domains/networkSourcesApi.ts',
    'domains/settingsApi.ts',
    'domains/themesApi.ts',
    'domains/pluginsApi.ts',
    'domains/systemApi.ts'
  ]
    .map((rel) => readFileSync(new URL(rel, root), 'utf8'))
    .join('\n')
}

const preloadSource = readPreloadSources()
const pluginIpcSource = readFileSync(new URL('../ipc/plugins.ts', import.meta.url), 'utf8')
const pluginExtensionPageSource = readFileSync(
  new URL('../../renderer/src/components/PluginExtensionPage.vue', import.meta.url),
  'utf8'
)

test('provider method union and plugin-api registration typings stay in sync', () => {
  assert.equal(registrationCoversUnion, true)
  assert.equal(unionCoversRegistration, true)
})

test('plugin manager keeps UI command failures isolated to the owning plugin', () => {
  assert.match(managerSource, /const PLUGIN_UI_COMMAND_TIMEOUT_MS = 5000/)
  assert.match(managerSource, /UI command 调用超时/)
  assert.match(managerSource, /this\.markFailed\(\s*running\.descriptor\.id/)
  assert.match(managerSource, /void this\.stopPlugin\(running\.descriptor\.id\)/)
})

test('plugin manager enforces controlled UI and theme extension contracts', () => {
  assert.match(themeContributionSource, /permissions\.includes\('ui:inject'\)/)
  assert.match(themeContributionSource, /'localSidebarItem'/)
  assert.match(themeContributionSource, /'streamingHome'/)
  assert.match(themeContributionSource, /const renderMode = 'command'/)
  assert.doesNotMatch(themeContributionSource, /record\.renderMode === 'html'/)
  assert.doesNotMatch(pluginExtensionPageSource, /srcdoc|allow-same-origin|htmlContent/)
  assert.match(pluginExtensionPageSource, /<pre>\{\{ textResult \}\}<\/pre>/)
  assert.match(managerSource, /this\.resolveThemeStylesheet/)
  assert.match(managerSource, /resolvePluginFile\(stylesheetPath, descriptor\.paths\.versionRoot\)/)
  assert.match(themeContributionSource, /\^--te-\[a-z0-9-_\]\+\$/)
  assert.match(
    managerSource,
    /主题必须通过 manifest contributes\.themes 声明，运行时主题注册已禁用/
  )
  assert.match(pluginHostSource, /Themes must be declared in plugin\.json contributes\.themes/)
  assert.match(managerSource, /themes: this\.normalizeDeclarativeThemeContributions\(descriptor\)/)
})

test('plugin manager rejects symlink escapes in installed plugin resources', () => {
  assert.match(managerSource, /assertPluginPackageFileSize\(source\)/)
  assert.match(managerSource, /extractPluginPackage\(source, tempRoot\)/)
  assert.match(managerSource, /assertPluginTreeSafe\(installSource\)/)
  assert.match(packageSecuritySource, /MAX_PLUGIN_PACKAGE_BYTES = 50 \* 1024 \* 1024/)
  assert.match(packageSecuritySource, /MAX_PLUGIN_EXTRACTED_BYTES = 100 \* 1024 \* 1024/)
  assert.match(packageSecuritySource, /MAX_PLUGIN_PACKAGE_FILES = 2000/)
  assert.match(packageSecuritySource, /inspectZipPackage\(source\)/)
  assert.match(packageSecuritySource, /isZipSymlink\(entry\)/)
  assert.match(packageSecuritySource, /info\.isSymbolicLink\(\)/)
  assert.match(packageSecuritySource, /realpathSync\(root\)/)
  assert.match(packageSecuritySource, /realpathSync\(filePath\)/)
  assert.match(managerSource, /resolvePluginFile\(mainPath, descriptor\.paths\.versionRoot\)/)
  assert.match(
    managerSource,
    /return resolvePluginFile\(resolve\(versionRoot, relPath\), versionRoot\)/
  )
})

test('plugin manager routes tep installs through the final hash and confirmation boundary', () => {
  assert.match(managerSource, /await runFinalPluginPackageTrustBoundary\(\{/)
  assert.match(managerSource, /inspectStagedPackage: async \(packagePath\)/)
  assert.match(
    managerSource,
    /requestConfirmation: \(\{ manifest: candidateManifest \}, evidence\)/
  )
  assert.doesNotMatch(managerSource, /if \(isTep\)[\s\S]{0,300}this\.confirmTrustBasedInstall/)
})

test('plugin updates stage, trial activate, and roll back without deleting the prior version', () => {
  assert.match(managerSource, /staging: join\(userData, 'plugin-staging'\)/)
  assert.match(managerSource, /await commitStagedPluginUpdate\(/)
  assert.match(managerSource, /await this\.trialActivatePlugin\(candidate\)/)
  assert.match(managerSource, /activeVersion: manifest\.version/)
  assert.match(managerSource, /restorePreviousVersion: async \(\) =>/)
  assert.doesNotMatch(managerSource, /removeOtherPluginVersions/)
  assert.doesNotMatch(managerSource, /mkdtemp\(join\(tmpdir\(\), 'twilight-plugin-'/)
})

test('plugin updates serialize same-id installs and surface rollback failures', () => {
  assert.match(
    managerSource,
    /private readonly pluginOperationQueue = new PluginOperationQueue\(\)/
  )
  assert.match(managerSource, /return await this\.pluginOperationQueue\.run\(manifest\.id/)
  assert.match(managerSource, /PluginUpdateRollbackError/)
  assert.match(managerSource, /update-rollback-error/)
  assert.match(operationQueueSource, /private readonly tails = new Map<string, Promise<void>>\(\)/)
  assert.match(updateTransactionSource, /class PluginUpdateRollbackError/)
  assert.doesNotMatch(
    updateTransactionSource,
    /rollbackActiveVersion\(\)\.catch\(\(\) => undefined\)/
  )
  assert.doesNotMatch(
    updateTransactionSource,
    /restorePreviousVersion\(\)\.catch\(\(\) => undefined\)/
  )
})

test('plugin state persistence serializes fsynced atomic writes and surfaces recovery', () => {
  assert.match(statePersistenceSource, /private writeTail: Promise<void> = Promise\.resolve\(\)/)
  assert.match(statePersistenceSource, /await handle\.sync\(\)/)
  assert.match(statePersistenceSource, /await writeRawFileAtomically\(backupPath, backupRaw\)/)
  assert.match(statePersistenceSource, /await writeRawFileAtomically\(filePath, json\)/)
  assert.match(managerSource, /state-recovery-warning/)
  assert.match(managerSource, /state-write-error/)
  assert.match(managerSource, /await this\.statePersistenceFor\(\)\.flush\(\)/)
  assert.match(managerSource, /private notifyStateIssueUser\(/)
  assert.match(managerSource, /this\.platform\.notifyStateIssue\(type, detail\)/)
  assert.match(readFileSync(new URL('./platform.ts', import.meta.url), 'utf8'), /dialog[\s\S]*\.showMessageBox\(/)
})

test('plugin manager enforces plugin API namespace permissions at the gateway', () => {
  assert.match(managerSource, /private requirePermission\(/)
  assert.match(managerSource, /'player:observe'/)
  assert.match(managerSource, /'player:control'/)
  assert.match(managerSource, /'library:read'/)
  assert.match(
    managerSource,
    /this\.requirePermission\(pluginId,\s*'network',\s*'providers\.register'/
  )
  assert.match(managerSource, /private requireProviderCapabilityPermissions\(/)
  assert.match(managerSource, /capabilities\.includes\('library'\)/)
  assert.match(managerSource, /private normalizeEventSubscription\(/)
  assert.match(managerSource, /this\.requirePermission\(id,\s*'player:observe'/)
  assert.match(managerSource, /this\.requirePermission\(id,\s*'player:control'/)
  assert.match(
    managerSource,
    /message\.kind === 'api-event-subscribe'[\s\S]*this\.normalizeEventSubscription\(id/
  )
  assert.match(
    managerSource,
    /eventName\.startsWith\('library:'\)[\s\S]*this\.requirePermission\(pluginId,\s*'library:read'/
  )
})

test('plugin manager routes the overlay namespace to the host dynamic island bridge behind ui:inject', () => {
  assert.match(managerSource, /dynamicIsland\?: \{/)
  assert.match(
    managerSource,
    /message\.namespace === 'overlay'[\s\S]*this\.handleOverlayApiCall\(id, message\)/
  )
  assert.match(managerSource, /private async handleOverlayApiCall\(/)
  assert.match(
    managerSource,
    /this\.requirePermission\(pluginId,\s*'ui:inject',\s*`overlay\.\$\{message\.method\}`\)/
  )
  assert.match(managerSource, /this\.dynamicIsland\.show\(pluginId\)/)
  assert.match(managerSource, /this\.dynamicIsland\.hide\(pluginId\)/)
  assert.match(
    managerSource,
    /this\.dynamicIsland\.configure\(pluginId, message\.args\[0\] \?\? \{\}\)/
  )
  assert.match(pluginHostSource, /overlay: \{/)
  assert.match(pluginHostSource, /function callOverlayApi\(/)
  assert.match(pluginHostSource, /callApi\('overlay', method, args\)/)
})

test('plugin manager prevents provider id takeover', () => {
  assert.match(managerSource, /const RESERVED_PROVIDER_IDS = new Set\(\['local', 'ncm'\]\)/)
  assert.match(managerSource, /private assertProviderIdAvailable\(/)
  assert.match(managerSource, /Provider id \$\{providerId\} 已保留给/)
  assert.match(managerSource, /Provider id 已被插件 \$\{running\.descriptor\.id\} 注册/)
})

test('plugin host enforces declared settings permission before private settings access', () => {
  assert.match(pluginHostSource, /message\.manifest\.permissions/)
  assert.match(pluginHostSource, /createSettingsApi\(/)
  assert.match(pluginHostSource, /requireLocalPermission\([^)]*'settings'/)
})

test('plugin manager exposes declarative manifest themes without executing theme scripts', () => {
  assert.match(managerSource, /normalizeDeclarativeThemeContributions/)
  assert.match(managerSource, /descriptor\.contributes/)
  assert.match(managerSource, /manifest theme/)
  assert.match(managerSource, /normalizeThemeContribution/)
  assert.match(managerSource, /loggedThemeCompatibilityNotes/)
  assert.match(themeContributionSource, /pluginApiVersion < 2/)
  assert.match(themeContributionSource, /findUnsupportedThemeModeIds/)
})

test('plugin manager blocks bundled plugin uninstall while allowing disable', () => {
  assert.match(managerSource, /async disable\(id: string\)/)
  assert.match(managerSource, /async uninstall\(id: string/)
  assert.match(managerSource, /this\.isBundledPluginId\(id\)/)
  assert.match(managerSource, /自带插件不能卸载/)
})

test('plugin manager isolates startup failures and keeps other enabled plugins loading', () => {
  assert.match(managerSource, /private async scanAndStartEnabled\(\)/)
  assert.match(managerSource, /for \(const descriptor of startupPlan\.ordered\)/)
  assert.match(
    managerSource,
    /await this\.startPlugin\(descriptor\)\.catch\(\(error\) => \{[\s\S]*this\.markFailed\(\s*descriptor\.id/
  )
})

test('plugin lifecycle stop is single-flight and stale process events cannot discard a replacement', () => {
  assert.match(
    managerSource,
    /private readonly stopOperations = new Map<string, Promise<void>>\(\)/
  )
  assert.match(managerSource, /const existingStop = this\.stopOperations\.get\(id\)/)
  assert.match(managerSource, /if \(existingStop\) return existingStop/)
  assert.match(managerSource, /await this\.stopOperations\.get\(descriptor\.id\)/)
  assert.match(
    managerSource,
    /child\.on\('exit',[\s\S]*if \(this\.running\.get\(descriptor\.id\) !== running\) return/
  )
  assert.match(
    managerSource,
    /if \(this\.running\.get\(id\) === running\) \{\s*await this\.dynamicIsland\?\.hide\(id\)\s*this\.running\.delete\(id\)/
  )
})

test('provider and UI RPC cancellation is wired through protocol, host AbortSignal, and public typings', () => {
  assert.match(pluginTypesSource, /kind: 'cancel'[\s\S]*requestId: string[\s\S]*reason: string/)
  assert.match(pluginHostSource, /const pendingPluginCalls = new Map<string, AbortController>\(\)/)
  assert.match(pluginHostSource, /cancelPluginCall\(message\.requestId, message\.reason\)/)
  assert.match(pluginHostSource, /signal: controller\.signal/)
  assert.match(pluginHostSource, /abortPendingPluginCalls\('Plugin is being deactivated\.'\)/)
  assert.match(
    pluginApiSource,
    /interface TwilightProviderRequestContext[\s\S]*signal: AbortSignal/
  )
  assert.match(pluginApiSource, /interface TwilightUiCommandContext[\s\S]*signal: AbortSignal/)
  assert.match(managerSource, /interface TwilightProviderCallOptions[\s\S]*signal\?: AbortSignal/)
  assert.match(managerSource, /kind: 'provider-call'[\s\S]*signal: options\.signal/)
})

test('provider downloads are capability-gated and final file access remains host-only', () => {
  assert.match(pluginApiSource, /\| 'download'/)
  assert.match(pluginApiSource, /createDownload\?\(/)
  assert.match(pluginApiSource, /getDownloadStatus\?\(/)
  assert.match(pluginApiSource, /getDownloadFile\?\(/)
  assert.match(pluginApiSource, /cancelDownload\?\(/)
  assert.match(rpcCoordinatorSource, /'createDownload'/)
  assert.match(pluginHostSource, /'getDownloadFile'/)
  assert.match(pluginIpcSource, /const HOST_ONLY_PROVIDER_METHODS/)
  assert.match(pluginIpcSource, /provider download methods are host-only/)
})

test('provider write idempotency is connected from renderer bridge through host request context', () => {
  assert.match(preloadSource, /providerWriteIdempotency\.begin\(/)
  assert.match(rpcCoordinatorSource, /const IDEMPOTENT_PROVIDER_WRITE_METHODS/)
  assert.match(
    rpcCoordinatorSource,
    /IDEMPOTENT_PROVIDER_WRITE_METHODS[\s\S]*'completeCloudUpload'/
  )
  assert.match(rpcCoordinatorSource, /IDEMPOTENT_PROVIDER_WRITE_METHODS[\s\S]*'createDownload'/)
  assert.match(managerSource, /kind: 'provider-call'[\s\S]*idempotencyKey/)
  assert.match(pluginHostSource, /idempotencyKey: message\.idempotencyKey/)
  assert.match(pluginApiSource, /idempotencyKey\?: string/)
})

test('plugin manager exposes per-plugin logs for troubleshooting', () => {
  assert.match(managerSource, /async openLog\(id: string\)/)
  assert.match(managerSource, /async getLog\(id: string\)/)
  assert.match(managerSource, /raw\.slice\(-20000\)/)
  assert.match(managerSource, /private appendLog\(descriptor: TwilightPluginDescriptor/)
  assert.match(managerSource, /logs', 'plugins'/)
})

test('plugin manager tracks provider health for calls and plugin failures', () => {
  assert.match(providerRoutingSource, /export interface ProviderHealthRecord/)
  assert.match(managerSource, /private readonly providerHealth = new Map/)
  assert.match(managerSource, /private getProviderHealth\(/)
  assert.match(providerRoutingSource, /export function normalizeProviderHealth\(/)
  assert.match(managerSource, /private recordProviderCallSuccess\(/)
  assert.match(managerSource, /private recordProviderCallFailure\(/)
  assert.match(providerRoutingSource, /export interface ProviderMethodHealthRecord/)
  assert.match(providerRoutingSource, /methodStats:/)
  assert.match(providerRoutingSource, /successRate:/)
  assert.match(providerRoutingSource, /totalCalls:/)
  assert.match(providerRoutingSource, /failedCalls:/)
  assert.match(providerRoutingSource, /lastError:/)
  assert.match(managerSource, /pluginStatus:/)
  assert.match(
    managerSource,
    /const health = normalizeProviderHealth\(record\.health,\s*providerId,\s*pluginId/
  )
  assert.match(managerSource, /if \(health\) this\.providerHealth\.set\(providerId,\s*health\)/)
  assert.match(
    managerSource,
    /this\.recordProviderCallSuccess\(\s*completion\.metadata\.providerId,\s*completion\.metadata\.pluginId,\s*completion\.metadata\.method/
  )
  assert.match(
    managerSource,
    /this\.recordProviderCallFailure\(\s*completion\.metadata\.providerId,\s*completion\.metadata\.pluginId,\s*completion\.metadata\.method/
  )
  assert.match(managerSource, /health: this\.getProviderHealth/)
})

test('plugin host forwards provider health registration metadata', () => {
  assert.match(pluginHostSource, /health\?: Record<string, unknown>/)
  assert.match(pluginHostSource, /health: provider\.health/)
})

test('specialized windows receive only their scoped preload APIs', () => {
  const miniPlayerApi = preloadSource.match(/const miniPlayerWindowApi = \{[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(preloadSource, /exposedApiForDocument\(\)/)
  assert.match(
    preloadSource,
    /if \(isDesktopLyricsDocument\(\)\)\s+return \{\s*core: coreApi,\s*diagnostics: diagnosticsApi,\s*desktopLyrics: desktopLyricsWindowApi,\s*experienceWindow: experienceWindowApi\s*\}/
  )
  assert.match(
    preloadSource,
    /if \(isMiniPlayerDocument\(\)\) \{[\s\S]*?return \{\s*core: coreApi,\s*diagnostics: diagnosticsApi,\s*miniPlayer: miniPlayerWindowApi,\s*data: miniPlayerCoverDataApi,\s*experienceWindow: experienceWindowApi\s*\}/
  )
  // The lyrics window is the shared renderer document with a `window` query now.
  assert.match(preloadSource, /get\('window'\) === 'desktop-lyrics'/)
  assert.match(preloadSource, /get\('window'\) === 'mini-player'/)
  assert.match(miniPlayerApi, /chooseBackgroundImage/)
  assert.doesNotMatch(miniPlayerApi, /ipcRenderer\.(?:invoke|send)\('(?:settings|shell|dialog):/)
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\('electron'/)
})

test('provider results replace approved remote media URLs before returning to the renderer', () => {
  const platform = readFileSync(new URL('./platform.ts', import.meta.url), 'utf8')
  assert.match(platform, /return protectProviderMedia\(value, method\)/)
  assert.match(managerSource, /await this\.platform\.protectProviderResult\(message\.value, metadata\.method\)/)
})

test('plugin host logs rotate at a bounded size and append through a serialized write chain', () => {
  assert.match(managerSource, /const PLUGIN_LOG_MAX_BYTES = \d+/)
  assert.match(managerSource, /logWriteChains = new Map<string, Promise<void>>/)
  assert.match(managerSource, /logSizes = new Map<string, number>/)
  const appendLog = managerSource.match(
    /private appendLog\(descriptor: TwilightPluginDescriptor, level: string, message: string\): void \{([\s\S]*?)\n  \}/
  )
  assert.ok(appendLog, 'appendLog should exist')
  const body = appendLog[1]
  assert.match(body, /size \+ lineBytes > PLUGIN_LOG_MAX_BYTES/)
  assert.match(body, /await rm\(previousLogPath, \{ force: true \}\)/)
  assert.match(body, /await rename\(logPath, previousLogPath\)/)
  assert.match(body, /this\.logWriteChains\.get\(logPath\) \?\? Promise\.resolve\(\)/)
})

test('plugin hosts hibernate when idle and wake on demand without losing contributions', () => {
  const hostIdleSource = readFileSync(new URL('../../core/plugins/hostIdle.ts', import.meta.url), 'utf8')
  assert.match(hostIdleSource, /export class PluginHostIdleTracker/)
  // Provider routing, UI commands, health, and takeover checks all see hibernated plugins.
  assert.match(
    managerSource,
    /private contributingPlugins\(\): Array<RunningPlugin \| HibernatedPlugin>/
  )
  assert.match(
    managerSource,
    /findProviderRoute\(this\.contributingPlugins\(\), normalizedProviderId, method\)/
  )
  assert.match(managerSource, /dedupeProviderRegistrations\(this\.contributingPlugins\(\)\)/)
  assert.match(managerSource, /const owner = this\.contributingPlugins\(\)\.find/)
  // A call to a hibernated plugin wakes it through the single-flight queue.
  assert.match(
    managerSource,
    /const running = route \? await this\.ensureRunningForCall\(route\.descriptor\.id\) : null/
  )
  assert.match(managerSource, /private wakePlugin\(id: string\): Promise<RunningPlugin>/)
  assert.match(managerSource, /const existing = this\.wakeOperations\.get\(id\)/)
  // Busy hosts (pending RPCs, internal NCM requests, trial runs, Qishui auth) never hibernate.
  assert.match(managerSource, /if \(this\.rpcCalls\.getPendingCount\(id\) > 0\) return false/)
  assert.match(managerSource, /if \(id === QISHUI_PLUGIN_ID\) return false/)
  assert.match(
    managerSource,
    /if \(!running \|\| running\.trial \|\| this\.shuttingDown\) return false/
  )
  // Explicit stops forget the snapshot; only hibernation keeps it.
  assert.match(
    managerSource,
    /if \(!this\.hibernating\.has\(id\)\) \{\s*this\.hibernated\.delete\(id\)/
  )
  // Boot restores cached contributions instead of forking when version and entry file match.
  assert.match(managerSource, /if \(this\.hibernateFromCache\(descriptor\)\) return/)
  assert.match(managerSource, /cached\.mainSignature !== signature/)
  assert.match(managerSource, /if \(this\.shuttingDown \|\| name === 'app:before-quit'\) return/)
  // P2-A: provider+ui hibernation, shutdown contribution preservation, and bundled sync timestamp preservation.
  assert.match(managerSource, /private supportsProviderHostHibernation\(/)
  assert.match(managerSource, /if \(!running\.trial && !this\.shuttingDown\) this\.forgetContributions\(id\)/)
  assert.match(managerSource, /preserveTimestamps: true/)
  const coreRuntimeSource = readFileSync(
    new URL('../app/coreApplicationRuntime.ts', import.meta.url),
    'utf8'
  )
  assert.match(coreRuntimeSource, /hostIdleTimeoutMs:\s*15_000/)
})
