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

const page = readFileSync(new URL('./EqualizerPage.vue', import.meta.url), 'utf8')

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

test('locked mode navigation has no side effects and resumes after queued commits when unlocked', async () => {
  const declaration = page.match(/async function switchTab\([\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  const events: string[] = []
  const context = {
    props: { navigationLocked: true },
    activeTab: { value: 'parametric' },
    presetMenuOpen: { value: true },
    filterMenuOpen: { value: true },
    commitChain: Promise.resolve(),
    finishParametricEdits: () => events.push('finish'),
    runEqApply: async (action: () => Promise<void>) => {
      events.push('apply')
      await action()
    },
    updateAudioProcessing: async (patch: { eqMode: string }) => {
      events.push(patch.eqMode)
    }
  }
  const switchTab = runInNewContext(`${stripTypeScriptTypes(declaration)}\nswitchTab`, context)
  await switchTab('graphic')
  assert.deepEqual(events, [], 'locked navigation must not finish or submit an edit')
  assert.equal(context.activeTab.value, 'parametric')
  assert.equal(context.presetMenuOpen.value, true)
  assert.equal(context.filterMenuOpen.value, true)

  let release!: () => void
  context.commitChain = new Promise<void>((resolve) => {
    release = resolve
  })
  context.props.navigationLocked = false
  let completed = false
  const switching = switchTab('graphic').then(() => {
    completed = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['finish'])
  assert.equal(completed, false, 'the previous gesture must finish committing first')
  assert.equal(context.activeTab.value, 'parametric')
  assert.equal(context.presetMenuOpen.value, true)
  assert.equal(context.filterMenuOpen.value, true)
  release()
  await switching
  assert.deepEqual(events, ['finish', 'apply', 'graphic'])
  assert.equal(context.activeTab.value, 'graphic')
  assert.equal(context.presetMenuOpen.value, false)
  assert.equal(context.filterMenuOpen.value, false)
})

function createLeaveHarness(feedback = 'idle'): {
  context: {
    historyLoading: { value: boolean }
    historyBusy: { value: boolean }
    clipboardBusy: { value: boolean }
    opraApplyingEqId: { value: string }
    opraSaving: { value: boolean }
    opraSearching: { value: boolean }
    opraRefreshing: { value: boolean }
    eqApplyFeedback: { value: string }
    commitChain: Promise<void>
    finishParametricEdits: () => void
    commitStagedBands: () => Promise<void>
  }
  events: string[]
  requestLeave: () => Promise<boolean>
} {
  const declaration = page.match(/async function requestLeave\([\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  const events: string[] = []
  const context = {
    historyLoading: { value: false },
    historyBusy: { value: false },
    clipboardBusy: { value: false },
    opraApplyingEqId: { value: '' },
    opraSaving: { value: false },
    opraSearching: { value: false },
    opraRefreshing: { value: false },
    eqApplyFeedback: { value: feedback },
    commitChain: Promise.resolve(),
    finishParametricEdits: () => {
      events.push('finish')
    },
    commitStagedBands: async () => {
      events.push('commit')
    }
  }
  const requestLeave = runInNewContext(
    `${stripTypeScriptTypes(declaration)}\nrequestLeave`,
    context
  )
  return { context, events, requestLeave }
}

test('leaving the equalizer stays pending until a finished gesture is committed', async () => {
  const { context, events, requestLeave } = createLeaveHarness('applying')
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  context.finishParametricEdits = () => {
    events.push('finish')
    context.commitChain = pending
  }
  let decision: boolean | undefined
  const leaving = requestLeave().then((allowed) => {
    decision = allowed
    return allowed
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['finish'])
  assert.equal(decision, undefined, 'navigation must wait for the newly queued commit')
  context.eqApplyFeedback.value = 'applied'
  release()
  assert.equal(await leaving, true)
})

test('leaving commits an already rendered edit before allowing navigation', async () => {
  const { context, events, requestLeave } = createLeaveHarness('editing')
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  context.commitStagedBands = async () => {
    events.push('commit')
    context.eqApplyFeedback.value = 'applying'
    context.commitChain = pending
    await pending
    context.eqApplyFeedback.value = 'applied'
  }
  let decision: boolean | undefined
  const leaving = requestLeave().then((allowed) => {
    decision = allowed
    return allowed
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['finish', 'commit'])
  assert.equal(decision, undefined, 'a renderer preview is not a completed DSP save')
  release()
  assert.equal(await leaving, true)
})

test('failed equalizer synchronization keeps the editor open after the commit settles', async () => {
  const { context, events, requestLeave } = createLeaveHarness('applying')
  let release!: () => void
  context.commitChain = new Promise<void>((resolve) => {
    release = resolve
  }).then(() => {
    context.eqApplyFeedback.value = 'failed'
  })
  const leaving = requestLeave()
  release()
  assert.equal(await leaving, false)
  assert.deepEqual(events, ['finish'])
  assert.equal(await requestLeave(), false, 'a settled failure must still block navigation')
})

test('idle equalizer navigation finishes interaction without submitting a redundant save', async () => {
  const { events, requestLeave } = createLeaveHarness()
  assert.equal(await requestLeave(), true)
  assert.deepEqual(events, ['finish'])
})

test('equalizer navigation stays blocked during loading, history actions and clipboard work', async () => {
  for (const busy of ['historyLoading', 'historyBusy', 'clipboardBusy'] as const) {
    const { context, events, requestLeave } = createLeaveHarness('editing')
    context[busy].value = true
    assert.equal(await requestLeave(), false, `${busy} must retain the editor`)
    assert.deepEqual(events, [], 'blocked navigation must not start another edit or save')
  }
})

test('OPRA writes retain the equalizer until applying or saving completes', async () => {
  for (const operation of ['apply', 'save']) {
    const { context, events, requestLeave } = createLeaveHarness()
    context.opraApplyingEqId.value = operation === 'apply' ? 'profile-1' : ''
    context.opraSaving.value = operation === 'save'
    assert.equal(await requestLeave(), false, `${operation} must retain the editor`)
    assert.deepEqual(events, [], 'an OPRA write must block navigation before finishing edits')
    context.opraApplyingEqId.value = ''
    context.opraSaving.value = false
    assert.equal(await requestLeave(), true, 'a completed OPRA write must release navigation')
    assert.deepEqual(events, ['finish'])
  }
})

test('read-only OPRA search and catalog refresh do not block equalizer navigation', async () => {
  for (const [searching, refreshing] of [
    [true, false],
    [false, true],
    [true, true]
  ]) {
    const { context, events, requestLeave } = createLeaveHarness()
    context.opraSearching.value = searching
    context.opraRefreshing.value = refreshing
    assert.equal(await requestLeave(), true)
    assert.deepEqual(events, ['finish'])
  }
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

const autoPreampDeclarations = [
  'loadAutoPreampPreference',
  'saveAutoPreampPreference',
  'toggleAutoPreamp',
  'applyAutoPreamp',
  'stagePreamp',
  'updatePreampInput'
]
  .map((name) => {
    const declaration = page.match(
      new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`)
    )?.[0]
    assert.ok(declaration)
    return stripTypeScriptTypes(declaration)
  })
  .join('\n')

test('auto compensation restores the manual preamp, survives reopening and permits manual overrides', async () => {
  const initial = normalizeAudioProcessing({
    ...defaultAudioProcessing,
    eqMode: 'parametric',
    eqPreamp: 2.3
  })
  const stored = new Map<string, string>()
  let applies = 0,
    previews = 0,
    manualCommit = Promise.resolve()
  const context = {
    audioProcessing: { value: initial },
    autoPreampEnabled: { value: false },
    autoPreampTargetDb: { value: -6.5 },
    manualPreampBeforeAuto: null as number | null,
    autoPreampStorageKey: 'auto',
    manualPreampStorageKey: 'manual',
    commitChain: Promise.resolve(),
    eqApplyFeedback: { value: 'idle' },
    pendingPreamp: null as number | null,
    clampNumber,
    finishParametricEdits() {},
    scheduleStagedFlush: () => {
      previews++
    },
    runEqApply: async (action: () => Promise<void>) => {
      try {
        await action()
        context.eqApplyFeedback.value = 'applied'
      } catch {
        context.eqApplyFeedback.value = 'failed'
      }
    },
    updateAudioProcessing: (patch: Partial<typeof initial>) =>
      history.commit({ ...context.audioProcessing.value, ...patch }),
    commitStagedBands: () => {
      const snapshot = {
        ...context.audioProcessing.value,
        eqPreamp: context.pendingPreamp!
      }
      manualCommit = context.commitChain.then(() => history.commit(snapshot))
      context.commitChain = manualCommit
      return manualCommit
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key)
    }
  }
  const history = useEqualizerHistory(initial, async (snapshot) => {
    applies++
    context.audioProcessing.value = { ...context.audioProcessing.value, ...snapshot }
  })
  const actions = runInNewContext(
    `${autoPreampDeclarations}\n({toggleAutoPreamp,applyAutoPreamp,loadAutoPreampPreference,updatePreampInput})`,
    context
  )
  await actions.toggleAutoPreamp()
  assert.equal(context.autoPreampEnabled.value, true)
  assert.equal(context.audioProcessing.value.eqPreamp, -6.5)
  assert.equal(context.manualPreampBeforeAuto, 2.3)
  assert.equal(stored.get('manual'), '2.3')
  context.audioProcessing.value = {
    ...context.audioProcessing.value,
    eqBands: [{ ...initial.eqBands[0], gain: 12 }]
  }
  context.autoPreampTargetDb.value = -12.5
  await actions.applyAutoPreamp()
  await actions.toggleAutoPreamp()
  assert.equal(context.autoPreampEnabled.value, false)
  assert.equal(context.audioProcessing.value.eqPreamp, 2.3)
  assert.equal(context.audioProcessing.value.eqBands[0].gain, 12)
  assert.equal(stored.get('auto'), '0')
  assert.equal(stored.has('manual'), false)
  await history.travel('undo')
  assert.equal(context.audioProcessing.value.eqPreamp, -12.5)
  await history.travel('redo')
  assert.equal(context.audioProcessing.value.eqPreamp, 2.3)
  await actions.toggleAutoPreamp()
  context.manualPreampBeforeAuto = null
  context.autoPreampEnabled.value = false
  actions.loadAutoPreampPreference()
  assert.equal(context.autoPreampEnabled.value, true)
  assert.equal(context.manualPreampBeforeAuto, 2.3)
  await actions.toggleAutoPreamp()
  assert.equal(context.audioProcessing.value.eqPreamp, 2.3)
  await actions.toggleAutoPreamp()
  const input = { value: '4.2', valueAsNumber: 4.2 }
  actions.updatePreampInput({ target: input })
  await manualCommit
  assert.equal(context.autoPreampEnabled.value, false)
  assert.equal(context.manualPreampBeforeAuto, null)
  assert.equal(context.audioProcessing.value.eqPreamp, 4.2)
  assert.equal(stored.get('auto'), '0')
  assert.equal(previews, 1)
  const beforeInvalid = applies
  actions.updatePreampInput({ target: { value: '', valueAsNumber: NaN } })
  actions.updatePreampInput({ target: input })
  assert.equal(applies, beforeInvalid)
  actions.updatePreampInput({ target: { value: '999', valueAsNumber: 999 } })
  await manualCommit
  assert.equal(context.audioProcessing.value.eqPreamp, 24)
  const applySettings = context.updateAudioProcessing
  let releaseApply!: () => void
  let enteredApply!: () => void
  const entered = new Promise<void>((resolve) => {
    enteredApply = resolve
  })
  const pendingApply = new Promise<void>((resolve) => {
    releaseApply = resolve
  })
  context.updateAudioProcessing = async (patch) => {
    enteredApply()
    await pendingApply
    await applySettings(patch)
  }
  const enabling = actions.toggleAutoPreamp()
  await entered
  actions.updatePreampInput({ target: { value: '3.7', valueAsNumber: 3.7 } })
  releaseApply()
  await enabling
  await manualCommit
  assert.equal(context.audioProcessing.value.eqPreamp, 3.7)
  assert.equal(context.autoPreampEnabled.value, false)
  assert.equal(context.manualPreampBeforeAuto, null)
  assert.equal(stored.get('auto'), '0')
  assert.equal(stored.has('manual'), false)
  context.updateAudioProcessing = async () => {
    throw new Error('Engine apply failed')
  }
  await actions.toggleAutoPreamp()
  assert.equal(context.autoPreampEnabled.value, false)
  assert.equal(context.manualPreampBeforeAuto, null)
  assert.equal(context.audioProcessing.value.eqPreamp, 3.7)
  assert.equal(stored.get('auto'), '0')
  for (const value of ['', 'bad', 'Infinity', '-25', '25']) {
    stored.set('auto', '1')
    stored.set('manual', value)
    actions.loadAutoPreampPreference()
    assert.equal(context.manualPreampBeforeAuto, null)
  }
})

test('turning compensation off waits for queued automatic updates before restoring the previous value', async () => {
  let release!: () => void
  const writes: number[] = []
  const context = {
    audioProcessing: { value: { eqPreamp: -6.5 } },
    autoPreampEnabled: { value: true },
    autoPreampTargetDb: { value: -10 },
    manualPreampBeforeAuto: 3.7,
    autoPreampStorageKey: 'auto',
    manualPreampStorageKey: 'manual',
    localStorage: { setItem() {}, removeItem() {} },
    commitChain: new Promise<void>((resolve) => {
      release = resolve
    }),
    eqApplyFeedback: { value: 'idle' },
    finishParametricEdits() {},
    runEqApply: async (action: () => Promise<void>) => {
      await action()
      context.eqApplyFeedback.value = 'applied'
    },
    updateAudioProcessing: async (patch: { eqPreamp: number }) => {
      writes.push(patch.eqPreamp)
      await new Promise((resolve) => setImmediate(resolve))
      context.audioProcessing.value.eqPreamp = patch.eqPreamp
    }
  }
  const actions = runInNewContext(
    `${autoPreampDeclarations}\n({toggleAutoPreamp,applyAutoPreamp})`,
    context
  )
  const automatic = actions.applyAutoPreamp(),
    off = actions.toggleAutoPreamp()
  assert.deepEqual(writes, [])
  release()
  await Promise.all([automatic, off])
  assert.deepEqual(writes, [-10, 3.7])
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
  let renders = 0,
    applies = 0,
    frames = 0
  const context = {
    pendingBandPatches: new Map(),
    pendingBandFrame: 0,
    pendingBandWindow: null,
    editorRoot: { value: null },
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
    audioOutputDspStore: {
      applyAudioProcessingState: (value: typeof initial) => {
        renders++
        context.audioProcessing.value = value
      }
    },
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
  assert.equal(renders, 1)
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
  assert.match(page, /window\.api\.audioEngine\.importFrequencyResponse\(\)/)
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

test('scene EQ keeps OPRA parameters but obeys DSP and equalizer bypass switches', () => {
  assert.match(page, /node\.enabled = nextSettings\.dspEnabled && nextSettings\.eqEnabled/)
  assert.doesNotMatch(
    page,
    /node\.enabled = nextSettings\.eqEnabled \|\| opraCompensationEnabled\.value/
  )
  assert.match(
    page,
    /bands: opraCompensationEnabled\.value\s*\? \[\.\.\.cloneBands\(headphoneCompensation\.value\.bands\), \.\.\.cloneBands\(nextSettings\.eqBands\)\]/
  )
})

test('applying or disabling OPRA re-syncs the DSP scene', () => {
  assert.equal(page.match(/await syncActiveSceneEq\(audioProcessing\.value\)/g)?.length, 2)
})

test('OPRA-stacked scene bands never overwrite the manual editor state', () => {
  assert.match(page, /if \(opraCompensationEnabled\.value\) return/)
})

test('scene EQ projection preserves the DSP switch and distinguishes master bypass from EQ bypass', () => {
  const declaration = page.match(/function applyActiveSceneEqToEditor\([\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  const sceneBands = [
    { frequency: 180, gain: -3.5, q: 1.2, filterType: 'peak' },
    { frequency: 4200, gain: 2, q: 0.8, filterType: 'highShelf' }
  ]
  for (const dspEnabled of [false, true]) {
    for (const eqEnabled of [false, true]) {
      for (const nodeEnabled of [false, true]) {
        const initial = normalizeAudioProcessing({
          ...defaultAudioProcessing,
          dspEnabled,
          eqEnabled,
          eqMode: 'graphic',
          eqPreamp: 4
        })
        let applies = 0
        const context = {
          opraCompensationEnabled: { value: false },
          audioProcessing: { value: initial },
          appSettings: { value: { audioProcessing: initial } },
          normalizeAudioProcessing,
          audioOutputDspStore: {
            applyAudioProcessingState: (settings: typeof initial) => {
              applies++
              context.audioProcessing.value = settings
            }
          }
        }
        const project = runInNewContext(
          `${stripTypeScriptTypes(declaration)}\napplyActiveSceneEqToEditor`,
          context
        )
        project({
          activeSceneId: 'active',
          scenes: [
            {
              id: 'active',
              graph: {
                nodes: [
                  {
                    type: 'equalizer',
                    enabled: nodeEnabled,
                    params: { mode: 'parametric', preampDb: -2.5, bands: sceneBands }
                  }
                ]
              }
            }
          ]
        })
        const projected = context.audioProcessing.value
        assert.equal(applies, 1)
        assert.equal(projected.dspEnabled, dspEnabled, 'opening the editor must not toggle DSP')
        assert.equal(
          projected.eqEnabled,
          dspEnabled ? nodeEnabled : eqEnabled,
          'a master-bypassed scene cannot reveal the saved EQ bypass preference'
        )
        assert.equal(projected.eqMode, 'parametric')
        assert.equal(projected.eqPreamp, -2.5)
        assert.deepEqual(projected.eqBands, sceneBands)
        assert.equal(context.appSettings.value.audioProcessing, projected)
      }
    }
  }
})

test('parametric editor exposes direct manipulation and throttled DSP commits', () => {
  assert.match(page, /import ParametricEqWorkspace/)
  assert.match(page, /@add="addBand"/)
  assert.match(page, /@preview-bands="stageBandPatches"/)
  assert.match(page, /@commit="commitStagedBands"/)
  assert.match(page, /@delete="deleteBand"/)
  assert.match(page, /@toggle="toggleBandEnabled"/)
  assert.match(page, /pendingBandWindow\.requestAnimationFrame/)
  assert.match(page, /runEqApply/)
})

test('detached equalizer previews use the editor window frame instead of the hidden main window', () => {
  const declaration = page.match(/function scheduleStagedFlush\([\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  let requested = 0,
    flushed = 0
  let callback: (() => void) | undefined
  const editorWindow = {
    requestAnimationFrame: (next: () => void) => {
      requested++
      callback = next
      return 9
    }
  }
  const context = {
    editorRoot: { value: { ownerDocument: { defaultView: editorWindow } } },
    pendingBandWindow: null,
    pendingBandFrame: 0,
    eqApplyFeedback: { value: 'idle' },
    flushStagedEdit: () => {
      flushed++
    },
    window: {
      requestAnimationFrame: () => {
        throw new Error('Main window must not schedule this frame')
      }
    }
  }
  const schedule = runInNewContext(
    `${stripTypeScriptTypes(declaration)};scheduleStagedFlush`,
    context
  )
  schedule()
  schedule()
  assert.equal(requested, 1)
  callback!()
  assert.equal(flushed, 1)
  assert.equal(context.pendingBandFrame, 0)
})

test('parametric page shares the mode navigation and keeps instrument commands with a compact footer', () => {
  const modeTabs = page.match(/<nav class="eq-mode-tabs"[\s\S]*?<\/nav>/)?.[0]
  const commands = page.match(/<template #commands>[\s\S]*?<\/template>/)?.[0]
  const footer = page.match(/<template #footer>[\s\S]*?<\/template>/)?.[0]
  assert.ok(modeTabs && commands && footer)
  assert.match(page, /class="tab-pane active parametric-pane"/)
  assert.match(modeTabs, /v-for="tab in tabs"/)
  assert.match(modeTabs, /:aria-pressed="activeTab === tab.key"/)
  assert.match(modeTabs, /@click="switchTab\(tab.key\)"/)
  assert.match(commands, /class="instrument-presets"/)
  assert.match(commands, /class="instrument-power"/)
  assert.match(footer, /<FrequencyResponseToolbar\s+compact/)
  assert.match(footer, /class="instrument-auto-preamp"/)
  assert.doesNotMatch(page, /class="(?:instrument-mode-switch|eq-sidebar)"/)
  assert.doesNotMatch(page, /<header class="parametric-page-header">/)
  assert.match(toolbar, /compact\?: boolean/)
})

test('parametric spectrum and meters acquire one shared demand without a second IPC timer', () => {
  assert.match(page, /acquireVisualizationConsumer\(\{ spectrumPoints: points \}\)/)
  assert.match(page, /shouldPoll \? 2048 : 64/)
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
})

test('equalizer state writes go through the store action instead of detaching storeToRefs', () => {
  assert.match(page, /audioOutputDspStore\.applyAudioProcessingState\(/)
  // Reassigning the storeToRefs audioProcessing would detach it from the
  // player store and freeze the graph/sliders while audio still changes.
  assert.doesNotMatch(
    page,
    /audioProcessing\.value\s*=\s*(appSettings\.value\.audioProcessing|settings|{)/
  )
})

test('staged pointer edits preserve both EQ and DSP bypass without applying to the engine', () => {
  const declaration = page.match(/function flushStagedEdit\(\): void \{[\s\S]*?\n\}/)?.[0]
  assert.ok(declaration)
  for (const enabled of [false, true]) {
    let staged = defaultAudioProcessing
    const current = { ...defaultAudioProcessing, eqEnabled: enabled, dspEnabled: enabled }
    runInNewContext(`${stripTypeScriptTypes(declaration)}\nflushStagedEdit()`, {
      pendingBandPatches: new Map([[0, { gain: 6 }]]),
      pendingPreamp: null,
      audioProcessing: { value: current },
      audioOutputDspStore: {
        applyAudioProcessingState: (value: typeof current) => {
          staged = value
        }
      },
      appSettings: { value: null },
      patchBand
    })
    assert.equal(staged.eqBands[0].gain, 6)
    assert.equal(staged.eqEnabled, enabled)
    assert.equal(staged.dspEnabled, enabled)
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
    audioEqPresets: [0, 32].map((count) => ({
      eqMode: 'parametric',
      eqBands: Array.from({ length: count }, () => ({ ...defaultAudioProcessing.eqBands[0] }))
    }))
  }
  await runInNewContext(`${stripTypeScriptTypes(declaration)}\nloadAppSettings()`, {
    appSettings,
    normalizeAudioProcessing,
    cloneBands,
    audioProcessing: { value: defaultAudioProcessing },
    activeTab: { value: 'graphic' },
    audioOutputDspStore: { applyAudioProcessingState: () => undefined },
    applyActiveSceneEqToEditor: () => undefined,
    window: {
      api: {
        settings: { get: async () => settings },
        audioEngine: { getDspSceneState: async () => ({ scenes: [] }) }
      }
    }
  })
  assert.equal(appSettings.value?.audioEqPresets[0].eqBands.length, 0)
  assert.equal(appSettings.value?.audioEqPresets[1].eqBands.length, 32)
})
