<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import { useEscapeToClose } from '@renderer/app/useDismissLayer.ts'
import type { Playlist } from '@renderer/stores/useMusicStore.ts'
import type { PlaylistDialogRequest } from '@renderer/components/song-list/usePlaylistLifecycleActions.ts'

const props = defineProps<{
  request: PlaylistDialogRequest
  error: string
  targets: Pick<Playlist, 'id' | 'name'>[]
}>()
const emit = defineEmits<{ close: []; confirm: [value: string] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const targetSelect = ref<HTMLSelectElement | null>(null)
const value = ref(props.request.initialValue)
useNativeDialog(dialog)

const labels = computed(() => {
  if (props.request.kind === 'move') {
    return { title: '移动到其他歌单', field: '目标歌单', confirm: '移动歌曲' }
  }
  if (props.request.kind === 'copy') {
    return { title: '复制歌单', field: '副本名称', confirm: '创建副本' }
  }
  return { title: '重命名歌单', field: '歌单名称', confirm: '保存' }
})

function confirm(): void {
  if (value.value.trim()) emit('confirm', value.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault()
}

function onBackdropClick(event: MouseEvent): void {
  const element = dialog.value
  if (!element || event.target !== element) return
  const bounds = element.getBoundingClientRect()
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  ) {
    emit('close')
  }
}

useEscapeToClose(
  () => true,
  () => emit('close')
)
onMounted(() => {
  if (input.value) input.value.select()
  else targetSelect.value?.focus()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="playlist-action-dialog"
    aria-labelledby="playlist-action-title"
    @cancel.prevent="emit('close')"
    @click.self="onBackdropClick"
  >
    <form @submit.prevent="confirm" @keydown="onKeydown">
      <h2 id="playlist-action-title">{{ labels.title }}</h2>
      <label for="playlist-action-value">{{ labels.field }}</label>
      <select
        v-if="request.kind === 'move'"
        id="playlist-action-value"
        ref="targetSelect"
        v-model="value"
        :aria-invalid="!!error"
        :aria-describedby="error ? 'playlist-action-error' : undefined"
      >
        <option v-for="target in targets" :key="target.id" :value="target.id">
          {{ target.name }}
        </option>
      </select>
      <input
        v-else
        id="playlist-action-value"
        ref="input"
        v-model="value"
        type="text"
        maxlength="80"
        autocomplete="off"
        :aria-invalid="!!error"
        :aria-describedby="error ? 'playlist-action-error' : undefined"
      />
      <p v-if="error" id="playlist-action-error" class="playlist-action-error" role="alert">
        {{ error }}
      </p>
      <div class="playlist-dialog-actions">
        <button type="button" @click="emit('close')">取消</button>
        <button type="submit" class="primary" :disabled="!value.trim()">
          {{ labels.confirm }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<style scoped>
.playlist-action-dialog {
  width: min(400px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  box-sizing: border-box;
  margin: auto;
  padding: 20px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-dialog-radius, 12px);
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  box-shadow: var(--te-glass-shadow);
  font-size: var(--te-font-size-body, 14px);
}

.playlist-action-dialog::backdrop {
  background: var(--te-dialog-backdrop);
}

h2 {
  margin: 0 0 16px;
  font-size: var(--te-type-section-title, calc(var(--te-font-size-body, 14px) * 20 / 14));
  font-weight: 600;
}

label {
  display: block;
  margin-bottom: 8px;
  color: var(--te-neutral-700);
  font-size: var(--te-type-caption, calc(var(--te-font-size-body, 14px) * 13 / 14));
}

input,
select,
button {
  box-sizing: border-box;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-control-radius-sm, 8px);
  font: inherit;
  color: var(--te-neutral-900);
}

input,
select {
  width: 100%;
  min-height: 36px;
  padding: 8px 12px;
  background: var(--te-subtle-bg);
}

input:focus-visible,
select:focus-visible,
button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 3px;
}

.playlist-action-error {
  margin: 10px 0 0;
  color: var(--te-danger-soft-fg);
  font-size: 0.92857em;
  overflow-wrap: anywhere;
}

.playlist-dialog-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

button {
  min-height: 36px;
  padding: 8px 18px;
  background: var(--te-subtle-bg);
  cursor: pointer;
}

button.primary {
  border-color: transparent;
  background: var(--te-control-accent);
  color: var(--te-control-on-accent);
  font-weight: 600;
}

@media (hover: hover) {
  button:hover:not(:disabled) {
    background: var(--te-hover-bg);
  }

  button.primary:hover:not(:disabled) {
    background: var(--te-control-accent);
    filter: brightness(0.95);
  }
}

button:active:not(:disabled) {
  transform: scale(0.97);
}

button:disabled {
  opacity: 0.45;
  cursor: default;
}

:global(html[data-te-motion='reduced']) button:active,
:global(html[data-te-motion='off']) button:active {
  transform: none;
}

@media (prefers-reduced-motion: reduce) {
  @scope (:root:not([data-te-motion='full'])) {
    button:active:not(:disabled) {
      transform: none;
    }
  }
}
</style>
