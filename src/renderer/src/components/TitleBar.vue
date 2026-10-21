<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useBackStack } from '../app/useBackStack'
import { useNcmStore } from '../stores/useNcmStore'
import { useProviderStore } from '../stores/useProviderStore'
import TitleBarIcon from './icons/TitleBarIcon.vue'
import { useWindowChrome } from '../app/useWindowChrome'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'

const props = withDefaults(
  defineProps<{
    menuOpen: boolean
    glass?: boolean
    immersive?: boolean
    liquidMaterial?: boolean
    streaming?: boolean
    titleSurface?: 'default' | 'settings' | 'streaming'
    activeTool?: 'settings' | 'plugins' | null
    preview?: boolean
    closeOnly?: boolean
    notificationsOpen?: boolean
  }>(),
  {
    titleSurface: 'default'
  }
)

defineEmits<{
  toggleMenu: []
  collapseMenu: []
  back: []
  login: [providerId?: string | null]
  settings: []
  reportIssue: []
  plugins: []
  library: []
  notifications: [event: MouseEvent]
}>()

const { isLoggedIn, profile } = useNcmStore()
const providerStore = useProviderStore()
const loginProvider = computed(() => {
  const providers = providerStore.providers.value.filter((provider) =>
    provider.capabilities.includes('login')
  )
  return providers.find((provider) => provider.id === 'ncm') ?? providers[0]
})
const showNcmProfile = computed(() => loginProvider.value?.id === 'ncm' && isLoggedIn.value)
const loginLabel = computed(() =>
  showNcmProfile.value
    ? profile.value?.nickname || '个人详情'
    : loginProvider.value
      ? `${loginProvider.value.name}登录`
      : '流媒体登录'
)
const { canGoBack, backHint } = useBackStack()
const { unreadCount, activeTaskCount, doNotDisturb } = useAppNoticeStore()
const { maximized } = useWindowChrome(() => props.preview === true)
const avatarLoadFailed = ref(false)
watch([() => profile.value?.userId, () => profile.value?.avatarUrl], () => {
  avatarLoadFailed.value = false
})
const titleBar = ref<HTMLElement | null>(null)
let titleObserver: ResizeObserver | undefined
onMounted(() => {
  if (props.preview) return
  const updateInset = (): void => {
    if (titleBar.value)
      titleBar.value.ownerDocument.documentElement.style.setProperty(
        '--te-titlebar-inset',
        `${titleBar.value.getBoundingClientRect().bottom}px`
      )
  }
  titleObserver = new ResizeObserver(updateInset)
  if (titleBar.value) titleObserver.observe(titleBar.value)
  updateInset()
})
onBeforeUnmount(() => titleObserver?.disconnect())

function setPressOrigin(event: PointerEvent): void {
  const button =
    event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
  if (!button) return
  const rect = button.getBoundingClientRect()
  button.style.setProperty('--te-lg-press-x', `${event.clientX - rect.left}px`)
  button.style.setProperty('--te-lg-press-y', `${event.clientY - rect.top}px`)
}

function minimize(): void {
  if (props.preview) return
  window.api.window.minimize()
}

function toggleMaximize(): void {
  if (props.preview) return
  window.api.window.toggleMaximize()
}

function close(): void {
  if (props.preview) return
  window.api.window.close()
}
</script>

