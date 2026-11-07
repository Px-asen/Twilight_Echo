'use strict'
const { mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream } = require('node:fs')
const { resolve, join } = require('node:path')
const { spawn } = require('node:child_process')
const { freemem, totalmem, cpus } = require('node:os')

function parseArgs(args) {
  const options = {
    buildRoot: resolve(__dirname, '..'),
    output: resolve('.artifacts/memory-' + Date.now()),
    sizes: [1057, 10000, 100000],
    runs: 3,
    cycles: 50,
    soakSeconds: 1800,
    settleSeconds: 120,
    minFreeBytes: 1024 ** 3
  }
  const numbers = {
    '--runs': 'runs',
    '--cycles': 'cycles',
    '--soak-seconds': 'soakSeconds',
    '--settle-seconds': 'settleSeconds'
  }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--') continue
    if (key === '--help') return { help: true }
    if (key === '--diagnostic-no-sandbox') {
      options.diagnosticNoSandbox = true
      continue
    }
    const value = args[++i]
    if (!value) throw Error(`Missing value for ${key}`)
    if (key === '--build-root') options.buildRoot = resolve(value)
    else if (key === '--output') options.output = resolve(value)
    else if (key === '--sizes') options.sizes = value.split(',').map(Number)
    else if (numbers[key]) options[numbers[key]] = Number(value)
    else throw Error(`Unknown option ${key}`)
  }
  for (const n of [
    ...options.sizes,
    options.runs,
    options.cycles,
    options.soakSeconds,
    options.settleSeconds
  ])
    if (!Number.isSafeInteger(n) || n < 1)
      throw Error('Sizes, counts and durations must be positive integers')
  return options
}
const percentile = (values, q) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)]
    : null
