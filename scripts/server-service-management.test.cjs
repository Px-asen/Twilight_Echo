'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

test('service management defaults to a read-only LocalService plan; even Install needs explicit Apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-service-plan-'))
  const data = join(root, "资料 ' profile")
  try {
    await mkdir(data)
    const original = JSON.stringify({
      version: 1,
      id: 'plan-only',
      libraryRoots: [],
      vst3Roots: []
    })
    await writeFile(join(data, 'server.json'), original)
    const run = async (extra) =>
      JSON.parse(
        (
          await promisify(execFile)(
            'pwsh',
            [
              '-NoProfile',
              '-NonInteractive',
              '-File',
              resolve(__dirname, 'manage-server-service.ps1'),
              '-Data',
              data,
              '-Node',
              process.execPath,
              ...extra
            ],
            { windowsHide: true }
          )
        ).stdout
      )
    for (const args of [[], ['-Action', 'Install', '-GrantProfileAccess']]) {
      const plan = await run(args)
      assert.equal(plan.changesApplied, false)
      assert.equal(plan.account, 'NT AUTHORITY\\LocalService')
      assert.equal(plan.bridgeOnly, true)
      assert.equal(plan.start, 'demand')
      assert.ok(plan.binaryPath.includes(`"${data}"`), JSON.stringify(plan))
      assert.deepEqual(await readdir(data), ['server.json'])
      assert.equal(await readFile(join(data, 'server.json'), 'utf8'), original)
    }
  } finally {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})
