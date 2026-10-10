<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  cloneMiniPlayerSettings,
  cloneMiniPlayerThemeProfile,
  createDefaultMiniPlayerThemeProfile,
  type MiniPlayerAppearanceSettings,
  type MiniPlayerBackgroundKind,
  type MiniPlayerBackgroundSettings,
  type MiniPlayerLayoutPreference,
  type MiniPlayerSettings,
  type MiniPlayerThemeProfile,
  type MiniPlayerVisibilitySettings
} from '../../../shared/miniPlayer.ts'
import { listMiniPlayerStyles } from './styles.ts'

type CustomizerTab = 'theme' | 'background' | 'appearance' | 'layout'
type BackgroundNumberKey =
  | 'gradientAngle'
  | 'blur'
  | 'brightness'
  | 'saturation'
  | 'opacity'
  | 'overlayOpacity'
type AppearanceNumberKey =
  | 'surfaceOpacity'
  | 'glassBlur'
  | 'cornerRadius'
  | 'borderWidth'
  | 'shadowStrength'

const props = withDefaults(
  defineProps<{
    settings: MiniPlayerSettings
    mode: 'overlay' | 'inline'
    saving?: boolean
    error?: string
    pickBackgroundImage: () => Promise<string | null>
  }>(),
  { saving: false, error: '' }
)

const emit = defineEmits<{
  'update:settings': [settings: MiniPlayerSettings]
  undo: []
  reset: []
  close: []
  flush: []
}>()

const tabs: { id: CustomizerTab; label: string; icon: string }[] = [
  { id: 'theme', label: '主题', icon: 'ph ph-swatches' },
  { id: 'background', label: '背景', icon: 'ph ph-image' },
  { id: 'appearance', label: '外观', icon: 'ph ph-sliders-horizontal' },
  { id: 'layout', label: '布局', icon: 'ph ph-layout' }
]
const backgroundKinds: { value: MiniPlayerBackgroundKind; label: string; icon: string }[] = [
  { value: 'solid', label: '纯色', icon: 'ph ph-square' },
  { value: 'gradient', label: '渐变', icon: 'ph ph-gradient' },
  { value: 'cover', label: '封面', icon: 'ph ph-vinyl-record' },
  { value: 'image', label: '图片', icon: 'ph ph-image-square' }
]
const layoutOptions: { value: MiniPlayerLayoutPreference; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'compact', label: '条形' },
  { value: 'standard', label: '卡片' },
  { value: 'wide', label: '舞台' },
  { value: 'poster', label: '海报' }
]
const backgroundSliders: {
  key: BackgroundNumberKey
  label: string
  min: number
  max: number
  unit: string
}[] = [
  { key: 'gradientAngle', label: '渐变角度', min: 0, max: 360, unit: '°' },
  { key: 'blur', label: '背景模糊', min: 0, max: 40, unit: 'px' },
  { key: 'brightness', label: '背景亮度', min: 50, max: 150, unit: '%' },
  { key: 'saturation', label: '背景饱和度', min: 0, max: 200, unit: '%' },
  { key: 'opacity', label: '背景不透明度', min: 0, max: 100, unit: '%' },
  { key: 'overlayOpacity', label: '遮罩强度', min: 0, max: 90, unit: '%' }
]
const appearanceSliders: {
  key: AppearanceNumberKey
  label: string
  min: number
  max: number
  unit: string
}[] = [
  { key: 'surfaceOpacity', label: '表面不透明度', min: 40, max: 100, unit: '%' },
  { key: 'glassBlur', label: '毛玻璃', min: 0, max: 40, unit: 'px' },
  { key: 'cornerRadius', label: '窗口圆角', min: 0, max: 36, unit: 'px' },
  { key: 'borderWidth', label: '边框粗细', min: 0, max: 3, unit: 'px' },
  { key: 'shadowStrength', label: '阴影强度', min: 0, max: 100, unit: '%' }
]
const visibilityOptions: { key: keyof MiniPlayerVisibilitySettings; label: string }[] = [
  { key: 'artwork', label: '专辑封面' },
  { key: 'album', label: '专辑名称' },
  { key: 'equalizer', label: '律动指示' },
  { key: 'time', label: '时间信息' },
  { key: 'volume', label: '音量控制' },
  { key: 'playMode', label: '播放模式' },
  { key: 'queuePosition', label: '队列位置' }
]

