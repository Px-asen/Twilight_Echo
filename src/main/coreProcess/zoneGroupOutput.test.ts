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

test('continuous output leases local transitions, binds only the agreed window and keeps the member sequential', async () => {
  const calls: unknown[][] = [], current = { id: 'a', source: 'C:/a.flac', queueEntryId: 'a:1' },
    next = { id: 'b', source: 'C:/b.flac', queueEntryId: 'b:1' }
  const audio = {
    acquireGroupPlayback: async () => { calls.push(['acquire']) }, releaseGroupPlayback: async () => { calls.push(['release']) },
    loadQueue: async (items: unknown[]) => { calls.push(['load', items]) },
    setPlayMode: async (mode: string) => { calls.push(['mode', mode]) }, setPlaybackRate: async () => {},
    playTimedBridge: async () => ({ nativeStarted: true }),
    callBridge: async (...args: unknown[]) => { calls.push(args) },
    getQueueSnapshot: () => [current, next], getQueueToken: () => 'private-native-token',
    getPlaybackInfo: async () => ({ queueIndex: 1 }),
    rebindQueue: async (request: unknown) => { calls.push(['rebind', request]); return { queueToken: 'new' } }
  } as unknown as AudioEngineManager
  const output = zoneGroupOutput('member', audio).continuous!
  await output.acquire(); await output.prepare([current, next], 2, () => true)
  await output.hold(); await output.advance('a:1', 'b:1')
  assert.equal(await output.rebind(next, [next]), true)
  await output.release()
  assert.ok(calls.some(c => c[0] === 'mode' && c[1] === 'sequential'))
  assert.ok(calls.some(c => c[0] === 'BridgeQueueControl' && JSON.stringify(c[1]) === '[true,"a:1","b:1"]'))
  assert.deepEqual(calls.find(c => c[0] === 'rebind')?.[1], { expected: { queueToken: 'private-native-token', index: 1,
    id: 'b', source: 'C:/b.flac' }, items: [next], startIndex: 0, playMode: 'sequential' })
})

test('group AutoMix ports use bridge-only mode/binding and preserve member-local native IDs', async () => {
  const calls: unknown[][]=[]
  const audio={
    setBridgeAutoMixMode:async(...v:unknown[])=>{calls.push(['mode',...v])},
    selectAutoMix:async(...v:unknown[])=>{calls.push(['select',...v]);return {ok:true,selectionId:11}},
    bindBridgeAutoMixSelection:async(...v:unknown[])=>{calls.push(['bind',...v]);return {ok:true,selectionId:27}},
    prepareAutoMix:async(...v:unknown[])=>{calls.push(['prepare',...v]);return true},
    getAutoMixNativeStatus:async()=>({autoMixState:'ready',autoMixPlanId:99}),
    submitAutoMix:async(...v:unknown[])=>{calls.push(['submit',...v]);return true},cancelAutoMix:async()=>true
  } as unknown as AudioEngineManager
  const port=zoneGroupOutput('member',audio).autoMix!
  await port.mode('natural');assert.equal((await port.select('{}')).selectionId,11)
  assert.equal((await port.bind('{}')).selectionId,27);await port.prepare('{"selectionId":27}')
  assert.equal((await port.status()).autoMixPlanId,99);await port.submit(99);assert.equal(await port.cancel(),true)
  assert.deepEqual(calls,[['mode','natural'],['select','{}'],['bind','{}'],['prepare','{"selectionId":27}'],['submit',99]])
})

test('continuous CAS waits for the native queue clock after capture promotion, including repeated occurrences', async () => {
  const current={id:'a',source:'C:/a.flac',queueEntryId:'repeat:1'},calls:unknown[][]=[]
  let reads=0
  const audio={
    getQueueSnapshot:()=>[current,current],getQueueToken:()=>'private-token',
    // The cached view is deliberately still at zero. Capture already promoted.
    getPlaybackInfo:async()=>({queueIndex:0}),
    getQueueState:async()=>({currentIndex:++reads<2?0:1}),
    callBridge:async()=>({transitionSerial:1}),
    rebindQueue:async(request:unknown)=>{calls.push([request]);return {queueToken:'new'}}
  } as unknown as AudioEngineManager
  assert.equal(await zoneGroupOutput('member',audio).continuous!.rebind(current,[current]),true)
  assert.ok(reads>=2)
  assert.equal((calls[0][0] as {expected:{index:number}}).expected.index,1)
})
