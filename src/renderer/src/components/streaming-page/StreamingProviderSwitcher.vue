<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { StreamingProviderOption } from '../../utils/streamingNavigation'

const props = defineProps<{
  modelValue: string
  options: StreamingProviderOption[]
}>()

const emit = defineEmits<{
  change: [providerId: string]
}>()

const providerMenuOpen = ref(false)
const switcherRef = ref<HTMLElement | null>(null)
const activeOption = computed(
  () => props.options.find((option) => option.id === props.modelValue) ?? props.options[0] ?? null
)

function toggleProviderMenu(): void {
  if (props.options.length < 2) return
  providerMenuOpen.value = !providerMenuOpen.value
}

function selectProvider(providerId: string): void {
  if (providerId !== props.modelValue) emit('change', providerId)
  providerMenuOpen.value = false
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!providerMenuOpen.value) return
  const target = event.target
  if (target instanceof Node && switcherRef.value?.contains(target)) return
  providerMenuOpen.value = false
}

function onMenuFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (!next || !switcherRef.value?.contains(next)) providerMenuOpen.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
})
</script>

<template>
  <div
    v-if="activeOption"
    ref="switcherRef"
    class="provider-switcher"
    :class="{ open: providerMenuOpen }"
    @focusout="onMenuFocusOut"
    @keydown.esc.prevent="providerMenuOpen = false"
  >
    <button
      type="button"
      class="provider-switcher-trigger"
      :style="{ '--provider-color': activeOption.color }"
      :title="
        options.length > 1
          ? `切换音源（当前：${activeOption.name}）`
          : `当前音源：${activeOption.name}`
      "
      :aria-label="
        options.length > 1
          ? `切换音源，当前为${activeOption.name}`
          : `当前音源：${activeOption.name}`
      "
      :aria-haspopup="options.length > 1 ? 'listbox' : undefined"
      :aria-expanded="options.length > 1 ? providerMenuOpen : undefined"
      :disabled="options.length < 2"
      @click="toggleProviderMenu"
    >
      <i :class="activeOption.icon" aria-hidden="true"></i>
    </button>

    <div
      v-if="providerMenuOpen"
      class="provider-switcher-menu"
      role="listbox"
      aria-label="选择音源"
    >
      <button
        v-for="option in options"
        :key="option.id"
        type="button"
        class="provider-switcher-option"
        :class="{ active: option.id === activeOption.id }"
        role="option"
        :aria-selected="option.id === activeOption.id"
        :style="{ '--provider-color': option.color }"
        @click="selectProvider(option.id)"
      >
        <i :class="option.icon" aria-hidden="true"></i>
        <span class="provider-switcher-option-name">{{ option.name }}</span>
        <i
          v-if="option.id === activeOption.id"
          class="pi pi-check provider-switcher-option-check"
          aria-hidden="true"
        ></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
.provider-switcher {
  position: relative;
  z-index: 5;
  display: inline-flex;
}

.provider-switcher-trigger {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--te-neutral-900) 12%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--te-card-bg) 86%, transparent);
  color: var(--te-neutral-700);
  box-shadow: 0 12px 32px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);
  cursor: pointer;
  backdrop-filter: blur(16px) saturate(145%);
  -webkit-backdrop-filter: blur(16px) saturate(145%);
  transition:
    transform 0.18s var(--te-ease-soft),
    background 0.18s,
    border-color 0.18s,
    box-shadow 0.18s;
}

.provider-switcher-trigger:hover,
.provider-switcher.open .provider-switcher-trigger {
  transform: translateY(-2px);
  background: var(--te-subtle-bg);
  border-color: color-mix(in srgb, var(--te-primary-500) 34%, transparent);
  box-shadow: 0 16px 36px color-mix(in srgb, var(--te-neutral-900) 12%, transparent);
}

.provider-switcher-trigger:disabled {
  cursor: default;
}

.provider-switcher-trigger > .pi {
  color: var(--provider-color, var(--te-primary-500));
  font-size: calc(var(--te-font-size-body, 14px) * 15 / 14);
}

.provider-switcher-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 10;
  min-width: 184px;
  padding: 6px;
  border: 1px solid var(--te-card-border);
  border-radius: 14px;
  background: var(--te-card-bg);
  box-shadow: 0 18px 42px color-mix(in srgb, var(--te-neutral-900) 18%, transparent);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
}

.provider-switcher-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--te-neutral-900);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.16s,
    color 0.16s;
}

.provider-switcher-option:hover,
.provider-switcher-option.active {
  background: var(--te-hover-bg);
}

.provider-switcher-option > .pi:first-child {
  flex-shrink: 0;
  color: var(--provider-color, var(--te-primary-500));
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.provider-switcher-option-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-switcher-option-check {
  flex-shrink: 0;
  color: var(--te-primary-500);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
</style>
