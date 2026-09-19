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
