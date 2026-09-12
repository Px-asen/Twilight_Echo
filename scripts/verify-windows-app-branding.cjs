const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_EXECUTABLE_NAME = 'TwilightEcho.exe'
const DEFAULT_PRODUCT_NAME = 'TwilightEcho'

function parseArgs(argv) {
  const index = argv.indexOf('--app-dir')
  if (index < 0 || !argv[index + 1]) throw new Error('--app-dir is required')
  if (argv.length !== 2) throw new Error('Only --app-dir is supported')
  return { appDir: argv[index + 1] }
}

function readWindowsExecutableMetadata(filePath, run = execFileSync) {
  const script = [
    `$filePath = '${path.resolve(filePath).replace(/'/g, "''")}'`,
    '$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($filePath)',
    '[PSCustomObject]@{',
    'fileDescription = [string]$info.FileDescription;',
    'productName = [string]$info.ProductName;',
    'internalName = [string]$info.InternalName;',
    'originalFilename = [string]$info.OriginalFilename;',
    'companyName = [string]$info.CompanyName',
    '} | ConvertTo-Json -Compress'
  ].join('\n')
  const output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  })
  return JSON.parse(String(output).trim())
}

function assertWindowsExecutableBranding(filePath, readMetadata = readWindowsExecutableMetadata) {
  const executable = path.resolve(filePath)
  assert.ok(fs.existsSync(executable), `Windows executable does not exist: ${executable}`)
  assert.equal(path.basename(executable), DEFAULT_EXECUTABLE_NAME)
  const metadata = readMetadata(executable)
  assert.equal(
    metadata.fileDescription,
    DEFAULT_PRODUCT_NAME,
    `FileDescription must be ${DEFAULT_PRODUCT_NAME}, found "${metadata.fileDescription}"`
  )
  assert.equal(
    metadata.productName,
    DEFAULT_PRODUCT_NAME,
    `ProductName must be ${DEFAULT_PRODUCT_NAME}, found "${metadata.productName}"`
  )
  assert.equal(
    metadata.internalName,
    DEFAULT_PRODUCT_NAME,
    `InternalName must be ${DEFAULT_PRODUCT_NAME}, found "${metadata.internalName}"`
  )
  assert.equal(
    metadata.originalFilename,
    DEFAULT_EXECUTABLE_NAME,
    `OriginalFilename must be ${DEFAULT_EXECUTABLE_NAME}, found "${metadata.originalFilename}"`
  )
  assert.ok(metadata.companyName, 'CompanyName is missing from the Windows executable')
  return metadata
}

function assertWindowsExecutableIcon(filePath, iconPath) {
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
  const executable = NtExecutable.from(fs.readFileSync(filePath), { ignoreCert: true })
  const entries = NtExecutableResource.from(executable).entries
  const groups = Resource.IconGroupEntry.fromEntries(entries)
  const icon = fs.readFileSync(iconPath)
  assert.equal(icon.readUInt16LE(2), 1, 'Expected ICO source')
  const expected = Array.from({ length: icon.readUInt16LE(4) }, (_, index) => {
    const offset = 6 + index * 16
    const start = icon.readUInt32LE(offset + 12)
    return icon.subarray(start, start + icon.readUInt32LE(offset + 8))
  })
  assert.ok(groups.length, 'Windows executable has no icon group')
  for (const group of groups) {
    const actual = group.icons.map((item) => {
      const entry = entries.find(
        (entry) => entry.type === 3 && entry.id === item.iconID && entry.lang === group.lang
      )
      assert.ok(entry, 'Windows icon group references a missing image')
      return Buffer.from(entry.bin)
    })
    assert.equal(actual.length, expected.length, 'Windows executable icon sizes differ from source')
    assert.ok(
      expected.every((image) => actual.some((value) => value.equals(image))),
      'Windows executable contains a stale icon'
    )
  }
}

function verifyWindowsAppBranding(appDir) {
  const executable = path.join(path.resolve(appDir), DEFAULT_EXECUTABLE_NAME)
  const metadata = assertWindowsExecutableBranding(executable)
  const source = path.join(__dirname, '..', 'build', 'icon.ico')
  assertWindowsExecutableIcon(executable, source)
  assert.ok(
    fs.readFileSync(path.join(appDir, 'resources', 'icon.ico')).equals(fs.readFileSync(source)),
    'Packaged window icon differs from source'
  )
  return metadata
}

if (require.main === module) {
  try {
    const result = verifyWindowsAppBranding(parseArgs(process.argv.slice(2)).appDir)
    console.log(`Windows executable branding verified: ${result.productName}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

module.exports = {
  assertWindowsExecutableIcon,
  DEFAULT_EXECUTABLE_NAME,
  DEFAULT_PRODUCT_NAME,
  assertWindowsExecutableBranding,
  parseArgs,
  readWindowsExecutableMetadata,
  verifyWindowsAppBranding
}
