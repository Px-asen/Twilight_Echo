<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { parseBridgeInvitation } from '../../../../shared/audioBridge.ts'
import type { ZonesView, ZoneTransport } from '../../../../shared/coreZones.ts'
import type { CoreDspState } from '../../../../shared/coreDsp.ts'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'

const core = useCoreConnection()
const data = ref<ZonesView | null>(null), selectedId = ref('local')
const selected = computed(() => data.value?.zones.find(z => z.id === selectedId.value))
const dsp = ref<CoreDspState | null>(null), path = ref<CoreSignalPath | null>(null)
const name = ref(''), invitation = ref(''), search = ref(''), error = ref(''), notice = ref('')
const busy = ref(false), removing = ref(false)
let timer: ReturnType<typeof setInterval> | undefined, disposed = false, reading = false
async function refresh() {
  if (reading || disposed || busy.value || core.state.value?.phase !== 'ready') return
  reading = true
  const id = selectedId.value
  try {
    const next = await core.query('zones.list', {})
    if (disposed) return
    data.value = next
    if (!next.zones.some(z => z.id === selectedId.value)) selectedId.value = 'local'
    if (id !== 'local' && id === selectedId.value && next.zones.some(z => z.id === id)) {
      const [settings, chain] = await Promise.all([core.query('zones.dsp', { zoneId: id }), core.query('zones.signalPath', { zoneId: id })])
      if (!disposed && selectedId.value === id) { dsp.value = settings; path.value = chain }
    }
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '无法读取 Zone' }
  finally { reading = false }
}
function choose(id: string) {
  selectedId.value = id; dsp.value = null; path.value = null; invitation.value = ''; removing.value = false
  error.value = ''; notice.value = ''; void refresh()
}
async function run(action: () => Promise<unknown>) {
  busy.value = true; error.value = ''; notice.value = ''
  try { await action() } catch (cause) { error.value = cause instanceof Error ? cause.message : '操作失败，请刷新后确认状态' }
  finally { busy.value = false; await refresh() }
}
function create() { return run(async () => {
  const result = await core.command('zones.create', { revision: data.value!.revision, name: name.value }) as { id: string }
  selectedId.value = result.id; name.value = ''; notice.value = '已创建独立会话；粘贴这台输出电脑的邀请以连接 DAC。'
}) }
function connect() { return run(async () => {
  await core.command('zones.connect', { zoneId: selectedId.value, revision: selected.value!.revision, peer: parseBridgeInvitation(invitation.value) })
  invitation.value = ''; notice.value = '输出已连接，队列保持暂停。'
}) }
function transport(action: ZoneTransport) { return run(() => core.command('zones.transport', {
  zoneId: selectedId.value, revision: selected.value!.revision, action
})) }
function prepare() { return run(async () => {
  await core.command('zones.queueFromQuery', { zoneId: selectedId.value, revision: selected.value!.revision,
    query: { ...(search.value.trim() ? { search: search.value.trim(), searchLiteral: true } : {}), sort: 'insertion', direction: 'asc' } })
  notice.value = '已载入独立队列，暂停待播。'
}) }
function processing(settings: Record<string, number | boolean>) { return run(() => core.command('zones.dsp.edit', {
  zoneId: selectedId.value, revision: dsp.value!.revision, edit: { kind: 'processing', settings }
})) }
function remove() { return run(async () => {
  await core.command('zones.remove', { zoneId: selectedId.value, revision: data.value!.revision })
  choose('local'); removing.value = false
}) }
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 1000) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer) })
</script>

