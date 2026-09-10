const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  DEFAULT_EXECUTABLE_NAME,
  DEFAULT_PRODUCT_NAME,
  assertWindowsExecutableBranding,
  parseArgs,
  readWindowsExecutableMetadata
} = require('./verify-windows-app-branding.cjs')

test('Windows executable branding requires the product executable and its metadata', () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-app-branding-'))
  try {
    const executable = path.join(appDir, DEFAULT_EXECUTABLE_NAME)
    fs.writeFileSync(executable, '')
    const metadata = assertWindowsExecutableBranding(executable, () => ({
      fileDescription: DEFAULT_PRODUCT_NAME,
      productName: DEFAULT_PRODUCT_NAME,
      internalName: DEFAULT_PRODUCT_NAME,
      originalFilename: DEFAULT_EXECUTABLE_NAME,
      companyName: 'Pxasen.com'
    }))
    assert.equal(metadata.productName, DEFAULT_PRODUCT_NAME)
    assert.throws(
      () =>
        assertWindowsExecutableBranding(executable, () => ({
          fileDescription: 'Electron',
          productName: 'Electron',
          internalName: 'Electron',
          originalFilename: 'electron.exe',
          companyName: ''
        })),
      /TwilightEcho/
    )
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true })
  }
})

test('Windows executable branding CLI requires exactly one app directory', () => {
  assert.throws(() => parseArgs([]), /--app-dir is required/)
  assert.deepEqual(parseArgs(['--app-dir', 'dist/win-unpacked']), {
    appDir: 'dist/win-unpacked'
  })
  assert.throws(() => parseArgs(['--app-dir', 'dist/win-unpacked', '--extra']), /Only --app-dir/)
})

test('Windows metadata reader sends PowerShell a valid hashtable script', () => {
  let invocation
  const metadata = readWindowsExecutableMetadata("dist/O'Brien/TwilightEcho.exe", (...args) => {
    invocation = args
    return JSON.stringify({
      fileDescription: DEFAULT_PRODUCT_NAME,
      productName: DEFAULT_PRODUCT_NAME,
      internalName: DEFAULT_PRODUCT_NAME,
      originalFilename: DEFAULT_EXECUTABLE_NAME,
      companyName: 'Pxasen.com'
    })
  })
  const script = invocation[1][3]
  assert.equal(metadata.productName, DEFAULT_PRODUCT_NAME)
  assert.equal(invocation[1].length, 4)
  assert.match(script, /\$filePath = '.*O''Brien.*TwilightEcho\.exe'/)
  assert.match(script, /\[PSCustomObject\]@\{\nfileDescription/)
  assert.doesNotMatch(script, /@\{;/)
  assert.doesNotMatch(script, /;;/)
})

test('EXE icon verification rejects old resources and accepts every current ICO size', () => {
  const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit')
  const { assertWindowsExecutableIcon } = require('./verify-windows-app-branding.cjs')
  const root = path.resolve(__dirname, '..')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-icon-check-'))
  try {
    const executablePath = path.join(directory, 'fixture.exe')
    const executable = NtExecutable.createEmpty(false, false)
    const resources = NtExecutableResource.from(executable)
    const iconPath = path.join(root, 'build', 'icon.ico')
    const icons = Data.IconFile.from(fs.readFileSync(iconPath)).icons.map((item) => item.data)
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icons)
    resources.outputResource(executable)
    fs.writeFileSync(executablePath, Buffer.from(executable.generate()))
    assert.doesNotThrow(() => assertWindowsExecutableIcon(executablePath, iconPath))
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icons.slice(0, 1))
    resources.outputResource(executable)
    fs.writeFileSync(executablePath, Buffer.from(executable.generate()))
    assert.throws(() => assertWindowsExecutableIcon(executablePath, iconPath), /icon sizes differ/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('installer refreshes existing shortcut icons without losing app identity', () => {
  const root = path.resolve(__dirname, '..')
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
  const hook = fs.readFileSync(path.join(root, 'scripts', 'installer.nsh'), 'utf8')
  assert.match(builder, /include: scripts\/installer\.nsh/)
  assert.match(hook, /app-icon-\$\{VERSION\}\.ico/)
  for (const link of ['newStartMenuLink', 'newDesktopLink']) {
    assert.ok(hook.includes('${if} ${FileExists} "$' + link + '"'))
    assert.ok(hook.includes('WinShell::SetLnkAUMI "$' + link + '" "${APP_ID}"'))
  }
  assert.match(hook, /SHChangeNotify/)
})
