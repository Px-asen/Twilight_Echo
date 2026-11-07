const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  bundleMacOSRuntimeDependencies,
  isSystemDependency,
  parseOtoolDependencies,
  parseOtoolRpaths,
  validateBundledMacOSRuntime
} = require('./macos-audio-runtime.cjs')

test('staged rpath copies retain their source identity and distinct same-name libraries still fail', () => {
  const root = path.resolve('/tmp/macos-bundle-origin'), output = path.join(root, 'runtime')
  const engine = path.join(output, 'engine.dylib'), addon = path.join(output, 'audio.node')
  const source = path.join(root, 'build', 'resampler.dylib'), staged = path.join(output, 'resampler.dylib')
  const other = path.join(root, 'other', 'resampler.dylib')
  const run = (conflict) => {
    const files = new Set([engine, addon, source, other]), loads = new Map([
      [engine, [source]], [addon, [conflict ? other : '@rpath/resampler.dylib']], [staged, []]
    ])
    const search = new Map([[engine, []], [addon, [output]], [staged, []]])
    const copies = []
    const result = bundleMacOSRuntimeDependencies([engine, addon], output, {
      exists: file => files.has(file), realpath: file => file,
      inspectDependencies: file => loads.get(file), inspectRpaths: file => search.get(file),
      copy: (from, to) => { copies.push([from, to]); files.add(to) },
      run: (command, args) => {
        if (command !== 'install_name_tool') return
        const target = args.at(-1)
        if (args[0] === '-change') loads.set(target, loads.get(target).map(load => load === args[1] ? args[2] : load))
        if (args[0] === '-delete_rpath') search.set(target, search.get(target).filter(value => value !== args[1]))
      }
    })
    assert.deepEqual(copies, [[source, staged]])
    assert.equal(result.copiedDependencies, 1)
    assert.equal(result.verification.binaries, 3)
  }
  run(false)
  assert.throws(() => run(true), /basename collision/)
})

test('parses otool dependency and rpath output without treating the Mach-O identity as a load', () => {
  assert.deepEqual(
    parseOtoolDependencies(
      `sample.dylib:\n\t@rpath/sample.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib (compatibility version 63.0.0, current version 63.1.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`
    ),
    ['/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib', '/usr/lib/libSystem.B.dylib']
  )
  assert.deepEqual(
    parseOtoolDependencies(
      `sample.node:\n\t@loader_path/libtwilight-audio-engine.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`
    ),
    ['@loader_path/libtwilight-audio-engine.dylib', '/usr/lib/libSystem.B.dylib']
  )
  assert.deepEqual(
    parseOtoolRpaths(
      `Load command 1\n          cmd LC_RPATH\n      cmdsize 48\n         path @loader_path (offset 12)\nLoad command 2\n          cmd LC_RPATH\n      cmdsize 88\n         path /private/tmp/audio-engine/build/default (offset 12)\n`
    ),
    ['@loader_path', '/private/tmp/audio-engine/build/default']
  )
})

test('recognizes only Apple platform locations as system dependencies', () => {
  assert.equal(isSystemDependency('/System/Library/Frameworks/CoreAudio.framework/CoreAudio'), true)
  assert.equal(isSystemDependency('/usr/lib/libSystem.B.dylib'), true)
  assert.equal(isSystemDependency('/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib'), false)
  assert.equal(isSystemDependency('@loader_path/libavcodec.63.dylib'), false)
})

test('packaged macOS runtime rejects absolute third-party loads and missing loader-path siblings', () => {
  const runtimeDir = path.resolve('/tmp/twilight-macos-runtime-fixture')
  const engine = path.join(runtimeDir, 'libtwilight-audio-engine.dylib')
  const node = path.join(runtimeDir, 'twilight_audio_node.node')
  assert.throws(
    () =>
      validateBundledMacOSRuntime([engine, node], {
        inspectDependencies: (file) =>
          file === engine
            ? ['/opt/homebrew/opt/ffmpeg/lib/libavcodec.63.dylib']
            : ['@loader_path/libtwilight-audio-engine.dylib'],
        inspectRpaths: () => [],
        exists: () => true
      }),
    /non-portable Mach-O dependency/
  )
  assert.throws(
    () =>
      validateBundledMacOSRuntime([engine, node], {
        inspectDependencies: () => ['@loader_path/libmissing.dylib'],
        inspectRpaths: () => [],
        exists: () => false
      }),
    /missing bundled Mach-O dependency/
  )
})

test('packaged macOS runtime accepts loader-relative dependencies with no build-machine rpaths', () => {
  const runtimeDir = path.resolve('/tmp/twilight-macos-runtime-fixture')
  const engine = path.join(runtimeDir, 'libtwilight-audio-engine.dylib')
  const node = path.join(runtimeDir, 'twilight_audio_node.node')
  const dependency = path.join(runtimeDir, 'libavcodec.63.dylib')
  const result = validateBundledMacOSRuntime([engine, node, dependency], {
    inspectDependencies: (file) =>
      file === node
        ? ['@loader_path/libtwilight-audio-engine.dylib', '/usr/lib/libSystem.B.dylib']
        : file === engine
          ? ['@loader_path/libavcodec.63.dylib']
          : ['/usr/lib/libSystem.B.dylib'],
    inspectRpaths: () => ['@loader_path'],
    exists: () => true
  })
  assert.deepEqual(result, { binaries: 3, bundledDependencies: 2 })
})

test('Node-API uses the native loader-relative rpath on macOS', () => {
  const cmake = fs.readFileSync(
    path.join(__dirname, '..', 'audio-engine', 'CMakeLists.txt'),
    'utf8'
  )
  assert.match(cmake, /if\(APPLE\)\s+set\(TAE_NAPI_RPATH "@loader_path"\)/)
  assert.match(cmake, /BUILD_RPATH "\$\{TAE_NAPI_RPATH\}"/)
  assert.match(cmake, /INSTALL_RPATH "\$\{TAE_NAPI_RPATH\}"/)
})

test('macOS packaging maps Electron architecture names to Clang and keeps downloads distinct', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'build-macos.yml'),
    'utf8'
  )
  assert.match(workflow, /arch: x64\s+cmake_arch: x86_64\s+runner: macos-15-intel/)
  assert.match(workflow, /arch: arm64\s+cmake_arch: arm64\s+runner: macos-15/)
  assert.ok(workflow.includes('-DCMAKE_OSX_ARCHITECTURES="${{ matrix.cmake_arch }}"'))
  assert.ok(workflow.includes('--mac --${{ matrix.arch }}'))
  const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8')
  assert.match(
    builder,
    /notarize: false\s+artifactName: \$\{name\}-\$\{version\}-mac-\$\{arch\}\.\$\{ext\}/
  )
  assert.match(builder, /dmg:\s+artifactName: \$\{name\}-\$\{version\}-mac-\$\{arch\}\.\$\{ext\}/)
})
