<script setup lang="ts">
import { computed } from 'vue'
import SettingsGroup from './SettingsGroup.vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  PLAYER_BAR_BOUNDS,
  normalizePlayerBarPageMode,
  normalizePlayerBarPageVisibility,
  playerBarAutoHideApplies,
  playerBarShapeCanAutoHide,
  type PlayerBarMode,
  type PlayerBarPageVisibility,
  type PlayerBarVisibility
} from '../../../../shared/playerBar.ts'
import {
  playerBarModeOptions,
  playerBarPageModeOptions,
  playerBarPageVisibilityOptions,
  playerBarVisibilityOptions
} from './types.ts'

const { settings, updateSettings } = useSettingsStore()

function setPlayerBarMode(mode: PlayerBarMode): void {
  if (settings.value.playerBar.mode === mode && settings.value.playerBar.modeSource === 'user')
    return
  void updateSettings({
    playerBar: { ...settings.value.playerBar, mode, modeSource: 'user' }
  })
}

function setPlayerBarPlayingPageMode(value: string): void {
  const playingPageMode = normalizePlayerBarPageMode(value)
  if (settings.value.playerBar.playingPageMode === playingPageMode) return
  void updateSettings({ playerBar: { ...settings.value.playerBar, playingPageMode } })
}

function setPlayerBarVisibility(visibility: PlayerBarVisibility): void {
  if (settings.value.playerBar.visibility === visibility) return
  void updateSettings({ playerBar: { ...settings.value.playerBar, visibility } })
}

function setPlayerBarPlayingPageVisibility(value: string): void {
  const playingPageVisibility = normalizePlayerBarPageVisibility(value)
  if (settings.value.playerBar.playingPageVisibility === playingPageVisibility) return
  void updateSettings({ playerBar: { ...settings.value.playerBar, playingPageVisibility } })
}

function setPlayerBarNumber(field: 'revealThresholdPx' | 'hideDelayMs', value: number): void {
  if (!Number.isFinite(value)) return
  void updateSettings({ playerBar: { ...settings.value.playerBar, [field]: value } })
}

/**
 * The reveal sliders only matter if auto-hide can actually take effect somewhere,
 * so ask the shared policy about both scopes rather than re-deriving the rules.
 */
const autoHideAppliesAnywhere = computed(() => {
  const bar = settings.value.playerBar
  return (
    playerBarAutoHideApplies(bar, { onPlayingPage: false }) ||
    playerBarAutoHideApplies(bar, { onPlayingPage: true })
  )
})

/** Whether each scope resolves to a shape that carries its own progress readout. */
const globalShapeCanAutoHide = computed(() =>
  playerBarShapeCanAutoHide(settings.value.playerBar.mode)
)
const playingPageShapeCanAutoHide = computed(() => {
  const bar = settings.value.playerBar
  return playerBarShapeCanAutoHide(
    bar.playingPageMode === 'inherit' ? bar.mode : bar.playingPageMode
  )
})

/**
 * Auto-hide needs a shape with its own progress readout — mini's long rail or
 * compact's top-edge line. Rather than letting the user pick a step that
 * silently does nothing, mark it unavailable per scope and say why.
 */
function visibilityOptionDisabled(value: PlayerBarVisibility | PlayerBarPageVisibility): boolean {
  return value === 'autoHide' && !globalShapeCanAutoHide.value
}

function pageVisibilityOptionDisabled(value: PlayerBarPageVisibility): boolean {
  return value === 'autoHide' && !playingPageShapeCanAutoHide.value
}
</script>

