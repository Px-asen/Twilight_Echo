<script setup lang="ts">
import QRCode from 'qrcode'
import './contentArrival.css'
import ServerLoginForm from '@renderer/components/login/ServerLoginForm.vue'
import LoginDisclaimerDialog from '@renderer/components/login/LoginDisclaimerDialog.vue'
import { createVisibilityPollingController } from '../utils/visibilityPolling.ts'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useBackHandler } from '../app/useBackStack'
import { useNcmStore } from '../stores/useNcmStore'
import { useProviderStore, type ProviderInfo, type ProviderLoginState } from '../stores/useProviderStore'
import type { MediaProviderProfile } from '../providers/mediaProvider'

const props = defineProps<{
  forceProfile?: boolean
  initialProviderId?: string | null
}>()

const emit = defineEmits<{
  loginSuccess: []
  configure: []
}>()

const providerStore = useProviderStore()
const ncmStore = useNcmStore()

const POLL_INTERVAL = 5000
const QR_KEY_COOLDOWN = 5000
const SUCCESS_LINGER_MS = 1200

type PageState =
  | 'loading'
  | 'account_list'
  | 'logged_in'
  | 'login_notice'
  | 'qr_loading'
  | 'qr_ready'
  | 'qr_scanned'
  | 'qr_expired'
  | 'login_success'
  | 'error'

interface AccountState {
  available: boolean
  loggedIn: boolean
  profile: MediaProviderProfile | null
  error: string
}

interface ProviderCard {
  id: string
  name: string
  desc: string
  icon: string
  color?: string
  available: boolean
  loggedIn: boolean
  profile: MediaProviderProfile | null
  error: string
  needsSetup: boolean
}

const pageState = ref<PageState>('loading')
const activeProviderId = ref<string | null>(null)
const errorMsg = ref('')
const qrImage = ref('')
const qrKey = ref('')
const lastKeyGenTime = ref(0)
const authUrl = ref('') // OAuth device flow URL (for showBrowserButton providers)
const accountStates = ref<Record<string, AccountState>>({})
const serverLoginBusy = ref(false)
const serverLoginMessage = ref('')
const extraActionMethod = ref('')
const confirmLogout = ref(false)
const uidCopied = ref(false)

let pollTimer: ReturnType<typeof setInterval> | null = null
let uidCopiedTimer: ReturnType<typeof setTimeout> | null = null
let accountsInitialized = false
let disposed = false
let providerChangeRevision = 0
let providerRecoveryPending = false
let extraActionController: AbortController | null = null

/**
 * 声明了 login 能力的 provider 都显示在登录页。
 * authType 为 'settings' 的 provider（如 Apple Music）通过设置面板配置凭据，
 * 点击卡片时跳转到设置页，而不是进入二维码/账号登录流程。
 */
const loginProviders = computed<ProviderInfo[]>(() =>
  providerStore.providers.value.filter((p) => p.capabilities.includes('login'))
)

/** 默认 QR 状态码（兼容大多数 QR 登录流程） */
const DEFAULT_QR_STATUS_CODES = {
  waiting: 801,
  scanned: 802,
  expired: 800,
  denied: undefined as number | undefined,
  success: 803
}

const providerCards = computed<ProviderCard[]>(() =>
  loginProviders.value.map((provider) => {
    const state = accountStates.value[provider.id] ?? {
      available: false,
      loggedIn: false,
      profile: null,
      error: ''
    }
    return {
      id: provider.id,
      name: provider.name,
      desc: providerCardDescription(provider),
      icon: provider.ui?.icon ?? 'pi pi-cloud',
      color: provider.ui?.color,
      available: state.available,
      loggedIn: state.loggedIn,
      profile: state.profile,
      error: state.error,
      needsSetup:
        provider.ui?.authType === 'settings' &&
        !provider.supportedMethods?.includes('loginWithServer')
    }
  })
)

function providerCardDescription(provider: ProviderInfo): string {
  if (
    provider.ui?.authType === 'settings' &&
    !provider.supportedMethods?.includes('loginWithServer')
  ) {
    return provider.ui?.loginInstructions || '请在插件设置中配置服务地址和 API Key'
  }
  return provider.ui?.description ?? '在线音源'
}

const activeProvider = computed<ProviderInfo | null>(() =>
  activeProviderId.value
    ? (loginProviders.value.find((p) => p.id === activeProviderId.value) ?? null)
    : null
)

const activeCard = computed(() =>
  activeProviderId.value
    ? (providerCards.value.find((card) => card.id === activeProviderId.value) ?? null)
    : null
)

const activeProfile = computed(() =>
  activeProviderId.value ? (accountStates.value[activeProviderId.value]?.profile ?? null) : null
)

const activeUi = computed(() => activeProvider.value?.ui)
const primaryLoginAction = computed(() =>
  activeUi.value?.loginExtraActions?.find(
    (action) => action.primary && activeProvider.value?.supportedMethods?.includes(action.method)
  )
)
const supportsServerLogin = computed(
  () => activeProvider.value?.supportedMethods?.includes('loginWithServer') === true
)
const isOAuthProvider = computed(() => Boolean(activeUi.value?.showBrowserButton))

/** 顶层视图：由页面状态机折叠而来，驱动舞台切换动画 */
const view = computed<'loading' | 'connect' | 'login' | 'profile' | 'success' | 'error'>(() => {
  switch (pageState.value) {
    case 'loading':
      return 'loading'
    case 'account_list':
      return 'connect'
    case 'logged_in':
      return 'profile'
    case 'login_success':
      return 'success'
    case 'error':
      return 'error'
    default:
      return 'login'
  }
})

const qrStatusText = computed(() => {
  switch (pageState.value) {
    case 'qr_loading':
      return '正在生成二维码…'
    case 'qr_ready':
      return activeUi.value?.loginInstructions ?? '打开手机 App 扫码登录'
    case 'qr_scanned':
      return '已扫码，请在手机上确认'
    case 'qr_expired':
      return '二维码已过期'
    default:
      return ''
  }
})

const profileInitial = computed(() => {
  const name = activeProfile.value?.nickname?.trim()
  return name ? Array.from(name)[0] : '?'
})

