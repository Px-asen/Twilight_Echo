<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  LYRICS_RANGES,
  type LyricsAppearanceSettings,
  type LyricsStyleTarget,
  type LyricsTextStyle
} from '../../../shared/lyricsAppearance.ts'
import { constrainLyricsAlignment, lyricsPreviewStyle } from '../utils/lyricsStyleVars'
import { useLyricsAppearanceEditor } from '../composables/useLyricsAppearanceEditor'
import { useLyricsFontPicker, type LyricsFontOption } from '../composables/useLyricsFontPicker'
import { useCurrentLyricsFormat } from '../composables/useCurrentLyricsFormat.ts'
import { useLyricsManagement } from '../stores/lyricsManagement.ts'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const {
  draft,
  activeTarget,
  style,
  saveState,
  statusLabel,
  presets,
  activePresetId,
  canSavePreset,
  patchStyle,
  setGlobal,
  syncFontSizeToAll,
  resetTarget,
  resetAll,
  reloadFromSettings,
  applyPreset,
  savePreset,
  deletePreset
} = useLyricsAppearanceEditor()

const fontPicker = useLyricsFontPicker()
const { isCurrentTtml } = useCurrentLyricsFormat()
const lyricsManagement = useLyricsManagement()
const fontMenuOpen = ref(false)
const presetName = ref('')
const showRomanization = computed(() => lyricsManagement.document.value.showRomanization)

const targetOptions: Array<{ value: LyricsStyleTarget; label: string; hint: string }> = [
  { value: 'normal', label: '普通歌词', hint: '未播放与非当前行' },
  { value: 'active', label: '当前歌词', hint: '正在播放的主歌词' },
  { value: 'harmony', label: '附属歌词', hint: '和声与背景人声，仅在播放时显示' },
  { value: 'translation', label: '翻译歌词', hint: '译文行' },
  { value: 'romanization', label: '罗马音', hint: '音译行，需在歌词管理中开启' }
]
const backgroundOptions = [
  { value: 'none', label: '无背景' },
  { value: 'solid', label: '纯色' },
  { value: 'glass', label: '磨砂' },
  { value: 'gradient', label: '渐变' }
] as const
const highlightOptions = [
  { value: 'none', label: '无' },
  { value: 'shadow', label: '阴影' },
  { value: 'glow', label: '柔光' },
  { value: 'outline', label: '描边' }
] as const
const allAlignmentOptions = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' }
] as const
const alignmentOptions = computed(() =>
  isCurrentTtml.value
    ? allAlignmentOptions.filter((option) => option.value !== 'right')
    : allAlignmentOptions
)
const effectiveStyleAlign = computed(() =>
  constrainLyricsAlignment(style.value.align, isCurrentTtml.value)
)

const ranges = LYRICS_RANGES

/** Label for the font control, whether the choice is built in or a local family. */
const fontLabel = computed(() => {
  if (style.value.fontFamily === 'custom') {
    return style.value.customFontFamily || '自定义字体名'
  }
  const match = fontPicker.builtinMatches.value.find(
    (option) => option.builtin === style.value.fontFamily
  )
  return match?.label ?? '跟随界面'
})

const customFontMissing = computed(
  () =>
    style.value.fontFamily === 'custom' &&
    style.value.customFontFamily.trim().length > 0 &&
    !fontPicker.isFontAvailable(style.value.customFontFamily)
)

function chooseFont(option: LyricsFontOption): void {
  if (option.builtin) {
    patchStyle('fontFamily', option.builtin)
  } else if (option.familyName) {
    // Locally installed families ride on the existing `custom` storage rather
    // than growing the schema with a parallel field.
    patchStyle('fontFamily', 'custom')
    patchStyle('customFontFamily', option.familyName)
  }
  fontMenuOpen.value = false
  fontPicker.query.value = ''
}

async function toggleFontMenu(): Promise<void> {
  fontMenuOpen.value = !fontMenuOpen.value
  if (fontMenuOpen.value) await fontPicker.load()
}

function previewStyle(target: LyricsStyleTarget): Record<string, string> {
  const targetStyle = draft.value.styles[target]
  return lyricsPreviewStyle(
    {
      ...targetStyle,
      align: constrainLyricsAlignment(targetStyle.align, isCurrentTtml.value)
    },
    target
  )
}

