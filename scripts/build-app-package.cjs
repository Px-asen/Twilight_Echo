const { archiveJavaScriptSymbols } = require('./diagnostic-symbols.cjs')
const { buildCrashHelpers } = require('./build-crash-helper.cjs')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { verifyPackagedDependencyClosure } = require('./verify-packaged-dependency-closure.cjs')
const { verifyPackagedRuntimeSmoke } = require('./verify-packaged-runtime-smoke.cjs')
const { verifyWindowsAppBranding } = require('./verify-windows-app-branding.cjs')
const {
  preparePackagedAppStaging,
  preparePackagedAudioStaging
} = require('./packaged-audio-staging.cjs')
const { prepareVst3Msvc } = require('./prepare-vst3-msvc.cjs')
const { prepareSmtcMsvc } = require('./prepare-smtc-msvc.cjs')
const { buildAsioHelper } = require('./build-asio-helper.cjs')
const { verifyAsioHelperPair } = require('./verify-asio-helper-artifacts.cjs')
const { prepareWindowsDesktopCore } = require('./desktop-core-packaging.cjs')

const root = path.resolve(__dirname, '..')
const electronBuilder = require.resolve('electron-builder/out/cli/cli.js')

function targetsWindows(args) {
  if (args.includes('--linux') || args.includes('--mac')) return false
  return args.includes('--win') || (process.platform === 'win32' && args.includes('--dir'))
}

function stripDefaultBuilderConfigArgs(args) {
  const sanitized = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--config' || arg === '-c') {
      const next = args[++index]
      if (next && path.resolve(root, next) === path.join(root, 'electron-builder.yml')) continue
      throw new Error(
        `Custom electron-builder config (${next || ''}) conflicts with staged dependency configuration.`
      )
    }
    if (arg.startsWith('--config=') || arg.startsWith('-c=')) {
      const value = arg.slice(arg.indexOf('=') + 1)
      if (value && path.resolve(root, value) === path.join(root, 'electron-builder.yml')) continue
      throw new Error(
        `Custom electron-builder config (${value}) conflicts with staged dependency configuration.`
      )
    }
    sanitized.push(arg)
  }
  return sanitized
}

function packageOutputDirectory(args, projectRoot = root) {
  const flag = '--config.directories.output'
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`))
  const directory =
    index < 0 ? 'dist' : args[index] === flag ? args[index + 1] : args[index].slice(flag.length + 1)
  return path.resolve(projectRoot, directory)
}

function packagedRuntimeTargets(outputDir, args) {
  if (!fs.existsSync(outputDir)) return []
  if (targetsWindows(args)) {
    const winUnpacked = path.join(outputDir, 'win-unpacked')
    return fs.existsSync(path.join(winUnpacked, 'resources', 'app.asar')) ? [winUnpacked] : []
  }
  if (args.includes('--mac') || (process.platform === 'darwin' && args.includes('--dir'))) {
    const bundles = []
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('mac')) continue
      const archDir = path.join(outputDir, entry.name)
      for (const child of fs.readdirSync(archDir, { withFileTypes: true })) {
        if (!child.isDirectory() || !child.name.endsWith('.app')) continue
        const appBundle = path.join(archDir, child.name)
        if (fs.existsSync(path.join(appBundle, 'Contents', 'Resources', 'app.asar'))) {
          bundles.push(appBundle)
        }
      }
    }
    return bundles.sort()
  }
  const linuxDirs = []
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('linux-')) continue
    const candidate = path.join(outputDir, entry.name)
    if (fs.existsSync(path.join(candidate, 'resources', 'app.asar'))) {
      linuxDirs.push(candidate)
    }
  }
  return linuxDirs.sort()
}

function run(args, environment = process.env) {
  return spawnSync(process.execPath, [electronBuilder, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...environment, TWILIGHT_PACKAGE_STRIP: '1' }
  })
}

async function main(args = process.argv.slice(2)) {
  const builderArgs = stripDefaultBuilderConfigArgs(args)
  const windowsPackage = targetsWindows(builderArgs)
  if (windowsPackage && process.platform !== 'win32') {
    throw new Error('Windows packaging with native VST3/SMTC helpers must run on Windows x64.')
  }
  let smtc = null
  let asio = null
  if (windowsPackage) {
    buildCrashHelpers({ root })
    await prepareWindowsDesktopCore({ root, args: builderArgs })
    asio = buildAsioHelper({ root, tests: false })
    smtc = prepareSmtcMsvc({ root, stage: false })
    prepareVst3Msvc({ root, force: true })
  }
  const staging = windowsPackage
    ? preparePackagedAudioStaging(root, {
        nativeOverrides: {
          'twilight_smtc_node.node': smtc.artifactPath,
          'twilight-asio-helper-x86.exe': asio.artifactPath
        }
      })
    : preparePackagedAppStaging(root)
  archiveJavaScriptSymbols(path.join(root, 'out'))
  let result
  try {
    if (staging.nativeDir) verifyAsioHelperPair(staging.nativeDir)
    result = run([...builderArgs, '--config', staging.configPath], {
      ...process.env,
      TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED: staging.nativeDir ? '1' : '0'
    })
  } finally {
    staging.dispose()
  }
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

  const outputDir = packageOutputDirectory(builderArgs)
  if (windowsPackage && process.platform === 'win32') {
    const branding = verifyWindowsAppBranding(path.join(outputDir, 'win-unpacked'))
    console.log(`Windows executable branding verified: ${branding.productName}`)
  }

  const runtimeTargets = packagedRuntimeTargets(outputDir, builderArgs)
  if (runtimeTargets.length === 0) {
    throw new Error(`No packaged app.asar target found under ${outputDir} after packaging.`)
  }
  for (const target of runtimeTargets) {
    const verified = verifyPackagedDependencyClosure(target, {
      projectRoot: root,
      externalPackages: ['electron']
    })
    console.log(
      `Packaged dependency closure verified (${path.basename(target)}): ${verified.packages} packages`
    )
    const smoke = verifyPackagedRuntimeSmoke(target)
    console.log(
      `Packaged runtime smoke verified (${path.basename(target)}, ${smoke.mode}): ${smoke.scannedTracks} scanned track, ${smoke.ncmRoutesChecked} NCM routes`
    )
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })

module.exports = {
  electronBuilder,
  main,
  packageOutputDirectory,
  packagedRuntimeTargets,
  run,
  stripDefaultBuilderConfigArgs,
  targetsWindows
}
