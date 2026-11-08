const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { archiveRoot } = require('./diagnostic-symbols.cjs')
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const id = option('--artifact')
if (!/^[a-f0-9]{64}$/.test(id || ''))
  throw new Error(
    'Usage: --artifact <shipped SHA-256> --offset <module RVA> [--addr2line <tool>] OR --artifact <JS SHA-256> --line <line> --column <column>'
  )
const root = archiveRoot()
if (args.includes('--line')) {
  const { createRequire } = require('node:module')
  const requireVite = createRequire(require.resolve('vite/package.json'))
  const { TraceMap, originalPositionFor } = requireVite('@jridgewell/trace-mapping')
  const dir = path.join(root, id),
    map = fs.readdirSync(dir).find((name) => name.endsWith('.map'))
  console.log(
    originalPositionFor(new TraceMap(JSON.parse(fs.readFileSync(path.join(dir, map), 'utf8'))), {
      line: Number(option('--line')),
      column: Number(option('--column') || 1) - 1
    })
  )
} else {
  const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))
  const symbols = index[id]
  if (!symbols) throw new Error('No symbols match this shipped artifact')
  const rva = option('--offset')
  if (!/^(?:0x)?[0-9a-f]+$/i.test(rva || '')) throw new Error('Invalid module offset')
  const directory = path.join(root, symbols.artifactId)
  const binary = path.join(directory, symbols.binary)
  if (symbols.dsym) {
    const dwarf = path.join(
      directory,
      symbols.dsym,
      'Contents',
      'Resources',
      'DWARF',
      symbols.binary
    )
    const result = spawnSync('atos', ['-o', dwarf, '-l', '0x0', rva], { encoding: 'utf8' })
    if (result.error) throw result.error
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.status ?? 1
  } else if (symbols.pdbs.length) {
    const helper = path.resolve('resources/audio-engine/twilight-crash-helper.exe')
    const result = spawnSync(
      helper,
      ['--symbolize', binary, '--offset', rva, '--symbols', directory],
      { encoding: 'utf8', windowsHide: true }
    )
    process.stdout.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    process.exitCode = result.status ?? 1
  } else {
    const data = fs.readFileSync(binary)
    let address = BigInt(rva.startsWith('0x') ? rva : `0x${rva}`)
    if (data.toString('ascii', 0, 2) === 'MZ') {
      const optional = data.readUInt32LE(0x3c) + 24
      address +=
        data.readUInt16LE(optional) === 0x20b
          ? data.readBigUInt64LE(optional + 24)
          : BigInt(data.readUInt32LE(optional + 28))
    }
    const tool = args.includes('--addr2line') ? option('--addr2line') : 'addr2line'
    const result = spawnSync(
      tool,
      [
        '-f',
        '-C',
        '-e',
        path.join(directory, symbols.debug || symbols.binary),
        `0x${address.toString(16)}`
      ],
      { encoding: 'utf8', windowsHide: true }
    )
    if (result.error) throw result.error
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.status ?? 1
  }
}
