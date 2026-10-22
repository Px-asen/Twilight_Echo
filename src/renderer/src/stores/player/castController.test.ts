import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef, ref } from 'vue'
import type { Track } from '../../types/music'
import { createCastController } from './castController.ts'

function fixture(resolvePlayTarget: (track: Track) => Promise<string>) {
  const currentTrack = shallowRef<Track | null>({
    id: 'local:one',
    title: 'Song',
    artist: 'Artist',
    filePath: 'D:\\Music\\one.flac'
  } as Track)
  const castTargetName = ref<string | null>(null)
  const castTargetUsn = ref<string | null>(null)
  const requests: Parameters<typeof window.api.remote.castToDevice>[0][] = []
  const starts: Track[] = []
  let remote: typeof window.api.remote | undefined = {
    castToDevice: async (request) => {
      requests.push(request)
      return { usn: request.usn, friendlyName: 'Living room' }
    },
    stopCast: async () => true,
    getCastTarget: async () => null
  } as unknown as typeof window.api.remote
  const controller = createCastController({
    currentTrack,
    castTargetName,
    castTargetUsn,
    currentTime: ref(30),
    getRemoteApi: () => remote,
    resolvePlayTarget,
    isCurrentTrackLiveStream: () => currentTrack.value?.source === 'radio',
    recordPlaybackStart: (track) => starts.push(track)
  })
  return {
    ...controller,
    currentTrack,
    castTargetName,
    castTargetUsn,
    requests,
    starts,
    api: remote,
    disconnect: () => {
      remote = undefined
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('stopping during URL resolution cancels the pending cast before it reaches the device', async () => {
  const target = deferred<string>()
  const state = fixture(() => target.promise)
  const cast = state.castCurrentTrackToDevice('device:old')
  await state.stopCastSession()
  target.resolve('D:\\Music\\one.flac')
  await cast
  assert.deepEqual(state.requests, [])
  assert.deepEqual(state.starts, [])
  assert.equal(state.castTargetUsn.value, null)
})

test('a departed occurrence cannot resume a pending cast after the same song is reselected', async () => {
  const target = deferred<string>()
  const state = fixture(() => target.promise)
  const original = { ...state.currentTrack.value!, queueEntryId: 'entry:first' }
  state.currentTrack.value = original
  const cast = state.castCurrentTrackToDevice('device:old')
  state.currentTrack.value = { ...original, queueEntryId: 'entry:second' }
  state.currentTrack.value = original
  target.resolve('D:\\Music\\one.flac')
  await cast
  assert.deepEqual(state.requests, [])
  assert.deepEqual(state.starts, [])
})

test('stop waits for an already dispatched cast and stale completion does not restore its target', async () => {
  const result = deferred<Awaited<ReturnType<typeof window.api.remote.castToDevice>>>()
  const entered = deferred<void>()
  const events: string[] = []
  const state = fixture(async () => 'D:\\Music\\one.flac')
  state.api.castToDevice = async () => {
    events.push('cast')
    entered.resolve()
    return result.promise
  }
  state.api.stopCast = async () => {
    events.push('stop')
    return { ok: true }
  }
  const cast = state.castCurrentTrackToDevice('device:old')
  await entered.promise
  const stop = state.stopCastSession()
  result.resolve({ ok: true, usn: 'device:old', friendlyName: 'Old device', mediaUrl: '' })
  await Promise.all([cast, stop])
  assert.equal(events.at(-1), 'stop')
  assert.equal(state.castTargetUsn.value, null)
  assert.deepEqual(state.starts, [])
})

test('a superseded cast rejection cannot trigger the old track fallback', async () => {
  const result = deferred<Awaited<ReturnType<typeof window.api.remote.castToDevice>>>()
  const entered = deferred<void>()
  const state = fixture(async () => 'D:\\Music\\one.flac')
  state.api.castToDevice = async () => {
    entered.resolve()
    return result.promise
  }
  const cast = state.castCurrentTrackToDevice('device:old')
  await entered.promise
  const stop = state.stopCastSession()
  result.reject(new Error('old cast failed'))
  await assert.doesNotReject(cast)
  await stop
  assert.deepEqual(state.starts, [])
  assert.equal(state.castTargetUsn.value, null)
})

test('a stale target refresh cannot undo a later stop', async () => {
  const target = deferred<{ usn: string; friendlyName: string } | null>()
  const state = fixture(async () => 'D:\\Music\\one.flac')
  state.api.getCastTarget = () => target.promise
  const refresh = state.refreshCastTarget()
  await state.stopCastSession()
  target.resolve({ usn: 'device:old', friendlyName: 'Old device' })
  await refresh
  assert.equal(state.castTargetUsn.value, null)
})

test('an old device command is cleaned up before a newer cast starts', async () => {
  const oldResult = deferred<Awaited<ReturnType<typeof window.api.remote.castToDevice>>>()
  const entered = deferred<void>()
  const events: string[] = []
  const state = fixture(async () => 'D:\\Music\\one.flac')
  state.api.castToDevice = async (request) => {
    events.push(`cast:${request.usn}`)
    if (request.usn === 'device:old') {
      entered.resolve()
      return oldResult.promise
    }
    return { ok: true, usn: request.usn, friendlyName: 'New device', mediaUrl: '' }
  }
  state.api.stopCast = async () => {
    events.push('stop')
    return { ok: true }
  }
  const oldCast = state.castCurrentTrackToDevice('device:old')
  await entered.promise
  state.currentTrack.value = { ...state.currentTrack.value!, id: 'local:two' }
  const newCast = state.castCurrentTrackToDevice('device:new')
  oldResult.resolve({ ok: true, usn: 'device:old', friendlyName: 'Old device', mediaUrl: '' })
  await Promise.all([oldCast, newCast])
  assert.deepEqual(events, ['cast:device:old', 'stop', 'cast:device:new'])
  assert.equal(state.castTargetUsn.value, 'device:new')
  assert.deepEqual(
    state.starts.map((track) => track.id),
    ['local:two']
  )
  state.dispose()
})

test('controller disposal cancels pending URL work without issuing a device command', async () => {
  const target = deferred<string>()
  const state = fixture(() => target.promise)
  const cast = state.castCurrentTrackToDevice('device:old')
  state.dispose()
  target.resolve('D:\\Music\\one.flac')
  await cast
  assert.deepEqual(state.requests, [])
  assert.deepEqual(state.starts, [])
})

for (const queuedStop of [false, true]) {
  test(`a disposed controller cannot stop the cast owned by its replacement (queued stop: ${queuedStop})`, async () => {
    const oldResult = deferred<Awaited<ReturnType<typeof window.api.remote.castToDevice>>>()
    const entered = deferred<void>()
    const events: string[] = []
    let target: string | null = null
    const oldState = fixture(async () => 'D:\\Music\\one.flac')
    const newState = fixture(async () => 'D:\\Music\\two.flac')
    const castToDevice: typeof window.api.remote.castToDevice = async (request) => {
      events.push(`cast:${request.usn}`)
      target = request.usn
      if (request.usn === 'device:old') {
        entered.resolve()
        return oldResult.promise
      }
      return { ok: true, usn: request.usn, friendlyName: 'New device', mediaUrl: '' }
    }
    const stopCast: typeof window.api.remote.stopCast = async () => {
      events.push('stop')
      target = null
      return { ok: true }
    }
    oldState.api.castToDevice = newState.api.castToDevice = castToDevice
    oldState.api.stopCast = newState.api.stopCast = stopCast
    const oldCast = oldState.castCurrentTrackToDevice('device:old')
    await entered.promise
    const oldStop = queuedStop ? oldState.stopCastSession() : Promise.resolve()
    oldState.dispose()
    await newState.castCurrentTrackToDevice('device:new')
    oldResult.resolve({ ok: true, usn: 'device:old', friendlyName: 'Old device', mediaUrl: '' })
    await Promise.all([oldCast, oldStop])
    await oldState.stopCastSession()
    assert.deepEqual(events, ['cast:device:old', 'cast:device:new'])
    assert.equal(target, 'device:new')
    assert.equal(newState.castTargetUsn.value, 'device:new')
    assert.equal(oldState.castTargetUsn.value, null)
    assert.deepEqual(oldState.starts, [])
    newState.dispose()
  })
}

test('casting uses a resolved local cache or provider grant and remembers the destination', async () => {
  for (const target of [
    'D:\\Cache\\one.flac',
    'https://audio.invalid/one',
    'twilight-media://grant/one'
  ]) {
    const state = fixture(async () => target)
    await state.castCurrentTrackToDevice('device:one')
    const request = state.requests[0]
    assert.equal(request.filePath ?? request.mediaUrl, target)
    assert.equal(request.positionSeconds, 30)
    assert.equal(state.castTargetUsn.value, 'device:one')
    assert.equal(state.castTargetName.value, 'Living room')
    assert.equal(state.starts[0], state.currentTrack.value)
    await state.stopCastSession()
    assert.equal(state.castTargetUsn.value, null)
    assert.equal(state.castTargetName.value, null)
  }
})

test('failed target resolution falls back to the track stream and live radio starts at zero', async () => {
  const state = fixture(async () => {
    throw new Error('provider offline')
  })
  state.currentTrack.value = {
    ...state.currentTrack.value!,
    source: 'radio',
    streamUrl: 'https://radio.invalid/live'
  }
  await state.castCurrentTrackToDevice('device:radio')
  assert.equal(state.requests[0].mediaUrl, 'https://radio.invalid/live')
  assert.equal(state.requests[0].positionSeconds, 0)
  await state.refreshCastTarget()
  assert.equal(state.castTargetName.value, null)
})

test('unsupported target or unavailable remote API reports failure before recording a playback', async () => {
  const state = fixture(async () => 'unsupported://one')
  state.currentTrack.value = { ...state.currentTrack.value!, filePath: 'unsupported://one' }
  await assert.rejects(state.castCurrentTrackToDevice('device:one'), /不支持投送/)
  assert.deepEqual(state.requests, [])
  assert.deepEqual(state.starts, [])
  state.disconnect()
  await assert.rejects(state.castCurrentTrackToDevice('device:one'), /API 不可用/)
  assert.deepEqual(await state.discoverCastDevices(), [])
})
