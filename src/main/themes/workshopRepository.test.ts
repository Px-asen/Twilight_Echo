import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkshopRepository } from './workshopRepository.ts'
import { createWorkshopProject } from '../../shared/themeWorkshop.ts'

test('projects survive reopening and stale writes cannot overwrite newer drafts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workshop-test-'))
  try {
    const repo = new WorkshopRepository(directory)
    const initial = createWorkshopProject('00000000-0000-0000-0000-000000000000', '我的主题')
    const saved = repo.save(initial)
    assert.equal(saved.revision, 1)
    assert.deepEqual(new WorkshopRepository(directory).get(initial.id), saved)
    assert.throws(() => repo.save(initial), /其他窗口/)
    assert.throws(() => repo.get('../outside'), /无效/)
    const applied = repo.saveApplied({ ...saved, name: '已应用' })
    repo.save({ ...applied, name: '未应用草稿' })
    const restored = new WorkshopRepository(directory).restoreApplied(initial.id)
    assert.equal(restored.name, '已应用')
    assert.equal(restored.revision, 4)
    assert.equal(repo.list().length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
