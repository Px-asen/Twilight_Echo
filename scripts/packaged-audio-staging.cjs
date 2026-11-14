const { archiveNativeSymbols, bindShippedSymbols, archiveRoot, artifactId } = require('./diagnostic-symbols.cjs')
const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const {
  NATIVE_RUNTIME_FILES,
  stripNativeFile: defaultStripNativeFile
} = require('./release-artifact-strip.cjs')
const { createAudioCapabilityManifest } = require('./generate-audio-capability-manifest.cjs')
const { createReleaseCapabilityStatus } = require('./verify-release-capability-consistency.cjs')
const { stagedVst3Files } = require('./prepare-vst3-msvc.cjs')
const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')
const { collectProductionPackages } = require('./server-package-dependencies.cjs')

const PACKAGE_SPECIFIC_FILTERS = {
  '@neteasecloudmusicapienhanced/api': ['!public/**'],
  'opencc-js': ['!dist/esm/**', '!dist/esm-lib/**', '!types/**']
}

function productionPackageFileSets(root) {
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  // Electron supplies its own built-in module; do not embed its development
  // download (or its downloader dependencies) inside app.asar.
  return collectProductionPackages(root, metadata.dependencies || {}, {
    externalPackages: ['electron']
  }).map((record) => ({
    from: record.source.replaceAll('\\', '/'),
    to: record.destination,
    filter: [
      '**/*',
      '!node_modules/**',
      '!**/{test,tests,__tests__,docs,doc,example,examples,benchmark,benchmarks}/**',
      '!**/*.map',
      '!**/*.ts',
      '!**/*.md',
      ...(PACKAGE_SPECIFIC_FILTERS[record.manifest.name] || [])
    ]
  }))
}

/** Transforms electron-builder.yml with staged native assets, pnpm production packages, and optional core-node. */
function buildStagedElectronBuilderConfig(sourceConfig, root, nativeDir, { bundleNodeCore = false } = {}) {
  const audioConfig = sourceConfig.replace(
    '  - from: resources/audio-engine',
    `  - from: '${nativeDir.replaceAll('\\', '/')}'`
  )
  if (audioConfig === sourceConfig) throw new Error('Audio engine resource entry was not found')
  if (!/^files:\r?$/m.test(audioConfig)) throw new Error('Package files entry was not found')
  const fileSets = productionPackageFileSets(root).flatMap((entry) => [
    `  - from: ${JSON.stringify(entry.from)}`,
    `    to: ${JSON.stringify(entry.to)}`,
    `    filter: ${JSON.stringify(entry.filter)}`
  ])
  let stagedConfig = audioConfig.replace(
    /^files:\r?$/m,
    ['files:', "  - '!node_modules/**'", ...fileSets].join('\n')
  )
  if (bundleNodeCore) {
    if (!/^win:\r?$/m.test(stagedConfig)) throw new Error('Windows package config entry was not found')
    stagedConfig = stagedConfig.replace(
      /^win:\r?$/m,
      [
        'win:',
        '  extraResources:',
        '    - from: out/desktop-core',
        '      to: core-node',
        '      filter:',
        "        - '**/*'",
        "        - '!**/*.map'"
      ].join('\n')
    )
  }
  return stagedConfig
}