<template>
  <div
    class="title-bar"
    ref="titleBar"
    :class="{
      'drag-region': !preview,
      'no-drag': preview,
      'title-bar-glass': glass && !immersive && !closeOnly,
      'title-bar-liquid': liquidMaterial && !immersive && !closeOnly,
      'title-bar-immersive': immersive && !closeOnly,
      'title-bar-close-only': closeOnly,
      'title-bar-settings': titleSurface === 'settings' && !immersive && !closeOnly,
      'title-bar-streaming': titleSurface === 'streaming' && !immersive && !closeOnly,
      'title-bar-menu-open': menuOpen && !immersive && !closeOnly
    }"
  >
    <!-- Playback already paints the caption backdrop, including filtered artwork.
         Keeping a separate material layer lets contrast preferences repaint it. -->
    <div v-if="!closeOnly && !immersive" class="title-bar-background" aria-hidden="true"></div>
    <div
      v-if="canGoBack && !preview && !closeOnly"
      class="title-bar-back no-drag"
      @pointerdown="setPressOrigin"
    >
      <button
        type="button"
        class="back-btn"
        :title="backHint ?? '返回'"
        aria-label="返回"
        @click="canGoBack && $emit('back')"
      >
        <TitleBarIcon name="arrow_left" />
      </button>
    </div>
    <div v-if="!closeOnly" class="title-bar-start no-drag" @pointerdown="setPressOrigin">
      <button
        type="button"
        aria-label="菜单"
        class="menu-btn"
        :title="menuOpen ? '收起导航' : '展开导航'"
        :aria-expanded="menuOpen"
        @click="$emit('toggleMenu')"
      >
        <TitleBarIcon name="navigation" />
      </button>
      <button
        type="button"
        :aria-label="loginLabel"
        class="login-btn"
        :title="loginLabel"
        @click="$emit('login', loginProvider?.id ?? null)"
      >
        <img
          v-if="showNcmProfile && profile?.avatarUrl && !avatarLoadFailed"
          :src="profile.avatarUrl"
          class="user-avatar"
          alt=""
          @error="avatarLoadFailed = true"
        />
        <TitleBarIcon v-else name="person" />
      </button>
    </div>
    <div class="title-bar-controls no-drag" @pointerdown="setPressOrigin">
      <div v-if="!closeOnly" class="title-bar-tools" role="group" aria-label="应用工具">
        <button
          type="button"
          aria-label="上报问题"
          class="settings-btn report-issue-btn"
          title="上报问题"
          @click="$emit('reportIssue')"
        >
          <TitleBarIcon name="bug" />
        </button>
        <button
          type="button"
          aria-label="扩展中心"
          :aria-pressed="activeTool === 'plugins'"
          class="plugins-btn"
          title="扩展中心"
          @click="$emit('plugins')"
        >
          <TitleBarIcon name="puzzle_piece" />
        </button>
        <button
          type="button"
          aria-label="设置"
          :aria-pressed="activeTool === 'settings'"
          class="settings-btn"
          title="设置"
          @click="$emit('settings')"
        >
          <TitleBarIcon name="settings" />
        </button>
        <button
          type="button"
          :disabled="preview"
          class="control-btn notification-btn"
          :aria-label="`任务与通知${doNotDisturb ? ' · 勿扰模式已开启' : ''}（${activeTaskCount} 项进行中，${unreadCount} 条未读）`"
          :title="
            doNotDisturb
              ? '任务与通知 · 勿扰模式已开启'
              : activeTaskCount
                ? `任务与通知 · ${activeTaskCount} 项进行中`
                : '任务与通知'
          "
          :aria-expanded="notificationsOpen"
          aria-controls="app-notice-history"
          @click="$emit('notifications', $event)"
        >
          <TitleBarIcon :name="doNotDisturb ? 'bell_off' : 'bell'" />
          <Transition name="notification-dot">
            <span
              v-if="!doNotDisturb && (unreadCount || activeTaskCount)"
              class="notification-dot"
              :class="{ 'notification-dot--busy': !unreadCount && activeTaskCount }"
              aria-hidden="true"
            ></span>
          </Transition>
        </button>
      </div>
      <div class="title-bar-window-controls" role="group" aria-label="窗口控制">
        <button
          v-if="!closeOnly"
          type="button"
          :disabled="preview"
          aria-label="最小化"
          class="control-btn minimize"
          title="最小化"
          @click="minimize"
        >
          <svg class="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 8.5h12" />
          </svg>
        </button>
        <button
          v-if="!closeOnly"
          type="button"
          :aria-label="maximized ? '还原窗口' : '最大化窗口'"
          class="control-btn maximize"
          :title="maximized ? '还原窗口' : '最大化窗口'"
          :disabled="preview"
          @click="toggleMaximize"
        >
          <svg class="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path v-if="maximized" d="M4.5 4.5v-2h9v9h-2M2.5 4.5h9v9h-9Z" />
            <rect v-else x="2.5" y="2.5" width="11" height="11" />
          </svg>
        </button>
        <button
          type="button"
          :disabled="preview"
          class="control-btn close"
          title="关闭窗口"
          aria-label="关闭窗口"
          @click="close"
        >
          <svg class="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m2.5 2.5 11 11m0-11-11 11" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-btn {
  position: relative;
}
.notification-icon {
  width: var(--te-titlebar-icon-size, 16px);
  height: var(--te-titlebar-icon-size, 16px);
  stroke: currentColor;
  stroke-width: 1.65;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 280ms var(--te-ease-soft);
}
.notification-dot {
  position: absolute;
  top: calc(50% - 9px);
  right: 12px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--te-primary-500);
  box-shadow: none;
}
.notification-dot--busy {
  background: currentColor;
  opacity: 0.55;
}
.notification-dot-enter-active,
.notification-dot-leave-active {
  transition:
    opacity 180ms ease,
    transform 240ms var(--te-ease-soft);
}
.notification-dot-enter-from,
.notification-dot-leave-to {
  opacity: 0;
  transform: scale(0);
}
.title-bar {
  --te-titlebar-height: 40px;
  --te-titlebar-material-surface: var(--te-chrome-frosted-solid, var(--te-app-bg));
  --te-titlebar-frosted-surface: var(
    --te-chrome-frosted-surface,
    color-mix(in srgb, var(--te-titlebar-material-surface) 80%, transparent)
  );
  --te-titlebar-material-ink: var(--te-shell-control-text);
  --te-titlebar-icon-size: 16px;
  --te-titlebar-control-width: 46px;
  font-family: var(--te-font-sans);
  font-weight: var(--te-control-font-weight, 500);
  letter-spacing: normal;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  min-height: 40px;
  max-height: 40px;
  box-sizing: border-box;
  flex-shrink: 0;
  background: transparent !important;
  user-select: none;
  position: fixed;
  isolation: isolate;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  overflow: hidden;
  border-bottom: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transition:
    border-color 0.3s,
    box-shadow 0.3s;
}

