<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { DspGraphConfig } from '../../../../shared/dspGraph.ts'
import type { DspAuditionResult } from '../../../../shared/dspAudition.ts'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { getTrackSource } from '@renderer/utils/trackSourceIdentity.ts'

const props = defineProps<{ a: DspGraphConfig | null; b: DspGraphConfig | null }>()
const player = usePlayerStore()
const start = ref(0)
const seconds = ref(30)
const busy = ref(false)
const result = shallowRef<DspAuditionResult | null>(null)
const message = ref('记录 A 快照后，将当前草稿作为 B。首版支持无处理与一个内置 EQ。')
let generation = 0
let timer: ReturnType<typeof setInterval> | null = null

function describe(graph: DspGraphConfig | null): string {
  if (!graph) return '尚未记录'
  const nodes = graph.nodes.filter((node) => node.enabled && node.type !== 'meter')
  if (!nodes.length) return '无处理'
  return nodes
    .map((node) => {
      if (node.type !== 'equalizer') return node.type
      const bands = Array.isArray(node.params.bands) ? node.params.bands : []
      return `EQ 前级 ${node.params.preampDb} dB；${
        bands
          .filter((band) => band.enabled !== false)
          .map((band) => `${band.frequency} Hz / ${band.gain} dB / Q ${band.q ?? 1}`)
          .join('；') || '无频段'
      }`
    })
    .join('；')
}

async function end(reason = '已退出试听，恢复进入前配置。'): Promise<boolean> {
  const closingGeneration = ++generation
  if (timer) clearInterval(timer)
  timer = null
  result.value = null
  busy.value = true
  try {
    await window.api.audioEngine.audition.end()
    if (closingGeneration === generation) message.value = reason
    return closingGeneration === generation
  } catch (error) {
    if (closingGeneration === generation)
      message.value = error instanceof Error ? error.message : '退出试听失败，请检查 DSP 状态'
    return false
  } finally {
    if (closingGeneration === generation) busy.value = false
  }
}

watch(
  () => [props.a, props.b],
  () => {
    if (busy.value || result.value) void end('配置已修改，旧测量已失效。')
  },
  { deep: true }
)
watch(
  player.currentTrack,
  (track) => {
    if (busy.value || result.value) void end('音源已改变，请重新测量。')
    start.value = track?.cueRange?.startSeconds ?? 0
  },
  { immediate: true }
)
watch([start, seconds], () => {
  if (busy.value || result.value) void end('区间已改变，请重新测量。')
})

async function measure(): Promise<void> {
  if (!props.a || !props.b || busy.value) return
  if (!(await end('正在冻结音源、区间和两套配置……')) || !props.a || !props.b) return
  const requestGeneration = ++generation
  busy.value = true
  try {
    const track = player.currentTrack.value
    if (!track || getTrackSource(track) !== 'local') throw new Error('请先播放本地 PCM 曲目')
    if (start.value < (track.cueRange?.startSeconds ?? 0))
      throw new Error('起点不能早于当前 CUE 曲目')
    const endSeconds = Math.min(
      start.value + seconds.value,
      track.cueRange?.endSeconds ?? Number.POSITIVE_INFINITY
    )
    message.value = '正在独立分析 A/B 处理结果并复测补偿；可取消。'
    const next = await window.api.audioEngine.audition.measure({
      source: track.filePath,
      startSeconds: start.value,
      endSeconds,
      a: JSON.parse(JSON.stringify(props.a)),
      b: JSON.parse(JSON.stringify(props.b))
    })
    if (generation !== requestGeneration) return
    result.value = next
    message.value = '已匹配：复测差值 ≤0.1 LU，峰值 ≤−1 dBTP。请选择 A 或 B 开始试听。'
    timer = setInterval(async () => {
      if (busy.value || !result.value) return
      try {
        const current = await window.api.audioEngine.audition.status()
        if (generation === requestGeneration && !current)
          await end('音源、设备或配置已改变，试听已结束。')
      } catch {
        if (generation === requestGeneration) await end('试听连接中断，请重新测量。')
      }
    }, 750)
  } catch (error) {
    if (generation === requestGeneration)
      message.value = error instanceof Error ? error.message : '无法匹配'
  } finally {
    if (generation === requestGeneration) busy.value = false
  }
}

async function select(side: 'a' | 'b'): Promise<void> {
  if (!result.value || busy.value) return
  busy.value = true
  const currentGeneration = generation
  try {
    const next = await window.api.audioEngine.audition.select(result.value.id, side)
    if (generation === currentGeneration) result.value = next
  } catch (error) {
    if (generation === currentGeneration)
      await end(error instanceof Error ? error.message : '切换失败，已退出试听')
  } finally {
    if (generation === currentGeneration) busy.value = false
  }
}
onBeforeUnmount(() => {
  void end()
})
</script>

<template>
  <section class="audition-panel" aria-label="等响度试听对比">
    <h3>等响度试听 A / B</h3>
    <p>固定当前曲目：A 为快照，B 为当前草稿。切换保留播放进度，退出恢复原配置。</p>
    <p>当前曲目：{{ player.currentTrack.value?.title || '尚未选择' }}</p>
    <div class="audition-controls">
      <label
        >文件内起点（秒） <input v-model.number="start" type="number" min="0" max="600"
      /></label>
      <label
        >区间长度（秒） <input v-model.number="seconds" type="number" min="10" max="60"
      /></label>
      <button :disabled="!a || !b || busy" @click="measure">测量并匹配</button>
      <button v-if="busy || result" @click="end()">{{ busy ? '取消 / 退出' : '退出试听' }}</button>
    </div>
    <p role="status" aria-live="polite">{{ message }}</p>
    <div v-if="result" class="audition-controls">
      <button :disabled="busy" :aria-pressed="result.selected === 'a'" @click="select('a')">
        A · {{ result.a.integratedLufs.toFixed(1) }} LUFS · 补偿 {{ result.gainA.toFixed(2) }} dB
      </button>
      <button :disabled="busy" :aria-pressed="result.selected === 'b'" @click="select('b')">
        B · {{ result.b.integratedLufs.toFixed(1) }} LUFS · 补偿 {{ result.gainB.toFixed(2) }} dB
      </button>
    </div>
    <details>
      <summary>冻结配置范围与支持说明</summary>
      <p>A：{{ describe(a) }}</p>
      <p>B：{{ describe(b) }}</p>
      <p>
        仅本地单/双声道 PCM，原采样率、正常速度、10–60 秒非静音区间。CUE 使用文件内区间。其他
        DSP、远程、DSD、重采样和交叉淡化不可匹配。数值匹配不保证主观等响。
      </p>
    </details>
  </section>
</template>

<style scoped>
.audition-panel {
  padding: 16px;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
}
.audition-panel p {
  margin: 8px 0;
  color: var(--te-neutral-600);
}
.audition-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
input {
  width: 80px;
}
input,
button {
  padding: 8px 12px;
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  background: var(--te-card-bg);
  color: inherit;
}
button[aria-pressed='true'] {
  outline: 2px solid var(--te-primary-500);
}
button:disabled {
  opacity: 0.5;
}
</style>
