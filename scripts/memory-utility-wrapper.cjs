'use strict'
// Benchmark-only entry wrapper: the production module retains its own __dirname,
// argv, IPC protocol and heap limit. No measurement code ships with the app.
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const target = process.env.TWILIGHT_MEMORY_ORIGINAL_ENTRY
const output = join(process.env.TWILIGHT_MEMORY_SAMPLE_DIR, `${process.pid}.json`)
process.argv[1] = target
const sample = () =>
  writeFileSync(
    output,
    JSON.stringify({
      pid: process.pid,
      timestamp: Date.now(),
      ...process.memoryUsage()
    })
  )
sample()
setInterval(sample, 2000).unref()
require(target)
