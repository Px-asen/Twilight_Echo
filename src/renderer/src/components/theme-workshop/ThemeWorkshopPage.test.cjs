const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')

for (const filename of [
  'CustomThemeAdvancedPanel.vue',
  'WorkshopPreview.vue',
  'WorkshopLayersPanel.vue',
  'WorkshopAssetsPanel.vue',
  'WorkshopModesPanel.vue',
  'WorkshopControl.vue',
  'WorkshopParameterDesigner.vue',
  'WorkshopDiagnosticsPanel.vue',
  'WorkshopProjectPanel.vue',
  'WorkshopOnboarding.vue',
  'WorkshopCanvasOverlay.vue'
]) {
  test(`${filename} compiles through the Vue SFC compiler`, () => {
    const source = readFileSync(join(__dirname, filename), 'utf8')
    const parsed = parse(source, { filename })
    assert.deepEqual(parsed.errors, [])
    const script = compileScript(parsed.descriptor, { id: 'workshop-test' })
    const result = compileTemplate({
      source: parsed.descriptor.template.content,
      filename,
      id: 'workshop-test',
      compilerOptions: {
        bindingMetadata: script.bindings,
        expressionPlugins: ['typescript']
      }
    })
    assert.deepEqual(result.errors, [])
  })
}

test('advanced authoring belongs to customization without optional plugin enablement', () => {
  const page = readFileSync(join(__dirname, '../AppearancePage.vue'), 'utf8')
  const controls = readFileSync(
    join(__dirname, '../settings-page/ThemeControlsSettings.vue'),
    'utf8'
  )
  assert.match(page, /CustomThemeAdvancedPanel/)
  assert.match(page, /导出 \.TEP/)
  assert.doesNotMatch(
    page,
    /appearance-selection-tab|appearance-workshop-tab|workshopEnableDialog|AppearanceThemeSelection/
  )
  assert.doesNotMatch(controls, /主题创意工坊|主题插件工坊|workshopEnabled/)
})

test('preview refreshes mode-only edits and reads candidate layout independently of CSS validity', async () => {
  const vue = require('vue')
  const ts = require('typescript')
  const vm = require('node:vm')
  const shared = await import('../../../../shared/themeWorkshop.ts')
  const theme = await import('../../../../shared/theme.ts')
  const filename = join(__dirname, 'WorkshopPreview.vue')
  const parsed = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(parsed.descriptor, { id: 'preview-behavior' })
  const code = ts.transpileModule(script.content, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const attributes = {}
  const doc = {
    documentElement: {
      dataset: {},
      setAttribute: (key, value) => {
        attributes[key] = value
      },
      removeAttribute: (key) => {
        delete attributes[key]
      }
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ textContent: '' }),
    head: { append() {}, insertBefore() {} },
    body: {}
  }
  const exports = {}
  const scope = vue.effectScope()
  vm.runInNewContext(code, {
    exports,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    document: { querySelectorAll: () => [] },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    require: (id) =>
      id === 'vue'
        ? { ...vue, onBeforeUnmount() {} }
        : id.endsWith('/themeWorkshop')
          ? shared
          : id.endsWith('/theme')
            ? theme
            : id.endsWith('/workshopDecorations')
              ? { mountWorkshopDecorations: () => () => {} }
              : {}
  })
  const props = vue.shallowReactive({
    project: shared.createWorkshopProject('00000000-0000-0000-0000-000000000000', 'Preview'),
    css: '',
    tone: 'pureWhite',
    state: 'normal',
    surface: 'library',
    width: 1180
  })
  try {
    const state = scope.run(() => exports.default.setup(props, { expose() {} }))
    state.frame.value = { contentDocument: doc }
    await state.ready()
    const next = shared.copyWorkshopDraft(props.project)
    next.modes = { library: { density: 'compact' } }
    props.project = next
    await vue.nextTick()
    assert.equal(attributes['data-te-library-density'], 'compact')
    props.project = {
      ...next,
      layout: {
        navigation: 'hidden',
        desktop: {
          columns: ['fill'],
          rows: ['content', 'fill'],
          areas: [['titleBar'], ['content']]
        }
      },
      values: { pureWhite: { x: 'invalid;' }, dark: {} },
      base: {
        ...next.base,
        editor: {
          schemaVersion: 1,
          controls: [
            {
              id: 'x',
              label: 'X',
              group: 'G',
              type: 'number',
              variable: '--x',
              defaults: { pureWhite: '0', dark: '0' }
            }
          ]
        }
      }
    }
    await vue.nextTick()
    assert.equal(attributes['data-te-shell-layout'], 'custom')
    assert.equal(attributes['data-te-shell-navigation'], 'hidden')
  } finally {
    scope.stop()
  }
})
