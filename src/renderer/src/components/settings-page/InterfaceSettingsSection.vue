<script setup lang="ts">
import MiniPlayerSettingsSection from './MiniPlayerSettingsSection.vue'
import PlayerBarLayoutSettings from './PlayerBarLayoutSettings.vue'
import PlayerBarSettings from './PlayerBarSettings.vue'
import SettingsGroup from './SettingsGroup.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'

const { settings, updateSettings } = useSettingsStore()
</script>

<template>
  <section id="interface" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-window-maximize" aria-hidden="true" />
      <h2>播放器界面</h2>
    </div>
    <p class="settings-section-description">
      播放条的形态、显示方式与按钮编排，以及迷你播放器。
    </p>
    <div id="player-bar" class="section-block">
      <h3>播放条</h3>
      <div class="setting-list">
        <PlayerBarSettings />
        <hr />
        <div
          data-setting-id="compact-visualizer"
          id="setting-compact-visualizer"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>歌词页底部动态频谱</strong>
            <span>显示播放条上的动态频谱；关闭时停止频谱数据轮询。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            role="switch"
            aria-label="歌词页底部动态频谱"
            :aria-checked="settings.playerBar.compactVisualizerEnabled"
            :class="{
              active: settings.playerBar.compactVisualizerEnabled,
              inactive: !settings.playerBar.compactVisualizerEnabled
            }"
            @click="
              updateSettings({
                playerBar: {
                  ...settings.playerBar,
                  compactVisualizerEnabled: !settings.playerBar.compactVisualizerEnabled
                }
              })
            "
          />
        </div>
        <SettingsGroup
          id="player-bar-layout-details"
          title="按钮编排"
          :summary="
            '当前全局形态：' +
            { standard: '标准', mini: '迷你', compact: '紧凑' }[settings.playerBar.mode]
          "
          description="调整每种播放条上的按钮和顺序；编辑布局不会切换正在使用的形态。"
        >
          <PlayerBarLayoutSettings />
        </SettingsGroup>
      </div>
    </div>
    <MiniPlayerSettingsSection />
  </section>
</template>
