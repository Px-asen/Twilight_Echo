<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { zoneQueueFence, type ZonesView, type ZoneTransport } from '../../../../shared/coreZones.ts'
import type { SyncGroupsView, SyncGroupView } from '../../../../shared/coreSyncGroups.ts'
import type { CoreSignalPath } from '../../../../shared/remoteDsp.ts'
import CoreSignalPathView from './CoreSignalPathView.vue'

const core = useCoreConnection()
const zones = ref<ZonesView | null>(null), data = ref<SyncGroupsView | null>(null)
const name = ref(''), members = ref<string[]>([]), sourceId = ref(''), delays = ref<Record<string, number>>({})
const error = ref(''), notice = ref(''), pending = ref(0), halting = ref(false), removing = ref('')
const progress = ref('')
const busy = computed(() => pending.value > 0)
const available = computed(() => zones.value?.zones.filter(z => !z.groupId) ?? [])
const sources = computed(() => available.value.filter(z => members.value.includes(z.id) && zoneQueueFence(z.queue)))
const valid = computed(() => name.value.trim() && members.value.length >= 2 && sources.value.some(z => z.id === sourceId.value) &&
  members.value.every(id => Number.isFinite(delays.value[id] ?? 0) && (delays.value[id] ?? 0) >= 0 && (delays.value[id] ?? 0) <= 250))
const path = ref<CoreSignalPath | null>(null), pathGroup = ref(''), pathMember = ref('')
const searches = ref<Record<string, string>>({})
const phase = (g: SyncGroupView) => ({ paused: '已暂停', preparing: '共同预缓冲', armed: '已调度起播', playing: '同步播放中',
  rebuffering: '共同重缓冲', completed: '队列已结束', failed: '需要恢复' }[g.coordination?.phase ?? 'paused'])
const zone = (id: string) => zones.value?.zones.find(z => z.id === id)
const ready = (g: SyncGroupView) => g.members.every(m => zone(m.zoneId)?.output?.connected && zone(m.zoneId)?.output?.receiver?.adaptiveSupported)
const time = (seconds = 0) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
let timer: ReturnType<typeof setInterval> | undefined, reading = false, disposed = false, sequence = 0
async function refresh() {
  if (disposed || reading || busy.value || core.state.value?.phase !== 'ready') return
  reading = true
  try {
    const [outputs, groups] = await Promise.all([core.query('zones.list', {}), core.query('groups.list', {})])
    if (disposed) return
    zones.value = outputs; data.value = groups
    members.value = members.value.filter(id => available.value.some(z => z.id === id))
    if (!sources.value.some(z => z.id === sourceId.value)) sourceId.value = sources.value[0]?.id ?? ''
    if (pathGroup.value && groups.groups.some(g => g.id === pathGroup.value)) {
      const next = await core.query('groups.signalPath', { groupId: pathGroup.value, zoneId: pathMember.value })
      if (!disposed) path.value = next
    } else path.value = null
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : '无法读取同步组' }
  finally { reading = false }
}
async function run(action: () => Promise<unknown>, pendingText = '') {
  const own = ++sequence
  pending.value++; error.value = ''; notice.value = ''; progress.value = pendingText
  try { await action() } catch (cause) { if (own === sequence) error.value = cause instanceof Error ? cause.message : '操作未成功，请刷新后确认状态' }
  finally { pending.value--; if (own === sequence) progress.value = ''; await refresh() }
}
function toggleSource() { if (!sources.value.some(z => z.id === sourceId.value)) sourceId.value = sources.value[0]?.id ?? '' }
function create() {
  const source = sources.value.find(z => z.id === sourceId.value)
  if (!valid.value || !zones.value || !source) return
  const payload = { revision: zones.value.revision, name: name.value.trim(), source: { zoneId: source.id, queue: zoneQueueFence(source.queue)! },
    members: members.value.map(id => ({ zoneId: id, revision: zone(id)!.revision, downstreamDelayMs: delays.value[id] ?? 0 })) }
  return run(async () => {
    await core.command('groups.create', payload)
    name.value = ''; members.value = []; sourceId.value = ''; notice.value = '同步组已建立，队列暂停待播。各输出原来的独立队列保留。'
  })
}
function transport(group: SyncGroupView, action: ZoneTransport) {
  return run(() => core.command('groups.transport', { groupId: group.id, revision: group.revision, action }), action.kind === 'play' ? '正在为全部成员预缓冲…' : '')
}
async function interrupt(groupId: string, kind: 'pause' | 'stop') {
  if (halting.value) return
  halting.value = true
  try { await run(() => core.command('groups.transport', { groupId, revision: null, action: { kind } })) }
  finally { halting.value = false }
}
function remove(group: SyncGroupView) { return run(async () => {
  await core.command('groups.remove', { groupId: group.id, revision: group.revision }); removing.value = ''
  notice.value = '已解除编组。各输出回到原独立队列，保持暂停。'
}) }
function prepare(group: SyncGroupView) { return run(async () => {
  const search = searches.value[group.id]?.trim()
  await core.command('groups.queueFromQuery', { groupId: group.id, revision: group.revision,
    query: { ...(search ? { search, searchLiteral: true } : {}), sort: 'insertion', direction: 'asc' } })
  notice.value = '已替换组队列并暂停。'
}) }
function showPath(groupId: string, zoneId: string) {
  pathGroup.value = groupId; pathMember.value = zoneId; path.value = null; void refresh()
}
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 1000) })
onBeforeUnmount(() => { disposed = true; clearInterval(timer) })
</script>

