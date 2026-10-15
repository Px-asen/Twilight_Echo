const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function settle() {
  for (let index = 0; index < 8; index++) await vue.nextTick()
}

async function until(predicate) {
  for (let index = 0; index < 40 && !predicate(); index++) await vue.nextTick()
  assert.ok(predicate(), 'the asynchronous operation reached its expected boundary')
}

function environment() {
  let handle = 0
  const frames = new Map()
  const timers = new Map()
  const mounted = []
  const unmounted = []
  const scope = vue.effectScope()
  const globals = {
    CSS: { supports: () => true },
    performance: { now: () => 0 },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    document: { hidden: false, documentElement: { dataset: { theme: 'dark' } } },
    window: {
      addEventListener() {},
      removeEventListener() {},
      requestAnimationFrame(callback) {
        frames.set(++handle, callback)
        return handle
      },
      cancelAnimationFrame(id) {
        frames.delete(id)
      }
    },
    setTimeout(callback, delay) {
      timers.set(++handle, { callback, delay })
      return handle
    },
    clearTimeout(id) {
      timers.delete(id)
    }
  }
  const lifecycle = {
    ...vue,
    onMounted: (callback) => mounted.push(callback),
    onBeforeUnmount: (callback) => unmounted.push(callback)
  }
  return {
    globals,
    frames,
    timers,
    mounted,
    lifecycle,
    run: (callback) => scope.run(callback),
    async frame() {
      const current = [...frames]
      frames.clear()
      for (const [, callback] of current) callback(16)
      await settle()
    },
    async timersAt(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue
        timers.delete(id)
        timer.callback()
      }
      await settle()
    },
    dispose() {
      for (const callback of unmounted) callback()
      scope.stop()
    }
  }
}

function loadModule(relative, env, modules) {
  const filename = join(__dirname, relative)
  let source = readFileSync(filename, 'utf8')
  if (relative.endsWith('.vue')) {
    const parsed = parse(source, { filename })
    assert.deepEqual(parsed.errors, [])
    source = compileScript(parsed.descriptor, { id: 'pointer-boundaries' }).content
  }
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true
    }
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    ...env.globals,
    exports,
    require(id) {
      if (id === 'vue') return env.lifecycle
      if (id in modules) return modules[id]
      if (id.endsWith('.vue')) return { __esModule: true, default: {} }
      if (id.endsWith('.css')) return {}
      throw new Error(`Missing fixture module: ${id}`)
    }
  })
  return exports
}

function schedulerModule(env) {
  return loadModule('../utils/themePreviewScheduler.ts', env, {})
}

function diagnosticReport(items) {
  return {
    diagnostics: items,
    errors: items.filter((item) => item.severity === 'error').length,
    warnings: items.filter((item) => item.severity === 'warning').length
  }
}

function diagnosticsFixture(options = {}) {
  const env = environment()
  const compiled = []
  const inspections = []
  const images = []
  env.globals.Image = class {
    constructor() {
      images.push(this)
    }
  }
  const value = vue.shallowRef({
    id: 'project',
    base: {},
    css: 'first',
    assets: options.assets ?? []
  })
  const generation = vue.ref(0)
  const candidate = vue.ref()
  const diagnosticModule = {
    __esModule: true,
    workshopDiagnosticReport: diagnosticReport,
    diagnoseWorkshopProject: () => diagnosticReport([])
  }
  const delayedModule = options.moduleGate?.promise.then(() => diagnosticModule)
  if (delayedModule) delayedModule.__esModule = true
  const modules = {
    '../../../../shared/themeWorkshop.ts': {
      compileWorkshopProject(snapshot) {
        compiled.push(snapshot.css)
        return snapshot.css
      }
    },
    '../../../../shared/themeWorkshopDiagnostics.ts': delayedModule ?? diagnosticModule,
    '@renderer/utils/themePreviewScheduler': schedulerModule(env),
    '@renderer/utils/themePerformance': {
      createThemePerformanceRecorder: () => ({ record: () => ({ preview: { p95Ms: 0 } }) })
    },
    '@renderer/components/theme-workshop/workshopCatalog': {
      WORKSHOP_PREVIEW_SURFACES: [{ id: 'library', label: 'Library' }]
    },
    '../../../../shared/themeWorkshopCssDiagnostics.ts': {
      diagnoseWorkshopCssSupport: () => []
    }
  }
  // The static import is synchronous, while the lazy diagnose import may be delayed.
  if (delayedModule) delayedModule.workshopDiagnosticReport = diagnosticReport
  const { useWorkshopDiagnostics } = loadModule(
    'theme-workshop/useWorkshopDiagnostics.ts',
    env,
    modules
  )
  const diagnostics = env.run(() =>
    useWorkshopDiagnostics(
      vue.computed(() => value.value),
      generation,
      candidate,
      () => {
        inspections.push(value.value.css)
        return options.inspect ? options.inspect() : Promise.resolve([])
      }
    )
  )
  return {
    ...env,
    compiled,
    inspections,
    images,
    diagnostics,
    async change(css) {
      value.value = { ...value.value, css }
      generation.value++
      await settle()
    }
  }
}

