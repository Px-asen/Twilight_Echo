const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { assertWindowsExecutableIcon } = require('./verify-windows-app-branding.cjs')
const { prepareStemZipDecoder } = require('./prepare-automix-stem-zip-decoder.cjs')
const { verifyPackagedDesktopCore } = require('./desktop-core-packaging.cjs')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  for (const name of ['twilight-crash-helper.exe', 'twilight-crash-helper-x86.exe'])
    if (!existsSync(join(context.appOutDir, 'resources', 'audio-engine', name))) throw new Error(`Missing diagnostic helper: ${name}`)
  if (
    existsSync(join(context.appOutDir, 'resources', 'core-node')) ||
    process.env.TWILIGHT_BUNDLE_NODE_CORE === '1'
  ) {
    verifyPackagedDesktopCore(join(context.appOutDir, 'resources'), context.packager.appInfo.version)
  }

  await prepareStemZipDecoder({
    root: context.packager.projectDir,
    destination: join(context.appOutDir, 'resources', 'automix-stems')
  })

  if (
    (process.env.TWILIGHT_RELEASE_BUILD === '1' || process.env.TWILIGHT_PACKAGE_STRIP === '1') &&
    process.env.TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED !== '1'
  ) {
    throw new Error('Packaged audio staging was not prepared before electron-builder started')
  }

  const appInfo = context.packager.appInfo
  const productName = appInfo.productName || 'TwilightEcho'
  const version = appInfo.version || '1.0.0'
  const exeName = `${context.packager.platformSpecificBuildOptions.executableName || productName}.exe`
  const exePath = join(context.appOutDir, exeName)
  const iconPath = join(context.packager.projectDir, 'build', 'icon.ico')
  const rceditPath = join(
    context.packager.projectDir,
    'node_modules',
    'electron-winstaller',
    'vendor',
    'rcedit.exe'
  )

  for (const [label, path] of [
    ['Windows executable', exePath],
    ['Windows icon', iconPath],
    ['rcedit', rceditPath]
  ]) {
    if (!existsSync(path)) throw new Error(`${label} not found: ${path}`)
  }

  const result = spawnSync(
    rceditPath,
    [
      exePath,
      '--set-icon',
      iconPath,
      '--set-file-version',
      version,
      '--set-product-version',
      version,
      '--set-version-string',
      'FileDescription',
      productName,
      '--set-version-string',
      'ProductName',
      productName,
      '--set-version-string',
      'OriginalFilename',
      exeName,
      '--set-version-string',
      'InternalName',
      productName,
      '--set-version-string',
      'CompanyName',
      appInfo.companyName || appInfo.author || productName
    ],
    { encoding: 'utf8' }
  )

  if (result.status !== 0) {
    throw new Error(
      [
        `Failed to write Windows executable metadata with rcedit (exit ${result.status})`,
        result.stdout,
        result.stderr
      ]
        .filter(Boolean)
        .join('\n')
    )
  }
  assertWindowsExecutableIcon(exePath, iconPath)
}
