<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { createQueueWorkspaceStore } from '@renderer/stores/player/queueWorkspaceStore.ts'
import type { createQueueSessionController } from '@renderer/stores/player/queueSessionController.ts'
import { getPlaybackQueueWindow } from '@renderer/utils/playbackQueueVirtualization.ts'
import type { NamedQueueSession } from '../../../../shared/queueWorkspace.ts'

const props = defineProps<{
  workspace: ReturnType<typeof createQueueWorkspaceStore>
  controller: ReturnType<typeof createQueueSessionController>
  queueLength: number
  canUndo: boolean
  undoLabel: string
  undo: () => boolean
}>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const nameInput = ref<HTMLInputElement | null>(null)
const name = ref('')
const selectedId = ref('')
const deleting = ref(false)
const pending = ref(false)
const message = ref('')
const error = ref('')
const scrollTop = ref(0)
let previousFocus: HTMLElement | null = null
let active = true
const busy = computed(
  () => pending.value || props.workspace.busy.value || props.controller.restoring.value
)
const selected = computed(() =>
  props.workspace.sessions.value.find((session) => session.id === selectedId.value)
)
const history = computed(() => [...props.workspace.history.value].reverse())
const historyWindow = computed(() =>
  getPlaybackQueueWindow(history.value.length, scrollTop.value, 324, 54, 3)
)
const historyRows = computed(() =>
  history.value.slice(historyWindow.value.start, historyWindow.value.end)
)
const modes = {
  sequential: '顺序',
  listLoop: '列表循环',
  repeat: '单曲循环',
  shuffle: '随机',
  heart: '心动'
}

async function run(operation: () => Promise<void>, success: string): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = ''
  message.value = ''
  try {
    await operation()
    if (active) message.value = success
  } catch (reason) {
    if (active) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (active) pending.value = false
  }
}

function choose(session: NamedQueueSession): void {
  selectedId.value = session.id
  name.value = session.name
  deleting.value = false
}

function undoQueueEdit(): void {
  message.value = props.undo() ? '已撤销队列操作' : '队列已变化，当前操作无法撤销'
}

function restore(andPlay = false): void {
  const session = selected.value
  if (!session) return
  void run(
    () => props.controller.restore(session.id, andPlay),
    andPlay ? `已恢复“${session.name}”并请求播放` : `已恢复“${session.name}”，等待播放`
  )
}

function close(): void {
  props.controller.cancelRestore()
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault()
    close()
  }
}

onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  await run(props.workspace.ensureLoaded, '')
  await nextTick()
  if (active) nameInput.value?.focus()
})
onBeforeUnmount(() => {
  active = false
  props.controller.cancelRestore()
  dialog.value?.close()
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="queue-workspace"
    aria-labelledby="queue-workspace-title"
    @cancel.prevent="close"
    @click.self="close"
    @keydown="onKeydown"
  >
    <header>
      <div>
        <h2 id="queue-workspace-title">队列与会话</h2>
        <p>当前队列 {{ queueLength.toLocaleString() }} 首</p>
      </div>
      <button type="button" aria-label="关闭队列与会话" @click="close">关闭</button>
    </header>
    <nav aria-label="队列管理视图">
      <button
        type="button"
        :aria-pressed="controller.tab.value === 'sessions'"
        @click="controller.show('sessions')"
      >
        命名会话
      </button>
      <button
        type="button"
        :aria-pressed="controller.tab.value === 'history'"
        @click="controller.show('history')"
      >
        实际播放顺序
      </button>
      <button
        type="button"
        :disabled="!canUndo || busy"
        :title="undoLabel ? `撤销${undoLabel}` : '暂无可撤销操作'"
        @click="undoQueueEdit"
      >
        撤销队列操作
      </button>
    </nav>
    <div class="workspace-body" :aria-busy="busy">
      <p v-if="workspace.loading.value" role="status">正在读取会话…</p>
      <div v-if="error || workspace.error.value" class="workspace-error" role="alert">
        {{ error || workspace.error.value }}
        <button
          v-if="workspace.error.value"
          type="button"
          :disabled="busy"
          @click="run(workspace.reload, '已重新读取会话，请重试操作')"
        >
          重新读取
        </button>
      </div>
      <p v-if="message" role="status">{{ message }}</p>
      <template v-if="controller.tab.value === 'sessions'">
        <p class="hint">保存临时队列、当前歌曲与进度。恢复后保持暂停，也可选择恢复并播放。</p>
        <form class="session-save" @submit.prevent="run(() => controller.save(name), '会话已保存')">
          <label for="queue-session-name">会话名称</label>
          <div class="name-row">
            <input
              id="queue-session-name"
              ref="nameInput"
              v-model="name"
              maxlength="120"
              placeholder="例如：工作、睡前"
              :disabled="busy"
            />
            <button type="submit" class="primary" :disabled="busy || !queueLength || !name.trim()">
              保存为新会话
            </button>
          </div>
        </form>
        <p v-if="!workspace.loading.value && !workspace.sessions.value.length" class="empty">
          还没有命名会话。加入歌曲后，给当前队列取个名字。
        </p>
        <div v-else class="session-list" aria-label="已保存的会话">
          <button
            v-for="session in workspace.sessions.value"
            :key="session.id"
            type="button"
            class="session-row"
            :aria-pressed="selectedId === session.id"
            :disabled="busy"
            @click="choose(session)"
          >
            <span>{{ session.name }}</span
            ><small
              >{{ session.entries.length.toLocaleString() }} 首 ·
              {{ modes[session.playMode] }}</small
            >
          </button>
        </div>
        <section v-if="selected" class="session-actions" :aria-label="`管理会话：${selected.name}`">
          <p>
            已选择 <strong>{{ selected.name }}</strong>
          </p>
          <div class="actions">
            <button type="button" class="primary" :disabled="busy" @click="restore()">
              恢复队列
            </button>
            <button type="button" :disabled="busy" @click="restore(true)">恢复并播放</button>
            <button
              type="button"
              :disabled="busy || !queueLength"
              @click="
                run(() => controller.save(selected!.name, selected!.id), '已用当前队列覆盖会话')
              "
            >
              用当前队列覆盖
            </button>
            <button
              type="button"
              :disabled="busy || !name.trim() || name.trim() === selected.name"
              @click="run(() => workspace.rename(selected!.id, name), '会话已重命名')"
            >
              应用新名称
            </button>
            <button type="button" :disabled="busy" @click="deleting = !deleting">删除会话</button>
          </div>
          <div v-if="deleting" class="delete-confirm">
            删除“{{ selected.name }}”？
            <button
              type="button"
              :disabled="busy"
              @click="run(() => workspace.remove(selected!.id), '会话已删除')"
            >
              确认删除
            </button>
            <button type="button" @click="deleting = false">取消</button>
          </div>
        </section>
        <p v-if="controller.restoring.value" role="status">
          正在核对会话中的资源…
          <button type="button" @click="controller.cancelRestore">取消恢复</button>
        </p>
        <div v-if="controller.lastRestore.value" class="restore-result" role="status">
          <p>
            可恢复 {{ controller.lastRestore.value.queue.length.toLocaleString() }} 首，跳过
            {{ controller.lastRestore.value.missing.length.toLocaleString() }} 首。
          </p>
          <p v-if="controller.lastRestore.value.deferred" class="hint">
            网络歌曲在播放时获取新地址；无法连接时会显示播放错误。
          </p>
          <ul v-if="controller.lastRestore.value.missing.length">
            <li
              v-for="item in controller.lastRestore.value.missing.slice(0, 8)"
              :key="item.entry.queueEntryId"
            >
              {{ item.entry.title }}：{{ item.reason }}
            </li>
            <li v-if="controller.lastRestore.value.missing.length > 8">
              另有 {{ controller.lastRestore.value.missing.length - 8 }} 首不可用。
            </li>
          </ul>
        </div>
        <p class="hint capacity">
          最多 20 个会话；每个 20,000 首，合计 40,000 首。心动队列保存为当前已生成的顺序。
        </p>
      </template>
      <template v-else>
        <p class="hint">最近 200 次实际开始的播放，最新在上；暂停和继续不会重复记录。</p>
        <p v-if="!history.length" class="empty">播放歌曲后，这里会记录实际顺序。</p>
        <div
          v-else
          class="history-list"
          tabindex="0"
          aria-label="实际播放顺序"
          @scroll.passive="scrollTop = ($event.target as HTMLElement).scrollTop"
        >
          <div :style="{ height: `${history.length * 54}px`, position: 'relative' }">
            <div :style="{ transform: `translateY(${historyWindow.start * 54}px)` }">
              <div
                v-for="entry in historyRows"
                :key="entry.id"
                class="history-row"
                data-playback-history-row
              >
                <div>
                  <strong>{{ entry.track.title }}</strong
                  ><small>{{ entry.track.artist }} · {{ modes[entry.playMode] }}</small>
                </div>
                <time :datetime="entry.playedAt">{{
                  new Date(entry.playedAt).toLocaleString()
                }}</time>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </dialog>
</template>

<style scoped>
.queue-workspace {
  width: min(680px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  padding: 0;
  border: 1px solid var(--border-color, #8884);
  border-radius: 16px;
  color: var(--text-primary, #202026);
  background: var(--bg-primary, #fafafa);
  box-shadow: 0 18px 70px #0003;
  overflow: auto;
}
.queue-workspace::backdrop {
  background: #0006;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px 12px;
}
h2 {
  font-size: 18px;
  margin: 0;
}
p {
  margin: 8px 0;
  line-height: 1.5;
}
header p,
.hint,
small {
  color: var(--text-secondary, #666);
  font-size: 12px;
}
nav,
.actions,
.name-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
nav {
  padding: 0 24px 16px;
  border-bottom: 1px solid var(--border-color, #8884);
}
.workspace-body {
  padding: 12px 24px 20px;
  font-size: 13px;
}
button,
input {
  font: inherit;
  color: inherit;
  border: 1px solid var(--border-color, #8884);
  border-radius: 7px;
  padding: 8px 12px;
  background: transparent;
}
button {
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: var(--bg-secondary, #8881);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
.history-list:focus-visible {
  outline: 2px solid var(--accent-color, #6b5cff);
  outline-offset: 2px;
}
button[aria-pressed='true'],
.primary {
  border-color: var(--accent-color, #6b5cff);
  color: var(--accent-color, #6b5cff);
}
.session-save {
  margin: 18px 0;
}
.session-save label {
  display: block;
  margin-bottom: 8px;
}
input {
  min-width: 120px;
  flex: 1;
}
.session-list {
  display: grid;
  gap: 6px;
  max-height: 220px;
  overflow: auto;
  padding: 3px;
}
.session-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  text-align: left;
}
.session-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-row small {
  white-space: nowrap;
}
.session-actions {
  border-top: 1px solid var(--border-color, #8884);
  margin-top: 12px;
  padding-top: 8px;
}
.delete-confirm,
.restore-result {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg-secondary, #8881);
  border-radius: 8px;
}
.workspace-error {
  color: var(--danger-color, #b83a3a);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.empty {
  color: var(--text-secondary, #666);
  padding: 28px 0;
  text-align: center;
}
.capacity {
  margin-top: 18px;
}
.history-list {
  height: 324px;
  overflow: auto;
  overscroll-behavior: contain;
}
.history-row {
  height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--border-color, #8882);
  box-sizing: border-box;
}
.history-row div {
  min-width: 0;
}
.history-row strong,
.history-row small {
  display: block;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.history-row time {
  font-size: 11px;
  color: var(--text-secondary, #666);
  flex-shrink: 0;
}
ul {
  padding-left: 18px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
