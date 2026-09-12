<script setup lang="ts">
import type { MediaProviderPlaylistSummary } from '../../providers/mediaProvider'
import NativeContextMenu from '@renderer/components/NativeContextMenu.vue'
import type { ProviderDownloadQuality } from '../../../../shared/providerDownloads.ts'

defineProps<{
  show: boolean
  x: number
  y: number
  allFavorited: boolean
  actionLabel: string
  canLike: boolean
  singleLiked: boolean
  canManagePlaylists: boolean
  ownedUserPlaylists: MediaProviderPlaylistSummary[]
  showPlaylistSubmenu: boolean
  canRemoveFromPlaylist: boolean
  canDownload: boolean
  showDownloadQualityMenu: boolean
  aggregatePlaylists: Array<{ id: string; name: string }>
  showAggregateSubmenu: boolean
}>()

const emit = defineEmits<{
  play: []
  playNext: []
  favorite: []
  like: []
  createPlaylist: []
  addToOwnedPlaylist: [playlist: MediaProviderPlaylistSummary]
  addToPlaylist: []
  removeFromPlaylist: []
  download: [quality: ProviderDownloadQuality]
  close: []
  togglePlaylistSubmenu: [value: boolean]
  toggleDownloadQualityMenu: [value: boolean]
  addToAggregatePlaylist: [playlistId: string]
  createAggregatePlaylist: []
  toggleAggregateSubmenu: [value: boolean]
}>()
</script>

<template>
  <Teleport to="body">
    <NativeContextMenu
      v-if="show"
      class="streaming-context-menu"
      :style="{ top: `${y}px`, left: `${x}px` }"
      @click.stop
      @close="emit('close')"
    >
      <div
        class="menu-item"
        role="menuitem"
        tabindex="0"
        data-te-interactive
        @click="emit('play')"
        @keydown.enter.prevent="emit('play')"
        @keydown.space.prevent="emit('play')"
      >
        <i class="pi pi-play"></i>
        <span>播放</span>
      </div>
      <div
        class="menu-item"
        role="menuitem"
        tabindex="0"
        data-te-interactive
        @click="emit('playNext')"
        @keydown.enter.prevent="emit('playNext')"
        @keydown.space.prevent="emit('playNext')"
      >
        <i class="pi pi-step-forward"></i><span>下一首播放</span>
      </div>
      <div
        class="menu-item"
        role="menuitem"
        tabindex="0"
        data-te-interactive
        @click="emit('favorite')"
        @keydown.enter.prevent="emit('favorite')"
        @keydown.space.prevent="emit('favorite')"
      >
        <i :class="allFavorited ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
        <span> {{ allFavorited ? '取消收藏' : '加入收藏' }}{{ actionLabel }} </span>
      </div>
      <div
        v-if="canLike"
        class="menu-item"
        role="menuitem"
        tabindex="0"
        data-te-interactive
        @click="emit('like')"
        @keydown.enter.prevent="emit('like')"
        @keydown.space.prevent="emit('like')"
      >
        <i :class="singleLiked ? 'pi pi-heart-fill' : 'pi pi-heart'"></i>
        <span>{{ singleLiked ? '取消喜欢' : '喜欢' }}</span>
      </div>
      <div
        v-if="canManagePlaylists"
        class="menu-item"
        @mouseenter="emit('togglePlaylistSubmenu', true)"
        @mouseleave="emit('togglePlaylistSubmenu', false)"
      >
        <i class="pi pi-plus"></i>
        <span>添加到歌单{{ actionLabel }}</span>
        <i class="pi pi-chevron-right submenu-icon"></i>
        <div class="submenu">
          <div
            class="menu-item create-playlist-menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('createPlaylist')"
            @keydown.enter.prevent="emit('createPlaylist')"
            @keydown.space.prevent="emit('createPlaylist')"
          >
            <i class="pi pi-plus"></i>
            <span>创建新歌单</span>
          </div>
          <div v-if="ownedUserPlaylists.length === 0" class="menu-item disabled">暂无自建歌单</div>
          <div
            v-for="playlist in ownedUserPlaylists"
            :key="playlist.id"
            class="menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('addToOwnedPlaylist', playlist)"
            @keydown.enter.prevent="emit('addToOwnedPlaylist', playlist)"
            @keydown.space.prevent="emit('addToOwnedPlaylist', playlist)"
          >
            {{ playlist.name }}
          </div>
          <div
            class="menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('addToPlaylist')"
            @keydown.enter.prevent="emit('addToPlaylist')"
            @keydown.space.prevent="emit('addToPlaylist')"
          >
            <i class="pi pi-list"></i>
            <span>选择歌单…</span>
          </div>
        </div>
      </div>
      <div
        class="menu-item"
        @mouseenter="emit('toggleAggregateSubmenu', true)"
        @mouseleave="emit('toggleAggregateSubmenu', false)"
      >
        <i class="pi pi-sitemap"></i>
        <span>添加到聚合歌单{{ actionLabel }}</span>
        <i class="pi pi-chevron-right submenu-icon"></i>
        <div class="submenu">
          <div
            class="menu-item create-playlist-menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('createAggregatePlaylist')"
            @keydown.enter.prevent="emit('createAggregatePlaylist')"
            @keydown.space.prevent="emit('createAggregatePlaylist')"
          >
            <i class="pi pi-plus"></i>
            <span>新建聚合歌单…</span>
          </div>
          <div v-if="aggregatePlaylists.length === 0" class="menu-item disabled">暂无聚合歌单</div>
          <div
            v-for="playlist in aggregatePlaylists"
            :key="playlist.id"
            class="menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('addToAggregatePlaylist', playlist.id)"
            @keydown.enter.prevent="emit('addToAggregatePlaylist', playlist.id)"
            @keydown.space.prevent="emit('addToAggregatePlaylist', playlist.id)"
          >
            {{ playlist.name }}
          </div>
        </div>
      </div>
      <div
        v-if="canRemoveFromPlaylist"
        class="menu-item danger"
        role="menuitem"
        tabindex="0"
        data-te-interactive
        @click="emit('removeFromPlaylist')"
        @keydown.enter.prevent="emit('removeFromPlaylist')"
        @keydown.space.prevent="emit('removeFromPlaylist')"
      >
        <i class="pi pi-minus-circle"></i>
        <span>从歌单移除{{ actionLabel }}</span>
      </div>
      <div
        v-if="canDownload"
        class="menu-item"
        role="menuitem"
        tabindex="0"
        data-te-interactive
        @mouseenter="emit('toggleDownloadQualityMenu', true)"
        @mouseleave="emit('toggleDownloadQualityMenu', false)"
      >
        <i class="pi pi-download"></i>
        <span>下载到本地{{ actionLabel }}</span>
        <i class="pi pi-chevron-right submenu-icon"></i>
        <div class="submenu">
          <div
            class="menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('download', 'hi-res')"
            @keydown.enter.prevent="emit('download', 'hi-res')"
            @keydown.space.prevent="emit('download', 'hi-res')"
          >
            <i class="pi pi-bolt"></i>
            <span>Hi-Res</span>
          </div>
          <div
            class="menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('download', 'lossless')"
            @keydown.enter.prevent="emit('download', 'lossless')"
            @keydown.space.prevent="emit('download', 'lossless')"
          >
            <i class="pi pi-wave-pulse"></i>
            <span>Lossless</span>
          </div>
          <div
            class="menu-item"
            role="menuitem"
            tabindex="0"
            data-te-interactive
            @click="emit('download', 'aac')"
            @keydown.enter.prevent="emit('download', 'aac')"
            @keydown.space.prevent="emit('download', 'aac')"
          >
            <i class="pi pi-volume-down"></i>
            <span>AAC</span>
          </div>
        </div>
      </div>
    </NativeContextMenu>
  </Teleport>
