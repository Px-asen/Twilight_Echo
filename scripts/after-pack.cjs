// Unified after-pack dispatcher.
//
// electron-builder's `afterPack` accepts a single script path (not an array),
// so this dispatcher routes to the platform-specific hooks below. Each hook
// is responsible for its own platform guard.
const { join } = require('node:path')
const { existsSync } = require('node:fs')
const { validate: validateAutoMixAssets } = require('./stage-automix-native-assets.cjs')
const { verifyPackagedDependencyClosure } = require('./verify-packaged-dependency-closure.cjs')

exports.default = async function afterPack(context) {
  const { electronPlatformName } = context
  const resourcesDir =
    electronPlatformName === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : join(context.appOutDir, 'resources')
  const packagedAsar = join(resourcesDir, 'app.asar')
  if (existsSync(packagedAsar)) {
    const verified = verifyPackagedDependencyClosure(packagedAsar, {
      projectRoot: context.packager?.projectDir,
      externalPackages: ['electron']
    })
    console.log(
      `[after-pack] Packaged dependency closure verified (${electronPlatformName}): ${verified.packages} packages`
    )
  }
  const autoMixAssets = join(resourcesDir, 'audio-engine', 'automix-native')
  if (existsSync(autoMixAssets)) validateAutoMixAssets(autoMixAssets)
  if (electronPlatformName === 'win32') {
    return require(join(__dirname, 'after-pack-windows.cjs')).default(context)
  }
  if (electronPlatformName === 'linux') {
    return require(join(__dirname, 'after-pack-linux.cjs')).default(context)
  }
  // mac / darwin: no custom after-pack steps yet.
}