async function refreshAccounts(): Promise<void> {
  await providerStore.syncProviders().catch(() => undefined)
  const providers = loginProviders.value
  await Promise.all(providers.map((p) => refreshAccount(p.id)))
  if (!activeProviderId.value && pageState.value === 'loading') {
    pageState.value = 'account_list'
  }
}

async function refreshAccount(providerId: string): Promise<void> {
  const available = providerStore.hasProvider(providerId)
  if (!available) {
    accountStates.value = {
      ...accountStates.value,
      [providerId]: { available: false, loggedIn: false, profile: null, error: '' }
    }
    return
  }
  try {
    const state = await providerStore.checkLogin(providerId)
    if (disposed || !providerStore.hasProvider(providerId)) return
    accountStates.value = {
      ...accountStates.value,
      [providerId]: {
        available: true,
        loggedIn: state.loggedIn,
        profile: state.profile,
        error: ''
      }
    }
  } catch (error) {
    if (disposed || !providerStore.hasProvider(providerId)) return
    accountStates.value = {
      ...accountStates.value,
      [providerId]: {
        available: true,
        loggedIn: false,
        profile: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** celebrate=true 时先停留在成功动画上，再进入流媒体 */
async function syncSuccessfulLogin(
  providerId: string,
  celebrate = false,
  verifiedState?: Pick<ProviderLoginState, 'loggedIn'> & Partial<ProviderLoginState>
): Promise<void> {
  const revision = loginRevision
  // Reuse the account just verified by the login method/account page. A second
  // network check must not turn a successful login into an unrelated UI state.
  if (verifiedState?.loggedIn && (verifiedState.profile || providerId !== 'ncm')) {
    accountStates.value = {
      ...accountStates.value,
      [providerId]: {
        available: true,
        loggedIn: true,
        profile: verifiedState.profile ?? null,
        error: ''
      }
    }
  } else if (!accountStates.value[providerId]?.loggedIn) {
    await refreshAccount(providerId)
  }
  if (disposed || revision !== loginRevision || activeProviderId.value !== providerId) return
  const state = accountStates.value[providerId]
  if (!state?.loggedIn || (providerId === 'ncm' && !state.profile)) {
    pageState.value = 'error'
    errorMsg.value = state?.error || '登录状态暂时无法确认，请重试'
    return
  }
  if (providerId === 'ncm') {
    const profile = await ncmStore.buildProfile({
      ...state.profile!,
      userId: Number(state.profile!.userId)
    })
    if (disposed || revision !== loginRevision || activeProviderId.value !== providerId) return
    ncmStore.setLogin(profile)
  }
  pageState.value = celebrate ? 'login_success' : 'logged_in'
  if (celebrate) await delay(SUCCESS_LINGER_MS)
  if (disposed || revision !== loginRevision || activeProviderId.value !== providerId) return
  emit('loginSuccess')
}

function openAccount(providerId: string): void {
  if (!loginProviders.value.some((provider) => provider.id === providerId)) {
    backToAccounts()
    openFallbackAccount()
    return
  }
  providerRecoveryPending = false
  loginRevision += 1
  extraActionController?.abort()
  extraActionController = null
  stopPolling()
  lastKeyGenTime.value = 0
  qrImage.value = ''
  qrKey.value = ''
  authUrl.value = ''
  errorMsg.value = ''
  serverLoginMessage.value = ''
  extraActionMethod.value = ''
  activeProviderId.value = providerId
  confirmLogout.value = false
  if (
    providerStore.getProvider(providerId)?.ui?.authType === 'settings' &&
    !supportsServerLogin.value
  ) {
    emit('configure')
    return
  }
  const state = accountStates.value[providerId]
  if (!state?.available) {
    pageState.value = 'error'
    errorMsg.value =
      state?.error ||
      `${providerCards.value.find((c) => c.id === providerId)?.name ?? 'Provider'} 未启用`
    return
  }
  if (state.error) {
    pageState.value = 'error'
    errorMsg.value = state.error
    return
  }
  if (state.loggedIn) {
    pageState.value = 'logged_in'
    return
  }
  if (supportsServerLogin.value) {
    pageState.value = 'qr_ready'
    return
  }
  pageState.value = 'login_notice'
}

function acceptLoginDisclaimer(providerId: string): void {
  if (
    disposed ||
    pageState.value !== 'login_notice' ||
    activeProviderId.value !== providerId ||
    !activeProvider.value
  )
    return
  pageState.value = 'qr_loading'
  if (primaryLoginAction.value) {
    void handleExtraAction(primaryLoginAction.value.method)
    return
  }
  void startQrLogin()
}

function openFallbackAccount(): void {
  const available = providerCards.value.filter((card) => card.available)
  const fallback =
    (props.forceProfile ? available.find((card) => card.loggedIn) : undefined) ?? available[0]
  if (fallback) openAccount(fallback.id)
}

async function checkQrScan(
  providerId: string,
  key: string
): Promise<{ code: number; message?: string; retryAfterSeconds?: number }> {
  try {
    return await providerStore.checkQrLogin(providerId, key)
  } catch (error) {
    return {
      code: -1,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function getQrErrorMessage(result: {
  code: number
  message?: string
  retryAfterSeconds?: number
}): string {
  if (result.message) return result.message
  if (result.code === 301) return '登录态无效或接口缓存了未登录结果，请重新登录或等待 2 分钟后重试'
  if (result.code === 502) return '二维码状态检查失败，请刷新二维码后重试'
  if (result.code === 503) return '登录接口触发高频限制，请等待几分钟后再试'
  if (result.code === 460) return '当前网络环境被网易云限制，请切换网络或稍后重试'
  return '二维码登录状态异常，请刷新二维码后重试'
}

function isQrStatus(code: number, type: 'waiting' | 'scanned' | 'expired' | 'success'): boolean {
  const codes = activeUi.value?.qrStatusCodes ?? DEFAULT_QR_STATUS_CODES
  switch (type) {
    case 'waiting':
      return code === codes.waiting
    case 'scanned':
      return codes.scanned !== null && code === codes.scanned
    case 'expired':
      return code === codes.expired || codes.denied === code
    case 'success':
      return code === codes.success
    default:
      return false
  }
}

function startPolling(providerId: string, key: string): void {
  stopPolling()
  const generation = pollGeneration
  let checking = false
  pollTimer = setInterval(async () => {
    if (document.hidden || checking) return
    checking = true
    const result = await checkQrScan(providerId, key)
    checking = false
    if (
      generation !== pollGeneration ||
      activeProviderId.value !== providerId ||
      qrKey.value !== key
    )
      return
    if (isQrStatus(result.code, 'expired')) {
      pageState.value = 'qr_expired'
      stopPolling()
      return
    }
    if (
      result.code === -1 ||
      result.code === 301 ||
      result.code === 502 ||
      result.code === 503 ||
      result.code === 460
    ) {
      errorMsg.value = getQrErrorMessage(result)
      pageState.value = 'error'
      stopPolling()
      return
    }
    if (isQrStatus(result.code, 'waiting')) {
      pageState.value = 'qr_ready'
      return
    }
    if (isQrStatus(result.code, 'scanned')) {
      pageState.value = 'qr_scanned'
      return
    }
    if (isQrStatus(result.code, 'success')) {
      stopPolling()
      pageState.value = 'loading'
      await syncSuccessfulLogin(providerId, true)
    }
  }, POLL_INTERVAL)
}

function onDocumentVisibilityChange(): void {
  qrVisibilityPolling.onVisibilityChange()
}

const qrVisibilityPolling = createVisibilityPollingController({
  isHidden: () => document.hidden,
  stop: stopPolling,
  resume: () => {
    if (qrKey.value && activeProviderId.value && pollTimer === null)
      startPolling(activeProviderId.value, qrKey.value)
  }
})

let loginRevision = 0
let pollGeneration = 0

function stopPolling(): void {
  pollGeneration += 1
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function startQrLogin(): Promise<void> {
  const providerId = activeProviderId.value
  if (!providerId || pageState.value === 'login_notice') return
  const now = Date.now()
  if (now - lastKeyGenTime.value < QR_KEY_COOLDOWN) return
  stopPolling()
  const revision = ++loginRevision
  lastKeyGenTime.value = now

  pageState.value = 'qr_loading'
  qrImage.value = ''
  qrKey.value = ''
  authUrl.value = ''
  errorMsg.value = ''

  try {
    const providerName = activeCard.value?.name ?? providerId
    const qr = await providerStore.getQrLogin(providerId)
    if (revision !== loginRevision || activeProviderId.value !== providerId) return
    if (!qr?.key) throw new Error(`获取 ${providerName} 登录信息失败`)
    qrKey.value = qr.key
    authUrl.value = activeUi.value?.showBrowserButton ? qr.qrContent || '' : ''
    const image =
      qr.imageDataUrl ||
      (await QRCode.toDataURL(qr.qrContent || qr.key, {
        margin: 1,
        width: 220
      }))
    if (revision !== loginRevision || activeProviderId.value !== providerId) return
    qrImage.value = image
    // Auto-open browser for OAuth-type providers
    if (activeUi.value?.showBrowserButton && authUrl.value) {
      window.open(authUrl.value, '_blank')
    }
    pageState.value = 'qr_ready'
    startPolling(providerId, qrKey.value)
  } catch (error) {
    if (revision !== loginRevision || activeProviderId.value !== providerId) return
    pageState.value = 'error'
    errorMsg.value = error instanceof Error ? error.message : String(error)
  }
}

async function handleRefresh(): Promise<void> {
  if (pageState.value === 'login_notice') return
  const providerId = activeProviderId.value
  const revision = loginRevision
  if (!providerId) return
  // The browser/QR may already have saved a valid session before a status
  // request failed. Retry that session before asking the user to sign in again.
  await refreshAccount(providerId)
  if (disposed || revision !== loginRevision || activeProviderId.value !== providerId) return
  const account = accountStates.value[providerId]
  if (account?.loggedIn) {
    await syncSuccessfulLogin(providerId, true)
    return
  }
  if (account?.error) {
    pageState.value = 'error'
    errorMsg.value = account.error
    return
  }
  if (primaryLoginAction.value) {
    void handleExtraAction(primaryLoginAction.value.method)
    return
  }
  lastKeyGenTime.value = 0
  void startQrLogin()
}

function openAuthUrl(): void {
  if (authUrl.value) {
    window.open(authUrl.value, '_blank')
  }
}

async function handleExtraAction(method: string): Promise<void> {
  if (!activeProviderId.value || extraActionMethod.value || pageState.value === 'login_notice')
    return
  const revision = ++loginRevision
  extraActionMethod.value = method
  const controller = new AbortController()
  extraActionController = controller
  stopPolling()
  pageState.value = 'qr_loading'
  qrImage.value = ''
  qrKey.value = ''
  errorMsg.value = ''
  try {
    const providerId = activeProviderId.value
    const result = await providerStore.callProvider<ProviderLoginState | undefined>(
      providerId, method, [], controller.signal
    )
    if (revision !== loginRevision || activeProviderId.value !== providerId) return
    if (result && typeof result === 'object' && 'loggedIn' in result && !result.loggedIn) {
      throw new Error('登录会话未建立，请重新打开官方登录窗口')
    }
    await syncSuccessfulLogin(providerId, true, result)
  } catch (error) {
    if (revision !== loginRevision) return
    pageState.value = 'error'
    errorMsg.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (revision === loginRevision) extraActionMethod.value = ''
    if (extraActionController === controller) extraActionController = null
  }
}

function normalizeLoginError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/301/.test(message))
    return '登录态无效或接口缓存了未登录结果，请等待 2 分钟或重新生成登录请求'
  if (/安全风险|设备环境异常|操作已拦截/i.test(message)) {
    return '网易云拦截了当前网络或设备环境。请停止频繁重试，切换网络/设备或按官方提示 24 小时后再试。'
  }
  if (/503|高频|风控/i.test(message)) return '登录接口触发高频或风控限制，请等待几分钟后再试'
  if (/460/.test(message)) return '当前网络环境被网易云限制，请切换网络或稍后重试'
  if (
    /fetch failed|Failed to fetch|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|offline/i.test(message)
  ) {
    return '网络不可用或无法连接网易云服务，请检查网络后重试'
  }
  return message || '登录失败，请检查账号信息后重试'
}

async function handleServerLogin(
  serverUrl: string,
  username: string,
  password: string
): Promise<void> {
  const providerId = activeProviderId.value
  if (!providerId || serverLoginBusy.value) return
  const revision = ++loginRevision
  serverLoginBusy.value = true
  serverLoginMessage.value = ''
  try {
    const result = await providerStore.callProvider<{ loggedIn: boolean }>(
      providerId,
      'loginWithServer',
      [serverUrl, username, password]
    )
    if (revision !== loginRevision || activeProviderId.value !== providerId) return
    if (!result.loggedIn) throw new Error('登录未成功，请检查服务器地址和账号')
    await syncSuccessfulLogin(providerId, true, result)
  } catch (error) {
    if (revision === loginRevision) serverLoginMessage.value = normalizeLoginError(error)
  } finally {
    if (revision === loginRevision) serverLoginBusy.value = false
  }
}

function requestLogout(): void {
  confirmLogout.value = true
}

async function handleLogout(): Promise<void> {
  if (!activeProviderId.value) return
  confirmLogout.value = false
  if (activeProviderId.value === 'ncm') await ncmStore.logout()
  else await providerStore.logout(activeProviderId.value)
  await refreshAccounts()
  openAccount(activeProviderId.value)
}

async function copyUid(): Promise<void> {
  const uid = activeProfile.value?.userId
  if (uid == null) return
  try {
    await navigator.clipboard.writeText(String(uid))
    uidCopied.value = true
    if (uidCopiedTimer) clearTimeout(uidCopiedTimer)
    uidCopiedTimer = setTimeout(() => {
      uidCopied.value = false
    }, 1600)
  } catch {
    // clipboard unavailable — ignore silently
  }
}

function backToAccounts(): void {
  providerRecoveryPending = false
  loginRevision += 1
  extraActionController?.abort()
  extraActionController = null
  lastKeyGenTime.value = 0
  stopPolling()
  activeProviderId.value = null
  pageState.value = 'account_list'
  qrImage.value = ''
  qrKey.value = ''
  authUrl.value = ''
  errorMsg.value = ''
  confirmLogout.value = false
  serverLoginBusy.value = false
  serverLoginMessage.value = ''
  extraActionMethod.value = ''
}

// 账号详情/扫码登录是登录页内部的一层：标题栏返回键先退到平台列表，再退出
// 登录页本身（页面层由 App.vue 按 showLoginPage 注册）。
useBackHandler(
  computed(() => activeProviderId.value !== null),
  backToAccounts,
  '返回平台列表'
)

async function enterAfterLoggedIn(): Promise<void> {
  if (activeProviderId.value) {
    await syncSuccessfulLogin(activeProviderId.value)
    return
  }
  emit('loginSuccess')
}

watch(view, (next) => {
  if (next !== 'profile') confirmLogout.value = false
})

watch(
  () => JSON.stringify(loginProviders.value.map((provider) => provider.id)),
  async () => {
    const changeRevision = ++providerChangeRevision
    if (!accountsInitialized || disposed) return
    const activeRemoved = activeProviderId.value !== null && activeProvider.value === null
    if (activeRemoved) {
      backToAccounts()
      providerRecoveryPending = true
    }
    const revision = loginRevision
    await refreshAccounts()
    if (disposed || changeRevision !== providerChangeRevision || revision !== loginRevision) return
    if (providerRecoveryPending) {
      providerRecoveryPending = false
      openFallbackAccount()
    }
  },
  { flush: 'sync' }
)

onMounted(async () => {
  document.addEventListener('visibilitychange', onDocumentVisibilityChange)
  await refreshAccounts()
  if (disposed) return
  accountsInitialized = true
  if (props.initialProviderId && !activeProviderId.value) {
    openAccount(props.initialProviderId)
    return
  }
  if (props.forceProfile && !activeProviderId.value) {
    const loggedIn = providerCards.value.find((card) => card.available && card.loggedIn)
    if (loggedIn) {
      openAccount(loggedIn.id)
    }
  }
})

onUnmounted(() => {
  disposed = true
  loginRevision += 1
  extraActionController?.abort()
  extraActionController = null
  document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
  stopPolling()
  if (uidCopiedTimer) clearTimeout(uidCopiedTimer)
})
</script>

<template>
  <div class="login-page">
    <div class="lp-sky" aria-hidden="true">
      <div class="sky-blob sky-blob-a"></div>
      <div class="sky-blob sky-blob-b"></div>
      <div class="sky-halo"></div>
    </div>

    <div class="lp-shell">
      <main class="lp-stage">
        <Transition name="stage" mode="out-in">
          <!-- 初始化 -->
          <section v-if="view === 'loading'" key="loading" class="stage-center">
            <div class="lp-spinner"></div>
            <p class="stage-muted">正在连接在线音源…</p>
          </section>

          <!-- 平台选择 -->
          <section v-else-if="view === 'connect'" key="connect" class="stage-view">
            <header class="stage-head">
              <h2 class="stage-title">选择你的音乐平台</h2>
              <p class="stage-sub">登录一个平台，把它的曲库接进 Twilight Echo</p>
            </header>
            <p v-if="providerCards.length === 0" class="stage-muted">
              暂无可用的登录平台，请在扩展中心启用流媒体插件。
            </p>
            <div class="provider-list">
              <button
                v-for="(provider, index) in providerCards"
                :key="provider.id"
                type="button"
                class="provider-row"
                :class="{ unavailable: !provider.available }"
                :style="{ '--d': index }"
                @click="openAccount(provider.id)"
              >
                <span
                  class="provider-glyph"
                  :style="provider.color ? { color: provider.color } : undefined"
                >
                  <i :class="provider.icon"></i>
                </span>
                <span class="provider-copy">
                  <span class="provider-name">
                    {{ provider.name }}
                    <em v-if="provider.loggedIn" class="provider-pill on">已连接</em>
                    <em v-else-if="!provider.available" class="provider-pill off">不可用</em>
                    <em v-else-if="provider.needsSetup" class="provider-pill setup">需配置</em>
                  </span>
                  <span class="provider-desc">
                    <template v-if="provider.loggedIn">
                      {{ provider.profile?.nickname || provider.profile?.userId || '未知用户' }} ·
                      点击管理账号
                    </template>
                    <template v-else-if="provider.available">{{ provider.desc }}</template>
                    <template v-else>{{ provider.error || 'Provider 未启用' }}</template>
                  </span>
                </span>
                <img
                  v-if="provider.loggedIn && provider.profile?.avatarUrl"
                  :src="provider.profile.avatarUrl"
                  class="provider-avatar"
                  alt=""
                />
                <span class="provider-arrow">
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </span>
              </button>
            </div>
          </section>

          <!-- 登录 -->
          <section v-else-if="view === 'login'" key="login" class="stage-view">
            <header class="stage-head">
              <button
                type="button"
                class="chip-back"
                data-te-back-button="pill"
                @click="backToAccounts"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                全部平台
              </button>
              <h2 class="stage-title">
                <span
                  v-if="activeCard"
                  class="title-glyph"
                  :style="activeCard.color ? { color: activeCard.color } : undefined"
                >
                  <i :class="activeCard.icon"></i>
                </span>
                登录 {{ activeCard?.name ?? '在线账号' }}
              </h2>
            </header>

            <!-- 扫码 / OAuth -->
            <div
              :key="supportsServerLogin ? 'server' : 'qr'"
              class="login-method-content te-content-arrival"
            >
              <ServerLoginForm
                v-if="supportsServerLogin"
                :key="activeProviderId || ''"
                :busy="serverLoginBusy"
                :error="serverLoginMessage"
                @submit="handleServerLogin"
              />
              <div v-else class="qr-stage">
                <div v-if="pageState === 'login_notice'" class="oauth-panel">
                  <p class="stage-muted">确认免责声明后继续登录</p>
                </div>
                <div v-else-if="extraActionMethod" class="oauth-panel" role="status">
                  <div class="lp-spinner"></div>
                  <p class="stage-muted">请在打开的登录窗口扫码或授权，完成后会自动返回</p>
                </div>
                <template v-else-if="isOAuthProvider">
                  <div class="oauth-panel">
                    <div class="lp-spinner"></div>
                    <p class="stage-muted">已在浏览器中打开授权页面，完成授权后将自动登录</p>
                    <button v-if="authUrl" type="button" class="btn-secondary" @click="openAuthUrl">
                      重新打开浏览器
                    </button>
                  </div>
                </template>
                <template v-else>
                  <div class="qr-frame" :class="{ expired: pageState === 'qr_expired' }">
                    <span class="qr-corner tl"></span>
                    <span class="qr-corner tr"></span>
                    <span class="qr-corner bl"></span>
                    <span class="qr-corner br"></span>
                    <img
                      v-if="qrImage && pageState !== 'qr_expired'"
                      :src="qrImage"
                      alt="登录二维码"
                      class="qr-image"
                    />
                    <div v-else-if="pageState === 'qr_loading'" class="qr-loading">
                      <div class="lp-spinner"></div>
                    </div>
                    <div
                      v-if="pageState === 'qr_expired'"
                      class="qr-expired-overlay"
                      data-te-interactive
                      role="button"
                      tabindex="0"
                      aria-label="刷新二维码"
                      @click="handleRefresh"
                      @keydown.enter.prevent="handleRefresh"
                      @keydown.space.prevent="handleRefresh"
                    >
                      <svg
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                      </svg>
                      <span>点击刷新二维码</span>
                    </div>
                    <div v-if="pageState === 'qr_ready'" class="qr-scanline"></div>
                  </div>
                  <p class="qr-status" :class="{ scanned: pageState === 'qr_scanned' }">
                    <span
                      class="qr-dot"
                      :class="pageState === 'qr_scanned' ? 'scanned' : 'waiting'"
                    ></span>
                    {{ qrStatusText }}
                  </p>
                </template>

                <div
                  v-if="pageState !== 'login_notice' && activeUi?.loginExtraActions?.length"
                  class="extra-actions"
                >
                  <button
                    v-for="action in activeUi.loginExtraActions"
                    :key="action.method"
                    type="button"
                    class="btn-secondary"
                    :disabled="Boolean(extraActionMethod)"
                    @click="handleExtraAction(action.method)"
                  >
                    <i :class="action.icon"></i>
                    {{ action.label }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <!-- 资料页 -->
          <section v-else-if="view === 'profile'" key="profile" class="stage-view profile-view">
            <header class="stage-head">
              <button
                type="button"
                class="chip-back"
                data-te-back-button="pill"
                @click="backToAccounts"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                全部平台
              </button>
            </header>

            <div class="id-card">
              <div class="id-banner">
                <i v-if="activeCard" :class="activeCard.icon" class="id-watermark"></i>
              </div>
              <div class="id-avatar-slot">
                <img
                  v-if="activeProfile?.avatarUrl"
                  :src="activeProfile.avatarUrl"
                  class="id-avatar"
                  alt="头像"
                />
                <span v-else class="id-avatar id-avatar-fallback">{{ profileInitial }}</span>
              </div>
              <div class="id-identity">
                <h2 class="id-name">{{ activeProfile?.nickname || '未知用户' }}</h2>
                <span v-if="activeCard" class="id-provider">
                  <i :class="activeCard.icon"></i>
                  {{ activeCard.name }}
                </span>
              </div>
              <p class="id-signature">
                {{ activeProfile?.signature?.trim() || '这位听众很安静，还没有留下签名' }}
              </p>
              <div class="id-stats">
                <span v-if="activeProfile?.follows != null" class="id-stat">
                  <strong>{{ activeProfile.follows }}</strong>
                  <span>关注</span>
                </span>
                <span v-if="activeProfile?.followeds != null" class="id-stat">
                  <strong>{{ activeProfile.followeds }}</strong>
                  <span>粉丝</span>
                </span>
                <button
                  type="button"
                  class="id-stat uid"
                  :title="uidCopied ? '已复制' : '点击复制 UID'"
                  @click="copyUid"
                >
                  <strong>{{ activeProfile?.userId ?? '—' }}</strong>
                  <span>{{ uidCopied ? '已复制 ✓' : 'UID · 复制' }}</span>
                </button>
              </div>
              <div class="id-actions">
                <button type="button" class="btn-primary" @click="enterAfterLoggedIn">
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                  进入流媒体
                </button>
                <button
                  v-if="!confirmLogout"
                  type="button"
                  class="btn-ghost-danger"
                  @click="requestLogout"
                >
                  退出登录
                </button>
                <button v-else type="button" class="btn-ghost-danger confirm" @click="handleLogout">
                  确认退出？
                </button>
              </div>
            </div>
          </section>

          <!-- 登录成功 -->
          <section v-else-if="view === 'success'" key="success" class="stage-center">
            <div class="success-burst">
              <svg viewBox="0 0 52 52" class="success-check">
                <circle class="success-circle" cx="26" cy="26" r="24" fill="none" />
                <path class="success-tick" fill="none" d="M15 27l7 7 15-16" />
              </svg>
            </div>
            <h2 class="stage-title center">登录成功</h2>
            <p class="stage-muted">正在为你打开流媒体…</p>
          </section>

          <!-- 错误 -->
          <section v-else key="error" class="stage-center">
            <div class="error-badge">
              <svg
                width="26"
                height="26"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <p class="error-text">{{ errorMsg || '出了点问题，请稍后重试' }}</p>
            <div class="error-actions">
              <button type="button" class="btn-primary" @click="handleRefresh">重试</button>
              <button
                type="button"
                class="btn-secondary"
                data-te-back-button="pill"
                @click="backToAccounts"
              >
                返回平台列表
              </button>
            </div>
          </section>
        </Transition>
      </main>
    </div>
    <LoginDisclaimerDialog
      v-if="pageState === 'login_notice' && activeProvider"
      :key="activeProvider.id"
      :provider-id="activeProvider.id"
      :provider-name="activeProvider.name"
      @accept="acceptLoginDisclaimer"
      @cancel="backToAccounts"
    />
  </div>
</template>

<style scoped>
.login-page {
  /* 本页局部调色板：与流媒体首页同源 —— 卡片 / 墨色中性 token 派生，自动适配深浅色 */
  --lp-surface: var(--te-card-bg);
  --lp-text: var(--te-neutral-900);
  --lp-muted: var(--te-neutral-500);
  --lp-line: var(--te-card-border);
  --lp-inset: var(--te-subtle-bg);
  --lp-tint: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
  --lp-tint-strong: color-mix(in srgb, var(--te-primary-500) 18%, transparent);
  --lp-shadow: 0 18px 44px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);
  --lp-shadow-lift: 0 24px 56px color-mix(in srgb, var(--te-neutral-900) 13%, transparent);
  --lp-shadow-soft: 0 1px 4px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);

  position: fixed;
  inset: 0;
  /* Above the sidebar (1000) and player bar (1002); below the title bar (9999). */
  z-index: 2000;
  display: grid;
  place-items: center;
  background-color: var(--te-streaming-bg);
  background-image: var(--te-streaming-bg-image);
  background-position: center;
  background-size: cover;
  color: var(--lp-text);
  font-family: var(--te-font-sans);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

/* ─── 背景天幕 ─────────────────────────────── */

.lp-sky {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.sky-blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(110px);
  animation: skyDrift 22s ease-in-out infinite alternate;
}

.sky-blob-a {
  width: 520px;
  height: 520px;
  top: -180px;
  right: -120px;
  background: color-mix(in srgb, var(--te-primary-500) 18%, transparent);
}

.sky-blob-b {
  width: 420px;
  height: 420px;
  bottom: -160px;
  left: -120px;
  background: color-mix(in srgb, var(--te-primary-300) 20%, transparent);
  animation-delay: -9s;
}

.sky-halo {
  position: absolute;
  inset: -30%;
  background: radial-gradient(
    ellipse at 50% 38%,
    color-mix(in srgb, var(--te-primary-500) 7%, transparent),
    transparent 55%
  );
}

@keyframes skyDrift {
  from {
    transform: translate(0, 0) scale(1);
  }
  to {
    transform: translate(-28px, 22px) scale(1.08);
  }
}

/* ─── 主壳体 ──────────────────────────────── */

.lp-shell {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(496px, calc(100vw - 48px));
  max-height: calc(100vh - 110px);
  border-radius: 22px;
  overflow: hidden;
  background: var(--lp-surface);
  border: 1px solid var(--lp-line);
  box-shadow: var(--lp-shadow);
  animation: shellIn 0.55s var(--te-ease-spring) both;
}

/* 卡片顶部的一层主题色光晕，替代原品牌面板的视觉锚点 */
.lp-shell::before {
  content: '';
  position: absolute;
  top: -120px;
  left: 50%;
  width: 560px;
  height: 260px;
  transform: translateX(-50%);
  background: radial-gradient(
    ellipse at center,
    color-mix(in srgb, var(--te-primary-500) 12%, transparent),
    transparent 68%
  );
  pointer-events: none;
}

@keyframes shellIn {
  from {
    opacity: 0;
    transform: translateY(22px) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ─── 舞台区 ──────────────────────────────── */

.lp-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.stage-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 38px 40px;
}

.stage-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 38px 40px;
  min-height: 340px;
  text-align: center;
}

.stage-enter-active,
.stage-leave-active {
  transition:
    opacity var(--te-motion-panel) var(--te-ease-soft),
    transform var(--te-motion-panel) var(--te-ease-soft);
}

.stage-enter-from {
  opacity: 0;
  transform: translateY(14px);
}

.stage-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.stage-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}

.stage-title {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin: 0;
  font-family: var(--te-font-display);
  font-size: calc(var(--te-font-size-body, 14px) * 23 / 14);
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--lp-text);
}

.title-glyph {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 11px;
  background: var(--lp-tint);
  color: var(--te-primary-500);
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
}

.stage-sub {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: var(--lp-muted);
}

.stage-muted {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  line-height: 1.6;
  color: var(--lp-muted);
}

.chip-back {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px 0 8px;
  border: none;
  border-radius: 999px;
  background: var(--lp-inset);
  color: var(--lp-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
  cursor: pointer;
  transition:
    color var(--te-motion-hover) var(--te-ease-soft),
    background var(--te-motion-hover) var(--te-ease-soft);
}

.chip-back:hover {
  transform: translateX(-1px);
}

/* ─── 平台列表 ─────────────────────────────── */

.provider-list {
  display: grid;
  gap: 12px;
}

.provider-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 15px;
  padding: 15px 18px;
  border: 1px solid var(--lp-line);
  border-radius: 18px;
  background: var(--lp-surface);
  color: var(--lp-text);
  text-align: left;
  cursor: pointer;
  animation: rowIn 0.5s var(--te-ease-spring) both;
  animation-delay: calc(var(--d) * 70ms);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    border-color var(--te-motion-hover),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint);
}

@keyframes rowIn {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.provider-row:hover {
  transition-duration: var(--te-motion-settle);
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--te-primary-500) 34%, transparent);
  box-shadow: var(--lp-shadow-lift);
}

.provider-row:hover .provider-arrow {
  transition-duration: var(--te-motion-settle);
  transform: translateX(3px);
  color: var(--te-primary-500);
}

.provider-row.unavailable {
  opacity: 0.55;
}

.provider-glyph {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 15px;
  background: var(--lp-tint);
  color: var(--te-primary-500);
  font-size: calc(var(--te-font-size-body, 14px) * 21 / 14);
}

.provider-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.provider-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(var(--te-font-size-body, 14px) * 15 / 14);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.provider-pill {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 600;
  font-style: normal;
}

.provider-pill.on {
  background: var(--te-success-soft-bg);
  color: var(--te-success-soft-fg);
}

.provider-pill.off {
  background: var(--lp-inset);
  color: var(--lp-muted);
}

.provider-pill.setup {
  background: var(--lp-tint-strong);
  color: var(--te-primary-500);
}

.provider-desc {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: var(--lp-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--lp-surface);
  box-shadow: var(--lp-shadow-soft);
}

.provider-arrow {
  display: grid;
  place-items: center;
  color: var(--lp-muted);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    color var(--te-motion-hover);
}

/* ─── 扫码区 ──────────────────────────────── */

.qr-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  padding-top: 6px;
}

.qr-frame {
  position: relative;
  width: 214px;
  height: 214px;
  display: grid;
  place-items: center;
  border-radius: 22px;
  background: white;
  box-shadow:
    var(--lp-shadow),
    0 0 0 1px var(--lp-line);
  overflow: hidden;
}

.qr-corner {
  position: absolute;
  width: 22px;
  height: 22px;
  border: 2.5px solid var(--te-primary-500);
  z-index: 2;
  pointer-events: none;
}

.qr-corner.tl {
  top: 10px;
  left: 10px;
  border-right: none;
  border-bottom: none;
  border-top-left-radius: 10px;
}

.qr-corner.tr {
  top: 10px;
  right: 10px;
  border-left: none;
  border-bottom: none;
  border-top-right-radius: 10px;
}

.qr-corner.bl {
  bottom: 10px;
  left: 10px;
  border-right: none;
  border-top: none;
  border-bottom-left-radius: 10px;
}

.qr-corner.br {
  bottom: 10px;
  right: 10px;
  border-left: none;
  border-top: none;
  border-bottom-right-radius: 10px;
}

.qr-image {
  width: 178px;
  height: 178px;
  object-fit: contain;
}

.qr-loading {
  display: grid;
  place-items: center;
}

.qr-scanline {
  position: absolute;
  left: 14px;
  right: 14px;
  height: 44px;
  top: 0;
  background: linear-gradient(
    to bottom,
    transparent,
    color-mix(in srgb, var(--te-primary-500) 22%, transparent)
  );
  border-bottom: 2px solid color-mix(in srgb, var(--te-primary-500) 70%, transparent);
  animation: scanSweep 2.4s ease-in-out infinite;
  pointer-events: none;
}

@keyframes scanSweep {
  0%,
  100% {
    transform: translateY(-8px);
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  88% {
    opacity: 1;
  }
  50% {
    transform: translateY(176px);
  }
}

.qr-expired-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: color-mix(in srgb, var(--lp-surface) 86%, transparent);
  backdrop-filter: blur(6px);
  color: var(--lp-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  cursor: pointer;
  transition: color var(--te-motion-hover) var(--te-ease-soft);
}

.qr-expired-overlay:hover {
  color: var(--te-primary-500);
}

.qr-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 500;
  color: var(--lp-text);
}

.qr-status.scanned {
  color: var(--te-success-soft-fg);
}

.qr-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.qr-dot.waiting {
  background: var(--te-primary-500);
  animation: dotPulse 1.6s ease-in-out infinite;
}

.qr-dot.scanned {
  background: var(--te-success-soft-fg);
  animation: dotPulse 1s ease-in-out infinite;
}

@keyframes dotPulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.72);
  }
}

