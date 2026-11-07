<script setup lang="ts">
import { observeMotionPolicy } from '../../app/motion/policy'
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
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
const menuRef = ref<HTMLElement | null>(null)
const menuId = useId()
const menuStyle = ref({ left: '0px', top: '0px', maxHeight: '320px', transformOrigin: 'right top' })
const activeOption = computed(
  () => props.options.find((option) => option.id === props.modelValue) ?? props.options[0] ?? null
)

function toggleProviderMenu(): void {
  if (props.options.length < 2) return
  const menu = menuRef.value
  const rect = switcherRef.value?.getBoundingClientRect()
  if (!menu || !rect) return
  if (menu.matches(':popover-open')) {
    closeMenu()
    return
  }
  positionMenu()
  menu.inert = false
  menu.showPopover()
  providerMenuOpen.value = true
}

function positionMenu(): void {
  const rect = switcherRef.value?.getBoundingClientRect()
  if (!rect) return
  const below = Math.max(0, window.innerHeight - rect.bottom - 16)
  const above = Math.max(0, rect.top - 16)
  const upward = below < 200 && above > below
  const height = Math.min(320, upward ? above : below)
  const left = Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228))
  menuStyle.value = {
    left: `${left}px`,
    top: `${upward ? Math.max(8, rect.top - height - 8) : rect.bottom + 8}px`,
    maxHeight: `${height}px`,
    transformOrigin: `${Math.max(0, Math.min(220, rect.left + rect.width / 2 - left))}px ${upward ? 'bottom' : 'top'}`
  }
}

function closeMenu(): void {
  if (menuRef.value) menuRef.value.inert = true
  menuRef.value?.hidePopover()
  providerMenuOpen.value = false
}

function onViewportChange(event: Event): void {
  if (event.target instanceof Node && menuRef.value?.contains(event.target)) return
  if (providerMenuOpen.value) positionMenu()
}

function onToggle(event: Event): void {
  providerMenuOpen.value = (event as ToggleEvent).newState === 'open'
  if (menuRef.value) menuRef.value.inert = !providerMenuOpen.value
}

function selectProvider(providerId: string): void {
  if (providerId !== props.modelValue) emit('change', providerId)
  closeMenu()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!providerMenuOpen.value) return
  const target = event.target
  if (target instanceof Node && switcherRef.value?.contains(target)) return
  closeMenu()
}

function onMenuFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && !switcherRef.value?.contains(next)) closeMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
  stopMotionPolicy()
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})
const stopMotionPolicy = observeMotionPolicy(document, () => {})
</script>

<template>
  <div
    v-if="activeOption"
    ref="switcherRef"
    class="provider-switcher"
    :class="{ open: providerMenuOpen }"
    @focusout="onMenuFocusOut"
    @keydown.esc.prevent="closeMenu"
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
      :aria-controls="menuId"
      :disabled="options.length < 2"
      @click="toggleProviderMenu"
    >
      <i :class="activeOption.icon" aria-hidden="true"></i>
      <span class="provider-switcher-label">{{ activeOption.name }}</span>
    </button>

    <div
      :id="menuId"
      ref="menuRef"
      class="provider-switcher-menu"
      popover="auto"
      :style="menuStyle"
      @toggle="onToggle"
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

.provider-switcher.open .provider-switcher-trigger {
  background: var(--te-subtle-bg);
  border-color: color-mix(in srgb, var(--te-primary-500) 34%, transparent);
  box-shadow: 0 16px 36px color-mix(in srgb, var(--te-neutral-900) 12%, transparent);
}
@media (hover: hover) and (pointer: fine) {
  .provider-switcher-trigger:hover {
    transform: translateY(-2px);
    background: var(--te-subtle-bg);
    border-color: color-mix(in srgb, var(--te-primary-500) 34%, transparent);
  }
}

.provider-switcher-trigger:disabled {
  cursor: default;
}

.provider-switcher-trigger > .pi {
  color: var(--provider-color, var(--te-primary-500));
  font-size: calc(var(--te-font-size-body, 14px) * 15 / 14);
}

.provider-switcher-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  width: min(220px, calc(100vw - 16px));
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  z-index: 10;
  padding: 6px;
  border: 1px solid var(--te-card-border);
  border-radius: 14px;
  background: var(--te-card-bg);
  box-shadow: 0 18px 42px color-mix(in srgb, var(--te-neutral-900) 18%, transparent);
  backdrop-filter: blur(18px) saturate(145%);
  -webkit-backdrop-filter: blur(18px) saturate(145%);
  opacity: 0;
  transform: scale(0.97);
  pointer-events: none;
  transition:
    opacity 120ms var(--te-ease-out-strong),
    transform 120ms var(--te-ease-out-strong),
    display 120ms allow-discrete,
    overlay 120ms allow-discrete;
}

.provider-switcher-menu:popover-open {
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition-duration: 180ms;
  @starting-style {
    opacity: 0;
    transform: scale(0.97);
  }
}

:global(html[data-te-motion='reduced'] .provider-switcher-menu) {
  transform: none;
  transition:
    opacity 120ms var(--te-ease-out-strong),
    display 120ms allow-discrete,
    overlay 120ms allow-discrete !important;
  @starting-style {
    transform: none;
  }
}

:global(html[data-te-motion='off'] .provider-switcher-menu),
:global(html[data-te-motion-input='keyboard'] .provider-switcher-menu),
:global(html[data-te-visibility='hidden'] .provider-switcher-menu) {
  transform: none;
  transition: none !important;
}
:global(html[data-te-motion-input='keyboard'] .provider-switcher-trigger) {
  transform: none;
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  :global(html:not([data-te-motion='full'], [data-te-motion='off']) .provider-switcher-menu) {
    transform: none;
    transition-property: opacity, display, overlay;
    transition-duration: 100ms;
    @starting-style {
      transform: none;
    }
  }
}

.provider-switcher-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: var(--te-control-height-field);
  padding: 0 var(--te-control-pad-x-sm);
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-neutral-900);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--te-motion-hover),
    color var(--te-motion-hover);
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

<style scoped>
.provider-switcher-trigger {
  display: flex;
  gap: 8px;
  width: auto;
  max-width: 220px;
  padding: 0 12px;
}
.provider-switcher-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--te-font-size-body, 14px);
}
</style>
