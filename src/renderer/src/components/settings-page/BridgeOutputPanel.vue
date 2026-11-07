<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { parseBridgeInvitation, type CoreZoneState } from '../../../../shared/audioBridge.ts'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import ZoneSessionsPanel from './ZoneSessionsPanel.vue'
import CoreSignalPathView from './CoreSignalPathView.vue'

const props = defineProps<{ manage?: boolean }>()
const core = useCoreConnection()
const zone = ref<CoreZoneState | null>(null)
const path = ref<CoreSignalPath | null>(null)
const invitation = ref(''), peerInput = ref(''), sampleRate = ref(48000)
const busy = ref(false), error = ref(''), notice = ref('')
let timer: ReturnType<typeof setInterval> | undefined
let disposed = false, reading = false
async function refresh() {
  if (reading || busy.value || disposed || core.state.value?.phase !== 'ready') return
  reading = true
  try {
    const [next, signalPath] = await Promise.all([core.query('zones.state', {}), core.query('audio.signalPath', {})])
    if (disposed) return
    zone.value = next
    path.value = next.groupId ? await core.query('groups.signalPath', { groupId: next.groupId, zoneId: 'local' }) : signalPath
    if (!next.hosting) invitation.value = ''
    else if (props.manage && !invitation.value) {
      const grant = await core.query('bridge.invitation', {})
      if (!disposed) invitation.value = grant.invitation ?? ''
    }
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '无法读取输出桥状态' }
  finally { reading = false }
}
async function run(action: () => Promise<unknown>) {
  busy.value = true; error.value = ''; notice.value = ''
  try { await action() } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败' }
  finally { busy.value = false; await refresh() }
}
function select(outputId: 'local' | 'bridge') {
  return run(() => core.command('zones.select', { revision: zone.value!.revision, outputId }))
}
function connectPeer() {
  return run(async () => {
    const peer = parseBridgeInvitation(peerInput.value)
    await core.command('bridge.connect', { revision: zone.value!.revision, peer })
    peerInput.value = ''; notice.value = '已连接输出桥。播放时由此电脑解码和处理。'
  })
}
function host() {
  return run(async () => {
    const enabled = !zone.value!.hosting
    await core.command('bridge.host', { revision: zone.value!.revision, enabled, sampleRate: sampleRate.value })
    invitation.value = enabled ? (await core.query('bridge.invitation', {})).invitation ?? '' : ''
  })
}
async function copyInvitation() {
  try { await navigator.clipboard.writeText(invitation.value); notice.value = '邀请已复制；仅发送给你信任的 Core 电脑。' }
  catch { error.value = '复制失败，请手动复制邀请。' }
}
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 1000) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer) })
</script>

