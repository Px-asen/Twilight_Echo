const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { verifyPackagedDependencyClosure } = require('./verify-packaged-dependency-closure.cjs')
const { verifyWindowsAppBranding } = require('./verify-windows-app-branding.cjs')
const { preparePackagedAudioStaging } = require('./packaged-audio-staging.cjs')
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

function packageOutputDirectory(args, projectRoot = root) {
  const flag = '--config.directories.output'
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`))
  const directory =
    index < 0 ? 'dist' : args[index] === flag ? args[index + 1] : args[index].slice(flag.length + 1)
  return path.resolve(projectRoot, directory)
}

function run(args, environment = process.env) {
  return spawnSync(process.execPath, [electronBuilder, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...environment, TWILIGHT_PACKAGE_STRIP: '1' }
  })
}

async function main(args = process.argv.slice(2)) {
  const windowsPackage = targetsWindows(args)
  if (windowsPackage && process.platform !== 'win32') {
    throw new Error('Windows packaging with native VST3/SMTC helpers must run on Windows x64.')
  }
  let smtc = null
  let asio = null
  if (windowsPackage) {
    await prepareWindowsDesktopCore({ root, args })
    asio = buildAsioHelper({ root, tests: false })
    smtc = prepareSmtcMsvc({ root, stage: false })
    prepareVst3Msvc({ root })
  }
  const staging = windowsPackage
    ? preparePackagedAudioStaging(root, {
        nativeOverrides: {
          'twilight_smtc_node.node': smtc.artifactPath,
          'twilight-asio-helper-x86.exe': asio.artifactPath
        }
      })
    : null
  let result
  try {
    if (staging) verifyAsioHelperPair(staging.nativeDir)
    result = run(staging ? [...args, '--config', staging.configPath] : args, {
      ...process.env,
      TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED: staging ? '1' : '0'
    })
  } finally {
    staging?.dispose()
  }
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
  const unpackedApp = path.join(packageOutputDirectory(args), 'win-unpacked')
  const packagedAsar = path.join(unpackedApp, 'resources', 'app.asar')
  if (process.platform === 'win32') {
    const branding = verifyWindowsAppBranding(unpackedApp)
    console.log(`Windows executable branding verified: ${branding.productName}`)
  }
  if (process.platform === 'win32' && fs.existsSync(packagedAsar)) {
    const verified = verifyPackagedDependencyClosure(packagedAsar, {
      projectRoot: root,
      externalPackages: ['electron']
    })
    console.log(`Packaged dependency closure verified: ${verified.packages} packages`)
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })

module.exports = { electronBuilder, main, packageOutputDirectory, run }