const STEADY_PHASES = [
  'idle',
  'playing',
  'bulk-favorites',
  'navigation',
  'streaming',
  'player-dsp',
  'returned-idle',
  'soak',
  'afterglow',
  'restored'
]
function acceptanceEligible(options, result) {
  return (
    result.status === 'complete' &&
    result.exitCode === 0 &&
    !options.diagnosticNoSandbox &&
    options.cycles >= 50 &&
    options.soakSeconds >= 1800 &&
    options.runs >= 3 &&
    result.environment?.gpu?.gpu_compositing === 'enabled' &&
    STEADY_PHASES.every((name) =>
      result.summary.some((phase) => phase.name === name && phase.valid)
    )
  )
}
function summarize(run, samples, runtimeSamples = []) {
  return (run.phases ?? []).map((phase) => {
    const all = samples.filter(
      (s) => s.timestamp >= phase.start && s.timestamp <= phase.end && s.processes.length > 0
    )
    const stable = all.filter(
      (s) => s.timestamp >= phase.end - Math.min(30000, (phase.end - phase.start) / 2)
    )
    const sum = (s, field) => s.processes.reduce((n, p) => n + p[field], 0)
    const roleNames = new Set(
      stable.flatMap((sample) =>
        sample.processes.map((process) => run.roles?.[process.pid] ?? 'descendant')
      )
    )
    const roles = Object.fromEntries([...roleNames].map((role) => [role, []]))
    for (const s of stable) {
      const totals = {}
      for (const p of s.processes) {
        const role = run.roles?.[p.pid] ?? 'descendant'
        const total = (totals[role] ??= { privateWorkingSetBytes: 0, privateCommitBytes: 0 })
        total.privateWorkingSetBytes += p.privateWorkingSetBytes
        total.privateCommitBytes += p.privateCommitBytes
      }
      for (const role of roleNames)
        roles[role].push(totals[role] ?? { privateWorkingSetBytes: 0, privateCommitBytes: 0 })
    }
    const gpu = stable.filter((s) => s.gpuAvailable)
    const heaps = {}
    for (const sample of runtimeSamples.filter(
      (s) =>
        s.timestamp >= phase.end - Math.min(30000, (phase.end - phase.start) / 2) &&
        s.timestamp <= phase.end
    )) {
      for (const p of [sample.main, ...(sample.utilities ?? [])].filter(Boolean)) {
        const role = run.roles?.[p.pid] ?? 'descendant'
        ;(heaps[`${role}:${p.pid}`] ??= []).push(p)
      }
      for (const p of sample.renderers ?? []) {
        ;(heaps[`renderer:${p.pid}`] ??= []).push({
          heapUsed: p.heap.usedSize,
          heapTotal: p.heap.totalSize,
          backingStorageBytes: p.heap.backingStorageSize,
          embedderHeapBytes: p.heap.embedderHeapUsedSize,
          domNodes: p.dom.nodes,
          eventListeners: p.dom.jsEventListeners
        })
      }
    }
    return {
      name: phase.name,
      valid: !phase.incomplete && stable.length >= 3,
      osSamples: all.length,
      stableSamples: stable.length,
      stablePrivateWorkingSetBytes: percentile(
        stable.map((s) => sum(s, 'privateWorkingSetBytes')),
        0.5
      ),
      stablePrivateCommitBytes: percentile(
        stable.map((s) => sum(s, 'privateCommitBytes')),
        0.5
      ),
      peakPrivateWorkingSetBytes: all.length
        ? Math.max(...all.map((s) => sum(s, 'privateWorkingSetBytes')))
        : null,
      peakPrivateCommitBytes: all.length
        ? Math.max(...all.map((s) => sum(s, 'privateCommitBytes')))
        : null,
      gpu: {
        available: gpu.length > 0,
        dedicatedBytes: percentile(
          gpu.map((s) => (s.gpu ?? []).reduce((n, p) => n + p.dedicatedBytes, 0)),
          0.5
        ),
        sharedBytes: percentile(
          gpu.map((s) => (s.gpu ?? []).reduce((n, p) => n + p.sharedBytes, 0)),
          0.5
        )
      },
      runtime: Object.fromEntries(
        Object.entries(heaps).map(([role, rows]) => [
          role,
          Object.fromEntries(
            [
              'heapUsed',
              'heapTotal',
              'external',
              'arrayBuffers',
              'backingStorageBytes',
              'embedderHeapBytes',
              'domNodes',
              'eventListeners'
            ].map((key) => [
              key,
              percentile(rows.map((row) => row[key]).filter(Number.isFinite), 0.5)
            ])
          )
        ])
      ),
      roles: Object.fromEntries(
        Object.entries(roles).map(([role, rows]) => [
          role,
          {
            privateWorkingSetBytes: percentile(
              rows.map((p) => p.privateWorkingSetBytes),
              0.5
            ),
            privateCommitBytes: percentile(
              rows.map((p) => p.privateCommitBytes),
              0.5
            )
          }
        ])
      )
    }
  })
}
async function runOne(options, size, iteration) {
  const directory = join(options.output, `${size}-${iteration}`)
  mkdirSync(directory, { recursive: true })
  const config = { ...options, size, iteration, directory, root: resolve(__dirname, '..') }
  const configPath = join(directory, 'config.json')
  writeFileSync(configPath, JSON.stringify(config))
  const env = {
    ...process.env,
    TWILIGHT_DEV_USER_DATA_DIR: join(directory, 'profile'),
    TWILIGHT_LOG_DIRECTORY: join(directory, 'logs')
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const child = spawn(
    require('electron'),
    [
      join(__dirname, 'memory-desktop-runner.cjs'),
      configPath,
      ...(options.diagnosticNoSandbox ? ['--no-sandbox'] : [])
    ],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const log = createWriteStream(join(directory, 'runtime.log'))
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const osPath = join(directory, 'windows.jsonl'),
    stopPath = join(directory, 'sampler.stop')
  const sampler = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(__dirname, 'memory-sampler.ps1'),
      '-RootProcessId',
      String(child.pid),
      '-OutputPath',
      osPath,
      '-StopPath',
      stopPath
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
  )
  sampler.stderr.pipe(log, { end: false })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  writeFileSync(stopPath, '')
  if (sampler.exitCode === null)
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        sampler.kill()
        resolve()
      }, 10000)
      sampler.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
  log.end()
  const resultPath = join(directory, 'run.json')
  const run = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, 'utf8'))
    : { status: 'failed', error: `Runner exited ${code} without report` }
  const samples = existsSync(osPath)
    ? readFileSync(osPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  const runtimePath = join(directory, 'runtime.jsonl')
  const runtimeSamples = existsSync(runtimePath)
    ? readFileSync(runtimePath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
  const result = {
    size,
    iteration,
    directory,
    ...run,
    exitCode: code,
    summary: summarize(run, samples, runtimeSamples)
  }
  result.acceptanceEligible = acceptanceEligible(options, result)
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(result, null, 2))
  return result
}
async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      'pnpm benchmark:memory -- --build-root <directory containing out/ and resources/audio-engine/> --output <new report directory> --sizes 1057,10000,100000 --runs 3 --cycles 50 --soak-seconds 1800 --settle-seconds 120\nRuns are sequential; stops below 1 GiB available physical memory. No forced GC. GPU memory is reported separately. Test profiles contain synthetic data only.\n--diagnostic-no-sandbox is only for isolated harness troubleshooting; these runs are ineligible for production acceptance.'
    )
    return
  }
  if (process.platform !== 'win32') throw Error('Windows memory counters require Windows')
  if (!existsSync(join(options.buildRoot, 'out/main/index.js')))
    throw Error('Build the production desktop first')
  if (!existsSync(join(options.buildRoot, 'resources/audio-engine/twilight_audio_node.node')))
    throw Error(
      'Stage the native engine under <build-root>/resources/audio-engine before measuring'
    )
  if (existsSync(options.output))
    throw Error('Choose a new --output directory to preserve earlier evidence')
  mkdirSync(options.output, { recursive: true })
  const report = {
    version: 1,
    startedAt: new Date().toISOString(),
    machine: {
      memoryBytes: totalmem(),
      cpu: cpus()[0]?.model,
      electron: require('electron/package.json').version
    },
    options,
    runs: [],
    status: 'running'
  }
  const save = () =>
    writeFileSync(join(options.output, 'report.json'), JSON.stringify(report, null, 2))
  save()
  outer: for (const size of options.sizes)
    for (let iteration = 1; iteration <= options.runs; iteration++) {
      if (freemem() < options.minFreeBytes) {
        report.status = 'memory-pressure'
        break outer
      }
      console.log(`[memory] ${size} tracks, run ${iteration}/${options.runs}`)
      const result = await runOne(options, size, iteration)
      report.runs.push(result)
      save()
      if (result.status !== 'complete') {
        report.status = result.status
        break outer
      }
    }
  if (report.status === 'running') report.status = 'complete'
  report.acceptanceEligible =
    report.status === 'complete' &&
    report.runs.length === options.sizes.length * options.runs &&
    report.runs.every((run) => run.acceptanceEligible)
  report.finishedAt = new Date().toISOString()
  save()
  console.log(`[memory] ${report.status}: ${join(options.output, 'report.json')}`)
  if (report.status !== 'complete') process.exitCode = 1
}
module.exports = { parseArgs, summarize, percentile, acceptanceEligible, STEADY_PHASES }
if (require.main === module)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
