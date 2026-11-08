import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { hasPendingPersonalRestore, personalRestoreFiles, personalRestoreNeedsReview } from './personalRestoreFiles.ts'

test('light restore bootstrap detects primary and backup journals without treating a review as pending work', t => {
  const root = mkdtempSync(join(tmpdir(), 'restore-bootstrap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(hasPendingPersonalRestore(root, existsSync), false)
  assert.equal(personalRestoreNeedsReview(root, existsSync), false)
  for (const name of [personalRestoreFiles.pending, personalRestoreFiles.journal]) {
    for (const suffix of ['', '.bak']) {
      const file = join(root, name + suffix)
      writeFileSync(file, '{}')
      assert.equal(hasPendingPersonalRestore(root, existsSync), true)
      rmSync(file)
    }
  }
  writeFileSync(join(root, personalRestoreFiles.review + '.bak'), '{}')
  assert.equal(personalRestoreNeedsReview(root, existsSync), true)
  assert.equal(hasPendingPersonalRestore(root, existsSync), false)
})
