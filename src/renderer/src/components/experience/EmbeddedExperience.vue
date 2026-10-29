<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { InstalledExperience } from '../../../../shared/pluginExperience.ts'
import { createExperienceBridge } from '../../extensions/experienceBridge'

const props = defineProps<{ experience: InstalledExperience }>()
const emit = defineEmits<{ exit: [] }>()
const frame = ref<HTMLIFrameElement>()
const ready = ref(false)
const error = ref('')
const attempt = ref(0)
let dispose: (() => void) | undefined
let port: MessagePort | undefined
let deadline: ReturnType<typeof setTimeout> | undefined
let appearanceObserver: MutationObserver | undefined

function sendAppearance(): void {
  if (!port) return
  const root = document.documentElement
  const style = getComputedStyle(root)
  const token = (name: string) => style.getPropertyValue(name).trim()
  port.postMessage({
    event: 'appearance',
    value: {
      theme: root.dataset.theme === 'dark' ? 'dark' : 'pureWhite',
      colors: {
        text: token('--te-navigation-text'),
        muted: token('--te-navigation-icon'),
        accent: token('--te-navigation-indicator'),
        surface: token('--te-card-bg'),
        border: token('--te-navigation-border')
      },
      fontFamily: token('--te-font-sans'),
      fontSize: token('--te-font-size-body'),
      reducedMotion: ['reduced', 'off'].includes(root.dataset.teMotion ?? '')
    }
  })
}

function release(): void {
  clearTimeout(deadline)
  dispose?.()
  dispose = undefined
  port = undefined
}

function handshake(event: MessageEvent): void {
  if (
    event.source !== frame.value?.contentWindow ||
    event.origin !== `plugin-ui://${props.experience.pluginId}` ||
    event.data?.type !== 'twilight-experience-ready'
  )
    return
  release()
  if ((event.data.bridgeVersion ?? 1) !== props.experience.bridgeVersion) {
    ready.value = false
    error.value = '界面桥接版本不匹配，请更新插件或宿主。'
    return
  }
  const channel = new MessageChannel()
  port = channel.port1
  dispose = createExperienceBridge(
    props.experience,
    port,
    () => emit('exit'),
    () => {
      if (props.experience.launch === 'sidebar') throw new Error('请从主界面打开宿主设置面板。')
    }
  )
  frame.value!.contentWindow!.postMessage(
    { type: 'twilight-experience-connect', bridgeVersion: props.experience.bridgeVersion },
    { targetOrigin: event.origin, transfer: [channel.port2] }
  )
  ready.value = true
  error.value = ''
  sendAppearance()
}

function startDeadline(): void {
  deadline = setTimeout(() => {
    if (!ready.value && !error.value) error.value = '插件界面未能连接。'
  }, 20_000)
}

function retry(): void {
  release()
  ready.value = false
  error.value = ''
  attempt.value++
  startDeadline()
}

onMounted(() => {
  window.addEventListener('message', handshake)
  appearanceObserver = new MutationObserver(sendAppearance)
  appearanceObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-te-motion', 'style', 'class']
  })
  startDeadline()
})
onBeforeUnmount(() => {
  release()
  appearanceObserver?.disconnect()
  window.removeEventListener('message', handshake)
})
</script>

<template>
  <div class="embedded-experience" :aria-busy="!ready && !error">
    <iframe
      :key="attempt"
      ref="frame"
      :src="experience.url"
      :title="experience.name"
      :inert="!ready || !!error"
      tabindex="0"
      sandbox="allow-scripts allow-same-origin"
    ></iframe>
    <div v-if="error" class="embedded-status" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="retry">重试</button>
    </div>
    <div v-else-if="!ready" class="embedded-status" role="status">正在连接…</div>
  </div>
</template>

<style scoped>
.embedded-experience {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}

.embedded-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: safe center;
  gap: 10px;
  overflow-y: auto;
  padding: 12px;
  background: var(--te-card-bg);
  color: var(--te-navigation-text);
  font: calc(var(--te-font-size-body, 14px) * 12 / 14) / 1.5 var(--te-font-sans);
  text-align: center;
  overflow-wrap: anywhere;
}

.embedded-status span {
  flex-shrink: 0;
}

.embedded-status button {
  flex-shrink: 0;
  min-height: 32px;
  padding: 4px 12px;
  border: 1px solid var(--te-navigation-border);
  border-radius: var(--te-control-radius-md, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.embedded-status button:hover {
  background: var(--te-navigation-hover);
}

.embedded-status button:focus-visible {
  outline: 2px solid var(--te-navigation-indicator);
  outline-offset: 2px;
}
</style>
