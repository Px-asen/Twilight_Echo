const { existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { spawnSync: childProcessSpawnSync } = require('node:child_process')
const { resolveWindowsPersistedEnvironment } = require('./windows-persisted-environment.cjs')

const PERSISTED_ASIO_MSVC_VARIABLES = ['TAE_ASIO_MSVC_INSTALL_ROOT', 'TAE_ASIO_MSVC_BUILD_DIR']

function resolveAsioMsvcEnvironment({ env = process.env, spawnSync = childProcessSpawnSync } = {}) {
  const resolved = resolveWindowsPersistedEnvironment({
    env,
    names: PERSISTED_ASIO_MSVC_VARIABLES,
    spawnSync
  })
  if (process.platform !== 'win32') return resolved
  if (!resolved.TAE_ASIO_MSVC_INSTALL_ROOT && resolved.TAE_VST3_MSVC_INSTALL_ROOT) {
    resolved.TAE_ASIO_MSVC_INSTALL_ROOT = resolved.TAE_VST3_MSVC_INSTALL_ROOT
  }
  return resolved
}

function resolveAsioMsvcBuildDirectory(env = process.env, root = process.cwd()) {
  return env.TAE_ASIO_MSVC_BUILD_DIR
    ? resolve(env.TAE_ASIO_MSVC_BUILD_DIR)
    : join(resolve(root), 'audio-engine', 'build', 'asio-msvc-ninja-x64')
}

function latestVersionDirectory(root, readDirectories = readdirSync) {
  try {
    return readDirectories(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0]
  } catch {
    return undefined
  }
}

function normalizeVersion(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/]+$/, '')
}

function cmakeCachePath(value) {
  return String(value ?? '').replaceAll('\\', '/')
}

