import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import type { AudioWorkspaceTab } from '../app/useAppNavigation.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript') as typeof import('typescript')
const source = readFileSync(new URL('./AudioWorkspace.vue', import.meta.url), 'utf8')
const descriptor = parse(source).descriptor
const compiled = typescript.transpileModule(
  compileScript(descriptor, { id: 'audio-workspace-test' }).content,
  {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS
    }
  }
).outputText

interface ChildPage {
  requestLeave: () => Promise<boolean>
  refreshFromEngine?: () => Promise<void>
}
interface WorkspaceSetup {
  portalTarget: Vue.ShallowRef<HTMLElement | null>
  openEditorWindow: () => void
  pageRef: Vue.Ref<ChildPage | null>
  busy: Vue.ComputedRef<boolean>
  dspPending: Vue.Ref<boolean>
  dspEnabled: Vue.ComputedRef<boolean>
  errorMessage: Vue.Ref<string>
  requestLeave: () => Promise<boolean>
  requestTabChange: (tab: AudioWorkspaceTab) => Promise<void>
  toggleDsp: () => Promise<void>
  onTabKeydown: (event: KeyboardEvent) => void
}

function createWorkspace(tab: AudioWorkspaceTab = 'equalizer') {
  const events: AudioWorkspaceTab[] = []
  const updates: { dspEnabled: boolean }[] = []
  const focused: string[] = []
  const props = Vue.reactive({ tab })
  const audioStore = Vue.reactive({
    audioProcessing: { dspEnabled: false },
    setAudioProcessing: async (
      patch: { dspEnabled: boolean },
      options: { throwOnError: boolean }
    ) => {
      assert.equal(options.throwOnError, true)
      updates.push({ ...patch })
      audioStore.audioProcessing.dspEnabled = patch.dspEnabled
    }
  })
  let beforeUnmount = () => {}
  let exposed: { requestLeave: () => Promise<boolean> } | undefined
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => WorkspaceSetup } } }
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      if (specifier === 'vue')
        return {
          ...Vue,
          onBeforeUnmount: (callback: () => void) => {
            beforeUnmount = callback
          }
        }
      if (specifier.endsWith('/useAudioOutputDspStore'))
        return { useAudioOutputDspStore: () => audioStore }
      if (specifier.endsWith('/AppBackgroundLayer.vue')) return { default: {} }
      if (specifier.endsWith('/useDspEditorWindow'))
        return {
          useDspEditorWindow: (onChange: (detached: boolean) => void) => {
            const target = Vue.shallowRef<HTMLElement | null>(null)
            return {
              target,
              open: () => {
                target.value = {} as HTMLElement
                onChange(true)
              },
              focus: () => {},
              dock: async () => {
                target.value = null
                onChange(false)
              }
            }
          }
        }
      throw new Error(`Unexpected setup dependency: ${specifier}`)
    },
    document: { getElementById: (id: string) => ({ focus: () => focused.push(id) }) }
  })
  const state = module.exports.default.setup(props, {
    emit: (event: 'switchTab' | 'detachedChange', nextTab: AudioWorkspaceTab) => {
      if (event !== 'switchTab') return
      events.push(nextTab)
      props.tab = nextTab
    },
    expose: (api: typeof exposed) => {
      exposed = api
    }
  })
  return {
    state,
    props,
    events,
    updates,
    focused,
    audioStore,
    unmount: () => beforeUnmount(),
    exposed
  }
}

test('workspace tab switches commit the current page first, respect refusal, and focus the selected tab', async () => {
  const workspace = createWorkspace()
  let allow = false
  let attempts = 0
  workspace.state.pageRef.value = {
    requestLeave: async () => {
      attempts += 1
      return allow
    }
  }
  await workspace.state.requestTabChange('equalizer')
  assert.equal(attempts, 0)
  await workspace.state.requestTabChange('effects')
  assert.deepEqual(workspace.events, [])
  allow = true
  await workspace.state.requestTabChange('effects')
  assert.equal(attempts, 2)
  assert.deepEqual(workspace.events, ['effects'])
  assert.deepEqual(workspace.focused, ['audio-workspace-tab-effects'])
  assert.equal(typeof workspace.exposed?.requestLeave, 'function')
  assert.deepEqual(workspace.updates, [])
})

test('detaching keeps the draft live and permits browsing without asking the editor to discard it', async () => {
  const workspace = createWorkspace('effects')
  let leaves = 0
  workspace.state.pageRef.value = {
    requestLeave: async () => {
      leaves += 1
      return false
    }
  }
  workspace.state.openEditorWindow()
  assert.ok(workspace.state.portalTarget.value)
  assert.equal(await workspace.exposed!.requestLeave(), true)
  assert.equal(leaves, 0)
  await workspace.state.toggleDsp()
  assert.equal(leaves, 1)
  assert.deepEqual(workspace.updates, [])
})

