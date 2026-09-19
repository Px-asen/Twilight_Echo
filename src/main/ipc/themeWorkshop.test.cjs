const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, mkdtempSync, rmSync } = require('node:fs')
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
