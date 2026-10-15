<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import ThemeIcon from '@renderer/components/ThemeIcon.vue'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { useHoldReorder } from '@renderer/composables/useHoldReorder'
import {
  createNavigationPageDraft,
  moveNavigationPage,
  orderNavigationPages,
  type NavigationPageDefinition
} from '@renderer/app/navigationPages.ts'
import { normalizeNavigationPagePreferences } from '../../../../shared/navigationPages.ts'
import { useEscapeToClose } from '@renderer/app/useDismissLayer'
import { sidebarGroupTitle } from '@renderer/app/sidebarNavigation.ts'

const props = defineProps<{ pages: NavigationPageDefinition[]; edit: boolean }>()
const emit = defineEmits<{ close: []; select: [page: NavigationPageDefinition] }>()
const store = useSettingsStore()
const dialog = ref<HTMLDialogElement | null>(null)
const query = ref('')
const busy = ref(false)
const error = ref('')
const previous = normalizeNavigationPagePreferences(store.settings.value.navigationPages)
const draft = shallowRef(createNavigationPageDraft(props.pages, previous))
const ordered = computed(() => orderNavigationPages(props.pages, draft.value))
const results = computed(() => {
  const text = query.value.trim().toLocaleLowerCase()
  return text
    ? ordered.value.filter((page) =>
        `${page.title} ${page.description}`.toLocaleLowerCase().includes(text)
      )
    : ordered.value
})
useNativeDialog(dialog)