.oauth-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 36px 20px;
  max-width: 320px;
  text-align: center;
}

.extra-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
}

/* ─── 按钮 ────────────────────────────────── */

.btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 46px;
  padding: 0 30px;
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--te-primary-500), var(--te-primary-400));
  color: white;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--te-primary-500) 34%, transparent);
  transition:
    transform var(--te-motion-return) var(--te-ease-out-quint),
    box-shadow var(--te-motion-return) var(--te-ease-out-quint);
}

.btn-primary:hover:not(:disabled) {
  transition-duration: var(--te-motion-settle);
  transform: translateY(-2px);
  box-shadow: 0 12px 30px color-mix(in srgb, var(--te-primary-500) 44%, transparent);
}

.btn-primary:active:not(:disabled) {
  transition-duration: var(--te-motion-press);
  transform: scale(var(--te-motion-press-scale));
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: wait;
  transform: none;
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 40px;
  padding: 0 22px;
  border: none;
  border-radius: 999px;
  background: var(--lp-inset);
  color: var(--lp-text);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--te-motion-hover) var(--te-ease-soft),
    color var(--te-motion-hover) var(--te-ease-soft);
}

.btn-secondary:hover {
  background: var(--lp-tint);
  color: var(--te-primary-500);
}

.btn-ghost-danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 46px;
  padding: 0 24px;
  border: none;
  border-radius: 999px;
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--te-motion-hover) var(--te-ease-soft),
    box-shadow var(--te-motion-hover) var(--te-ease-soft);
}

