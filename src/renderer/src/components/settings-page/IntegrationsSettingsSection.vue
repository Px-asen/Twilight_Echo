<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import QRCode from 'qrcode'
import SettingsGroup from './SettingsGroup.vue'
import type { RemoteControlStatus } from '../../../../shared/remoteControl.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'

const core = useCoreConnection()

const props = defineProps<{
  discordEnabled: boolean
  remoteEnabled: boolean
}>()

const emit = defineEmits<{
  'update:discordEnabled': [enabled: boolean]
  'update:remoteEnabled': [enabled: boolean]
}>()

const remoteStatus = ref<RemoteControlStatus | null>(null)
const remoteStatusError = ref('')
const remoteBusy = ref(false)
const remoteQrDataUrl = ref('')
const remoteQrUrl = ref('')
const discordStatus = ref<{
  enabled: boolean
  connected: boolean
  lastError: string | null
} | null>(null)
const notice = ref('')

let discordStatusTimer: number | null = null
let remoteStatusTimer: number | null = null

async function refreshDiscordStatus(): Promise<void> {
  try {
    if (!window.api?.discord?.getStatus) {
      discordStatus.value = null
      return
    }
    discordStatus.value = await window.api.discord.getStatus()
  } catch {
    discordStatus.value = null
  }
}

const discordStatusText = computed(() => {
  if (!props.discordEnabled) return '已关闭'
  if (!discordStatus.value) return '状态未知'
  if (discordStatus.value.connected) return '已连接'
  return discordStatus.value.lastError
    ? `未连接：${discordStatus.value.lastError}`
    : '未连接（等待 Discord）'
})

async function refreshRemoteStatus(): Promise<void> {
  remoteStatusError.value = ''
  try {
    remoteStatus.value = await core.query('remote.status', {})
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  }
}

async function refreshRemoteQr(urls: string[] | undefined | null): Promise<void> {
  const primary = urls?.find((u) => typeof u === 'string' && u.trim()) ?? ''
  if (!primary) {
    remoteQrDataUrl.value = ''
    remoteQrUrl.value = ''
    return
  }
  if (primary === remoteQrUrl.value && remoteQrDataUrl.value) return
  try {
    remoteQrDataUrl.value = await QRCode.toDataURL(primary, {
      margin: 1,
      width: 160,
      errorCorrectionLevel: 'M'
    })
    remoteQrUrl.value = primary
  } catch {
    remoteQrDataUrl.value = ''
    remoteQrUrl.value = ''
  }
}

watch(
  () => remoteStatus.value?.urls,
  (urls) => {
    void refreshRemoteQr(urls)
  },
  { deep: true }
)

watch(
  () => props.remoteEnabled,
  (enabled) => {
    if (!enabled) {
      remoteQrDataUrl.value = ''
      remoteQrUrl.value = ''
    }
  }
)

function toggleDiscord(): void {
  emit('update:discordEnabled', !props.discordEnabled)
  window.setTimeout(() => {
    void refreshDiscordStatus()
  }, 400)
}

async function toggleRemote(): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try {
    const next = !props.remoteEnabled
    remoteStatus.value = (await core.command('remote.setEnabled', {
      enabled: next
    })) as RemoteControlStatus
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  } finally {
    remoteBusy.value = false
  }
}

async function rotateRemotePin(): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try {
    const result = (await core.command('remote.rotatePin', {})) as { status: RemoteControlStatus }
    remoteStatus.value = result.status
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  } finally {
    remoteBusy.value = false
  }
}

async function decideRemotePairing(requestId: string, allow: boolean): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try { remoteStatus.value = await core.command('remote.decidePairing', { requestId, allow }) as RemoteControlStatus }
  catch (err) { remoteStatusError.value = err instanceof Error ? err.message : String(err) }
  finally { remoteBusy.value = false }
}

async function revokeRemoteDevice(id: string): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try { remoteStatus.value = await core.command('remote.revokeDevice', { id }) as RemoteControlStatus }
  catch (err) { remoteStatusError.value = err instanceof Error ? err.message : String(err) }
  finally { remoteBusy.value = false }
}

async function copyRemoteUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url)
    notice.value = '已复制远程地址'
  } catch {
    notice.value = url
  }
}

onMounted(() => {
  void refreshRemoteStatus()
  void refreshDiscordStatus()
  discordStatusTimer = window.setInterval(() => {
    if (props.discordEnabled) void refreshDiscordStatus()
  }, 8_000)
  remoteStatusTimer = window.setInterval(() => {
    if (props.remoteEnabled && !remoteBusy.value) void refreshRemoteStatus()
  }, 3_000)
})

onBeforeUnmount(() => {
  if (remoteStatusTimer !== null) window.clearInterval(remoteStatusTimer)
  if (discordStatusTimer !== null) {
    window.clearInterval(discordStatusTimer)
    discordStatusTimer = null
  }
})
</script>

