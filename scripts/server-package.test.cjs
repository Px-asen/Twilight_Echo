'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')
const { packageServer, archiveServerPackage } = require('./package-server.cjs')
const { pipeline } = require('node:stream/promises')
const yauzl = require('yauzl')
const { readPeHeader, assertStrippedPe } = require('./verify-release-artifacts.cjs')
const { registerServerCliTest } = require('./server-cli.test.cjs')

const temporary = fs.mkdtempSync(join(tmpdir(), 'twilight-server-package-test-'))
const built = join(temporary, "Server ' 中文 version")
const app =
  process.env.TWILIGHT_SERVER_PACKAGE_TEST_ROOT ||
  join(temporary, 'unpacked', "Server ' 中文 version")
const node = join(app, 'runtime/node.exe')
const sourceHost = resolve(__dirname, '../out/server-service/twilight-server-service.exe')
const originalHeader = readPeHeader(sourceHost)
test.before(async () => {
  if (!process.env.TWILIGHT_SERVER_PACKAGE_TEST_ROOT) {
    packageServer({ destination: built })
    const archive = await archiveServerPackage(built, join(temporary, 'server.zip'))
    assert.match(fs.readFileSync(archive.checksum, 'utf8'), /^[a-f0-9]{64}  server\.zip\n$/)
    await assert.rejects(archiveServerPackage(built, archive.archive), /已存在/)
    // Exercise the actual transfer artifact, including Unicode and long dependency paths.
    await new Promise((resolveZip, reject) =>
      yauzl.open(archive.archive, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error)
        zip.on('error', reject)
        zip.on('end', resolveZip)
        zip.on('entry', (entry) => {
          const target = join(temporary, 'unpacked', entry.fileName)
          fs.mkdirSync(resolve(target, '..'), { recursive: true })
          zip.openReadStream(entry, async (error, stream) => {
            if (error) return reject(error)
            try {
              await pipeline(stream, fs.createWriteStream(target, { flags: 'wx' }))
              zip.readEntry()
            } catch (error) {
              reject(error)
            }
          })
        })
        zip.readEntry()
      })
    )
  }
})
test.after(() => {
  assert.deepEqual(readPeHeader(sourceHost), originalHeader)
  assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
  fs.rmSync(temporary, { recursive: true, force: true })
})

test('self-contained Server package contains its runtime, licenses and closed dependency inventory; launchers do not use global Node', () => {
  const manifest = JSON.parse(fs.readFileSync(join(app, 'server-package.json'), 'utf8'))
  assert.equal(manifest.platform, 'win32')
  assert.equal(manifest.arch, 'x64')
  assert.match(manifest.nodeVersion, /^v24\./)
  assert.ok(manifest.packages.length > 100)
  assert.ok(
    fs
      .readFileSync(join(app, 'README.txt'), 'utf8')
      .includes(String.raw`--data D:\ServerData\TwilightEcho`)
  )
  assert.equal(fs.existsSync(join(app, 'node_modules/electron')), false)
  assert.equal(fs.existsSync(join(app, 'node_modules/vite')), false)
  assert.equal(fs.existsSync(join(app, 'node_modules/typescript')), false)
  assert.ok(
    fs.readFileSync(join(app, 'runtime/LICENSE.txt'), 'utf8').startsWith('Node.js is licensed')
  )
  assertStrippedPe(join(app, manifest.service))
  assertStrippedPe(join(app, 'resources/audio-engine/twilight-audio-engine.dll'))
  const env = { ...process.env, NODE_PATH: '', PATH: `${process.env.SystemRoot}\\System32` }
  assert.equal(
    execFileSync(node, ['-p', 'process.execPath'], {
      encoding: 'utf8',
      env,
      windowsHide: true
    }).trim(),
    node
  )
  const pwsh = execFileSync(join(process.env.SystemRoot, 'System32/where.exe'), ['pwsh'], {
    encoding: 'utf8',
    windowsHide: true
  })
    .trim()
    .split(/\r?\n/)[0]
  const help = execFileSync(
    pwsh,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '& $env:TWILIGHT_TEST_LAUNCHER --help; exit $LASTEXITCODE'
    ],
    {
      encoding: 'utf8',
      env: { ...env, TWILIGHT_TEST_LAUNCHER: join(app, 'server.cmd') },
      windowsHide: true
    }
  )
  assert.match(help, /整包导出/)
  assert.match(help, /upgrade-recover/)
  assert.ok(fs.existsSync(join(app, 'scripts/server-service-upgrade.ps1')))
  const data = join(temporary, "资料 ' profile")
  execFileSync(node, [join(app, manifest.entry), 'init', '--data', data], {
    env,
    windowsHide: true
  })
  // Read-only PowerShell plan from the packaged management entry.
  const plan = JSON.parse(
    execFileSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', join(app, 'manage-service.ps1'), '-Data', data],
      { encoding: 'utf8', windowsHide: true }
    )
  )
  assert.equal(plan.changesApplied, false)
  assert.ok(plan.binaryPath.includes(`"${node}"`))
  assert.throws(() => packageServer({ destination: app }), /目标已存在/)
  console.log(
    '[server-package]',
    JSON.stringify({
      app,
      packages: manifest.packages.length,
      bundledNode: manifest.nodeVersion,
      noGlobalNode: true,
      servicePlanOnly: true
    })
  )
})

registerServerCliTest('native', {
  applicationRoot: app,
  nodeExecutable: node,
  isolatedPackage: true,
  configurationMigration: true
})
registerServerCliTest('service-child', {
  applicationRoot: app,
  nodeExecutable: node,
  isolatedPackage: true,
  sessionQueues: true
})
registerServerCliTest('service-child', {
  applicationRoot: app,
  nodeExecutable: node,
  isolatedPackage: true,
  dspManagement: true
})
registerServerCliTest('service-child', {
  applicationRoot: app,
  nodeExecutable: node,
  isolatedPackage: true,
  pluginManagement: true
})
