'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

test('health rejects a non-ready Core while status remains a successful diagnostic query', async t => {
  const { createServerAdmin } = await import('../src/main/server/admin.ts')
  const root = await mkdtemp(join(tmpdir(), 'twilight-health-'))
  let phase = 'ready'
  const admin = await createServerAdmin({ health: () => ({ phase, epoch: 'health-fixture' }) }, root)
  t.after(async () => { await admin.close(); await rm(root, { recursive: true, force: true }) })
  const entry = resolve(__dirname, '../out/server/server.cjs')
  const cli = command => promisify(execFile)(process.execPath, [entry, command, '--data', root],
    { timeout: 10_000, windowsHide: true })
  assert.equal(JSON.parse((await cli('health')).stdout).phase, 'ready')
  for (phase of ['starting', 'recovering', 'failed', 'stopped']) {
    await assert.rejects(cli('health'), error => {
      assert.equal(error.code, 1)
      assert.equal(JSON.parse(error.stdout).phase, phase)
      return true
    })
    assert.equal(JSON.parse((await cli('status')).stdout).phase, phase)
  }
})

test('health fails when there is no running Server', async t => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-health-stopped-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(promisify(execFile)(process.execPath,
    [resolve(__dirname, '../out/server/server.cjs'), 'health', '--data', root],
    { timeout: 10_000, windowsHide: true }), error => error.code === 1)
})
