import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultThemeLibraryDocument } from '../../../shared/theme.ts'
import { isThemeLibrarySnapshotNewer } from './themeRuntimeRevision.ts'

function snapshot(revision: number) {
  return {
    version: 2 as const,
    revision,
    savedAt: new Date(0).toISOString(),
    data: createDefaultThemeLibraryDocument()
  }
}

test('accepts only strictly newer theme snapshots', () => {
  const current = snapshot(12)

  assert.equal(isThemeLibrarySnapshotNewer(null, current), true)
  assert.equal(isThemeLibrarySnapshotNewer(current, snapshot(11)), false)
  assert.equal(isThemeLibrarySnapshotNewer(current, snapshot(12)), false)
  assert.equal(isThemeLibrarySnapshotNewer(current, snapshot(13)), true)
})