<template>
  <section class="bridge-output" aria-label="Core 与输出桥">
    <header><div><h3>Core 与输出桥</h3><p>{{ zone?.hosting ? '接收模式 · 本机 DSP 不叠加处理' : '主会话 · 选择声音的出口' }}</p></div>
      <span v-if="zone" class="bridge-state" :class="{ live: zone.connected || zone.receiving }">
        {{ zone.hosting ? (zone.receiving ? '正在接收' : '等待 Core') : zone.selected ? (zone.connected ? '已连接' : '连接中断') : '本机输出' }}
      </span>
    </header>
    <p v-if="zone && !zone.supported" role="status">当前原生引擎不含输出桥；请重新构建或更新桌面端。</p>
    <div v-if="zone && !zone.hosting" class="bridge-outputs" role="group" aria-label="播放输出">
      <button v-for="output in zone.outputs" :key="output.id" type="button" :aria-pressed="zone.selectedOutputId === output.id"
        :disabled="busy || !output.available || (!!zone.groupId && output.id === 'local') || (zone.selectedOutputId === output.id && (output.id === 'local' || zone.connected))"
        @click="select(output.id)">
        <i :class="output.id === 'local' ? 'pi pi-desktop' : 'pi pi-server'" aria-hidden="true" />
        {{ output.name }}<span v-if="output.id === 'bridge' && !zone.connected"> · 重新连接</span>
      </button>
    </div>
    <p v-if="zone?.error" class="bridge-error" role="status">{{ zone.error }}</p>
    <p v-if="zone?.groupId" role="status">主输出已加入同步组。请使用下方组控制；重连不会自动播放。</p>
    <details v-if="path && !zone?.hosting" class="bridge-path">
      <summary>信号链 <span>{{ zone?.selected ? 'Core → TLS → Bridge → DAC' : 'Core → 本机输出' }}</span></summary>
      <CoreSignalPathView :path="path" />
    </details>
    <details v-if="props.manage && zone?.supported" class="bridge-setup">
      <summary>连接另一台电脑 / 将此电脑设为输出桥</summary>
      <div class="bridge-setup-body">
        <template v-if="!zone.hosting">
          <label for="bridge-peer">另一台电脑的输出桥邀请</label>
          <div class="bridge-form-row"><input id="bridge-peer" v-model="peerInput" type="password" maxlength="2048" autocomplete="off" spellcheck="false" placeholder="twilight-bridge://…" :disabled="busy" />
            <button type="button" :disabled="busy || !peerInput.trim()" @click="connectPeer">连接并选择</button></div>
        </template>
        <div class="bridge-host-row"><div><strong>允许此电脑作为输出桥</strong><p>先在音频设置中明确选择 DAC。开启后停止本机播放；关闭即撤销邀请和连接。</p></div>
          <select v-model="sampleRate" aria-label="输出桥采样率" :disabled="busy || zone.hosting"><option v-for="rate in [44100, 48000, 88200, 96000, 176400, 192000]" :key="rate" :value="rate">{{ rate / 1000 }} kHz</option></select>
          <button type="button" :disabled="busy || zone.selected" @click="host">{{ zone.hosting ? '关闭并撤销' : '开启接收' }}</button>
        </div>
        <div v-if="invitation && zone.hosting" class="bridge-invitation"><input :value="invitation" readonly aria-label="输出桥邀请" @focus="($event.target as HTMLInputElement).select()" /><button type="button" @click="copyInvitation">复制邀请</button></div>
      </div>
    </details>
    <p v-if="notice" role="status">{{ notice }}</p><p v-if="error" class="bridge-error" role="alert">{{ error }}</p>
    <ZoneSessionsPanel v-if="props.manage" />
  </section>
</template>

<style scoped>
.bridge-output { --bridge-text: var(--text-primary, var(--te-neutral-900)); --bridge-muted: var(--text-secondary, var(--te-neutral-500)); --bridge-border: var(--border-color, var(--te-neutral-200, #8884)); --bridge-accent: var(--accent-color, var(--te-accent-cyan, #74ae98)); margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--bridge-border); color: var(--bridge-text); }
header, .bridge-host-row, .bridge-form-row, .bridge-invitation { display: flex; align-items: center; gap: 12px; }
header { justify-content: space-between; } h3 { margin: 0; font-size: 16px; } p { margin: 6px 0; line-height: 1.6; font-size: 13px; color: var(--bridge-muted); }
.bridge-state { flex-shrink: 0; font-size: 12px; color: var(--bridge-muted); } .bridge-state.live { color: var(--bridge-accent); }
.bridge-outputs { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
button, select, input { font: inherit; font-size: 13px; border: 1px solid var(--bridge-border); border-radius: 9px; color: var(--bridge-text); background: var(--bg-secondary, color-mix(in srgb, var(--bridge-text) 4%, transparent)); padding: 10px 12px; }
button { cursor: pointer; overflow-wrap: anywhere; } button:disabled { cursor: default; opacity: .5; } button[aria-pressed="true"] { border-color: var(--bridge-accent); opacity: 1; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--bridge-accent); outline-offset: 3px; }
.bridge-path, .bridge-setup { margin-top: 16px; } summary { cursor: pointer; font-size: 13px; line-height: 1.6; } summary span { display: inline-block; margin-left: 12px; color: var(--bridge-muted); font-size: 12px; }
.bridge-setup-body { display: grid; gap: 12px; padding-top: 16px; } label { font-size: 13px; } input { min-width: 0; flex: 1; } .bridge-host-row { margin-top: 8px; flex-wrap: wrap; } .bridge-host-row > div { flex: 1; min-width: 180px; } .bridge-error { color: var(--error-color, var(--te-control-danger, #cc5650)); overflow-wrap: anywhere; }
@media (max-width: 600px) { .bridge-form-row, .bridge-invitation { align-items: stretch; flex-direction: column; } summary span { display: block; margin-left: 0; } }
</style>
