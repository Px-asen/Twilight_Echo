<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useLyricsFontPicker } from '@renderer/composables/useLyricsFontPicker'
import MiniPlayerSettingsSection from './MiniPlayerSettingsSection.vue'
import ThemeControlsSettings from './ThemeControlsSettings.vue'
import BackgroundEditorSettings from './BackgroundEditorSettings.vue'
import FontRenderingSettings from './FontRenderingSettings.vue'
import WindowTransparencySettings from './WindowTransparencySettings.vue'
import SettingsGroup from './SettingsGroup.vue'
import PlayerBarSettings from './PlayerBarSettings.vue'
import PlayerBarLayoutSettings from './PlayerBarLayoutSettings.vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { fontFamilyOptions, uiDensityOptions, type BooleanSettingKey } from './types.ts'
import { normalizeAppFontFamily } from '../../../../shared/appFont.ts'
import type { AppSettings, UiDensity } from '../../types/settings'

const emit = defineEmits<{
  openAppearance: []
}>()

const { settings, updateSettings } = useSettingsStore()
const { installed, load: loadFonts } = useLyricsFontPicker()
onMounted(loadFonts)

const customLocalFont = computed(() =>
  settings.value.fontFamily.startsWith('local:') ? settings.value.fontFamily.slice(6) : ''
)

function setFontFamily(event: Event): void {
  const fontFamily = normalizeAppFontFamily((event.target as HTMLSelectElement).value)
  if (settings.value.fontFamily === fontFamily) return
  void updateSettings({ fontFamily })
}

function setCustomFontFamily(event: Event): void {
  const raw = (event.target as HTMLInputElement).value.trim()
  const fontFamily = raw ? normalizeAppFontFamily(`local:${raw}`) : 'system'
  if (settings.value.fontFamily === fontFamily) return
  void updateSettings({ fontFamily })
}

function setUiDensity(density: UiDensity): void {
  if (settings.value.uiDensity === density) return
  void updateSettings({ uiDensity: density })
}

function toggleSetting(key: BooleanSettingKey): void {
  void updateSettings({ [key]: !settings.value[key] } as Partial<AppSettings>)
}
</script>

<template>
  <section id="appearance" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-palette"></i>
      <h2>外观</h2>
    </div>

    <p class="settings-section-description">搭配主题、文字与播放器，让界面适合你的使用习惯。</p>
    <div class="setting-list">
      <div data-setting-id="appearance-workspace" class="setting-item">
        <div class="setting-copy">
          <strong>自定义主题</strong>
          <span>通过 2D/3D 预览调整外观，使用高级工具制作并导出 .TEP 主题插件。</span>
        </div>
        <button type="button" class="soft-button" @click="emit('openAppearance')">
          打开自定义主题
        </button>
      </div>
    </div>
    <div class="section-block">
      <h3>主题与配色</h3>
      <div class="setting-list">
        <ThemeControlsSettings />
      </div>
    </div>
    <div class="section-block">
      <h3>背景与材质</h3>
      <div class="setting-list">
        <BackgroundEditorSettings />
        <hr />
        <div data-setting-id="cover-theme" id="setting-cover-theme" class="setting-item">
          <div class="setting-copy">
            <strong>封面主题色</strong>
            <span>播放页和底栏使用当前专辑封面提取的主题色。</span>
          </div>
          <button
            type="button"
            aria-label="封面主题色"
            class="toggle-switch"
            :class="{ active: settings.useCoverTheme, inactive: !settings.useCoverTheme }"
            role="switch"
            :aria-checked="settings.useCoverTheme"
            @click="toggleSetting('useCoverTheme')"
          ></button>
        </div>
        <SettingsGroup
          id="window-transparency-details"
          title="系统窗口透明"
          :summary="settings.windowTransparency ? '已开启' : '已关闭'"
          description="需要透出桌面或系统模糊效果时展开；这是系统窗口效果，与界面卡片材质分别设置。"
          ><WindowTransparencySettings
        /></SettingsGroup>
      </div>
    </div>
    <div class="section-block">
      <h3>文字与排版</h3>
      <div class="setting-list">
        <div data-setting-id="global-font" id="setting-global-font" class="setting-item">
          <div class="setting-copy">
            <strong>界面字体</strong>
            <span>更换界面的正文、标题与圆体字体；“默认”跟随当前主题自带的字体。</span>
          </div>
          <select
            class="preview-select wide"
            aria-label="界面字体"
            :value="settings.fontFamily"
            @change="setFontFamily"
          >
            <option v-for="option in fontFamilyOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
            <optgroup label="系统已安装字体">
              <option
                v-if="customLocalFont && !installed.includes(customLocalFont)"
                :value="`local:${customLocalFont}`"
              >
                {{ customLocalFont }}
              </option>
              <option v-for="family in installed" :key="family" :value="`local:${family}`">
                {{ family }}
              </option>
            </optgroup>
          </select>
        </div>
        <hr />
        <div data-setting-id="global-font-custom" class="setting-item">
          <div class="setting-copy">
            <strong>本机字体名称</strong>
            <span>可直接输入系统已安装的字体家族名（如 FOT-TsukuMin Pro），清空则恢复默认。</span>
          </div>
          <input
            type="text"
            class="preview-select wide"
            aria-label="本机字体名称"
            maxlength="96"
            placeholder="例如 Microsoft YaHei UI"
            :value="customLocalFont"
            @change="setCustomFontFamily"
          />
        </div>
        <hr />
        <FontRenderingSettings />
        <hr />
        <div data-setting-id="ui-density" id="setting-ui-density" class="setting-item">
          <div class="setting-copy">
            <strong>界面密度</strong>
            <span>控制列表项的间距与信息密度。</span>
          </div>
          <div class="segmented-control density">
            <button
              v-for="option in uiDensityOptions"
              :key="option.value"
              type="button"
              :class="{ active: settings.uiDensity === option.value }"
              @click="setUiDensity(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <SettingsGroup
      id="player-bar"
      title="播放条"
      :summary="
        '形态：' +
        { standard: '标准', mini: '迷你', compact: '紧凑' }[settings.playerBar.mode] +
        ' · ' +
        { visible: '常显', autoHide: '自动隐藏', hidden: '完全隐藏' }[settings.playerBar.visibility]
      "
      description="先选择形态与显示方式；需要调整播放页差异、自动隐藏或按钮布局时，再展开对应选项。"
    >
      <div class="setting-list">
        <PlayerBarSettings />
        <div
          data-setting-id="compact-visualizer"
          id="setting-compact-visualizer"
          class="setting-item"
        >
          <div class="setting-copy">
            <strong>歌词页底部动态频谱</strong
            ><span>显示播放条上的动态频谱；关闭时停止频谱数据轮询。</span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            role="switch"
            aria-label="歌词页底部动态频谱"
            :aria-checked="settings.playerBar.compactVisualizerEnabled"
            :class="{ active: settings.playerBar.compactVisualizerEnabled }"
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
          ><PlayerBarLayoutSettings
        /></SettingsGroup>
      </div>
    </SettingsGroup>
    <MiniPlayerSettingsSection />
  </section>
</template>