<template>
  <section class="sync-groups" aria-label="同步组">
    <header><div><h3>同步组</h3><p>同一队列、同一时间线，发送到多台输出电脑。</p></div><span class="tag">时钟自适应 PCM</span></header>
    <p v-if="error || data?.error" class="error" role="alert">{{ error || data?.error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="progress" role="status">{{ progress }}</p>
    <article v-for="group in data?.groups" :key="group.id" class="group" :aria-label="group.name">
      <header><h4>{{ group.name }}</h4><span class="phase" role="status">{{ phase(group) }}</span></header>
      <div class="now"><strong>{{ group.track?.title || '组队列为空' }}</strong><span>{{ group.track?.artist }}</span></div>
      <div class="controls" aria-label="同步组播放控制">
        <button :disabled="busy || !ready(group) || !group.queue" @click="transport(group,{kind:'play'})">一起播放</button>
        <button :disabled="halting" @click="interrupt(group.id,'pause')">全部暂停</button>
        <button :disabled="halting" @click="interrupt(group.id,'stop')">全部停止</button>
        <button :disabled="busy || !ready(group) || !group.queue" @click="transport(group,{kind:'previous'})">上一首</button>
        <button :disabled="busy || !ready(group) || !group.queue" @click="transport(group,{kind:'next'})">下一首</button>
      </div>
      <label class="slider">共同位置 · {{ time(group.playback?.position) }} / {{ time(group.playback?.duration) }}
        <input type="range" min="0" :max="group.playback?.duration || 1" step="0.1" :value="group.playback?.position || 0"
          :disabled="busy || !ready(group) || !group.queue" @change="transport(group,{kind:'seek',position:Number(($event.target as HTMLInputElement).value)})" /></label>
      <label class="slider">组音量 · {{ Math.round((group.playback?.volume ?? .5)*100) }}%
        <input type="range" min="0" max="1" step="0.01" :value="group.playback?.volume ?? .5" :disabled="busy || !group.playback"
          @change="transport(group,{kind:'volume',volume:Number(($event.target as HTMLInputElement).value)})" /></label>
      <p v-if="group.error" class="error" role="status">{{ group.error }}</p>
      <p v-if="!ready(group)">请在对应 Zone 的输出面板重连支持时钟自适应的 Bridge，再明确播放；不会自动换用本机扬声器。</p>
      <ul class="members"><li v-for="member in group.members" :key="member.zoneId">
        <div><strong>{{ zone(member.zoneId)?.name || member.zoneId }}</strong><span>{{ zone(member.zoneId)?.output?.connected ? '已连接' : '未连接' }} · 下游补偿 {{ member.downstreamDelayMs }} ms</span></div>
        <button :disabled="busy || !group.playback" @click="showPath(group.id,member.zoneId)">信号链</button>
      </li></ul>
      <p v-if="group.coordination?.estimatedSkewMs != null">组间估计偏差 {{ group.coordination.estimatedSkewMs.toFixed(2) }} ms · 观测范围 {{ (group.coordination.observationRangeMs ?? 0).toFixed(2) }} ms</p>
      <CoreSignalPathView v-if="path && pathGroup === group.id" :path="path" />
      <details><summary>替换组队列</summary><p>按曲库搜索建立共同队列，替换后暂停。留空使用整个曲库。</p>
        <div class="form"><input v-model="searches[group.id]" aria-label="同步组曲库搜索" placeholder="搜索曲名、艺术家或专辑" maxlength="512" :disabled="busy" />
          <button :disabled="busy || !group.playback" @click="prepare(group)">载入并暂停</button></div></details>
      <button v-if="removing !== group.id" :disabled="busy" @click="removing=group.id">解除编组…</button>
      <div v-else class="confirm" role="alertdialog" aria-label="确认解除同步组"><p>停止「{{ group.name }}」并解除？各输出恢复自己的原独立队列，保持暂停，不采用组队列。</p>
        <button :disabled="busy" @click="remove(group)">全部停止并解除</button><button :disabled="busy" @click="removing=''">取消</button></div>
    </article>
    <details v-if="available.length >= 2" class="create"><summary>建立同步组</summary>
      <p>先选择输出，再选择要共同播放的队列。编组会暂停成员；各自 DSP 保持独立。</p>
      <form @submit.prevent="create">
        <label class="field">组名<input v-model="name" placeholder="例如：全屋音乐" maxlength="80" :disabled="busy" /></label>
        <fieldset :disabled="busy"><legend>输出成员</legend><div v-for="output in available" :key="output.id" class="candidate">
          <label><input v-model="members" type="checkbox" :value="output.id" @change="toggleSource" />{{ output.name }}<span>{{ output.output?.connected ? '已连接' : '离线，可先编组' }}</span></label>
          <label v-if="members.includes(output.id)" class="delay">下游延迟 <input v-model.number="delays[output.id]" type="number" min="0" max="250" step="0.1" placeholder="0" :aria-label="`${output.name}下游延迟，毫秒`" /> ms</label>
        </div></fieldset>
        <label class="field">采用哪份队列<select v-model="sourceId" :disabled="busy || !sources.length"><option value="" disabled>选择有队列的成员</option>
          <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }} · {{ source.track?.title || '播放队列' }}</option></select></label>
        <p>下游延迟限 0–250 ms；填 0 表示尚未校准 DAC 模拟输出延迟。同步播放需要所有成员连接支持时钟自适应的 Bridge。</p>
        <button type="submit" :disabled="busy || !valid || !!data?.error">建立并暂停</button>
      </form>
    </details>
    <p v-else-if="!data?.groups.length">先建立至少两个独立 Zone 并载入一份曲库队列，即可编组。</p>
  </section>
