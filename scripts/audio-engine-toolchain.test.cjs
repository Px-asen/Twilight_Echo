const assert = require('node:assert/strict')
const {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, parse, delimiter } = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  MINGW_EXPECTED_CTESTS,
  findStaleCTestRegistrations,
  prepareMingwCmakeEnvironment,
  prepareMingwBuildLayout,
  resolveMingwBuildJobs,
  resolveMingwBuildLayout,
  resolveMingwEnvironment,
  validateMingwBuildCommands,
  validateMingwCTestRegistration,
  validateMingwNativeDependencyConfiguration,
  validateMingwToolchain
} = require('./audio-engine-toolchain.cjs')
const {
  cmakeCachePath,
  prepareAsioMsvcNinjaToolchain,
  resolveAsioMsvcBuildDirectory,
  resolveAsioMsvcEnvironment
} = require('./asio-msvc-toolchain.cjs')
const { resolveSmtcMsvcEnvironment } = require('./smtc-msvc-toolchain.cjs')
const { resolveVst3MsvcEnvironment } = require('./vst3-msvc-toolchain.cjs')
const { createMinimalPe } = require('./pe-fixture.cjs')

// stage-audio-engine.cjs requires these siblings, so a fixture copy needs all of
// them or the script dies with MODULE_NOT_FOUND before reaching its own checks.
const STAGING_SCRIPT_FILES = Object.freeze([
  'stage-audio-engine.cjs',
  'diagnostic-symbols.cjs',
  'audio-engine-toolchain.cjs',
  'windows-persisted-environment.cjs',
  'macos-audio-runtime.cjs',
  'generate-audio-capability-manifest.cjs',
  'staged-audio-runtime-observation.cjs',
  'verify-release-capability-consistency.cjs',
  'verify-release-artifacts.cjs',
  'verify-asio-helper-artifacts.cjs',
  'pe-imports.cjs'
])

function copyStagingScripts(fixtureScripts) {
  mkdirSync(fixtureScripts, { recursive: true })
  for (const file of STAGING_SCRIPT_FILES) {
    copyFileSync(join(__dirname, file), join(fixtureScripts, file))
  }
  for (const file of STAGING_SCRIPT_FILES) {
    assert.ok(existsSync(join(fixtureScripts, file)), `staging fixture omitted ${file}`)
  }
}

function nativeLibraryName() {
  return process.platform === 'win32'
    ? 'twilight-audio-engine.dll'
    : process.platform === 'darwin'
      ? 'libtwilight-audio-engine.dylib'
      : 'libtwilight-audio-engine.so'
}

function runtimeFileNames() {
  return [
    nativeLibraryName(),
    'twilight_audio_node.node',
    ...(process.platform === 'win32' ? ['twilight-asio-helper.exe'] : [])
  ]
}

/** Staging parses import tables on Windows, so fixtures must be real PE files. */
function writeRuntimeFixture(directory, file, options = {}) {
  if (process.platform === 'darwin') {
    const marker = JSON.stringify(options.trailer ?? `fixture ${file}`)
    const source = file.endsWith('.node')
      ? `const char *twilight_test_node_marker = ${marker}; int twilight_test_node_fixture(void) { return 0; }\n`
      : `const char *twilight_test_library_marker = ${marker}; int twilight_test_library_fixture(void) { return 0; }\n`
    const result = spawnSync(
      'clang',
      [
        '-x',
        'c',
        '-',
        file.endsWith('.node') ? '-bundle' : '-dynamiclib',
        '-o',
        join(directory, file)
      ],
      { input: source, encoding: 'utf8' }
    )
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return
  }
  writeFileSync(join(directory, file), createMinimalPe(options))
}

// Virtual absolute fixture paths; no toolchain installation is needed on the host.
function fixturePath(...parts) {
  return join(parse(tmpdir()).root, 'twilight-toolchain-fixtures', ...parts).replaceAll('\\', '/')
}

function createExistsSync(paths) {
  const existing = new Set(paths.map((entry) => entry.replaceAll('\\', '/').toLowerCase()))
  return (entry) => existing.has(String(entry).replaceAll('\\', '/').toLowerCase())
}

function createSpawnSync(results) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const result = results[command]
    return typeof result === 'function' ? result(command, args, options) : result
  }
  spawn.calls = calls
  return spawn
}

function createGnuPatchSpawnSync() {
  return createSpawnSync(
    new Proxy(
      {},
      {
        get: () => ({ status: 0, stdout: 'GNU patch 2.7.6', stderr: '' })
      }
    )
  )
}

const persistedEnvironmentCases = [
  {
    name: 'MinGW',
    resolveEnvironment: resolveMingwEnvironment,
    names: ['VCPKG_ROOT', 'W64DEVKIT_ROOT', 'TAE_MINGW_BUILD_DIR', 'TWILIGHT_GNU_PATCH']
  },
  {
    name: 'ASIO',
    resolveEnvironment: resolveAsioMsvcEnvironment,
    names: ['TAE_ASIO_MSVC_INSTALL_ROOT', 'TAE_ASIO_MSVC_BUILD_DIR']
  },
  {
    name: 'SMTC',
    resolveEnvironment: resolveSmtcMsvcEnvironment,
    names: ['TAE_SMTC_MSVC_INSTALL_ROOT', 'TAE_SMTC_MSVC_BUILD_DIR']
  },
  {
    name: 'VST3',
    resolveEnvironment: resolveVst3MsvcEnvironment,
    names: ['TAE_VST3_SDK_ROOT', 'TAE_VST3_MSVC_INSTALL_ROOT', 'TAE_VST3_MSVC_BUILD_DIR']
  }
]
const windowsEnvironmentOnly =
  process.platform === 'win32' ? {} : { skip: 'Windows registry lookup' }

