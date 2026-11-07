'use strict'
const { registerServerCliTest } = require('./server-cli.test.cjs')
const applicationRoot = process.env.TWILIGHT_LINUX_SERVER_ROOT || '/server'
if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Run in the Linux x86_64 build container')
for (const feature of ['pluginManagement', 'dspManagement', 'sessionQueues']) {
  registerServerCliTest('service-child', { applicationRoot, nodeExecutable: process.execPath,
    isolatedPackage: true, [feature]: true })
}
