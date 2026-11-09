'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { parseArgs } = require('node:util')
const { pipeline } = require('node:stream/promises')
const { ZipFile } = require('yazl')
const { hashFile } = require('./release-assets.cjs')
const { copyProductionPackages } = require('./server-package-dependencies.cjs')
const { NATIVE_RUNTIME_FILES, stripNativeFile } = require('./release-artifact-strip.cjs')
const {
  assertStrippedPe,
  assertX64Pe,
  listRuntimeDependencies,
  listShippedBinaries
} = require('./verify-release-artifacts.cjs')
const { refreshAudioCapabilityArtifacts } = require('./packaged-audio-staging.cjs')
const { readStagedAudioRuntimeObservation } = require('./staged-audio-runtime-observation.cjs')
const { createAudioCapabilityManifest } = require('./generate-audio-capability-manifest.cjs')
const { resolveMingwEnvironment } = require('./audio-engine-toolchain.cjs')
const {
  validate: validateAutoMixAssets,
  allowed: autoMixAssets
} = require('./stage-automix-native-assets.cjs')

const ENTRIES = [
  'bootstrap',
  'server',
  'runtime',
  'nodeSupervisor',
  'platform',
  'musicCore',
  'audioEngineService',
  'audioAnalysisService',
  'modelPackWorker',
  'libraryDatabaseService',
  'libraryScanService',
  'pluginHost'
]

function packageReadme(applicationVersion, nodeVersion) {
  return [
    'Twilight Echo Server — Windows x64',
    `版本：${applicationVersion}；Node：${nodeVersion}`,
    '',
    '无需全局 Node、npm 或源码仓库。解压到独立版本目录，数据目录放在包外。',
    String.raw`新建：server.cmd init --data D:\ServerData\TwilightEcho --library D:\Music`,
    String.raw`仅桥输出前台运行：service-console.cmd --data D:\ServerData\TwilightEcho`,
    String.raw`状态：server.cmd status --data D:\ServerData\TwilightEcho`,
    String.raw`正常停止：server.cmd stop --data D:\ServerData\TwilightEcho`,
    String.raw`服务注册：pwsh -File manage-service.ps1 -Data D:\ServerData\TwilightEcho（默认只显示计划）`,
    '升级前正常停止实例并保留旧包；新包的 CLI 默认只预览，--apply 才创建候选副本并切换入口。',
    String.raw`升级预览：server.cmd upgrade --from D:\Apps\Server-old --to D:\Apps\Server-new --data D:\ServerData\TwilightEcho --work D:\ServerData\Upgrade-01`,
    String.raw`切换后入口：pwsh -File D:\ServerData\Upgrade-01\service-console.ps1`,
    String.raw`回退预览：server.cmd rollback --work D:\ServerData\Upgrade-01`,
    '回退恢复升级前快照到另一个新目录；新版数据保留，但不合并升级后的更改。工作目录含长期凭据，须保持私有。',
    '完整命令：server.cmd --help；迁移、备份、配对、DSP 和扩展管理沿用同一 CLI。',
    'Windows Service 的 DAC 输出位于其他交互式 Bridge，不直接在 Session 0 打开设备。',
    '不包含 Python 环境、用户 VST3 模块或登录凭据；不自动安装、注册服务或更改权限。',
    ''
  ].join('\r\n')
}