function prepareAsioMsvcNinjaToolchain({
  arch = 'x64',
  env = process.env,
  exists = existsSync,
  readDirectories = readdirSync
} = {}) {
  if (!['x64', 'x86'].includes(arch)) return { ok: false, message: `Unsupported ASIO helper architecture: ${arch}` }
  const validation = validateAsioMsvcToolchain({ env, exists, readDirectories })
  if (!validation.ok) return validation

  const installRoot = validation.installRoot
  const msvcRoot = join(installRoot, 'VC', 'Tools', 'MSVC')
  const msvcVersion =
    normalizeVersion(env.VCToolsVersion) || latestVersionDirectory(msvcRoot, readDirectories)
  const programFilesX86 = env['ProgramFiles(x86)'] || env.ProgramFiles || 'C:\\Program Files (x86)'
  const windowsSdkRoot = resolve(env.WindowsSdkDir || join(programFilesX86, 'Windows Kits', '10'))
  const sdkVersion =
    normalizeVersion(env.WindowsSDKVersion) ||
    latestVersionDirectory(join(windowsSdkRoot, 'Include'), readDirectories)
  const toolsetRoot = msvcVersion ? join(msvcRoot, msvcVersion) : ''
  const sdkBin = sdkVersion ? join(windowsSdkRoot, 'bin', sdkVersion, 'x64') : ''
  const cmakePath = join(
    installRoot,
    'Common7',
    'IDE',
    'CommonExtensions',
    'Microsoft',
    'CMake',
    'CMake',
    'bin',
    'cmake.exe'
  )
  const ninjaPath = join(
    installRoot,
    'Common7',
    'IDE',
    'CommonExtensions',
    'Microsoft',
    'CMake',
    'Ninja',
    'ninja.exe'
  )
  const compilerBin = toolsetRoot ? join(toolsetRoot, 'bin', 'Hostx64', arch) : ''
  const required = [
    [`MSVC ${arch} compiler`, compilerBin && join(compilerBin, 'cl.exe')],
    [`MSVC ${arch} linker`, compilerBin && join(compilerBin, 'link.exe')],
    ['MSVC standard library headers', toolsetRoot && join(toolsetRoot, 'include', 'cstddef')],
    [`MSVC ${arch} runtime libraries`, toolsetRoot && join(toolsetRoot, 'lib', arch, 'msvcrt.lib')],
    ['Visual Studio CMake', cmakePath],
    ['Visual Studio Ninja', ninjaPath],
    ['Windows SDK resource compiler', sdkBin && join(sdkBin, 'rc.exe')],
    ['Windows SDK manifest tool', sdkBin && join(sdkBin, 'mt.exe')],
    [
      'Windows SDK headers',
      sdkVersion && join(windowsSdkRoot, 'Include', sdkVersion, 'um', 'Windows.h')
    ],
    [
      `Windows SDK ${arch} libraries`,
      sdkVersion && join(windowsSdkRoot, 'Lib', sdkVersion, 'um', arch, 'kernel32.lib')
    ]
  ]
  const missing = required.filter(([, path]) => !path || !exists(path))
  if (missing.length > 0) {
    return {
      ok: false,
      installRoot,
      message: `ASIO MSVC Ninja preflight failed:\n${missing
        .map(([label, path]) => `- ${label}: ${path || 'not resolved'}`)
        .join('\n')}`
    }
  }

  const includeDirectories = [
    join(toolsetRoot, 'include'),
    join(windowsSdkRoot, 'Include', sdkVersion, 'ucrt'),
    join(windowsSdkRoot, 'Include', sdkVersion, 'shared'),
    join(windowsSdkRoot, 'Include', sdkVersion, 'um'),
    join(windowsSdkRoot, 'Include', sdkVersion, 'winrt'),
    join(windowsSdkRoot, 'Include', sdkVersion, 'cppwinrt')
  ].filter((path) => exists(path))
  const libraryDirectories = [
    join(toolsetRoot, 'lib', arch),
    join(windowsSdkRoot, 'Lib', sdkVersion, 'ucrt', arch),
    join(windowsSdkRoot, 'Lib', sdkVersion, 'um', arch)
  ].filter((path) => exists(path))
  const libraryPathDirectories = [
    join(toolsetRoot, 'lib', arch),
    join(windowsSdkRoot, 'UnionMetadata', sdkVersion),
    join(windowsSdkRoot, 'References', sdkVersion)
  ].filter((path) => exists(path))
  const existingPath = env.PATH || env.Path || ''
  const environment = {
    ...env,
    PATH: [compilerBin, sdkBin, existingPath].filter(Boolean).join(';'),
    INCLUDE: includeDirectories.join(';'),
    LIB: libraryDirectories.join(';'),
    LIBPATH: libraryPathDirectories.join(';'),
    CC: join(compilerBin, 'cl.exe'),
    CXX: join(compilerBin, 'cl.exe')
  }
  delete environment.Path

  return {
    ok: true,
    message: '',
    installRoot,
    msvcVersion,
    sdkVersion,
    cmakePath,
    ninjaPath,
    rcPath: join(sdkBin, 'rc.exe'),
    environment
  }
}

function validateAsioMsvcToolchain({
  env = process.env,
  exists = existsSync,
  readDirectories = readdirSync
} = {}) {
  const installRoot = env.TAE_ASIO_MSVC_INSTALL_ROOT ? resolve(env.TAE_ASIO_MSVC_INSTALL_ROOT) : ''
  const missing = []
  if (!installRoot || !exists(join(installRoot, 'Common7', 'Tools', 'VsDevCmd.bat'))) {
    missing.push('TAE_ASIO_MSVC_INSTALL_ROOT must point to a VS 2022 Build Tools installation')
  } else {
    const toolsetRoot = join(installRoot, 'VC', 'Tools', 'MSVC')
    const hasToolset =
      exists(toolsetRoot) &&
      readDirectories(toolsetRoot, { withFileTypes: true }).some((entry) => entry.isDirectory())
    if (!hasToolset) missing.push(`No MSVC toolset found under ${toolsetRoot}.`)
  }
  return missing.length === 0
    ? { ok: true, message: '', installRoot }
    : {
        ok: false,
        message: `ASIO MSVC toolchain preflight failed:\n- ${missing.join('\n- ')}`,
        installRoot
      }
}

module.exports = {
  cmakeCachePath,
  prepareAsioMsvcNinjaToolchain,
  resolveAsioMsvcBuildDirectory,
  resolveAsioMsvcEnvironment,
  validateAsioMsvcToolchain
}
