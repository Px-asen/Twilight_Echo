import test from 'node:test'
import assert from 'node:assert/strict'
import { activate, deactivate } from './index.mjs'

test('workshop registers a command-backed independent sidebar entry', async () => {
  let page
  let command
  let handler
  await activate({
    twilight: {
      ui: {
        onCommand: (id, callback) => {
          command = id
          handler = callback
        },
        register: async (entry) => {
          page = entry
        }
      }
    }
  })
  assert.equal(page.id, 'theme-workshop')
  assert.equal(page.kind, 'sidebarPage')
  assert.equal(page.command, command)
  assert.deepEqual(handler(), { page: 'theme-workshop' })
  assert.equal(deactivate(), undefined)
})
