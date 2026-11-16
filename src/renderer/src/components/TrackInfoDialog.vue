<script setup lang="ts">
import { defineAsyncComponent, computed, ref } from 'vue'
import { useNativeDialog } from '@renderer/composables/useNativeDialog'
import { useEscapeToClose } from '@renderer/app/useDismissLayer'
import type { Track } from '@renderer/types/music'
import CoverImg from '@renderer/components/CoverImg.vue'
import LocalLibraryTagManager from '@renderer/components/LocalLibraryTagManager.vue'
import { selectLocalLibraryActionTracks } from '@renderer/utils/localTrackRemovalPolicy.ts'
import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import TrackCreditsPanel from '@renderer/components/music-metadata/TrackCreditsPanel.vue'
import TrackRatingsPanel from '@renderer/components/music-ratings/TrackRatingsPanel.vue'

const props = defineProps<{ track: Track }>()
const musicStore = useMusicStore()
const editing = ref(false)
const versions = ref(false)
const activeTab = ref<'all' | 'curation' | 'credits'>('all')
const MusicVersionsHost = defineAsyncComponent(
  () => import('@renderer/components/music-versions/MusicVersionsHost.vue')
)
const editableTracks = computed(() => {
  const track = props.track
  const id = typeof track.id === 'string' ? track.id : ''
  const source = track.source
  const mayBeLocal =
    source === 'local' ||
    (!source && (/^[a-zA-Z]:[\\/]/.test(id) || /^[\\/]/.test(id) || !id.includes(':')))
  return mayBeLocal ? selectLocalLibraryActionTracks([track]) : []
})
const emit = defineEmits<{ close: [] }>()
function onTagsApplied(): void {
  void musicStore.refreshLibraryIndex()
}
const dialog = ref<HTMLDialogElement | null>(null)
useNativeDialog(dialog)
useEscapeToClose(
  () => !editing.value && !versions.value,
  () => emit('close')
)
</script>

<template>
  <dialog
    ref="dialog"
    class="track-info-dialog"
    :class="{ 'is-editing': editing || versions }"
    aria-labelledby="track-info-title"
    @close="emit('close')"
    @cancel.prevent="versions ? (versions = false) : editing ? (editing = false) : emit('close')"
  >
    <MusicVersionsHost v-if="versions" embedded :initial-track="track" @close="versions = false" />
    <LocalLibraryTagManager
      v-else-if="editing"
      :tracks="editableTracks"
      @close="editing = false"
      @applied="onTagsApplied"
    />
    <template v-else>
      <header class="track-info-hero">
        <CoverImg
          :cover="track.cover"
          :cover-source="track.coverSource"
          size="grid"
          class="track-info-cover"
          alt=""
        />
        <div class="track-info-meta">
          <div class="track-info-title-row">
            <h2 id="track-info-title">{{ track.title }}</h2>
            <button
              type="button"
              class="track-info-close"
              aria-label="关闭歌曲信息"
              @click.stop="emit('close')"
            >
              ×
            </button>
          </div>
          <dl class="track-info-facts">
            <div>
              <dt>艺人</dt>
              <dd>{{ track.artist || '未知艺人' }}</dd>
            </div>
            <div>
              <dt>专辑</dt>
              <dd>{{ track.album || '未知专辑' }}</dd>
            </div>
            <div>
              <dt>时长</dt>
              <dd>
                {{ Math.floor(track.duration / 60) }}:{{
                  String(Math.floor(track.duration % 60)).padStart(2, '0')
                }}
              </dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd class="source-pill">{{ track.source || 'local' }}</dd>
            </div>
          </dl>
          <div class="track-info-toolbar">
            <div class="track-info-actions">
              <button
                v-if="editableTracks.length"
                type="button"
                class="track-info-edit"
                @click="editing = true"
              >
                编辑歌曲信息
              </button>
              <button type="button" class="track-info-edit" @click="versions = true">
                歌曲与专辑版本
              </button>
            </div>
            <div class="track-info-tabs" role="tablist" aria-label="歌曲详情视图切换">
              <button
                type="button"
                role="tab"
                class="tab-pill"
                :aria-selected="activeTab === 'all'"
                @click="activeTab = 'all'"
              >
                双栏总览
              </button>
              <button
                type="button"
                role="tab"
                class="tab-pill"
                :aria-selected="activeTab === 'curation'"
                @click="activeTab = 'curation'"
              >
                评分 · 偏好 · 标签
              </button>
              <button
                type="button"
                role="tab"
                class="tab-pill"
                :aria-selected="activeTab === 'credits'"
                @click="activeTab = 'credits'"
              >
                参与人员 · 探索 · 身份
              </button>
            </div>
          </div>
        </div>
      </header>

      <div class="track-info-body" :class="`mode-${activeTab}`">
        <div
          class="track-info-column"
          :class="{ 'is-hidden-pane': activeTab === 'credits' }"
        >
          <TrackRatingsPanel :track="track" />
        </div>
        <div
          class="track-info-column"
          :class="{ 'is-hidden-pane': activeTab === 'curation' }"
        >
          <TrackCreditsPanel :track="track" />
        </div>
      </div>
    </template>
  </dialog>
