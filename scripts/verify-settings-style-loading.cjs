'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Follow only static dependencies: opening Settings must not require opening
// Appearance first, and vice versa. A combined component fixture misses this.
function assertSettingsStyleLoading(rendererDir, manifest) {
  const pages = Object.entries(manifest).filter(
    ([, entry]) => entry.name === 'SettingsPage' || entry.name === 'AppearancePage'
  )
  for (const [key, page] of pages) {
    const visited = new Set()
    const styles = new Set()
    function visit(dependency) {
      if (visited.has(dependency)) return
      visited.add(dependency)
      const entry = manifest[dependency]
      assert.ok(entry, `Missing dependency ${dependency} for ${page.name}`)
      for (const css of entry.css || []) styles.add(css)
      for (const imported of entry.imports || []) visit(imported)
    }
    visit(key)
    const css = [...styles]
      .map((file) => fs.readFileSync(path.join(rendererDir, file), 'utf8'))
      .join('\n')
    for (const [selector, property, value] of [
      ['settings-preview-page', 'position', 'fixed'],
      ['settings-preview-stack', 'display', 'flex'],
      ['setting-item', 'display', 'flex']
    ]) {
      const declaration = new RegExp(
        `\\.${selector}\\s*\\{[^}]*\\b${property}\\s*:\\s*${value}\\s*[;}]`
      )
      assert.match(css, declaration, `${page.name} is missing shared ${selector} styles`)
    }
  }
  return pages.length
}

module.exports = { assertSettingsStyleLoading }
