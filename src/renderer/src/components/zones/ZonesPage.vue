<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import { scrollMotionBehavior } from '@renderer/app/scrollMotion'
import type { BridgePeer } from '../../../../shared/audioBridge.ts'
import type { SyncGroupCreate } from '../../../../shared/coreSyncGroups.ts'
import type { ZoneHandoff, ZoneTransport, ZoneView } from '../../../../shared/coreZones.ts'
import type { AudioProcessingSettings } from '../../../../shared/audioEngineTypes.ts'
import { useZonesWorkspace, type ZonesSelection } from './useZonesWorkspace.ts'
import {
  GROUP_PHASE_LABEL,
  groupPhase,
  isBridgeZone,
  wallItems,
  zoneOutputLabel,
  zoneStatus
} from './zonesPresentation.ts'
import ZoneWindowCard from './ZoneWindowCard.vue'
import ZoneGroupFrame from './ZoneGroupFrame.vue'
import ZoneSignalPath from './ZoneSignalPath.vue'
import ZoneGroupAlignment from './ZoneGroupAlignment.vue'
import ZoneGroupAutoMix from './ZoneGroupAutoMix.vue'
import ZoneQueueCard from './ZoneQueueCard.vue'
import ZoneProcessingCard from './ZoneProcessingCard.vue'
import ZoneHostCard from './ZoneHostCard.vue'
import ZoneHandoffDialog from './dialogs/ZoneHandoffDialog.vue'
import SyncGroupComposerDialog from './dialogs/SyncGroupComposerDialog.vue'
import SyncGroupDissolveDialog from './dialogs/SyncGroupDissolveDialog.vue'
import ZoneCreateDialog from './dialogs/ZoneCreateDialog.vue'
import ZoneConnectDialog from './dialogs/ZoneConnectDialog.vue'
import ZoneRemoveDialog from './dialogs/ZoneRemoveDialog.vue'

const ws = useZonesWorkspace()
const {
  ready,
  loaded,
  loadError,
  zoneList,
  groupList,
  limit,
  summary,
  selection,
  selectedZone,
  selectedGroup,
  detailZoneId,
  signalPath,
  dsp,
  dspError,
  queuePage,
  pending
} = ws

const items = computed(() => wallItems(zoneList.value, groupList.value))
const freeSlots = computed(() => Math.max(0, limit.value - zoneList.value.length))
const atLimit = computed(() => freeSlots.value === 0)
const ungrouped = computed(() => zoneList.value.filter((zone) => !zone.groupId))
const canCompose = computed(() => ungrouped.value.length >= 2)
const caption = computed(() => {
  const value = summary.value
  const parts = [`${value.zones} 个声区`, value.playing ? `${value.playing} 处在播` : '暂无在播']
  if (value.groups) parts.push(`${value.groups} 个同步组`)
  return parts.join(' · ')
})

const pendingOf = (key: string): string | null => pending.get(key) ?? null
const isSelected = (kind: ZonesSelection['kind'], id: string): boolean =>
  selection.value?.kind === kind && selection.value.id === id

// ---------------------------------------------------------------------------
// Detail of the selection

const detailZone = computed(() => ws.zoneById(detailZoneId.value) ?? null)
const detailOwner = computed(() => detailZone.value?.name ?? '')
const detailTitle = computed(() => selectedGroup.value?.name ?? selectedZone.value?.name ?? '')
const detailSubtitle = computed(() => {
  const group = selectedGroup.value
  if (group) {
    return `同步组 · ${group.members.length} 个声区 · ${GROUP_PHASE_LABEL[groupPhase(group)]}`
  }
  const zone = selectedZone.value
  return zone ? `${zoneOutputLabel(zone)} · ${zoneStatus(zone).label}` : ''
})
const handoffBlock = computed(() => {
  const zone = selectedZone.value
  if (!zone) return '先选择一个声区'
  if (zone.groupId) return '同步组成员不能单独接力'
  if (!zone.queue) return '队列为空，无法接力'
  if (!zoneList.value.some((other) => other.id !== zone.id && !other.groupId))
    return '没有可接力的其他声区'
  return ''
})
const queueOpenRequest = ref(0)
const detailRef = ref<HTMLElement | null>(null)

async function revealDetail(): Promise<void> {
  await nextTick()
  detailRef.value?.scrollIntoView({ behavior: scrollMotionBehavior('smooth'), block: 'start' })
}
function chooseMusic(zone: ZoneView): void {
  ws.select({ kind: 'zone', id: zone.id })
  queueOpenRequest.value += 1
  void revealDetail()
}

