import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref, watch } from 'vue'
import { createLibraryHomeStatus } from '../../stores/library/libraryHomeStatus.ts'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const metadata = (revision: number, trackCount: number) => ({
  revision,
  trackCount,
  fileCount: trackCount,
  folders: [],
  exclusions: []
})

test('home status serializes scan storms, discards superseded revisions and stops at unmount', async () => {
  let calls = 0,
    complete!: (value: ReturnType<typeof metadata>) => void
  const home = createLibraryHomeStatus({
    getStorageMode: async () => 'sqlite',
    api: {
      getMetadata: async () => {
        calls++
        return new Promise((resolve) => {
          complete = resolve
        })
      }
    }
  })
  home.refresh()
  await tick()
  assert.equal(calls, 1)
  for (let revision = 1; revision <= 500; revision++) home.refresh(revision)
  assert.equal(calls, 1)
  complete(metadata(1, 100))
  await tick()
  assert.equal(home.state.value.total, null)
  assert.equal(calls, 2)
  complete(metadata(500, 405))
  await tick()
  assert.equal(home.state.value.total, 405)
  for (let i = 0; i < 500; i++) home.refresh(500)
  assert.equal(calls, 2)
  home.refresh(501)
  home.refresh(502)
  home.dispose()
  complete(metadata(501, 0))
  await tick()
  assert.equal(home.state.value.total, 405)
  assert.equal(calls, 3)
})

test('production home routing reads Core metadata and exposes retry without renderer library access', async () => {
  const source = readFileSync(new URL('./LocalHome.vue', import.meta.url), 'utf8')
  const ast = ts.createSourceFile(
    'home.ts',
    source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1],
    ts.ScriptTarget.Latest,
    true
  )
  const script = ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
  let fail = true,
    reads = 0,
    metadataCount = 405
  const mounts: Array<() => void> = [],
    unmounts: Array<() => void> = []
  const coreState = ref<{ phase: string; epoch: string; libraryRevision: number | null }>({
    phase: 'ready',
    epoch: 'epoch-1',
    libraryRevision: 1
  })
  const settings = ref<{ homePageMode?: 'auto' | 'local' | 'streaming' }>({ homePageMode: 'auto' })
  const entry = runInNewContext(
    ts.transpileModule(
      script + '\n;({home,homeState,emptyLibrary,showOnlineDashboard,homePending})',
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
      }
    ).outputText,
    {
      computed,
      watch,
      defineAsyncComponent: () => ({}),
      onMounted: (fn: () => void) => mounts.push(fn),
      onBeforeUnmount: (fn: () => void) => unmounts.push(fn),
      defineProps: () => ({}),
      defineEmits: () => () => {},
      useThemeStore: () => ({ presetLayout: ref('default') }),
      useSettingsStore: () => ({ settings }),
      useCoreConnection: () => ({
        state: coreState,
        query: async () => {
          reads++
          if (fail) throw new Error('Core offline')
          return metadata(coreState.value.libraryRevision ?? reads, metadataCount)
        }
      }),
      createLibraryHomeStatus
    }
  ) as {
    home: ReturnType<typeof createLibraryHomeStatus>
    homeState: { value: { error: string } }
    emptyLibrary: { value: boolean }
    showOnlineDashboard: { value: boolean }
    homePending: { value: boolean }
  }
  assert.equal(entry.homePending.value, true)
  for (const mount of mounts) mount()
  await tick()
  assert.equal(entry.homeState.value.error, 'Core offline')
  assert.equal(entry.emptyLibrary.value, false, 'Core failure is not an empty library')
  fail = false
  entry.home.refresh()
  await tick()
  assert.equal(entry.homeState.value.error, '')
  assert.equal(entry.emptyLibrary.value, false)
  assert.equal(entry.showOnlineDashboard.value, false)
  settings.value = { homePageMode: 'streaming' }
  assert.equal(
    entry.showOnlineDashboard.value,
    true,
    'Explicit streaming homePageMode selects online home even when local library has tracks'
  )
  settings.value = { homePageMode: 'auto' }
  metadataCount = 0
  coreState.value = { ...coreState.value, libraryRevision: 2 }
  await tick()
  assert.equal(
    entry.emptyLibrary.value,
    true,
    'Core metadata selects online home for an empty library'
  )
  assert.equal(entry.showOnlineDashboard.value, true)
  settings.value = { homePageMode: 'local' }
  assert.equal(
    entry.showOnlineDashboard.value,
    false,
    'Explicit local homePageMode keeps local home even when library is empty'
  )
  assert.equal(entry.homePending.value, false)
  for (const unmount of unmounts) unmount()
  const previous = reads
  coreState.value = { ...coreState.value, libraryRevision: 3 }
  await tick()
  assert.equal(reads, previous)
  assert.match(source, /v-else-if="showOnlineDashboard"/)
  assert.doesNotMatch(source, /window\.api\.library/)
})
