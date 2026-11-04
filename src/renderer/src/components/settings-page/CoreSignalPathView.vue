<script setup lang="ts">
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import { nodeLabel } from '../../utils/dspNodeParams.ts'
import { bridgeClockObservation, bridgeAdaptiveObservation } from '../../utils/bridgeClockPresentation.ts'
defineProps<{ path: CoreSignalPath }>()
const format = (rate?: number | null, bits?: number, channels?: number) => rate
  ? `${rate / 1000} kHz${bits ? ` · ${bits} bit` : ''}${channels ? ` · ${channels} ch` : ''}` : '尚未确认'
</script>

<template>
  <ol class="core-signal-path">
    <li><strong>音源 / 解码{{ path.source.codec ? ` · ${path.source.codec}` : '' }}</strong><span>{{ format(path.source.sampleRate, path.source.bitDepth, path.source.channels) }} → {{ format(path.decoded.sampleRate, path.decoded.bitDepth, path.decoded.channels) }}</span></li>
    <li><strong>Core DSP · {{ path.dsp.applyState === 'pending' ? '应用中' : path.dsp.applyState === 'failed' ? '应用失败' : path.dsp.applyState === 'applied' ? '已应用' : '引擎状态' }}</strong>
      <span v-for="node in path.dsp.nodes" :key="node.id">{{ nodeLabel(node.type) }} · {{ node.active ? '实际运行' : node.bypassed ? '旁路' : '待命' }}</span>
      <span v-if="!path.dsp.nodes.length">未报告处理节点</span>
    </li>
    <li v-if="path.dsp.outputStage?.resampled"><strong>Core SRC</strong><span>{{ format(path.dsp.outputStage.actualSampleRate) }}{{ path.dsp.outputStage.effectiveResampler ? ` · ${path.dsp.outputStage.effectiveResampler}` : '' }}</span></li>
    <li v-if="path.transport.kind === 'tls-pcm'"><strong>TLS / Float32 PCM</strong><span>{{ format(path.transport.sampleRate, 32, path.transport.channels) }} · Bridge 不重复应用 Core DSP</span></li>
    <li v-if="path.receiver?.adaptive"><strong>Bridge 时钟 SRC</strong><span v-for="line in bridgeAdaptiveObservation(path.receiver)" :key="line">{{ line }}</span></li>
    <li v-if="path.receiver"><strong>Bridge 缓冲 / PCM 出队</strong><span>{{ Math.round(path.receiver.bufferedFrames * 1000 / path.receiver.sampleRate) }} ms · PCM 已出队 {{ path.receiver.consumedFrames }} 帧 · 欠载 {{ path.receiver.underruns }}</span></li>
    <li v-if="path.transport.kind === 'tls-pcm'"><strong>时钟观测{{ path.timing?.output.source === 'wasapi-audio-clock' ? ' · WASAPI IAudioClock' : '' }}</strong>
      <span v-for="line in bridgeClockObservation(path.timing)" :key="line">{{ line }}</span>
    </li>
    <li><strong>{{ path.output.deviceName || path.output.backend || '输出驱动' }}</strong><span>{{ format(path.output.sampleRate, path.output.bitDepth, path.output.channels) }} · 驱动回报；DAC 内部处理未知</span></li>
  </ol>
</template>

<style scoped>
ol { margin:16px 0 0; padding-left:22px; }
li { padding:0 0 12px 8px; font-size:13px; }
li strong,li span { display:block; }
li span { color:var(--text-secondary,var(--te-neutral-500)); line-height:1.6; margin-top:3px; }
</style>
