'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { createRequire } = require('node:module')
const {
  collectProductionPackages,
  copyProductionPackages,
  resolvePackage
} = require('./server-package-dependencies.cjs')
const { packageServer, packageFiles, packageReadme } = require('./package-server.cjs')

function fixture(t) {
  const temporary = fs.mkdtempSync(join(tmpdir(), 'twilight-package-deps-'))
  t.after(() => {
    assert.equal(resolve(temporary, '..'), resolve(tmpdir()))
    fs.rmSync(temporary, { recursive: true, force: true })
  })
  const root = join(temporary, 'source'),
    target = join(temporary, 'target')
  fs.mkdirSync(root)
  const pkg = (directory, name, version, dependencies = {}, extra = {}) => {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name, version, main: 'index.cjs', dependencies, ...extra })
    )
    fs.writeFileSync(join(directory, 'index.cjs'), `module.exports=${JSON.stringify(version)}`)
    fs.writeFileSync(join(directory, 'LICENSE'), 'fixture license')
  }
  return { root, target, pkg }
}

test('packaged README commands retain literal Windows absolute paths', () => {
  const readme = packageReadme('1.4.0', 'v24.21.0')
  assert.equal(readme.split(String.raw`D:\ServerData\TwilightEcho`).length - 1, 6)
  assert.ok(readme.includes(String.raw`--library D:\Music`))
  assert.ok(readme.includes(String.raw`--from D:\Apps\Server-old --to D:\Apps\Server-new`))
  assert.ok(readme.includes(String.raw`rollback --work D:\ServerData\Upgrade-01`))
  assert.ok(readme.includes(String.raw`pwsh -File D:\ServerData\Upgrade-01\service-console.ps1`))
})

test('production closure preserves nested installed versions, exports-hidden manifests, peers and builtin-named packages without dev files', (t) => {
  const f = fixture(t)
  f.pkg(
    join(f.root, 'node_modules/a'),
    'a',
    '1.0.0',
    { shared: '1' },
    { peerDependencies: { peer: '*' }, optionalDependencies: { absent: '*' } }
  )
  f.pkg(join(f.root, 'node_modules/b'), 'b', '1.0.0', { shared: '2' })
  f.pkg(join(f.root, 'node_modules/shared'), 'shared', '1.0.0')
  f.pkg(
    join(f.root, 'node_modules/b/node_modules/shared'),
    'shared',
    '2.0.0',
    {},
    { exports: './index.cjs' }
  )
  f.pkg(join(f.root, 'node_modules/peer'), 'peer', '1.0.0')
  f.pkg(join(f.root, 'node_modules/string_decoder'), 'string_decoder', '1.3.0')
  f.pkg(join(f.root, 'node_modules/dev-only'), 'dev-only', '1.0.0')
  fs.mkdirSync(join(f.root, 'node_modules/a/tests'))
  fs.writeFileSync(join(f.root, 'node_modules/a/tests/private'), 'not runtime')
  const inventory = copyProductionPackages(f.root, f.target, {
    a: '*',
    b: '*',
    string_decoder: '*'
  })
  assert.equal(inventory.length, 6)
  const fromA = createRequire(join(f.target, 'node_modules/a/package.json'))
  const fromB = createRequire(join(f.target, 'node_modules/b/package.json'))
  assert.equal(fromA('shared'), '1.0.0')
  assert.equal(fromB('shared'), '2.0.0')
  assert.equal(fromA('peer'), '1.0.0')
  assert.ok(resolvePackage(f.target, 'string_decoder').startsWith(f.target))
  assert.equal(fs.existsSync(join(f.target, 'node_modules/dev-only')), false)
  assert.equal(fs.existsSync(join(f.target, 'node_modules/a/tests')), false)
  assert.equal(fs.readFileSync(join(f.target, 'node_modules/a/LICENSE'), 'utf8'), 'fixture license')
})

test('circular dependencies terminate with Node-compatible ancestors, and missing required modules fail before copying', (t) => {
  const f = fixture(t)
  f.pkg(join(f.root, 'node_modules/a'), 'a', '1', { b: '*' })
  f.pkg(join(f.root, 'node_modules/b'), 'b', '1', { a: '*' })
  assert.equal(copyProductionPackages(f.root, f.target, { a: '*', b: '*' }).length, 2)
  assert.throws(() => collectProductionPackages(f.root, { unknown: '*' }), /缺少已安装的生产依赖/)
  f.pkg(join(f.root, 'node_modules/broken'), 'broken', '1', { unknown: '*' })
  assert.throws(() => collectProductionPackages(f.root, { broken: '*' }), /broken -> unknown/)
})

test('incomplete package publication cleans only its owned staging directory; portable inventories refuse junctions', (t) => {
  const f = fixture(t)
  fs.writeFileSync(
    join(f.root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: {} })
  )
  assert.throws(
    () =>
      packageServer({
        root: f.root,
        destination: f.target,
        nodeLicense: resolve(__dirname, '../resources/server-runtime/node-v24.21.0-LICENSE.txt')
      }),
    /ENOENT/
  )
  assert.equal(fs.existsSync(f.target), false)
  assert.deepEqual(fs.readdirSync(resolve(f.root, '..')), ['source'])
  fs.mkdirSync(f.target)
  fs.symlinkSync(f.target, join(f.root, 'outside'), 'junction')
  assert.throws(() => packageFiles(f.root), /链接/)
})
