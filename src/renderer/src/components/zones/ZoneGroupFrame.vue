<script setup lang="ts">
import { computed } from 'vue'
import type { ZoneTransport, ZoneView } from '../../../../shared/coreZones.ts'
import type { SyncGroupView } from '../../../../shared/coreSyncGroups.ts'
import ZoneCover from './ZoneCover.vue'
import ZoneDeck from './ZoneDeck.vue'
import {
  GROUP_PHASE_LABEL,
  codecLabel,
  formatAudio,
  formatMs,
  groupPhase,
  groupPhaseTone,
  groupReady,
  groupSkew,
  memberLight,
  trackArtists,
  zoneOutputLabel
} from './zonesPresentation.ts'

/** A sync group: its members' windows share one frame, joined at every seam. */
const props = defineProps<{
  group: SyncGroupView
  members: ZoneView[]
  zones: ZoneView[]
  selected: boolean
  pathMemberId: string | null
  pending: string | null
  position: number
  volume: number
}>()

const emit = defineEmits<{
  select: [memberId?: string]
  transport: [action: ZoneTransport]
  volume: [volume: number]
}>()

const phase = computed(() => groupPhase(props.group))
const phaseTone = computed(() => groupPhaseTone(phase.value))
const skew = computed(() => groupSkew(props.group))
const ready = computed(() => groupReady(props.group, props.zones))
const hasMusic = computed(() => Boolean(props.group.queue && props.group.track))
const playable = computed(() => hasMusic.value && ready.value)
const reason = computed(() => {
  if (!hasMusic.value) return '组队列为空'
  if (!ready.value) return '每个成员都需要连接支持时钟自适应的输出桥'
  return ''
})
const formatLine = computed(() => {
  const playback = props.group.playback
  const track = props.group.track
  const source = [
    codecLabel(playback?.codec || track?.format),
    formatAudio(
      playback?.sourceSampleRate || track?.sampleRate,
      playback?.sourceBitDepth || track?.bitDepth
    )
  ]
    .filter(Boolean)
    .join(' · ')
  return source ? `${source} → ${props.members.length} 个输出桥同步` : ''
})
const memberDelay = (zoneId: string): number =>
  props.group.members.find((member) => member.zoneId === zoneId)?.downstreamDelayMs ?? 0

function memberMessage(zone: ZoneView): string {
  const light = memberLight(zone, props.group)
  if (light === 'offline') return '输出桥离线'
  if (light === 'unpaired') return '未配对输出桥'
  if (light === 'empty') return '队列为空'
  return ''
}

function onFrameClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('button, input, a, label, select, textarea')) return
  emit('select')
}
</script>

<template>
  <article
    class="zone-group"
    data-te-interactive
    :class="[`is-${phase}`, { 'is-selected': selected, 'has-error': Boolean(group.error) }]"
    :style="{ '--zone-members': members.length }"
    :data-members="members.length"
    :data-group-id="group.id"
    @click="onFrameClick"
  >
    <div class="zone-group-windows">
      <div
        v-for="(member, index) in members"
        :key="member.id"
        class="zone-group-member"
        :class="{ 'is-path-member': selected && member.id === pathMemberId }"
      >
        <div class="zone-group-window">
          <button
            type="button"
            class="zone-group-window-hit"
            :aria-pressed="selected && member.id === pathMemberId"
            :aria-label="`查看${member.name}的信号链`"
            @click="emit('select', member.id)"
          >
            <ZoneCover
              :track="group.track"
              :light="memberLight(member, group)"
              :message="memberMessage(member)"
              compact
            />
          </button>
          <span v-if="index < members.length - 1" class="zone-group-link" aria-hidden="true">
            <i class="ph-bold ph-link-simple" />
          </span>
        </div>
        <div class="zone-group-member-meta">
          <strong>{{ member.name }}</strong>
          <span>{{ zoneOutputLabel(member) }}</span>
          <small v-if="memberDelay(member.id) > 0">下游延迟 {{ memberDelay(member.id) }} ms</small>
        </div>
      </div>
    </div>

    <div class="zone-group-shared">
      <header class="zone-group-head">
        <div class="zone-window-title">
          <h3>
            <button
              type="button"
              class="zone-window-name"
              :aria-pressed="selected"
              :title="`查看${group.name}的同步状态`"
              @click="emit('select')"
            >
              {{ group.name }}
            </button>
          </h3>
          <p>
            <i class="ph ph-link-simple" aria-hidden="true" />
            <span>同步组 · {{ members.length }} 个声区</span>
          </p>
        </div>
        <div class="zone-group-chips">
          <span class="zones-chip" :class="`is-${phaseTone}`">{{ GROUP_PHASE_LABEL[phase] }}</span>
          <span
            v-if="skew.measured"
            class="zones-chip"
            :class="skew.aligned ? 'is-neutral' : 'is-warning'"
            :title="`观测范围 ${formatMs(skew.rangeMs)}`"
          >
            偏差 {{ formatMs(skew.skewMs) }}
          </span>
        </div>
      </header>

      <div class="zone-group-body">
        <div class="zone-window-track" :class="{ 'is-muted': !hasMusic }">
          <template v-if="group.track">
            <strong :title="group.track.title">{{ group.track.title || '未知曲目' }}</strong>
            <span>{{ trackArtists(group.track) || '未知艺术家' }}</span>
          </template>
          <template v-else>
            <strong>组队列为空</strong>
            <span>从曲库为整个同步组载入一份队列</span>
          </template>
        </div>
        <ZoneDeck
          :owner="group.name"
          :state="group.playback?.state"
          :position="position"
          :duration="group.playback?.duration || group.track?.duration || 0"
          :volume="volume"
          :playable="playable"
          :reason="reason"
          :pending="pending"
          @play="emit('transport', { kind: 'play' })"
          @pause="emit('transport', { kind: 'pause' })"
          @previous="emit('transport', { kind: 'previous' })"
          @next="emit('transport', { kind: 'next' })"
          @seek="emit('transport', { kind: 'seek', position: $event })"
          @volume="emit('volume', $event)"
        />
      </div>

      <p v-if="group.error || group.coordination?.error" class="zone-window-error" role="status">
        <i class="ph ph-warning-circle" aria-hidden="true" />
        <span>{{ group.error || group.coordination?.error }}</span>
      </p>
      <p v-else-if="!ready" class="zone-group-hint">
        <i class="ph ph-info" aria-hidden="true" />
        <span>同步播放需要每个成员都连接支持时钟自适应的输出桥</span>
      </p>
      <p class="zone-window-format" :title="formatLine || undefined">
        {{ formatLine || '—' }}
      </p>
    </div>
  </article>
</template>