for (const { name, resolveEnvironment, names } of persistedEnvironmentCases) {
  test(
    `${name} gives process values priority and queries only its persisted variable allowlist`,
    windowsEnvironmentOnly,
    () => {
      const env = Object.freeze({
        [names[0]]: 'process value',
        [names[1]]: '',
        PATH: 'process path'
      })
      const spawn = createSpawnSync({
        'reg.exe': (_, args) => ({
          status: 0,
          stdout: `    ${args[3]}    REG_SZ    persisted value`
        })
      })
      const result = resolveEnvironment({ env, spawnSync: spawn })

      assert.notEqual(result, env)
      assert.deepEqual(result, {
        ...env,
        ...Object.fromEntries(names.slice(1).map((variable) => [variable, 'persisted value']))
      })
      assert.deepEqual(env, { [names[0]]: 'process value', [names[1]]: '', PATH: 'process path' })
      assert.deepEqual(
        spawn.calls,
        names.slice(1).map((variable) => ({
          command: 'reg.exe',
          args: ['query', 'HKCU\\Environment', '/v', variable],
          options: { encoding: 'utf8', windowsHide: true }
        }))
      )
    }
  )

  test(
    `${name} preserves paths and trims REG_SZ and REG_EXPAND_SZ output`,
    windowsEnvironmentOnly,
    () => {
      const values = ['C:\\Program Files\\Build Tools', '%LOCALAPPDATA%\\Tool Chain']
      const spawn = createSpawnSync({
        'reg.exe': (_, args) => {
          const index = names.indexOf(args[3]) % values.length
          const type = index === 0 ? 'REG_SZ' : 'REG_EXPAND_SZ'
          return {
            status: 0,
            stdout: `HKEY_CURRENT_USER\\Environment\r\n\t${args[3].toLowerCase()}  ${type}\t ${values[index]}  \r\n    UNRELATED    REG_SZ    ignored\r\n`
          }
        }
      })
      const result = resolveEnvironment({ env: {}, spawnSync: spawn })
      assert.deepEqual(
        result,
        Object.fromEntries(
          names.map((variable, index) => [variable, values[index % values.length]])
        )
      )
      assert.deepEqual(
        spawn.calls.map((call) => call.args[3]),
        names
      )
    }
  )

  test(`${name} ignores failed registry queries and missing values`, windowsEnvironmentOnly, () => {
    for (const registryResult of [
      undefined,
      { status: 1, stdout: `    ${names[0]}    REG_SZ    failed value` },
      {
        status: 0,
        error: new Error('registry unavailable'),
        stdout: `    ${names[0]}    REG_SZ    failed value`
      },
      { status: 0 },
      { status: 0, stdout: '' },
      { status: 0, stdout: `    ${names[0]}    REG_SZ` },
      { status: 0, stdout: '    UNRELATED    REG_SZ    ignored' }
    ]) {
      const env = Object.freeze({ PATH: 'process path' })
      const spawn = createSpawnSync({ 'reg.exe': registryResult })
      assert.deepEqual(resolveEnvironment({ env, spawnSync: spawn }), env)
      assert.deepEqual(
        spawn.calls.map((call) => call.args[3]),
        names
      )
    }
  })
}

test(
  'MinGW keeps its case-insensitive string lookup for existing environment values',
  windowsEnvironmentOnly,
  () => {
    const env = Object.freeze({
      vcpkg_root: 'process vcpkg',
      w64devkit_root: 'process devkit',
      TAE_MINGW_BUILD_DIR: 1
    })
    const spawn = createSpawnSync({ 'reg.exe': { status: 1 } })
    assert.deepEqual(resolveMingwEnvironment({ env, spawnSync: spawn }), env)
    assert.deepEqual(
      spawn.calls.map((call) => call.args[3]),
      ['TAE_MINGW_BUILD_DIR', 'TWILIGHT_GNU_PATCH']
    )
  }
)

test(
  'MSVC resolvers keep exact-key truthy lookup for existing environment values',
  windowsEnvironmentOnly,
  () => {
    for (const { resolveEnvironment, names } of persistedEnvironmentCases.slice(1)) {
      const env = Object.freeze({ [names[0]]: 1, [names[1].toLowerCase()]: 'lowercase value' })
      const spawn = createSpawnSync({ 'reg.exe': { status: 1 } })
      assert.deepEqual(resolveEnvironment({ env, spawnSync: spawn }), env)
      assert.deepEqual(
        spawn.calls.map((call) => call.args[3]),
        names.slice(1)
      )
    }
  }
)

test(
  'ASIO uses the VST3 install root only after process and persisted ASIO values',
  windowsEnvironmentOnly,
  () => {
    const env = Object.freeze({ TAE_VST3_MSVC_INSTALL_ROOT: 'VST3 root' })
    assert.equal(
      resolveAsioMsvcEnvironment({ env, spawnSync: () => ({ status: 1 }) })
        .TAE_ASIO_MSVC_INSTALL_ROOT,
      'VST3 root'
    )
    const spawn = createSpawnSync({
      'reg.exe': (_, args) => ({ status: 0, stdout: `    ${args[3]}    REG_SZ    persisted ASIO` })
    })
    assert.equal(
      resolveAsioMsvcEnvironment({ env, spawnSync: spawn }).TAE_ASIO_MSVC_INSTALL_ROOT,
      'persisted ASIO'
    )
    assert.equal(
      resolveAsioMsvcEnvironment({
        env: { ...env, TAE_ASIO_MSVC_INSTALL_ROOT: 'process ASIO' },
        spawnSync: spawn
      }).TAE_ASIO_MSVC_INSTALL_ROOT,
      'process ASIO'
    )
    assert.deepEqual(env, { TAE_VST3_MSVC_INSTALL_ROOT: 'VST3 root' })
    assert.deepEqual(resolveSmtcMsvcEnvironment({ env, spawnSync: () => ({ status: 1 }) }), env)
  }
)

