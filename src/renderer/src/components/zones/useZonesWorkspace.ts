import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useAppNoticeStore } from '../../stores/useAppNoticeStore.ts'
import type { BridgePeer } from '../../../../shared/audioBridge.ts'
import type { CoreDspState } from '../../../../shared/coreDsp.ts'
import type { CoreQueuePage } from '../../../../shared/coreViews.ts'
import type {
  SyncGroupCreate,
  SyncGroupView,
  SyncGroupsView
} from '../../../../shared/coreSyncGroups.ts'
import type {
  ZoneHandoff,
  ZoneTransport,
  ZoneView,
  ZonesView
} from '../../../../shared/coreZones.ts'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import type { AudioProcessingSettings } from '../../../../shared/audioEngineTypes.ts'
import type { AutoMixMode } from '../../../../shared/twilightAutoMix.ts'

export type ZonesSelection = { kind: 'zone'; id: string } | { kind: 'group'; id: string }
type Playback = ZoneView['playback']

const POLL_MS = 1000
const message = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

/**
 * One poller for the whole page: topology (zones + groups) every second, plus
 * the selected window's signal path, processing state and upcoming queue.
 */
export function useZonesWorkspace() {
  const core = useCoreConnection()
  const notices = useAppNoticeStore()
  const zones = shallowRef<ZonesView | null>(null)
  const groups = shallowRef<SyncGroupsView | null>(null)
  const loadError = ref<string | null>(null)
  const loaded = ref(false)
  const receivedAt = ref(0)
  const now = ref(0)
  const selection = ref<ZonesSelection | null>(null)
  const pathMemberId = ref<string | null>(null)
  const signalPath = shallowRef<CoreSignalPath | null>(null)
  const dsp = shallowRef<CoreDspState | null>(null)
  const dspError = ref<string | null>(null)
  const queuePage = shallowRef<CoreQueuePage | null>(null)
  /** key → action kind; keys are `zone:<id>` / `group:<id>` / `dsp` / `queue`. */
  const pending = reactive(new Map<string, string>())
  /** Optimistic slider values until Core reports the new volume. */
  const volumeDraft = reactive(new Map<string, number>())

  const ready = computed(() => core.state.value?.phase === 'ready')
  const zoneList = computed(() => zones.value?.zones ?? [])
  const groupList = computed(() => groups.value?.groups ?? [])
  const limit = computed(() => zones.value?.limit ?? 4)
  const zoneById = (id: string | null | undefined): ZoneView | undefined =>
    id ? zoneList.value.find((zone) => zone.id === id) : undefined
  const groupById = (id: string | null | undefined): SyncGroupView | undefined =>
    id ? groupList.value.find((group) => group.id === id) : undefined

  const selectedZone = computed(() =>
    selection.value?.kind === 'zone' ? zoneById(selection.value.id) ?? null : null
  )
  const selectedGroup = computed(() =>
    selection.value?.kind === 'group' ? groupById(selection.value.id) ?? null : null
  )
  /** The zone whose DSP and signal path the detail shows (a member when a group is selected). */
  const detailZoneId = computed(() => {
    if (selectedZone.value) return selectedZone.value.id
    const group = selectedGroup.value
    if (!group) return null
    const member = group.members.find((entry) => entry.zoneId === pathMemberId.value)
    return member?.zoneId ?? group.members[0]?.zoneId ?? null
  })
  const selectedQueue = computed(() => selectedGroup.value?.queue ?? selectedZone.value?.queue ?? null)

  const summary = computed(() => {
    const list = zoneList.value
    const playingZones = list.filter((zone) => {
      const group = zone.groupId ? groupById(zone.groupId) : null
      return (group ? group.playback?.state : zone.playback?.state) === 'playing'
    }).length
    return { zones: list.length, playing: playingZones, groups: groupList.value.length }
  })

  function normalizeSelection(): void {
    const list = zoneList.value
    if (!list.length) {
      selection.value = null
      return
    }
    const current = selection.value
    if (current?.kind === 'zone') {
      const zone = zoneById(current.id)
      if (zone?.groupId && groupById(zone.groupId)) {
        selection.value = { kind: 'group', id: zone.groupId }
        pathMemberId.value = zone.id
        return
      }
      if (zone) return
    }
    if (current?.kind === 'group' && groupById(current.id)) return
    // Lost or first selection: prefer what is audible right now.
    const live = groupList.value.find((group) => group.playback?.state === 'playing')
    if (live) {
      selection.value = { kind: 'group', id: live.id }
      return
    }
    const playing = list.find((zone) => !zone.groupId && zone.playback?.state === 'playing')
    const fallback = playing ?? list.find((zone) => !zone.groupId) ?? list[0]
    if (fallback.groupId) selection.value = { kind: 'group', id: fallback.groupId }
    else selection.value = { kind: 'zone', id: fallback.id }
  }

  let disposed = false
  let reading = false
  let generation = 0
  let dspKey = ''
  let queueKey = ''
  let detailTick = 0

  async function refresh(): Promise<void> {
    if (disposed || reading) return
    if (!ready.value) return
    reading = true
    const own = ++generation
    try {
      const [nextZones, nextGroups] = await Promise.all([
        core.query('zones.list', {}),
        core.query('groups.list', {})
      ])
      if (disposed || own !== generation) return
      zones.value = nextZones
      groups.value = nextGroups
      receivedAt.value = performance.now()
      now.value = receivedAt.value
      loadError.value = nextZones.error ?? nextGroups.error ?? null
      loaded.value = true
      for (const [key, value] of volumeDraft) {
        const [kind, id] = key.split(':')
        const reported =
          kind === 'group' ? groupById(id)?.playback?.volume : zoneById(id)?.playback?.volume
        if (reported !== undefined && Math.abs(reported - value) < 0.005) volumeDraft.delete(key)
      }
      normalizeSelection()
      await refreshDetail(own)
    } catch (cause) {
      if (!disposed && own === generation) {
        loadError.value = message(cause, '无法读取声区')
        loaded.value = true
      }
    } finally {
      reading = false
    }
  }

  async function refreshDetail(own: number): Promise<void> {
    const zoneId = detailZoneId.value
    const group = selectedGroup.value
    if (!zoneId) {
      signalPath.value = null
      dsp.value = null
      queuePage.value = null
      return
    }
    detailTick += 1
    const pathRequest = group
      ? core.query('groups.signalPath', { groupId: group.id, zoneId })
      : core.query('zones.signalPath', { zoneId })
    const nextDspKey = zoneId
    const wantDsp = nextDspKey !== dspKey || detailTick % 5 === 0
    const queue = selectedQueue.value
    const nextQueueKey = queue ? `${queue.id}:${queue.revision}:${queue.index}` : ''
    const wantQueue = nextQueueKey !== queueKey
    const [path, settings, page] = await Promise.all([
      pathRequest.catch(() => null),
      wantDsp
        ? core.query('zones.dsp', { zoneId }).then(
            (value) => ({ value, error: null as string | null }),
            (cause: unknown) => ({ value: null, error: message(cause, '无法读取处理设置') })
          )
        : null,
      wantQueue && queue
        ? core
            .query('queue.page', {
              id: queue.id,
              revision: queue.revision,
              offset: Math.max(0, queue.index),
              limit: 6
            })
            .catch(() => null)
        : null
    ])
    if (disposed || own !== generation || zoneId !== detailZoneId.value) return
    signalPath.value = path
    if (settings) {
      dsp.value = settings.value
      dspError.value = settings.error
      dspKey = nextDspKey
    }
    if (wantQueue) {
      queuePage.value = page
      queueKey = nextQueueKey
    }
  }

  function select(next: ZonesSelection, memberId?: string): void {
    const same =
      selection.value?.kind === next.kind && selection.value.id === next.id
    selection.value = next
    if (memberId) pathMemberId.value = memberId
    if (!same || memberId) {
      signalPath.value = null
      queuePage.value = null
      dspKey = ''
      queueKey = ''
      void refresh()
    }
  }

  async function settle(): Promise<void> {
    // A command can land while a poll is mid-flight; read again after it.
    generation += 1
    reading = false
    await refresh()
  }

  async function run(
    key: string,
    kind: string,
    action: () => Promise<unknown>,
    options: { success?: string; error?: string } = {}
  ): Promise<boolean> {
    pending.set(key, kind)
    try {
      await action()
      if (options.success) notices.pushNotice({ kind: 'success', message: options.success })
      return true
    } catch (cause) {
      notices.pushNotice({
        kind: 'error',
        message: message(cause, options.error ?? '操作失败，请刷新后确认状态'),
        dedupeKey: `zones:${key}`
      })
      return false
    } finally {
      pending.delete(key)
      await settle()
    }
  }

  function zoneTransport(zone: ZoneView, action: ZoneTransport): Promise<boolean> {
    const instant = action.kind === 'pause' || action.kind === 'stop'
    return run(`zone:${zone.id}`, action.kind, () =>
      instant
        ? core.command('zones.transport', {
            zoneId: zone.id,
            revision: null,
            action: { kind: action.kind as 'pause' | 'stop' }
          })
        : core.command('zones.transport', {
            zoneId: zone.id,
            revision: zoneById(zone.id)?.revision ?? zone.revision,
            action
          })
    )
  }

  function groupTransport(group: SyncGroupView, action: ZoneTransport): Promise<boolean> {
    const instant = action.kind === 'pause' || action.kind === 'stop'
    return run(`group:${group.id}`, action.kind, () =>
      instant
        ? core.command('groups.transport', {
            groupId: group.id,
            revision: null,
            action: { kind: action.kind as 'pause' | 'stop' }
          })
        : core.command('groups.transport', {
            groupId: group.id,
            revision: groupById(group.id)?.revision ?? group.revision,
            action
          })
    )
  }

  function editGroupAutoMix(group: SyncGroupView, autoMixMode: AutoMixMode): Promise<boolean> {
    const key = `group:${group.id}`
    if (pending.has(key) || (group.autoMixMode ?? 'off') === autoMixMode) return Promise.resolve(false)
    return run(key, 'settings', () => core.command('groups.settings.edit', {
      groupId: group.id, revision: group.revision, autoMixMode
    }), { success: '组 AutoMix 已保存，全组暂停待播' })
  }

  function setVolume(target: ZonesSelection, volume: number): Promise<boolean> {
    const value = Math.min(1, Math.max(0, volume))
    volumeDraft.set(`${target.kind}:${target.id}`, value)
    if (target.kind === 'group') {
      const group = groupById(target.id)
      return group ? groupTransport(group, { kind: 'volume', volume: value }) : Promise.resolve(false)
    }
    const zone = zoneById(target.id)
    return zone ? zoneTransport(zone, { kind: 'volume', volume: value }) : Promise.resolve(false)
  }

  function volumeOf(target: ZonesSelection): number {
    const draft = volumeDraft.get(`${target.kind}:${target.id}`)
    if (draft !== undefined) return draft
    const playback =
      target.kind === 'group' ? groupById(target.id)?.playback : zoneById(target.id)?.playback
    return playback?.volume ?? 0.5
  }

  /** Position advanced locally between polls so progress moves smoothly. */
  function livePosition(playback: Playback | null | undefined): number {
    if (!playback) return 0
    const base = Number.isFinite(playback.position) ? playback.position : 0
    if (playback.state !== 'playing') return base
    const elapsed = Math.max(0, (now.value - receivedAt.value) / 1000)
    const rate = playback.playbackRate && playback.playbackRate > 0 ? playback.playbackRate : 1
    const end = playback.duration > 0 ? playback.duration : Number.POSITIVE_INFINITY
    return Math.min(end, base + elapsed * rate)
  }

  async function editProcessing(settings: Partial<AudioProcessingSettings>): Promise<boolean> {
    const zoneId = detailZoneId.value
    const state = dsp.value
    if (!zoneId || !state) return false
    return run('dsp', 'processing', async () => {
      try {
        await core.command('zones.dsp.edit', {
          zoneId,
          revision: state.revision,
          edit: { kind: 'processing', settings }
        })
      } finally {
        dspKey = ''
      }
    })
  }

  async function applyScene(id: string | null): Promise<boolean> {
    const zoneId = detailZoneId.value
    const state = dsp.value
    if (!zoneId || !state) return false
    return run('dsp', 'scene', async () => {
      try {
        await core.command('zones.dsp.edit', {
          zoneId,
          revision: state.revision,
          edit: { kind: 'apply', id }
        })
      } finally {
        dspKey = ''
      }
    })
  }

  function loadQueue(search: string): Promise<boolean> {
    const query = {
      ...(search.trim() ? { search: search.trim(), searchLiteral: true } : {}),
      sort: 'insertion' as const,
      direction: 'asc' as const
    }
    const group = selectedGroup.value
    if (group) {
      return run(`group:${group.id}`, 'queue', () =>
        core.command('groups.queueFromQuery', { groupId: group.id, revision: group.revision, query }),
        { success: `已为「${group.name}」载入新队列，暂停待播` }
      )
    }
    const zone = selectedZone.value
    if (!zone) return Promise.resolve(false)
    return run(`zone:${zone.id}`, 'queue', () =>
      core.command('zones.queueFromQuery', { zoneId: zone.id, revision: zone.revision, query }),
      { success: `已为「${zone.name}」载入新队列，暂停待播` }
    )
  }

  // Dialog commands throw so the dialog can keep the message inline.
  async function command(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } finally {
      await settle()
    }
  }
  const handoff = (payload: ZoneHandoff): Promise<void> =>
    command(async () => {
      await core.command('zones.handoff', payload)
      const target = zoneById(payload.target.zoneId)
      select({ kind: 'zone', id: payload.target.zoneId })
      notices.pushNotice({
        kind: 'success',
        message: payload.resume
          ? `已接力到「${target?.name ?? '目标声区'}」继续播放`
          : `已接力到「${target?.name ?? '目标声区'}」，保持暂停`
      })
    })
  const createGroup = (payload: SyncGroupCreate): Promise<void> =>
    command(async () => {
      const result = (await core.command('groups.create', payload)) as { id?: string } | undefined
      if (result?.id) select({ kind: 'group', id: result.id })
      notices.pushNotice({ kind: 'success', message: `已建立「${payload.name}」，暂停待播` })
    })
  const removeGroup = (payload: { groupId: string; revision: number }): Promise<void> =>
    command(async () => {
      const group = groupById(payload.groupId)
      await core.command('groups.remove', payload)
      const first = group?.members[0]?.zoneId
      if (first) select({ kind: 'zone', id: first })
      notices.pushNotice({ kind: 'success', message: '已解除编组，成员回到各自的队列' })
    })
  /**
   * Creates the zone, then connects it when an invitation came along. A zone that
   * Core created stays created even when the connect fails: the caller gets the
   * error back so the user can retry the connection instead of creating a twin.
   */
  async function createZone(payload: {
    name: string
    peer: BridgePeer | null
  }): Promise<{ zoneId: string; connectError: string | null }> {
    let outcome = { zoneId: '', connectError: null as string | null }
    await command(async () => {
      const revision = zones.value?.revision ?? 0
      const result = (await core.command('zones.create', { revision, name: payload.name })) as {
        id: string
      }
      outcome = { zoneId: result.id, connectError: null }
      select({ kind: 'zone', id: result.id })
      if (payload.peer) {
        try {
          await settle()
          const zone = zoneById(result.id)
          if (!zone) throw new Error('新声区还没有出现在列表里，请稍后再连接输出桥')
          await core.command('zones.connect', {
            zoneId: zone.id,
            revision: zone.revision,
            peer: payload.peer
          })
        } catch (cause) {
          outcome.connectError = message(cause, '连接输出桥失败，请检查邀请后重试')
        }
      }
      notices.pushNotice(
        outcome.connectError
          ? { kind: 'info', message: `已新建「${payload.name}」，输出桥还没有连上` }
          : {
              kind: 'success',
              message: payload.peer
                ? `已新建「${payload.name}」并连接输出桥`
                : `已新建「${payload.name}」`
            }
      )
    })
    return outcome
  }
  const connectZone = (zoneId: string, peer: BridgePeer): Promise<void> =>
    command(async () => {
      const zone = zoneById(zoneId)
      if (!zone) throw new Error('声区已不存在，请刷新')
      await core.command('zones.connect', { zoneId, revision: zone.revision, peer })
      notices.pushNotice({ kind: 'success', message: `「${zone.name}」已连接输出桥，队列保持暂停` })
    })
  const removeZone = (zoneId: string): Promise<void> =>
    command(async () => {
      const zone = zoneById(zoneId)
      await core.command('zones.remove', { zoneId, revision: zones.value?.revision ?? 0 })
      select({ kind: 'zone', id: 'local' })
      notices.pushNotice({ kind: 'success', message: `已移除「${zone?.name ?? '声区'}」` })
    })

  let poll: ReturnType<typeof setInterval> | undefined
  let tick: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    void refresh()
    poll = setInterval(() => void refresh(), POLL_MS)
    tick = setInterval(() => {
      now.value = performance.now()
    }, 250)
  })
  onBeforeUnmount(() => {
    disposed = true
    clearInterval(poll)
    clearInterval(tick)
  })
  watch(ready, (value) => {
    if (value) void refresh()
  })

  return {
    ready,
    loaded,
    loadError,
    zones,
    groups,
    zoneList,
    groupList,
    limit,
    summary,
    selection,
    selectedZone,
    selectedGroup,
    detailZoneId,
    pathMemberId,
    signalPath,
    dsp,
    dspError,
    queuePage,
    pending,
    zoneById,
    groupById,
    select,
    refresh,
    zoneTransport,
    groupTransport,
    editGroupAutoMix,
    setVolume,
    volumeOf,
    livePosition,
    editProcessing,
    applyScene,
    loadQueue,
    handoff,
    createGroup,
    removeGroup,
    createZone,
    connectZone,
    removeZone
  }
}

export type ZonesWorkspace = ReturnType<typeof useZonesWorkspace>
