const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

test('installed extract-zip rejects a symlink followed by a same-name file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-zip-patch-'))
  try {
    const local = []
    const central = []
    let offset = 0
    for (const [mode, content] of [
      [0o120777, '../outside.txt'],
      [0o100644, 'overwritten']
    ]) {
      const name = Buffer.from('escape')
      const data = Buffer.from(content)
      const crc = require('buffer-crc32').unsigned(data)
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt32LE(crc, 14)
      header.writeUInt32LE(data.length, 18)
      header.writeUInt32LE(data.length, 22)
      header.writeUInt16LE(name.length, 26)
      local.push(header, name, data)
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(0x0314, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt32LE(crc, 16)
      record.writeUInt32LE(data.length, 20)
      record.writeUInt32LE(data.length, 24)
      record.writeUInt16LE(name.length, 28)
      record.writeUInt32LE((mode << 16) >>> 0, 38)
      record.writeUInt32LE(offset, 42)
      central.push(record, name)
      offset += header.length + name.length + data.length
    }
    const directory = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(2, 8)
    end.writeUInt16LE(2, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    const archive = path.join(root, 'attack.zip')
    fs.writeFileSync(archive, Buffer.concat([...local, directory, end]))
    const outside = path.join(root, 'outside.txt')
    fs.writeFileSync(outside, 'original')
    await assert.rejects(require('extract-zip')(archive, { dir: path.join(root, 'target') }), {
      message: /Refusing to extract symlink entry/
    })
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original')
    assert.equal(fs.existsSync(path.join(root, 'target', 'escape')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const {
  assertLocalVirtualStore,
  assertSingleLockfile,
  readModulesMetadata,
  verifyInstallPolicy
} = require('./verify-install-policy.cjs')

function makeCandidate(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-install-policy-'))
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ packageManager: 'pnpm@11.7.0', scripts: { postinstall: 'x' } })
  )
  fs.writeFileSync(
    path.join(root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\npackages:\n  '@neteasecloudmusicapienhanced/api@4.35.1(patch_hash=abc)': {}\n"
  )
  fs.writeFileSync(
    path.join(root, 'pnpm-workspace.yaml'),
    [
      'nodeLinker: hoisted',
      'overrides:',
      '  form-data: 4.0.6',
      '  qs: 6.16.0',
      'patchedDependencies:',
      "  '@neteasecloudmusicapienhanced/api@4.35.1': patches/@neteasecloudmusicapienhanced__api@4.35.1.patch"
    ].join('\n')
  )
  fs.writeFileSync(
    path.join(root, 'patches', '@neteasecloudmusicapienhanced__api@4.35.1.patch'),
    'patch'
  )
  const store = options.externalStore || path.join(root, 'node_modules', '.pnpm')
  if (!options.externalStore) fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'node_modules', '.modules.yaml'),
    `packageManager: pnpm@11.7.0\nvirtualStoreDir: ${store.replaceAll('\\', '/')}\n`
  )
  return root
}

test('install policy accepts the single-lock pnpm candidate layout', () => {
  const root = makeCandidate()
  try {
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy rejects an additional lockfile and an external virtual store', () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-external-store-'))
  const root = makeCandidate({ externalStore: external })
  try {
    assert.throws(() => assertLocalVirtualStore(root), /inside this candidate/)
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}')
    assert.throws(() => assertSingleLockfile(root), /package-lock\.json must not exist/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})

test('install policy reads pnpm JSON metadata written by modern pnpm', () => {
  const root = makeCandidate()
  try {
    const metadataPath = path.join(root, 'node_modules', '.modules.yaml')
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        packageManager: 'pnpm@11.7.0',
        virtualStoreDir: path.join(root, 'node_modules', '.pnpm')
      })
    )
    assert.deepEqual(readModulesMetadata(path.join(root, 'node_modules')), {
      packageManager: 'pnpm@11.7.0',
      virtualStoreDir: path.join(root, 'node_modules', '.pnpm')
    })
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy accepts a valid pnpm 11 candidate when metadata omits packageManager', () => {
  const root = makeCandidate()
  try {
    const metadataPath = path.join(root, 'node_modules', '.modules.yaml')
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ virtualStoreDir: path.join(root, 'node_modules', '.pnpm') })
    )
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy accepts pnpm hoisted layout without isolated metadata', () => {
  const root = makeCandidate()
  try {
    fs.rmSync(path.join(root, 'node_modules', '.modules.yaml'))
    fs.rmSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true, force: true })
    fs.mkdirSync(path.join(root, 'node_modules', 'local-package'))
    assert.equal(verifyInstallPolicy(root, { skipRuntime: true }), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('install policy rejects a hoisted dependency junction that escapes the candidate', () => {
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-external-module-'))
  const root = makeCandidate()
  try {
    fs.rmSync(path.join(root, 'node_modules', '.modules.yaml'))
    fs.rmSync(path.join(root, 'node_modules', '.pnpm'), { recursive: true, force: true })
    fs.symlinkSync(external, path.join(root, 'node_modules', 'external-package'), 'junction')
    assert.throws(() => assertLocalVirtualStore(root), /must stay inside this candidate/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})
