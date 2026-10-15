'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { assertSettingsStyleLoading } = require('./verify-settings-style-loading.cjs')

test('each lazy page loads its foundations without opening its peer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-settings-css-'))
  try {
    fs.writeFileSync(
      path.join(root, 'foundations.css'),
      '.settings-preview-page {position:fixed;} .settings-preview-stack {display:flex;} .setting-item {display:flex;}'
    )
    const manifest = {
      settings: { name: 'SettingsPage', imports: ['app'], dynamicImports: ['appearance'] },
      appearance: { name: 'AppearancePage', imports: ['app'], css: ['foundations.css'] },
      app: {}
    }
    assert.throws(
      () => assertSettingsStyleLoading(root, manifest),
      /SettingsPage is missing shared settings-preview-page styles/
    )
    manifest.app.css = ['foundations.css']
    assert.equal(assertSettingsStyleLoading(root, manifest), 2)
    delete manifest.appearance.css
    assert.equal(assertSettingsStyleLoading(root, manifest), 2)
    delete manifest.app.css
    manifest.settings.css = ['foundations.css']
    assert.throws(
      () => assertSettingsStyleLoading(root, manifest),
      /AppearancePage is missing shared settings-preview-page styles/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
