'use strict'
const { registerServerCliTest } = require('./server-cli.test.cjs')
registerServerCliTest('service-child', { libraryManagement: true })
registerServerCliTest('service-child', { sessionQueues: true })
registerServerCliTest('service-child', { dspManagement: true })