test('environment resolvers return a copy without registry queries or ASIO fallback outside Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'non-windows' })
    for (const { resolveEnvironment } of persistedEnvironmentCases) {
      const env = Object.freeze({ TAE_VST3_MSVC_INSTALL_ROOT: 'VST3 root' })
      const result = resolveEnvironment({
        env,
        spawnSync: () => assert.fail('unexpected registry query')
      })
      assert.notEqual(result, env)
      assert.deepEqual(result, env)
    }
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test('prepares a deterministic MSVC and Ninja environment for the ASIO ABI fixture', () => {
  const installRoot = fixturePath('tools/vs2022-buildtools')
  const msvcVersion = '14.44.35207'
  const sdkRoot = fixturePath('Program Files (x86)/Windows Kits/10')
  const sdkVersion = '10.0.26100.0'
  const existing = [
    `${installRoot}/Common7/Tools/VsDevCmd.bat`,
    `${installRoot}/VC/Tools/MSVC`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/bin/Hostx64/x64/cl.exe`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/bin/Hostx64/x64/link.exe`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/include/cstddef`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/lib/x64/msvcrt.lib`,
    `${installRoot}/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe`,
    `${installRoot}/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe`,
    `${sdkRoot}/bin/${sdkVersion}/x64/rc.exe`,
    `${sdkRoot}/bin/${sdkVersion}/x64/mt.exe`,
    `${sdkRoot}/Include/${sdkVersion}/um/Windows.h`,
    `${sdkRoot}/Lib/${sdkVersion}/um/x64/kernel32.lib`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/include`,
    `${sdkRoot}/Include/${sdkVersion}/ucrt`,
    `${sdkRoot}/Include/${sdkVersion}/shared`,
    `${sdkRoot}/Include/${sdkVersion}/um`,
    `${sdkRoot}/Include/${sdkVersion}/winrt`,
    `${sdkRoot}/Include/${sdkVersion}/cppwinrt`,
    `${installRoot}/VC/Tools/MSVC/${msvcVersion}/lib/x64`,
    `${sdkRoot}/Lib/${sdkVersion}/ucrt/x64`,
    `${sdkRoot}/Lib/${sdkVersion}/um/x64`,
    `${sdkRoot}/UnionMetadata/${sdkVersion}`,
    `${sdkRoot}/References/${sdkVersion}`
  ]
  const result = prepareAsioMsvcNinjaToolchain({
    env: {
      TAE_ASIO_MSVC_INSTALL_ROOT: installRoot,
      'ProgramFiles(x86)': fixturePath('Program Files (x86)'),
      PATH: fixturePath('Windows/System32')
    },
    exists: createExistsSync(existing),
    readDirectories: (path) => {
      if (String(path).replaceAll('\\', '/').endsWith('/VC/Tools/MSVC')) {
        return [{ name: msvcVersion, isDirectory: () => true }]
      }
      if (String(path).replaceAll('\\', '/').endsWith('/Windows Kits/10/Include')) {
        return [{ name: sdkVersion, isDirectory: () => true }]
      }
      return []
    }
  })

  assert.equal(result.ok, true)
  assert.equal(result.msvcVersion, msvcVersion)
  assert.equal(result.sdkVersion, sdkVersion)
  assert.match(cmakeCachePath(result.environment.PATH), /Hostx64\/x64/)
  assert.match(cmakeCachePath(result.environment.INCLUDE), /MSVC\/14\.44\.35207\/include/)
  assert.match(
    cmakeCachePath(result.environment.LIB),
    /Windows Kits\/10\/Lib\/10\.0\.26100\.0\/um\/x64/
  )
  assert.match(cmakeCachePath(result.cmakePath), /CMake\/bin\/cmake\.exe$/)
  assert.match(cmakeCachePath(result.ninjaPath), /CMake\/Ninja\/ninja\.exe$/)
})

test('normalizes MSVC cache paths before passing them to CMake', () => {
  assert.equal(
    cmakeCachePath('C:\\Program Files (x86)\\Windows Kits\\10\\bin\\rc.exe'),
    'C:/Program Files (x86)/Windows Kits/10/bin/rc.exe'
  )
})

test('uses the MSVC Ninja build directory by default for ASIO ABI fixtures', () => {
  assert.match(
    cmakeCachePath(resolveAsioMsvcBuildDirectory({}, fixturePath('repo'))),
    /audio-engine\/build\/asio-msvc-ninja-x64$/
  )
})

test('rejects a missing MinGW toolchain environment before CMake configures', () => {
  const result = validateMingwToolchain({
    env: {},
    existsSync: createExistsSync([])
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /VCPKG_ROOT/)
  assert.match(result.message, /W64DEVKIT_ROOT/)
})

test('accepts an installed toolchain and rejects CTest entries from a moved build directory', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const buildDir = 'C:/repo/audio-engine/build/mingw-static'
  const result = validateMingwToolchain({
    env: { VCPKG_ROOT: vcpkgRoot, W64DEVKIT_ROOT: devkitRoot },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`
    ])
  })

  assert.deepEqual(result, { ok: true, message: '' })
  assert.deepEqual(
    findStaleCTestRegistrations(
      'add_test([=[engine]=] "T:/audio-engine/build/mingw-static/twilight_audio_tests.exe")',
      buildDir
    ),
    ['T:/audio-engine/build/mingw-static/twilight_audio_tests.exe']
  )
})

function registeredCTestOutput(names = MINGW_EXPECTED_CTESTS) {
  return `${names.map((name, index) => `  Test #${index + 1}: ${name}`).join('\n')}\n\nTotal Tests: ${names.length}`
}

test('fails closed when a MinGW build has no CMake cache or CTest file', () => {
  const buildDir = fixturePath('twilight-build/mingw-static')
  const missingCache = validateMingwCTestRegistration({
    buildDir,
    existsSync: createExistsSync([]),
    spawnSync: () => {
      throw new Error('ctest must not run without a cache')
    }
  })
  assert.equal(missingCache.ok, false)
  assert.match(missingCache.message, /CMakeCache\.txt/)

  const missingCTestFile = validateMingwCTestRegistration({
    buildDir,
    existsSync: createExistsSync([`${buildDir}/CMakeCache.txt`]),
    spawnSync: () => {
      throw new Error('ctest must not run without CTestTestfile.cmake')
    }
  })
  assert.equal(missingCTestFile.ok, false)
  assert.match(missingCTestFile.message, /CTestTestfile\.cmake/)
})

test('rejects zero or incomplete MinGW CTest discovery even when ctest exits zero', () => {
  const buildDir = fixturePath('twilight-build/mingw-static')
  const base = {
    buildDir,
    existsSync: createExistsSync([`${buildDir}/CMakeCache.txt`, `${buildDir}/CTestTestfile.cmake`]),
    readFileSync: () => `add_test(NAME local COMMAND "${buildDir}/local.exe")`
  }

  const zeroTests = validateMingwCTestRegistration({
    ...base,
    spawnSync: () => ({ status: 0, stdout: 'No tests were found!!!\nTotal Tests: 0', stderr: '' })
  })
  assert.equal(zeroTests.ok, false)
  assert.match(zeroTests.message, /zero tests/)

  const incomplete = validateMingwCTestRegistration({
    ...base,
    spawnSync: () => ({
      status: 0,
      stdout: registeredCTestOutput(MINGW_EXPECTED_CTESTS.slice(1)),
      stderr: ''
    })
  })
  assert.equal(incomplete.ok, false)
  assert.deepEqual(incomplete.missing, [MINGW_EXPECTED_CTESTS[0]])
})

test('accepts a configured MinGW build only when every native CTest is registered', () => {
  const buildDir = fixturePath('twilight-build/mingw-static')
  const result = validateMingwCTestRegistration({
    buildDir,
    existsSync: createExistsSync([`${buildDir}/CMakeCache.txt`, `${buildDir}/CTestTestfile.cmake`]),
    readFileSync: () => `add_test(NAME local COMMAND "${buildDir}/twilight_audio_tests.exe")`,
    spawnSync: () => ({ status: 0, stdout: registeredCTestOutput(), stderr: '' })
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 0)
  assert.deepEqual(result.missing, [])
})

test('fails closed when the MinGW cache was configured without vcpkg native dependencies', () => {
  const buildDir = fixturePath('twilight-build/mingw-static')
  const cache = `${buildDir}/CMakeCache.txt`
  const result = validateMingwNativeDependencyConfiguration({
    buildDir,
    existsSync: createExistsSync([cache]),
    readFileSync: () =>
      [
        'VCPKG_TARGET_TRIPLET:UNINITIALIZED=x64-mingw-static',
        'TAE_BUILD_NAPI:BOOL=ON',
        'FFMPEG_FOUND:BOOL=FALSE',
        'EBUR128_INCLUDE_DIR:PATH=EBUR128_INCLUDE_DIR-NOTFOUND'
      ].join('\n')
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /VCPKG_INSTALLED_DIR/)
  assert.match(result.message, /FFMPEG_FOUND/)
  assert.match(result.message, /EBUR128_INCLUDE_DIR/)
})

test('accepts a MinGW cache only when vcpkg FFmpeg and libebur128 resolve from the selected build', () => {
  const buildDir = fixturePath('twilight-build/mingw-static')
  const installRoot = `${buildDir}/vcpkg_installed`
  const tripletRoot = `${installRoot}/x64-mingw-static`
  const cache = `${buildDir}/CMakeCache.txt`
  const result = validateMingwNativeDependencyConfiguration({
    buildDir,
    existsSync: createExistsSync([
      cache,
      `${tripletRoot}/include/ebur128.h`,
      `${tripletRoot}/lib/libebur128.a`,
      `${tripletRoot}/include/libavformat/avformat.h`
    ]),
    readFileSync: () =>
      [
        `VCPKG_INSTALLED_DIR:PATH=${installRoot}`,
        'VCPKG_TARGET_TRIPLET:STRING=x64-mingw-static',
        'TAE_BUILD_NAPI:BOOL=ON',
        'FFMPEG_FOUND:BOOL=TRUE',
        `EBUR128_INCLUDE_DIR:PATH=${tripletRoot}/include`,
        `EBUR128_LIBRARY:FILEPATH=${tripletRoot}/lib/libebur128.a`,
        `FFMPEG_INCLUDE_DIRS:STRING=${tripletRoot}/include`
      ].join('\n')
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
})

test('prepares a MinGW environment with GNU patch before the w64devkit tools', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const programFiles = fixturePath('Program Files')
  const gnuPatch = `${programFiles}/Git/usr/bin/patch.exe`
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: fixturePath('Windows/System32')
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      gnuPatch
    ]),
    spawnSync: createSpawnSync({
      [resolve(gnuPatch)]: {
        status: 0,
        stdout: 'GNU patch 2.7.6',
        stderr: ''
      }
    })
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.environment.PATH.split(delimiter).slice(0, 2), [
    join(programFiles, 'Git', 'usr', 'bin'),
    join(devkitRoot, 'bin')
  ])
})

