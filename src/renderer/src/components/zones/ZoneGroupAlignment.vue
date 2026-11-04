<script setup lang="ts">
import { computed } from 'vue'
import type { ZoneView } from '../../../../shared/coreZones.ts'
import type { SyncGroupView } from '../../../../shared/coreSyncGroups.ts'
import {
  GROUP_SKEW_TOLERANCE_MS,
  GROUP_STEPS,
  formatMs,
  groupPhase,
  groupPhaseTone,
  groupSkew,
  groupStepIndex,
  memberReadiness,
  zoneOutputLabel
} from './zonesPresentation.ts'

const props = defineProps<{
  group: SyncGroupView
  zones: ZoneView[]
  pathMemberId: string | null
}>()
const emit = defineEmits<{ 'pick-member': [zoneId: string] }>()

const phase = computed(() => groupPhase(props.group))
const tone = computed(() => groupPhaseTone(phase.value))
const step = computed(() => groupStepIndex(phase.value))
const reading = computed(() => groupSkew(props.group))
const percent = (ms: number): string =>
  `${Math.min(100, Math.max(0, (ms / reading.value.scaleMs) * 100)).toFixed(2)}%`
const band = computed(() => {
  const value = reading.value
  const low = Math.max(0, value.skewMs - value.rangeMs)
  const high = Math.min(value.scaleMs, value.skewMs + value.rangeMs)
  return { left: percent(low), width: percent(Math.max(0, high - low)) }
})
const meterLabel = computed(() =>
  reading.value.measured
    ? `成员间偏差 ${formatMs(reading.value.skewMs)}，观测范围 ${formatMs(reading.value.rangeMs)}，${reading.value.label}`
    : `成员间偏差：${reading.value.label}`
)
const members = computed(() =>
  props.group.members.map((member) => {
    const zone = props.zones.find((candidate) => candidate.id === member.zoneId)
    const engine = props.group.coordination?.members.find((entry) => entry.id === member.zoneId)
    return {
      id: member.zoneId,
      name: zone?.name ?? '已移除的声区',
      output: zone ? zoneOutputLabel(zone) : '—',
      delay: member.downstreamDelayMs,
      dspDelay: engine ? engine.dspDelayMs : null,
      readiness: memberReadiness(zone)
    }
  })
)
const error = computed(() => props.group.coordination?.error || props.group.error)
</script>

<template>
  <section class="zones-panel zone-align" aria-labelledby="zone-align-title">
    <header class="zones-panel-head">
      <div>
        <h3 id="zone-align-title">同步对齐</h3>
        <p>所有成员在同一时刻起播，持续测量彼此的偏差</p>
      </div>
    </header>

    <ol class="zone-align-steps" :class="`is-${tone}`" aria-label="同步阶段">
      <li
        v-for="(entry, index) in GROUP_STEPS"
        :key="entry.phase"
        :class="{ 'is-done': index < step, 'is-current': index === step }"
        :aria-current="index === step ? 'step' : undefined"
      >
        <span class="zone-align-step-dot" aria-hidden="true" />
        <span class="zone-align-step-label">{{ entry.label }}</span>
      </li>
    </ol>
    <p v-if="phase === 'rebuffering' || phase === 'completed' || phase === 'failed'" class="zone-align-note">
      {{
        phase === 'rebuffering'
          ? '有成员缓冲不足，所有成员一同等待后再对齐起播。'
          : phase === 'completed'
            ? '组队列已播放完毕，成员保持暂停。'
            : '同步播放已停止，请检查成员的输出桥后重新播放。'
      }}
    </p>
    <p v-if="error" class="zones-inline-error" role="status">
      <i class="ph ph-warning-circle" aria-hidden="true" />{{ error }}
    </p>

    <div class="zone-skew" :class="{ 'is-drifting': reading.measured && !reading.aligned }">
      <dl class="zone-skew-figures">
        <div>
          <dt>偏差</dt>
          <dd>{{ reading.measured ? formatMs(reading.skewMs) : '—' }}</dd>
        </div>
        <div>
          <dt>观测范围</dt>
          <dd>{{ reading.measured ? formatMs(reading.rangeMs) : '—' }}</dd>
        </div>
        <div>
          <dt>容差</dt>
          <dd>{{ GROUP_SKEW_TOLERANCE_MS }} ms</dd>
        </div>
      </dl>
      <div class="zone-skew-meter" role="img" :aria-label="meterLabel">
        <span class="zone-skew-tolerance" :style="{ width: percent(GROUP_SKEW_TOLERANCE_MS) }" />
        <template v-if="reading.measured">
          <span class="zone-skew-band" :style="{ left: band.left, width: band.width }" />
          <span class="zone-skew-marker" :style="{ left: percent(reading.skewMs) }" />
        </template>
      </div>
      <div class="zone-skew-axis" aria-hidden="true">
        <span>0</span>
        <span class="zone-skew-axis-tolerance" :style="{ left: percent(GROUP_SKEW_TOLERANCE_MS) }">
          {{ GROUP_SKEW_TOLERANCE_MS }} ms
        </span>
        <span>{{ reading.scaleMs }} ms</span>
      </div>
      <p class="zone-skew-verdict">
        <i
          class="ph"
          :class="
            !reading.measured ? 'ph-timer' : reading.aligned ? 'ph-check-circle' : 'ph-warning'
          "
          aria-hidden="true"
        />
        {{ reading.label }}
      </p>
    </div>

    <div class="zone-members">
      <h4>成员</h4>
      <ul>
        <li v-for="member in members" :key="member.id">
          <button
            type="button"
            class="zone-member"
            :aria-pressed="member.id === pathMemberId"
            :title="`查看${member.name}的信号链`"
            @click="emit('pick-member', member.id)"
          >
            <span class="zone-member-dot" :class="`is-${member.readiness.tone}`" aria-hidden="true" />
            <span class="zone-member-copy">
              <strong>{{ member.name }}</strong>
              <small>{{ member.output }}</small>
            </span>
            <span class="zone-member-delay">
              <small>下游延迟</small>
              <strong :class="{ 'is-muted': member.delay <= 0 }">
                {{ member.delay > 0 ? `${member.delay} ms` : '未校准' }}
              </strong>
            </span>
            <span class="zone-member-delay" :title="member.dspDelay === null ? '起播后由 Core 回报' : undefined">
              <small>DSP 延迟</small>
              <strong :class="{ 'is-muted': member.dspDelay === null }">
                {{ member.dspDelay === null ? '—' : formatMs(member.dspDelay, 1) }}
              </strong>
            </span>
            <span class="zones-chip" :class="`is-${member.readiness.tone}`">
              {{ member.readiness.label }}
            </span>
          </button>
        </li>
      </ul>
      <p class="zones-hint">下游延迟在建立同步组时设定，0 表示 DAC 模拟输出尚未校准。点选成员可查看它的信号链。</p>
    </div>
  </section>
</template>
