<script setup lang="ts">
import type { CloseWindowBehavior, PlaybackResumeMode } from '@renderer/types/settings'

const props = defineProps<{
  closeWindowBehavior: CloseWindowBehavior
  launchAtLogin: boolean
  resumeMode: PlaybackResumeMode
  taskbarThumbarButtonsEnabled: boolean
  globalShortcuts: boolean
  smtcEnabled: boolean
  discordRpcEnabled: boolean
}>()
const emit = defineEmits<{
  'update:closeWindowBehavior': [value: CloseWindowBehavior]
  'update:launchAtLogin': [value: boolean]
  'update:resumeMode': [value: PlaybackResumeMode]
  'update:taskbarThumbarButtonsEnabled': [value: boolean]
  'update:globalShortcuts': [value: boolean]
  'update:smtcEnabled': [value: boolean]
  'update:discordRpcEnabled': [value: boolean]
}>()

const closeBehaviorOptions: {
  value: CloseWindowBehavior
  title: string
  desc: string
  icon: string
}[] = [
  {
    value: 'quit',
    title: '直接退出',
    desc: '关闭窗口就是结束应用',
    icon: 'ph ph-power'
  },
  {
    value: 'tray',
    title: '进入托盘',
    desc: '音乐继续播放，从系统托盘唤回',
    icon: 'ph ph-tray'
  },
  {
    value: 'miniPlayer',
    title: '切换迷你播放器',
    desc: '收起主窗口，显示迷你播放器',
    icon: 'ph ph-picture-in-picture'
  }
]
</script>

<template>
  <section class="onb-stage" data-scene="07">
    <p class="onb-kicker">任务栏与后台</p>
    <h1 class="onb-title">让它<em>融入你的桌面</em></h1>

    <div
      class="onb-cards onb-close-behavior-cards has-selection"
      role="radiogroup"
      aria-label="关闭窗口行为"
    >
      <button
        v-for="option in closeBehaviorOptions"
        :key="option.value"
        type="button"
        class="onb-card is-compact"
        :class="{ 'is-selected': props.closeWindowBehavior === option.value }"
        role="radio"
        :aria-checked="props.closeWindowBehavior === option.value"
        @click="emit('update:closeWindowBehavior', option.value)"
      >
        <span v-if="props.closeWindowBehavior === option.value" class="onb-card-check">
          <i class="ph ph-check"></i>
        </span>
        <i class="onb-card-icon" :class="option.icon"></i>
        <span class="onb-card-title">{{ option.title }}</span>
        <span class="onb-card-desc">{{ option.desc }}</span>
      </button>
    </div>

    <div class="onb-panel">
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>任务栏缩略图按钮</strong>
          <span>悬停在 Windows 任务栏图标上，即可切歌、播放/暂停和喜欢歌曲。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.taskbarThumbarButtonsEnabled }"
          role="switch"
          :aria-checked="props.taskbarThumbarButtonsEnabled"
          aria-label="任务栏缩略图按钮"
          @click="emit('update:taskbarThumbarButtonsEnabled', !props.taskbarThumbarButtonsEnabled)"
        ></button>
      </div>
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>系统媒体控制（SMTC）</strong>
          <span>在系统音量条、媒体键与锁屏界面显示正在播放的歌曲。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.smtcEnabled }"
          role="switch"
          :aria-checked="props.smtcEnabled"
          aria-label="系统媒体控制"
          @click="emit('update:smtcEnabled', !props.smtcEnabled)"
        ></button>
      </div>
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>全局快捷键</strong>
          <span>在其他应用中切歌或暂停。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.globalShortcuts }"
          role="switch"
          :aria-checked="props.globalShortcuts"
          aria-label="全局快捷键"
          @click="emit('update:globalShortcuts', !props.globalShortcuts)"
        ></button>
      </div>
    </div>

    <div class="onb-panel">
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>开机自动启动</strong>
          <span>登录系统后在后台静候，随时开始播放。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.launchAtLogin }"
          role="switch"
          :aria-checked="props.launchAtLogin"
          aria-label="开机自动启动"
          @click="emit('update:launchAtLogin', !props.launchAtLogin)"
        ></button>
      </div>
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>记住播放进度</strong>
          <span>下次启动时从上次停下的那首歌、那一秒继续。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.resumeMode === 'trackAndPosition' }"
          role="switch"
          :aria-checked="props.resumeMode === 'trackAndPosition'"
          aria-label="记住播放进度"
          @click="
            emit(
              'update:resumeMode',
              props.resumeMode === 'trackAndPosition' ? 'off' : 'trackAndPosition'
            )
          "
        ></button>
      </div>
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>Discord 状态展示</strong>
          <span>把正在听的歌曲展示在你的 Discord 个人状态上。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.discordRpcEnabled }"
          role="switch"
          :aria-checked="props.discordRpcEnabled"
          aria-label="Discord 状态展示"
          @click="emit('update:discordRpcEnabled', !props.discordRpcEnabled)"
        ></button>
      </div>
    </div>
  </section>
</template>
