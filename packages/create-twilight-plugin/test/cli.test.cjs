const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const extract = require('extract-zip')
const { initCommand, packCommand } = require('../lib/cli.cjs')
const { validatePluginManifest } = require('../lib/manifest.cjs')

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'twilight-plugin-cli-'))
}

test('packs the sidebar widget example with its custom HTML, scripts and styles', async () => {
  const root = await tempDir()
  const target = path.join(root, 'sidebar-widget')
  await fs.cp(path.resolve(__dirname, '../../../sdk/examples/sidebar-widget'), target, {
    recursive: true
  })
  const result = await packCommand([target])
  const unpacked = path.join(root, 'unpacked')
  await extract(result.outputFile, { dir: unpacked })
  const manifest = validatePluginManifest(
    JSON.parse(await fs.readFile(path.join(unpacked, 'plugin.json'), 'utf8'))
  )
  assert.equal(manifest.main, undefined)
  assert.equal(manifest.contributes.experiences[0].launch, 'sidebar')
  assert.deepEqual(manifest.contributes.experiences[0].sidebar, { height: 128 })
  for (const file of ['index.html', 'widget.js', 'widget.css'])
    assert.equal(await exists(path.join(unpacked, 'ui', file)), true)
})

test('CLI and host agree on sidebar launch and sizing validation', () => {
  const source = {
    id: 'com.example.widget',
    name: 'Widget',
    version: '1.0.0',
    description: 'Widget',
    author: 'Example',
    license: 'MIT',
    type: ['ui'],
    apiVersion: 4,
    engines: { twilightEcho: '*' },
    permissions: ['ui:inject']
  }
  const entry = { id: 'battery', name: 'Battery', entry: 'ui/index.html', bridgeVersion: 2 }
  const validate = (patch) =>
    validatePluginManifest({ ...source, contributes: { experiences: [{ ...entry, ...patch }] } })
  for (const launch of [undefined, 'page', 'panel', 'sidebar'])
    assert.doesNotThrow(() => validate({ launch }))
  for (const sidebar of [undefined, {}, { height: 64 }, { height: 480 }])
    assert.doesNotThrow(() => validate({ launch: 'sidebar', sidebar }))
  for (const patch of [
    { launch: 'flyout' },
    { launch: 'page', sidebar: {} },
    { launch: 'panel', sidebar: {} },
    ...[null, [], 128, { height: '128' }, { height: 63 }, { height: 481 }, { height: 128.5 }].map(
      (sidebar) => ({ launch: 'sidebar', sidebar })
    )
  ])
    assert.throws(() => validate(patch))
})

test('packs an API v4 experience dist entry and assets without recursively including packages', async () => {
  const root = await tempDir()
  const target = path.join(root, 'experience')
  await fs.mkdir(path.join(target, 'dist'), { recursive: true })
  await fs.writeFile(path.join(target, 'plugin.json'), JSON.stringify({ id: 'com.example.experience',
    name: 'Experience', version: '0.1.0', description: 'Test', author: 'Test', license: 'MIT',
    type: ['ui'], apiVersion: 4, engines: { twilightEcho: '*' }, permissions: ['ui:inject'],
    contributes: { experiences: [{ id: 'rhine', name: 'Rhine', entry: 'dist/index.html', bridgeVersion: 1 }] } }))
  await fs.writeFile(path.join(target, 'dist/index.html'), '<html></html>')
  await fs.writeFile(path.join(target, 'dist/scene.js'), 'export const ready = true')
  await fs.writeFile(path.join(target, 'dist/old.tep'), 'old package')
  const result = await packCommand([target])
  const unpacked = path.join(root, 'unpacked')
  await extract(result.outputFile, { dir: unpacked })
  assert.equal(await exists(path.join(unpacked, 'dist/index.html')), true)
  assert.equal(await exists(path.join(unpacked, 'dist/scene.js')), true)
  assert.equal(await exists(path.join(unpacked, 'dist/old.tep')), false)
  await fs.unlink(path.join(target, 'dist/index.html'))
  await assert.rejects(packCommand([target]))
})

