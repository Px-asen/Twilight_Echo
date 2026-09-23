const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

test('workshop handlers enforce sender and enablement and preserve applied versions', async () => {
  const { WorkshopRepository } = await import('../themes/workshopRepository.ts')
  const shared = await import('../../shared/themeWorkshop.ts')
  const templates = await import('../../shared/themeWorkshopTemplates.ts')
  const directory = mkdtempSync(join(tmpdir(), 'workshop-ipc-'))
  const handlers = new Map()
  let enabled = false
  let installed
  let installedCss
  const runtime = {
    pluginManagerReady: Promise.resolve(),
    pluginManager: {
      list: async () => [{ id: shared.THEME_WORKSHOP_ID, enabled }],
      installFromPath: async (path) => {
        installed = JSON.parse(readFileSync(join(path, 'plugin.json'), 'utf8'))
        installedCss = readFileSync(join(path, 'theme.css'), 'utf8')
      },
      enable: async (id) => assert.equal(id, installed.id)
    }
  }
  const exports = {}
  const source = ts.transpileModule(readFileSync(join(__dirname, 'themeWorkshop.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const dependencies = {
    electron: {
      app: { getPath: () => directory },
      dialog: {},
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
    },
    '../core/runtime.ts': { runtime },
    '../security/electronSecurity.ts': {
      assertTrustedIpcSender: (event) => {
        if (!event.trusted) throw new Error('untrusted')
      }
    },
    '../security/ipcValidation.ts': { stringifyJsonForIpcStorage: JSON.stringify },
    '../security/jsonSafety.ts': {},
    '../themes/workshopRepository.ts': { WorkshopRepository },
    '../themes/themeArchive.ts': {},
    '../../shared/themeWorkshopTemplates.ts': templates,
    '../../shared/themeWorkshop.ts': shared
  }
  vm.runInNewContext(source, {
    exports,
    require: (id) => (id.startsWith('node:') ? require(id) : dependencies[id]),
    setTimeout,
    clearTimeout
  })
  const invoke = (name, ...args) =>
    handlers.get(`themeWorkshop:${name}`)({ trusted: true }, ...args)
  try {
    exports.setupThemeWorkshopIpc()
    await assert.rejects(handlers.get('themeWorkshop:list')({ trusted: false }), /untrusted/)
    await assert.rejects(invoke('list'), /启用/)
    enabled = true
    const project = await invoke('create', 'minimal')
    const list = await invoke('list')
    assert.equal(list.length, 1)
    assert.equal(list[0].base, undefined)
    assert.equal((await invoke('get', project.id)).name, project.name)
    await assert.rejects(invoke('get', '../escape'), /无效/)
    await assert.rejects(invoke('save', { ...project, version: 'invalid' }), /无效/)
    await assert.rejects(invoke('restoreApplied', project.id), /没有应用/)
    const saved = await invoke('save', {
      ...project,
      tokens: { pureWhite: {}, dark: { 'color.primary.500': '#123456' } }
    })
    const applied = await invoke('apply', saved.id)
    assert.equal(installed.main, undefined)
    assert.equal(installed.apiVersion, 3)
    assert.equal(
      installed.contributes.themes[0].structured.variants.dark.tokens['color.primary.500'],
      '#123456'
    )
    assert.match(installedCss, /--te-primary-500:#123456/)
    assert.equal(applied.project.lastApplied.version, project.version)
    await invoke('save', { ...applied.project, name: '修改后' })
    assert.equal((await invoke('restoreApplied', saved.id)).name, project.name)
    enabled = false
    await assert.rejects(invoke('save', project), /启用/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('source snapshots export real plugin archives and editable projects without source files', async () => {
  const shared = await import('../../shared/themeWorkshop.ts')
  const templates = await import('../../shared/themeWorkshopTemplates.ts')
  const { WorkshopRepository } = await import('../themes/workshopRepository.ts')
  const { normalizeThemeContribution } = await import('../plugins/themeContribution.ts')
  const jsonSafety = await import('../security/jsonSafety.ts')
  const extract = require('extract-zip')
  const directory = mkdtempSync(join(tmpdir(), 'workshop-roundtrip-'))
  const sourceRoot = process.env.TWILIGHT_WORKSHOP_SOURCE || join(directory, 'source')
  const fixture = !process.env.TWILIGHT_WORKSHOP_SOURCE
  if (fixture) {
    mkdirSync(sourceRoot)
    writeFileSync(
      join(sourceRoot, 'art.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSocAAAAASUVORK5CYII=',
        'base64'
      )
    )
    writeFileSync(
      join(sourceRoot, 'theme.css'),
      ":root{--art:url('art.png')}.card{background-image:var(--art)}"
    )
    writeFileSync(join(sourceRoot, 'LICENSE'), 'Fixture attribution')
    writeFileSync(
      join(sourceRoot, 'plugin.json'),
      JSON.stringify({
        id: 'com.example.theme',
        version: '1.0.0',
        author: 'Author',
        license: 'MIT',
        contributes: {
          themes: [
            {
              id: 'theme',
              name: 'Source',
              stylesheet: 'theme.css',
              editor: {
                schemaVersion: 1,
                controls: [
                  {
                    id: 'art',
                    label: 'Art',
                    group: 'Images',
                    type: 'image',
                    variable: '--art',
                    defaults: { pureWhite: 'none', dark: 'none' }
                  }
                ]
              }
            }
          ]
        }
      })
    )
  }
  const manifest = JSON.parse(readFileSync(join(sourceRoot, 'plugin.json'), 'utf8'))
  const theme = manifest.contributes.themes[0]
  let sourceAvailable = true
  let savePath = join(directory, 'theme.tep')
  const handlers = new Map()
  const electron = {
    app: { getPath: () => directory },
    dialog: {
      showSaveDialog: async () => ({ filePath: savePath }),
      showOpenDialog: async () => ({ filePaths: [savePath] })
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
  }
  const runtime = {
    pluginManagerReady: Promise.resolve(),
    pluginManager: {
      list: async () => [
        { id: shared.THEME_WORKSHOP_ID, enabled: true },
        ...(sourceAvailable
          ? [
              {
                ...manifest,
                enabled: true,
                paths: { versionRoot: sourceRoot, manifestPath: join(sourceRoot, 'plugin.json') }
              }
            ]
          : [])
      ],
      listExtensions: async () => [
        {
          pluginId: manifest.id,
          themes: [{ ...theme, stylesheet: join(sourceRoot, theme.stylesheet) }]
        }
      ]
    }
  }
  function load(path, dependencies) {
    const exports = {}
    const source = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText
    vm.runInNewContext(source, {
      exports,
      Buffer,
      setTimeout,
      clearTimeout,
      require: (id) => (id.startsWith('node:') ? require(id) : (dependencies[id] ?? {}))
    })
    return exports
  }
  const archive = load(join(__dirname, '../themes/themeArchive.ts'), {
    electron,
    'extract-zip': extract
  })
  const module = load(join(__dirname, 'themeWorkshop.ts'), {
    electron,
    '../core/runtime.ts': { runtime },
    '../security/electronSecurity.ts': { assertTrustedIpcSender() {} },
    '../security/ipcValidation.ts': { stringifyJsonForIpcStorage: JSON.stringify },
    '../security/jsonSafety.ts': jsonSafety,
    '../themes/workshopRepository.ts': { WorkshopRepository },
    '../themes/themeArchive.ts': archive,
    '../../shared/themeWorkshopTemplates.ts': templates,
    '../../shared/themeWorkshop.ts': shared
  })
  const invoke = (name, ...args) => handlers.get('themeWorkshop:' + name)({}, ...args)
  try {
    module.setupThemeWorkshopIpc()
    const project = await invoke('create', '', {
      pluginId: manifest.id,
      themeId: theme.id,
      name: theme.name,
      version: manifest.version
    })
    assert.match(project.base.css, /data:image\//)
    const compiled = shared.compileWorkshopProject(project)
    sourceAvailable = false
    await assert.rejects(invoke('updateBase', project.id), /卸载/)
    await invoke('exportProject', project.id, 'tep')
    const extracted = join(directory, 'extracted')
    await extract(savePath, { dir: extracted })
    const exported = JSON.parse(readFileSync(join(extracted, 'plugin.json'), 'utf8'))
    const normalized = normalizeThemeContribution({
      pluginApiVersion: exported.apiVersion,
      pluginTypes: exported.type,
      raw: exported.contributes.themes[0],
      source: 'roundtrip',
      resolveStylesheet: (value) => join(extracted, value)
    })
    assert.notEqual(exported.id, manifest.id)
    assert.equal(exported.main, undefined)
    assert.equal(readFileSync(normalized.stylesheet, 'utf8'), compiled)
    assert.equal(
      JSON.parse(readFileSync(join(extracted, 'ATTRIBUTION.json'), 'utf8')).sourcePlugin,
      manifest.id
    )
    savePath = join(directory, 'theme.teworkshop')
    await invoke('exportProject', project.id, 'project')
    const restored = await invoke('importProject')
    assert.notEqual(restored.id, project.id)
    assert.equal(shared.compileWorkshopProject(restored), compiled)
    await assert.rejects(
      archive.writeStoredZip(extracted, join(directory, 'invalid-theme.zip')),
      /theme.json/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