.btn-ghost-danger:hover {
  background: color-mix(in srgb, var(--te-danger-soft-fg) 16%, var(--te-danger-soft-bg));
}

.btn-ghost-danger.confirm {
  background: var(--te-danger-soft-fg);
  color: white;
  animation: confirmNudge 0.3s var(--te-ease-spring);
}

@keyframes confirmNudge {
  0% {
    transform: scale(0.94);
  }
  100% {
    transform: scale(1);
  }
}

.lp-spinner {
  width: 34px;
  height: 34px;
  border: 3px solid var(--lp-tint-strong);
  border-top-color: var(--te-primary-500);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ─── 资料卡 ──────────────────────────────── */

.profile-view {
  gap: 14px;
}

.id-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1px solid var(--lp-line);
  border-radius: 22px;
  background: var(--lp-surface);
  box-shadow: var(--lp-shadow);
  overflow: hidden;
  animation: rowIn 0.5s var(--te-ease-spring) both;
}

.id-banner {
  position: relative;
  width: 100%;
  height: 112px;
  background:
    radial-gradient(
      circle at 80% 20%,
      color-mix(in srgb, var(--te-primary-300) 34%, transparent),
      transparent 55%
    ),
    linear-gradient(
      140deg,
      color-mix(in srgb, var(--te-primary-500) 26%, var(--lp-surface)),
      color-mix(in srgb, var(--te-primary-500) 8%, var(--lp-surface))
    );
}