test('init creates a valid tool plugin scaffold', async () => {
  const root = await tempDir()
  const target = path.join(root, 'my-tool')
  await initCommand([target, '--type', 'tool', '--id', 'com.example.my-tool', '--name', 'My Tool'])

  const manifest = validatePluginManifest(
    JSON.parse(await fs.readFile(path.join(target, 'plugin.json'), 'utf-8'))
  )
  assert.equal(manifest.id, 'com.example.my-tool')
  assert.deepEqual(manifest.type, ['tool'])
  assert.equal(await exists(path.join(target, 'src', 'index.mts')), true)
  assert.match(
    await fs.readFile(path.join(target, 'package.json'), 'utf-8'),
    /create-twilight-plugin/
  )
})

test('init creates provider, ui-tool, and theme manifests', async () => {
  for (const type of ['provider', 'ui-tool', 'theme']) {
    const root = await tempDir()
    const target = path.join(root, type)
    await initCommand([target, '--type', type, '--id', `com.example.${type}`])
    const manifest = validatePluginManifest(
      JSON.parse(await fs.readFile(path.join(target, 'plugin.json'), 'utf-8'))
    )
    assert.equal(manifest.id, `com.example.${type}`)
    if (type === 'theme') {
      assert.equal(manifest.main, undefined)
      assert.equal(manifest.apiVersion, 3)
      assert.equal(await exists(path.join(target, 'theme.css')), true)
      assert.equal(await exists(path.join(target, 'src', 'index.mts')), false)
      assert.equal(Array.isArray(manifest.contributes?.themes), true)
      assert.equal(manifest.contributes.themes[0].structured.schemaVersion, 3)
      assert.equal(manifest.contributes.themes[0].structured.modes.player.layout, 'split')
      assert.equal(manifest.contributes.themes[0].structured.layout.navigation, 'persistent')
    }
  }
})

test('tooling gates structured theme v2 and v3 on their matching plugin API versions', () => {
  const manifest = {
    id: 'com.example.mode-theme',
    name: 'Mode Theme',
    version: '1.0.0',
    description: 'Theme modes',
    author: 'Example',
    license: 'Apache-2.0',
    type: ['theme'],
    engines: { twilightEcho: '>=0.20.0' },
    apiVersion: 1,
    permissions: [],
    contributes: {
      themes: [
        {
          id: 'mode-theme',
          name: 'Mode Theme',
          structured: {
            schemaVersion: 2,
            variants: {},
            modes: { navigation: { style: 'rail' } }
          }
        }
      ]
    }
  }

  assert.throws(() => validatePluginManifest(manifest), /requires plugin apiVersion 2/)
  assert.equal(validatePluginManifest({ ...manifest, apiVersion: 2 }).apiVersion, 2)
  assert.equal(validatePluginManifest({ ...manifest, apiVersion: 3 }).apiVersion, 3)
  assert.throws(
    () =>
      validatePluginManifest({
        ...manifest,
        apiVersion: 2,
        contributes: {
          themes: [
            {
              ...manifest.contributes.themes[0],
              structured: {
                schemaVersion: 3,
                variants: {},
                layout: {
                  desktop: {
                    columns: ['fill'],
                    rows: ['auto', 'fill'],
                    areas: [['titleBar'], ['content']]
                  }
                }
              }
            }
          ]
        }
      }),
    /requires plugin apiVersion 3/
  )
})

test('pack creates a tep for declarative theme plugins without a JS build', async () => {
  const root = await tempDir()
  const target = path.join(root, 'my-theme')
  await initCommand([target, '--type', 'theme', '--id', 'com.example.theme-pack'])

  const outDir = path.join(root, 'packed')
  const result = await packCommand([target, '--out', outDir])
  assert.equal(path.extname(result.outputFile), '.tep')

  const extracted = path.join(root, 'extracted-theme')
  await fs.mkdir(extracted, { recursive: true })
  await extract(result.outputFile, { dir: extracted })
  const manifest = JSON.parse(await fs.readFile(path.join(extracted, 'plugin.json'), 'utf-8'))
  assert.equal(manifest.main, undefined)
  assert.equal(await exists(path.join(extracted, 'theme.css')), true)
  assert.equal(await exists(path.join(extracted, 'src', 'index.mts')), false)
})