function zoneVolume(zone: ZoneView): number {
  return ws.volumeOf({ kind: 'zone', id: zone.id })
}
function onZoneTransport(zone: ZoneView, action: ZoneTransport): void {
  void ws.zoneTransport(zone, action)
}
function onGroupTransport(groupId: string, action: ZoneTransport): void {
  const group = ws.groupById(groupId)
  if (group) void ws.groupTransport(group, action)
}
function onEditProcessing(settings: Partial<AudioProcessingSettings>): void {
  void ws.editProcessing(settings)
}
function onApplyScene(id: string | null): void {
  void ws.applyScene(id)
}
function onLoadQueue(search: string): void {
  void ws.loadQueue(search)
}
const queuePending = computed(() => {
  const key = selectedGroup.value
    ? `group:${selectedGroup.value.id}`
    : selectedZone.value
      ? `zone:${selectedZone.value.id}`
      : ''
  return key ? pending.get(key) === 'queue' : false
})

// ---------------------------------------------------------------------------
// Dialogs: presentational components emit ready payloads; the page runs them.

type DialogState =
  | { kind: 'handoff'; sourceId: string }
  | { kind: 'compose'; memberIds: string[] }
  | { kind: 'dissolve'; groupId: string }
  | { kind: 'create' }
  | { kind: 'connect'; zoneId: string }
  | { kind: 'remove'; zoneId: string }

const dialog = ref<DialogState | null>(null)
const dialogBusy = ref(false)
const dialogError = ref<string | null>(null)

function openDialog(next: DialogState): void {
  dialogError.value = null
  dialogBusy.value = false
  dialog.value = next
}
function closeDialog(): void {
  if (dialogBusy.value) return
  dialog.value = null
  dialogError.value = null
}
async function submit<T>(action: () => Promise<T>): Promise<T | undefined> {
  if (dialogBusy.value) return undefined
  dialogBusy.value = true
  dialogError.value = null
  try {
    const result = await action()
    dialog.value = null
    return result
  } catch (cause) {
    dialogError.value =
      cause instanceof Error && cause.message ? cause.message : '操作失败，请刷新后重试'
    return undefined
  } finally {
    dialogBusy.value = false
  }
}

const dialogZone = computed(() => {
  const state = dialog.value
  return state && (state.kind === 'connect' || state.kind === 'remove')
    ? (ws.zoneById(state.zoneId) ?? null)
    : null
})
const dialogGroup = computed(() => {
  const state = dialog.value
  return state?.kind === 'dissolve' ? (ws.groupById(state.groupId) ?? null) : null
})

function openCompose(): void {
  const zone = selectedZone.value
  openDialog({ kind: 'compose', memberIds: zone && !zone.groupId ? [zone.id] : [] })
}
const onHandoff = async (payload: ZoneHandoff): Promise<void> => {
  await submit(() => ws.handoff(payload))
}
const onCompose = async (payload: SyncGroupCreate): Promise<void> => {
  await submit(() => ws.createGroup(payload))
}
const onDissolve = async (payload: { groupId: string; revision: number }): Promise<void> => {
  await submit(() => ws.removeGroup(payload))
}
/** A zone that was created but could not connect continues in the connect dialog. */
async function onCreate(payload: { name: string; peer: BridgePeer | null }): Promise<void> {
  const outcome = await submit(() => ws.createZone(payload))
  if (!outcome?.connectError) return
  openDialog({ kind: 'connect', zoneId: outcome.zoneId })
  dialogError.value = outcome.connectError
}
const onConnect = async (peer: BridgePeer): Promise<void> => {
  const zone = dialogZone.value
  if (zone) await submit(() => ws.connectZone(zone.id, peer))
}
const onRemove = async (): Promise<void> => {
  const zone = dialogZone.value
  if (zone) await submit(() => ws.removeZone(zone.id))
}
</script>

