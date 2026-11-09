'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { parseArgs } = require('node:util')
const { copyProductionPackages } = require('./server-package-dependencies.cjs')
const { validate: validateAutoMixAssets, allowed: autoMixAssets } = require('./stage-automix-native-assets.cjs')
const binaries = ['libtwilight-audio-engine.so', 'libtwilight-soxr.so', 'twilight_audio_node.node', 'twilight_image_node.node']
const workers = ['worker.py', 'arrangement.py', 'probe.py']

function inspectLinuxNativeRuntime(native) {
  for (const name of binaries) {
    const header = fs.readFileSync(path.join(native, name)).subarray(0, 20)
    if (header.length < 20 || header.toString('hex', 0, 4) !== '7f454c46' || header[4] !== 2 ||
        header[5] !== 1 || header.readUInt16LE(18) !== 62)
      throw Error(`原生模块不是 x86_64 ELF：${name}`)
  }
  return binaries
}

function inspectLinuxAutoMixInputs(root) {
  const assets = path.join(root, 'resources/audio-engine/automix-native')
  validateAutoMixAssets(assets)
  for (const name of workers) {
    if (!fs.statSync(path.join(root, 'resources/automix-stems', name)).isFile())
      throw Error(`缺少 AutoMix worker：${name}`)
  }
  return { assets, workers }
}

function stageLinuxServer({ root = path.resolve(__dirname, '..'), destination, native }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Linux Server 交付需要 Linux x86_64 构建环境')
  if (!destination || !native || !path.isAbsolute(destination) || !path.isAbsolute(native)) throw Error('--to 与 --native 必须为绝对路径')
  if (fs.existsSync(destination)) throw Error('交付目录已存在，请指定新目录')
  inspectLinuxNativeRuntime(native)
  const autoMix = inspectLinuxAutoMixInputs(root)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  fs.mkdirSync(destination, { recursive: true })
  const copy = (relative) => fs.cpSync(path.join(root, relative), path.join(destination, relative), { recursive: true })
  for (const relative of ['out/server', 'resources/plugins/ncm-provider', 'resources/remote', 'LICENSE']) copy(relative)
  const runtime = path.join(destination, 'resources/audio-engine')
  fs.mkdirSync(runtime, { recursive: true })
  for (const name of binaries) fs.copyFileSync(path.join(native, name), path.join(runtime, name))
  const graphs = path.join(runtime, 'automix-native')
  fs.mkdirSync(graphs)
  for (const name of autoMixAssets) fs.copyFileSync(path.join(autoMix.assets, name), path.join(graphs, name))
  const stems = path.join(destination, 'resources/automix-stems')
  fs.mkdirSync(stems)
  for (const name of autoMix.workers) fs.copyFileSync(path.join(root, 'resources/automix-stems', name), path.join(stems, name))
  const licenses = path.join(destination, 'licenses')
  fs.mkdirSync(licenses)
  fs.copyFileSync(path.join(root, 'audio-engine/third_party/soxr/upstream/COPYING.LGPL'), path.join(licenses, 'soxr-LGPL.txt'))
  const packages = copyProductionPackages(root, destination, manifest.dependencies)
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: manifest.type }))
  fs.writeFileSync(path.join(destination, 'server-package.json'), JSON.stringify({ applicationVersion: manifest.version,
    platform: 'linux', arch: 'x64', nodeVersion: process.version, entry: 'out/server/server.cjs', packages }, null, 2))
  // Resolve all native dependencies from the staged directory while still in the build image.
  require(path.join(runtime, 'twilight_audio_node.node'))
  require(path.join(runtime, 'twilight_image_node.node'))
  return { destination, packages: packages.length }
}
if (require.main === module) {
  const { values } = parseArgs({ options: { to: { type: 'string' }, native: { type: 'string' } } })
  console.log(stageLinuxServer({ destination: values.to, native: values.native }))
}
module.exports = { stageLinuxServer, inspectLinuxNativeRuntime, inspectLinuxAutoMixInputs }
