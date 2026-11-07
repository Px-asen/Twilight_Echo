<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useCoreConnection } from '@renderer/stores/coreConnection.ts'
import { useAppNoticeStore } from '@renderer/stores/useAppNoticeStore.ts'
import { parseBridgeInvitation, type CoreZoneState, type BridgeWireFormat } from '../../../../shared/audioBridge.ts'
import { moveRadioFocus } from './radioFocus.ts'

/**
 * Where this computer's main session sounds, and whether this computer may act
 * as an output Bridge for another Core. Ported from the settings panel's rules.
 */
const core = useCoreConnection()
const notices = useAppNoticeStore()
const zone = ref<CoreZoneState | null>(null)
const invitation = ref('')
const peerInput = ref('')
const sampleRate = ref(48000)
const wireFormat = ref<BridgeWireFormat>('float32-le')
const channels = ref(2)
const busy = ref(false)
const error = ref('')
const revealed = ref(false)
const rates = computed(() => wireFormat.value === 'float32-le' ? [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000]
  : wireFormat.value === 'dop-int24-le' ? [176400, 192000, 352800, 384000, 705600, 768000, 1411200, 1536000]
    : [2822400, 3072000, 5644800, 6144000, 11289600, 12288000, 22579200, 24576000])
watch(wireFormat, () => { if (!rates.value.includes(sampleRate.value)) sampleRate.value = rates.value[0] })

let timer: ReturnType<typeof setInterval> | undefined
let disposed = false
let reading = false

async function refresh(): Promise<void> {
  if (reading || busy.value || disposed || core.state.value?.phase !== 'ready') return
  reading = true
  try {
    const next = await core.query('zones.state', {})
    if (disposed) return
    zone.value = next
    if (next.hosting && next.receiver) {
      const wire = next.receiver.wireFormat ?? 'float32-le'
      wireFormat.value = wire.startsWith('dsd-') ? 'dsd-int8-lsb1' : wire
      sampleRate.value = next.receiver.sampleRate
      channels.value = next.receiver.channels
    }
    if (!next.hosting) invitation.value = ''
    else if (!invitation.value) {
      const grant = await core.query('bridge.invitation', {})
      if (!disposed) invitation.value = grant.invitation ?? ''
    }
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : '无法读取输出桥状态'
  } finally {
    reading = false
  }
}

async function run(action: () => Promise<unknown>, success?: string): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await action()
    if (success) notices.pushNotice({ kind: 'success', message: success })
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败'
  } finally {
    busy.value = false
    await refresh()
  }
}

const outputs = computed(() => zone.value?.outputs ?? [])
const paired = computed(() => outputs.value.some((output) => output.id === 'bridge'))
/**
 * Options the main session cannot move to. Core only lets a grouped main session
 * reconnect its bridge; switching to local would pull it out of the group's timing.
 */
function outputBlocked(id: 'local' | 'bridge', available: boolean): boolean {
  const state = zone.value
  if (!state || !available) return true
  return Boolean(state.groupId) && id === 'local'
}
/** The checked option is a no-op, except a dropped bridge where a click reconnects. */
function outputSettled(id: 'local' | 'bridge'): boolean {
  const state = zone.value
  if (!state || state.selectedOutputId !== id) return false
  return id === 'local' || state.connected
}
function outputBroken(id: 'local' | 'bridge'): boolean {
  const state = zone.value
  return id === 'bridge' && state?.selectedOutputId === 'bridge' && !state.connected
}
function outputCaption(id: 'local' | 'bridge', available: boolean): string {
  const state = zone.value
  if (!state) return ''
  const chosen = state.selectedOutputId === id
  if (id === 'local') {
    if (chosen) return '正在使用'
    if (!available) return '仅可使用输出桥'
    return state.groupId ? '编组期间不可切换' : '此电脑的声卡'
  }
  // Core lists the bridge only once a peer was paired; its name is already the label.
  if (!chosen) return '已配对的输出桥'
  return state.connected ? '已连接，正在使用' : '连接中断，点按重连'
}
function choose(outputId: 'local' | 'bridge'): void {
  const state = zone.value
  if (!state || busy.value || outputSettled(outputId)) return
  const reconnect = outputId === 'bridge' && state.selectedOutputId === 'bridge'
  void run(
    () => core.command('zones.select', { revision: state.revision, outputId }),
    reconnect ? '已重新连接输出桥' : outputId === 'local' ? '主会话改用本机输出' : '主会话改用输出桥'
  )
}
const peerError = computed(() => {
  const value = peerInput.value.trim()
  if (!value) return ''
  try {
    parseBridgeInvitation(value)
    return ''
  } catch {
    return '这不是有效的输出桥邀请'
  }
})
function connectPeer(): Promise<void> {
  return run(async () => {
    const peer = parseBridgeInvitation(peerInput.value)
    await core.command('bridge.connect', { revision: zone.value!.revision, peer })
    peerInput.value = ''
  }, '已连接输出桥，播放时由此电脑解码和处理')
}
function toggleHost(): Promise<void> {
  return run(async () => {
    const enabled = !zone.value!.hosting
    await core.command('bridge.host', {
      revision: zone.value!.revision,
      enabled,
      sampleRate: sampleRate.value,
      wireFormat: wireFormat.value,
      channels: channels.value
    })
    revealed.value = false
    invitation.value = enabled ? ((await core.query('bridge.invitation', {})).invitation ?? '') : ''
  })
}
async function copyInvitation(): Promise<void> {
  try {
    await navigator.clipboard.writeText(invitation.value)
    notices.pushNotice({ kind: 'success', message: '邀请已复制，只发送给你信任的电脑' })
  } catch {
    error.value = '复制失败，请手动复制邀请'
  }
}