<template>
  <main class="zones-page" aria-labelledby="zones-title">
    <div class="zones-page-inner">
      <header class="zones-header">
        <div class="zones-heading">
          <p class="zones-caption">{{ loaded ? caption : '正在读取声区' }}</p>
          <h1 id="zones-title">声区</h1>
        </div>
        <div class="zones-header-actions">
          <button
            type="button"
            class="zones-pill is-outline"
            :disabled="!ready || !canCompose"
            :title="canCompose ? undefined : '至少需要两个未编组的声区'"
            @click="openCompose"
          >
            <i class="ph ph-link-simple" aria-hidden="true" />建立同步组
          </button>
          <button
            type="button"
            class="zones-pill is-ink"
            :disabled="!ready || atLimit"
            :title="atLimit ? `最多 ${limit} 个声区，先移除一个再新建` : undefined"
            @click="openDialog({ kind: 'create' })"
          >
            <i class="ph ph-plus" aria-hidden="true" />新建声区
          </button>
        </div>
      </header>

      <div v-if="!ready" class="zones-state" role="status">
        <span class="zones-state-glyph" aria-hidden="true"><i class="ph ph-plugs" /></span>
        <strong>Core 尚未就绪</strong>
        <p>连接恢复后，这里会显示每个声区正在播放的内容。</p>
      </div>
      <p v-else-if="loadError" class="zones-inline-error zones-banner" role="alert">
        <i class="ph ph-warning-circle" aria-hidden="true" />{{ loadError }}
      </p>

      <template v-if="ready">
        <section class="zones-wall" aria-label="声区">
          <template v-if="loaded">
            <template v-for="item in items" :key="item.key">
              <ZoneWindowCard
                v-if="item.kind === 'zone'"
                :zone="item.zone"
                :selected="isSelected('zone', item.zone.id)"
                :pending="pendingOf(`zone:${item.zone.id}`)"
                :position="ws.livePosition(item.zone.playback)"
                :volume="zoneVolume(item.zone)"
                @select="ws.select({ kind: 'zone', id: item.zone.id })"
                @transport="onZoneTransport(item.zone, $event)"
                @volume="ws.setVolume({ kind: 'zone', id: item.zone.id }, $event)"
                @connect="openDialog({ kind: 'connect', zoneId: item.zone.id })"
                @choose-music="chooseMusic(item.zone)"
              />
              <ZoneGroupFrame
                v-else
                :group="item.group"
                :members="item.members"
                :zones="zoneList"
                :selected="isSelected('group', item.group.id)"
                :path-member-id="isSelected('group', item.group.id) ? detailZoneId : null"
                :pending="pendingOf(`group:${item.group.id}`)"
                :position="ws.livePosition(item.group.playback)"
                :volume="ws.volumeOf({ kind: 'group', id: item.group.id })"
                @select="ws.select({ kind: 'group', id: item.group.id }, $event)"
                @transport="onGroupTransport(item.group.id, $event)"
                @volume="ws.setVolume({ kind: 'group', id: item.group.id }, $event)"
              />
            </template>
            <button
              v-if="freeSlots > 0"
              type="button"
              class="zones-slot"
              @click="openDialog({ kind: 'create' })"
            >
              <span class="zones-slot-glyph" aria-hidden="true"><i class="ph ph-plus" /></span>
              <strong>新建声区</strong>
              <small>还可新建 {{ freeSlots }} 个，每个声区连接一个输出桥</small>
            </button>
          </template>
          <template v-else>
            <div v-for="index in 3" :key="index" class="zones-skeleton" aria-hidden="true" />
          </template>
        </section>

        <section
          v-if="selectedZone || selectedGroup"
          ref="detailRef"
          class="zones-detail"
          aria-labelledby="zones-detail-title"
        >
          <header class="zones-section-head">
            <div>
              <h2 id="zones-detail-title">{{ detailTitle }}</h2>
              <p>{{ detailSubtitle }}</p>
            </div>
            <div class="zones-detail-actions">
              <template v-if="selectedGroup">
                <button
                  type="button"
                  class="zones-pill is-outline"
                  @click="openDialog({ kind: 'dissolve', groupId: selectedGroup.id })"
                >
                  <i class="ph ph-link-break" aria-hidden="true" />解除编组…
                </button>
              </template>
              <template v-else-if="selectedZone">
                <button
                  type="button"
                  class="zones-pill is-outline"
                  :disabled="Boolean(handoffBlock)"
                  :title="handoffBlock || undefined"
                  @click="openDialog({ kind: 'handoff', sourceId: selectedZone.id })"
                >
                  <i class="ph ph-arrow-bend-up-right" aria-hidden="true" />接力到…
                </button>
                <button
                  v-if="isBridgeZone(selectedZone)"
                  type="button"
                  class="zones-pill is-outline"
                  @click="openDialog({ kind: 'connect', zoneId: selectedZone.id })"
                >
                  <i class="ph ph-link-simple" aria-hidden="true" />
                  {{ selectedZone.output?.peerName ? '重新连接' : '连接输出桥' }}
                </button>
                <button
                  v-if="isBridgeZone(selectedZone)"
                  type="button"
                  class="zones-text-button is-danger"
                  @click="openDialog({ kind: 'remove', zoneId: selectedZone.id })"
                >
                  <i class="ph ph-trash" aria-hidden="true" />移除声区
                </button>
              </template>
            </div>
          </header>

          <div class="zones-detail-grid" :class="{ 'is-group': Boolean(selectedGroup) }">
            <ZoneGroupAlignment
              v-if="selectedGroup"
              class="zones-span-full"
              :group="selectedGroup"
              :zones="zoneList"
              :path-member-id="detailZoneId"
              @pick-member="ws.select({ kind: 'group', id: selectedGroup.id }, $event)"
            />
            <ZoneGroupAutoMix v-if="selectedGroup" class="zones-span-full" :group="selectedGroup"
              :busy="pending.has(`group:${selectedGroup.id}`)"
              @change="ws.editGroupAutoMix(selectedGroup, $event)" />
            <ZoneSignalPath
              class="zones-span-full"
              :path="signalPath"
              :peer-name="detailZone?.output?.peerName"
              :owner="detailOwner"
              :grouped="Boolean(selectedGroup)"
            />
            <ZoneQueueCard
              :queue="selectedGroup ? selectedGroup.queue : (selectedZone?.queue ?? null)"
              :page="queuePage"
              :current="selectedGroup ? selectedGroup.track : (selectedZone?.track ?? null)"
              :playing="
                (selectedGroup ? selectedGroup.playback?.state : selectedZone?.playback?.state) ===
                'playing'
              "
              :scope="selectedGroup ? 'group' : 'zone'"
              :can-load="Boolean(selectedGroup) || !selectedZone?.groupId"
              :loading="queuePending"
              :open-request="queueOpenRequest"
              @load="onLoadQueue"
            />
            <ZoneProcessingCard
              :dsp="dsp"
              :error="dspError"
              :busy="pending.has('dsp')"
              :owner="detailZone?.name ?? ''"
              :grouped="Boolean(selectedGroup)"
              @edit="onEditProcessing"
              @scene="onApplyScene"
            />
          </div>
        </section>

        <ZoneHostCard />
      </template>
    </div>

    <NativeDialogTransition>
      <ZoneHandoffDialog
        v-if="dialog?.kind === 'handoff'"
        :zones="zoneList"
        :source-id="dialog.sourceId"
        :busy="dialogBusy"
        :error="dialogError"
        @close="closeDialog"
        @submit="onHandoff"
      />
      <SyncGroupComposerDialog
        v-else-if="dialog?.kind === 'compose'"
        :zones="zoneList"
        :revision="ws.groups.value?.revision ?? 0"
        :initial-member-ids="dialog.memberIds"
        :busy="dialogBusy"
        :error="dialogError"
        @close="closeDialog"
        @submit="onCompose"
      />
      <SyncGroupDissolveDialog
        v-else-if="dialog?.kind === 'dissolve' && dialogGroup"
        :group="dialogGroup"
        :zones="zoneList"
        :busy="dialogBusy"
        :error="dialogError"
        @close="closeDialog"
        @submit="onDissolve"
      />
      <ZoneCreateDialog
        v-else-if="dialog?.kind === 'create'"
        :count="zoneList.length"
        :limit="limit"
        :taken-names="zoneList.map((zone) => zone.name)"
        :busy="dialogBusy"
        :error="dialogError"
        @close="closeDialog"
        @submit="onCreate"
      />
      <ZoneConnectDialog
        v-else-if="dialog?.kind === 'connect' && dialogZone"
        :zone="dialogZone"
        :busy="dialogBusy"
        :error="dialogError"
        @close="closeDialog"
        @submit="onConnect"
      />
      <ZoneRemoveDialog
        v-else-if="dialog?.kind === 'remove' && dialogZone"
        :zone="dialogZone"
        :busy="dialogBusy"
        :error="dialogError"
        @close="closeDialog"
        @submit="onRemove"
      />
    </NativeDialogTransition>
  </main>
</template>

<style src="./ZonesPage.css"></style>