test('preserves a Windows Path environment value when building the MinGW PATH', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const programFiles = fixturePath('Program Files')
  const gnuPatch = `${programFiles}/Git/usr/bin/patch.exe`
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      Path: [fixturePath('Windows/System32'), fixturePath('Windows')].join(delimiter)
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      gnuPatch
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })

  assert.equal(result.ok, true)
  assert.equal(result.environment.Path, undefined)
  assert.deepEqual(result.environment.PATH.split(delimiter).slice(-2), [
    fixturePath('Windows/System32'),
    fixturePath('Windows')
  ])
})

test('rejects a TWILIGHT_GNU_PATCH override that is not GNU patch', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const busyboxPatch = `${devkitRoot}/bin/patch.exe`
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      TWILIGHT_GNU_PATCH: busyboxPatch,
      ProgramFiles: fixturePath('Program Files'),
      PATH: fixturePath('Windows/System32')
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      busyboxPatch,
      fixturePath('Program Files/Git/usr/bin/patch.exe')
    ]),
    spawnSync: createSpawnSync({
      [resolve(busyboxPatch)]: {
        status: 0,
        stdout: 'BusyBox v1.36.1',
        stderr: ''
      }
    })
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /TWILIGHT_GNU_PATCH/)
  assert.match(result.message, /Git for Windows/)
})

test('rejects an automatic Git patch path that does not identify as GNU patch', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const gnuPatch = fixturePath('Program Files/Git/usr/bin/patch.exe')
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: fixturePath('Program Files'),
      PATH: fixturePath('Windows/System32')
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      gnuPatch
    ]),
    spawnSync: createSpawnSync({
      'C:\\Program Files\\Git\\usr\\bin\\patch.exe': {
        status: 0,
        stdout: 'patch 2.7.6',
        stderr: ''
      }
    })
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /Git for Windows/)
  assert.match(result.message, /valid TWILIGHT_GNU_PATCH/)
})

