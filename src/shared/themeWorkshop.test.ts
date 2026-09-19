import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWorkshopProject,
  compileWorkshopProject,
  exportWorkshopEditor,
  normalizeThemeEditor,
  compileWorkshopTheme,
  copyWorkshopDraft,
  isWorkshopProject
} from './themeWorkshop.ts'
import { createWorkshopLayer } from './themeWorkshopLayers.ts'

test('image replacements compile embedded assets without allowing declaration injection', () => {
  const project = createWorkshopProject('00000000-0000-0000-0000-000000000000', '主题')
  project.base.editor = {
    schemaVersion: 1,
    controls: [
      {
        id: 'image',
        label: '图片',
        group: '背景',
        type: 'image',
        variable: '--picture',
        defaults: { dark: 'none', pureWhite: 'none' }
      }
    ]
  }
  project.values.pureWhite.image = "url('data:image/webp;base64,YWJj')"
  assert.match(compileWorkshopProject(project), /data:image\/webp;base64,YWJj/)
  project.values.pureWhite.image = 'red;display:none'
  assert.throws(() => compileWorkshopProject(project), /无效/)
})

test('inheritance does not materialize editor defaults and scoped changes stay tone-specific', () => {
  const project = createWorkshopProject('00000000-0000-0000-0000-000000000000', '主题')
  project.base.css = '.card { --wash: 44% }'
  project.base.editor = {
    schemaVersion: 1,
    controls: [
      {
        id: 'wash',
        label: '蒙版',
        group: '背景',
        type: 'number',
        variable: '--wash',
        selector: '.card',
        defaults: { dark: '60%', pureWhite: '44%' }
      }
    ]
  }
  assert.equal(compileWorkshopProject(project).includes('--wash:60%'), false)
  project.values.dark.wash = '70%'
  assert.match(
    compileWorkshopProject(project),
    /html\[data-theme='dark'\] .card \{--wash:70% !important\}/
  )
  assert.ok(compileWorkshopProject(project).startsWith(project.base.css))
})

test('editor descriptors discard duplicate IDs and invalid selectors', () => {
  const control = {
    id: 'x',
    label: 'X',
    group: 'G',
    type: 'text',
    variable: '--x',
    defaults: { dark: '0', pureWhite: '0' }
  }
  const result = normalizeThemeEditor({
    schemaVersion: 1,
    controls: [control, control, { ...control, id: 'y', selector: '{}' }]
  })
  assert.equal(result?.controls.length, 1)
})

test('unlinked local and streaming masks compile independently', () => {
  const project = createWorkshopProject('00000000-0000-0000-0000-000000000000', '独立蒙版')
  project.base.editor = {
    schemaVersion: 1,
    controls: [
      {
        id: 'wash',
        label: '蒙版',
        group: '列表',
        type: 'number',
        variable: '--wash',
        defaults: { dark: '60%', pureWhite: '44%' },
        targets: { local: '.song-list', streaming: '.streaming-content' }
      }
    ]
  }
  project.unlinked = { wash: true }
  project.values.pureWhite = { 'wash.local': '30%', 'wash.streaming': '70%' }
  const css = compileWorkshopProject(project)
  assert.match(css, /\.song-list \{--wash:30% !important\}/)
  assert.match(css, /\.streaming-content \{--wash:70% !important\}/)
  assert.doesNotMatch(css, /data-theme='dark'\] \.song-list/)
  const editor = exportWorkshopEditor(project)!
  assert.equal(editor.controls[0].defaults.pureWhite, '30%')
  assert.equal(editor.controls[1].defaults.pureWhite, '70%')
  assert.equal(editor.controls[0].targets, undefined)
  assert.equal(editor.controls[1].selector, '.streaming-content')
})

test('layers and assets survive serialization and history copies do not mutate previous drafts', () => {
  const project = createWorkshopProject('00000000-0000-0000-0000-000000000000', '图层')
  const layer = createWorkshopLayer('art', 'image')
  layer.assetId = 'image'
  layer.fade.left = 24
  project.assets = [
    {
      id: 'image',
      name: 'art.png',
      dataUrl: 'data:image/png;base64,YWJj',
      type: 'image',
      source: '作者',
      license: '许可'
    }
  ]
  project.layers = { pureWhite: { 'local.library': [layer] }, dark: {} }
  assert.ok(isWorkshopProject(JSON.parse(JSON.stringify(project))))
  const next = copyWorkshopDraft(project)
  next.layers!.pureWhite['local.library']![0].fade.left = 40
  next.assets![0].license = '新许可'
  assert.equal(project.layers.pureWhite['local.library']![0].fade.left, 24)
  assert.equal(project.assets[0].license, '许可')
  const css = compileWorkshopProject(project)
  assert.match(css, /data:image\/png;base64,YWJj/)
  assert.match(css, /mask-composite:intersect/)
  assert.match(css, /#000 24%/)
  assert.doesNotMatch(css, /html\[data-theme='dark'\] \.song-list/)
  next.layers!.pureWhite['local.library']![0].opacity = 3
  assert.equal(isWorkshopProject(next), false)
})

test('compiled packages keep structured layout, modes and explicit token overrides', () => {
  const project = createWorkshopProject('00000000-0000-0000-0000-000000000000', '布局')
  project.base.structured = {
    schemaVersion: 3,
    variants: {},
    modes: { library: { density: 'compact' } },
    layout: {
      desktop: { columns: ['fill'], rows: ['content', 'fill'], areas: [['titleBar'], ['content']] }
    }
  }
  project.tokens.dark['color.primary.500'] = '#112233'
  const compiled = compileWorkshopTheme(project)
  assert.deepEqual(
    compiled.structured?.schemaVersion === 3 && compiled.structured.layout,
    project.base.structured.layout
  )
  assert.deepEqual(
    compiled.structured?.schemaVersion === 3 && compiled.structured.modes,
    project.base.structured.modes
  )
  assert.equal(compiled.structured?.variants.dark?.tokens?.['color.primary.500'], '#112233')
  assert.match(compiled.css, /--te-primary-500:#112233/)
})
