<script setup lang="ts">
import { computed } from 'vue'
import type { ZoneTransport, ZoneView } from '../../../../shared/coreZones.ts'
import ZoneCover from './ZoneCover.vue'
import ZoneDeck from './ZoneDeck.vue'
import {
  isBridgeZone,
  trackArtists,
  zoneFormatLine,
  zoneLight,
  zoneOutputLabel,
  zoneStatus
} from './zonesPresentation.ts'

const props = defineProps<{
  zone: ZoneView
  selected: boolean
  pending: string | null
  position: number
  volume: number
}>()

const emit = defineEmits<{
  select: []
  transport: [action: ZoneTransport]
  volume: [volume: number]
  connect: []
  'choose-music': []
}>()

const light = computed(() => zoneLight(props.zone))
const status = computed(() => zoneStatus(props.zone))
const bridge = computed(() => isBridgeZone(props.zone))
const formatLine = computed(() => zoneFormatLine(props.zone))
const playable = computed(
  () => (light.value === 'playing' || light.value === 'paused') && Boolean(props.zone.queue)
)
const reason = computed(() => {
  if (light.value === 'offline') return '输出桥未连接；不会切换到本机输出'
  if (light.value === 'unpaired') return '先连接输出桥'
  if (light.value === 'empty') return '队列为空，先选择音乐'
  return ''
})
// The chip names the state; the dark window says what it means and what to do.
const coverMessage = computed(() => {
  if (light.value === 'offline') {
    return bridge.value ? `「${props.zone.output?.peerName || '输出桥'}」没有响应` : '输出桥连接中断'
  }
  if (light.value === 'unpaired') return '还没有声音出口'
  return ''
})
const coverDetail = computed(() => {
  if (light.value === 'offline') {
    return bridge.value ? '不会改用本机输出' : '可在下方「本机输出与输出桥」中重新连接'
  }
  if (light.value === 'unpaired') return '连接另一台电脑的输出桥后即可播放'
  return ''
})

function onCardClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('button, input, a, label, select, textarea')) return
  emit('select')
}
</script>

<template>
  <article
    class="zone-window"
    :class="[`is-${light}`, { 'is-selected': selected, 'has-error': Boolean(zone.error) }]"
    :data-zone-id="zone.id"
    @click="onCardClick"
  >
    <ZoneCover
      :track="zone.track"
      :light="light"
      :message="coverMessage"
      :detail="coverDetail"
    >
      <template v-if="light !== 'playing' && light !== 'paused'" #action>
        <button
          v-if="(light === 'offline' || light === 'unpaired') && bridge"
          type="button"
          class="zones-pill is-outline is-small"
          @click="emit('connect')"
        >
          <i class="ph ph-link-simple" aria-hidden="true" />
          {{ light === 'offline' ? '重新连接' : '连接输出桥' }}
        </button>
        <button
          v-else-if="light === 'empty'"
          type="button"
          class="zones-pill is-outline is-small"
          @click="emit('choose-music')"
        >
          <i class="ph ph-music-notes-plus" aria-hidden="true" />
          选择音乐
        </button>
      </template>
    </ZoneCover>

    <div class="zone-window-body">
      <header class="zone-window-head">
        <div class="zone-window-title">
          <h3>
            <button
              type="button"
              class="zone-window-name"
              :aria-pressed="selected"
              :title="`查看${zone.name}的详情`"
              @click="emit('select')"
            >
              {{ zone.name }}
            </button>
          </h3>
          <p>
            <i
              class="ph"
              :class="bridge || zone.output?.selected ? 'ph-broadcast' : 'ph-desktop'"
              aria-hidden="true"
            />
            <span>{{ zoneOutputLabel(zone) }}</span>
          </p>
        </div>
        <span class="zones-chip" :class="`is-${status.tone}`">{{ status.label }}</span>
      </header>

      <div class="zone-window-track" :class="{ 'is-muted': !playable }">
        <template v-if="zone.track">
          <strong :title="zone.track.title">{{ zone.track.title || '未知曲目' }}</strong>
          <span :title="trackArtists(zone.track)">{{ trackArtists(zone.track) || '未知艺术家' }}</span>
        </template>
        <template v-else>
          <strong>尚未载入音乐</strong>
          <span>{{ bridge ? '此声区有自己的队列，与其他声区互不影响' : '此电脑的主会话' }}</span>
        </template>
      </div>

      <ZoneDeck
        :owner="zone.name"
        :state="zone.playback?.state"
        :position="position"
        :duration="zone.playback?.duration || zone.track?.duration || 0"
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

      <p v-if="zone.error" class="zone-window-error" role="status">
        <i class="ph ph-warning-circle" aria-hidden="true" />
        <span>{{ zone.error }}</span>
      </p>
      <p class="zone-window-format" :title="formatLine || undefined">
        {{ formatLine || (playable ? '格式待播放后报告' : '—') }}
      </p>
    </div>
  </article>
</template>
