import assert from 'node:assert/strict'
import test from 'node:test'
import { zoneGroupOutput } from './zoneGroupOutput.ts'
import type { AudioEngineManager } from '../audioEngineManager.ts'
test('output adapter gives each physical decoder one sequential occurrence and uses joined timed cancellation', async () => {
  const calls: unknown[][] = []
  const audio = {
    loadQueue: async (...args: unknown[]) => { calls.push(['queue', ...args]) },
    setPlayMode: async (...args: unknown[]) => { calls.push(['mode', ...args]) },
    setPlaybackRate: async (...args: unknown[]) => { calls.push(['rate', ...args]) },
    playTimedBridge: async (...args: unknown[]) => { calls.push(['play', ...args]); return { nativeStarted: true } },
    pause: async () => { calls.push(['pause']) },
    callBridge: async (...args: unknown[]) => { calls.push(['bridge', ...args]) },
    setVolume: async (v: number) => { calls.push(['volume', v]) }
  } as unknown as AudioEngineManager
  const output = zoneGroupOutput('zone-fixture', audio, 3)
  await output.silence()
  assert.deepEqual(calls, [['pause']])
  calls.length = 0
  const media = { id: 'a', source: 'C:/disc.flac', queueEntryId: 'a:2', cueRange: { startSeconds: 10, endSeconds: 20, pregapSeconds: 0 } }
  await output.prepare(media, 2, () => true)
  assert.deepEqual(calls.slice(0, 3), [['queue', [media], 0], ['mode', 'sequential'], ['rate', 1]])
  assert.equal(calls[3][0], 'play'); assert.equal(calls[3][1], media.source)
  await output.arm(10000, 2); await output.silence(); await output.volume(.3)
  assert.deepEqual(calls.slice(-3), [['bridge', 'BridgeArmTimed', [10000, 2, true]],
    ['bridge', 'BridgeCancelTimed'], ['volume', .3]])
  calls.length = 0
  await assert.rejects(output.prepare(media, 0, () => false), /取消/)
  assert.equal(calls.some(c => c[0] === 'play'), false)
})

test('lost cancel acknowledgement is retained and retried against the explicitly reconnected stream', async () => {
  let cancels = 0
  const output = zoneGroupOutput('member', {
    loadQueue: async () => {}, setPlayMode: async () => {}, setPlaybackRate: async () => {},
    playTimedBridge: async () => ({ nativeStarted: true }),
    pause: async () => assert.fail('An unconfirmed timed stream is not an ordinary idle member'),
    callBridge: async () => { if (++cancels === 1) throw Error('Disconnected') }
  } as unknown as AudioEngineManager)
  await output.prepare({ id: 'a', source: 'C:/a.flac' }, 0, () => true)
  await assert.rejects(output.silence(), /Disconnected/)
  await output.silence()
  assert.equal(cancels, 2)
})
