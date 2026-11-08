'use strict'
// Instrument only benchmark children; the production bootstrap and private IPC
// remain unchanged, including the entry at argv[2] and transferred socket handles.
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const bootstrap = process.env.TWILIGHT_MEMORY_ORIGINAL_BOOTSTRAP
const output = join(process.env.TWILIGHT_MEMORY_SAMPLE_DIR, `${process.pid}.json`)
process.argv[1] = bootstrap
const sample = () =>
  writeFileSync(
    output,
    JSON.stringify({ pid: process.pid, timestamp: Date.now(), ...process.memoryUsage() })
  )
sample()
setInterval(sample, 2000).unref()
require(bootstrap)
