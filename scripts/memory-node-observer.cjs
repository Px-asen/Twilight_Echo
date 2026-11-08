'use strict'
const { basename, join } = require('node:path')

const roles = {
  'musicCore.cjs': 'twilight-core',
  'audioEngineService.cjs': 'twilight-audio',
  'audioAnalysisService.cjs': 'twilight-analysis',
  'libraryDatabaseService.cjs': 'twilight-database',
  'libraryScanService.cjs': 'twilight-scan',
  'modelPackWorker.cjs': 'twilight-model-install',
  'pluginHost.cjs': 'twilight-plugin'
}

function observeNodeSpawns({ childProcess, scriptsRoot, sampleDir, observe, codec }) {
  const spawn = childProcess.spawn
  const wrapped = (executable, args, options = {}) => {
    const index = Array.isArray(args)
      ? args.findIndex((arg) => basename(arg) === 'bootstrap.cjs')
      : -1
    const role = index >= 0 ? roles[basename(args[index + 1] ?? '')] : null
    if (!role) return spawn(executable, args, options)
    const bootstrap = args[index]
    const stable = options.env?.TWILIGHT_DESKTOP_NODE_HOST === '1'
    if (stable && !codec) throw new Error('Desktop Node measurement requires its supervision codec')
    const instrumented = [...args]
    instrumented[index] = join(scriptsRoot, 'memory-node-wrapper.cjs')
    const child = spawn(executable, instrumented, {
      ...options,
      env: {
        ...(options.env ?? process.env),
        TWILIGHT_MEMORY_ORIGINAL_BOOTSTRAP: bootstrap,
        TWILIGHT_MEMORY_SAMPLE_DIR: sampleDir
      }
    })
    const send = child.send.bind(child)
    const encode = stable ? codec.encodeSupervisionMessage : (value) => value
    const decode = stable ? codec.decodeSupervisionMessage : (value) => value
    const peer = {
      postMessage: (message) => child.send({ message: encode(message), socket: false })
    }
    observe(
      child,
      role,
      peer,
      (transform) => {
        child.send = (envelope, ...rest) => {
          if (envelope && typeof envelope === 'object' && envelope.message) {
            const message = decode(envelope.message)
            transform(message)
            envelope = { ...envelope, message: encode(message) }
          }
          return send(envelope, ...rest)
        }
      },
      decode
    )
    return child
  }
  childProcess.spawn = wrapped
  return () => {
    if (childProcess.spawn === wrapped) childProcess.spawn = spawn
  }
}
module.exports = { observeNodeSpawns }
