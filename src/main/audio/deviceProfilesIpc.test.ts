import assert from 'node:assert/strict'
import test from 'node:test'
import { createDeviceProfileHandlers } from './deviceProfilesIpc.ts'

test('device profile handlers reject untrusted senders and malformed profiles before touching the engine', async () => {
  let reachedEngine = false
  const handlers = createDeviceProfileHandlers(
    async () => {
      reachedEngine = true
      throw new Error('engine')
    },
    (sender) => {
      if (sender !== 'trusted') throw new Error('untrusted')
    }
  )
  await assert.rejects(handlers.get('foreign'), /untrusted/)
  await assert.rejects(handlers.save('trusted', { version: 1, name: 'bad' }), /格式无效/)
  await assert.rejects(handlers.apply('trusted', ''), /device profile id/)
  assert.equal(reachedEngine, false)
})

test('device profile handler sends one complete request to the manager', async () => {
  const received: string[] = []
  const handlers = createDeviceProfileHandlers(
    async () => ({
      getDeviceProfiles: () => {
        throw new Error('unused')
      },
      saveDeviceProfile: async () => {
        throw new Error('unused')
      },
      deleteDeviceProfile: async () => {
        throw new Error('unused')
      },
      applyDeviceProfile: async (id) => {
        received.push(id)
        return { activeProfileId: id } as never
      }
    }),
    () => {}
  )
  const result = await handlers.apply({}, 'desk')
  assert.equal(result.activeProfileId, 'desk')
  assert.deepEqual(received, ['desk'])
})