function packageServer({
  root = path.resolve(__dirname, '..'),
  destination,
  node = process.execPath,
  nodeLicense,
  audioRuntime,
  stripEnvironment = resolveMingwEnvironment()
}) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('当前交付目标是 Windows x64；其他平台尚未验收')
  if (!destination || !path.isAbsolute(destination))
    throw new Error('--to 必须是尚不存在的绝对目录')
  const target = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination))
  if (fs.existsSync(target)) throw new Error('交付目标已存在，未覆盖')
  const application = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const probe = spawnSync(
    node,
    ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],
    { encoding: 'utf8', windowsHide: true }
  )
  if (probe.error || probe.status !== 0) throw new Error('指定的 Node 不能运行')
  const runtime = JSON.parse(probe.stdout)
  if (!/^v24\./.test(runtime.version) || runtime.platform !== 'win32' || runtime.arch !== 'x64')
    throw new Error('交付需要 Node 24 Windows x64')
  const license =
    nodeLicense ||
    path.join(root, 'resources/server-runtime', `node-${runtime.version}-LICENSE.txt`)
  if (!fs.readFileSync(license, 'utf8').startsWith('Node.js is licensed for use as follows:'))
    throw new Error('需要该 Node 发行版的完整 LICENSE')
  const staged = `${target}.partial-${randomUUID()}`
  fs.mkdirSync(staged)
  try {
    const copy = (relative) => {
      const output = path.join(staged, relative)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.cpSync(path.join(root, relative), output, {
        recursive: true,
        errorOnExist: true,
        force: false
      })
    }
    for (const entry of ENTRIES) copy(`out/server/${entry}.cjs`)
    copy('out/server-service/twilight-server-service.exe')
    copy('out/server-service/twilight_server_credentials.node')
    const sourceNative = audioRuntime ? fs.realpathSync(audioRuntime) : path.join(root, 'resources/audio-engine')
    const native = path.join(staged, 'resources/audio-engine')
    fs.mkdirSync(native, { recursive: true })
    for (const name of [
      'twilight-audio-engine.dll',
      'twilight_audio_node.node',
      'twilight_image_node.node',
      'twilight-vst3-host.exe',
      'twilight-vst3-scanner.exe'
    ]) {
      if (!fs.existsSync(path.join(sourceNative, name)))
        throw new Error(`交付缺少原生运行时：${name}`)
    }
    const products = NATIVE_RUNTIME_FILES.map((name) => path.join(sourceNative, name)).filter(
      (file) => fs.existsSync(file)
    )
    const nativeFiles = new Set([
      ...products,
      ...listRuntimeDependencies(sourceNative, products),
      ...['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].map((name) =>
        path.join(sourceNative, name)
      )
    ])
    for (const file of nativeFiles) fs.copyFileSync(file, path.join(native, path.basename(file)))
    copy('resources/audio-engine/licenses')
    validateAutoMixAssets(path.join(sourceNative, 'automix-native'))
    fs.mkdirSync(path.join(native, 'automix-native'))
    for (const name of autoMixAssets)
      fs.copyFileSync(
        path.join(sourceNative, 'automix-native', name),
        path.join(native, 'automix-native', name)
      )
    for (const relative of ['resources/remote', 'resources/plugins', 'resources/plugin-index'])
      copy(relative)
    const stems = path.join(staged, 'resources/automix-stems')
    fs.mkdirSync(stems)
    for (const name of [
      'worker.py',
      'arrangement.py',
      'probe.py',
      '7za.exe',
      '7zip-LICENSE.txt',
      '7zip-NOTICE.txt'
    ])
      fs.copyFileSync(path.join(root, 'resources/automix-stems', name), path.join(stems, name))
    fs.mkdirSync(path.join(staged, 'runtime'))
    fs.copyFileSync(node, path.join(staged, 'runtime/node.exe'))
    fs.copyFileSync(license, path.join(staged, 'runtime/LICENSE.txt'))
    for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) copy(name)
    copy('scripts/manage-server-service.ps1')
    copy('scripts/server-service-upgrade.ps1')
    const dependencies = { ...application.dependencies }
    delete dependencies['@electron-toolkit/utils'] // GUI-only peer requires Electron; no Server caller imports it.
    const manifest = {
      name: `${application.name}-server`,
      version: application.version,
      private: true,
      license: application.license,
      engines: { node: '24.x' },
      dependencies
    }
    fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const packages = copyProductionPackages(root, staged, dependencies)
    for (const name of NATIVE_RUNTIME_FILES) {
      const file = path.join(native, name)
      if (!fs.existsSync(file)) continue
      stripNativeFile(file, { environment: stripEnvironment })
      assertStrippedPe(file)
    }
    const host = path.join(staged, 'out/server-service/twilight-server-service.exe')
    stripNativeFile(host, { environment: stripEnvironment })
    assertStrippedPe(host)
    assertX64Pe(host)
    const credentials = path.join(staged, 'out/server-service/twilight_server_credentials.node')
    stripNativeFile(credentials, { environment: stripEnvironment })
    assertStrippedPe(credentials)
    assertX64Pe(credentials)
    assertX64Pe(path.join(staged, 'runtime/node.exe'))
    listRuntimeDependencies(native, listShippedBinaries(native))
    listRuntimeDependencies(path.dirname(host), [host])
    const binaryManifest = createAudioCapabilityManifest({ artifactDir: native })
    const observed = readStagedAudioRuntimeObservation({
      artifactDir: native,
      manifest: binaryManifest,
      runProbe: (_command, args, options) =>
        spawnSync(path.join(staged, 'runtime/node.exe'), args, options)
    })
    if (!observed) throw new Error('交付包原生音频能力读取失败')
    refreshAudioCapabilityArtifacts(native, observed)
    fs.writeFileSync(
      path.join(staged, 'server.cmd'),
      '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0out\\server\\server.cjs" %*\r\nexit /b %errorlevel%\r\n'
    )
    fs.writeFileSync(
      path.join(staged, 'service-console.cmd'),
      '@echo off\r\n"%~dp0out\\server-service\\twilight-server-service.exe" --console --node "%~dp0runtime\\node.exe" --entry "%~dp0out\\server\\server.cjs" %*\r\nexit /b %errorlevel%\r\n'
    )
    fs.writeFileSync(
      path.join(staged, 'manage-service.ps1'),
      '#requires -Version 7.0\n& (Join-Path $PSScriptRoot "scripts/manage-server-service.ps1") -Node (Join-Path $PSScriptRoot "runtime/node.exe") -Application $PSScriptRoot @args\nexit $LASTEXITCODE\n'
    )
    fs.writeFileSync(
      path.join(staged, 'README.txt'),
      packageReadme(application.version, runtime.version)
    )
    const result = {
      format: 'twilight-server-package',
      version: 1,
      applicationVersion: application.version,
      platform: runtime.platform,
      arch: runtime.arch,
      nodeVersion: runtime.version,
      createdAt: new Date().toISOString(),
      service: 'out/server-service/twilight-server-service.exe',
      entry: 'out/server/server.cjs',
      packages
    }
    fs.writeFileSync(
      path.join(staged, 'server-package.json'),
      JSON.stringify(result, null, 2) + '\n'
    )
    packageFiles(staged) // A portable directory must not retain source-tree links either.
    fs.renameSync(staged, target)
    return { ...result, destination: target }
  } catch (error) {
    if (path.dirname(path.resolve(staged)) !== path.dirname(target)) throw error
    fs.rmSync(staged, { recursive: true, force: true })
    throw error
  }
}