</template>

<style scoped>
.sync-groups{border-top:1px solid var(--border-color,#8884);margin-top:24px;padding-top:20px;color:var(--text-primary)}
header,.controls,.form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header{justify-content:space-between}h3,h4{margin:0;font-size:16px}p{font-size:13px;line-height:1.6;color:var(--text-secondary);margin:8px 0}
.tag,.phase{font-size:12px;color:var(--text-secondary)}.group{padding:18px 0;border-bottom:1px solid var(--border-color,#8884)}.group:last-of-type{border-bottom:0}.now{display:grid;gap:4px;margin:14px 0}.now strong{font-size:15px}.now span{font-size:13px;color:var(--text-secondary)}
button,input,select{font:inherit;font-size:13px;color:inherit}button,input:not([type=range]):not([type=checkbox]),select{border:1px solid var(--border-color,#8884);border-radius:9px;background:var(--bg-secondary,transparent);padding:10px 12px}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent-color);outline-offset:3px}
.slider,.field{display:grid;gap:8px;font-size:13px;margin:16px 0;max-width:420px}input[type=range]{width:100%}input[type=range],input[type=checkbox]{accent-color:var(--accent-color)}.members{list-style:none;margin:16px 0;padding:0}.members li{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 0}.members li div{display:grid;gap:5px;font-size:13px}.members span{font-size:12px;color:var(--text-secondary)}details{margin:16px 0}summary{font-size:13px;cursor:pointer}.form input{flex:1;min-width:160px}.error{color:var(--error-color,#cf665f);overflow-wrap:anywhere}.confirm button{margin:8px 8px 0 0}
fieldset{border:0;padding:0;margin:20px 0}legend{font-size:13px;margin-bottom:10px}.candidate{padding:10px 0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.candidate>label{display:flex;align-items:center;gap:8px;font-size:13px}.candidate span{font-size:12px;color:var(--text-secondary)}.delay input{width:76px}.delay{color:var(--text-secondary)}
@media(max-width:600px){.controls button{flex:1;white-space:nowrap}.form{align-items:stretch;flex-direction:column}.form input{min-width:0}.candidate{display:grid}.tag{display:none}}
</style>
