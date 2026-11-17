const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  'out',
  'output',
  'outputs',
  'tmp',
  'temp'
])
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cmake',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.json',
  '.md',
  '.mjs',
  '.cjs',
  '.yml',
  '.yaml'
])
const FORBIDDEN_PATHS = [
  /(^|\/)third_party\/ASIOSDK(?:\/|$)/i,
  /(^|\/)ASIOSDK(?:\/|$)/i,
  /(^|\/)asiosys\.h$/i,
  /(^|\/)asiodrivers\.h$/i,
  /(^|\/)asiodrivers\.cpp$/i,
  /(^|\/)asiolist\.cpp$/i
]
const FORBIDDEN_CONTENT = [/#\s*include\s*[<"](?:asio|asiosys|asiodrivers)\.h[>"]/i, /\bASIOSDK\b/i]

function shouldRead(path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  return TEXT_EXTENSIONS.has(extension)
}

function collectFiles(root, directory = root, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const isHiddenLocal = entry.name.startsWith('.') && entry.name !== '.github'
      if (!isHiddenLocal && !IGNORED_DIRECTORIES.has(entry.name))
        collectFiles(root, join(directory, entry.name), result)
      continue
    }
    if (entry.isFile()) result.push(join(directory, entry.name))
  }
  return result
}

function findForbiddenAsioSdkReferences(root, files = collectFiles(root)) {
  const findings = []
  for (const path of files) {
    const repositoryPath = relative(root, path).replaceAll('\\', '/')
    if (repositoryPath.startsWith('scripts/verify-asio-sdk-free')) continue
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(repositoryPath))) {
      findings.push(`forbidden SDK path: ${repositoryPath}`)
      continue
    }
    if (!shouldRead(path)) continue
    const content = readFileSync(path, 'utf8')
    if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(content))) {
      findings.push(`forbidden SDK reference: ${repositoryPath}`)
    }
  }
  return findings
}

function findForbiddenAsioSdkHistory(root, spawn = spawnSync) {
  const result = spawn(
    'git',
    ['-c', `safe.directory=${resolve(root)}`, 'log', '--all', '--name-only', '--format='],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true
    }
  )
  if (result?.error || result?.status !== 0) {
    return [
      `unable to inspect Git history: ${result?.error?.message || `git exited ${result?.status ?? 'unknown'}`}`
    ]
  }
  const paths = String(result.stdout || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  return paths
    .filter((path) => FORBIDDEN_PATHS.some((pattern) => pattern.test(path.replaceAll('\\', '/'))))
    .map((path) => `forbidden SDK path in Git history: ${path}`)
}

function verifyAsioSdkFree(root, { includeHistory = true } = {}) {
  if (!existsSync(root)) return { ok: false, findings: [`repository root is missing: ${root}`] }
  const findings = findForbiddenAsioSdkReferences(root)
  if (includeHistory) findings.push(...findForbiddenAsioSdkHistory(root))
  return { ok: findings.length === 0, findings }
}

if (require.main === module) {
  const root = resolve(__dirname, '..')
  const result = verifyAsioSdkFree(root)
  if (!result.ok) {
    console.error(`ASIO SDK removal gate failed:\n- ${result.findings.join('\n- ')}`)
    process.exit(1)
  }
}

module.exports = {
  FORBIDDEN_CONTENT,
  FORBIDDEN_PATHS,
  IGNORED_DIRECTORIES,
  findForbiddenAsioSdkHistory,
  findForbiddenAsioSdkReferences,
  verifyAsioSdkFree
}
