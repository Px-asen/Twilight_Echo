const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createMinimalPe } = require('./pe-fixture.cjs')
const { NATIVE_RUNTIME_FILES } = require('./release-artifact-strip.cjs')
const {
  preparePackagedAppStaging,
  preparePackagedAudioStaging,
  productionPackageFileSets
} = require('./packaged-audio-staging.cjs')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('package verification follows the selected output directory rather than a running older build', () => {
  const { packageOutputDirectory } = require('./build-app-package.cjs')
  assert.equal(packageOutputDirectory(['--win']), path.join(root, 'dist'))
  assert.equal(
    packageOutputDirectory(['--win', '--config.directories.output=dist/audio-tail-fix']),
    path.join(root, 'dist', 'audio-tail-fix')
  )
  const isolated = path.join(os.tmpdir(), 'twilight-package-output')
  assert.equal(packageOutputDirectory(['--config.directories.output', isolated]), isolated)
})

test('packaging overlays an isolated fresh engine and dependencies while preserving live files and bundled assets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-isolated-package-'))
  const liveDir = path.join(directory, 'resources', 'audio-engine')
  const isolatedDir = path.join(directory, 'fresh')
  fs.mkdirSync(liveDir, { recursive: true })
  fs.mkdirSync(isolatedDir)
  fs.writeFileSync(path.join(directory, 'package.json'), '{"dependencies":{}}')
  fs.writeFileSync(
    path.join(directory, 'electron-builder.yml'),
    'files:\n  - out/**\nextraResources:\n  - from: resources/audio-engine\n'
  )
  for (const name of [
    ...NATIVE_RUNTIME_FILES,
    'msvcp140.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll'
  ]) {
    fs.writeFileSync(path.join(liveDir, name), createMinimalPe({ trailer: 'live-' + name }))
  }
  fs.mkdirSync(path.join(liveDir, 'automix-native'))
  fs.writeFileSync(path.join(liveDir, 'automix-native', 'manifest.json'), '{"preserved":true}')
  const freshCore = createMinimalPe({ imports: ['fresh-runtime.dll'], trailer: 'fresh-core' })
  fs.writeFileSync(path.join(isolatedDir, 'twilight-audio-engine.dll'), freshCore)
  fs.writeFileSync(
    path.join(isolatedDir, 'twilight_audio_node.node'),
    createMinimalPe({ trailer: 'fresh-addon' })
  )
  fs.writeFileSync(path.join(isolatedDir, 'fresh-runtime.dll'), createMinimalPe())
  const smtcOverride = path.join(directory, 'fresh-smtc.node')
  fs.writeFileSync(smtcOverride, createMinimalPe({ trailer: 'smtc-override' }))
  let staging
  try {
    staging = preparePackagedAudioStaging(directory, {
      environment: { TAE_AUDIO_ENGINE_STAGE_DIR: isolatedDir },
      nativeOverrides: { 'twilight_smtc_node.node': smtcOverride },
      stripNativeFile: () => undefined,
      observeRuntime: () => null
    })
    const packagedDir = path.join(path.dirname(staging.configPath), 'audio-engine')
    assert.deepEqual(
      fs.readFileSync(path.join(packagedDir, 'twilight-audio-engine.dll')),
      freshCore
    )
    assert.deepEqual(
      fs.readFileSync(path.join(packagedDir, 'twilight_smtc_node.node')),
      fs.readFileSync(smtcOverride)
    )
    assert.ok(fs.existsSync(path.join(packagedDir, 'fresh-runtime.dll')))
    assert.ok(fs.existsSync(path.join(liveDir, 'twilight_image_node.node')))
    assert.equal(fs.existsSync(path.join(packagedDir, 'twilight_image_node.node')), false)
    assert.equal(
      fs.readFileSync(path.join(packagedDir, 'automix-native', 'manifest.json'), 'utf8'),
      '{"preserved":true}'
    )
    assert.deepEqual(
      fs.readFileSync(path.join(liveDir, 'twilight-audio-engine.dll')),
      createMinimalPe({ trailer: 'live-twilight-audio-engine.dll' })
    )
    assert.deepEqual(
      fs.readFileSync(path.join(isolatedDir, 'twilight-audio-engine.dll')),
      freshCore
    )
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packagedDir, 'audio-capabilities.json'), 'utf8')
    )
    assert.ok(
      !manifest.nativeArtifacts.some((artifact) => artifact.path === 'twilight_image_node.node')
    )
    assert.ok(
      JSON.stringify(manifest).includes(createHash('sha256').update(freshCore).digest('hex'))
    )
  } finally {
    staging?.dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('desktop file sets retain installed nested production versions without dev packages', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-desktop-dependencies-'))
  const writePackage = (relative, name, version, dependencies = {}) => {
    const target = path.join(directory, relative)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(
      path.join(target, 'package.json'),
      JSON.stringify({ name, version, dependencies })
    )
  }
  try {
    writePackage('', 'desktop', '2.0.0', { parent: '1', shared: '1' })
    writePackage('node_modules/parent', 'parent', '1.0.0', { shared: '2' })
    writePackage('node_modules/shared', 'shared', '1.0.0')
    writePackage('node_modules/parent/node_modules/shared', 'shared', '2.0.0')
    writePackage('node_modules/dev-only', 'dev-only', '1.0.0')
    const parentManifest = path.join(directory, 'node_modules/parent/package.json')
    const parent = JSON.parse(fs.readFileSync(parentManifest, 'utf8'))
    parent.peerDependencies = { electron: '*' }
    fs.writeFileSync(parentManifest, JSON.stringify(parent))
    writePackage('node_modules/electron', 'electron', '43.8.1', { downloader: '1' })
    writePackage('node_modules/downloader', 'downloader', '1.0.0')
    const fileSets = productionPackageFileSets(directory)
    assert.deepEqual(fileSets.map((entry) => entry.to).sort(), [
      'node_modules/parent',
      'node_modules/parent/node_modules/shared',
      'node_modules/shared'
    ])
    assert.ok(fileSets.every((entry) => entry.filter.includes('!node_modules/**')))
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('an incomplete isolated engine cannot silently package an older live engine', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-incomplete-package-'))
  try {
    assert.throws(
      () =>
        preparePackagedAudioStaging(directory, {
          environment: { TAE_AUDIO_ENGINE_STAGE_DIR: directory }
        }),
      /Isolated audio staging is missing twilight-audio-engine\.dll/
    )
    fs.writeFileSync(path.join(directory, 'twilight-audio-engine.dll'), createMinimalPe())
    assert.throws(
      () =>
        preparePackagedAudioStaging(directory, {
          environment: { TAE_AUDIO_ENGINE_STAGE_DIR: directory }
        }),
      /Isolated audio staging is missing twilight_audio_node\.node/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('release configuration is intentionally unsigned and does not advertise a placeholder updater', () => {
  const builder = read('electron-builder.yml')
  assert.doesNotMatch(builder, /example\.com\/auto-updates/)
  assert.doesNotMatch(builder, /^publish:/m)
  assert.match(builder, /^win:\s*$/m)
  assert.doesNotMatch(builder, /^\s+forceCodeSigning:/m)
  assert.match(builder, /^\s+signAndEditExecutable:\s*false\s*$/m)
  assert.equal(fs.existsSync(path.join(root, 'electron-builder.release-win.yml')), false)
})

test('macOS hardened runtime permits bundled native code under local signatures', () => {
  const builder = read('electron-builder.yml')
  const entitlements = read('build/entitlements.mac.plist')
  assert.match(builder, /^mac:\s*\n\s+entitlementsInherit: build\/entitlements\.mac\.plist$/m)
  assert.match(
    entitlements,
    /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/
  )
})

test('release packaging writes an SHA-256 companion file for the installer', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-release-checksum-'))
  try {
    const installer = path.join(sandbox, 'TwilightEcho-1.0.2-setup.exe')
    fs.writeFileSync(installer, 'twilight-release')
    const { writeInstallerChecksum } = require('./build-windows-release.cjs')
    const checksumPath = await writeInstallerChecksum(installer)
    assert.equal(checksumPath, `${installer}.sha256`)
    const expected = createHash('sha256').update('twilight-release').digest('hex')
    assert.equal(
      fs.readFileSync(checksumPath, 'utf8'),
      `${expected}  TwilightEcho-1.0.2-setup.exe\n`
    )
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
})

test('macOS and Linux packaging stage nested production node_modules and resolve runtime targets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-cross-platform-staging-'))
  try {
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'desktop', version: '2.0.2', dependencies: { 'type-is': '1.6.18' } })
    )
    fs.writeFileSync(
      path.join(directory, 'electron-builder.yml'),
      'files:\n  - out/**\nextraResources:\n  - from: resources/audio-engine\n'
    )
    const typeIsDir = path.join(directory, 'node_modules', 'type-is')
    const nestedTyperDir = path.join(typeIsDir, 'node_modules', 'media-typer')
    fs.mkdirSync(nestedTyperDir, { recursive: true })
    fs.writeFileSync(
      path.join(typeIsDir, 'package.json'),
      JSON.stringify({
        name: 'type-is',
        version: '1.6.18',
        dependencies: { 'media-typer': '0.3.0' }
      })
    )
    fs.writeFileSync(
      path.join(nestedTyperDir, 'package.json'),
      JSON.stringify({ name: 'media-typer', version: '0.3.0' })
    )

    const staging = preparePackagedAppStaging(directory)
    try {
      assert.equal(staging.nativeDir, null)
      const stagedYaml = fs.readFileSync(staging.configPath, 'utf8')
      assert.match(stagedYaml, /- '!node_modules\/\*\*'/)
      assert.match(stagedYaml, /to: "node_modules\/type-is\/node_modules\/media-typer"/)
      assert.match(stagedYaml, /- from: resources\/audio-engine/)
    } finally {
      staging.dispose()
    }

    const {
      packagedRuntimeTargets,
      stripDefaultBuilderConfigArgs
    } = require('./build-app-package.cjs')
    assert.deepEqual(
      stripDefaultBuilderConfigArgs([
        '--mac',
        '--arm64',
        '--config',
        'electron-builder.yml',
        '--publish',
        'never'
      ]),
      ['--mac', '--arm64', '--publish', 'never']
    )
    const distDir = path.join(directory, 'dist')
    const macApp = path.join(distDir, 'mac-arm64', 'TwilightEcho.app')
    fs.mkdirSync(path.join(macApp, 'Contents', 'Resources'), { recursive: true })
    fs.writeFileSync(path.join(macApp, 'Contents', 'Resources', 'app.asar'), 'asar')
    assert.deepEqual(packagedRuntimeTargets(distDir, ['--mac', '--arm64']), [macApp])

    const linuxDir = path.join(distDir, 'linux-unpacked')
    fs.mkdirSync(path.join(linuxDir, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(linuxDir, 'resources', 'app.asar'), 'asar')
    assert.deepEqual(packagedRuntimeTargets(distDir, ['--linux']), [linuxDir])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
