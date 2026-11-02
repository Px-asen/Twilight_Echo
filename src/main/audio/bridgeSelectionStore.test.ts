import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { bridgeSelectionStore } from './bridgeSelectionStore.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-bridge-selection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: join(root, 'bridge-output-selection.json') }
}

test('a new profile uses local output; explicit choices survive restart', async (t) => {
  const { root, path } = await fixture(t)
  const store = await bridgeSelectionStore(root)
  assert.equal(store.selected, false)
  await store.save(true)
  assert.equal((await bridgeSelectionStore(root)).selected, true)
  await store.save(false)
  assert.equal((await bridgeSelectionStore(root)).selected, false)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, selected: false })
})

test('truncated or invalid selection records quarantine instead of selecting local', async (t) => {
  const { root, path } = await fixture(t)
  for (const data of [
    '',
    '{"selected":',
    'null',
    '[]',
    '{}',
    '{"version":2,"selected":false}',
    '{"version":1,"selected":"false"}'
  ]) {
    await writeFile(path, data)
    assert.equal((await bridgeSelectionStore(root)).selected, true, data)
    // Preserve the record for diagnosis until the user makes an explicit choice.
    assert.equal(await readFile(path, 'utf8'), data)
  }
  const store = await bridgeSelectionStore(root)
  await store.save(false)
  assert.equal((await bridgeSelectionStore(root)).selected, false)
})

test('a read failure is not treated as a missing first-run selection', async (t) => {
  const { root, path } = await fixture(t)
  await mkdir(path)
  assert.equal((await bridgeSelectionStore(root)).selected, true)
})