const activeTab = ref<CustomizerTab>('theme')
const localError = ref('')
const themes = listMiniPlayerStyles()
const activeProfile = computed(
  () =>
    props.settings.profiles[props.settings.activeStyleId] ??
    createDefaultMiniPlayerThemeProfile(props.settings.activeStyleId)
)
const visibleError = computed(() => localError.value || props.error)
const imagePreviewStyle = computed(() => ({
  backgroundImage: activeProfile.value.background.imageUrl
    ? `url("${activeProfile.value.background.imageUrl.replace(/"/g, '\\"')}")`
    : 'none'
}))

function selectTheme(styleId: string): void {
  const next = cloneMiniPlayerSettings(props.settings)
  if (!next.profiles[styleId]) {
    next.profiles[styleId] = createDefaultMiniPlayerThemeProfile(styleId)
  }
  next.activeStyleId = styleId
  emit('update:settings', next)
}

function replaceActiveProfile(profile: MiniPlayerThemeProfile): void {
  const next = cloneMiniPlayerSettings(props.settings)
  next.profiles[next.activeStyleId] = cloneMiniPlayerThemeProfile(profile)
  emit('update:settings', next)
}

function updateBackground<K extends keyof MiniPlayerBackgroundSettings>(
  key: K,
  value: MiniPlayerBackgroundSettings[K]
): void {
  replaceActiveProfile({
    ...activeProfile.value,
    background: { ...activeProfile.value.background, [key]: value }
  })
}

function updateAppearance<K extends keyof MiniPlayerAppearanceSettings>(
  key: K,
  value: MiniPlayerAppearanceSettings[K]
): void {
  replaceActiveProfile({
    ...activeProfile.value,
    appearance: { ...activeProfile.value.appearance, [key]: value }
  })
}

function updateVisibility(key: keyof MiniPlayerVisibilitySettings, value: boolean): void {
  replaceActiveProfile({
    ...activeProfile.value,
    visibility: { ...activeProfile.value.visibility, [key]: value }
  })
}

function updateLayoutPreference(preference: MiniPlayerLayoutPreference): void {
  replaceActiveProfile({
    ...activeProfile.value,
    layout: { preference }
  })
}

function updateBackgroundNumber(key: BackgroundNumberKey, event: Event): void {
  updateBackground(key, Number((event.target as HTMLInputElement).value))
}

function updateAppearanceNumber(key: AppearanceNumberKey, event: Event): void {
  updateAppearance(key, Number((event.target as HTMLInputElement).value))
}

async function chooseBackgroundImage(): Promise<void> {
  localError.value = ''
  try {
    const imageUrl = await props.pickBackgroundImage()
    if (!imageUrl) return
    replaceActiveProfile({
      ...activeProfile.value,
      background: { ...activeProfile.value.background, kind: 'image', imageUrl }
    })
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : '背景图片选择失败'
  }
}

function removeBackgroundImage(): void {
  replaceActiveProfile({
    ...activeProfile.value,
    background: {
      ...activeProfile.value.background,
      kind: 'solid',
      imageUrl: ''
    }
  })
}
</script>

