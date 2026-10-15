import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const declaration = app.match(/async function runAfterAudioLeave\([\s\S]*?\n\}/)?.[0]
assert.ok(declaration)

function createGuard(requestLeave: () => Promise<boolean>) {
  const context = {
    showAudioWorkspace: { value: true },
    audioWorkspaceRef: {
      value: { requestLeave } as { requestLeave: () => Promise<boolean> } | null
    },
    navigation: { session: { value: { overlay: 'dsp' } } }
  }
  const run = runInNewContext(
    `let leavingAudioWorkspace = false;\n${stripTypeScriptTypes(declaration!)}\nrunAfterAudioLeave`,
    context
  ) as (action: () => void | Promise<void>) => Promise<void>
  return { context, run }
}

test('shell navigation waits for audio commits and leaves refused drafts on the current page', async () => {
  let allow = false
  const events: string[] = []
  const guard = createGuard(async () => {
    events.push('leave')
    return allow
  })
  await guard.run(() => {
    events.push('navigate')
  })
  assert.deepEqual(events, ['leave'])
  allow = true
  await guard.run(() => {
    events.push('navigate')
  })
  assert.deepEqual(events, ['leave', 'leave', 'navigate'])
})

test('shell suppresses repeated navigation while one audio leave request is pending', async () => {
  let release!: (allowed: boolean) => void
  let attempts = 0
  let navigations = 0
  const guard = createGuard(() => {
    attempts += 1
    return new Promise<boolean>((resolve) => {
      release = resolve
    })
  })
  const pending = guard.run(() => {
    navigations += 1
  })
  await guard.run(() => {
    navigations += 100
  })
  assert.equal(attempts, 1)
  release(true)
  await pending
  assert.equal(navigations, 1)
})

test('shell cancels stale leave completions after another surface or child has replaced the source', async () => {
  for (const replace of ['overlay', 'child']) {
    let release!: (allowed: boolean) => void
    let navigations = 0
    const guard = createGuard(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    const pending = guard.run(() => {
      navigations += 1
    })
    if (replace === 'overlay') guard.context.navigation.session.value.overlay = 'settings'
    else guard.context.audioWorkspaceRef.value = { requestLeave: async () => true }
    release(true)
    await pending
    assert.equal(navigations, 0, replace)
  }
})

test('shell blocks navigation during initial workspace load but keeps ordinary pages immediate', async () => {
  const guard = createGuard(async () => true)
  guard.context.audioWorkspaceRef.value = null
  let navigations = 0
  await guard.run(() => {
    navigations += 1
  })
  assert.equal(navigations, 0)
  guard.context.showAudioWorkspace.value = false
  const pending = guard.run(() => {
    navigations += 1
  })
  assert.equal(navigations, 1)
  await pending
})