test('pack creates a tep with plugin.json at root and excludes node_modules', async () => {
  const root = await tempDir()
  const target = path.join(root, 'my-tool')
  await initCommand([target, '--type', 'tool', '--id', 'com.example.packable'])
  await fs.mkdir(path.join(target, 'dist'), { recursive: true })
  await fs.writeFile(
    path.join(target, 'dist', 'index.mjs'),
    'export function activate() {}',
    'utf-8'
  )
  await fs.mkdir(path.join(target, 'node_modules', 'ignored'), { recursive: true })
  await fs.writeFile(path.join(target, 'node_modules', 'ignored', 'file.js'), 'ignored', 'utf-8')

  const outDir = path.join(root, 'packed')
  const result = await packCommand([target, '--out', outDir])
  assert.equal(path.extname(result.outputFile), '.tep')

  const extracted = path.join(root, 'extracted')
  await fs.mkdir(extracted, { recursive: true })
  await extract(result.outputFile, { dir: extracted })
  assert.equal(await exists(path.join(extracted, 'plugin.json')), true)
  assert.equal(await exists(path.join(extracted, 'node_modules')), false)
})

test('pack accepts flags before the plugin directory', async () => {
  const root = await tempDir()
  const target = path.join(root, 'my-tool')
  await initCommand([target, '--type', 'tool', '--id', 'com.example.flag-order'])
  await fs.mkdir(path.join(target, 'dist'), { recursive: true })
  await fs.writeFile(
    path.join(target, 'dist', 'index.mjs'),
    'export function activate() {}',
    'utf-8'
  )

  const outDir = path.join(root, 'packed')
  const result = await packCommand(['--out', outDir, target])
  assert.match(result.outputFile, /com\.example\.flag-order-1\.0\.0\.tep$/)
  assert.equal(await exists(result.outputFile), true)
})

test('tooling canonicalizes nested manifest paths to POSIX on every host', () => {
  const base = {
    id: 'com.example.path-vector',
    name: 'Path Vector',
    version: '1.0.0',
    description: 'Cross-platform path vector',
    author: 'Example',
    license: 'Apache-2.0',
    type: ['tool', 'dsp'],
    engines: { twilightEcho: '>=0.20.0' },
    apiVersion: 1,
    permissions: ['dsp:native']
  }
  const windowsStyle = validatePluginManifest({
    ...base,
    main: 'dist\\generated\\..\\index.mjs',
    icon: 'assets\\icons\\plugin.png',
    binary: { 'win32-x64': 'native\\win32\\plugin.dll' }
  })
  const posixStyle = validatePluginManifest({
    ...base,
    main: 'dist/index.mjs',
    icon: 'assets/icons/plugin.png',
    binary: { 'win32-x64': 'native/win32/plugin.dll' }
  })

  assert.deepEqual(windowsStyle, posixStyle)
  assert.equal(windowsStyle.main, 'dist/index.mjs')
  assert.equal(windowsStyle.icon, 'assets/icons/plugin.png')
  assert.deepEqual(windowsStyle.binary, { 'win32-x64': 'native/win32/plugin.dll' })
  const rejectedPaths = [
    '../escape.mjs',
    'dist/../../escape.mjs',
    '..\\escape.mjs',
    '/rooted.mjs',
    '\\rooted.mjs',
    'C:\\rooted.mjs',
    'C:/rooted.mjs',
    'C:drive-relative.mjs',
    '\\\\server\\share\\plugin.mjs',
    'dist/illegal\0entry.mjs'
  ]
  const validDspBinary = { 'win32-x64': 'native/win32/plugin.dll' }
  for (const candidate of rejectedPaths) {
    assert.throws(
      () => validatePluginManifest({ ...base, main: candidate, binary: validDspBinary }),
      /outside|null byte/
    )
    assert.throws(
      () =>
        validatePluginManifest({
          ...base,
          main: 'index.mjs',
          icon: candidate,
          binary: validDspBinary
        }),
      /outside|null byte/
    )
    assert.throws(
      () =>
        validatePluginManifest({
          ...base,
          main: 'index.mjs',
          binary: { 'win32-x64': candidate }
        }),
      /outside|null byte/
    )
  }
})

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