<template>
  <div data-setting-id="player-bar-mode" id="setting-player-bar-mode" class="setting-item">
    <div class="setting-copy">
      <strong>播放条形态</strong>
      <span
        >迷你形态用扁平长进度条，保留上一首、播放和下一首；紧凑形态贴着窗口底边通栏，进度走顶边细线。每种形态装哪些按钮见下面的「播放条按钮编排」。</span
      >
    </div>
    <div class="segmented-control">
      <button
        v-for="option in playerBarModeOptions"
        :key="option.value"
        type="button"
        :class="{ active: settings.playerBar.mode === option.value }"
        @click="setPlayerBarMode(option.value)"
      >
        <i :class="option.icon"></i>
        {{ option.label }}
      </button>
    </div>
  </div>
  <hr />
  <div
    data-setting-id="player-bar-visibility"
    id="setting-player-bar-visibility"
    class="setting-item"
  >
    <div class="setting-copy">
      <strong>播放条可见性</strong>
      <span>
        常显始终保留播放条；自动隐藏平时收起、鼠标靠近窗口底边时滑出（需迷你或紧凑形态）；完全隐藏则不再出现，也不会被鼠标唤出。
      </span>
    </div>
    <div class="segmented-control">
      <button
        v-for="option in playerBarVisibilityOptions"
        :key="option.value"
        type="button"
        :class="{
          active: settings.playerBar.visibility === option.value,
          disabled: visibilityOptionDisabled(option.value)
        }"
        :disabled="visibilityOptionDisabled(option.value)"
        :title="visibilityOptionDisabled(option.value) ? '自动隐藏需要全局形态为迷你或紧凑' : ''"
        @click="setPlayerBarVisibility(option.value)"
      >
        <i :class="option.icon"></i>
        {{ option.label }}
      </button>
    </div>
  </div>
  <SettingsGroup
    id="player-bar-behavior-details"
    title="播放页与自动隐藏"
    :summary="
      '播放页：' +
      (playerBarPageModeOptions.find(
        (option) => option.value === settings.playerBar.playingPageMode
      )?.label ?? '跟随全局')
    "
    description="可以只改变播放页；触发距离和收起延迟仅在自动隐藏可用时显示。"
    ><div data-setting-id="player-page-mode" id="setting-player-page-mode" class="setting-item">
      <div class="setting-copy">
        <strong>播放页形态</strong>
        <span>可以只在播放页换一种形态，其余界面保持全局形态。</span>
      </div>
      <select
        class="preview-select"
        :value="settings.playerBar.playingPageMode"
        @change="setPlayerBarPlayingPageMode(($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="option in playerBarPageModeOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>
    </div>
    <div
      data-setting-id="player-page-visibility"
      id="setting-player-page-visibility"
      class="setting-item"
    >
      <div class="setting-copy">
        <strong>播放页可见性</strong>
        <span>可以只在播放页自动隐藏或完全隐藏播放条，其余界面保持全局可见性。</span>
      </div>
      <select
        class="preview-select"
        :value="settings.playerBar.playingPageVisibility"
        @change="setPlayerBarPlayingPageVisibility(($event.target as HTMLSelectElement).value)"
      >
        <option
          v-for="option in playerBarPageVisibilityOptions"
          :key="option.value"
          :value="option.value"
          :disabled="pageVisibilityOptionDisabled(option.value)"
        >
          {{ option.label }}
        </option>
      </select>
    </div>
    <template v-if="autoHideAppliesAnywhere">
      <hr />
      <div
        data-setting-id="player-bar-threshold"
        id="setting-player-bar-threshold"
        class="setting-item"
      >
        <div class="setting-copy">
          <strong>触发距离</strong>
          <span>鼠标距窗口底边多少像素内触发滑出。</span>
        </div>
        <div class="range-pill">
          <span>距离</span>
          <input
            class="range-input"
            type="range"
            :min="PLAYER_BAR_BOUNDS.revealThresholdPx.min"
            :max="PLAYER_BAR_BOUNDS.revealThresholdPx.max"
            :value="settings.playerBar.revealThresholdPx"
            @input="
              setPlayerBarNumber(
                'revealThresholdPx',
                Number(($event.target as HTMLInputElement).value)
              )
            "
          />
          <EditableRangeValue
            :value="settings.playerBar.revealThresholdPx"
            :min="PLAYER_BAR_BOUNDS.revealThresholdPx.min"
            :max="PLAYER_BAR_BOUNDS.revealThresholdPx.max"
            suffix="px"
            aria-label="编辑触发距离"
            @change="setPlayerBarNumber('revealThresholdPx', $event)"
          />
        </div>
      </div>
      <hr />
      <div data-setting-id="player-bar-delay" id="setting-player-bar-delay" class="setting-item">
        <div class="setting-copy">
          <strong>收起延迟</strong>
          <span>鼠标离开触发区后延迟多久收起播放条。</span>
        </div>
        <div class="range-pill">
          <span>延迟</span>
          <input
            class="range-input"
            type="range"
            :min="PLAYER_BAR_BOUNDS.hideDelayMs.min"
            :max="PLAYER_BAR_BOUNDS.hideDelayMs.max"
            step="50"
            :value="settings.playerBar.hideDelayMs"
            @input="
              setPlayerBarNumber('hideDelayMs', Number(($event.target as HTMLInputElement).value))
            "
          />
          <EditableRangeValue
            :value="settings.playerBar.hideDelayMs"
            :min="PLAYER_BAR_BOUNDS.hideDelayMs.min"
            :max="PLAYER_BAR_BOUNDS.hideDelayMs.max"
            :step="50"
            suffix="ms"
            aria-label="编辑收起延迟"
            @change="setPlayerBarNumber('hideDelayMs', $event)"
          />
        </div>
      </div> </template
  ></SettingsGroup>
</template>