.title-bar-background {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 0;
  pointer-events: none;
  background: var(--te-titlebar-frosted-surface);
  box-shadow: none;
  backdrop-filter: blur(var(--te-chrome-frosted-blur, 24px))
    saturate(var(--te-chrome-frosted-saturation, 124%));
  -webkit-backdrop-filter: blur(var(--te-chrome-frosted-blur, 24px))
    saturate(var(--te-chrome-frosted-saturation, 124%));
}

.title-bar::before {
  display: none;
}

.title-bar-glass {
  --te-titlebar-material-surface: #17181a;
  --te-titlebar-frosted-surface: rgb(23 24 26 / 72%);
  --te-titlebar-material-ink: #fff;
}

/* Playback paints one continuous backdrop, including the caption strip. */
.title-bar-immersive {
  --te-shell-control-text: var(--te-playback-page-text, #f4f7fb);
  --te-shell-control-hover: color-mix(in srgb, var(--te-shell-control-text) 8%, transparent);
  --te-titlebar-material-surface: var(--te-player-bg);
  --te-titlebar-material-ink: var(--te-shell-control-text);
  /* Presets must not tint the artwork again behind the caption controls. */
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar-immersive .title-bar-background {
  background: transparent !important;
  box-shadow: none;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar-start,
.title-bar-back,
.title-bar-tools {
  --te-titlebar-icon-size: 18px;
}

.title-bar-start {
  display: flex;
  flex-shrink: 0;
  height: 100%;
  position: relative;
  z-index: 1;
}

.title-bar-back {
  display: flex;
  align-items: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  overflow: hidden;
  position: relative;
  z-index: 1;
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  min-width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.back-btn:hover {
  background: var(--te-shell-control-hover);
}

.title-bar-glass .back-btn {
  color: var(--te-on-accent);
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
}

.settings-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.plugins-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
}

.login-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

/* Use a neutral wash for dark caption feedback so album accents cannot tint the chrome. */
html[data-theme='dark'] .title-bar .control-btn:not(.notification-btn):not(.close):hover {
  background: color-mix(in srgb, var(--te-shell-control-text) 6%, transparent);
}

.user-avatar {
  width: var(--te-titlebar-icon-size, 18px);
  height: var(--te-titlebar-icon-size, 18px);
  border-radius: 50%;
  object-fit: cover;
}

.title-bar-glass :is(.menu-btn, .settings-btn, .plugins-btn) {
  color: #fff;
}

.title-bar-glass .login-btn {
  color: #fff;
}

.title-bar-controls {
  display: flex;
  flex-shrink: 0;
  height: 100%;
  margin-left: auto;
  position: relative;
  z-index: 1;
}

.title-bar-tools,
.title-bar-window-controls {
  display: flex;
  align-items: center;
  height: 100%;
}

.title-bar-window-controls {
  margin-left: 12px;
}

.title-bar-close-only .title-bar-window-controls {
  margin-left: 0;
}

html .title-bar.title-bar-close-only {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar-tools::after {
  content: '';
  width: 1px;
  height: 16px;
  background: color-mix(in srgb, var(--te-shell-control-text) 12%, transparent);
  pointer-events: none;
}

.title-bar :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn):focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: -3px;
}

.control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  min-width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  flex-shrink: 0;
  border: none;
  border-radius: 0;
  padding: 0;
  background: transparent;
  color: var(--te-shell-control-text);
  font-size: calc(var(--te-font-size-body, 14px) * 16 / 14);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.3s,
    transform 0.24s var(--te-ease-soft);
}

.control-btn:active {
  transition-duration: 0.1s;
}

.control-btn:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: -2px;
}

