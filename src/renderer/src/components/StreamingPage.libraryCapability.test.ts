import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { effectScope, nextTick, ref, watch } from 'vue'
import { getNavigationLibraryProviders } from '../utils/streamingNavigation.ts'

const source = readFileSync(new URL('./StreamingPage.vue', import.meta.url), 'utf8')
const ast = ts.createSourceFile(
  'page.ts',
  source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1],
  ts.ScriptTarget.Latest,
  true
)
const nodes = ast.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) &&
      ['providerSupportsLibrary', 'ensureExternalLibraryLoaded'].includes(node.name?.text ?? '')) ||
    (ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'watch' &&
      ['activeProvider', 'activeTab'].includes(node.expression.arguments[0]?.getText(ast)))
)
const code = ts.transpileModule(nodes.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

function fixture(t: { after(fn: () => void): void }, supported = true) {
  const calls: string[] = []
  const state = {
    loggedIn: true,
    libraryLoaded: false,
    libraryLoading: false,
    libraryError: '',
    playlists: [],
    likedPlaylist: null,
    pinnedPlaylistIds: []
  }
  const activeProvider = ref('search-only')
  const activeTab = ref('home')
  const fallbackProvider = ref<string | null>(null)
  const libraryProviders = ref(
    getNavigationLibraryProviders({
      ncmAvailable: false,
      providers: [
        {
          id: 'search-only',
          name: 'Search',
          capabilities: ['search'],
          supportedMethods: ['search']
        },
        { id: 'missing-method', name: 'Missing', capabilities: ['library'], supportedMethods: [] },
        ...(supported
          ? [
              {
                id: 'personal',
                name: 'Personal',
                capabilities: ['library'],
                supportedMethods: ['fetchUserLibrary']
              }
            ]
          : [])
      ]
    })
  )
  const bindings = {
    watch,
    restoringPage: false,
    browseContexts: Promise.resolve([]),
    captureBrowseContexts: async () => [],
    activeProvider,
    activeTab,
    fallbackProvider,
    libraryProviders,
    props: { active: true },
    NCM_PROVIDER_ID: 'ncm',
    ensureExternalState: () => state,
    isProviderAvailable: () => true,
    providerStore: {
      fetchUserLibrary: async (id: string) => {
        calls.push(id)
        return { likedPlaylist: null, playlists: [{ id: 'a', pinned: true }] }
      }
    },
    friendlyStreamingError: (error: Error) => error.message,
    externalProviderName: () => 'Provider',
    resetDetail: () => {},
    clearSearch: () => {},
    detailNavigationProvider: null,
    playbackNavigationSyncToken: null,
    detailNavigationToken: 1,
    recommendationRequestId: 0,
    recommendationProviderId: ref(''),
    homeSectionDefinitions: ref([]),
    recommendationTracks: ref({}),
    recommendationErrors: ref({}),
    recsError: ref(''),
    recsLoading: ref(false),
    recommendPlaylists: ref([]),
    activeProviderRequiresLogin: ref(false),
    isLoggedIn: ref(true),
    cloudSongs: ref([]),
    ensureLibraryLoaded: async () => {
      calls.push('ncm')
    }
  }
  const scope = effectScope()
  const api = scope.run(() =>
    runInNewContext(code + '\n;({ensureExternalLibraryLoaded})', bindings)
  )!
  t.after(() => scope.stop())
  return { ...bindings, state, calls, api }
}

test('no-login and missing optional methods never request a music library', async (t) => {
  const f = fixture(t)
  await f.api.ensureExternalLibraryLoaded('search-only', true)
  await f.api.ensureExternalLibraryLoaded('missing-method', true)
  assert.deepEqual(f.calls, [])
  assert.equal(f.state.libraryError, '')
  assert.equal(f.state.libraryLoading, false)
})

test('entering library falls back to an implemented provider; absence stays empty', async (t) => {
  for (const supported of [true, false]) {
    const f = fixture(t, supported)
    f.activeTab.value = 'library'
    await nextTick()
    assert.equal(f.fallbackProvider.value, supported ? 'personal' : null)
    assert.deepEqual(f.calls, [])
    f.activeProvider.value = 'missing-method'
    await nextTick()
    assert.deepEqual(f.calls, [])
  }
})

test('implemented libraries preserve login, cache and forced refresh behavior', async (t) => {
  const f = fixture(t)
  f.state.loggedIn = false
  await f.api.ensureExternalLibraryLoaded('personal')
  assert.deepEqual(f.calls, [])
  f.state.loggedIn = true
  await f.api.ensureExternalLibraryLoaded('personal')
  await f.api.ensureExternalLibraryLoaded('personal')
  await f.api.ensureExternalLibraryLoaded('personal', true)
  assert.deepEqual(f.calls, ['personal', 'personal'])
  assert.equal(f.state.libraryLoaded, true)
  assert.equal(f.state.libraryLoading, false)
})
