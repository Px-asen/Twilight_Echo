import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { createServerCredentials } from './credentials.ts'

test('Server credentials bind to plugin scope and survive a profile path change', { skip: process.platform !== 'win32' }, async () => {
  const root = resolve('fixture-profile'), moved = resolve('fixture-restored')
  const addon = resolve('out/server-service/twilight_server_credentials.node')
  const credentials = createServerCredentials(root, addon)
  const signal = new AbortController().signal
  const scope = `plugin-settings:${join(root, 'plugin-data', 'com.example.one', 'settings.json')}`
  const secret = { cookie: 'test-only-cookie', nested: { value: 7 } }
  const protectedValue = await credentials['credentials.protect']!({ scope, value: secret }, signal)
  assert.equal(protectedValue.backend, 'windows-dpapi')
  assert.doesNotMatch(JSON.stringify(protectedValue), /test-only-cookie/)
  assert.deepEqual(await credentials['credentials.unprotect']!({ scope, value: protectedValue }, signal), secret)
  await assert.rejects(credentials['credentials.unprotect']!({ scope: scope.replace('com.example.one', 'com.example.two'), value: protectedValue }, signal))
  const restored = createServerCredentials(moved, addon)
  assert.deepEqual(await restored['credentials.unprotect']!({ scope: scope.replace(root, moved), value: protectedValue }, signal), secret)
  await assert.rejects(credentials['credentials.protect']!({ scope: 'outside-profile', value: secret }, signal))
})