<template>
  <SettingsGroup
    id="external-connections"
    title="社交与远程控制"
    :summary="
      'Discord：' + discordStatusText + ' · 远程控制：' + (remoteEnabled ? '已开启' : '已关闭')
    "
    :attention="
      remoteStatusError ||
      remoteStatus?.lastError ||
      discordStatus?.lastError ||
      (remoteBusy ? '正在更新远程连接…' : '')
    "
    description="需要分享听歌状态，或从同一局域网的手机控制播放时展开。"
  >
    <div class="section-block">
      <h3>社交与远程控制</h3>
      <div class="setting-list">
        <div data-setting-id="discord" id="setting-discord" class="setting-item">
          <div class="setting-copy">
            <strong>Discord Rich Presence <i class="pi pi-discord discord-icon"></i></strong>
            <span>在 Discord 状态中向好友展示您正在播放的音乐。</span>
            <span class="setting-substatus" aria-live="polite">{{ discordStatusText }}</span>
          </div>
          <button
            type="button"
            aria-label="Discord Rich Presence"
            class="toggle-switch"
            :class="{ active: props.discordEnabled, inactive: !props.discordEnabled }"
            role="switch"
            :aria-checked="props.discordEnabled"
            @click="toggleDiscord"
          ></button>
        </div>
        <hr />
        <div
          data-setting-id="remote-control"
          id="setting-remote-control"
          class="setting-item top-align"
        >
          <div class="setting-copy">
            <strong>局域网远程控制</strong>
            <span>
              开启后，Android 可自动发现这台电脑。首次连接在电脑确认，之后直接重连。
            </span>
          </div>
          <button
            type="button"
            aria-label="局域网远程控制"
            class="toggle-switch"
            :class="{
              active: props.remoteEnabled,
              inactive: !props.remoteEnabled
            }"
            role="switch"
            :aria-checked="props.remoteEnabled"
            :aria-busy="remoteBusy"
            :disabled="remoteBusy"
            @click="toggleRemote"
          ></button>
        </div>
        <div
          data-setting-id="remote-pairing"
          id="setting-remote-pairing"
          v-if="props.remoteEnabled"
          class="setting-item top-align remote-control-panel"
        >
          <div class="setting-copy">
            <strong>{{ remoteStatus?.serverName || '这台电脑' }}</strong>
            <span>
              状态：
              {{ remoteStatus?.running ? `运行中 · 端口 ${remoteStatus.port ?? '—'}` : '未运行' }}
              <template v-if="remoteStatus?.paired"> · 已配对</template>
              <template v-if="(remoteStatus?.clientCount ?? 0) > 0">
                · {{ remoteStatus?.clientCount }} 客户端
              </template>
            </span>
            <span class="setting-substatus" role="status">
              {{ remoteStatus?.discovery === 'advertising' ? '手机可在同一局域网自动发现' : remoteStatus?.discoveryError || '局域网发现未启动' }}
            </span>
            <div v-for="request in remoteStatus?.pairingRequests ?? []" :key="request.id" class="remote-device-row">
              <div>
                <strong>{{ request.deviceName }}</strong>
                <span>请求连接 · {{ request.address }}<template v-if="request.verificationCode"> · 验证码 {{ request.verificationCode }}</template></span>
              </div>
              <button type="button" class="soft-button" :disabled="remoteBusy" @click="decideRemotePairing(request.id, true)">允许连接</button>
              <button type="button" class="soft-button" :disabled="remoteBusy" @click="decideRemotePairing(request.id, false)">拒绝</button>
            </div>
            <div v-if="(remoteStatus?.trustedDevices?.length ?? 0) > 0" class="remote-devices">
              <strong>已授权设备</strong>
              <div v-for="device in remoteStatus?.trustedDevices ?? []" :key="device.id" class="remote-device-row">
                <span>{{ device.name }}</span>
                <button type="button" class="soft-button" :disabled="remoteBusy" @click="revokeRemoteDevice(device.id)">撤销授权</button>
              </div>
            </div>
            <details class="remote-manual-access"><summary>浏览器遥控与手动连接</summary>
            <div v-if="remoteStatus?.pin" class="remote-pin-row">
              <code class="remote-pin">{{ remoteStatus.pin }}</code>
              <button
                type="button"
                class="soft-button"
                :disabled="remoteBusy"
                @click="rotateRemotePin"
              >
                更换 PIN 并撤销全部授权
              </button>
              <button
                type="button"
                class="soft-button"
                :disabled="remoteBusy"
                @click="refreshRemoteStatus"
              >
                刷新
              </button>
            </div>
            <div
              v-if="remoteQrDataUrl || (remoteStatus?.urls?.length ?? 0) > 0"
              class="remote-access-row"
            >
              <div v-if="remoteQrDataUrl" class="remote-qr-block">
                <img
                  class="remote-qr"
                  :src="remoteQrDataUrl"
                  :alt="`远程控制二维码：${remoteQrUrl}`"
                  width="160"
                  height="160"
                />
                <span class="remote-qr-hint">手机扫码打开遥控页</span>
              </div>
              <ul v-if="(remoteStatus?.urls?.length ?? 0) > 0" class="remote-url-list">
                <li v-for="url in remoteStatus?.urls ?? []" :key="url">
                  <button type="button" class="linkish" @click="copyRemoteUrl(url)">
                    {{ url }}
                  </button>
                </li>
              </ul>
            </div>
            </details>
            <span v-if="remoteStatus?.lastError" class="remote-error">
              {{ remoteStatus.lastError }}
            </span>
            <span v-if="remoteStatusError" class="remote-error">{{ remoteStatusError }}</span>
            <span v-if="notice" class="setting-substatus">{{ notice }}</span>
          </div>
        </div>
      </div>
    </div>
  </SettingsGroup>
</template>

<style scoped>
.remote-device-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 0; }
.remote-device-row > :first-child { flex: 1; min-width: 160px; }
.remote-device-row > div { display: flex; flex-direction: column; gap: 4px; }
.remote-devices, .remote-manual-access { margin-top: 16px; }
.remote-manual-access summary { cursor: pointer; padding: 8px 0; }
</style>