<template>
  <aside class="mini-customizer" :class="`is-${mode}`" aria-label="迷你播放器自定义">
    <header class="mini-customizer-header">
      <strong>独立迷你窗口</strong>
      <div class="mini-customizer-header-actions">
        <i v-if="saving" class="pi pi-spin pi-spinner" aria-label="正在保存"></i>
        <button
          v-if="mode === 'overlay'"
          type="button"
          class="customizer-icon-button"
          title="关闭"
          aria-label="关闭自定义面板"
          @click="emit('close')"
        >
          <i class="ph ph-x"></i>
        </button>
      </div>
    </header>

    <nav class="mini-customizer-tabs" aria-label="自定义类别">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        <i :class="tab.icon"></i>
        <span>{{ tab.label }}</span>
      </button>
    </nav>

    <div class="mini-customizer-body">
      <section v-if="activeTab === 'theme'" class="customizer-section">
        <button
          v-for="theme in themes"
          :key="theme.id"
          type="button"
          class="customizer-theme-option"
          :class="{ active: settings.activeStyleId === theme.id }"
          @click="selectTheme(theme.id)"
        >
          <span
            class="customizer-theme-swatch"
            :style="{ background: theme.defaultProfile.background.fallbackColor }"
          ></span>
          <span>{{ theme.name }}</span>
          <i v-if="settings.activeStyleId === theme.id" class="ph ph-check"></i>
        </button>
      </section>

      <section v-else-if="activeTab === 'background'" class="customizer-section">
        <div class="customizer-segment four-columns">
          <button
            v-for="option in backgroundKinds"
            :key="option.value"
            type="button"
            :class="{ active: activeProfile.background.kind === option.value }"
            @click="updateBackground('kind', option.value)"
          >
            <i :class="option.icon"></i>
            <span>{{ option.label }}</span>
          </button>
        </div>

        <p v-if="activeProfile.background.kind === 'cover'" class="customizer-cover-note">
          封面背景沿用歌词页的模糊、暗色遮罩与封面取色效果。
        </p>

        <label v-if="activeProfile.background.kind === 'solid'" class="customizer-color-row">
          <span>背景颜色</span>
          <input
            type="color"
            :value="activeProfile.background.solidColor"
            @input="updateBackground('solidColor', ($event.target as HTMLInputElement).value)"
            @change="emit('flush')"
          />
          <code>{{ activeProfile.background.solidColor }}</code>
        </label>

        <template v-if="activeProfile.background.kind === 'gradient'">
          <label class="customizer-color-row">
            <span>起始颜色</span>
            <input
              type="color"
              :value="activeProfile.background.gradientStart"
              @input="updateBackground('gradientStart', ($event.target as HTMLInputElement).value)"
              @change="emit('flush')"
            />
            <code>{{ activeProfile.background.gradientStart }}</code>
          </label>
          <label class="customizer-color-row">
            <span>结束颜色</span>
            <input
              type="color"
              :value="activeProfile.background.gradientEnd"
              @input="updateBackground('gradientEnd', ($event.target as HTMLInputElement).value)"
              @change="emit('flush')"
            />
            <code>{{ activeProfile.background.gradientEnd }}</code>
          </label>
        </template>

        <div v-if="activeProfile.background.kind === 'image'" class="customizer-image-row">
          <span class="customizer-image-preview" :style="imagePreviewStyle"></span>
          <button type="button" @click="chooseBackgroundImage">
            <i class="ph ph-image-square"></i>
            <span>{{ activeProfile.background.imageUrl ? '更换图片' : '选择图片' }}</span>
          </button>
          <button
            type="button"
            class="customizer-icon-button"
            title="移除图片"
            aria-label="移除背景图片"
            :disabled="!activeProfile.background.imageUrl"
            @click="removeBackgroundImage"
          >
            <i class="ph ph-trash"></i>
          </button>
        </div>

        <div v-if="activeProfile.background.kind === 'image'" class="customizer-segment">
          <button
            type="button"
            :class="{ active: activeProfile.background.imageFit === 'cover' }"
            @click="updateBackground('imageFit', 'cover')"
          >
            填满
          </button>
          <button
            type="button"
            :class="{ active: activeProfile.background.imageFit === 'contain' }"
            @click="updateBackground('imageFit', 'contain')"
          >
            完整
          </button>
        </div>

        <label v-if="activeProfile.background.kind !== 'cover'" class="customizer-color-row">
          <span>回退颜色</span>
          <input
            type="color"
            :value="activeProfile.background.fallbackColor"
            @input="updateBackground('fallbackColor', ($event.target as HTMLInputElement).value)"
            @change="emit('flush')"
          />
          <code>{{ activeProfile.background.fallbackColor }}</code>
        </label>
        <label v-if="activeProfile.background.kind !== 'cover'" class="customizer-color-row">
          <span>遮罩颜色</span>
          <input
            type="color"
            :value="activeProfile.background.overlayColor"
            @input="updateBackground('overlayColor', ($event.target as HTMLInputElement).value)"
            @change="emit('flush')"
          />
          <code>{{ activeProfile.background.overlayColor }}</code>
        </label>

        <label
          v-for="control in backgroundSliders"
          v-show="
            activeProfile.background.kind !== 'cover' &&
            (control.key !== 'gradientAngle' || activeProfile.background.kind === 'gradient')
          "
          :key="control.key"
          class="customizer-slider-row"
        >
          <span>{{ control.label }}</span>
          <input
            type="range"
            :min="control.min"
            :max="control.max"
            step="1"
            :value="activeProfile.background[control.key]"
            @input="updateBackgroundNumber(control.key, $event)"
            @change="emit('flush')"
          />
          <output>{{ activeProfile.background[control.key] }}{{ control.unit }}</output>
        </label>
      </section>

      <section v-else-if="activeTab === 'appearance'" class="customizer-section">
        <p v-if="activeProfile.background.kind === 'cover'" class="customizer-cover-note">
          背景和文字明暗随封面自动调整，强调色跟随封面取色。
        </p>
        <div v-else class="customizer-labeled-control">
          <span>强调色</span>
          <div class="customizer-segment">
            <button
              type="button"
              :class="{ active: activeProfile.appearance.accentMode === 'track' }"
              @click="updateAppearance('accentMode', 'track')"
            >
              跟随封面
            </button>
            <button
              type="button"
              :class="{ active: activeProfile.appearance.accentMode === 'custom' }"
              @click="updateAppearance('accentMode', 'custom')"
            >
              自定义
            </button>
          </div>
        </div>
        <label
          v-if="
            activeProfile.background.kind !== 'cover' &&
            activeProfile.appearance.accentMode === 'custom'
          "
          class="customizer-color-row"
        >
          <span>强调颜色</span>
          <input
            type="color"
            :value="activeProfile.appearance.accentColor"
            @input="updateAppearance('accentColor', ($event.target as HTMLInputElement).value)"
            @change="emit('flush')"
          />
          <code>{{ activeProfile.appearance.accentColor }}</code>
        </label>

        <div v-if="activeProfile.background.kind !== 'cover'" class="customizer-labeled-control">
          <span>文字颜色</span>
          <div class="customizer-segment">
            <button
              type="button"
              :class="{ active: activeProfile.appearance.textMode === 'auto' }"
              @click="updateAppearance('textMode', 'auto')"
            >
              自动
            </button>
            <button
              type="button"
              :class="{ active: activeProfile.appearance.textMode === 'custom' }"
              @click="updateAppearance('textMode', 'custom')"
            >
              自定义
            </button>
          </div>
        </div>
        <template
          v-if="
            activeProfile.background.kind !== 'cover' &&
            activeProfile.appearance.textMode === 'custom'
          "
        >
          <label class="customizer-color-row">
            <span>主要文字</span>
            <input
              type="color"
              :value="activeProfile.appearance.primaryTextColor"
              @input="
                updateAppearance('primaryTextColor', ($event.target as HTMLInputElement).value)
              "
              @change="emit('flush')"
            />
            <code>{{ activeProfile.appearance.primaryTextColor }}</code>
          </label>
          <label class="customizer-color-row">
            <span>次要文字</span>
            <input
              type="color"
              :value="activeProfile.appearance.mutedTextColor"
              @input="updateAppearance('mutedTextColor', ($event.target as HTMLInputElement).value)"
              @change="emit('flush')"
            />
            <code>{{ activeProfile.appearance.mutedTextColor }}</code>
          </label>
        </template>
        <label class="customizer-color-row">
          <span>边框颜色</span>
          <input
            type="color"
            :value="activeProfile.appearance.borderColor"
            @input="updateAppearance('borderColor', ($event.target as HTMLInputElement).value)"
            @change="emit('flush')"
          />
          <code>{{ activeProfile.appearance.borderColor }}</code>
        </label>

        <label
          v-for="control in appearanceSliders"
          v-show="control.key !== 'surfaceOpacity' || activeProfile.background.kind !== 'cover'"
          :key="control.key"
          class="customizer-slider-row"
        >
          <span>{{ control.label }}</span>
          <input
            type="range"
            :min="control.min"
            :max="control.max"
            step="1"
            :value="activeProfile.appearance[control.key]"
            @input="updateAppearanceNumber(control.key, $event)"
            @change="emit('flush')"
          />
          <output>{{ activeProfile.appearance[control.key] }}{{ control.unit }}</output>
        </label>
      </section>

      <section v-else class="customizer-section">
        <div class="customizer-segment five-columns">
          <button
            v-for="option in layoutOptions"
            :key="option.value"
            type="button"
            :class="{ active: activeProfile.layout.preference === option.value }"
            @click="updateLayoutPreference(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <label v-for="option in visibilityOptions" :key="option.key" class="customizer-switch-row">
          <span>{{ option.label }}</span>
          <input
            type="checkbox"
            :checked="activeProfile.visibility[option.key]"
            @change="updateVisibility(option.key, ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </section>
    </div>

    <div v-if="visibleError" class="mini-customizer-error" role="status">
      <i class="ph ph-warning-circle"></i>
      <span>{{ visibleError }}</span>
    </div>

    <footer class="mini-customizer-footer">
      <button type="button" @click="emit('undo')">
        <i class="ph ph-arrow-counter-clockwise"></i>
        <span>撤销本次</span>
      </button>
      <button type="button" @click="emit('reset')">
        <i class="ph ph-clock-counter-clockwise"></i>
        <span>恢复默认</span>
      </button>
    </footer>
  </aside>
</template>

<style src="./MiniPlayerCustomizer.css"></style>
