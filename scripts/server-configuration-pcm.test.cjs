'use strict'
const { registerServerCliTest } = require('./server-cli.test.cjs')
registerServerCliTest('console', { configurationMigration: true })