.window-control-icon {
  display: block;
  width: var(--te-titlebar-icon-size, 16px);
  height: var(--te-titlebar-icon-size, 16px);
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  stroke-linecap: butt;
  stroke-linejoin: miter;
}

.title-bar-glass .control-btn {
  color: #fff;
}

.title-bar-glass .control-btn:not(.notification-btn):hover {
  background: rgba(255, 255, 255, 0.08);
}

.control-btn:not(.notification-btn):hover {
  background: var(--te-shell-control-hover);
}

.control-btn.close:hover,
html[data-theme='pureWhite'] .title-bar .control-btn.close:hover,
.title-bar-liquid .control-btn.close:hover {
  background: #e81123;
  color: #fff;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn) {
  color: var(--te-shell-control-text);
  /* Match the playback surface as soon as it appears, without a light-theme tween. */
  transition-property: background-color;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):not(
    .close
  ):hover {
  color: var(--te-shell-control-text);
  transform: none;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):focus-visible {
  outline-color: var(--te-shell-control-text);
}

.title-bar-liquid {
  isolation: isolate;
  color: var(--te-lg-context-label);
}

.title-bar-liquid .title-bar-background {
  display: block;
  background: color-mix(in srgb, var(--te-lg-context-material) 72%, transparent);
  box-shadow: none;
  backdrop-filter: blur(var(--te-chrome-frosted-blur, 24px))
    saturate(var(--te-chrome-frosted-saturation, 124%));
  -webkit-backdrop-filter: blur(var(--te-chrome-frosted-blur, 24px))
    saturate(var(--te-chrome-frosted-saturation, 124%));
}

.title-bar-liquid :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn) {
  position: relative;
  overflow: hidden;
  color: inherit;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn)::after {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at var(--te-lg-press-x, 50%) var(--te-lg-press-y, 50%),
    color-mix(in srgb, var(--te-lg-context-rim) 56%, transparent),
    transparent 58%
  );
  content: '';
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease-out;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active {
  transform: scale(0.94);
  transition-duration: 90ms;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active::after {
  opacity: 1;
}

/* Inset feedback shares the caption material; the full 46 × 40 hit area stays intact. */
html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn) {
  position: relative;
  isolation: isolate;
  border-radius: 0;
  background: transparent;
  --te-titlebar-feedback: transparent;
  transition:
    background-color 160ms ease-out,
    color 160ms ease-out,
    opacity 100ms ease-out;
}