test('workshop pause removes queued frames and 250ms checks; resume compiles only the latest draft', async () => {
  const fixture = diagnosticsFixture()
  const { diagnostics } = fixture
  try {
    assert.equal(fixture.frames.size, 1)
    diagnostics.pause()
    assert.equal(fixture.frames.size, 0)
    await fixture.frame()
    await fixture.timersAt(250)
    assert.deepEqual(fixture.compiled, [])
    assert.deepEqual(fixture.inspections, [])

    await fixture.change('second')
    await fixture.change('latest')
    assert.equal(fixture.frames.size, 0)
    diagnostics.resume()
    diagnostics.resume()
    assert.equal(fixture.frames.size, 1)
    await fixture.frame()
    assert.deepEqual(fixture.compiled, ['latest'])
    assert.equal(fixture.timers.size, 1)
    diagnostics.pause()
    assert.equal(fixture.timers.size, 0)
    await fixture.timersAt(250)
    assert.deepEqual(fixture.inspections, [])
    diagnostics.resume()
    assert.equal(fixture.frames.size, 0)
    await fixture.timersAt(250)
    assert.deepEqual(fixture.inspections, ['latest'])
    assert.deepEqual(fixture.compiled, ['latest'])
  } finally {
    fixture.dispose()
  }
})

test('workshop discards an asynchronous compile that finishes after pause', async () => {
  const gate = deferred()
  const fixture = diagnosticsFixture({ moduleGate: gate })
  try {
    await fixture.frame()
    fixture.diagnostics.pause()
    await fixture.change('latest')
    gate.resolve()
    await settle()
    assert.deepEqual(fixture.compiled, [])
    assert.equal(fixture.diagnostics.css.value, '')
    assert.equal(fixture.diagnostics.validProject.value, undefined)
    fixture.diagnostics.resume()
    await fixture.frame()
    assert.deepEqual(fixture.compiled, ['latest'])
    assert.equal(fixture.diagnostics.css.value, 'latest')
  } finally {
    fixture.dispose()
  }
})

test('pause and immediate resume discard a frame whose preview callback has not begun', async () => {
  const fixture = diagnosticsFixture()
  try {
    const [handle, callback] = fixture.frames.entries().next().value
    fixture.frames.delete(handle)
    callback(16)
    fixture.diagnostics.pause()
    fixture.diagnostics.resume()
    await settle()
    assert.deepEqual(fixture.compiled, [], 'the cancelled microtask cannot publish after resume')
    assert.equal(fixture.timers.size, 0)
    assert.equal(fixture.frames.size, 1, 'resume schedules one current reservation')
    await fixture.frame()
    assert.deepEqual(fixture.compiled, ['first'])
  } finally {
    fixture.dispose()
  }
})

test('a deferred old snapshot with the same project id and base cannot replace a newer generation', async () => {
  const gate = deferred()
  const fixture = diagnosticsFixture({ moduleGate: gate })
  try {
    await fixture.frame()
    await fixture.change('same id, same base, new generation')
    gate.resolve()
    await settle()
    assert.deepEqual(fixture.compiled, [])
    assert.equal(fixture.diagnostics.validProject.value, undefined)
    await fixture.frame()
    assert.deepEqual(fixture.compiled, ['same id, same base, new generation'])
  } finally {
    fixture.dispose()
  }
})