function refreshAudioCapabilityArtifacts(nativeDir, runtimeStatus) {
  const manifest = createAudioCapabilityManifest({ artifactDir: nativeDir, runtimeStatus })
  writeFileSync(
    join(nativeDir, 'audio-capabilities.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  writeFileSync(
    join(nativeDir, 'release-capability-status.json'),
    `${JSON.stringify(createReleaseCapabilityStatus({ nativeDir, manifest }), null, 2)}\n`
  )
}

function preparePackagedAudioStaging(
  root,
  {
    nativeOverrides = {},
    bundleNodeCore = false,
    environment = process.env,
    stripNativeFile = defaultStripNativeFile,
    observeRuntime = readStagedAudioRuntimeObservation
  } = {}
) {
  const sourceDir = join(root, 'resources', 'audio-engine')
  const isolatedDir = environment.TAE_AUDIO_ENGINE_STAGE_DIR
    ? resolve(environment.TAE_AUDIO_ENGINE_STAGE_DIR)
    : null
  if (isolatedDir) {
    for (const name of ['twilight-audio-engine.dll', 'twilight_audio_node.node']) {
      if (!existsSync(join(isolatedDir, name))) {
        throw new Error(`Isolated audio staging is missing ${name}: ${isolatedDir}`)
      }
    }
  }
  const vst3 = stagedVst3Files(root)
  if (!vst3.complete) {
    const invalid = [
      ...vst3.missing,
      ...vst3.wrongArchitecture.map((file) => `${file} is not a Windows x64 PE`)
    ]
    throw new Error(
      `Windows packaging requires complete x64 VST3 helpers and VC runtime files; missing or invalid ${invalid.join(', ')}. Run pnpm run prepare:vst3-msvc first.`
    )
  }
  const temporaryDir = mkdtempSync(join(tmpdir(), 'twilight-packaged-audio-'))
  const nativeDir = join(temporaryDir, 'audio-engine')
  mkdirSync(nativeDir)
  // Keep bundled assets and MSVC helpers, then overlay the fresh isolated build
  // and its runtime dependencies without touching files used by the live app.
  for (const directory of new Set([sourceDir, isolatedDir].filter(Boolean))) {
    for (const name of readdirSync(directory)) {
      if (!NATIVE_RUNTIME_FILES.includes(name)) {
        cpSync(join(directory, name), join(nativeDir, name), { recursive: true })
      }
    }
  }
  const identities = []
  for (const name of NATIVE_RUNTIME_FILES) {
    // The desktop resource filter excludes this Server-only addon. Its manifest
    // must describe the desktop payload rather than every build-host module.
    if (name === 'twilight_image_node.node') continue
    const isolatedPath = isolatedDir && join(isolatedDir, name)
    const sourcePath =
      nativeOverrides[name] ||
      (isolatedPath && existsSync(isolatedPath) ? isolatedPath : join(sourceDir, name))
    if (!existsSync(sourcePath)) continue
    const workingPath = join(temporaryDir, `${name}.strip-input`)
    copyFileSync(sourcePath, workingPath)
    let symbols
    // Recover the pre-stage symbols before the second, packaging-only strip.
    if (stripNativeFile === defaultStripNativeFile) {
      const indexFile = join(archiveRoot(), 'index.json')
      const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {}
      symbols = index[artifactId(sourcePath)] || archiveNativeSymbols(sourcePath, { originalName: name })
    }
    stripNativeFile(workingPath)
    copyFileSync(workingPath, join(nativeDir, name))
    if (symbols) identities.push(bindShippedSymbols(join(nativeDir, name), symbols))
    rmSync(workingPath, { force: true })
  }
  writeFileSync(join(nativeDir, 'native-build-identities.json'), JSON.stringify(identities, null, 2))
  const binaryManifest = createAudioCapabilityManifest({ artifactDir: nativeDir })
  const runtimeStatus = observeRuntime({
    artifactDir: nativeDir,
    manifest: binaryManifest
  })
  refreshAudioCapabilityArtifacts(nativeDir, runtimeStatus)

  const sourceConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  const stagedConfig = buildStagedElectronBuilderConfig(sourceConfig, root, nativeDir, {
    bundleNodeCore
  })
  const configPath = join(temporaryDir, 'electron-builder.yml')
  writeFileSync(configPath, stagedConfig)
  return {
    configPath,
    nativeDir,
    dispose: () => {
      try {
        rmSync(temporaryDir, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 })
        return true
      } catch (_error) {
        console.warn(`Unable to remove packaged audio staging directory: ${temporaryDir}`)
        return false
      }
    }
  }
}

module.exports = {
  buildStagedElectronBuilderConfig,
  preparePackagedAudioStaging,
  productionPackageFileSets,
  refreshAudioCapabilityArtifacts
}
