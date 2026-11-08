import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'

const source = readFileSync(new URL('./DownloadResultActions.vue', import.meta.url), 'utf8')
const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
const ast = ts.createSourceFile('download.ts', script, ts.ScriptTarget.Latest, true)
const body = ast.statements
  .filter((s) => !ts.isImportDeclaration(s))
  .map((s) => s.getText(ast))
  .join('\n')
const code = ts.transpileModule(
  `${body}\n({pending,error,indexState,indexError,act,refreshIndexedTrack})`,
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }
).outputText
const turn = async () => {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
}
function fixture(t: test.TestContext) {
  const props = reactive({ task: { id: 'download-1' } })
  const snapshot = ref({ epoch: 'one', libraryRevision: 2, sequence: 1 })
  const calls: { name: string; payload: unknown }[] = []
  let query = async () => ({ indexed: false })
  let failure: Error | null = null
  let unmount = () => {}
  const scope = effectScope()
  const entry = scope.run(() =>
    runInNewContext(code, {
      computed,
      ref,
      watch,
      Error,
      onBeforeUnmount: (callback: () => void) => {
        unmount = callback
      },
      defineProps: () => props,
      useCoreConnection: () => ({
        state: snapshot,
        query: async (name: string, payload: unknown) => {
          calls.push({ name, payload })
          return query()
        },
        command: async (name: string, payload: unknown) => {
          calls.push({ name, payload })
          if (failure) throw failure
        }
      })
    })
  )!
  t.after(() => {
    unmount()
    scope.stop()
  })
  return {
    entry,
    props,
    snapshot,
    calls,
    query: (value: typeof query) => {
      query = value
    },
    fail: (value: Error | null) => {
      failure = value
    }
  }
}

test('download result actions send Core identities, never paths or renderer queue data', async (t) => {
  const f = fixture(t)
  await turn()
  await f.entry.act('play')
  await f.entry.act('reveal')
  await f.entry.act('add')
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.calls.filter((c) => c.name !== 'downloads.indexed'))),
    [
      { name: 'downloads.play', payload: { id: 'download-1' } },
      { name: 'downloads.reveal', payload: { id: 'download-1' } },
      { name: 'downloads.result', payload: { id: 'download-1', addToLibrary: true } }
    ]
  )
  assert.doesNotMatch(script, /targetPath|fallbackTrack|usePlayerStore|window\.api/)
})

test('download projection discards an old identity reply and failed commands remain retryable', async (t) => {
  const f = fixture(t)
  await turn()
  let finish!: (value: { indexed: boolean }) => void
  f.query(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const old = f.entry.refreshIndexedTrack()
  f.query(async () => ({ indexed: false }))
  f.props.task.id = 'download-2'
  await turn()
  finish({ indexed: true })
  await old
  assert.equal(f.entry.indexState.value, 'missing')
  f.fail(new Error('Core write failed'))
  await f.entry.act('play')
  assert.equal(f.entry.error.value, 'Core write failed')
  assert.equal(f.entry.pending.value, false)
  f.fail(null)
  await f.entry.act('play')
  assert.equal(f.entry.error.value, '')
  assert.equal(f.calls.at(-1)?.name, 'downloads.play')
})

test('download library refresh preserves the known state and ignores unrelated snapshots', async t => {
  const f = fixture(t)
  await turn()
  f.snapshot.value = { ...f.snapshot.value, sequence: 2 }; await turn()
  assert.equal(f.calls.length, 1)
  let finish!: (value: { indexed: boolean }) => void
  f.query(() => new Promise(resolve => { finish = resolve }))
  f.snapshot.value.libraryRevision++; await turn()
  assert.equal(f.entry.indexState.value, 'missing')
  finish({ indexed: true }); await turn()
  assert.equal(f.entry.indexState.value, 'indexed')
  f.snapshot.value.libraryRevision++; await turn()
  assert.equal(f.entry.indexState.value, 'indexed')
  finish({ indexed: false }); await turn()
  assert.equal(f.entry.indexState.value, 'missing')
  f.props.task.id = 'download-2'; await turn()
  assert.equal(f.entry.indexState.value, 'checking')
  finish({ indexed: true }); await turn()
  f.snapshot.value.epoch = 'two'; await turn()
  assert.equal(f.entry.indexState.value, 'checking')
  finish({ indexed: false }); await turn()
})
