'use strict'
const { registerServerCliTest } = require('./server-cli.test.cjs')
registerServerCliTest('service-child', { pluginManagement: true })
registerServerCliTest('service-child', { pluginManagement: true, remotePlugins: false })
