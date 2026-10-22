const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createMinimalPe } = require('./pe-fixture.cjs')
const { NATIVE_RUNTIME_FILES } = require('./release-artifact-strip.cjs')
const { preparePackagedAudioStaging } = require('./packaged-audio-staging.cjs')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('packaging overlays an isolated fresh engine and dependencies while preserving live files and bundled assets', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-isolated-package-'))
  const liveDir = path.join(directory, 'resources', 'audio-engine')
  const isolatedDir = path.join(directory, 'fresh')
  fs.mkdirSync(liveDir, { recursive: true })
  fs.mkdirSync(isolatedDir)
  fs.writeFileSync(
    path.join(directory, 'electron-builder.yml'),
    'extraResources:\n  - from: resources/audio-engine\n'
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
      JSON.stringify(manifest).includes(createHash('sha256').update(freshCore).digest('hex'))
    )
  } finally {
    staging?.dispose()
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

test('Windows packaging strips copied native binaries while unsigned releases stay fail-closed', () => {
  const afterPack = read('scripts/after-pack-windows.cjs')
  const packageBuild = read('scripts/build-app-package.cjs')
  const releaseBuild = read('scripts/build-windows-release.cjs')
  const audioStaging = read('scripts/packaged-audio-staging.cjs')
  const lifecycle = read('src/main/app/lifecycle.ts')
  assert.match(afterPack, /process\.env\.TWILIGHT_RELEASE_BUILD === '1'/)
  assert.match(afterPack, /process\.env\.TWILIGHT_PACKAGE_STRIP === '1'/)
  assert.match(afterPack, /--set-icon/)
  assert.match(afterPack, /FileDescription/)
  assert.match(afterPack, /ProductName/)
  assert.match(afterPack, /TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED/)
  assert.match(audioStaging, /NATIVE_RUNTIME_FILES\.includes\(name\)/)
  assert.match(audioStaging, /stripNativeFile\(workingPath\)/)
  assert.match(audioStaging, /createAudioCapabilityManifest/)
  assert.match(audioStaging, /createReleaseCapabilityStatus/)
  assert.match(audioStaging, /readStagedAudioRuntimeObservation/)
  assert.match(audioStaging, /stagedVst3Files/)
  assert.match(packageBuild, /TWILIGHT_PACKAGE_STRIP: '1'/)
  assert.match(packageBuild, /prepareSmtcMsvc/)
  assert.match(packageBuild, /prepareVst3Msvc/)
  assert.match(packageBuild, /preparePackagedAudioStaging/)
  assert.match(packageBuild, /targetsWindows/)
  assert.match(packageBuild, /verifyWindowsAppBranding/)
  assert.match(releaseBuild, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/)
  assert.match(releaseBuild, /TWILIGHT_RELEASE_BUILD: '1'/)
  assert.match(releaseBuild, /TWILIGHT_PACKAGED_AUDIO_PRESTRIPPED: '1'/)
  assert.match(releaseBuild, /prepareSmtcMsvc/)
  assert.match(releaseBuild, /prepareVst3Msvc/)
  assert.match(releaseBuild, /preparePackagedAudioStaging/)
  assert.doesNotMatch(releaseBuild, /--require-signature/)
  assert.match(releaseBuild, /verifyWindowsAppBranding/)
  assert.match(releaseBuild, /verifyPackagedDependencyClosure/)
  assert.match(releaseBuild, /findInstaller/)
  assert.match(releaseBuild, /createHash\('sha256'\)/)
  assert.match(releaseBuild, /\.sha256/)
  assert.ok(lifecycle.indexOf("app.setName('TwilightEcho')") < lifecycle.indexOf('app.whenReady()'))
  assert.ok(
    lifecycle.indexOf('electronApp.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)') <
      lifecycle.indexOf('app.whenReady()')
  )
})

test('Linux packaging fails closed when native engine artifacts are missing', () => {
  const afterPack = read('scripts/after-pack-linux.cjs')
  assert.match(
    afterPack,
    /const runtimeFiles = \['libtwilight-audio-engine\.so', 'twilight_audio_node\.node'\]/
  )
  assert.match(
    afterPack,
    /if \(!existsSync\(source\)\) \{\s*throw new Error\(`\[after-pack-linux\] Missing required native artifact:/
  )
})

test('Linux release builds keep the validated Ubuntu LTS image', () => {
  const workflow = read('.github/workflows/build-linux.yml')
  assert.match(workflow, /runs-on: ubuntu-24\.04/)
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/)
})

test('manual release rebuilds use the requested tag in both build and publish checkouts', () => {
  const releaseRef =
    "${{ inputs.release_tag && format('refs/tags/{0}', inputs.release_tag) || github.ref }}"
  for (const file of ['build-linux.yml', 'build-macos.yml']) {
    const workflow = read(`.github/workflows/${file}`)
    const checkouts = [...workflow.matchAll(/^ {8}uses: actions\/checkout@[^\r\n]+/gm)]
    assert.equal(checkouts.length, 2, `${file} must check out source for both jobs`)
    for (const checkout of checkouts) {
      const settings = workflow.slice(checkout.index + checkout[0].length)
      const ref = settings.match(/^\r?\n {8}with:\r?\n {10}ref: ([^\r\n]+)/)?.[1]
      assert.equal(ref, releaseRef, `${file} must build and publish the requested release tag`)
    }
  }
})

test('package publication keeps build success and scoped write permission gates', () => {
  for (const platform of ['linux', 'macos']) {
    const workflow = read(`.github/workflows/build-${platform}.yml`)
    const publishIndex = workflow.search(/^ {2}publish:\r?$/m)
    assert.notEqual(publishIndex, -1, `${platform} must publish through a separate job`)
    const publish = workflow.slice(publishIndex)
    const build = workflow.slice(0, publishIndex)
    assert.match(workflow, /^permissions:\r?\n {2}contents: read\r?\n/m)
    assert.doesNotMatch(build, /contents: write/)
    assert.match(publish, /^ {4}permissions:\r?\n {6}contents: write\r?\n/m)
    assert.match(publish, new RegExp(`^ {4}needs: ${platform}\\r?\\n`, 'm'))
    assert.match(
      publish,
      new RegExp(
        `^ {4}if: needs\\.${platform}\\.result == 'success' && \\(github\\.event_name == 'push' \\|\\| inputs\\.release_tag\\)\\r?$`,
        'm'
      )
    )
    assert.match(build, /--publish never/)
    assert.match(build, /if-no-files-found: error/)
    assert.match(publish, /test "v\$\{version\}" = "\$RELEASE_TAG"/)
    assert.ok(
      publish.indexOf('Verify the release tag matches the packaged version') <
        publish.indexOf('bash scripts/publish-release-assets.sh')
    )
  }
})

test('release packaging writes an SHA-256 companion file for the installer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-release-checksum-'))
  try {
    const installer = path.join(root, 'TwilightEcho-1.0.2-setup.exe')
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
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windows packages use maximum compression', () => {
  const builder = read('electron-builder.yml')
  assert.match(builder, /^compression:\s*maximum\s*$/m)
  assert.match(builder, /^electronLanguages:\s*\n\s+- zh-CN\s*\n\s+- zh-TW\s*\n\s+- en-US\s*$/m)
  assert.doesNotMatch(builder, /^\s+- node_modules\/\*\*\s*$/m)
  assert.match(builder, /^\s+include:\s*scripts\/installer\.nsh\s*$/m)
  assert.doesNotMatch(
    read('scripts/installer.nsh'),
    /SetCompressor|SetCompress|RequestExecutionLevel/
  )
})

test('update checks download GitHub release installers without electron-updater', () => {
  const projectUrls = read('src/shared/projectUrls.ts')
  const updater = read('src/main/ipc/appIpc.ts')
  const service = read('src/main/app/appUpdateService.ts')
  const updateEngine = [
    service,
    read('src/main/app/appUpdateRelease.ts'),
    read('src/main/app/appUpdateDownload.ts')
  ].join('\n')
  assert.match(projectUrls, /export const GITHUB_OWNER = 'Px-asen'/)
  assert.match(projectUrls, /export const GITHUB_REPO = 'Twilight_Echo'/)
  assert.match(
    projectUrls,
    /GITHUB_API_LATEST_RELEASE_URL = `https:\/\/api\.github\.com\/repos\/\$\{GITHUB_OWNER\}\/\$\{GITHUB_REPO\}\/releases\/latest`/
  )
  assert.match(projectUrls, /GITHUB_API_RELEASES_URL/)
  assert.match(projectUrls, /RELEASES_URL = `\$\{GITHUB_URL\}\/releases`/)
  assert.match(updater, /checkForAppUpdate/)
  assert.match(updater, /downloadAppUpdate/)
  assert.match(updater, /installDownloadedAppUpdate/)
  assert.doesNotMatch(updater, /autoUpdater/)
  assert.doesNotMatch(service, /electron-updater/)
  assert.doesNotMatch(service, /autoUpdater/)
  assert.match(service, /shell\.openPath/)
  assert.match(updateEngine, /createHash\('sha256'\)/)
  assert.match(updateEngine, /error: 'no-checksum'/)
  assert.match(updateEngine, /pickLatestAvailableRelease/)
  assert.match(updateEngine, /extractAssetDigestSha256/)
  assert.match(updateEngine, /GitHub Release 未提供 Windows 安装包的 SHA-256 校验和/)
  const settingsTypes = read('src/renderer/src/components/settings-page/types.ts')
  const about = read('src/renderer/src/components/settings-page/AppUpdatePanel.vue')
  assert.match(settingsTypes, /from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/projectUrls\.ts'/)
  assert.match(settingsTypes, /RELEASES_URL/)
  assert.match(about, /下载更新/)
  assert.match(about, /安装并退出/)
  assert.match(about, /检查更新/)
})

test('release docs keep non-Windows audio backends explicitly unverified', () => {
  const readme = read('README.md')
  assert.match(readme, /macOS 与 Linux 后端已有实现，但尚未达到正式发布验证标准/)
  assert.match(
    readme,
    /CoreAudio 与 ALSA 后端已存在，但目前没有经过与 Windows 同等级别的发布和真实设备验证/
  )
  assert.doesNotMatch(readme, /macOS 与 Linux 的原生音频引擎仍在验证阶段（代码已 release-ready/)
})
