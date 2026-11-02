<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMusicStore } from '../../stores/useMusicStore'
import type { Playlist } from '../../stores/useMusicStore'
import CoverImg from '../CoverImg.vue'
import CreateAggregatePlaylistDialog from '../aggregate-playlist/CreateAggregatePlaylistDialog.vue'

const emit = defineEmits<{
  selectView: [category: string, filter: string | null]
  importExternal: []
}>()
const music = useMusicStore()
const query = ref('')
const createDialog = ref(false)
const createName = ref('')
const createError = ref('')
const aggregateDialog = ref(false)

type PlaylistCard = Playlist & {
  count: number
  kindLabel: string
  coverValue: string | null
  coverSourceValue: string | null
}
const cards = computed<PlaylistCard[]>(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase()
  return music.playlists.value
    .map((playlist) => {
      const count = playlist.count
      const kindLabel = playlist.imported
        ? '外部歌单'
        : playlist.kind === 'aggregate'
          ? '聚合'
          : '应用'
      return {
        ...playlist,
        count,
        kindLabel,
        coverValue: playlist.cover || null,
        coverSourceValue: null
      }
    })
    .filter(
      (playlist) =>
        !normalizedQuery ||
        `${playlist.name} ${playlist.kindLabel} ${playlist.imported?.source.label ?? ''}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
    )
    .sort((left, right) => {
      const leftPin = left.pinnedAt ?? ''
      const rightPin = right.pinnedAt ?? ''
      if (leftPin !== rightPin) return rightPin.localeCompare(leftPin)
      return (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)
    })
})

function open(playlist: PlaylistCard): void {
  if (playlist.imported) emit('selectView', 'playlists', `external-playlist:${playlist.id}`)
  else if (playlist.kind === 'aggregate') emit('selectView', 'aggregate', playlist.id)
  else emit('selectView', 'playlists', `playlist:${playlist.name}`)
}
async function createPlaylist(): Promise<void> {
  const name = createName.value.trim()
  if (!name) {
    createError.value = '请输入歌单名称'
    return
  }
  try {
    await music.createPlaylist(name)
    createDialog.value = false
    createName.value = ''
    createError.value = ''
  } catch (error) {
    createError.value = error instanceof Error ? error.message : String(error)
  }
}
async function togglePin(playlist: Playlist, event: Event): Promise<void> {
  event.stopPropagation()
  await music.setPlaylistPinned(playlist.id, !playlist.pinnedAt)
}
async function removePlaylist(playlist: Playlist, event: Event): Promise<void> {
  event.stopPropagation()
  const verb = '删除歌单'
  if (window.confirm(`确定${verb}「${playlist.name}」吗？`)) await music.deletePlaylist(playlist.id)
}
function handleCreated(): void {
  aggregateDialog.value = false
}
</script>

<template>
  <main class="playlist-library">
    <header class="library-header">
      <div>
        <h1>歌单</h1>
      </div>
      <div class="library-actions">
        <button type="button" @click="createDialog = true">
          <i class="pi pi-plus" aria-hidden="true"></i><span>新建歌单</span>
        </button>
        <button type="button" @click="aggregateDialog = true">
          <i class="pi pi-sitemap" aria-hidden="true"></i><span>新建聚合歌单</span>
        </button>
        <button type="button" class="primary" @click="emit('importExternal')">
          <i class="pi pi-download" aria-hidden="true"></i><span>导入外部歌单</span>
        </button>
      </div>
    </header>
    <div class="library-toolbar">
      <label
        ><span class="pi pi-search" aria-hidden="true"></span
        ><input v-model="query" aria-label="搜索歌单" placeholder="搜索歌单名称或类型"
      /></label>
    </div>
    <section v-if="cards.length" class="playlist-grid" aria-label="全部歌单">
      <article v-for="playlist in cards" :key="playlist.id" class="playlist-card">
        <button
          class="card-open"
          type="button"
          :aria-label="`打开${playlist.name}`"
          @click="open(playlist)"
        >
          <div class="card-cover">
            <CoverImg
              v-if="playlist.coverValue"
              :cover="playlist.coverValue"
              :cover-source="playlist.coverSourceValue"
              :identity="playlist.id"
              :alt="`${playlist.name} 封面`"
              loading="lazy"
            />
            <i
              v-else
              :class="playlist.kind === 'aggregate' ? 'pi pi-sitemap' : 'pi pi-list'"
              aria-hidden="true"
            ></i>
          </div>
          <div class="card-copy">
            <span class="card-kind">{{
              playlist.kindLabel
            }}</span>
            <strong :title="playlist.name">{{ playlist.name }}</strong>
            <small
              >{{ playlist.count }} 首<span v-if="playlist.imported?.source.label">
                · {{ playlist.imported.source.label }}</span
              ></small
            >
          </div>
        </button>
        <div class="card-actions">
          <button
            v-if="playlist.kind === 'aggregate'"
            type="button"
            :title="playlist.pinnedAt ? '取消置顶' : '置顶'"
            :aria-label="playlist.pinnedAt ? '取消置顶' : '置顶'"
            @click="togglePin(playlist, $event)"
          >
            <i class="pi pi-thumbtack" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            title="删除歌单"
            aria-label="删除歌单"
            @click="removePlaylist(playlist, $event)"
          >
            <i class="pi pi-trash" aria-hidden="true"></i>
          </button>
        </div>
      </article>
    </section>
    <div v-else class="empty-state">
      <i class="pi pi-list" aria-hidden="true"></i>
      <strong>{{ query ? '没有匹配的歌单' : '还没有歌单' }}</strong>
      <button v-if="!query" type="button" class="primary" @click="emit('importExternal')">
        导入外部歌单
      </button>
    </div>

    <div v-if="createDialog" class="create-overlay" @click.self="createDialog = false">
      <section
        class="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-playlist-title"
      >
        <h2 id="create-playlist-title">新建歌单</h2>
        <input
          v-model="createName"
          autofocus
          maxlength="80"
          aria-label="歌单名称"
          placeholder="歌单名称"
          @keydown.enter="createPlaylist"
        />
        <p v-if="createError" role="alert">{{ createError }}</p>
        <footer>
          <button type="button" @click="createDialog = false">取消</button
          ><button type="button" class="primary" @click="createPlaylist">创建</button>
        </footer>
      </section>
    </div>
    <CreateAggregatePlaylistDialog
      :show="aggregateDialog"
      :tracks="[]"
      @close="aggregateDialog = false"
      @created="handleCreated"
    />
  </main>
</template>

<style scoped>
.playlist-library {
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  padding: 28px min(4.4vw, 48px) 90px;
  color: var(--te-neutral-900);
  background: transparent;
}
.library-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 22px;
  padding: 0 0 24px;
  border-bottom: 1px solid var(--te-card-border);
}
h1 {
  margin: 0;
  font-size: 25px;
  font-weight: 700;
}
.library-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.library-actions button,
.card-actions button,
.create-dialog button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 36px;
  border: 1px solid var(--te-card-border);
  border-radius: 7px;
  padding: 0 12px;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-800);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.library-actions button:hover,
.card-actions button:hover,
.create-dialog button:hover {
  background: var(--te-hover-bg);
}
.library-actions .primary,
.create-dialog .primary,
.empty-state .primary {
  border-color: transparent;
  background: var(--te-primary-500);
  color: #fff;
}
.library-toolbar {
  display: flex;
  justify-content: flex-end;
  padding: 18px 0;
}
.library-toolbar label {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(340px, 100%);
  border: 1px solid var(--te-card-border);
  border-radius: 7px;
  padding: 0 12px;
  background: var(--te-subtle-bg);
  color: var(--te-neutral-500);
}
.library-toolbar input {
  width: 100%;
  height: 38px;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--te-neutral-900);
  font: inherit;
  font-size: 13px;
}
.playlist-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.playlist-card {
  position: relative;
  min-width: 0;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-card-bg);
  overflow: hidden;
  transition:
    border-color 0.16s,
    background 0.16s;
}
.playlist-card:hover {
  border-color: var(--te-primary-300, var(--te-primary-500));
}
.card-open {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 14px;
  border: 0;
  padding: 12px 42px 12px 12px;
  text-align: left;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.card-cover {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  flex: none;
  overflow: hidden;
  border-radius: 6px;
  background: var(--te-subtle-bg);
  color: var(--te-primary-500);
}
.card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.card-cover > i {
  font-size: 22px;
}
.card-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
}
.card-copy strong {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}
.card-copy small {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--te-neutral-500);
  font-size: 12px;
}
.card-kind {
  color: var(--te-neutral-500);
  font-size: 10px;
  font-weight: 700;
}
.card-kind.staged {
  color: var(--te-warning-600, #a86a1d);
}
.card-actions {
  position: absolute;
  top: 12px;
  right: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.card-actions button {
  width: var(--te-control-height-sm);
  height: var(--te-control-height-sm);
  min-height: var(--te-control-height-sm);
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--te-neutral-500);
}
.empty-state {
  display: flex;
  min-height: 240px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--te-neutral-500);
}
.empty-state > i {
  font-size: 26px;
}
.empty-state strong {
  color: var(--te-neutral-800);
  font-size: 15px;
}
.create-overlay {
  position: fixed;
  inset: 0;
  z-index: 1600;
  display: grid;
  place-items: center;
  background: #0007;
  padding: 20px;
}
.create-dialog {
  width: min(400px, 100%);
  box-sizing: border-box;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  padding: 22px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  box-shadow: var(--te-card-shadow);
}
.create-dialog h2 {
  margin: 0 0 16px;
  font-size: 19px;
}
.create-dialog input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--te-card-border);
  border-radius: 7px;
  padding: 10px 12px;
  background: var(--te-subtle-bg);
  color: inherit;
  font: inherit;
}
.create-dialog p {
  color: var(--te-danger-500);
  font-size: 12px;
}
.create-dialog footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
@media (max-width: 760px) {
  .playlist-library {
    padding-inline: 20px;
  }
  .library-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .library-actions {
    justify-content: flex-start;
  }
  .playlist-grid {
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  }
}
.library-toolbar label:focus-within {
  border-color: color-mix(in srgb, var(--te-control-focus-color) 42%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--te-control-focus-color) 12%, transparent);
}
</style>
