import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = async (relative: string): Promise<string> =>
  await readFile(new URL(relative, import.meta.url), 'utf8')

test('lifecycle keeps the app alive without windows and shuts the mode down', async () => {
  const source = await read('./lifecycle.ts')
  assert.match(
    source,
    /app\.on\('window-all-closed',[\s\S]*?if \(isAfterglowModeActive\(\)\) return[\s\S]*?app\.quit\(\)/
  )
  assert.match(source, /app\.on\('before-quit',[\s\S]*?shutdownAfterglowMode\(\)/)
  assert.match(
    source,
    /app\.on\('second-instance',[\s\S]*?isAfterglowModeActive\(\)[\s\S]*?restoreAfterglowMode\(\)/
  )
  assert.match(
    source,
    /app\.on\('activate',[\s\S]*?isAfterglowModeActive\(\)[\s\S]*?restoreAfterglowMode\(\)/
  )
})

test('window teardown marks Afterglow unloads and the recreated window carries the flag', async () => {
  const source = await read('./window.ts')
  assert.match(
    source,
    /if \(afterglowUnloading \|\| awaitingAfterglowHandoff\) \{[\s\S]*?afterglowUnloading = false[\s\S]*?\} else \{[\s\S]*?destroyWindowsSmtc\(\)/
  )
  assert.match(source, /export function setMainWindowAfterglowUnloading/)
  assert.match(source, /afterglowRendererRestoreQueryKey/)
  assert.match(source, /loadFile\([\s\S]*?\[afterglowRendererRestoreQueryKey\]: '1'/)
  assert.match(source, /on\('minimize',[\s\S]*?handleMainWindowMinimized\(\)/)
  assert.match(source, /handleMainWindowHidden\(\)/)
})

test('renderer restore adopts live engine state without reloading the queue', async () => {
  // After the Core migration the restore/adoption logic lives in
  // core/playback (guarded by its own suite); the renderer is a projection
  // and must never reintroduce queue loads or playback restarts.
  const store = await read('../../renderer/src/stores/useCorePlayerStore.ts')
  const internals = await read('../../renderer/src/stores/player/corePlayerStore.ts')
  const combined = store + '\n' + internals
  assert.doesNotMatch(combined, /loadQueue\(/, 'renderer must not reload the native queue')
  assert.doesNotMatch(
    combined,
    /audioEngine\.play\(|api\.play\(/,
    'renderer must not restart playback'
  )
  assert.doesNotMatch(
    combined,
    /adoptAfterglowRestore|nativeQueueLoader/,
    'restore adoption must stay inside Core'
  )
  const session = await read('../../core/playback/session.ts')
  assert.match(session, /resumeMode/, 'Core session must own restore adoption')
})

test('renderer-free control plane is serialized and reads live engine state', async () => {
  const source = await read('./rendererFreePlayback.ts')
  assert.match(source, /let transportLane: Promise<unknown> = Promise\.resolve\(\)/)
  assert.match(source, /enqueueRendererFreeTransport/)
  assert.match(source, /stopActiveOutputTest\(\)/)
  assert.match(source, /scheduleSoftwareVolumePersist\(/)
  assert.match(source, /getPlaybackInfo\(\)/)
  assert.match(source, /resolveAuthorizedAudioSource\(/)
})

test('tray, media keys and SMTC route through the renderer-free dispatcher', async () => {
  const tray = await read('../integrations/shortcutsTray.ts')
  assert.match(tray, /if \(isAfterglowModeActive\(\)\)[\s\S]*?dispatchAfterglowTransport/)
  assert.match(tray, /恢复界面/)
  assert.match(tray, /restoreAfterglowMode\(\)/)
  assert.match(tray, /进入余晖模式/)
  assert.match(tray, /Notification\.isSupported\(\)/)

  const smtc = await read('../integrations/windowsSmtc.ts')
  assert.match(smtc, /export function rebindWindowsSmtc/)
  assert.match(smtc, /routeRendererFreeCommand/)
  assert.match(smtc, /isAfterglowModeActive\(\)/)
})

test('the LAN remote and Discord keep working while the renderer is unloaded', async () => {
  const snapshot = await read('./afterglowSnapshot.ts')
  assert.match(snapshot, /publishRemotePlaybackSnapshot\?\./)
  assert.match(snapshot, /updateDiscordActivity\(/)
  assert.match(snapshot, /resolveRemoteCoverDataUrl/)
  assert.match(snapshot, /readCoverCacheFileBytes\(/)
  assert.match(snapshot, /engineState === 'stopped'/)

  const remote = await read('../remote/remoteIpc.ts')
  assert.match(remote, /isAfterglowModeActive\(\)[\s\S]*?dispatchAfterglowTransport/)
  assert.match(remote, /export function publishRemotePlaybackSnapshot/)
  assert.match(remote, /runtime\.publishRemotePlaybackSnapshot = publishRemotePlaybackSnapshot/)
  assert.match(remote, /case 'setPlayMode'[\s\S]*?dispatchAfterglowTransport/)

  const runtime = await read('../core/runtime.ts')
  assert.match(runtime, /publishRemotePlaybackSnapshot/)
})

test('the service rejects unloadable playback and keeps a restore escape hatch', async () => {
  const source = await read('./AfterglowModeService.ts')
  for (const reason of [
    'afterglow_requires_native_engine',
    'afterglow_requires_active_playback',
    'afterglow_requires_renderer_snapshot',
    'afterglow_requires_fully_local_queue',
    'afterglow_requires_fully_delegated_queue',
    'afterglow_requires_mappable_current_track',
    'afterglow_restore_shortcut_unavailable',
    'afterglow_renderer_flush_failed'
  ]) {
    assert.match(source, new RegExp(reason), `missing rejection reason: ${reason}`)
  }
  // Playback-resume is a user preference, not a prerequisite for unloading.
  assert.doesNotMatch(source, /playbackResumeMode === 'off'/)
  // Restore failures return to `active` so the tray/shortcut can try again.
  const failRestore = source.slice(source.indexOf('private failWindowRestore'))
  assert.match(failRestore, /this\.phase = 'active'/)
  assert.match(failRestore, /registerRestoreShortcut\(\)/)
})

test('the renderer hands its queue to main without touching playback-session.json', async () => {
  // With Core owning the queue there is no renderer-side queue handoff left.
  // The regression this guards against ("保存播放状态失败" from persisting
  // before the in-memory state was handed over) now lives in the quit order:
  // the renderer session save must complete before Core shuts down.
  const app = await read('../../renderer/src/App.vue')
  const store = await read('../../renderer/src/stores/useCorePlayerStore.ts')
  const renderer = app + '\n' + store
  assert.doesNotMatch(
    renderer,
    /publishRendererSnapshot|savePlaybackSessionWithQueue|playback-session/,
    'renderer must not persist or hand off the queue itself'
  )
  const lifecycle = await read('./lifecycle.ts')
  const beforeQuit = lifecycle.slice(lifecycle.indexOf("app.on('before-quit'"))
  const saveAt = beforeQuit.indexOf('requestRendererPlaybackSessionSave')
  const shutdownAt = beforeQuit.indexOf('core.shutdown()')
  assert.ok(saveAt !== -1 && shutdownAt !== -1 && saveAt < shutdownAt)

  const ipc = await read('../ipc/afterglowModeIpc.ts')
  assert.match(ipc, /app:afterglow:publishRendererSnapshot/)
  assert.match(ipc, /publishAfterglowRendererSnapshot\(payload\)/)

  // Online queues are a window; the handoff carries the native→logical map.
  const queueLoader = await read('../../renderer/src/utils/nativeQueueLoader.ts')
  assert.match(queueLoader, /nativeQueueIndices/)
  const service = await read('./AfterglowModeService.ts')
  assert.match(service, /resolveAfterglowEngineMapping/)
  assert.match(service, /windowedQueue/)
  assert.match(service, /bindWindowedAutoRestore/)
  assert.match(service, /AFTERGLOW_WINDOWED_AUTO_RESTORE_DELAY_MS/)
  assert.match(service, /afterglow_requires_mappable_current_track/)
  assert.match(service, /AFTERGLOW_QUEUE_REFERENCE_OWNER = 'afterglow'/)
  assert.match(service, /syncLibraryQueueReferences\(AFTERGLOW_QUEUE_REFERENCE_OWNER/)
  assert.match(service, /setAfterglowLibraryQueueReference\(prepared\.queue\.id, true\)/)
  assert.match(service, /afterglow_restore_window_timeout/)
  // Queue-end/error restore is not limited to windowed queues, and the online
  // core starts for full queues too (so upcoming URLs can still be refreshed).
  assert.match(service, /this\.bindWindowedAutoRestore\(\)\n/)
  assert.match(service, /queue-core\.start/)
  assert.match(service, /queue-core\.capability/)
  // Route C: windowed queues extend through the native hot-update core.
  assert.match(service, /AfterglowQueueCore/)
  assert.match(service, /createAfterglowSourceResolver/)
  assert.match(service, /getQueueHotUpdateCapability/)
  assert.match(service, /onMappingChanged/)
  // A successful memory handoff survives a failed/blocked disk persistence.
  assert.match(
    service,
    /if \(!this\.rendererSnapshot\) return this\.fail\('afterglow_renderer_flush_failed'\)/
  )
  const sessionSource = await read('./playbackSessionService.ts')
  assert.match(sessionSource, /continuing in memory/)
  const adapter = await read('./afterglowQueueCore.ts')
  assert.match(adapter, /NativeQueueMaintainer as AfterglowQueueCore/)
  const core = await read('../../core/playback/nativeQueueMaintainer.ts')
  assert.match(core, /appendQueueItems/)
  assert.match(core, /updateQueueItemSource/)
  assert.match(core, /getMapping\(\)/)
  assert.doesNotMatch(core, /loadQueue\s*\(/)
  const resolverAdapter = await read('./afterglowSourceResolver.ts')
  assert.match(resolverAdapter, /createSourceResolver/)
  assert.match(resolverAdapter, /reuseResolvedProviderPaths: true/)
  const resolver = await read('../../core/playback/sourceResolver.ts')
  assert.match(resolver, /getPlaybackUrl/)
  assert.match(resolver, /isAfterglowPlayableSource/)
  const snapshot = await read('./afterglowSnapshot.ts')
  assert.match(snapshot, /nativeQueueIndices: \[\.\.\.mapping\]/)
  assert.match(snapshot, /setAfterglowEngineMapping/)

  const session = await read('./playbackSessionService.ts')
  assert.match(session, /memoryOnly/)
  assert.match(session, /adoptRendererSnapshot/)
  assert.match(session, /playbackResumeMode === 'off'/)
  assert.match(session, /if \(this\.memoryOnly\) return/)
  assert.match(session, /logicalIndex/)
})