</template>

<style scoped>
.track-info-dialog {
  -webkit-app-region: no-drag;
  position: fixed;
  width: min(920px, calc(100vw - 40px));
  max-height: calc(100vh - 56px);
  overflow: auto;
  padding: 24px 28px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-dialog-radius, 14px);
  color: var(--te-neutral-900);
  background: var(--te-card-bg, Canvas);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
}
.track-info-dialog::backdrop {
  background: color-mix(in srgb, var(--te-neutral-900) 40%, transparent);
  backdrop-filter: blur(4px);
}
.track-info-dialog.is-editing {
  width: min(940px, calc(100vw - 40px));
  padding: 0;
}
.track-info-hero {
  display: grid;
  grid-template-columns: 108px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--te-card-border);
}
.track-info-cover {
  width: 108px;
  height: 108px;
  object-fit: cover;
  border-radius: 12px;
  border: 1px solid var(--te-card-border);
}
.track-info-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.track-info-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  margin: 0;
  font-size: 1.35em;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.track-info-close {
  font: inherit;
  font-size: calc(var(--te-font-size-body, 14px) * 22 / 14);
  line-height: 1;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--te-neutral-500);
  cursor: pointer;
}
.track-info-close:hover {
  background: var(--te-hover-bg);
  color: var(--te-neutral-900);
}
.track-info-facts {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  font-size: 13px;
}
.track-info-facts > div {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
dt {
  color: var(--te-neutral-500);
  font-size: 12px;
}
dd {
  margin: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.source-pill {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
  color: var(--te-primary-600);
}
.track-info-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 2px;
}
.track-info-actions,
.track-info-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.track-info-edit {
  padding: 6px 12px;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-hover-bg);
  color: var(--te-primary-600);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}
.track-info-edit:hover {
  border-color: color-mix(in srgb, var(--te-primary-500) 45%, var(--te-card-border));
}
.tab-pill {
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: color-mix(in srgb, var(--te-neutral-500) 8%, transparent);
  color: var(--te-neutral-600, var(--te-neutral-500));
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.tab-pill[aria-selected='true'] {
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 40%, var(--te-card-border));
  font-weight: 600;
}
.track-info-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 24px;
  align-items: start;
  margin-top: 8px;
}
.track-info-body.mode-curation,
.track-info-body.mode-credits {
  grid-template-columns: minmax(0, 1fr);
}
.track-info-column {
  min-width: 0;
}
.is-hidden-pane {
  display: none;
}
@media (max-width: 680px) {
  .track-info-hero {
    grid-template-columns: 76px minmax(0, 1fr);
    gap: 14px;
  }
  .track-info-cover {
    width: 76px;
    height: 76px;
  }
  .track-info-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