html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn)::before {
  content: '';
  position: absolute;
  inset: 5px 7px;
  border-radius: 9px;
  z-index: -1;
  pointer-events: none;
  background: var(--te-titlebar-feedback);
  transition: background-color 160ms ease-out;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn) {
  transition-property: background-color, opacity;
}

html
  .title-bar
  :is(
    .menu-btn,
    .back-btn,
    .settings-btn,
    .plugins-btn,
    .login-btn,
    .notification-btn
  ):focus-visible::before {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 1px;
}

html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn):not(
    :disabled
  ):hover {
  --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 6%, transparent);
}

html
  .title-bar
  :is(
    .settings-btn[aria-pressed='true'],
    .plugins-btn[aria-pressed='true'],
    .notification-btn[aria-expanded='true']
  ) {
  --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 12%, transparent);
  color: var(--te-primary-500);
}

html[data-theme='dark']
  .title-bar
  :is(
    .settings-btn[aria-pressed='true'],
    .plugins-btn[aria-pressed='true'],
    .notification-btn[aria-expanded='true']
  ) {
  color: var(--te-primary-400);
}

html
  .title-bar
  :is(
    .settings-btn[aria-pressed='true'],
    .plugins-btn[aria-pressed='true'],
    .notification-btn[aria-expanded='true']
  ):not(:disabled):hover {
  --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 16%, transparent);
}

html
  .title-bar
  :is(
    .menu-btn,
    .back-btn,
    .settings-btn,
    .plugins-btn,
    .login-btn,
    .notification-btn
  ):focus-visible {
  outline: none;
}

html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn):active {
  transform: none;
  opacity: 0.8;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn)::after {
  inset: 5px 7px;
  border-radius: 9px;
}

@media (prefers-contrast: more) {
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .plugins-btn[aria-pressed='true'],
      .notification-btn[aria-expanded='true']
    ),
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .plugins-btn[aria-pressed='true'],
      .notification-btn[aria-expanded='true']
    ):hover {
    --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 22%, transparent);
    color: var(--te-shell-control-text);
  }
}

@media (forced-colors: active) {
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .plugins-btn[aria-pressed='true'],
      .notification-btn[aria-expanded='true']
    ),
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .plugins-btn[aria-pressed='true'],
      .notification-btn[aria-expanded='true']
    ):hover {
    --te-titlebar-feedback: Highlight;
    color: HighlightText;
    forced-color-adjust: none;
  }
  html
    .title-bar
    :is(
      .menu-btn,
      .back-btn,
      .settings-btn,
      .plugins-btn,
      .login-btn,
      .notification-btn
    ):focus-visible::before {
    outline-color: Highlight;
  }
}

html:is([data-te-motion='reduced'], [data-te-motion='off']) .title-bar button,
html:is([data-te-motion='reduced'], [data-te-motion='off']) .title-bar button::before {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .title-bar button,
  .title-bar button::before {
    transition: none;
  }
}

/* All effect switches target the painter, rather than its transparent host. */
html[data-te-effects-mode='reduced'] .title-bar .title-bar-background,
body.te-no-blur .title-bar .title-bar-background {
  background: var(--te-titlebar-material-surface) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .title-bar-background {
    background: var(--te-titlebar-material-surface) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  .title-bar-liquid .title-bar-background {
    background: var(--te-lg-context-surface-solid) !important;
    border-bottom: 1px solid var(--te-lg-context-label);
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

@media (forced-colors: active) {
  html .title-bar.title-bar-immersive {
    --te-shell-control-text: CanvasText;
    background: Canvas !important;
  }

  .title-bar .title-bar-background {
    background: Canvas !important;
    border-bottom: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}
</style>