</template>

<style scoped>
.streaming-context-menu {
  position: fixed;
  z-index: 4500;
  min-width: 180px;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.68);
  background: var(--te-glass-bg, rgba(255, 255, 255, 0.92));
  box-shadow: 0 20px 60px rgba(86, 70, 160, 0.18);
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
}

.streaming-context-menu .menu-item {
  display: flex;
  align-items: center;
  position: relative;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  color: var(--te-neutral-800, #1e293b);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    transform 0.15s;
}

.streaming-context-menu .menu-item:hover {
  background: rgba(124, 77, 255, 0.1);
  transform: translateX(2px);
}

.streaming-context-menu .menu-item.danger,
.streaming-context-menu .menu-item.danger i {
  color: #b42318;
}

.streaming-context-menu .menu-item.danger:hover {
  background: rgba(180, 35, 24, 0.1);
}

.streaming-context-menu .menu-item i {
  margin-right: 10px;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  color: var(--te-neutral-500, #64748b);
}

.streaming-context-menu .menu-item.disabled {
  color: #cbd5e1;
  pointer-events: none;
}

.streaming-context-menu .submenu-icon {
  margin-left: auto;
  margin-right: 0 !important;
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14) !important;
  color: #94a3b8 !important;
}

.streaming-context-menu .submenu {
  position: absolute;
  left: 100%;
  top: 0;
  min-width: 160px;
  max-height: min(360px, 70vh);
  overflow: auto;
  margin-left: 2px;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.68);
  background: var(--te-glass-bg-strong, rgba(255, 255, 255, 0.96));
  box-shadow: 0 20px 60px rgba(86, 70, 160, 0.18);
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
}

:global(html[data-theme='dark'] .streaming-context-menu),
:global(html[data-theme='dark'] .streaming-context-menu .submenu) {
  border-color: rgba(148, 163, 184, 0.2);
  background: rgba(30, 41, 59, 0.96);
  color: #e2e8f0;
}

:global(html[data-theme='dark'] .streaming-context-menu .menu-item) {
  color: #e2e8f0;
}

:global(html[data-theme='dark'] .streaming-context-menu .menu-item:hover) {
  background: rgba(129, 140, 248, 0.16);
}
</style>
