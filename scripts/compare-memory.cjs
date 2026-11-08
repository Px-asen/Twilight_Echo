'use strict'
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { percentile } = require('./benchmark-memory.cjs')

const range = (values) => ({
  median: percentile(values, 0.5),
  min: values.length ? Math.min(...values) : null,
  max: values.length ? Math.max(...values) : null
})
const metric = (rows, read) => range(rows.map(read).filter(Number.isFinite))

/** Compare complete launches only. A failed/pressure-aborted run cannot supply
 * a lower working set, and mismatched desktop geometry is not a comparison. */
function compareReports(before, after) {
  const problems = []
  for (const [label, report] of [
    ['before', before],
    ['after', after]
  ]) {
    if (report.status !== 'complete' || !report.acceptanceEligible)
      problems.push(`${label}: incomplete or ineligible acceptance workload`)
    if (report.runs?.length !== report.options.sizes.length * report.options.runs)
      problems.push(`${label}: missing repetitions`)
    if (report.runs?.some((run) => run.status !== 'complete' || !run.acceptanceEligible))
      problems.push(`${label}: contains an incomplete or ineligible launch`)
  }
  for (const key of ['sizes', 'runs', 'scenario', 'cycles', 'soakSeconds', 'settleSeconds'])
    if (JSON.stringify(before.options[key]) !== JSON.stringify(after.options[key]))
      problems.push(`Workload differs: ${key}`)
  for (const key of ['memoryBytes', 'cpu', 'electron'])
    if (before.machine[key] !== after.machine[key]) problems.push(`Machine differs: ${key}`)
  const geometries = [...before.runs, ...after.runs].map((run) =>
    JSON.stringify({
      dpr: run.environment?.dpr,
      width: run.environment?.width,
      height: run.environment?.height,
      theme: run.settings?.theme,
      sandbox: run.settings?.sandbox,
      gpu: run.environment?.gpu?.gpu_compositing
    })
  )
  if (new Set(geometries).size !== 1) problems.push('Window, DPI, theme or compositor differs')
  if (problems.length) return { comparable: false, memoryTargetMet: false, problems, sizes: [] }
  const sizes = before.options.sizes.map((size) => {
    const oldRuns = before.runs.filter((run) => run.size === size)
    const newRuns = after.runs.filter((run) => run.size === size)
    const names = new Set(oldRuns.flatMap((run) => run.summary.map((phase) => phase.name)))
    const phases = [...names].map((name) => {
      const oldRows = oldRuns.map((run) => run.summary.find((phase) => phase.name === name))
      const newRows = newRuns.map((run) => run.summary.find((phase) => phase.name === name))
      const valid = [...oldRows, ...newRows].every((row) => row?.valid)
      if (!valid) return { name, valid: false }
      const compareMetric = (read) => ({
        before: metric(oldRows, read),
        after: metric(newRows, read)
      })
      const resident = compareMetric((row) => row.stablePrivateWorkingSetBytes)
      const commit = compareMetric((row) => row.stablePrivateCommitBytes)
      const roles = new Set([...oldRows, ...newRows].flatMap((row) => Object.keys(row.roles)))
      return {
        name,
        valid: true,
        privateWorkingSetBytes: resident,
        privateCommitBytes: commit,
        workingSetReduction:
          resident.before.median > 0 ? 1 - resident.after.median / resident.before.median : null,
        commitReduction:
          commit.before.median > 0 ? 1 - commit.after.median / commit.before.median : null,
        roles: Object.fromEntries(
          [...roles].map((role) => [
            role,
            {
              privateWorkingSetBytes: compareMetric(
                (row) => row.roles[role]?.privateWorkingSetBytes ?? 0
              ),
              privateCommitBytes: compareMetric((row) => row.roles[role]?.privateCommitBytes ?? 0)
            }
          ])
        ),
        gpu: {
          dedicatedBytes: compareMetric((row) => row.gpu?.dedicatedBytes),
          sharedBytes: compareMetric((row) => row.gpu?.sharedBytes)
        }
      }
    })
    const playing = phases.find((phase) => phase.name === 'playing')
    return {
      size,
      memoryTargetMet:
        playing?.valid && playing.workingSetReduction >= 0.3 && playing.commitReduction >= 0,
      phases
    }
  })
  // This is the memory gate only. Functional, cache recovery and audio acceptance
  // are independent requirements before changing the application's default host.
  return {
    comparable: true,
    memoryTargetMet: sizes.every((size) => size.memoryTargetMet),
    problems,
    sizes
  }
}

module.exports = { compareReports }
if (require.main === module) {
  const [before, after] = process.argv.slice(2)
  if (!before || !after)
    throw Error('Usage: node scripts/compare-memory.cjs <before/report.json> <after/report.json>')
  const result = compareReports(
    ...[before, after].map((file) => JSON.parse(readFileSync(resolve(file), 'utf8')))
  )
  console.log(JSON.stringify(result, null, 2))
  if (!result.comparable) process.exitCode = 1
}