.id-watermark {
  position: absolute;
  right: 26px;
  bottom: -14px;
  font-size: 96px;
  color: color-mix(in srgb, var(--te-primary-500) 18%, transparent);
  pointer-events: none;
}

.id-avatar-slot {
  margin-top: -46px;
  padding: 5px;
  border-radius: 50%;
  background: var(--lp-surface);
  z-index: 1;
}

.id-avatar {
  display: grid;
  place-items: center;
  width: 92px;
  height: 92px;
  border-radius: 50%;
  object-fit: cover;
  box-shadow: var(--lp-shadow-soft);
}

.id-avatar-fallback {
  background: linear-gradient(135deg, var(--te-primary-500), var(--te-primary-300));
  color: white;
  font-size: calc(var(--te-font-size-body, 14px) * 38 / 14);
  font-weight: 700;
  font-family: var(--te-font-display);
}

.id-identity {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding: 0 32px;
}

.id-name {
  margin: 0;
  font-family: var(--te-font-display);
  font-size: calc(var(--te-font-size-body, 14px) * 25 / 14);
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--lp-text);
  text-align: center;
}

.id-provider {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--lp-tint);
  color: var(--te-primary-500);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
}

.id-signature {
  margin: 12px 0 0;
  padding: 0 36px;
  max-width: 400px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  line-height: 1.7;
  text-align: center;
  color: var(--lp-muted);
}