function move(from: string, to: string): void {
  draft.value = moveNavigationPage(draft.value, from, to)
}
const reorder = useHoldReorder(move, 0)
function step(id: string, offset: number): void {
  const target = ordered.value[ordered.value.findIndex((page) => page.id === id) + offset]
  if (target) move(id, target.id)
}
function toggle(id: string): void {
  const hidden = new Set(draft.value.hidden)
  if (hidden.has(id)) hidden.delete(id)
  else hidden.add(id)
  draft.value = { ...draft.value, hidden: [...hidden] }
}
function reset(): void {
  draft.value = {
    version: 1,
    order: props.pages.map((page) => page.id),
    hidden: props.pages.filter((page) => !page.defaultVisible).map((page) => page.id)
  }
}
async function save(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await store.updateSettings({ navigationPages: draft.value })
    emit('close')
  } catch (cause) {
    error.value = `无法保存页面配置：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    busy.value = false
  }
}
function close(): void {
  if (!busy.value) emit('close')
}
let backdropPressed = false
function isBackdrop(event: MouseEvent): boolean {
  const element = dialog.value
  if (!element || event.target !== element) return false
  const bounds = element.getBoundingClientRect()
  return (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
}
function onBackdropPointerDown(event: PointerEvent): void {
  backdropPressed = isBackdrop(event)
}
function onBackdropClick(event: MouseEvent): void {
  if (backdropPressed && isBackdrop(event)) close()
  backdropPressed = false
}
useEscapeToClose(() => !busy.value, close)
</script>

<template>
  <dialog
    ref="dialog"
    class="navigation-pages-dialog"
    aria-labelledby="navigation-pages-title"
    @cancel.prevent="close"
    @pointerdown="onBackdropPointerDown"
    @click="onBackdropClick"
  >
    <header>
      <div>
        <h2 id="navigation-pages-title">{{ edit ? '编辑页面' : '全部页面' }}</h2>
        <p>
          {{
            edit ? '拖动排序，勾选显示；同一栏目内的页面依次排列' : '打开页面，不改变侧栏的显示配置'
          }}
        </p>
      </div>
      <button type="button" aria-label="关闭" :disabled="busy" @click="close">
        <i class="pi pi-times" aria-hidden="true"></i>
      </button>
    </header>
    <input
      v-if="!edit"
      v-model="query"
      type="text"
      placeholder="搜索页面"
      aria-label="搜索页面"
      autofocus
    />
    <div class="navigation-page-list" data-reorder-group :aria-busy="busy">
      <div
        v-for="(page, index) in results"
        :key="page.id"
        class="navigation-page-row"
        :class="{
          dragging: reorder.active.value === page.id,
          over: reorder.over.value === page.id
        }"
        :data-reorder-id="page.id"
      >
        <template v-if="edit">
          <span
            class="drag-handle"
            aria-hidden="true"
            @pointerdown="!busy && reorder.start($event, page.id)"
            ><i class="pi pi-bars" aria-hidden="true"></i
          ></span>
          <input
            type="checkbox"
            :checked="!draft.hidden.includes(page.id)"
            :disabled="busy"
            :aria-label="`显示${page.title}`"
            @change="toggle(page.id)"
          />
        </template>
        <button
          type="button"
          class="page-destination"
          :disabled="edit"
          @click="emit('select', page)"
        >
          <i v-if="page.customIcon" :class="page.customIcon" aria-hidden="true"></i
          ><ThemeIcon v-else :icon-slot="page.icon" />
          <span
            ><strong>{{ page.title }}</strong
            ><small
              >{{ sidebarGroupTitle(page.id) ? `${sidebarGroupTitle(page.id)} · ` : ''
              }}{{ page.unavailableReason ?? page.description }}</small
            ></span
          >
        </button>
        <template v-if="edit">
          <button
            type="button"
            :disabled="busy || index === 0"
            :aria-label="`上移${page.title}`"
            @click="step(page.id, -1)"
          >
            <i class="pi pi-arrow-up" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            :disabled="busy || index === results.length - 1"
            :aria-label="`下移${page.title}`"
            @click="step(page.id, 1)"
          >
            <i class="pi pi-arrow-down" aria-hidden="true"></i>
          </button>
        </template>
      </div>
      <p v-if="results.length === 0" class="empty">没有匹配的页面</p>
    </div>
    <p v-if="error" class="save-error" role="alert">{{ error }}</p>
    <footer v-if="edit">
      <button type="button" :disabled="busy" @click="reset">恢复默认</button>
      <span></span><button type="button" :disabled="busy" @click="close">取消</button
      ><button class="primary" type="button" :disabled="busy" @click="save">
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </footer>
  </dialog>
</template>

<style scoped>
.navigation-pages-dialog {
  width: min(580px, calc(100vw - 32px));
  max-height: min(760px, calc(100vh - 48px));
  margin: auto;
  padding: 24px;
  box-sizing: border-box;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-dialog-radius, 18px);
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.navigation-pages-dialog::backdrop {
  background: var(--te-dialog-backdrop);
}
header,
footer,
.navigation-page-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
header {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 1.4);
}
p {
  color: var(--te-neutral-600);
  margin: 6px 0 0;
  font-size: var(--te-font-size-body, 14px);
}
input[type='text'] {
  padding: 12px;
  background: var(--te-subtle-bg);
  color: inherit;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  font: inherit;
}
button {
  border: 0;
  background: transparent;
  color: inherit;
  border-radius: 8px;
  padding: 8px;
  font: inherit;
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: var(--te-hover-bg);
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
button:disabled {
  cursor: default;
}
.navigation-page-list {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}
.navigation-page-row {
  min-height: 68px;
  padding: 0 4px;
  border-radius: 10px;
}
.page-destination {
  display: flex;
  align-items: center;
  text-align: left;
  gap: 14px;
  flex: 1;
  min-width: 0;
  padding: 10px;
}
.page-destination > :first-child {
  flex-shrink: 0;
  width: 20px;
}
.page-destination:disabled {
  opacity: 1;
}
.page-destination span {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
strong {
  font-size: var(--te-font-size-body, 14px);
  font-weight: 600;
}
small {
  font-size: calc(var(--te-font-size-body, 14px) * 0.85);
  color: var(--te-neutral-600);
}
.drag-handle {
  cursor: grab;
  touch-action: none;
  width: 28px;
  height: 36px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.dragging {
  opacity: 0.5;
}
.over {
  box-shadow: inset 0 2px var(--te-navigation-indicator);
}
footer {
  padding-top: 8px;
  border-top: 1px solid var(--te-card-border);
}
footer span {
  flex: 1;
}
footer button {
  padding: 10px 14px;
}
.primary {
  background: var(--te-navigation-active);
  color: var(--te-navigation-active-text);
}
.save-error {
  color: var(--te-danger-soft-fg);
}
.empty {
  padding: 24px;
  text-align: center;
}
@media (max-width: 540px) {
  .navigation-pages-dialog {
    padding: 16px;
  }
  small {
    display: none;
  }
  .navigation-page-row {
    min-height: 56px;
  }
}
</style>

<style scoped>
.navigation-pages-dialog:not([open]) {
  display: none;
}
</style>