const hostState = computed(() => {
  const state = zone.value
  if (!state) return { label: '读取中', tone: 'neutral' }
  if (state.hosting) return state.receiving
    ? { label: '正在接收', tone: 'success' }
    : { label: '等待连接', tone: 'info' }
  if (state.selected) return state.connected
    ? { label: '输出桥已连接', tone: 'success' }
    : { label: '连接中断', tone: 'danger' }
  return { label: '本机输出', tone: 'neutral' }
})

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), 1500)
})
onBeforeUnmount(() => {
  disposed = true
  clearInterval(timer)
})
</script>

<template>
  <section class="zones-host" aria-labelledby="zones-host-title">
    <header class="zones-section-head">
      <div>
        <h2 id="zones-host-title">本机输出与输出桥</h2>
        <p>此电脑主会话的声音从哪里出来，以及是否接收另一台电脑的音乐。</p>
      </div>
      <span class="zones-chip" :class="`is-${hostState.tone}`">{{ hostState.label }}</span>
    </header>

    <p v-if="zone && !zone.supported" class="zones-inline-note" role="status">
      <i class="ph ph-info" aria-hidden="true" />当前原生引擎不含输出桥，请更新或重新构建桌面端。
    </p>

    <div class="zones-host-grid">
      <article class="zones-panel zones-host-output">
        <header class="zones-panel-head">
          <div>
            <h3>主会话的出口</h3>
            <p>{{ zone?.hosting ? '接收模式下，此电脑只作为输出桥发声' : '选择此电脑主会话的声音出口，切换时会停止播放' }}</p>
          </div>
        </header>
        <div
          v-if="zone && !zone.hosting"
          class="zones-output-options"
          role="radiogroup"
          aria-label="主会话的输出"
          @keydown="moveRadioFocus"
        >
          <button
            v-for="output in outputs"
            :key="output.id"
            type="button"
            role="radio"
            class="zones-output-option"
            :class="{ 'is-broken': outputBroken(output.id) }"
            :aria-checked="zone.selectedOutputId === output.id"
            :disabled="busy || outputBlocked(output.id, output.available)"
            @click="choose(output.id)"
          >
            <span class="zones-output-glyph" aria-hidden="true">
              <i class="ph" :class="output.id === 'local' ? 'ph-desktop' : 'ph-broadcast'" />
            </span>
            <span class="zones-output-copy">
              <strong>{{ output.name }}</strong>
              <small>{{ outputCaption(output.id, output.available) }}</small>
            </span>
            <i
              v-if="zone.selectedOutputId === output.id"
              class="ph-bold ph-check zones-output-check"
              aria-hidden="true"
            />
          </button>
        </div>
        <p v-if="zone?.groupId" class="zones-hint">主会话已加入同步组，请在上方的同步组里控制播放；重连不会自动播放。</p>
        <p v-if="zone?.error" class="zones-inline-error" role="status">
          <i class="ph ph-warning-circle" aria-hidden="true" />{{ zone.error }}
        </p>

        <form v-if="zone?.supported && !zone.hosting" class="zones-peer-form" @submit.prevent="connectPeer">
          <label for="zones-host-peer">{{ paired ? '换用另一台电脑的输出桥' : '连接另一台电脑的输出桥' }}</label>
          <div class="zones-field-row">
            <span class="zones-field" :class="{ 'is-invalid': Boolean(peerError) }">
              <i class="ph ph-link-simple" aria-hidden="true" />
              <input
                id="zones-host-peer"
                v-model="peerInput"
                type="password"
                maxlength="2048"
                autocomplete="off"
                spellcheck="false"
                placeholder="twilight-bridge://…"
                :disabled="busy"
                :aria-invalid="Boolean(peerError) || undefined"
                aria-describedby="zones-host-peer-hint"
              />
            </span>
            <button
              type="submit"
              class="zones-pill is-ink"
              :disabled="busy || !peerInput.trim() || Boolean(peerError)"
            >
              连接并使用
            </button>
          </div>
          <p id="zones-host-peer-hint" class="zones-hint" :class="{ 'is-error': Boolean(peerError) }">
            {{ peerError || '在另一台电脑开启「允许此电脑作为输出桥」，复制邀请后粘贴到这里。连接后按协商格式加密传送音频。' }}
          </p>
        </form>
      </article>

      <article class="zones-panel zones-host-receive">
        <header class="zones-panel-head">
          <div>
            <h3>作为输出桥</h3>
            <p>让另一台电脑把音乐送到这台电脑的 DAC</p>
          </div>
        </header>
        <div class="zones-receive-row">
          <span class="zone-switch-copy">
            <strong id="zones-host-switch">允许此电脑作为输出桥</strong>
            <small>先在音频设置中明确选择 DAC。开启后停止本机播放；关闭即撤销邀请和连接。</small>
          </span>
          <button
            type="button"
            role="switch"
            class="zones-switch"
            :aria-checked="Boolean(zone?.hosting)"
            aria-labelledby="zones-host-switch"
            :disabled="!zone?.supported || busy || zone?.selected"
            :title="zone?.selected ? '主会话正在使用输出桥，先改回本机输出' : undefined"
            @click="toggleHost"
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <label class="zones-select-row">
          <span>接收格式</span>
          <select v-model="wireFormat" class="zones-select" :disabled="busy || zone?.hosting">
            <option value="float32-le">PCM · Float32</option>
            <option value="dop-int24-le">DoP · DSD over PCM</option>
            <option value="dsd-int8-lsb1">原生 DSD</option>
          </select>
        </label>
        <label class="zones-select-row">
          <span>声道布局</span>
          <select v-model="channels" class="zones-select" :disabled="busy || zone?.hosting">
            <option :value="1">单声道</option><option :value="2">双声道</option>
            <option :value="6">5.1 · 侧环绕</option><option :value="8">7.1</option>
          </select>
        </label>
        <label class="zones-select-row">
          <span>接收采样率</span>
          <select v-model="sampleRate" class="zones-select" :disabled="busy || zone?.hosting">
            <option v-for="rate in rates" :key="rate" :value="rate">{{ rate >= 2822400 ? `${rate / 1000000} MHz` : `${rate / 1000} kHz` }}</option>
          </select>
        </label>
        <p v-if="wireFormat !== 'float32-le'" class="zones-hint">DSD／DoP 需要匹配的 DSD 音源、Core 单位增益且不启用 PCM 处理。DoP 需独占输出及支持 DoP 的 DAC；原生 DSD 需驱动明确支持。DSD 和多声道暂不加入同步组。</p>
        <p v-else-if="channels !== 2" class="zones-hint">按所选布局发送，DAC 必须支持相同声道数及布局，不自动降为双声道。多声道暂不加入同步组。</p>
        <div v-if="invitation && zone?.hosting" class="zones-invitation">
          <span class="zones-field">
            <i class="ph ph-key" aria-hidden="true" />
            <input
              :value="invitation"
              :type="revealed ? 'text' : 'password'"
              readonly
              aria-label="输出桥邀请"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <button
              type="button"
              class="zones-field-action"
              :aria-pressed="revealed"
              @click="revealed = !revealed"
            >
              {{ revealed ? '隐藏' : '显示' }}
            </button>
          </span>
          <button type="button" class="zones-pill is-outline" @click="copyInvitation">
            <i class="ph ph-copy" aria-hidden="true" />复制邀请
          </button>
        </div>
        <p v-if="zone?.hosting" class="zones-hint">邀请等同于访问权限，只发送给你信任的电脑。</p>
      </article>
    </div>
    <p v-if="error" class="zones-inline-error" role="alert">
      <i class="ph ph-warning-circle" aria-hidden="true" />{{ error }}
    </p>
  </section>
</template>