.id-stats {
  display: flex;
  align-items: stretch;
  gap: 30px;
  margin-top: 20px;
  padding: 14px 30px;
  border-radius: 16px;
  background: var(--lp-inset);
}

.id-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  border: none;
  padding: 0;
  background: transparent;
  color: inherit;
}

.id-stat strong {
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
  font-weight: 700;
  font-family: var(--te-font-display);
  color: var(--lp-text);
  letter-spacing: 0.01em;
}

.id-stat span {
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 500;
  color: var(--lp-muted);
}

.id-stat.uid {
  cursor: pointer;
}

.id-stat.uid:hover span,
.id-stat.uid:hover strong {
  color: var(--te-primary-500);
}

.id-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 24px 0 28px;
  padding: 0 24px;
}

/* ─── 成功 / 错误 ─────────────────────────── */

.success-burst {
  position: relative;
  display: grid;
  place-items: center;
  width: 92px;
  height: 92px;
}

.success-burst::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--lp-tint);
  animation: burstRing 0.9s var(--te-ease-soft) both;
}

@keyframes burstRing {
  from {
    transform: scale(0.4);
    opacity: 0;
  }
  60% {
    opacity: 1;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.success-check {
  position: relative;
  width: 62px;
  height: 62px;
}

.success-circle {
  stroke: var(--te-success-soft-fg);
  stroke-width: 2.4;
  stroke-dasharray: 152;
  stroke-dashoffset: 152;
  stroke-linecap: round;
  animation: drawStroke 0.7s var(--te-ease-soft) 0.1s forwards;
}

.success-tick {
  stroke: var(--te-success-soft-fg);
  stroke-width: 3.4;
  stroke-dasharray: 36;
  stroke-dashoffset: 36;
  stroke-linecap: round;
  stroke-linejoin: round;
  animation: drawStroke 0.4s var(--te-ease-soft) 0.55s forwards;
}

@keyframes drawStroke {
  to {
    stroke-dashoffset: 0;
  }
}

.error-badge {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}

.error-text {
  margin: 0;
  max-width: 340px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  line-height: 1.7;
  color: var(--te-danger-soft-fg);
}

.error-actions {
  display: flex;
  gap: 12px;
  margin-top: 6px;
}

/* ─── 响应式与动效偏好 ─────────────────────── */

@media (max-height: 600px) {
  .lp-shell {
    max-height: calc(100vh - 72px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sky-blob,
  .qr-scanline,
  .qr-dot.waiting,
  .qr-dot.scanned {
    animation: none;
  }

  .lp-shell,
  .provider-row,
  .id-card {
    animation-duration: 0.01s;
    animation-delay: 0s;
  }
}
</style>
