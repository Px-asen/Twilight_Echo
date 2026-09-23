const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { parse, compileScript, compileTemplate } = require('@vue/compiler-sfc')

for (const filename of [
  'ThemeWorkshopPage.vue',
  'WorkshopPreview.vue',
  'WorkshopLayersPanel.vue',
  'WorkshopAssetsPanel.vue',
  'WorkshopModesPanel.vue'
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

test('workshop opens below the theme studio in settings without a sidebar shortcut', () => {
  const app = readFileSync(join(__dirname, '../../App.vue'), 'utf8')
  const controls = readFileSync(
    join(__dirname, '../settings-page/ThemeControlsSettings.vue'),
    'utf8'
  )
  assert.match(app, /page\.pluginId !== 'com\.twilightecho\.tool\.theme-workshop'/)
  assert.ok(controls.indexOf('<strong>主题创意工坊') < controls.indexOf('<strong>主题插件工坊'))
  assert.match(controls, /:disabled="!workshopEnabled"/)
  assert.match(app, /@open-theme-workshop="openThemeWorkshop"/)
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
    createElement: () => ({ textContent: '' }),
    head: { append() {}, insertBefore() {} },
    body: {}
  }
  const exports = {}
  const scope = vue.effectScope()
  vm.runInNewContext(code, {
    exports,
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
