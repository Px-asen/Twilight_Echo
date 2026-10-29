import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import {
  cloneBands,
  clampNumber,
  defaultAudioProcessing,
  normalizeAudioProcessing,
  patchBand
} from '../utils/equalizerPageLogic.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useEqualizerHistory } from '../composables/useEqualizerHistory.ts'
import { computed, ref } from 'vue'
import { createDspFactoryScene } from '../../../shared/dspGraph.ts'
import { mergeEqualizerPatch } from '../utils/equalizerSettingsPatch.ts'
import { builtInEqPresets } from '../utils/equalizerPageLogic.ts'

const page = readFileSync(new URL('./EqualizerPage.vue', import.meta.url), 'utf8')

function declarations(...names: string[]): string {
  return names
    .map((name) => {
      const declaration = page.match(
        new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`)
      )?.[0]
      assert.ok(declaration, `${name} exists in the EQ page`)
      return stripTypeScriptTypes(declaration)
    })
    .join('\n')
}

test('opening a master-bypassed default scene preserves the separate EQ module switch', () => {
  const declaration = page.match(/function applyActiveSceneEqToEditor\([\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  const scene = createDspFactoryScene('headphoneCorrection', 'default')
  scene.graph.nodes.find((node) => node.type === 'equalizer')!.enabled = false
  const processing = { value: normalizeAudioProcessing({ dspEnabled: false, eqEnabled: true }) }
  const apply = runInNewContext(
    `${stripTypeScriptTypes(declaration)}\napplyActiveSceneEqToEditor`,
    {
      loadedSceneId: null,
      opraCompensationEnabled: { value: false },
      audioProcessing: processing,
      appSettings: { value: null },
      normalizeAudioProcessing,
      structuredClone
    }
  )
  apply({ scenes: [scene], activeSceneId: 'default' })
  assert.equal(processing.value.dspEnabled, false)
  assert.equal(processing.value.eqEnabled, true)
})

test('EQ submits only manual bands to Core and refreshes the acknowledged projection', async () => {
  const initial = normalizeAudioProcessing({ eqMode: 'parametric', eqEnabled: true })
  const submitted: Partial<typeof initial>[] = []
  let refreshes = 0
  const context = {
    Error,
    structuredClone,
    props: { embedded: true },
    loadedSceneId: 'active',
    coreAudio: { getDspSceneState: async () => ({ activeSceneId: 'active' }) },
    audioProcessing: { value: initial },
    autoPreampEnabled: { value: true },
    activeTab: { value: 'graphic' },
    selectedBandIndex: { value: 0 },
    selectedBandIndices: { value: [0] },
    selectBand() {},
    appSettings: { value: { audioProcessing: initial } },
    cloneBands,
    setAudioProcessing: async (
      edit: Partial<typeof initial>,
      options: { throwOnError: boolean }
    ) => {
      assert.equal(options.throwOnError, true)
      submitted.push(edit)
    },
    refreshEqualizerProjection: async () => {
      refreshes++
      context.audioProcessing.value = { ...initial, eqPreamp: -6.5 }
    }
  }
  const apply = runInNewContext(
    `${declarations('applyEqualizerSnapshot')}\napplyEqualizerSnapshot`,
    context
  )
  const snapshot = {
    ...initial,
    eqBands: [{ frequency: 1000, gain: -3, q: 1, filterType: 'peak' as const }]
  }
  await apply(snapshot)
  assert.deepEqual(submitted[0].eqBands, snapshot.eqBands)
  assert.notEqual(submitted[0].eqBands, snapshot.eqBands)
  assert.equal(Object.hasOwn(submitted[0], 'eqPreamp'), false)
  assert.equal(refreshes, 1)
  assert.equal(context.audioProcessing.value.eqPreamp, -6.5)
  assert.equal(context.activeTab.value, 'parametric')
  assert.equal(context.appSettings.value.audioProcessing.eqPreamp, -6.5)
  context.autoPreampEnabled.value = false
  await apply({ ...snapshot, eqPreamp: 2.3 })
  assert.equal(submitted[1].eqPreamp, 2.3)
  context.loadedSceneId = 'old-device-scene'
  await assert.rejects(apply(snapshot), /活动场景已改变/)
  assert.equal(submitted.length, 2)
  assert.equal(refreshes, 2)
})

function createPersistenceHarness() {
  const initial = {
    audioProcessing: {
      ...defaultAudioProcessing,
      eqMode: 'parametric' as const,
      eqBands: cloneBands(defaultAudioProcessing.eqBands)
    },
    audioEqPresets: [] as { name: string; eqBands: typeof defaultAudioProcessing.eqBands }[],
    headphoneCompensation: {
      enabled: true,
      preampDb: -3,
      bands: cloneBands(defaultAudioProcessing.eqBands)
    }
  }
  let persisted = structuredClone(initial)
  const appSettings = ref(structuredClone(initial))
  let refreshes = 0
  const profile = {
    applicable: true,
    productId: 'headphone',
    productName: 'Headphone',
    vendorName: 'Vendor',
    eqId: 'profile',
    author: 'Author',
    details: '',
    link: '',
    preampDb: -2,
    bands: [{ frequency: 200, gain: 2, q: 1, filterType: 'peak' as const }],
    unsupportedBandTypes: []
  }
  const context = {
    Error,
    structuredClone,
    appSettings,
    userPresets: computed(() => appSettings.value.audioEqPresets),
    headphoneCompensation: computed(() => appSettings.value.headphoneCompensation),
    opraCompensationEnabled: computed(() => appSettings.value.headphoneCompensation.enabled),
    audioProcessing: ref(initial.audioProcessing),
    presetName: ref('First'),
    presetError: ref(''),
    opraError: ref(''),
    opraApplyingEqId: ref(''),
    props: { embedded: false },
    loadedSceneId: null,
    saving: ref(false),
    presetMenuOpen: ref(false),
    commitChain: Promise.resolve(),
    finishParametricEdits() {},
    cloneBands,
    autoPreampEnabled: ref(false),
    projectedAudioProcessing: { value: structuredClone(initial.audioProcessing) },
    audioOutputDspStore: {
      refreshAudioOutputState: async () => {
        refreshes++
      }
    },
    core: {
      query: async (name: string, payload: unknown) => {
        if (name === 'audio.dsp') return { autoPreamp: { enabled: false } }
        assert.equal(name, 'opra.profile')
        assert.deepEqual(JSON.parse(JSON.stringify(payload)), { id: profile.eqId })
        return profile
      }
    },
    window: {
      api: {
        settings: {
          update: async (patch: Partial<typeof initial>) => {
            // Model contextBridge's clone before any preload sanitization runs.
            persisted = { ...persisted, ...structuredClone(patch) }
            return structuredClone(persisted)
          }
        }
      }
    },
    console: { error() {} }
  }
  const actions = runInNewContext(
    `${declarations('saveEqPreset', 'disableOpraCompensation', 'applyOpraProfile', 'refreshEqualizerProjection', 'loadAutoPreampPreference')}\n({saveEqPreset,disableOpraCompensation,applyOpraProfile})`,
    context
  ) as {
    saveEqPreset(): Promise<void>
    disableOpraCompensation(): Promise<void>
    applyOpraProfile(value: typeof profile): Promise<void>
  }
  return { context, actions, profile, refreshes: () => refreshes, persisted: () => persisted }
}

test('saving successive presets sends cloneable snapshots of existing reactive bands', async () => {
  const { context, actions, persisted } = createPersistenceHarness()
  await actions.saveEqPreset()
  context.presetName.value = 'Second'
  context.audioProcessing.value.eqBands[0].gain = 5
  await actions.saveEqPreset()
  assert.deepEqual(
    persisted().audioEqPresets.map((preset) => preset.name),
    ['First', 'Second']
  )
  assert.equal(persisted().audioEqPresets[0].eqBands[0].gain, 0)
  assert.equal(persisted().audioEqPresets[1].eqBands[0].gain, 5)
  assert.equal(context.presetError.value, '')
  assert.equal(context.saving.value, false)
})

test('preset persistence failure preserves the name and exposes a retryable error', async () => {
  const { context, actions } = createPersistenceHarness()
  const update = context.window.api.settings.update
  context.window.api.settings.update = async () => {
    throw new Error('disk full')
  }
  await actions.saveEqPreset()
  assert.equal(context.appSettings.value.audioEqPresets.length, 0)
  assert.equal(context.presetName.value, 'First')
  assert.match(context.presetError.value, /disk full/)
  assert.equal(context.saving.value, false)
  context.window.api.settings.update = update
  await actions.saveEqPreset()
  assert.equal(context.presetError.value, '')
  assert.equal(context.appSettings.value.audioEqPresets.length, 1)
})

test('disabling OPRA persists cloneable bands and reloads the Core projection', async () => {
  const { context, actions, refreshes, persisted } = createPersistenceHarness()
  await actions.disableOpraCompensation()
  assert.equal(persisted().headphoneCompensation.enabled, false)
  assert.equal(context.appSettings.value.headphoneCompensation.enabled, false)
  assert.equal(context.opraError.value, '')
  assert.equal(refreshes(), 1)
  assert.deepEqual(
    structuredClone(persisted().headphoneCompensation.bands),
    structuredClone(defaultAudioProcessing.eqBands)
  )
})

test('failed OPRA persistence keeps compensation enabled and exposes the failure', async () => {
  const { context, actions, refreshes, persisted } = createPersistenceHarness()
  context.window.api.settings.update = async () => {
    throw new Error('permission denied')
  }
  await actions.disableOpraCompensation()
  assert.equal(persisted().headphoneCompensation.enabled, true)
  assert.equal(context.appSettings.value.headphoneCompensation.enabled, true)
  assert.match(context.opraError.value, /permission denied/)
  assert.equal(refreshes(), 0)
})

test('applying OPRA fetches the full Core profile without stacking it into the manual editor', async () => {
  const { context, actions, profile, refreshes, persisted } = createPersistenceHarness()
  await actions.applyOpraProfile({ ...profile, bands: [] })
  assert.deepEqual(persisted().headphoneCompensation.bands, profile.bands)
  assert.equal(persisted().headphoneCompensation.preampDb, -2)
  assert.equal(refreshes(), 1)
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.audioProcessing.value.eqBands)),
    defaultAudioProcessing.eqBands
  )
  assert.equal(context.opraApplyingEqId.value, '')
})

test('OPRA scene failure is reported after persistence and a successful retry clears it', async () => {
  const { context, actions, persisted } = createPersistenceHarness()
  const refresh = context.audioOutputDspStore.refreshAudioOutputState
  context.audioOutputDspStore.refreshAudioOutputState = async () => {
    throw new Error('DSP unavailable')
  }
  await actions.disableOpraCompensation()
  assert.equal(persisted().headphoneCompensation.enabled, false)
  assert.equal(context.appSettings.value.headphoneCompensation.enabled, false)
  assert.match(context.opraError.value, /DSP unavailable/)
  context.audioOutputDspStore.refreshAudioOutputState = refresh
  await actions.disableOpraCompensation()
  assert.equal(context.opraError.value, '')
})

test('history keyboard shortcuts leave text undo and modified band shortcuts untouched', () => {
  const declaration = page.match(
    /function onEqualizerKeydown\(event: KeyboardEvent\): void \{[\s\S]*?\n\}/
  )?.[0]
  assert.ok(declaration)
  const commands: string[] = []
  const selections: number[][] = []
  const context = {
    activeTab: { value: 'parametric' },
    historyBusy: { value: false },
    historyLoading: { value: false },
    clipboardBusy: { value: false },
    responseView: { value: 'dsp' },
    selectedBandIndices: { value: [0, 1] },
    selectedBand: { value: {} },
    audioProcessing: { value: { eqBands: [{}, {}] } },
    selectBand: (_index: number, indices: number[]) => selections.push([...indices]),
    runHistoryCommand: (command: string) => commands.push(command),
    toggleBandEnabled: () => commands.push('bypass'),
    deleteBand: () => commands.push('delete'),
    copyBands: () => commands.push('copy'),
    pasteBands: () => commands.push('paste')
  }
  const handler = runInNewContext(
    `${stripTypeScriptTypes(declaration)}\nonEqualizerKeydown`,
    context
  )
  const event = (patch: Record<string, unknown> = {}) => ({
    key: 'z',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    target: { closest: () => null },
    preventDefault() {},
    stopPropagation() {},
    ...patch
  })
  handler(event())
  handler(event({ shiftKey: true }))
  handler(event({ key: 'y', ctrlKey: false, metaKey: true }))
  handler(event({ target: { closest: () => ({}) } }))
  handler(event({ key: 'b' }))
  handler(event({ key: 'a' }))
  handler(event({ key: 'a', target: { closest: () => ({}) } }))
  handler(event({ key: 'c' }))
  handler(event({ key: 'v', ctrlKey: false, metaKey: true }))
  handler(event({ key: 'v', target: { closest: () => ({}) } }))
  context.responseView.value = 'headphone'
  handler(event({ key: 'v' }))
  context.responseView.value = 'dsp'
  context.clipboardBusy.value = true
  handler(event({ key: 'v' }))
  context.clipboardBusy.value = false
  context.historyBusy.value = true
  handler(event())
  assert.deepEqual(commands, ['undo', 'redo', 'redo', 'copy', 'paste'])
  assert.deepEqual(selections, [[0, 1]])
})

test('history actions flush pending gestures before switching the applied snapshot', async () => {
  const declaration = page.match(/async function runHistoryCommand\([\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  const events: string[] = []
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const context = {
    commitChain: pending,
    finishParametricEdits: () => events.push('finish'),
    runEqApply: (action: () => Promise<void>) => action(),
    eqHistory: {
      switchSlot: async (slot: string) => {
        events.push(slot)
      }
    }
  }
  const result = runInNewContext(
    `${stripTypeScriptTypes(declaration)}\nrunHistoryCommand('B')`,
    context
  )
  assert.deepEqual(events, ['finish'])
  release()
  await result
  assert.deepEqual(events, ['finish', 'B'])
})
const chart = readFileSync(
  new URL('./equalizer/FrequencyResponseChart.vue', import.meta.url),
  'utf8'
)
const opra = readFileSync(new URL('./equalizer/OpraEqPanel.vue', import.meta.url), 'utf8')
const graphic = readFileSync(new URL('./equalizer/GraphicEqPanel.vue', import.meta.url), 'utf8')
const toolbar = readFileSync(
  new URL('./equalizer/FrequencyResponseToolbar.vue', import.meta.url),
  'utf8'
)
const equalizerUi = [page, chart, opra, graphic, toolbar].join('\n')

function createAutoPreampHarness() {
  const initial = normalizeAudioProcessing({ eqMode: 'parametric', eqEnabled: true, eqPreamp: 2.3 })
  const state = {
    revision: 7,
    processing: structuredClone(initial),
    autoPreamp: { enabled: false }
  }
  const queries: string[] = []
  const commands: Array<{ revision: number; edit: { kind: string; enabled?: boolean } }> = []
  const processingWrites: Partial<typeof initial>[] = []
  let refreshes = 0
  const context = {
    Error,
    structuredClone,
    cloneBands,
    clampNumber,
    patchBand,
    normalizeAudioProcessing,
    mergeEqualizerPatch,
    props: { embedded: false },
    loadedSceneId: null,
    audioProcessing: { value: structuredClone(initial) },
    projectedAudioProcessing: { value: structuredClone(initial) },
    autoPreampEnabled: { value: false },
    activeTab: { value: 'parametric' },
    selectedBandIndex: { value: 0 },
    selectedBandIndices: { value: [0] },
    selectBand() {},
    appSettings: { value: null },
    commitChain: Promise.resolve(),
    pendingBandPatches: new Map(),
    pendingBandFrame: 0,
    pendingPreamp: null,
    eqApplyFeedback: { value: 'idle' },
    eqApplyError: { value: '' },
    activeEqApply: Promise.resolve(),
    applyFeedbackTimer: null,
    finishParametricEdits() {},
    scheduleStagedFlush() {},
    window: { cancelAnimationFrame() {}, setTimeout: () => 1, clearTimeout() {} },
    core: {
      query: async (name: string) => {
        assert.equal(name, 'audio.dsp')
        queries.push(name)
        return structuredClone(state)
      },
      command: async (name: string, payload: (typeof commands)[number]) => {
        assert.equal(name, 'audio.dsp.edit')
        assert.equal(payload.revision, state.revision)
        commands.push(structuredClone(payload))
        state.autoPreamp.enabled = payload.edit.enabled!
        state.processing.eqPreamp = state.autoPreamp.enabled ? -6.5 : 2.3
        state.revision++
      }
    },
    audioOutputDspStore: {
      refreshAudioOutputState: async () => {
        refreshes++
        context.projectedAudioProcessing.value = structuredClone(state.processing)
      }
    },
    setAudioProcessing: async (patch: Partial<typeof initial>) => {
      processingWrites.push(structuredClone(patch))
      if (patch.eqPreamp !== undefined) state.autoPreamp.enabled = false
      state.processing = { ...state.processing, ...patch }
      state.revision++
    },
    eqHistory: null as unknown as ReturnType<typeof useEqualizerHistory>
  }
  const actions = runInNewContext(
    `${declarations(
      'loadAutoPreampPreference',
      'toggleAutoPreamp',
      'refreshEqualizerProjection',
      'stagePreamp',
      'updatePreampInput',
      'commitStagedBands',
      'flushStagedEdit',
      'updateAudioProcessing',
      'applyEqualizerSnapshot',
      'runEqApply',
      'clearApplyFeedbackTimer'
    )}
      \n({loadAutoPreampPreference,toggleAutoPreamp,updatePreampInput,applyEqualizerSnapshot})`,
    context
  )
  context.eqHistory = useEqualizerHistory(initial, actions.applyEqualizerSnapshot)
  return {
    context,
    actions,
    state,
    queries,
    commands,
    processingWrites,
    refreshes: () => refreshes
  }
}

test('auto compensation uses the current Core revision and reloads its acknowledged state', async () => {
  const { context, actions, commands, queries, refreshes } = createAutoPreampHarness()
  await actions.loadAutoPreampPreference()
  await actions.toggleAutoPreamp()
  assert.deepEqual(commands, [{ revision: 7, edit: { kind: 'autoPreamp', enabled: true } }])
  assert.equal(context.autoPreampEnabled.value, true)
  assert.equal(context.audioProcessing.value.eqPreamp, -6.5)
  assert.equal(context.eqApplyFeedback.value, 'applied')
  assert.equal(refreshes(), 1)
  context.autoPreampEnabled.value = false
  await actions.loadAutoPreampPreference()
  assert.equal(context.autoPreampEnabled.value, true)
  await actions.toggleAutoPreamp()
  assert.deepEqual(commands[1], { revision: 8, edit: { kind: 'autoPreamp', enabled: false } })
  assert.equal(context.audioProcessing.value.eqPreamp, 2.3)
  assert.equal(queries.length, 6)
  assert.doesNotMatch(page, /localStorage|manualPreampBeforeAuto|saveAutoPreampPreference/)
})

test('automatic compensation waits for queued edits and reports Core rejection without publishing state', async () => {
  const { context, actions, commands, queries, refreshes } = createAutoPreampHarness()
  let release!: () => void
  context.commitChain = new Promise<void>((resolve) => {
    release = resolve
  })
  const toggle = actions.toggleAutoPreamp()
  assert.deepEqual(queries, [])
  release()
  await toggle
  assert.equal(commands.length, 1)
  const command = context.core.command
  context.core.command = async () => {
    throw new Error('stale revision')
  }
  await actions.toggleAutoPreamp()
  assert.equal(context.eqApplyFeedback.value, 'failed')
  assert.match(context.eqApplyError.value, /stale revision/)
  assert.equal(context.autoPreampEnabled.value, true)
  assert.equal(context.audioProcessing.value.eqPreamp, -6.5)
  assert.equal(refreshes(), 1)
  context.core.command = command
  await actions.toggleAutoPreamp()
  assert.equal(context.eqApplyFeedback.value, 'applied')
  assert.equal(context.eqApplyError.value, '')
  assert.equal(context.autoPreampEnabled.value, false)
})

test('manual preamp input rejects invalid text, clamps gain and overrides automatic compensation', async () => {
  const { context, actions, processingWrites } = createAutoPreampHarness()
  await actions.toggleAutoPreamp()
  const invalid = { value: '', valueAsNumber: NaN }
  actions.updatePreampInput({ target: invalid })
  assert.equal(invalid.value, '-6.5')
  assert.equal(processingWrites.length, 0)
  const input = { value: '999', valueAsNumber: 999 }
  actions.updatePreampInput({ target: input })
  await context.commitChain
  assert.equal(input.value, '24.0')
  assert.equal(processingWrites[0].eqPreamp, 24)
  assert.equal(context.audioProcessing.value.eqPreamp, 24)
  assert.equal(context.autoPreampEnabled.value, false)
  actions.updatePreampInput({ target: { value: '24', valueAsNumber: 24 } })
  await context.commitChain
  assert.equal(processingWrites.length, 1)
})

test('a manual preamp queued during automatic enable keeps its explicit value after the Core reply', async () => {
  const { context, actions, processingWrites } = createAutoPreampHarness()
  const command = context.core.command
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  context.core.command = async (name, payload) => {
    entered()
    await waiting
    await command(name, payload)
  }
  const enabling = actions.toggleAutoPreamp()
  await started
  actions.updatePreampInput({ target: { value: '3.7', valueAsNumber: 3.7 } })
  release()
  await enabling
  await context.commitChain
  assert.equal(processingWrites[0].eqPreamp, 3.7)
  assert.equal(context.audioProcessing.value.eqPreamp, 3.7)
  assert.equal(context.autoPreampEnabled.value, false)
})

test('preamp controls stay editable in both equalizer modes while automatic compensation is active', () => {
  assert.doesNotMatch(graphic, /:disabled="props\.autoPreampEnabled"/)
  assert.match(page, /aria-label="前级增益"/)
  assert.match(page, /@change="updatePreampInput"/)
  assert.match(page, /@keydown\.enter\.prevent="updatePreampInput"/)
})

test('page orchestrates the extracted equalizer domain panels', () => {
  assert.match(page, /import ParametricEqWorkspace/)
  assert.match(page, /import OpraEqPanel/)
  assert.match(page, /import FrequencyResponseChart/)
  assert.match(page, /import FrequencyResponseToolbar/)
  assert.match(page, /import GraphicEqPanel/)
  assert.match(page, /<OpraEqPanel/)
  assert.match(page, /<FrequencyResponseChart/)
  assert.match(page, /<FrequencyResponseToolbar[\s\S]*card/)
  assert.match(page, /<GraphicEqPanel/)
})

test('graphic equalizer preamp and band sliders support 0.1 dB adjustments', () => {
  assert.match(
    graphic,
    /<input[\s\S]*?type="range"[\s\S]*?min="-24"[\s\S]*?max="24"[\s\S]*?step="0\.1"[\s\S]*?:value="props\.preamp"/
  )
  assert.match(
    graphic,
    /<input[\s\S]*?type="range"[\s\S]*?min="-12"[\s\S]*?max="12"[\s\S]*?step="0\.1"[\s\S]*?:value="band\.gain"/
  )
})

test('graphic sliders preview locally and commit once per gesture', () => {
  // Applying to the engine on every @input issued overlapping async round trips
  // (setAudioProcessing + setDspScenes). Out-of-order responses overwrote the
  // shared state, leaving the board on an earlier gain than the user dragged to
  // while the DSP scene kept the later one.
  assert.match(graphic, /@input="\s*emit\('preview-band', index, \{ gain:/)
  assert.match(graphic, /@input="emit\('preview-preamp',/)
  assert.equal(graphic.match(/@change="emit\('commit'\)"/g)?.length, 2)
  assert.doesNotMatch(graphic, /update-band|update-preamp/)

  assert.match(page, /@preview-band="stageBandPatch"/)
  assert.match(page, /@preview-preamp="stagePreamp"/)
  assert.match(page, /<GraphicEqPanel[\s\S]*?@commit="commitStagedBands"/)

  // The commit must snapshot bands before awaiting, or an in-flight response
  // overwrites this gesture's edit before the patch is built.
  assert.match(
    page,
    /const bands = cloneBands\(audioProcessing\.value\.eqBands\)\s*\n\s*\/\/ Serialize commits/
  )
  // Serialized so a slow earlier response cannot land after a faster later one.
  assert.match(page, /commitChain = commitChain\s*\n?\s*\.then\(/)
  // A settled rejection would make every later slider release fail.
  assert.match(page, /\.catch\(\(error\) => \{/)
})

test('group previews merge atomically and one undo restores all edited bands', async () => {
  const names = ['flushStagedEdit', 'scheduleStagedFlush', 'stageBandPatches', 'commitStagedBands']
  const declarations = names.map((name) => {
    const declaration = page.match(
      new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`)
    )?.[0]
    assert.ok(declaration)
    return stripTypeScriptTypes(declaration)
  })
  const initial = normalizeAudioProcessing({
    ...defaultAudioProcessing,
    eqMode: 'parametric',
    eqEnabled: false,
    dspEnabled: false,
    eqBands: [
      { frequency: 100, gain: 2, q: 1, filterType: 'peak', enabled: false, channelMask: 1 },
      { frequency: 1000, gain: 4, q: 2, filterType: 'peak' }
    ]
  })
  let applies = 0,
    frames = 0
  const context = {
    pendingBandPatches: new Map(),
    pendingBandFrame: 0,
    pendingPreamp: null,
    commitChain: Promise.resolve(),
    audioProcessing: { value: initial },
    appSettings: { value: null },
    autoPreampEnabled: { value: false },
    eqApplyFeedback: { value: 'idle' },
    eqApplyError: { value: '' },
    cloneBands,
    patchBand,
    window: { requestAnimationFrame: () => ++frames, cancelAnimationFrame() {} },
    runEqApply: (action: () => Promise<void>) => action(),
    updateAudioProcessing: (patch: Partial<typeof initial>) =>
      history.commit({ ...context.audioProcessing.value, ...patch })
  }
  const history: ReturnType<typeof useEqualizerHistory> = useEqualizerHistory(
    initial,
    async (snapshot) => {
      applies++
      context.audioProcessing.value = { ...context.audioProcessing.value, ...snapshot }
    }
  )
  const actions = runInNewContext(
    `${declarations.join('\n')}\n({stageBandPatches, commitStagedBands})`,
    context
  )
  actions.stageBandPatches([
    { index: 0, patch: { gain: 4 } },
    { index: 1, patch: { gain: 8 } }
  ])
  actions.stageBandPatches([{ index: 0, patch: { q: 3 } }])
  assert.equal(frames, 1)
  assert.equal(context.audioProcessing.value, initial)
  await actions.commitStagedBands()
  assert.equal(applies, 1)
  assert.equal(context.audioProcessing.value.eqBands[0].q, 3)
  assert.deepEqual(
    context.audioProcessing.value.eqBands.map((band) => band.gain),
    [4, 8]
  )
  assert.equal(context.audioProcessing.value.eqEnabled, false)
  assert.equal(context.audioProcessing.value.dspEnabled, false)
  assert.equal(context.audioProcessing.value.eqBands[0].enabled, false)
  assert.equal(context.audioProcessing.value.eqBands[0].channelMask, 1)
  await history.travel('undo')
  assert.deepEqual(context.audioProcessing.value.eqBands, initial.eqBands)
  assert.equal(history.canUndo.value, false)
  await history.travel('redo')
  assert.deepEqual(
    context.audioProcessing.value.eqBands.map((band) => band.gain),
    [4, 8]
  )
})

