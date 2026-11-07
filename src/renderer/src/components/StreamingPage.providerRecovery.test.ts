import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { effectScope, nextTick, reactive, ref, watch } from 'vue'
import { PersonalizedQueue } from '../../../core/playback/personalizedQueue.ts'

const source = readFileSync(new URL('./StreamingPage.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true)
const recoveryNodes = ast.statements.filter(
  (node) =>
    (ts.isFunctionDeclaration(node) &&
      ['refreshStreamingSurface', 'playbackNavigationPending'].includes(node.name?.text ?? '')) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ['lastMetadataNavigationKey', 'playbackNavigationInFlight'].includes(declaration.name.getText(ast))
    )) ||
    (ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === 'watch' &&
      ['ncmNavigationAvailable', '() => props.active'].includes(
        node.expression.arguments[0]?.getText(ast)
      ))
)
const code = ts.transpileModule(recoveryNodes.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText

function fixture(t: { after: (fn: () => void) => void }) {
  const calls: string[] = []
  const ncmNavigationAvailable = ref(false)
  const activeProvider = ref('ncm')
  const props = reactive({
    active: true,
    metadataNavigationRequest: null as { key: number } | null
  })
  const bindings = {
    watch,
    ncmNavigationAvailable,
    activeProvider,
    props,
    NCM_PROVIDER_ID: 'ncm',
    activeTab: ref('library'),
    checkLogin: async () => {
      calls.push('login')
    },
    ensureLibraryLoaded: async () => {
      calls.push('library')
    },
    refreshExternalProviderState: async () => {
      calls.push('external')
    },
    loadRecommendations: async () => {
      calls.push('home')
    },
    discovery: {
      ensureLoaded: async () => {
        calls.push('discovery')
      }
    },
    isLoggedIn: ref(true),
    cloudSongs: ref([]),
    refreshCloudSongs: async () => {
      calls.push('cloud')
    }
  }
  const scope = effectScope()
  scope.run(() => runInNewContext(code, bindings))
  t.after(() => scope.stop())
  return { calls, ncmNavigationAvailable, activeProvider, props }
}

async function flush() {
  await nextTick()
  await new Promise<void>((done) => setImmediate(done))
}

test('late NCM registration restores the visible library without leaving the page', async (t) => {
  const f = fixture(t)
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, ['login', 'library'])
  f.ncmNavigationAvailable.value = false
  await flush()
  assert.deepEqual(f.calls, ['login', 'library'], 'disabling must not wake the plugin')
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, ['login', 'library', 'login', 'library'])
})

test('registration on an inactive page defers recovery until the user opens it', async (t) => {
  const f = fixture(t)
  f.props.active = false
  await flush()
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, [])
  f.props.active = true
  await flush()
  assert.deepEqual(f.calls, ['login', 'library'])
})

test('NCM registration leaves the selected external provider alone', async (t) => {
  const f = fixture(t)
  f.activeProvider.value = 'bili'
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, [])
})

for (const key of ['fm', 'radar'] as const) {
  test(`Core ${key} refills at the queue tail after replay without concurrent requests`, async (t) => {
    const queue = { id: 'queue', revision: 1, total: 10, index: 0, occurrenceId: 'entry:0' }
    const calls: string[] = []
    let resolveBatch!: (tracks: unknown[]) => void
    const owner = new PersonalizedQueue({
      queue: () => queue,
      supportedMethods: () => ['fetchPersonalFm', 'fetchPrivateContent'],
      call: async (_provider, method) => { calls.push(method); return new Promise(resolve => { resolveBatch = resolve }) },
      append: async (_id, tracks, current) => { assert.ok(current()); queue.total += tracks.length; return tracks.length },
      now: Date.now, changed() {}
    })
    t.after(() => owner.shutdown())
    owner.attach({ queueId: queue.id, providerId: 'fixture', key })
    owner.observe(true)
    await flush()
    assert.deepEqual(calls, [])
    queue.index = 6
    owner.observe(true)
    await flush()
    assert.deepEqual(calls, [], 'four entries including the current track are above the limit')
    queue.index = 7
    owner.observe(true)
    await flush()
    assert.equal(calls.length, 1)
    assert.equal(calls[0], key === 'fm' ? 'fetchPersonalFm' : 'fetchPrivateContent')
    queue.index = 8
    owner.observe(true)
    await flush()
    assert.equal(calls.length, 1, 'an active refill must prevent concurrent requests')
    const work = owner.refill()
    resolveBatch([10,11,12].map(id => ({ id: String(id), title: String(id), artist: 'Artist', duration: 180 })))
    await work
    owner.observe(true)
    await flush()
    assert.equal(calls.length, 1, 'new queue entries restore enough playback runway')
    queue.index = 10
    owner.observe(true)
    await flush()
    assert.equal(calls.length, 2)
    const second = owner.refill()
    resolveBatch([{ id: '13', title: '13', artist: 'Artist', duration: 180 }])
    await second
    owner.stop()
    owner.observe(true)
    await flush()
    assert.equal(calls.length, 2, 'a completed session must not refill')
  })
}

test('late provider registration does not refresh the root while playback metadata navigation is pending', async (t) => {
  const f = fixture(t)
  f.props.metadataNavigationRequest = { key: 1 }
  f.ncmNavigationAvailable.value = true
  await flush()
  assert.deepEqual(f.calls, [])
  f.props.metadataNavigationRequest = null
  f.props.active = false
  await flush()
  f.props.active = true
  await flush()
  assert.deepEqual(f.calls, ['login', 'library'])
})