test('rejects a w64devkit environment without a compatible GNU patch executable', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const result = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      PATH: fixturePath('Windows/System32')
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`
    ])
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /GNU patch/)
  assert.match(result.message, /TWILIGHT_GNU_PATCH/)
})

test('reports missing CMake and CTest before native configuration or test discovery', () => {
  const missingCmake = validateMingwBuildCommands({
    env: { PATH: fixturePath('Windows/System32') },
    spawnSync: createSpawnSync({
      cmake: { error: new Error('spawn cmake ENOENT'), status: null, stdout: '', stderr: '' },
      ctest: { status: 0, stdout: 'ctest version 3.30.0', stderr: '' }
    })
  })
  assert.equal(missingCmake.ok, false)
  assert.match(missingCmake.message, /CMake.*cmake/i)
  assert.match(missingCmake.message, /PATH/)

  const missingCtest = validateMingwBuildCommands({
    env: { PATH: fixturePath('Windows/System32') },
    spawnSync: createSpawnSync({
      cmake: { status: 0, stdout: 'cmake version 3.30.0', stderr: '' },
      ctest: { error: new Error('spawn ctest ENOENT'), status: null, stdout: '', stderr: '' }
    })
  })
  assert.equal(missingCtest.ok, false)
  assert.match(missingCtest.message, /CTest.*ctest/i)
  assert.match(missingCtest.message, /PATH/)
})

test('requires a no-whitespace MinGW build directory and derives its temporary directory', () => {
  const missingOverride = resolveMingwBuildLayout({
    root: fixturePath('Project With Spaces/Twilight Echo'),
    env: {}
  })
  assert.equal(missingOverride.ok, false)
  assert.match(missingOverride.message, /TAE_MINGW_BUILD_DIR/)

  const configured = resolveMingwBuildLayout({
    root: fixturePath('Project With Spaces/Twilight Echo'),
    env: { TAE_MINGW_BUILD_DIR: fixturePath('twilight-build/mingw-static') }
  })
  assert.deepEqual(configured, {
    ok: true,
    buildDir: resolve(fixturePath('twilight-build/mingw-static')),
    tempDir: join(fixturePath('twilight-build/mingw-static'), 'tmp')
  })
})

test('creates and validates the selected MinGW build layout before CMake runs', () => {
  const created = []
  const checked = []
  const result = prepareMingwBuildLayout({
    root: fixturePath('Project With Spaces/Twilight Echo'),
    env: { TAE_MINGW_BUILD_DIR: fixturePath('twilight-build/mingw-static') },
    mkdirSync: (directory, options) => created.push({ directory, options }),
    accessSync: (directory, mode) => checked.push({ directory, mode }),
    constants: { W_OK: 2 }
  })

  assert.deepEqual(result, {
    ok: true,
    buildDir: resolve(fixturePath('twilight-build/mingw-static')),
    tempDir: join(fixturePath('twilight-build/mingw-static'), 'tmp')
  })
  assert.deepEqual(created, [
    {
      directory: resolve(fixturePath('twilight-build/mingw-static')),
      options: { recursive: true }
    },
    {
      directory: join(fixturePath('twilight-build/mingw-static'), 'tmp'),
      options: { recursive: true }
    }
  ])
  assert.deepEqual(checked, [
    { directory: resolve(fixturePath('twilight-build/mingw-static')), mode: 2 },
    { directory: join(fixturePath('twilight-build/mingw-static'), 'tmp'), mode: 2 }
  ])
})

test('reports an actionable preflight error for an unwritable selected MinGW layout', () => {
  const result = prepareMingwBuildLayout({
    root: fixturePath('Project With Spaces/Twilight Echo'),
    env: { TAE_MINGW_BUILD_DIR: fixturePath('twilight-build/mingw-static') },
    mkdirSync: () => {},
    accessSync: () => {
      const error = new Error('permission denied')
      error.code = 'EACCES'
      throw error
    },
    constants: { W_OK: 2 }
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /^MinGW audio toolchain preflight failed:/)
  assert.ok(result.message.includes(resolve(fixturePath('twilight-build/mingw-static'))))
  assert.match(result.message, /writable/i)
  assert.doesNotMatch(result.message, /Error:/)
})

test('uses the selected build directory for the CMake temporary environment', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const programFiles = fixturePath('Program Files')
  const result = prepareMingwCmakeEnvironment({
    buildDir: fixturePath('twilight-build/mingw-static'),
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: fixturePath('Windows/System32')
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })

  assert.equal(result.ok, true)
  assert.equal(result.environment.TEMP, join(fixturePath('twilight-build/mingw-static'), 'tmp'))
  assert.equal(result.environment.TMP, result.environment.TEMP)
  assert.equal(result.environment.TMPDIR, result.environment.TEMP)
})

test('enables MSYS .lnk symlinks without replacing unrelated MSYS flags', () => {
  const vcpkgRoot = fixturePath('tools/vcpkg')
  const devkitRoot = fixturePath('tools/w64devkit')
  const programFiles = fixturePath('Program Files')
  const result = prepareMingwCmakeEnvironment({
    buildDir: fixturePath('twilight-build/mingw-static'),
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: fixturePath('Windows/System32'),
      MSYS: 'noacl winsymlinks:lnk'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })

  assert.equal(result.ok, true)
  assert.equal(result.environment.MSYS, 'noacl winsymlinks:lnk')

  const withDuplicateLinkFallback = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: fixturePath('Windows/System32'),
      MSYS: 'noacl winsymlinks:lnk winsymlinks:lnk'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })
  assert.equal(withDuplicateLinkFallback.ok, true)
  assert.equal(withDuplicateLinkFallback.environment.MSYS, 'noacl winsymlinks:lnk')

  const withLaterConflictingLinkMode = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: fixturePath('Windows/System32'),
      MSYS: 'noacl winsymlinks:lnk winsymlinks:native'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })
  assert.equal(withLaterConflictingLinkMode.ok, true)
  assert.equal(
    withLaterConflictingLinkMode.environment.MSYS,
    'noacl winsymlinks:native winsymlinks:lnk'
  )

  const withoutLinkFallback = prepareMingwCmakeEnvironment({
    env: {
      VCPKG_ROOT: vcpkgRoot,
      W64DEVKIT_ROOT: devkitRoot,
      ProgramFiles: programFiles,
      PATH: fixturePath('Windows/System32'),
      MSYS: 'noacl'
    },
    existsSync: createExistsSync([
      `${vcpkgRoot}/scripts/buildsystems/vcpkg.cmake`,
      `${devkitRoot}/bin/gcc.exe`,
      `${devkitRoot}/bin/g++.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-gcc.exe`,
      `${devkitRoot}/bin/x86_64-w64-mingw32-g++.exe`,
      `${devkitRoot}/bin/ninja.exe`,
      `${programFiles}/Git/usr/bin/patch.exe`
    ]),
    spawnSync: createGnuPatchSpawnSync()
  })
  assert.equal(withoutLinkFallback.ok, true)
  assert.equal(withoutLinkFallback.environment.MSYS, 'noacl winsymlinks:lnk')
})

test('MinGW configure script performs the preflight before invoking CMake', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /findStaleCTestRegistrations/)
  assert.match(script, /prepareMingwCmakeEnvironment/)
  assert.match(script, /prepareMingwBuildLayout/)
  assert.match(script, /const toolchainEnvironment = resolveMingwEnvironment\(\)/)
  assert.match(
    script,
    /const buildLayout = prepareMingwBuildLayout\(\{ root, env: toolchainEnvironment \}\)/
  )
  assert.match(script, /const \{ buildDir \} = buildLayout/)
  assert.match(script, /'-B', buildDir/)
  assert.match(script, /const cmakeEnvironment = preflight\.environment/)
})

test('MinGW configure validates once and never retries a possibly active vcpkg configure', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /const status = runCmake\(\)/)
  assert.match(script, /if \(status !== 0\) process\.exit\(status\)/)
  assert.equal(script.match(/runCmake\(\)/g)?.length, 2)
  assert.doesNotMatch(script, /cleanFfmpegExtractTemps|vcpkgLogText/)
})

test('MinGW scripts preflight CMake and CTest with the prepared environment', () => {
  const configureScript = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')
  const runnerScript = readFileSync(join(__dirname, 'run-audio-engine-mingw.cjs'), 'utf8')

  assert.match(configureScript, /validateMingwBuildCommands/)
  assert.match(configureScript, /validateMingwBuildCommands\(\{ env: cmakeEnvironment \}\)/)
  assert.match(configureScript, /validateMingwCTestRegistration/)
  assert.match(configureScript, /expectedTests: MINGW_EXPECTED_CTESTS/)
  assert.match(runnerScript, /validateMingwBuildCommands/)
  assert.match(runnerScript, /prepareMingwBuildLayout/)
  assert.match(runnerScript, /const toolchainEnvironment = resolveMingwEnvironment\(\)/)
  assert.match(
    runnerScript,
    /const layout = prepareMingwBuildLayout\(\{ root, env: toolchainEnvironment \}\)/
  )
  assert.match(
    runnerScript,
    /validateMingwBuildCommands\(\{\s*env: preflight\.environment,\s*commands: \['cmake', 'ctest'\]\s*\}\)/
  )
  assert.match(runnerScript, /validateMingwCTestRegistration/)
  assert.match(
    runnerScript,
    /if \(!ctestRegistration\.ok\)[\s\S]*process\.exit\(ctestRegistration\.status \|\| 1\)/
  )
})

test('MinGW staging rejects an explicitly selected build directory instead of using fallback artifacts', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-stage-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

  const fixtureScripts = join(fixtureRoot, 'scripts')
  copyStagingScripts(fixtureScripts)

  const fallbackBuildDirs = [
    join(fixtureRoot, 'audio-engine', 'build', 'mingw-static'),
    join(fixtureRoot, 'audio-engine', 'build', 'windows-msvc'),
    join(fixtureRoot, 'audio-engine', 'build', 'default')
  ]
  const nativeLibrary = nativeLibraryName()
  for (const fallbackBuildDir of fallbackBuildDirs) {
    mkdirSync(fallbackBuildDir, { recursive: true })
    for (const file of runtimeFileNames()) {
      writeRuntimeFixture(fallbackBuildDir, file, { trailer: 'fallback artifact' })
    }
  }

  const selectedBuildDir = join(fixtureRoot, 'selected-build')
  const result = spawnSync(
    process.execPath,
    [join(fixtureScripts, 'stage-audio-engine.cjs'), '--build-dir', selectedBuildDir],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, TAE_MINGW_BUILD_DIR: '' }
    }
  )

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /selected audio-engine build directory/i)
  assert.equal(existsSync(join(fixtureRoot, 'resources', 'audio-engine', nativeLibrary)), false)
})

test('explicit staging output keeps the current player runtime intact', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-stage-isolated-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  const fixtureScripts = join(fixtureRoot, 'scripts')
  copyStagingScripts(fixtureScripts)
  const buildDir = join(fixtureRoot, 'selected-build')
  const currentDir = join(fixtureRoot, 'resources', 'audio-engine')
  const targetDir = join(fixtureRoot, 'prepared-runtime')
  mkdirSync(buildDir, { recursive: true })
  mkdirSync(currentDir, { recursive: true })
  for (const file of runtimeFileNames())
    writeRuntimeFixture(buildDir, file, { trailer: 'new artifact' })
  const current = join(currentDir, nativeLibraryName())
  writeFileSync(current, 'running player artifact')
  const result = spawnSync(
    process.execPath,
    [
      join(fixtureScripts, 'stage-audio-engine.cjs'),
      '--build-dir',
      buildDir,
      '--output-dir',
      targetDir
    ],
    { cwd: fixtureRoot, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(readFileSync(current, 'utf8'), 'running player artifact')
  for (const file of runtimeFileNames())
    assert.deepEqual(readFileSync(join(targetDir, file)), readFileSync(join(buildDir, file)))
  assert.ok(existsSync(join(targetDir, 'audio-capabilities.json')))
})

for (const fallbackName of ['windows-msvc', 'default']) {
  test(`generic audio staging discovers ${fallbackName} runtime artifacts`, (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight audio stage-'))
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

    const fixtureScripts = join(fixtureRoot, 'scripts')
    copyStagingScripts(fixtureScripts)

    const nativeLibrary = nativeLibraryName()
    const fallbackBuildDir = join(fixtureRoot, 'audio-engine', 'build', fallbackName)
    mkdirSync(fallbackBuildDir, { recursive: true })
    for (const file of runtimeFileNames()) {
      writeRuntimeFixture(fallbackBuildDir, file, { trailer: `artifact from ${fallbackName}` })
    }

    const result = spawnSync(process.execPath, [join(fixtureScripts, 'stage-audio-engine.cjs')], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: { ...process.env, TAE_MINGW_BUILD_DIR: '' }
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.ok(
      readFileSync(
        join(fixtureRoot, 'resources', 'audio-engine', nativeLibrary),
        'latin1'
      ).includes(`artifact from ${fallbackName}`),
      `staged ${nativeLibrary} did not come from the ${fallbackName} build directory`
    )
    const manifest = JSON.parse(
      readFileSync(
        join(fixtureRoot, 'resources', 'audio-engine', 'audio-capabilities.json'),
        'utf8'
      )
    )
    assert.equal(manifest.artifactDirectory, '.')
  })
}

// The MinGW build links libstdc++/libgcc/mcfgthread dynamically, so those DLLs
// must be staged beside the addon; without them dlopen fails on any machine that
// lacks that exact toolchain and the app can only report "未加载
// twilight_audio_node.node". Windows-only because the step parses PE imports.
const windowsStagingOnly = process.platform === 'win32' ? {} : { skip: 'Windows-only staging step' }

function stageRuntimeDependencyFixture(fixtureRoot, { provideRuntimeDll, provideSoxr = false }) {
  const fixtureScripts = join(fixtureRoot, 'scripts')
  copyStagingScripts(fixtureScripts)

  const nativeLibrary = nativeLibraryName()
  const buildDir = join(fixtureRoot, 'audio-engine', 'build', 'default')
  mkdirSync(buildDir, { recursive: true })
  writeRuntimeFixture(buildDir, nativeLibrary, {
    imports: ['libstdc++-6.dll', 'KERNEL32.dll', ...(provideSoxr ? ['libtwilight-soxr.dll'] : [])]
  })
  if (provideSoxr) {
    writeRuntimeFixture(buildDir, 'libtwilight-soxr.dll')
    const previousStage = join(fixtureRoot, 'resources', 'audio-engine')
    mkdirSync(previousStage, { recursive: true })
    writeFileSync(join(previousStage, 'libtwilight-soxr.dll'), 'stale SoX must be replaced')
    const sources = join(fixtureRoot, 'audio-engine', 'third_party', 'soxr')
    mkdirSync(join(sources, 'upstream', 'src'), { recursive: true })
    writeFileSync(join(sources, 'CMakeLists.txt'), '# replaceable shared library')
    writeFileSync(join(sources, 'upstream', 'LICENCE'), 'LGPL-2.1-or-later fixture')
    writeFileSync(join(sources, 'upstream', 'src', 'soxr.c'), '/* source fixture */')
  }
  writeRuntimeFixture(buildDir, 'twilight_audio_node.node', {
    imports: [nativeLibrary, 'libstdc++-6.dll']
  })
  writeRuntimeFixture(buildDir, 'twilight-asio-helper.exe', {
    imports: ['libstdc++-6.dll']
  })

  const toolchainBin = join(fixtureRoot, 'toolchain', 'bin')
  mkdirSync(toolchainBin, { recursive: true })
  // Reachable only through libstdc++-6.dll, so staging has to walk the closure.
  writeRuntimeFixture(toolchainBin, 'libmcfgthread-2.dll')
  if (provideRuntimeDll) {
    writeRuntimeFixture(toolchainBin, 'libstdc++-6.dll', { imports: ['libmcfgthread-2.dll'] })
  }

  const result = spawnSync(
    process.execPath,
    [join(fixtureScripts, 'stage-audio-engine.cjs'), '--runtime-dir', toolchainBin],
    {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        // Synthetic PE import fixtures are not executable toolchain output.
        // Do not let an unrelated strip.exe on the developer PATH rewrite them.
        PATH: '',
        Path: '',
        TAE_MINGW_BUILD_DIR: '',
        TAE_MINGW_RUNTIME_DIR: '',
        W64DEVKIT_ROOT: '',
        TAE_W64DEVKIT_ROOT: ''
      }
    }
  )
  return { result, stagedDir: join(fixtureRoot, 'resources', 'audio-engine') }
}

test(
  'Windows staging copies the whole toolchain runtime import closure',
  windowsStagingOnly,
  (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-runtime-'))
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

    const { result, stagedDir } = stageRuntimeDependencyFixture(fixtureRoot, {
      provideRuntimeDll: true
    })

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    for (const file of ['libstdc++-6.dll', 'libmcfgthread-2.dll']) {
      assert.ok(existsSync(join(stagedDir, file)), `${file} was not staged beside the addon`)
    }
  }
)

test(
  'Windows staging includes direct SoX and its corresponding source and license',
  windowsStagingOnly,
  (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-soxr-'))
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
    const { result, stagedDir } = stageRuntimeDependencyFixture(fixtureRoot, {
      provideRuntimeDll: true, provideSoxr: true
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    for (const file of ['libtwilight-soxr.dll', 'licenses/soxr-0.1.3/CMakeLists.txt',
      'licenses/soxr-0.1.3/upstream/LICENCE', 'licenses/soxr-0.1.3/upstream/src/soxr.c']) {
      assert.ok(existsSync(join(stagedDir, file)), `SoX staging omitted ${file}`)
    }
    const config = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    assert.match(config, /- libtwilight-soxr\.dll/)
    assert.match(config, /licenses\/soxr-0\.1\.3\/\*\*\/\*/)
  }
)

test(
  'Windows staging fails loudly when a toolchain runtime DLL cannot be found',
  windowsStagingOnly,
  (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'twilight-audio-runtime-missing-'))
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))

    const { result, stagedDir } = stageRuntimeDependencyFixture(fixtureRoot, {
      provideRuntimeDll: false
    })

    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /libstdc\+\+-6\.dll/)
    assert.equal(existsSync(join(stagedDir, 'libstdc++-6.dll')), false)
  }
)

test('MinGW build runner stages from its selected external build directory', () => {
  const script = readFileSync(join(__dirname, 'run-audio-engine-mingw.cjs'), 'utf8')

  assert.match(
    script,
    /\[resolve\(__dirname, 'stage-audio-engine\.cjs'\), '--build-dir', layout\.buildDir\]/
  )
})

test('MinGW build runner reuses the preflight environment for builds and tests', () => {
  const script = readFileSync(join(__dirname, 'run-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /prepareMingwCmakeEnvironment/)
  assert.match(
    script,
    /const preflight = prepareMingwCmakeEnvironment\(\{\s*buildDir: layout\.buildDir,\s*env: toolchainEnvironment\s*\}\)/
  )
  assert.match(script, /if \(!preflight\.ok\) \{[\s\S]*console\.error\(preflight\.message\)/)
  assert.match(
    script,
    /action === 'build'[\s\S]*\['cmake', \['--build', layout\.buildDir, '--parallel', String\(buildJobs\)\]\]/
  )
  assert.match(
    script,
    /action === 'test'[\s\S]*\['ctest', \['--test-dir', layout\.buildDir, '--output-on-failure'\]\]/
  )
  assert.match(
    script,
    /spawnSync\(command\[0\], command\[1\], \{[\s\S]*env: preflight\.environment/
  )
})

test('MinGW configure resets a stale cache that lost vcpkg native dependencies', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')

  assert.match(script, /function cleanInvalidNativeDependencyConfiguration\(\)/)
  assert.match(script, /validateMingwNativeDependencyConfiguration\(\{ buildDir \}\)/)
  assert.match(script, /cleanInvalidNativeDependencyConfiguration\(\)\nconst status = runCmake\(\)/)
  assert.match(script, /if \(!verifyNativeDependencies\(\)\) process\.exit\(1\)/)
})

test('MinGW configure clears CTestTestfile.cmake with other stale configure state', () => {
  const script = readFileSync(join(__dirname, 'configure-audio-engine-mingw.cjs'), 'utf8')
  const start = script.indexOf('function cleanCmakeConfigureState()')
  const end = script.indexOf('function cleanStaleCTestRegistration()')
  const cleanState = script.slice(start, end)

  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  assert.match(cleanState, /const ctestFile = join\(buildDir, 'CTestTestfile\.cmake'\)/)
  assert.match(cleanState, /rmSync\(ctestFile, \{ force: true \}\)/)
})

test('MinGW CTest validation requires every native test registration, including the performance gate', () => {
  const cmakeLists = readFileSync(join(__dirname, '..', 'audio-engine', 'CMakeLists.txt'), 'utf8')
  const registeredTests = [
    ...cmakeLists.matchAll(/add_test\(\s*NAME\s+(twilight_[a-z0-9_]+)/g)
  ].map((match) => match[1])

  assert.ok(registeredTests.length >= 44, 'native test registrations must not disappear')
  assert.ok(MINGW_EXPECTED_CTESTS.includes('twilight_convolver_unit'))
  assert.ok(MINGW_EXPECTED_CTESTS.includes('twilight_wsola_performance_gate'))
  assert.ok(MINGW_EXPECTED_CTESTS.includes('twilight_audio_performance_gate'))
  assert.ok(MINGW_EXPECTED_CTESTS.includes('twilight_audio_pcm_transparency'))
  assert.ok(MINGW_EXPECTED_CTESTS.includes('twilight_audio_flac_tail_continuation'))
  assert.ok(MINGW_EXPECTED_CTESTS.includes('twilight_audio_automix_continuation'))
  assert.deepEqual([...MINGW_EXPECTED_CTESTS].sort(), registeredTests.sort())
})

test('every native test target keeps assert() live in Release builds', () => {
  const cmakeLists = readFileSync(join(__dirname, '..', 'audio-engine', 'CMakeLists.txt'), 'utf8')

  const targetList = cmakeLists.match(/set\(TAE_TEST_TARGETS\s*([^)]*)\)/)
  assert.ok(targetList, 'audio-engine/CMakeLists.txt must declare TAE_TEST_TARGETS')
  const undebugTargets = new Set(targetList[1].split(/\s+/).filter(Boolean))

  // Release defines NDEBUG, which deletes assert() calls together with any side effects
  // inside the asserted expression. Every executable that asserts its expectations must
  // therefore opt out, or the suite silently degrades into a no-op that still reports pass.
  const ctestTargets = [
    ...cmakeLists.matchAll(
      /add_test\(\s*NAME\s+twilight_[a-z0-9_]+\s+COMMAND\s+(twilight_[a-z0-9_]+)/g
    )
  ].map((match) => match[1])

  assert.ok(ctestTargets.length >= 27)
  for (const target of ctestTargets) {
    assert.ok(undebugTargets.has(target), `${target} runs as a ctest but never clears NDEBUG`)
  }
  assert.ok(undebugTargets.has('twilight_audio_performance_gate'))
  assert.ok(undebugTargets.has('twilight_vst3_host_pressure_fixture'))

  assert.match(cmakeLists, /foreach\(tae_test_target IN LISTS TAE_TEST_TARGETS\)/)
  assert.match(cmakeLists, /target_compile_options\(\$\{tae_test_target\} PRIVATE \/UNDEBUG\)/)
  assert.match(cmakeLists, /target_compile_options\(\$\{tae_test_target\} PRIVATE -UNDEBUG\)/)
})

test('Windows release gate documents MinGW toolchain and no-whitespace build layout requirements', () => {
  const guide = readFileSync(join(__dirname, '..', 'docs', 'DEVELOPER_README.md'), 'utf8')

  for (const requirement of [
    'VCPKG_ROOT',
    'W64DEVKIT_ROOT',
    'TWILIGHT_GNU_PATCH',
    'TAE_MINGW_BUILD_DIR'
  ]) {
    assert.match(guide, new RegExp(requirement))
  }
  assert.ok(
    guide.indexOf('pnpm run configure:audio-engine:mingw') <
      guide.indexOf('pnpm run build:audio-engine:mingw')
  )
  assert.ok(
    guide.indexOf('pnpm run build:audio-engine:mingw') <
      guide.indexOf('pnpm run test:audio-engine:mingw')
  )
})

test('caps MinGW compile parallelism by available memory rather than core count', () => {
  const gib = 1024 * 1024 * 1024

  // A high-core / low-memory host is what makes cc1plus die with
  // "out of memory allocating N bytes". 20 cores against 8 GiB must not
  // dispatch 20 concurrent -O3 compiles.
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 8 * gib, cpuCount: 20 }), 7)

  // When memory is plentiful the core count is the limit.
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 128 * gib, cpuCount: 8 }), 8)

  // Never drop below a single job, however constrained the host is.
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 1 * gib, cpuCount: 16 }), 1)
  assert.equal(resolveMingwBuildJobs({ env: {}, totalMemoryBytes: 0, cpuCount: 4 }), 4)

  // An explicit override wins over both heuristics.
  assert.equal(
    resolveMingwBuildJobs({
      env: { TAE_MINGW_BUILD_JOBS: '3' },
      totalMemoryBytes: 128 * gib,
      cpuCount: 32
    }),
    3
  )
  assert.equal(
    resolveMingwBuildJobs({
      env: { TAE_MINGW_BUILD_JOBS: 'not-a-number' },
      totalMemoryBytes: 8 * gib,
      cpuCount: 20
    }),
    7
  )
})

test('miniaudio vendoring stays pinned, private, and single-TU', () => {
  const root = join(__dirname, '..')
  const miniaudioRoot = join(root, 'audio-engine', 'third_party', 'miniaudio')
  const expectedHashes = new Map([
    ['miniaudio.h', 'ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89'],
    ['miniaudio.c', 'ab1984bb9804ffd7b0303813595d0b345a8a86c34da1daffc353a14b34102a65'],
    ['LICENSE', '542a5d4b0947d7d9083f75c454409edbac531527dd41cccaa918ce9d33a1d05c']
  ])

  for (const [file, expectedHash] of expectedHashes) {
    const data = readFileSync(join(miniaudioRoot, file))
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), expectedHash)
  }

  const header = readFileSync(join(miniaudioRoot, 'miniaudio.h'), 'utf8')
  assert.match(header, /miniaudio - v0\.11\.25/)
  assert.match(header, /#define MA_VERSION_MAJOR\s+0/)
  assert.match(header, /#define MA_VERSION_MINOR\s+11/)
  assert.match(header, /#define MA_VERSION_REVISION\s+25/)

  const license = readFileSync(join(miniaudioRoot, 'LICENSE'), 'utf8')
  const provenance = readFileSync(join(miniaudioRoot, 'PROVENANCE.md'), 'utf8')
  assert.match(license, /ALTERNATIVE 2 - MIT No Attribution/)
  assert.match(provenance, /MIT No Attribution \(MIT-0\)/)
  assert.match(provenance, /9634bedb5b5a2ca38c1ee7108a9358a4e233f14d/)

  const cmake = readFileSync(join(root, 'audio-engine', 'CMakeLists.txt'), 'utf8')
  const presets = readFileSync(join(root, 'audio-engine', 'CMakePresets.json'), 'utf8')
  const stagingScript = readFileSync(join(root, 'scripts', 'stage-audio-engine.cjs'), 'utf8')
  assert.match(cmake, /option\(TAE_ENABLE_MINIAUDIO .* OFF\)/)
  assert.match(cmake, /set\(TAE_DEFAULT_PCM_PROVIDER "legacy" CACHE STRING/)
  assert.match(cmake, /TAE_DEFAULT_PCM_PROVIDER_MINIAUDIO/)
  assert.match(presets, /"TAE_ENABLE_MINIAUDIO"\s*:\s*"ON"/)
  assert.match(presets, /"TAE_DEFAULT_PCM_PROVIDER"\s*:\s*"legacy"/)
  assert.match(
    cmake,
    /target_sources\(twilight_audio_engine PRIVATE output\/miniaudio\/MiniaudioImplementation\.cpp\)/
  )
  assert.match(
    cmake,
    /target_include_directories\(twilight_audio_engine PRIVATE \$\{CMAKE_CURRENT_SOURCE_DIR\}\/third_party\/miniaudio\)/
  )
  assert.doesNotMatch(cmake, /PUBLIC[^\n]*third_party\/miniaudio/)
  assert.doesNotMatch(
    stagingScript,
    /third_party[\\/]+miniaudio|MiniaudioImplementation|miniaudio\.(?:h|c)/
  )

  const implementation = readFileSync(
    join(root, 'audio-engine', 'output', 'miniaudio', 'MiniaudioImplementation.cpp'),
    'utf8'
  )
  assert.match(implementation, /#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS/)
  assert.match(implementation, /#define MA_ENABLE_WASAPI/)
  assert.match(implementation, /#define MA_NO_DECODING/)
  assert.match(implementation, /#define MA_NO_ENCODING/)
  assert.match(implementation, /#define MA_NO_RESOURCE_MANAGER/)
  assert.match(implementation, /#define MA_NO_NODE_GRAPH/)
  assert.match(implementation, /#define MA_NO_ENGINE/)
  assert.match(implementation, /#define MA_NO_GENERATION/)
  assert.match(implementation, /#include "\.\.\/\.\.\/third_party\/miniaudio\/miniaudio\.c"/)

  const implementationIncludes = listRepositoryFiles(join(root, 'audio-engine'))
    .filter((file) => !file.replaceAll('\\', '/').includes('/third_party/miniaudio/'))
    .filter((file) => /\.(?:c|cc|cpp|cxx|h|hpp)$/.test(file))
    .filter((file) => readFileSync(file, 'utf8').includes('third_party/miniaudio/miniaudio.c'))
  assert.deepEqual(
    implementationIncludes.map((file) => file.replaceAll('\\', '/')),
    [
      join(root, 'audio-engine', 'output', 'miniaudio', 'MiniaudioImplementation.cpp').replaceAll(
        '\\',
        '/'
      )
    ]
  )
})

function listRepositoryFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) return listRepositoryFiles(entryPath)
    return [entryPath]
  })
}


test('ASIO Win32 helper selects x86 compiler and libraries without changing the x64 default', () => {
  const result = prepareAsioMsvcNinjaToolchain({
    arch: 'x86',
    env: { TAE_ASIO_MSVC_INSTALL_ROOT: fixturePath('vs'), VCToolsVersion: '14.44',
      WindowsSdkDir: fixturePath('sdk'), WindowsSDKVersion: '10.0', PATH: '' },
    exists: () => true,
    readDirectories: () => [{ name: '14.44', isDirectory: () => true }]
  })
  assert.equal(result.ok, true)
  assert.ok(cmakeCachePath(result.environment.CXX).endsWith('/Hostx64/x86/cl.exe'))
  assert.ok(cmakeCachePath(result.environment.LIB).includes('/lib/x86'))
  assert.ok(!cmakeCachePath(result.environment.LIB).includes('/lib/x64'))
  assert.equal(prepareAsioMsvcNinjaToolchain({ arch: 'arm64' }).ok, false)
})