function packageFiles(root, prefix = '') {
  const result = []
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`交付包不能引用目录外的链接：${relative}`)
    if (entry.isDirectory()) result.push(...packageFiles(root, relative))
    else if (entry.isFile()) result.push(relative)
  }
  return result.sort()
}

/** The ZIP is the transfer artifact. Its checksum follows the existing release
 * asset contract; package files are not individually re-hashed. */
async function archiveServerPackage(source, destination) {
  if (!path.isAbsolute(destination)) throw new Error('ZIP 目标必须是绝对路径')
  const target = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination))
  if (fs.existsSync(target) || fs.existsSync(`${target}.sha256`))
    throw new Error('ZIP 或校验文件已存在，未覆盖')
  const files = packageFiles(source),
    staged = `${target}.partial-${randomUUID()}`
  const zip = new ZipFile()
  zip.on('error', (error) => zip.outputStream.destroy(error))
  const writing = pipeline(zip.outputStream, fs.createWriteStream(staged, { flags: 'wx' }))
  try {
    for (const relative of files)
      zip.addFile(path.join(source, relative), `${path.basename(source)}/${relative}`)
    zip.end()
    await writing
    fs.renameSync(staged, target)
    const digest = await hashFile(target)
    fs.writeFileSync(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`, { flag: 'wx' })
    return {
      archive: target,
      checksum: `${target}.sha256`,
      files: files.length,
      bytes: fs.statSync(target).size
    }
  } catch (error) {
    zip.outputStream.destroy()
    await writing.catch(() => {})
    if (path.dirname(path.resolve(staged)) !== path.dirname(target)) throw error
    fs.rmSync(staged, { force: true })
    throw error
  }
}
if (require.main === module) {
  const { values } = parseArgs({
    options: {
      to: { type: 'string' },
      node: { type: 'string' },
      'node-license': { type: 'string' },
      'audio-runtime': { type: 'string' },
      zip: { type: 'string' }
    }
  })
  ;(async () => {
    const result = packageServer({
      destination: values.to,
      node: values.node,
      nodeLicense: values['node-license'],
      audioRuntime: values['audio-runtime']
    })
    const archive = values.zip
      ? await archiveServerPackage(result.destination, values.zip)
      : undefined
    console.log(JSON.stringify({ ...result, ...archive }, null, 2))
  })().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
module.exports = { packageServer, archiveServerPackage, packageFiles, packageReadme, ENTRIES }
