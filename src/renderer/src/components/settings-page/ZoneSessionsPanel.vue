<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { parseBridgeInvitation } from '../../../../shared/audioBridge.ts'
import { zoneQueueFence, type ZonesView, type ZoneTransport } from '../../../../shared/coreZones.ts'
import type { CoreDspState } from '../../../../shared/coreDsp.ts'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import CoreSignalPathView from './CoreSignalPathView.vue'
import SyncGroupsPanel from './SyncGroupsPanel.vue'

const core = useCoreConnection()
const data = ref<ZonesView | null>(null), selectedId = ref('local')
const selected = computed(() => data.value?.zones.find(z => z.id === selectedId.value))
const dsp = ref<CoreDspState | null>(null), path = ref<CoreSignalPath | null>(null)
const name = ref(''), invitation = ref(''), search = ref(''), error = ref(''), notice = ref('')
const progress = ref('')
const pending = ref(0), busy = computed(() => pending.value > 0), removing = ref(false), halting = ref(false)
const handoffTargetId = ref(''), replaceTarget = ref(false), resumeTarget = ref(false)
const handoffTarget = computed(() => data.value?.zones.find(z => z.id === handoffTargetId.value && z.id !== selectedId.value))
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
  handoffTargetId.value = ''; replaceTarget.value = false; resumeTarget.value = false
  error.value = ''; notice.value = ''; void refresh()
}
let sequence = 0
async function run(action: () => Promise<unknown>, pendingText = '') {
  const own = ++sequence
  pending.value++; error.value = ''; notice.value = ''; progress.value = pendingText
  try { await action() } catch (cause) { if (own === sequence) error.value = cause instanceof Error ? cause.message : '操作失败，请刷新后确认状态' }
  finally { pending.value--; if (own === sequence) progress.value = ''; await refresh() }
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
}), action.kind === 'play' ? '正在准备播放…' : '') }
async function interrupt(kind: 'pause' | 'stop') {
  if (halting.value) return
  halting.value = true
  const id = selectedId.value
  try { await run(async () => {
    await core.command('zones.transport', { zoneId: id, revision: null, action: { kind } })
  }) } finally { halting.value = false }
}
function handoff() {
  const source = selected.value, target = handoffTarget.value
  const queue = source && zoneQueueFence(source.queue)
  if (!source || !target || !queue) return
  const payload = { source: { zoneId: source.id, revision: source.revision, queue },
    target: { zoneId: target.id, revision: target.revision, queue: zoneQueueFence(target.queue) },
    replace: replaceTarget.value, resume: resumeTarget.value }
  return run(async () => {
    await core.command('zones.handoff', payload)
    notice.value = payload.resume ? `已接力到「${target.name}」继续播放；源会话已暂停。` : `已接力到「${target.name}」并暂停，保留当前位置。`
    handoffTargetId.value = ''; replaceTarget.value = false; resumeTarget.value = false
  }, '正在接力…')
}
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
    <p>每个 Zone 分别排队和处理音频，可同时播放不同音乐；编组后由下方的同步组统一控制。</p>
    <p v-if="data?.error || error" class="zone-error" role="alert">{{ data?.error || error }}</p>
    <p v-if="progress" role="status">{{ progress }}</p>
    <div class="zone-tabs" role="group" aria-label="选择 Zone">
      <button v-for="zone in data?.zones" :key="zone.id" :aria-pressed="zone.id === selectedId" :disabled="busy" @click="choose(zone.id)">
        <span>{{ zone.name }}</span><small>{{ zone.groupId ? '同步组成员' : zone.id === 'local' ? '主会话' : zone.output?.connected ? '已连接' : '未连接' }}</small>
      </button>
    </div>
    <div v-if="selected" class="zone-detail">
      <p v-if="selected.groupId" role="status">此输出已由同步组占用。原独立队列保留并暂停；请在下方统一控制，或先解除编组。</p>
      <template v-if="selected.id === 'local'"><p v-if="!selected.groupId">主播放栏与上方输出面板继续控制原主会话。新建 Zone 不会切换或清空它的队列。</p></template>
      <template v-else>
        <div class="zone-now"><strong>{{ selected.track?.title || '队列为空' }}</strong><span>{{ selected.track?.artist }}</span>
          <small>{{ selected.queue ? `${selected.queue.index + 1} / ${selected.queue.total} 首` : '尚未载入音乐' }} · {{ selected.playback?.state === 'playing' ? '播放中' : selected.playback?.state === 'paused' ? '已暂停' : '已停止' }}</small></div>
        <div v-if="!selected.groupId" class="zone-controls" aria-label="会话播放控制">
          <button :disabled="busy || !selected.output?.connected || !selected.queue" @click="transport({kind:'play'})">播放</button>
          <button :disabled="halting" @click="interrupt('pause')">暂停</button>
          <button :disabled="halting" @click="interrupt('stop')">停止</button>
          <button :disabled="busy || !selected.output?.connected || !selected.queue" @click="transport({kind:'next'})">下一首</button>
        </div>
        <label v-if="!selected.groupId" class="zone-slider">此 Zone 音量
          <input type="range" min="0" max="1" step="0.01" :value="selected.playback?.volume ?? 0.5" :disabled="busy"
            @change="transport({kind:'volume', volume:Number(($event.target as HTMLInputElement).value)})" /></label>
        <p v-if="selected.error" class="zone-error" role="status">{{ selected.error }}</p>
        <details :open="!selected.output?.connected"><summary>连接此 Zone 的输出桥</summary>
          <p>复制接收电脑的输出桥邀请。一个 DAC 接收端只连接一个会话；断线后不会切回本机。</p>
          <div class="zone-form"><input v-model="invitation" type="password" maxlength="2048" autocomplete="off" aria-label="此 Zone 的输出桥邀请" placeholder="twilight-bridge://…" :disabled="busy" />
            <button :disabled="busy || !invitation.trim()" @click="connect">连接输出</button></div>
        </details>
        <details v-if="!selected.groupId"><summary>载入曲库队列</summary><p>按曲库搜索建立新的独立队列，替换此 Zone 的原队列；载入后暂停。留空使用整个曲库。</p>
          <div class="zone-form"><input v-model="search" aria-label="此 Zone 的曲库搜索" placeholder="搜索曲名、艺术家或专辑" maxlength="512" :disabled="busy" />
            <button :disabled="busy" @click="prepare">载入并暂停</button></div>
        </details>
        <details v-if="dsp"><summary>此 Zone 的 DSP</summary>
          <label class="zone-toggle"><input type="checkbox" :checked="dsp.processing.dspEnabled" :disabled="busy" @change="processing({dspEnabled:($event.target as HTMLInputElement).checked})" />启用 DSP</label>
          <label class="zone-toggle"><input type="checkbox" :checked="dsp.processing.directMode" :disabled="busy" @change="processing({directMode:($event.target as HTMLInputElement).checked})" />直通模式</label>
          <label class="zone-toggle"><input type="checkbox" :checked="dsp.processing.eqEnabled" :disabled="busy" @change="processing({eqEnabled:($event.target as HTMLInputElement).checked})" />启用均衡器</label>
          <label class="zone-slider">均衡器前级 · {{ dsp.processing.eqPreamp }} dB
            <input type="range" min="-24" max="12" step="0.5" :value="dsp.processing.eqPreamp" :disabled="busy || !dsp.processing.dspEnabled || !dsp.processing.eqEnabled || dsp.processing.directMode" @change="processing({eqPreamp:Number(($event.target as HTMLInputElement).value)})" /></label>
        </details>
        <details v-if="path && !selected.groupId"><summary>此 Zone 的信号链</summary>
          <CoreSignalPathView :path="path" />
        </details>
        <button v-if="!removing && !selected.groupId" class="zone-remove" :disabled="busy" @click="removing=true">移除此 Zone…</button>
        <div v-else-if="removing && !selected.groupId" class="zone-confirm" role="alertdialog" aria-label="确认移除 Zone"><p>停止「{{ selected.name }}」并从列表移除？其他 Zone 不受影响。</p>
          <button :disabled="busy" @click="remove">停止并移除</button><button :disabled="busy" @click="removing=false">取消</button></div>
      </template>
      <details v-if="!selected.groupId && selected.queue && data && data.zones.length > 1" class="zone-handoff"><summary>接力到另一个 Zone</summary>
        <p>源会话先暂停，队列和当前位置复制到目标；目标保留自己的 DSP 和音量。</p>
        <label class="zone-slider">目标会话
          <select v-model="handoffTargetId" :disabled="busy" @change="replaceTarget=false; resumeTarget=false">
            <option value="" disabled>选择目标 Zone</option>
            <option v-for="zone in data.zones.filter(z => z.id !== selectedId && !z.groupId)" :key="zone.id" :value="zone.id">{{ zone.name }}</option>
          </select></label>
        <template v-if="handoffTarget">
          <p v-if="handoffTarget.queue">目标现有：{{ handoffTarget.track?.title || '播放队列' }} · {{ handoffTarget.queue.total }} 首</p>
          <label v-if="handoffTarget.queue" class="zone-toggle"><input v-model="replaceTarget" type="checkbox" :disabled="busy" />确认替换目标现有队列</label>
          <label class="zone-toggle"><input v-model="resumeTarget" type="checkbox" :disabled="busy || (handoffTarget.output?.selected && !handoffTarget.output?.connected)" />在目标输出继续播放</label>
          <button :disabled="busy || (!!handoffTarget.queue && !replaceTarget)" @click="handoff">{{ resumeTarget ? '接力并继续播放' : '接力并暂停' }}</button>
        </template>
      </details>
    </div>
    <form class="zone-form zone-create" @submit.prevent="create"><input v-model="name" aria-label="新 Zone 名称" maxlength="80" placeholder="新会话名称，例如：书房" :disabled="busy || !!data?.error" />
      <button type="submit" :disabled="busy || !data || !!data.error || data.zones.length >= data.limit || !name.trim()">新建 Zone</button></form>
    <p v-if="notice" role="status">{{ notice }}</p>
  </section>
  <SyncGroupsPanel />
