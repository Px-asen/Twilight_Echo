import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'
import type { AfterglowModeStatus } from '../../../../shared/afterglowMode.ts'

const mode = (phase: AfterglowModeStatus['phase']): AfterglowModeStatus => ({
  phase,
  active: phase !== 'inactive',
  restoreAccelerator: 'CommandOrControl+Shift+E',
  error: null
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function fixture(getStatus: () => Promise<AfterglowModeStatus>) {
  const source = readFileSync(new URL('./AfterglowSettingsSection.vue', import.meta.url), 'utf8')
  const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const ast = ts.createSourceFile('settings.ts', script, ts.ScriptTarget.Latest, true)
  const body = ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
  const mounts: Array<() => void> = []
  const unmounts: Array<() => void> = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  const view = runInNewContext(
    ts.transpileModule(body + '\n({status, active, restoring, transitioning, refreshStatus})', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText,
    {
      computed,
      ref,
      onMounted: (callback: () => void) => mounts.push(callback),
      onBeforeUnmount: (callback: () => void) => unmounts.push(callback),
      useSettingsStore: () => ({
        settings: ref({ afterglowAutoEntry: 'off', unloadHiddenMainWindow: true }),
        updateSettings() {}
      }),
      window: { api: { app: { afterglow: { getStatus } } } },
      setTimeout: (callback: () => void, delay: number) => {
        assert.equal(delay, 250)
        timers.set(++timerId, callback)
        return timerId
      },
      clearTimeout: (id: number) => timers.delete(id)
    }
  )
  return {
    view,
    timers,
    mount: () => mounts.forEach((callback) => callback()),
    unmount: () => unmounts.forEach((callback) => callback()),
    pulse: async () => {
      const [id, callback] = [...timers][0]
      timers.delete(id)
      callback()
      await tick()
    }
  }
}

test('settings mounted during Afterglow adoption refresh until inactive, then stop', async () => {
  let calls = 0
  const f = fixture(async () => mode(++calls < 3 ? 'restoring' : 'inactive'))
  f.mount()
  await tick()
  assert.equal(f.view.active.value, false)
  assert.equal(f.view.restoring.value, true)
  assert.equal(f.view.transitioning.value, true)
  assert.equal(f.timers.size, 1)
  await f.pulse()
  assert.equal(f.timers.size, 1)
  await f.pulse()
  assert.equal(f.view.status.value.phase, 'inactive')
  assert.equal(f.view.transitioning.value, false)
  assert.equal(f.timers.size, 0)
  assert.equal(calls, 3)
  f.unmount()
})

test('stable status does not create a background polling loop', async () => {
  for (const phase of ['inactive', 'active', 'entering'] as const) {
    const f = fixture(async () => mode(phase))
    f.mount()
    await tick()
    assert.equal(f.view.active.value, phase === 'active')
    assert.equal(f.view.transitioning.value, phase === 'entering')
    assert.equal(f.timers.size, 0)
    f.unmount()
  }
})

test('unmount cancels transition polling and ignores an outstanding status reply', async () => {
  const f = fixture(async () => mode('restoring'))
  f.mount()
  await tick()
  f.unmount()
  assert.equal(f.timers.size, 0)
  let resolve!: (status: AfterglowModeStatus) => void
  const pending = fixture(() => new Promise((done) => (resolve = done)))
  pending.mount()
  pending.unmount()
  resolve(mode('restoring'))
  await tick()
  assert.equal(pending.view.status.value, null)
  assert.equal(pending.timers.size, 0)
})

test('failed status refresh stops rather than retrying indefinitely', async () => {
  let calls = 0
  const f = fixture(async () => {
    if (++calls > 1) throw new Error('IPC unavailable')
    return mode('restoring')
  })
  f.mount()
  await tick()
  await f.pulse()
  assert.equal(f.view.status.value, null)
  assert.equal(f.timers.size, 0)
  f.unmount()
})

test('late old query cannot overwrite a newer confirmed status', async () => {
  let resolve!: (status: AfterglowModeStatus) => void
  let calls = 0
  const f = fixture(() =>
    ++calls === 1 ? new Promise((done) => (resolve = done)) : Promise.resolve(mode('inactive'))
  )
  f.mount()
  await f.view.refreshStatus()
  resolve(mode('restoring'))
  await tick()
  assert.equal(f.view.status.value.phase, 'inactive')
  assert.equal(f.timers.size, 0)
  f.unmount()
})