test('workshop save-time flush validates the latest paused draft without restarting automatic checks', async () => {
  const fixture = diagnosticsFixture()
  try {
    fixture.diagnostics.pause()
    await fixture.change('save draft')
    await fixture.diagnostics.flush()
    assert.deepEqual(fixture.compiled, ['save draft'])
    assert.equal(fixture.diagnostics.validProject.value.css, 'save draft')
    assert.equal(fixture.frames.size, 0)
    assert.equal(fixture.timers.size, 0)
    await fixture.timersAt(250)
    assert.deepEqual(fixture.inspections, [])
    fixture.diagnostics.resume()
    assert.equal(fixture.frames.size, 0)
    await fixture.timersAt(250)
    assert.deepEqual(fixture.inspections, ['save draft'])
  } finally {
    fixture.dispose()
  }
})

test('workshop pause ignores in-flight runtime results and ends an in-flight scene scan', async () => {
  const gate = deferred()
  const problem = {
    id: 'late',
    code: 'preview.contrast',
    severity: 'error',
    message: 'Late result',
    location: { kind: 'preview' }
  }
  const fixture = diagnosticsFixture({ inspect: () => gate.promise })
  try {
    await fixture.frame()
    await fixture.timersAt(250)
    assert.equal(fixture.inspections.length, 1)
    fixture.diagnostics.pause()
    gate.resolve([problem])
    await settle()
    assert.equal(fixture.diagnostics.report.value.errors, 0)
    fixture.diagnostics.resume()

    const scanGate = deferred()
    const scan = diagnosticsFixture({ inspect: () => scanGate.promise })
    try {
      await scan.frame()
      const fullCheck = scan.diagnostics.fullCheck()
      await until(() => scan.inspections.length === 1)
      assert.equal(scan.diagnostics.checking.value, true)
      assert.equal(scan.inspections.length, 1)
      assert.ok(scan.diagnostics.scene.value)
      scan.diagnostics.pause()
      assert.equal(scan.diagnostics.scene.value, undefined)
      assert.equal(scan.diagnostics.checking.value, false)
      scanGate.resolve([problem])
      await fullCheck
      assert.equal(scan.inspections.length, 1)
      assert.equal(scan.diagnostics.report.value.errors, 0)
      assert.equal(scan.diagnostics.stale.value, true)
      assert.equal(scan.frames.size, 0)
      assert.equal(scan.timers.size, 0)
    } finally {
      scan.dispose()
    }
  } finally {
    fixture.dispose()
  }
})

test('pause ignores a native image decode already in flight without claiming to cancel the decoder', async () => {
  const fixture = diagnosticsFixture({
    assets: [{ id: 'photo', name: 'Photo', type: 'image', dataUrl: 'data:image/png;base64,AA==' }]
  })
  try {
    await fixture.frame()
    await fixture.timersAt(250)
    assert.equal(fixture.images.length, 1)
    assert.equal(fixture.timers.size, 1, 'the native decoder timeout remains in flight')
    fixture.diagnostics.pause()
    await fixture.timersAt(250)
    assert.equal(fixture.images.length, 1, 'no further decoder starts while paused')
    fixture.images[0].onerror()
    await settle()
    assert.equal(fixture.diagnostics.report.value.errors, 0)
    assert.equal(fixture.timers.size, 0)
    fixture.diagnostics.resume()
    await fixture.timersAt(250)
    assert.equal(fixture.images.length, 1, 'the completed decode cache is reused')
    assert.equal(
      fixture.diagnostics.report.value.errors,
      1,
      'the current run receives the decode error'
    )
  } finally {
    fixture.dispose()
  }
})