function commitPreset(): void {
  savePreset(presetName.value)
  presetName.value = ''
}

async function toggleRomanization(): Promise<void> {
  try {
    await lyricsManagement.updateVisibility({ showRomanization: !showRomanization.value })
  } catch {
    // The lyrics manager remains the authoritative source; a failed persistence
    // attempt must not interrupt editing the appearance profile.
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void lyricsManagement.ensureLoaded()
      reloadFromSettings()
      fontMenuOpen.value = false
      fontPicker.query.value = ''
    }
  }
)
</script>

<template>
  <Transition name="lyrics-customizer">
    <!--
      Teleported to <body>, so the PlayerBar's document-level pointerdown
      listener would misread any interaction inside the panel as an outside
      click and close the floating drawer. Stopping propagation here keeps
      the panel alive while the user drags a slider; `.self` still fires when
      the pointer lands on the translucent shell itself, preserving the
      click-outside-to-dismiss behaviour.
    -->
    <div
      v-if="open"
      class="lyrics-customizer-shell"
      @pointerdown.self="emit('close')"
      @pointerdown.stop
    >
      <aside
        class="lyrics-customizer"
        role="dialog"
        aria-modal="true"
        aria-label="PlayingMusic 歌词个性化"
      >
        <header class="customizer-header">
          <div>
            <span class="customizer-kicker">PlayingMusic</span>
            <h2>歌词个性化</h2>
            <p>分别调整普通、当前、附属、翻译与罗马音歌词，所有更改实时应用并自动保存。</p>
          </div>
          <button
            type="button"
            class="icon-button"
            aria-label="关闭歌词个性化"
            @click="emit('close')"
          >
            <i class="pi pi-times"></i>
          </button>
        </header>

        <div class="customizer-status" :data-state="saveState">
          <span><i class="pi pi-eye"></i>{{ statusLabel }}</span>
          <button type="button" @click="resetAll">恢复全部默认</button>
        </div>

        <div class="style-tabs" role="tablist" aria-label="歌词样式对象">
          <button
            v-for="option in targetOptions"
            :key="option.value"
            type="button"
            role="tab"
            :aria-selected="activeTarget === option.value"
            @click="activeTarget = option.value"
          >
            <strong>{{ option.label }}</strong
            ><span>{{ option.hint }}</span>
          </button>
        </div>

        <section class="live-preview" aria-label="歌词样式实时预览">
          <span class="preview-label">实时预览</span>
          <div class="preview-lines">
            <div class="preview-sample">
              <p :style="previewStyle('normal')">在暮色里听见回声</p>
              <p class="is-translation" :style="previewStyle('translation')">
                I hear an echo in the twilight
              </p>
            </div>
            <div class="preview-sample">
              <p class="is-active" :style="previewStyle('active')">此刻旋律正穿过夜色</p>
              <p class="is-translation" :style="previewStyle('translation')">
                The melody is crossing the night
              </p>
              <p class="is-harmony" :style="previewStyle('harmony')">I'll see you again</p>
              <p class="is-romanization" :style="previewStyle('romanization')">
                cǐ kè xuán lǜ zhèng chuān guò yè sè
              </p>
            </div>
          </div>
        </section>

        <div class="customizer-scroll">
          <section class="control-section">
            <div class="section-heading">
              <h3>外观方案</h3>
            </div>
            <div class="preset-grid">
              <button
                v-for="preset in presets"
                :key="preset.id"
                type="button"
                class="preset-chip"
                :aria-pressed="activePresetId === preset.id"
                @click="applyPreset(preset.id)"
              >
                <span>{{ preset.name }}</span>
                <i
                  v-if="!preset.builtin"
                  class="pi pi-trash"
                  role="button"
                  :aria-label="`删除方案 ${preset.name}`"
                  @click.stop="deletePreset(preset.id)"
                ></i>
              </button>
            </div>
            <div class="preset-save">
              <input
                v-model="presetName"
                type="text"
                maxlength="48"
                placeholder="方案名称"
                :disabled="!canSavePreset"
                @keydown.enter.prevent="commitPreset"
              />
              <button
                type="button"
                :disabled="!canSavePreset || !presetName.trim()"
                @click="commitPreset"
              >
                存为方案
              </button>
            </div>
            <p v-if="!canSavePreset" class="preset-hint">自定义方案已达上限，请先删除一个。</p>
          </section>

          <section class="control-section">
            <div class="section-heading">
              <h3>字体与排版</h3>
              <button type="button" @click="resetTarget">恢复本项默认</button>
            </div>
            <div class="control-field control-field--wide font-field">
              <span>字体</span>
              <button
                type="button"
                class="font-trigger"
                :aria-expanded="fontMenuOpen"
                @click="toggleFontMenu"
              >
                <span :style="{ fontFamily: previewStyle(activeTarget).fontFamily }">{{
                  fontLabel
                }}</span>
                <i class="pi pi-chevron-down"></i>
              </button>
              <div v-if="fontMenuOpen" class="font-menu">
                <input
                  v-model="fontPicker.query.value"
                  type="text"
                  class="font-search"
                  placeholder="搜索字体…"
                />
                <div class="font-list">
                  <p class="font-group">内置</p>
                  <button
                    v-for="option in fontPicker.builtinMatches.value"
                    :key="option.key"
                    type="button"
                    class="font-option"
                    :style="{ fontFamily: option.preview }"
                    @click="chooseFont(option)"
                  >
                    {{ option.label }}
                  </button>
                  <p class="font-group">
                    本机字体
                    <small v-if="fontPicker.loading.value">载入中…</small>
                    <small v-else-if="!fontPicker.installedMatches.value.length">无匹配</small>
                  </p>
                  <button
                    v-for="option in fontPicker.installedMatches.value"
                    :key="option.key"
                    type="button"
                    class="font-option"
                    :style="{ fontFamily: option.preview }"
                    @click="chooseFont(option)"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>
            </div>
            <label v-if="style.fontFamily === 'custom'" class="control-field control-field--wide">
              <span>本机字体名称</span>
              <input
                :value="style.customFontFamily"
                type="text"
                maxlength="96"
                placeholder="例如 Microsoft YaHei UI"
                @input="patchStyle('customFontFamily', ($event.target as HTMLInputElement).value)"
              />
            </label>
            <p v-if="customFontMissing" class="field-warning">
              系统中未找到该字体，歌词会回退到界面字体。
            </p>
            <div class="control-grid">
              <label class="range-field range-field--font-size"
                ><span
                  >字号 <strong>{{ style.fontSize }}px</strong></span
                ><input
                  type="range"
                  :min="ranges.fontSize.min"
                  :max="ranges.fontSize.max"
                  :step="ranges.fontSize.step"
                  :value="style.fontSize"
                  @input="
                    patchStyle('fontSize', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <button type="button" class="sync-size-button" @click="syncFontSizeToAll">
                同步到全部
              </button>
              <label class="range-field"
                ><span
                  >字重 <strong>{{ style.fontWeight }}</strong></span
                ><input
                  type="range"
                  :min="ranges.fontWeight.min"
                  :max="ranges.fontWeight.max"
                  :step="ranges.fontWeight.step"
                  :value="style.fontWeight"
                  @input="
                    patchStyle('fontWeight', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >行间距 <strong>{{ style.lineHeight.toFixed(2) }}</strong></span
                ><input
                  type="range"
                  :min="ranges.lineHeight.min"
                  :max="ranges.lineHeight.max"
                  :step="ranges.lineHeight.step"
                  :value="style.lineHeight"
                  @input="
                    patchStyle('lineHeight', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >文字透明度 <strong>{{ style.opacity }}%</strong></span
                ><input
                  type="range"
                  :min="ranges.opacity.min"
                  :max="ranges.opacity.max"
                  :step="ranges.opacity.step"
                  :value="style.opacity"
                  @input="patchStyle('opacity', Number(($event.target as HTMLInputElement).value))"
              /></label>
              <label class="range-field"
                ><span
                  >字间距 <strong>{{ style.letterSpacing.toFixed(2) }}em</strong></span
                ><input
                  type="range"
                  :min="ranges.letterSpacing.min"
                  :max="ranges.letterSpacing.max"
                  :step="ranges.letterSpacing.step"
                  :value="style.letterSpacing"
                  @input="
                    patchStyle('letterSpacing', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
            </div>
            <div class="segment-field">
              <span>字形</span>
              <div class="segment-control">
                <button
                  v-for="option in [
                    { value: 'normal', label: '常规' },
                    { value: 'italic', label: '斜体' }
                  ]"
                  :key="option.value"
                  type="button"
                  :aria-pressed="style.fontStyle === option.value"
                  @click="patchStyle('fontStyle', option.value as LyricsTextStyle['fontStyle'])"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <div class="segment-field">
              <span>对齐方式</span>
              <div class="segment-control">
                <button
                  v-for="option in alignmentOptions"
                  :key="option.value"
                  type="button"
                  :aria-pressed="effectiveStyleAlign === option.value"
                  @click="patchStyle('align', option.value as LyricsTextStyle['align'])"
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
          </section>

          <section class="control-section">
            <h3>文字颜色</h3>
            <div class="segment-field">
              <span>颜色来源</span>
              <div class="segment-control">
                <button
                  type="button"
                  :aria-pressed="style.colorMode === 'theme'"
                  @click="patchStyle('colorMode', 'theme')"
                >
                  跟随主题</button
                ><button
                  type="button"
                  :aria-pressed="style.colorMode === 'custom'"
                  @click="patchStyle('colorMode', 'custom')"
                >
                  自定义
                </button>
              </div>
            </div>
            <label v-if="style.colorMode === 'custom'" class="color-field"
              ><span>文字颜色</span
              ><input
                type="color"
                :value="style.color"
                @input="patchStyle('color', ($event.target as HTMLInputElement).value)"
              /><code>{{ style.color }}</code></label
            >
          </section>

          <section class="control-section">
            <h3>背景样式</h3>
            <div class="option-grid">
              <button
                v-for="option in backgroundOptions"
                :key="option.value"
                type="button"
                :aria-pressed="style.backgroundStyle === option.value"
                @click="patchStyle('backgroundStyle', option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <template v-if="style.backgroundStyle !== 'none'">
              <label class="color-field"
                ><span>背景颜色</span
                ><input
                  type="color"
                  :value="style.backgroundColor"
                  @input="patchStyle('backgroundColor', ($event.target as HTMLInputElement).value)"
                /><code>{{ style.backgroundColor }}</code></label
              >
              <label class="range-field"
                ><span
                  >背景透明度 <strong>{{ style.backgroundOpacity }}%</strong></span
                ><input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  :value="style.backgroundOpacity"
                  @input="
                    patchStyle(
                      'backgroundOpacity',
                      Number(($event.target as HTMLInputElement).value)
                    )
                  "
              /></label>
            </template>
          </section>

          <section class="control-section">
            <h3>高亮效果</h3>
            <div class="option-grid">
              <button
                v-for="option in highlightOptions"
                :key="option.value"
                type="button"
                :aria-pressed="style.highlightEffect === option.value"
                @click="patchStyle('highlightEffect', option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <template v-if="style.highlightEffect !== 'none'">
              <label class="color-field"
                ><span>效果颜色</span
                ><input
                  type="color"
                  :value="style.highlightColor"
                  @input="patchStyle('highlightColor', ($event.target as HTMLInputElement).value)"
                /><code>{{ style.highlightColor }}</code></label
              >
              <label class="range-field"
                ><span
                  >效果强度 <strong>{{ style.highlightIntensity }}%</strong></span
                ><input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  :value="style.highlightIntensity"
                  @input="
                    patchStyle(
                      'highlightIntensity',
                      Number(($event.target as HTMLInputElement).value)
                    )
                  "
              /></label>
            </template>
          </section>

          <section class="control-section">
            <h3>显示行为</h3>
            <label class="range-field"
              ><span
                >非当前行整体可见度 <strong>{{ draft.inactiveOpacity }}%</strong></span
              ><input
                type="range"
                :min="ranges.inactiveOpacity.min"
                :max="ranges.inactiveOpacity.max"
                :step="ranges.inactiveOpacity.step"
                :value="draft.inactiveOpacity"
                @input="
                  setGlobal('inactiveOpacity', Number(($event.target as HTMLInputElement).value))
                "
            /></label>
            <div class="segment-field">
              <span>聚焦范围</span>
              <div class="segment-control segment-control--four">
                <button
                  v-for="option in [
                    { value: 'all', label: '全部' },
                    { value: 1, label: '1行' },
                    { value: 3, label: '3行' },
                    { value: 5, label: '5行' }
                  ]"
                  :key="option.value"
                  type="button"
                  :aria-pressed="draft.focusLineCount === option.value"
                  @click="
                    setGlobal(
                      'focusLineCount',
                      option.value as LyricsAppearanceSettings['focusLineCount']
                    )
                  "
                >
                  {{ option.label }}
                </button>
              </div>
            </div>
            <button
              type="button"
              class="switch-row"
              :aria-pressed="draft.karaokeEnabled"
              @click="setGlobal('karaokeEnabled', !draft.karaokeEnabled)"
            >
              <span><strong>逐字高亮</strong><small>仅在歌词含逐字时间戳时生效</small></span
              ><i :class="draft.karaokeEnabled ? 'pi pi-check-circle' : 'pi pi-circle'"></i>
            </button>
            <button
              type="button"
              class="switch-row"
              :aria-pressed="draft.hidePassedLines"
              @click="setGlobal('hidePassedLines', !draft.hidePassedLines)"
            >
              <span><strong>隐藏已唱歌词</strong><small>播放时淡出当前行之前的内容</small></span
              ><i :class="draft.hidePassedLines ? 'pi pi-check-circle' : 'pi pi-circle'"></i>
            </button>
            <button
              type="button"
              class="switch-row"
              :aria-pressed="showRomanization"
              @click="toggleRomanization"
            >
              <span><strong>显示罗马音</strong><small>独立显示或隐藏歌词中的音译层</small></span>
              <i :class="showRomanization ? 'pi pi-check-circle' : 'pi pi-circle'"></i>
            </button>
          </section>

          <section class="control-section">
            <h3>布局与几何</h3>
            <div class="control-grid">
              <label class="range-field"
                ><span
                  >封面间距 <strong>{{ draft.coverGap }}px</strong></span
                ><input
                  type="range"
                  :min="ranges.coverGap.min"
                  :max="ranges.coverGap.max"
                  :step="ranges.coverGap.step"
                  :value="draft.coverGap"
                  @input="setGlobal('coverGap', Number(($event.target as HTMLInputElement).value))"
              /></label>
              <label class="range-field"
                ><span
                  >歌词最大宽度 <strong>{{ draft.lyricsMaxWidth }}px</strong></span
                ><input
                  type="range"
                  :min="ranges.lyricsMaxWidth.min"
                  :max="ranges.lyricsMaxWidth.max"
                  :step="ranges.lyricsMaxWidth.step"
                  :value="draft.lyricsMaxWidth"
                  @input="
                    setGlobal('lyricsMaxWidth', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >歌词水平偏移 <strong>{{ draft.lyricsOffsetX }}px</strong></span
                ><input
                  type="range"
                  :min="ranges.lyricsOffsetX.min"
                  :max="ranges.lyricsOffsetX.max"
                  :step="ranges.lyricsOffsetX.step"
                  :value="draft.lyricsOffsetX"
                  @input="
                    setGlobal('lyricsOffsetX', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >当前行位置 <strong>{{ Math.round(draft.anchorPosition * 100) }}%</strong></span
                ><input
                  type="range"
                  :min="ranges.anchorPosition.min"
                  :max="ranges.anchorPosition.max"
                  :step="ranges.anchorPosition.step"
                  :value="draft.anchorPosition"
                  @input="
                    setGlobal('anchorPosition', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >封面尺寸 <strong>{{ draft.coverSize }}%</strong></span
                ><input
                  type="range"
                  :min="ranges.coverSize.min"
                  :max="ranges.coverSize.max"
                  :step="ranges.coverSize.step"
                  :value="draft.coverSize"
                  @input="
                    setGlobal('coverSize', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >封面圆角 <strong>{{ draft.coverRadius }}px</strong></span
                ><input
                  type="range"
                  :min="ranges.coverRadius.min"
                  :max="ranges.coverRadius.max"
                  :step="ranges.coverRadius.step"
                  :value="draft.coverRadius"
                  @input="
                    setGlobal('coverRadius', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >译文间距 <strong>{{ draft.translationSpacing }}px</strong></span
                ><input
                  type="range"
                  :min="ranges.translationSpacing.min"
                  :max="ranges.translationSpacing.max"
                  :step="ranges.translationSpacing.step"
                  :value="draft.translationSpacing"
                  @input="
                    setGlobal(
                      'translationSpacing',
                      Number(($event.target as HTMLInputElement).value)
                    )
                  "
              /></label>
            </div>
          </section>

          <section class="control-section">
            <h3>动效</h3>
            <div class="control-grid">
              <label class="range-field"
                ><span
                  >缩放强度 <strong>{{ draft.scaleIntensity }}%</strong></span
                ><input
                  type="range"
                  :min="ranges.scaleIntensity.min"
                  :max="ranges.scaleIntensity.max"
                  :step="ranges.scaleIntensity.step"
                  :value="draft.scaleIntensity"
                  @input="
                    setGlobal('scaleIntensity', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >模糊强度 <strong>{{ draft.blurIntensity }}%</strong></span
                ><input
                  type="range"
                  :min="ranges.blurIntensity.min"
                  :max="ranges.blurIntensity.max"
                  :step="ranges.blurIntensity.step"
                  :value="draft.blurIntensity"
                  @input="
                    setGlobal('blurIntensity', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
              <label class="range-field"
                ><span
                  >滚动跟随速度 <strong>{{ draft.cascadeSpeed }}</strong></span
                ><input
                  type="range"
                  :min="ranges.cascadeSpeed.min"
                  :max="ranges.cascadeSpeed.max"
                  :step="ranges.cascadeSpeed.step"
                  :value="draft.cascadeSpeed"
                  @input="
                    setGlobal('cascadeSpeed', Number(($event.target as HTMLInputElement).value))
                  "
              /></label>
            </div>
            <p class="section-hint">动效受系统「减少动态效果」偏好约束，关闭后此处设置不生效。</p>
          </section>
        </div>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * The shell stays fullscreen and interactive so "click outside to close" still
 * works, but it paints nothing: no blur, no scrim. The whole point of opening
 * the panel is to watch the lyrics underneath respond while tweaking, and a
 * blurred backdrop defeats that entirely.
 */
.lyrics-customizer-shell {
  position: fixed;
  inset: 0;
  z-index: 15000;
  display: flex;
  justify-content: flex-start;
  background: transparent;
}
.lyrics-customizer {
  /*
   * `--te-neutral-900` and `--te-neutral-50` trade places between the two tones
   * (near-black / near-white under pureWhite, the reverse under dark). These two
   * locals pin the ends of that ramp, so the handful of things here that must
   * stay dark — or stay light — in *both* tones can say so. Without them the
   * drop shadow below becomes a white glow in dark mode.
   */
  --customizer-tone-dark: var(--te-neutral-900);
  --customizer-tone-light: var(--te-neutral-50);
  width: min(460px, 100vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  color: var(--te-neutral-900);
  border-right: 1px solid color-mix(in srgb, var(--te-card-border) 86%, transparent);
  background: var(--te-settings-bg);
  box-shadow: 24px 0 70px color-mix(in srgb, var(--customizer-tone-dark) 34%, transparent);
}
html[data-theme='dark'] .lyrics-customizer {
  --customizer-tone-dark: var(--te-neutral-50);
  --customizer-tone-light: var(--te-neutral-900);
}
.customizer-header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 24px 18px;
}
.customizer-kicker {
  color: var(--te-primary-400);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.customizer-header h2 {
  margin: 5px 0 4px;
  font-size: calc(var(--te-font-size-body, 14px) * 24 / 14);
}
.customizer-header p {
  margin: 0;
  max-width: 430px;
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  line-height: 1.6;
}
.icon-button {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  color: inherit;
  background: var(--te-card-bg);
  cursor: pointer;
}
.customizer-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 24px;
  border-block: 1px solid var(--te-card-border);
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
.customizer-status span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.customizer-status[data-state='saved'] span {
  color: var(--te-success-500);
}
.customizer-status[data-state='error'] span {
  color: var(--te-favorite-500);
}
.customizer-status button,
.section-heading button {
  border: 0;
  color: var(--te-primary-400);
  background: transparent;
  cursor: pointer;
}
.style-tabs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(116px, 1fr));
  gap: 8px;
  padding: 16px 24px;
}
.style-tabs button {
  min-width: 0;
  padding: 11px 10px;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  color: var(--te-neutral-500);
  text-align: left;
  background: var(--te-card-bg);
  cursor: pointer;
}
.style-tabs button[aria-selected='true'] {
  border-color: color-mix(in srgb, var(--te-primary-400) 70%, transparent);
  color: var(--te-neutral-900);
  background: color-mix(in srgb, var(--te-primary-500) 14%, var(--te-card-bg));
}
.style-tabs strong,
.style-tabs span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.style-tabs strong {
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
}
.style-tabs span {
  margin-top: 3px;
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
}
/*
 * Every value in this shorthand has to be a real colour. The previous revision
 * fed `--te-playback-fluid-bg` — itself a `linear-gradient(...)` — into a colour
 * stop, which made the whole `background` invalid, so Chromium dropped *both*
 * layers and the box painted nothing in either tone.
 *
 * The stage stays dark whichever tone is active, because the lines inside are
 * previewed through `lyricsPreviewStyle`, whose theme colours resolve to the
 * now-playing page's `--te-playback-lyric-*` tokens — white in both tones.
 * A light stage in dark mode would render white text on white.
 */
.live-preview {
  margin: 0 24px 16px;
  padding: 16px;
  overflow: hidden;
  border: 1px solid var(--te-card-border);
  border-radius: 16px;
  background:
    radial-gradient(
      circle at 80% 10%,
      color-mix(in srgb, var(--te-primary-500) 26%, transparent),
      transparent 34%
    ),
    linear-gradient(
      145deg,
      color-mix(in srgb, var(--customizer-tone-dark) 88%, var(--te-primary-500)),
      var(--customizer-tone-dark)
    );
}
.preview-label {
  color: color-mix(in srgb, var(--customizer-tone-light) 46%, transparent);
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.preview-lines {
  display: grid;
  gap: 7px;
  margin-top: 12px;
}
.preview-sample {
  display: grid;
  gap: 2px;
}
.preview-lines p {
  margin: 0;
  padding: 5px 9px;
  border-radius: 9px;
  transition:
    transform 160ms var(--te-ease-soft),
    opacity 160ms var(--te-ease-soft),
    color 160ms var(--te-ease-soft),
    background-color 160ms var(--te-ease-soft);
}
.preview-lines .is-active {
  transform: scale(1.02);
}
.preview-lines .is-translation {
  margin-top: 0;
}
.preview-lines .is-romanization {
  margin-top: 0;
}
.preview-lines .is-harmony {
  margin-top: 2px;
}
.customizer-scroll {
  min-height: 0;
  overflow-y: auto;
  padding: 0 24px 28px;
  scrollbar-width: thin;
}
.control-section {
  display: grid;
  gap: 14px;
  padding: 18px 0;
  border-top: 1px solid var(--te-card-border);
}
.control-section h3 {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.control-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px 18px;
}
.section-hint,
.preset-hint,
.field-warning {
  margin: 0;
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  line-height: 1.6;
}
.field-warning {
  color: var(--te-warning-soft-fg);
}

/* Presets */
.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.preset-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid var(--te-card-border);
  border-radius: 999px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
.preset-chip[aria-pressed='true'] {
  border-color: var(--te-primary-400);
  color: var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-400) 14%, transparent);
}
.preset-chip .pi-trash {
  opacity: 0.55;
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
}
.preset-chip .pi-trash:hover {
  opacity: 1;
}
.preset-save {
  display: flex;
  gap: 8px;
}
.preset-save input {
  flex: 1;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
}
.preset-save button,
.sync-size-button {
  min-height: 38px;
  padding: 0 14px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  white-space: nowrap;
}
.preset-save button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sync-size-button {
  align-self: end;
}

/* Font combobox */
.font-field {
  position: relative;
}
.font-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  text-align: left;
}
.font-menu {
  position: absolute;
  z-index: 5;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-settings-bg);
  box-shadow: 0 18px 46px color-mix(in srgb, var(--te-neutral-900) 26%, transparent);
}
.font-search {
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--te-card-border);
  border-radius: 9px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
}
.font-list {
  display: grid;
  max-height: 260px;
  overflow-y: auto;
}
.font-group {
  display: flex;
  justify-content: space-between;
  margin: 8px 0 4px;
  padding: 0 8px;
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.font-option {
  min-height: 34px;
  padding: 0 8px;
  border: none;
  border-radius: 8px;
  color: var(--te-neutral-900);
  background: transparent;
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
  text-align: left;
}
.font-option:hover {
  background: color-mix(in srgb, var(--te-primary-400) 12%, transparent);
}
.control-field,
.range-field,
.color-field,
.segment-field {
  display: grid;
  gap: 8px;
  min-width: 0;
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
}
.control-field select,
.control-field input {
  width: 100%;
  min-height: 38px;
  padding: 0 11px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
}
.range-field span,
.color-field span {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.range-field strong {
  color: var(--te-neutral-900);
  font-variant-numeric: tabular-nums;
}
.range-field input[type='range'] {
  width: 100%;
  accent-color: var(--te-primary-500);
}
.segment-control {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 3px;
  border: 1px solid var(--te-card-border);
  border-radius: 11px;
  background: var(--te-card-bg);
}
.segment-control--four {
  grid-template-columns: repeat(4, 1fr);
}
.segment-control button,
.option-grid button {
  min-height: 34px;
  border: 0;
  border-radius: 8px;
  color: var(--te-neutral-500);
  background: transparent;
  cursor: pointer;
}
.segment-control button[aria-pressed='true'],
.option-grid button[aria-pressed='true'] {
  color: var(--te-playback-control-hover-text);
  background: var(--te-primary-500);
}
.option-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
}
.option-grid button {
  border: 1px solid var(--te-card-border);
  background: var(--te-card-bg);
}
.color-field {
  grid-template-columns: 1fr auto auto;
  align-items: center;
}
.color-field input {
  width: 42px;
  height: 32px;
  padding: 2px;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: transparent;
}
.color-field code {
  color: var(--te-neutral-500);
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 13px;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  color: var(--te-neutral-900);
  text-align: left;
  background: var(--te-card-bg);
  cursor: pointer;
}
.switch-row span {
  display: grid;
  gap: 3px;
}
.switch-row small {
  color: var(--te-neutral-500);
}
.switch-row[aria-pressed='true'] i {
  color: var(--te-primary-400);
}
.lyrics-customizer-enter-active,
.lyrics-customizer-leave-active {
  transition: opacity 220ms ease;
}
.lyrics-customizer-enter-active .lyrics-customizer,
.lyrics-customizer-leave-active .lyrics-customizer {
  transition:
    transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 220ms ease;
}
.lyrics-customizer-enter-from,
.lyrics-customizer-leave-to {
  opacity: 0;
}
.lyrics-customizer-enter-from .lyrics-customizer,
.lyrics-customizer-leave-to .lyrics-customizer {
  transform: translateX(-100%);
  opacity: 0.5;
}
@media (max-width: 620px) {
  .customizer-header {
    padding: 18px 16px 14px;
  }
  .customizer-status {
    padding-inline: 16px;
  }
  .style-tabs {
    padding: 12px 16px;
    gap: 5px;
  }
  .style-tabs button {
    padding-inline: 7px;
  }
  .live-preview {
    margin-inline: 16px;
  }
  .customizer-scroll {
    padding-inline: 16px;
  }
  .control-grid {
    grid-template-columns: 1fr;
  }
  .option-grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-height: 700px) {
  .customizer-header {
    padding-block: 14px 10px;
  }
  .customizer-header p {
    display: none;
  }
  .live-preview {
    padding-block: 11px;
    margin-bottom: 10px;
  }
  .style-tabs {
    padding-block: 10px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .lyrics-customizer-enter-active,
  .lyrics-customizer-leave-active,
  .lyrics-customizer-enter-active .lyrics-customizer,
  .lyrics-customizer-leave-active .lyrics-customizer,
  .preview-lines p {
    transition: none;
  }
}
</style>