test('pending or unloaded child pages block duplicate switches and external navigation', async () => {
  const workspace = createWorkspace()
  assert.equal(await workspace.state.requestLeave(), false)
  let release!: (allowed: boolean) => void
  workspace.state.pageRef.value = {
    requestLeave: () =>
      new Promise<boolean>((resolve) => {
        release = resolve
      })
  }
  const pending = workspace.state.requestTabChange('effects')
  assert.equal(workspace.state.busy.value, true)
  assert.equal(await workspace.state.requestLeave(), false)
  await workspace.state.requestTabChange('effects')
  release(true)
  await pending
  assert.deepEqual(workspace.events, ['effects'])
  assert.equal(workspace.state.busy.value, false)
})

test('guard failures and late unmount resolutions do not switch away or hide errors', async () => {
  const workspace = createWorkspace()
  workspace.state.pageRef.value = {
    requestLeave: async () => {
      throw new Error('save failed')
    }
  }
  await workspace.state.requestTabChange('effects')
  assert.deepEqual(workspace.events, [])
  assert.match(workspace.state.errorMessage.value, /save failed/)
  workspace.state.pageRef.value = { requestLeave: async () => true }
  const pending = workspace.state.requestTabChange('effects')
  workspace.unmount()
  await pending
  assert.deepEqual(workspace.events, [])
})

test('master DSP only changes after explicit click and protected effects state refreshes after success', async () => {
  const workspace = createWorkspace('effects')
  const calls: string[] = []
  workspace.state.pageRef.value = {
    requestLeave: async () => {
      calls.push('leave')
      return true
    },
    refreshFromEngine: async () => {
      calls.push('refresh')
    }
  }
  assert.deepEqual(workspace.updates, [])
  assert.equal(workspace.state.dspEnabled.value, false)
  await workspace.state.toggleDsp()
  assert.deepEqual(workspace.updates, [{ dspEnabled: true }])
  assert.deepEqual(calls, ['leave', 'refresh'])
  assert.equal(workspace.state.dspEnabled.value, true)
  await workspace.state.toggleDsp()
  assert.deepEqual(workspace.updates, [{ dspEnabled: true }, { dspEnabled: false }])
  assert.equal(workspace.state.dspEnabled.value, false)
})

test('master DSP cannot race pending engine writes or bypass a refused child draft', async () => {
  const workspace = createWorkspace()
  workspace.state.pageRef.value = { requestLeave: async () => false }
  await workspace.state.toggleDsp()
  assert.deepEqual(workspace.updates, [])
  workspace.state.pageRef.value = { requestLeave: async () => true }
  let reject!: (error: Error) => void
  let started!: () => void
  const applying = new Promise<void>((resolve) => {
    started = resolve
  })
  workspace.audioStore.setAudioProcessing = () =>
    new Promise<void>((_resolve, fail) => {
      reject = fail
      started()
    })
  const pending = workspace.state.toggleDsp()
  await applying
  assert.equal(workspace.state.dspPending.value, true)
  assert.equal(await workspace.state.requestLeave(), false)
  await workspace.state.toggleDsp()
  reject(new Error('engine unavailable'))
  await pending
  assert.equal(workspace.state.dspEnabled.value, false)
  assert.match(workspace.state.errorMessage.value, /engine unavailable/)
  assert.equal(workspace.state.busy.value, false)
})

test('workspace mounts one embedded audio page at a time without retaining hidden workers', () => {
  const equalizerTag = descriptor.template!.content.match(/<EqualizerPage\b[^>]*\/>/)?.[0]
  const effectsTag = descriptor.template!.content.match(/<DspRackPage\b[^>]*\/>/)?.[0]
  assert.ok(equalizerTag)
  assert.ok(effectsTag)
  assert.match(equalizerTag, /\bv-if\s*=\s*"tab === 'equalizer'"/)
  assert.match(effectsTag, /\bv-else\b/)
  for (const tag of [equalizerTag, effectsTag]) {
    assert.match(tag, /\bref\s*=\s*"pageRef"/)
    assert.match(tag, /\bembedded\b/)
  }
  assert.match(equalizerTag, /:navigation-locked\s*=\s*"busy"/)
  assert.doesNotMatch(source, /KeepAlive/)
  assert.match(descriptor.template!.content, /DSP 已关闭，均衡器和效果链的调整暂不影响播放声音/)
})
