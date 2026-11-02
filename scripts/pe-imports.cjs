const fs = require('node:fs')
const path = require('node:path')

// PE import parsing shared by audio-engine staging (which has to copy the
// toolchain runtime DLLs next to the addon) and the Windows release gate (which
// has to prove they were copied). Both sides derive the dependency list from the
// binaries themselves: a hand-maintained name list silently rots the moment the
// MinGW toolchain changes its threading model, and the runtime symptom of a
// missing DLL is an opaque "未加载 twilight_audio_node.node" that says nothing
// about which file is absent.

const API_SET_PREFIXES = Object.freeze(['api-ms-win-', 'ext-ms-win-'])

// Imports matching these must ship beside the importer. This is deliberately a
// positive rule rather than a system-DLL denylist: an OS DLL we forgot to
// enumerate can then never fail the release gate. GNU toolchain runtimes
// (libstdc++-6, libgcc_s_seh-1, libmcfgthread-2, libwinpthread-1) and vcpkg
// output all use the lib* convention; twilight* is our own build output.
const BUNDLED_IMPORT_PATTERNS = Object.freeze([/^lib/i, /^twilight/i])

function parsePeLayout(buffer, filePath) {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`${filePath} is not a PE binary`)
  }
  const peOffset = buffer.readUInt32LE(0x3c)
  if (
    peOffset + 24 > buffer.length ||
    buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
  ) {
    throw new Error(`${filePath} has an invalid PE header`)
  }
  const coffOffset = peOffset + 4
  const sectionCount = buffer.readUInt16LE(coffOffset + 2)
  const optionalSize = buffer.readUInt16LE(coffOffset + 16)
  const optionalOffset = coffOffset + 20
  if (optionalOffset + optionalSize > buffer.length || optionalSize < 96) {
    throw new Error(`${filePath} has a truncated PE optional header`)
  }
  const magic = buffer.readUInt16LE(optionalOffset)
  if (![0x10b, 0x20b].includes(magic)) {
    throw new Error(`${filePath} has an unsupported PE optional header`)
  }
  const dataDirectoryOffset = optionalOffset + (magic === 0x20b ? 112 : 96)
  if (dataDirectoryOffset + 16 > optionalOffset + optionalSize) {
    throw new Error(`${filePath} has a truncated PE data directory`)
  }
  const sectionTableOffset = optionalOffset + optionalSize
  if (sectionTableOffset + sectionCount * 40 > buffer.length) {
    throw new Error(`${filePath} has a truncated PE section table`)
  }
  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20)
    })
  }
  return { dataDirectoryOffset, sections, machine: buffer.readUInt16LE(coffOffset) }
}

function readPeMachine(filePath) {
  return parsePeLayout(fs.readFileSync(filePath), filePath).machine
}

function rvaToOffset(sections, rva) {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize)
    if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
      return section.rawOffset + (rva - section.virtualAddress)
    }
  }
  return null
}

function readCString(buffer, offset) {
  if (offset === null || offset < 0 || offset >= buffer.length) return ''
  const end = buffer.indexOf(0, offset)
  return buffer.toString('latin1', offset, end === -1 ? buffer.length : end)
}

/** DLL names in the import directory of a PE binary, deduplicated. */
function readPeImports(filePath) {
  const buffer = fs.readFileSync(filePath)
  const { dataDirectoryOffset, sections } = parsePeLayout(buffer, filePath)
  const importRva = buffer.readUInt32LE(dataDirectoryOffset + 8)
  const importSize = buffer.readUInt32LE(dataDirectoryOffset + 12)
  if (importRva === 0 || importSize === 0) return []
  let cursor = rvaToOffset(sections, importRva)
  if (cursor === null) throw new Error(`${filePath} has an unreadable import directory`)
  const names = []
  // IMAGE_IMPORT_DESCRIPTOR is 20 bytes and the table ends on an all-zero entry.
  while (cursor + 20 <= buffer.length) {
    const originalFirstThunk = buffer.readUInt32LE(cursor)
    const nameRva = buffer.readUInt32LE(cursor + 12)
    const firstThunk = buffer.readUInt32LE(cursor + 16)
    if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break
    const name = readCString(buffer, rvaToOffset(sections, nameRva))
    if (name) names.push(name)
    cursor += 20
  }
  return [...new Set(names)]
}

function isApiSetImport(name) {
  const lower = name.toLowerCase()
  return API_SET_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function matchesBundledConvention(name) {
  return BUNDLED_IMPORT_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Split imports into the ones that must ship beside the binary and the ones the
 * OS provides. When systemRoot is unavailable the classification falls back to
 * the naming conventions alone, so an unrecognised import is treated as a system
 * DLL rather than failing a release over a guess.
 */
function classifyImports(names, options = {}) {
  const systemRoot = options.systemRoot ?? (process.env.SystemRoot || process.env.windir || '')
  const exists = options.exists ?? fs.existsSync
  const bundled = []
  const system = []
  for (const name of names) {
    if (isApiSetImport(name)) {
      system.push(name)
      continue
    }
    if (matchesBundledConvention(name)) {
      bundled.push(name)
      continue
    }
    if (systemRoot && !exists(path.join(systemRoot, options.systemDirectory || 'System32', name))) {
      bundled.push(name)
      continue
    }
    system.push(name)
  }
  return { bundled, system }
}

/**
 * Walk the bundled-import graph starting at entryFiles.
 *
 * resolveDependency(name, importer) returns an absolute path for a dependency
 * that is available, or a falsy value when it is not. Staging points it at the
 * toolchain bin directory so it can copy what is missing; the release gate
 * points it at the packaged directory only, so anything unresolved is a defect.
 */
function collectImportClosure(entryFiles, resolveDependency, options = {}) {
  const dependencies = new Map()
  const missing = new Map()
  const visited = new Set()
  const queue = [...entryFiles]
  while (queue.length > 0) {
    const filePath = queue.shift()
    const key = filePath.toLowerCase()
    if (visited.has(key)) continue
    visited.add(key)
    const { bundled } = classifyImports(readPeImports(filePath), options)
    for (const name of bundled) {
      const nameKey = name.toLowerCase()
      if (dependencies.has(nameKey)) continue
      const resolved = resolveDependency(name, filePath)
      if (!resolved) {
        const importers = missing.get(nameKey) ?? { name, importers: [] }
        importers.importers.push(filePath)
        missing.set(nameKey, importers)
        continue
      }
      dependencies.set(nameKey, { name, path: resolved })
      queue.push(resolved)
    }
  }
  return {
    inspected: [...visited],
    dependencies: [...dependencies.values()],
    missing: [...missing.values()]
  }
}

module.exports = {
  API_SET_PREFIXES,
  BUNDLED_IMPORT_PATTERNS,
  classifyImports,
  collectImportClosure,
  isApiSetImport,
  matchesBundledConvention,
  readPeImports,
  readPeMachine
}