async function studioFixture() {
  const env = environment()
  const theme = await import('../../../shared/theme.ts')
  const appearanceLayers = await import('../../../shared/appearanceLayers.ts')
  const visual = await import('./theme-studio/themeVisualControls.ts')
  const profile = JSON.parse(JSON.stringify(theme.TWILIGHT_DEFAULT_THEME))
  profile.id = 'user:pointer-boundary'
  profile.name = 'Original name'
  profile.overrides = { pureWhite: {}, dark: {} }
  profile.modes = {}
  const previews = []
  const recoveries = []
  const saved = []
  const themeStore = {
    activeTheme: vue.ref({ kind: 'user', id: profile.id }),
    profiles: vue.ref([profile]),
    snapshot: vue.ref({ data: { profileHistory: {} } }),
    saving: vue.ref(false),
    error: vue.ref(''),
    effectiveVariables: vue.ref({}),
    load: async () => {},
    setPreviewTone: async () => {},
    preview: async (value) => previews.push(JSON.parse(JSON.stringify(value))),
    previewTheme: async () => {},
    async saveProfile(value) {
      saved.push(JSON.parse(JSON.stringify(value)))
      themeStore.profiles.value = [value]
      return { data: { profiles: [value] } }
    },
    async setActive(value) {
      themeStore.activeTheme.value = value
    }
  }
  const editorModules = {
    '@renderer/components/theme-studio/themeVisualControls': visual,
    '../../../../shared/theme.ts': theme,
    '../../../../shared/appearanceLayers': appearanceLayers,
    '@renderer/extensions/registry': {
      useExtensionRegistry: () => ({
        themeContributions: vue.ref([]),
        syncExtensions: async () => {}
      })
    },
    '@renderer/extensions/themeSelection': {
      getPluginThemeKey: (value) => value.pluginId + ':' + value.id
    },
    '@renderer/stores/useThemeStore': { useThemeStore: () => themeStore },
    '@renderer/utils/themePreviewScheduler': schedulerModule(env),
    './themeStudioRecovery': {
      readThemeStudioRecovery: () => null,
      storeThemeStudioRecovery: (value) => recoveries.push(value)
    }
  }
  const { useThemeStudioEditor } = loadModule(
    'theme-studio/useThemeStudioEditor.ts',
    env,
    editorModules
  )
  const editor = env.run(() =>
    useThemeStudioEditor({ editable: true, initialKey: 'profile:' + profile.id, onBack() {} })
  )
  for (const callback of env.mounted) await callback()
  await env.frame()
  previews.length = 0
  recoveries.length = 0
  return { ...env, editor, previews, recoveries, saved, theme, visual, themeStore }
}

function nameEvent(value) {
  return { target: { value } }
}

test('theme name changes retain draft history, recovery and save metadata without visual previews', async () => {
  const fixture = await studioFixture()
  try {
    fixture.editor.changeName(nameEvent('Renamed theme'))
    await settle()
    assert.equal(fixture.editor.draft.value.name, 'Renamed theme')
    assert.equal(fixture.editor.isDirty.value, true)
    assert.equal(fixture.editor.canUndo.value, true)
    assert.equal(fixture.frames.size, 0)
    await fixture.timersAt(500)
    assert.equal(fixture.recoveries.at(-1).draft.name, 'Renamed theme')
    assert.deepEqual(fixture.previews, [])

    fixture.editor.changeName(nameEvent(' Renamed theme '))
    await settle()
    fixture.editor.undo()
    assert.equal(fixture.editor.draft.value.name, 'Original name')
    fixture.editor.redo()
    assert.equal(fixture.editor.draft.value.name, 'Renamed theme')
    await fixture.editor.applySelected()
    assert.equal(fixture.saved.at(-1).name, 'Renamed theme')
    assert.equal(fixture.editor.isDirty.value, false)
  } finally {
    fixture.dispose()
  }
})

test('a name edit leaves a pending real color preview intact', async () => {
  const fixture = await studioFixture()
  try {
    const definition = fixture.theme.THEME_TOKEN_DEFINITIONS.find(
      (item) => item.id === 'navigation.surface'
    )
    fixture.editor.updateToken(definition, '#333333')
    fixture.editor.changeName(nameEvent('Color and name'))
    await settle()
    assert.equal(fixture.frames.size, 1)
    await fixture.frame()
    assert.equal(fixture.previews.length, 1)
    assert.equal(fixture.previews[0].overrides.dark['navigation.surface'], '#333333')
    assert.equal(fixture.editor.draft.value.name, 'Color and name')
    await fixture.timersAt(500)
    assert.equal(fixture.recoveries.at(-1).draft.name, 'Color and name')
    assert.equal(fixture.recoveries.at(-1).draft.overrides.dark['navigation.surface'], '#333333')
  } finally {
    fixture.dispose()
  }
})