test('group delete and bypass operate on the selection in one action', async () => {
  const declarations = ['editedBandIndices', 'deleteBand', 'toggleBandEnabled'].map((name) => {
    const declaration = page.match(
      new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`)
    )?.[0]
    assert.ok(declaration)
    return stripTypeScriptTypes(declaration)
  })
  const bands = defaultAudioProcessing.eqBands
    .slice(0, 4)
    .map((band, index) => ({ ...band, frequency: 100 * (index + 1), enabled: index !== 0 }))
  let submitted: Partial<typeof defaultAudioProcessing> = {},
    enabled: boolean | undefined
  const context = {
    activeTab: { value: 'parametric' },
    selectedBandIndex: { value: 0 },
    selectedBandIndices: { value: [0, 2] },
    audioProcessing: { value: { ...defaultAudioProcessing, eqBands: bands } },
    commitChain: Promise.resolve(),
    eqApplyFeedback: { value: 'applied' },
    finishParametricEdits() {},
    selectBand() {},
    runEqApply: (action: () => Promise<void>) => action(),
    updateAudioProcessing: async (patch: Partial<typeof defaultAudioProcessing>) => {
      submitted = patch
    },
    updateEqBand: async (_index: number, patch: { enabled: boolean }) => {
      enabled = patch.enabled
    }
  }
  const actions = runInNewContext(
    `${declarations.join('\n')}\n({deleteBand, toggleBandEnabled})`,
    context
  )
  await actions.toggleBandEnabled()
  assert.equal(enabled, false)
  context.audioProcessing.value.eqBands[2].enabled = false
  await actions.toggleBandEnabled()
  assert.equal(enabled, true)
  await actions.deleteBand()
  assert.deepEqual(
    submitted.eqBands?.map((band) => band.frequency),
    [200, 400]
  )
})

test('copy preserves selected metadata without history; paste appends one undoable edit', async () => {
  const declarations = ['copyBands', 'pasteBands'].map((name) => {
    const declaration = page.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))?.[0]
    assert.ok(declaration)
    return stripTypeScriptTypes(declaration)
  })
  const initial = normalizeAudioProcessing({
    ...defaultAudioProcessing,
    eqMode: 'parametric',
    eqEnabled: false,
    eqPreamp: -3,
    eqBands: [
      { frequency: 100, gain: 3, q: 2, filterType: 'peak', enabled: false, channelMask: 1 },
      { frequency: 1000, gain: 0, q: 1, filterType: 'highPass', channelMask: 2 }
    ]
  })
  let copied: typeof initial.eqBands = [],
    applies = 0
  const context = {
    audioProcessing: { value: initial },
    activeTab: { value: 'parametric' },
    responseView: { value: 'dsp' },
    selectedBandIndices: { value: [1] },
    clipboardBusy: { value: false },
    clipboardMessage: { value: '' },
    clipboardFailed: { value: false },
    equalizerMounted: true,
    commitChain: Promise.resolve(),
    eqApplyFeedback: { value: 'idle' },
    cloneBands,
    finishParametricEdits() {},
    selectBand: (_index: number, indices: number[]) => {
      context.selectedBandIndices.value = [...indices]
    },
    runEqApply: async (action: () => Promise<void>) => {
      await action()
      context.eqApplyFeedback.value = 'applied'
    },
    updateAudioProcessing: (patch: Partial<typeof initial>) =>
      history.commit({ ...context.audioProcessing.value, ...patch }),
    window: {
      api: {
        window: {
          copyEqBands: async (bands: typeof copied) => {
            copied = bands
          },
          pasteEqBands: async () => cloneBands(copied)
        }
      }
    }
  }
  const history = useEqualizerHistory(initial, async (snapshot) => {
    applies++
    context.audioProcessing.value = { ...context.audioProcessing.value, ...snapshot }
  })
  const actions = runInNewContext(`${declarations.join('\n')}\n({copyBands,pasteBands})`, context)
  await actions.copyBands()
  assert.deepEqual(JSON.parse(JSON.stringify(copied)), [initial.eqBands[1]])
  assert.equal(applies, 0)
  assert.equal(history.canUndo.value, false)
  await actions.copyBands(true)
  assert.deepEqual(JSON.parse(JSON.stringify(copied)), initial.eqBands)
  await actions.pasteBands()
  assert.equal(applies, 1)
  assert.equal(context.audioProcessing.value.eqBands.length, 4)
  assert.deepEqual(context.selectedBandIndices.value, [2, 3])
  assert.equal(context.audioProcessing.value.eqEnabled, false)
  assert.equal(context.audioProcessing.value.eqPreamp, -3)
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.audioProcessing.value.eqBands.slice(2))),
    initial.eqBands
  )
  await history.travel('undo')
  assert.deepEqual(context.audioProcessing.value.eqBands, initial.eqBands)
  assert.equal(history.canUndo.value, false)
  await history.travel('redo')
  assert.equal(context.audioProcessing.value.eqBands.length, 4)
  await history.copyToOther()
  await history.switchSlot('B')
  assert.equal(context.audioProcessing.value.eqBands.length, 4)
  const beforeFailure = applies
  context.window.api.window.pasteEqBands = async () => {
    throw new Error('没有可粘贴的 EQ 频段')
  }
  await actions.pasteBands()
  assert.equal(applies, beforeFailure)
  assert.equal(context.clipboardFailed.value, true)
  assert.match(context.clipboardMessage.value, /没有可粘贴/)
  context.window.api.window.pasteEqBands = async () => cloneBands(copied)
  context.audioProcessing.value = {
    ...initial,
    eqBands: Array.from({ length: 31 }, () => ({ ...initial.eqBands[0] }))
  }
  await actions.pasteBands()
  assert.equal(applies, beforeFailure)
  assert.equal(context.audioProcessing.value.eqBands.length, 31)
  assert.match(context.clipboardMessage.value, /当前 31 个，待粘贴 2 个/)
  assert.deepEqual(context.selectedBandIndices.value, [2, 3])
})

test('clipboard commands finish queued edits, reject duplicates and cancel paste after leaving', async () => {
  const declaration = page.match(/async function pasteBands\([\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  let releaseEdits!: () => void,
    releaseClipboard!: (bands: typeof defaultAudioProcessing.eqBands) => void
  const pending = new Promise<void>((resolve) => {
    releaseEdits = resolve
  })
  let finished = 0,
    reads = 0,
    applies = 0
  const context = {
    activeTab: { value: 'parametric' },
    responseView: { value: 'dsp' },
    clipboardBusy: { value: false },
    clipboardMessage: { value: '' },
    clipboardFailed: { value: false },
    equalizerMounted: true,
    commitChain: pending,
    finishParametricEdits: () => {
      finished++
    },
    window: {
      api: {
        window: {
          pasteEqBands: () => {
            reads++
            return new Promise((resolve) => {
              releaseClipboard = resolve
            })
          }
        }
      }
    },
    runEqApply: () => {
      applies++
    }
  }
  const paste = runInNewContext(`${stripTypeScriptTypes(declaration)}\npasteBands`, context)
  const result = paste()
  await paste()
  assert.equal(finished, 1)
  assert.equal(reads, 0)
  releaseEdits()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 1)
  context.equalizerMounted = false
  releaseClipboard(defaultAudioProcessing.eqBands)
  await result
  assert.equal(applies, 0)
  assert.equal(context.clipboardBusy.value, false)
})

test('theme modes change only equalizer presentation and use stable chart classes', () => {
  assert.equal(chart.match(/class="equalizer-spectrum-line"/g)?.length, 1)
  assert.equal(chart.match(/class="equalizer-spectrum-area"/g)?.length, 1)
  assert.match(page, /ParametricEqWorkspace/)
  assert.match(equalizerUi, /data-te-equalizer-panel='tinted'/)
  assert.match(equalizerUi, /data-te-equalizer-slider='solid'/)
  assert.match(equalizerUi, /data-te-equalizer-knob='dot'/)
  assert.match(equalizerUi, /data-te-equalizer-spectrum='area'/)
  assert.match(equalizerUi, /data-te-equalizer-button='outline'/)
  assert.match(equalizerUi, /data-te-visible-equalizer-grid='false'/)
  assert.match(equalizerUi, /data-te-visible-equalizer-frequency-guides='false'/)
  assert.match(equalizerUi, /data-te-visible-equalizer-spectrum='false'/)
})

test('OPRA compensation is reflected in the plotted response curve', () => {
  assert.match(
    page,
    /const displayEqBands = computed\([\s\S]*?opraCompensationEnabled\.value[\s\S]*?headphoneCompensation\.value\.bands/
  )
  assert.match(page, /computeCompositeResponse\(\s*displayEqBands\.value,\s*displayEqPreamp\.value/)
  assert.match(page, /mode: displayEqMode\.value/)
})

test('DSP chart splits manual, OPRA, and effective total response curves', () => {
  assert.match(
    page,
    /const manualResponsePath = computed\([\s\S]*?computeCompositeResponse\(audioProcessing\.value\.eqBands, audioProcessing\.value\.eqPreamp/
  )
  assert.match(
    page,
    /const opraResponsePath = computed\([\s\S]*?computeCompositeResponse\([\s\S]*?headphoneCompensation\.value\.bands,[\s\S]*?headphoneCompensation\.value\.preampDb/
  )
  assert.match(chart, /class="equalizer-manual-response-line"/)
  assert.match(chart, /class="equalizer-opra-response-line"/)
  assert.equal(chart.match(/>总 DSP 合成<\/span>/g)?.length, 1)
  assert.match(page, /:response-path="responsePath"/)
  assert.match(page, /:meter-peak-db="visualizationData\.peakDb"/)
  assert.match(page, /:meter-rms-db="visualizationData\.rmsDb"/)
})

test('OPRA estimated source deviation is explicitly non-measured and excludes preamp', () => {
  assert.match(
    page,
    /computeEstimatedSourceDeviation\(headphoneCompensation\.value\.bands, responseOptions\.value\)/
  )
  assert.match(chart, /class="equalizer-estimated-deviation-line"/)
  assert.equal(chart.match(/相对隐含目标 0 dB · 非实测/g)?.length, 1)
  assert.match(chart, /排除前级增益，不代表实测频响/)
})

test('AutoEq CSV import switches to a distinct headphone response view with precise data semantics', () => {
  assert.match(page, /coreAudio\.importFrequencyResponse\(\)/)
  assert.match(page, /type ResponseView = 'dsp' \| 'headphone'/)
  assert.equal(toolbar.match(/>\s*DSP 响应\s*<\/button>/g)?.length, 2)
  assert.equal(toolbar.match(/>\s*耳机频响\s*<\/button>/g)?.length, 2)
  assert.match(toolbar, /AutoEq smoothed 列/)
  assert.match(toolbar, /AutoEq raw 列/)
  assert.doesNotMatch(equalizerUi, /原始测量/)
})

test('headphone comparison exposes source, target, individual, combined, and corrected curves', () => {
  assert.match(page, /computeFrequencyResponseComparison\(/)
  assert.match(
    page,
    /computeCompositeResponse\(displayEqBands\.value, 0,[\s\S]*?mode: displayEqMode\.value/
  )
  assert.match(chart, /源频响 M\(f\)/)
  assert.match(chart, /目标曲线 T\(f\)/)
  assert.match(chart, /单个滤波 Hn\(f\)/)
  assert.match(chart, /合并滤波 H\(f\)/)
  assert.match(chart, /滤波结果 R\(f\)/)
  assert.match(chart, /class="equalizer-measured-source-line"/)
  assert.match(chart, /class="equalizer-target-response-line"/)
  assert.match(chart, /class="equalizer-combined-filter-line"/)
  assert.match(chart, /class="equalizer-corrected-acoustic-line"/)
  assert.match(chart, /R\(f\) = M\(f\) \+ H\(f\) · 排除数字前级 · 预计值，非校正后实测/)
})

test('headphone curves have independent accessible visibility controls in both EQ workspaces', () => {
  for (const state of [
    'showMeasuredSource',
    'showTargetResponse',
    'showIndividualFilters',
    'showCombinedFilter',
    'showCorrectedResponse'
  ]) {
    assert.match(page, new RegExp(`const ${state} = ref\\(true\\)`))
    assert.match(chart, new RegExp(`:aria-pressed="props\\.${state}"`))
  }
  assert.match(page, /@toggle-headphone-curve="toggleHeadphoneCurve"/)
  assert.match(
    page,
    /:band-response-paths="\s*responseView === 'headphone' \? headphoneBandResponsePaths : bandResponsePaths\s*"/
  )
})

test('the editor delegates effective scene processing to Core instead of writing scene graphs', () => {
  assert.match(page, /await setAudioProcessing\(edit, \{ throwOnError: true \}\)/)
  assert.doesNotMatch(page, /setDspScenes|applyDspScene|window\.api\.audioEngine/)
})

test('applying or disabling OPRA reloads the acknowledged Core projection', () => {
  for (const name of ['applyOpraProfile', 'disableOpraCompensation']) {
    assert.match(declarations(name), /await refreshEqualizerProjection\(\)/)
  }
})

test('OPRA-stacked scene bands never overwrite the manual editor state', () => {
  assert.match(page, /if \(opraCompensationEnabled\.value\) return/)
})

test('parametric editor exposes direct manipulation and throttled DSP commits', () => {
  assert.match(page, /import ParametricEqWorkspace/)
  assert.match(page, /@add="addBand"/)
  assert.match(page, /@preview-bands="stageBandPatches"/)
  assert.match(page, /@commit="commitStagedBands"/)
  assert.match(page, /@delete="deleteBand"/)
  assert.match(page, /@toggle="toggleBandEnabled"/)
  assert.match(page, /window\.requestAnimationFrame/)
  assert.match(page, /runEqApply/)
})

test('parametric page puts mode, presets and power into the instrument with a compact footer', () => {
  assert.match(page, /class="tab-pane active parametric-pane"/)
  assert.match(page, /<template #commands>/)
  assert.match(page, /<template #footer>/)
  assert.match(page, /class="instrument-mode-switch"/)
  assert.match(page, /class="instrument-power"/)
  assert.match(page, /class="instrument-auto-preamp"/)
  assert.match(page, /v-if="activeTab !== 'parametric' && !embedded" class="eq-sidebar"/)
  assert.match(page, /:docked-inspector="embedded"/)
  assert.doesNotMatch(page, /<header class="parametric-page-header">/)
  assert.match(toolbar, /compact\?: boolean/)
})

test('parametric spectrum and meters acquire one shared demand without a second IPC timer', () => {
  assert.match(page, /acquireVisualizationConsumer\(\{ spectrumPoints: points \}\)/)
  assert.match(page, /shouldPoll\s*\?\s*2048\s*:\s*64/)
  assert.doesNotMatch(page, /getVisualizationData|spectrumPollTimer/)
  assert.match(page, /:spectrum-levels="spectrumLevels"/)
})

test('freeze retains its frame, downgrades shared demand, and ignores late detailed samples', () => {
  const update = page.match(/function updateSpectrumPolling\(\): void \{[\s\S]*?\n\}/)?.[0]
  const sample = page.match(/function updateSpectrumFromSample\([\s\S]*?\n\}/)?.[0]
  assert.ok(update && sample)
  const demands: number[] = []
  let releases = 0
  const baseline = new Float32Array([0.2, 0.4])
  const context = {
    props: { visible: true },
    document: { hidden: false },
    spectrumPollingMounted: true,
    visualizationConsumerPoints: 0,
    releaseVisualizationConsumer: null,
    acquireVisualizationConsumer: ({ spectrumPoints }: { spectrumPoints: number }) => {
      demands.push(spectrumPoints)
      return () => {
        releases++
      }
    },
    activeTab: { value: 'parametric' },
    responseView: { value: 'dsp' },
    spectrumVisible: { value: true },
    spectrumFrozen: { value: false },
    isPlaying: { value: true },
    spectrumLevels: { value: baseline as Float32Array | null },
    responseSampleRate: { value: 48000 },
    projectSpectrumLevels: (levels: number[]) => new Float32Array(levels)
  }
  const actions = runInNewContext(
    stripTypeScriptTypes(update) +
      '\n' +
      stripTypeScriptTypes(sample) +
      '\n({updateSpectrumPolling, updateSpectrumFromSample})',
    context
  )
  actions.updateSpectrumPolling()
  assert.deepEqual(demands, [2048])
  context.spectrumFrozen.value = true
  actions.updateSpectrumPolling()
  actions.updateSpectrumFromSample({ active: true, spectrum: [0.9, 0.9], sampleRate: 48000 })
  assert.deepEqual(demands, [2048, 64])
  assert.equal(context.spectrumLevels.value, baseline)
  context.spectrumFrozen.value = false
  actions.updateSpectrumPolling()
  actions.updateSpectrumFromSample({ active: true, spectrum: [0.5, 0.5], sampleRate: 48000 })
  assert.deepEqual(context.spectrumLevels.value, new Float32Array([0.5, 0.5]))
  context.activeTab.value = 'graphic'
  actions.updateSpectrumPolling()
  assert.equal(context.spectrumLevels.value, null)
  assert.equal(context.visualizationConsumerPoints, 0)
  assert.equal(releases, 3)
  context.activeTab.value = 'parametric'
  actions.updateSpectrumPolling()
  context.document.hidden = true
  actions.updateSpectrumPolling()
  assert.equal(context.visualizationConsumerPoints, 0)
  context.document.hidden = false
  context.props.visible = false
  actions.updateSpectrumPolling()
  assert.equal(context.visualizationConsumerPoints, 0)
})

test('equalizer drafts are separate from the read-only Core projection', () => {
  assert.match(page, /audioProcessing: projectedAudioProcessing/)
  assert.match(
    page,
    /const audioProcessing = ref<AudioProcessingSettings>\(structuredClone\(projectedAudioProcessing\.value\)\)/
  )
  assert.match(
    declarations('refreshEqualizerProjection'),
    /audioProcessing\.value = structuredClone\(projectedAudioProcessing\.value\)/
  )
  assert.doesNotMatch(page, /projectedAudioProcessing\.value\s*=/)
})

test('staged pointer edits preserve both EQ and DSP bypass without applying to the engine', () => {
  const declaration = page.match(/function flushStagedEdit\(\): void \{[\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  for (const enabled of [false, true]) {
    const current = { ...defaultAudioProcessing, eqEnabled: enabled, dspEnabled: enabled }
    const draft = { value: current }
    runInNewContext(`${stripTypeScriptTypes(declaration)}\nflushStagedEdit()`, {
      pendingBandPatches: new Map([[0, { gain: 6 }]]),
      pendingPreamp: null,
      audioProcessing: draft,
      appSettings: { value: null },
      patchBand
    })
    assert.equal(draft.value.eqBands[0].gain, 6)
    assert.equal(draft.value.eqEnabled, enabled)
    assert.equal(draft.value.dspEnabled, enabled)
    assert.equal(current.eqBands[0].gain, 0)
  }
})

test('loading parametric presets preserves zero and thirty-two bands', async () => {
  const declaration = page.match(
    /async function loadAppSettings\(\): Promise<void> \{[\s\S]*?\n\}/
  )?.[0]
  assert.ok(declaration)
  const appSettings: { value: { audioEqPresets: { eqBands: unknown[] }[] } | null } = {
    value: null
  }
  const settings = {
    audioProcessing: defaultAudioProcessing,
    headphoneCompensation: { bands: [] },
    audioEqPresets: [0, 32].map((count) => ({
      eqMode: 'parametric',
      eqBands: Array.from({ length: count }, () => ({ ...defaultAudioProcessing.eqBands[0] }))
    }))
  }
  await runInNewContext(`${stripTypeScriptTypes(declaration)}\nloadAppSettings()`, {
    appSettings,
    structuredClone,
    normalizeAudioProcessing,
    cloneBands,
    audioProcessing: { value: defaultAudioProcessing },
    activeTab: { value: 'graphic' },
    applyActiveSceneEqToEditor: () => undefined,
    coreAudio: { getDspSceneState: async () => ({ scenes: [] }) },
    window: {
      api: {
        settings: { get: async () => settings }
      }
    }
  })
  assert.equal(appSettings.value?.audioEqPresets[0].eqBands.length, 0)
  assert.equal(appSettings.value?.audioEqPresets[1].eqBands.length, 32)
})

test('built-in and custom presets can be renamed, overwritten with current EQ, deleted, and restored', async () => {
  const initial = {
    audioProcessing: {
      ...defaultAudioProcessing,
      eqMode: 'parametric' as 'graphic' | 'parametric',
      eqPreamp: -3.5,
      eqBands: cloneBands(defaultAudioProcessing.eqBands).map((band, index) =>
        index === 0 ? { ...band, gain: 4.2 } : band
      )
    },
    audioEqBuiltInPresets: null as typeof builtInEqPresets | null,
    audioEqPresets: [] as typeof builtInEqPresets
  }
  let persisted = structuredClone(initial)
  const readPersisted = () => persisted
  const appSettings = ref(structuredClone(initial))
  const editingPresetKey = ref('')
  const editingPresetName = ref('')
  const context = {
    Error,
    structuredClone,
    appSettings,
    builtInPresets: computed(() => appSettings.value.audioEqBuiltInPresets ?? builtInEqPresets),
    userPresets: computed(() => appSettings.value.audioEqPresets),
    audioProcessing: ref(structuredClone(initial.audioProcessing)),
    presetName: ref('Studio Custom'),
    presetError: ref(''),
    editingPresetKey,
    editingPresetName,
    saving: ref(false),
    presetMenuOpen: ref(false),
    commitChain: Promise.resolve(),
    finishParametricEdits() {},
    cloneBands,
    window: {
      api: {
        settings: {
          update: async (patch: Partial<typeof initial>) => {
            persisted = { ...persisted, ...structuredClone(patch) }
            return structuredClone(persisted)
          }
        }
      }
    }
  }
  const actions = runInNewContext(
    `${declarations(
      'saveEqPreset',
      'cloneEqPresets',
      'startRenameEqPreset',
      'cancelRenameEqPreset',
      'renameEqPreset',
      'updateEqPreset',
      'deleteEqPreset',
      'restoreBuiltInEqPresets'
    )}\n({saveEqPreset,startRenameEqPreset,cancelRenameEqPreset,renameEqPreset,updateEqPreset,deleteEqPreset,restoreBuiltInEqPresets})`,
    context
  ) as {
    saveEqPreset(): Promise<void>
    startRenameEqPreset(scope: 'builtin' | 'custom', preset: (typeof builtInEqPresets)[0]): void
    cancelRenameEqPreset(): void
    renameEqPreset(scope: 'builtin' | 'custom', presetId: string, nextRawName?: string): Promise<void>
    updateEqPreset(scope: 'builtin' | 'custom', presetId: string): Promise<void>
    deleteEqPreset(scope: 'builtin' | 'custom', presetId: string): Promise<void>
    restoreBuiltInEqPresets(): Promise<void>
  }

  // 1. Create two custom presets, rename one, overwrite one, and delete the other.
  await actions.saveEqPreset()
  context.presetName.value = 'Temporary Custom'
  await actions.saveEqPreset()
  assert.equal(readPersisted().audioEqPresets.length, 2)
  const firstCustom = readPersisted().audioEqPresets[0]
  const secondCustom = readPersisted().audioEqPresets[1]

  actions.startRenameEqPreset('custom', firstCustom)
  assert.equal(editingPresetKey.value, `custom:${firstCustom.id}`)
  editingPresetName.value = '   '
  await actions.renameEqPreset('custom', firstCustom.id)
  assert.equal(context.presetError.value, '预设名称不能为空')
  assert.equal(editingPresetKey.value, `custom:${firstCustom.id}`)

  editingPresetName.value = 'Master Reference'
  await actions.renameEqPreset('custom', firstCustom.id)
  assert.equal(context.presetError.value, '')
  assert.equal(editingPresetKey.value, '')
  assert.equal(readPersisted().audioEqPresets[0].name, 'Master Reference')

  context.audioProcessing.value.eqPreamp = -5
  context.audioProcessing.value.eqBands[0].gain = -2.5
  await actions.updateEqPreset('custom', firstCustom.id)
  assert.equal(readPersisted().audioEqPresets[0].eqPreamp, -5)
  assert.equal(readPersisted().audioEqPresets[0].eqBands[0].gain, -2.5)

  await actions.deleteEqPreset('custom', secondCustom.id)
  assert.deepEqual(
    readPersisted().audioEqPresets.map((item) => item.name),
    ['Master Reference']
  )

  // 2. Rename, overwrite, and delete built-in presets, then restore defaults.
  assert.equal(readPersisted().audioEqBuiltInPresets, null)
  actions.startRenameEqPreset('builtin', builtInEqPresets[0])
  editingPresetName.value = 'Flat Studio'
  await actions.renameEqPreset('builtin', 'flat')
  assert.equal(readPersisted().audioEqBuiltInPresets?.length, builtInEqPresets.length)
  assert.equal(readPersisted().audioEqBuiltInPresets?.[0]?.name, 'Flat Studio')

  context.audioProcessing.value.eqMode = 'graphic'
  context.audioProcessing.value.eqPreamp = -1.2
  context.audioProcessing.value.eqBands[1].gain = 3.1
  await actions.updateEqPreset('builtin', 'warm')
  const updatedWarm = readPersisted().audioEqBuiltInPresets?.find((item) => item.id === 'warm')
  assert.equal(updatedWarm?.eqMode, 'graphic')
  assert.equal(updatedWarm?.eqPreamp, -1.2)
  assert.equal(updatedWarm?.eqBands[1].gain, 3.1)

  for (const preset of [...(readPersisted().audioEqBuiltInPresets ?? [])]) {
    await actions.deleteEqPreset('builtin', preset.id)
  }
  assert.deepEqual(readPersisted().audioEqBuiltInPresets, [])
  assert.equal(context.builtInPresets.value.length, 0)

  // Persistence error leaves existing state untouched and exposes error message.
  const validUpdate = context.window.api.settings.update
  context.window.api.settings.update = async () => {
    throw new Error('write denied')
  }
  await actions.deleteEqPreset('custom', firstCustom.id)
  assert.equal(context.appSettings.value.audioEqPresets.length, 1)
  assert.match(context.presetError.value, /write denied/)
  context.window.api.settings.update = validUpdate

  await actions.restoreBuiltInEqPresets()
  assert.equal(readPersisted().audioEqBuiltInPresets, null)
  assert.equal(context.builtInPresets.value.length, builtInEqPresets.length)
  assert.equal(context.presetError.value, '')
})