</template>

<style scoped>
.zone-sessions { border-top: 1px solid var(--border-color, #8884); margin-top: 24px; padding-top: 20px; color: var(--text-primary); }
header, .zone-form, .zone-controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; } header { justify-content:space-between; } h3 { margin:0; font-size:16px; } header span, small { color:var(--text-secondary); font-size:12px; }
p { font-size:13px; line-height:1.6; color:var(--text-secondary); margin:8px 0; } button,input { font:inherit; font-size:13px; color:inherit; } button, input:not([type=range]):not([type=checkbox]) { padding:10px 12px; border-radius:9px; border:1px solid var(--border-color,#8884); background:var(--bg-secondary,transparent); } button { cursor:pointer; } button:disabled { opacity:.45; cursor:default; } button[aria-pressed=true] { border-color:var(--accent-color,var(--te-accent-cyan)); }
.zone-tabs { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }.zone-tabs button { display:grid; gap:4px; text-align:left; min-width:112px; }.zone-detail { margin:16px 0; } .zone-now { display:grid; gap:4px; margin-bottom:12px; } .zone-now strong { font-size:15px; } .zone-now span { font-size:13px; color:var(--text-secondary); }
.zone-slider { display:grid; gap:8px; font-size:13px; margin:16px 0; max-width:400px; } input[type=range] { width:100%; accent-color:var(--accent-color); } .zone-toggle { display:flex; gap:8px; margin:12px 0; font-size:13px; } .zone-form input { flex:1; min-width:160px; } details { margin:16px 0; } summary { font-size:13px; cursor:pointer; } .zone-create { margin-top:20px; } .zone-error { color:var(--error-color,var(--te-control-danger,#cc5650)); overflow-wrap:anywhere; } .zone-remove { margin-top:8px; } .zone-confirm button { margin:8px 8px 0 0; }
button:focus-visible,input:focus-visible,summary:focus-visible { outline:2px solid var(--accent-color);outline-offset:3px; }
select { font:inherit; font-size:13px; color:inherit; background:var(--bg-secondary); border:1px solid var(--border-color,#8884); border-radius:9px; padding:10px 12px; }
input[type=checkbox],input[type=range] { accent-color:var(--accent-color,var(--te-accent-cyan,#74ae98)); }
@media(max-width:600px){.zone-form{align-items:stretch;flex-direction:column}.zone-form input{min-width:0}.zone-tabs button{flex:1}}
</style>