<template>
  <section class="zone-sessions" aria-label="独立播放会话">
    <header><h3>独立播放会话</h3><span v-if="data">{{ data.zones.length }} / {{ data.limit }}</span></header>
    <p>每个 Zone 分别排队和处理音频，可同时播放不同音乐。同步组尚未开放。</p>
    <p v-if="data?.error || error" class="zone-error" role="alert">{{ data?.error || error }}</p>
    <div class="zone-tabs" role="group" aria-label="选择 Zone">
      <button v-for="zone in data?.zones" :key="zone.id" :aria-pressed="zone.id === selectedId" :disabled="busy" @click="choose(zone.id)">
        <span>{{ zone.name }}</span><small>{{ zone.id === 'local' ? '主会话' : zone.output?.connected ? '已连接' : '未连接' }}</small>
      </button>
    </div>
    <div v-if="selected" class="zone-detail">
      <template v-if="selected.id === 'local'"><p>主播放栏与上方输出面板继续控制原主会话。新建 Zone 不会切换或清空它的队列。</p></template>
      <template v-else>
        <div class="zone-now"><strong>{{ selected.track?.title || '队列为空' }}</strong><span>{{ selected.track?.artist }}</span>
          <small>{{ selected.queue ? `${selected.queue.index + 1} / ${selected.queue.total} 首` : '尚未载入音乐' }} · {{ selected.playback?.state === 'playing' ? '播放中' : selected.playback?.state === 'paused' ? '已暂停' : '已停止' }}</small></div>
        <div class="zone-controls" aria-label="会话播放控制">
          <button :disabled="busy || !selected.output?.connected || !selected.queue" @click="transport({kind:'play'})">播放</button>
          <button :disabled="busy" @click="transport({kind:'pause'})">暂停</button>
          <button :disabled="busy" @click="transport({kind:'stop'})">停止</button>
          <button :disabled="busy || !selected.output?.connected || !selected.queue" @click="transport({kind:'next'})">下一首</button>
        </div>
        <label class="zone-slider">此 Zone 音量
          <input type="range" min="0" max="1" step="0.01" :value="selected.playback?.volume ?? 0.5" :disabled="busy"
            @change="transport({kind:'volume', volume:Number(($event.target as HTMLInputElement).value)})" /></label>
        <p v-if="selected.error" class="zone-error" role="status">{{ selected.error }}</p>
        <details :open="!selected.output?.connected"><summary>连接此 Zone 的输出桥</summary>
          <p>复制接收电脑的输出桥邀请。一个 DAC 接收端只连接一个会话；断线后不会切回本机。</p>
          <div class="zone-form"><input v-model="invitation" type="password" maxlength="2048" autocomplete="off" aria-label="此 Zone 的输出桥邀请" placeholder="twilight-bridge://…" :disabled="busy" />
            <button :disabled="busy || !invitation.trim()" @click="connect">连接输出</button></div>
        </details>
        <details><summary>载入曲库队列</summary><p>按曲库搜索建立新的独立队列，替换此 Zone 的原队列；载入后暂停。留空使用整个曲库。</p>
          <div class="zone-form"><input v-model="search" aria-label="此 Zone 的曲库搜索" placeholder="搜索曲名、艺术家或专辑" maxlength="512" :disabled="busy" />
            <button :disabled="busy" @click="prepare">载入并暂停</button></div>
        </details>
        <details v-if="dsp"><summary>此 Zone 的 DSP</summary>
          <label class="zone-toggle"><input type="checkbox" :checked="dsp.processing.dspEnabled" :disabled="busy" @change="processing({dspEnabled:($event.target as HTMLInputElement).checked})" />启用 DSP</label>
          <label class="zone-slider">均衡器前级 · {{ dsp.processing.eqPreamp }} dB
            <input type="range" min="-24" max="12" step="0.5" :value="dsp.processing.eqPreamp" :disabled="busy" @change="processing({eqPreamp:Number(($event.target as HTMLInputElement).value)})" /></label>
        </details>
        <details v-if="path"><summary>此 Zone 的信号链</summary><p>{{ path.transport.kind === 'tls-pcm' ? 'Core DSP → TLS Float32 PCM → Bridge → DAC' : '等待输出确认' }}</p>
          <p v-if="path.receiver">{{ path.receiver.actualSampleRate / 1000 }} kHz · {{ path.receiver.actualBitDepth }} bit · 缓冲 {{ Math.round(path.receiver.bufferedFrames * 1000 / path.receiver.sampleRate) }} ms · 欠载 {{ path.receiver.underruns }}</p>
        </details>
        <button v-if="!removing" class="zone-remove" :disabled="busy" @click="removing=true">移除此 Zone…</button>
        <div v-else class="zone-confirm" role="alertdialog" aria-label="确认移除 Zone"><p>停止「{{ selected.name }}」并从列表移除？其他 Zone 不受影响。</p>
          <button :disabled="busy" @click="remove">停止并移除</button><button :disabled="busy" @click="removing=false">取消</button></div>
      </template>
    </div>
    <form class="zone-form zone-create" @submit.prevent="create"><input v-model="name" aria-label="新 Zone 名称" maxlength="80" placeholder="新会话名称，例如：书房" :disabled="busy || !!data?.error" />
      <button type="submit" :disabled="busy || !data || !!data.error || data.zones.length >= data.limit || !name.trim()">新建 Zone</button></form>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.zone-sessions { border-top: 1px solid var(--border-color, #8884); margin-top: 24px; padding-top: 20px; color: var(--text-primary); }
header, .zone-form, .zone-controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; } header { justify-content:space-between; } h3 { margin:0; font-size:16px; } header span, small { color:var(--text-secondary); font-size:12px; }
p { font-size:13px; line-height:1.6; color:var(--text-secondary); margin:8px 0; } button,input { font:inherit; font-size:13px; color:inherit; } button, input:not([type=range]):not([type=checkbox]) { padding:10px 12px; border-radius:9px; border:1px solid var(--border-color,#8884); background:var(--bg-secondary,transparent); } button { cursor:pointer; } button:disabled { opacity:.45; cursor:default; } button[aria-pressed=true] { border-color:var(--accent-color,var(--te-accent-cyan)); }
.zone-tabs { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }.zone-tabs button { display:grid; gap:4px; text-align:left; min-width:112px; }.zone-detail { margin:16px 0; } .zone-now { display:grid; gap:4px; margin-bottom:12px; } .zone-now strong { font-size:15px; } .zone-now span { font-size:13px; color:var(--text-secondary); }
.zone-slider { display:grid; gap:8px; font-size:13px; margin:16px 0; max-width:400px; } input[type=range] { width:100%; accent-color:var(--accent-color); } .zone-toggle { display:flex; gap:8px; margin:12px 0; font-size:13px; } .zone-form input { flex:1; min-width:160px; } details { margin:16px 0; } summary { font-size:13px; cursor:pointer; } .zone-create { margin-top:20px; } .zone-error { color:var(--error-color,var(--te-control-danger,#cc5650)); overflow-wrap:anywhere; } .zone-remove { margin-top:8px; } .zone-confirm button { margin:8px 8px 0 0; }
button:focus-visible,input:focus-visible,summary:focus-visible { outline:2px solid var(--accent-color);outline-offset:3px; }
@media(max-width:600px){.zone-form{align-items:stretch;flex-direction:column}.zone-form input{min-width:0}.zone-tabs button{flex:1}}
</style>