test('studio outside dismissal preserves focus while Escape returns it to the tools trigger', async () => {
  const fixture = await studioFixture()
  const dismissLayers = []
  try {
    const parts = await import('./appearanceParts.ts')
    const appearance = await import('../../../shared/appAppearance.ts')
    const layers = await import('../../../shared/appearanceLayers.ts')
    const modules = {
      './appearanceParts': parts,
      '../../../shared/theme': fixture.theme,
      '../../../shared/appAppearance': appearance,
      '../../../shared/appearanceLayers': layers,
      '../stores/useSettingsStore': { useSettingsStore: () => ({ settings: vue.ref({}) }) },
      './theme-studio/themeVisualControls': fixture.visual,
      '@renderer/components/theme-studio/useThemeStudioEditor': {
        useThemeStudioEditor: () => fixture.editor
      },
      '@renderer/app/useBackStack': { useBackHandlerWhileMounted: () => () => {} },
      '@renderer/app/useDismissLayer': {
        useEscapeToClose: (enabled, close) => dismissLayers.push({ enabled, close })
      }
    }
    const page = loadModule('ThemeStudioPage.vue', fixture, modules)
    const props = vue.reactive({
      controlsOnly: true,
      contextual: true,
      unified: true,
      active: true,
      part: 'navigation'
    })
    const state = fixture.run(() => page.default.setup(props, { expose() {}, emit() {} }))
    let focused = 0
    state.toolsTrigger.value = { focus: () => focused++ }
    state.toolsOpen.value = true
    state.closeContextTools(false)
    await settle()
    assert.equal(focused, 0)
    assert.equal(state.toolsOpen.value, false)
    state.toolsOpen.value = true
    const escape = dismissLayers.find((layer) => layer.enabled())
    assert.ok(escape)
    escape.close()
    await settle()
    assert.equal(focused, 1)
    assert.equal(state.toolsOpen.value, false)
    state.toolsOpen.value = true
    props.active = false
    await settle()
    assert.equal(state.toolsOpen.value, false)
    assert.equal(focused, 1)
  } finally {
    fixture.dispose()
  }
})

test('appearance resumes a clean studio with the latest active theme, preserving hidden dirty drafts', async () => {
  const env = environment()
  try {
    const theme = await import('../../../shared/theme.ts')
    const appearance = await import('../../../shared/appAppearance.ts')
    const parts = await import('./appearanceParts.ts')
    const editor = await import('./appearanceEditor.ts')
    const themeStore = {
      activeTheme: vue.ref({ kind: 'user', id: 'first' }),
      profiles: vue.ref([])
    }
    const modules = {
      './appearanceParts': parts,
      './appearanceEditor': editor,
      '../../../shared/theme': theme,
      '../../../shared/appAppearance': appearance,
      '../stores/useThemeStore': { useThemeStore: () => themeStore },
      '../stores/useSettingsStore': {
        useSettingsStore: () => ({ settings: vue.ref({}), loadSettings: async () => {} })
      },
      '../extensions/themeSelection': {
        getPluginThemeKey: (value) => value.pluginId + ':' + value.id
      },
      '../extensions/registry': {
        useExtensionRegistry: () => ({
          uiContributions: vue.ref([]),
          themeContributions: vue.ref([])
        })
      },
      '../app/useDismissLayer': { useEscapeToClose() {} },
      '../app/useBackStack': { useBackHandler() {} },
      '../app/pageDock': { usePageDock() {} },
      '../app/scrollMotion.ts': { scrollMotionBehavior: () => 'auto' },
      './theme-studio/themeStudioRecovery': { readThemeStudioRecovery: () => null },
      './settings-page/settingsDisclosureRegistry.ts': { provideSettingsDisclosures: () => ({}) },
      './settings-page/types.ts': { SETTINGS_SEARCH_INDEX: [], settingsDisclosurePath: () => [] }
    }
    const page = loadModule('AppearancePage.vue', env, modules)
    const props = vue.reactive({ active: false })
    const state = env.run(() => page.default.setup(props, { expose() {}, emit() {} }))
    const selections = []
    const studioState = vue.reactive({ dirty: false, busy: false })
    state.studio.value = {
      state: studioState,
      async selectKey(key) {
        selections.push(key)
      }
    }
    state.loaded.value = true
    state.tab.value = 'studio'
    themeStore.activeTheme.value = { kind: 'user', id: 'latest-hidden' }
    await settle()
    assert.deepEqual(selections, [])
    props.active = true
    await settle()
    assert.deepEqual(selections, ['profile:latest-hidden'])
    themeStore.activeTheme.value = { kind: 'user', id: 'latest-hidden' }
    await settle()
    assert.equal(selections.length, 2, 'same-key content refresh remains supported')
    studioState.dirty = true
    props.active = false
    themeStore.activeTheme.value = { kind: 'user', id: 'another-hidden' }
    await settle()
    props.active = true
    await settle()
    assert.equal(selections.length, 2, 'resume cannot replace an unapplied draft')
  } finally {
    env.dispose()
  }
})
