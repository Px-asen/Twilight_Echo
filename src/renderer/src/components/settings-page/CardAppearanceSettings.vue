<script setup lang="ts">
import SettingsDisclosure from './SettingsDisclosure.vue'
import { computed, ref } from 'vue'
import EditableRangeValue from '../EditableRangeValue.vue'
import type { AppearanceDraft } from '../../../../shared/appAppearance.ts'
import type {
  CardAppearanceSettings,
  CardAppearanceTheme,
  CardHoverEffect,
  CardShadowStrength
} from '../../types/settings'

const props = defineProps<{ modelValue: AppearanceDraft; tone?: 'light' | 'dark' }>()
const emit = defineEmits<{
  'update:modelValue': [value: AppearanceDraft]
  'update:tone': [tone: 'light' | 'dark']
}>()
const settings = computed(() => props.modelValue)
function updateSettings(patch: Partial<AppearanceDraft>): void {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

const cardAppearanceOpen = ref(true)
const cardAppearanceTab = computed({
  get: () => props.tone ?? 'light',
  set: (tone: 'light' | 'dark') => emit('update:tone', tone)
})

const cardShadowOptions: { value: CardShadowStrength; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'subtle', label: '弱' },
  { value: 'medium', label: '中' },
  { value: 'strong', label: '强' }
]

const cardHoverOptions: { value: CardHoverEffect; label: string }[] = [
  { value: 'none', label: '无' },
  { value: 'lift', label: '上浮' },
  { value: 'zoom', label: '放大' },
  { value: 'glow', label: '发光' }
]

function cloneCardAppearance(): CardAppearanceSettings {
  const ca = settings.value.cardAppearance
  return {
    enabled: ca.enabled,
    light: { ...ca.light },
    dark: { ...ca.dark },
    background: {
      enabled: ca.background.enabled,
      light: { ...ca.background.light },
      dark: { ...ca.background.dark }
    }
  }
}

function toggleCardAppearance(): void {
  const cardAppearance = cloneCardAppearance()
  cardAppearance.enabled = !cardAppearance.enabled
  void updateSettings({ cardAppearance })
}

function setCardField<K extends keyof CardAppearanceTheme>(
  field: K,
  value: CardAppearanceTheme[K]
): void {
  const cardAppearance = cloneCardAppearance()
  const theme = cardAppearanceTab.value
  cardAppearance[theme][field] = value
  void updateSettings({ cardAppearance })
}
</script>

<template>
  <button
    type="button"
    class="settings-accordion-trigger setting-item"
    :class="{ open: cardAppearanceOpen }"
    :aria-expanded="cardAppearanceOpen"
    @click="cardAppearanceOpen = !cardAppearanceOpen"
  >
    <span class="setting-copy">
      <strong>卡片细节</strong>
      <span>调节卡片模糊、颜色、阴影和悬停反馈。</span>
    </span>
    <i class="pi pi-chevron-down"></i>
  </button>
  <SettingsDisclosure :open="cardAppearanceOpen" class="settings-accordion-body">
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>启用自定义外观</strong>
        <span>标准材质下应用自定义卡片外观。</span>
      </div>
      <button
        type="button"
        aria-label="启用自定义外观"
        class="toggle-switch"
        :class="{ active: settings.cardAppearance.enabled }"
        role="switch"
        :aria-checked="settings.cardAppearance.enabled"
        @click="toggleCardAppearance"
      ></button>
    </div>
    <div v-if="settings.cardAppearance.enabled">
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>编辑主题</strong>
          <span>分别设置浅色与深色模式下的卡片外观。</span>
        </div>
        <div class="theme-segment">
          <button
            type="button"
            :class="{ active: cardAppearanceTab === 'light' }"
            @click="cardAppearanceTab = 'light'"
          >
            <i class="pi pi-sun"></i>
            浅色
          </button>
          <button
            type="button"
            :class="{ active: cardAppearanceTab === 'dark' }"
            @click="cardAppearanceTab = 'dark'"
          >
            <i class="pi pi-moon"></i>
            深色
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片模糊强度</strong>
          <span>控制卡片毛玻璃的模糊半径。</span>
        </div>
        <div class="range-pill">
          <span>模糊</span>
          <input
            class="range-input"
            type="range"
            min="0"
            max="40"
            :value="settings.cardAppearance[cardAppearanceTab].blurRadius"
            @input="setCardField('blurRadius', Number(($event.target as HTMLInputElement).value))"
          />
          <EditableRangeValue
            :value="settings.cardAppearance[cardAppearanceTab].blurRadius"
            :min="0"
            :max="40"
            suffix="px"
            aria-label="编辑卡片模糊强度"
            @change="setCardField('blurRadius', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片模糊饱和度</strong>
          <span>增强或减弱毛玻璃的色彩饱和感。</span>
        </div>
        <div class="range-pill">
          <span>饱和度</span>
          <input
            class="range-input"
            type="range"
            min="80"
            max="180"
            :value="settings.cardAppearance[cardAppearanceTab].blurSaturation"
            @input="
              setCardField('blurSaturation', Number(($event.target as HTMLInputElement).value))
            "
          />
          <EditableRangeValue
            :value="settings.cardAppearance[cardAppearanceTab].blurSaturation"
            :min="80"
            :max="180"
            suffix="%"
            aria-label="编辑卡片模糊饱和度"
            @change="setCardField('blurSaturation', $event)"
          />
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片背景颜色</strong>
          <span>自定义卡片的底色。</span>
        </div>
        <div class="inline-controls">
          <input
            type="color"
            class="color-picker"
            :value="settings.cardAppearance[cardAppearanceTab].backgroundColor"
            @input="setCardField('backgroundColor', ($event.target as HTMLInputElement).value)"
          />
          <div class="range-pill">
            <span>不透明度</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="100"
              :value="settings.cardAppearance[cardAppearanceTab].backgroundOpacity"
              @input="
                setCardField('backgroundOpacity', Number(($event.target as HTMLInputElement).value))
              "
            />
            <EditableRangeValue
              :value="settings.cardAppearance[cardAppearanceTab].backgroundOpacity"
              :min="0"
              :max="100"
              suffix="%"
              aria-label="编辑卡片背景不透明度"
              @change="setCardField('backgroundOpacity', $event)"
            />
          </div>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片边框</strong>
          <span>自定义边框颜色、透明度与宽度。</span>
        </div>
        <div class="inline-controls">
          <input
            type="color"
            class="color-picker"
            :value="settings.cardAppearance[cardAppearanceTab].borderColor"
            @input="setCardField('borderColor', ($event.target as HTMLInputElement).value)"
          />
          <div class="range-pill">
            <span>透明度</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="100"
              :value="settings.cardAppearance[cardAppearanceTab].borderOpacity"
              @input="
                setCardField('borderOpacity', Number(($event.target as HTMLInputElement).value))
              "
            />
            <EditableRangeValue
              :value="settings.cardAppearance[cardAppearanceTab].borderOpacity"
              :min="0"
              :max="100"
              suffix="%"
              aria-label="编辑卡片边框透明度"
              @change="setCardField('borderOpacity', $event)"
            />
          </div>
          <div class="range-pill">
            <span>宽度</span>
            <input
              class="range-input"
              type="range"
              min="0"
              max="3"
              step="0.5"
              :value="settings.cardAppearance[cardAppearanceTab].borderWidth"
              @input="
                setCardField('borderWidth', Number(($event.target as HTMLInputElement).value))
              "
            />
            <EditableRangeValue
              :value="settings.cardAppearance[cardAppearanceTab].borderWidth"
              :min="0"
              :max="3"
              :step="0.5"
              suffix="px"
              aria-label="编辑卡片边框宽度"
              @change="setCardField('borderWidth', $event)"
            />
          </div>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片阴影强度</strong>
          <span>控制卡片投影的深浅。</span>
        </div>
        <div class="segmented-control">
          <button
            v-for="option in cardShadowOptions"
            :key="option.value"
            type="button"
            :class="{
              active: settings.cardAppearance[cardAppearanceTab].shadowStrength === option.value
            }"
            @click="setCardField('shadowStrength', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>卡片悬浮效果</strong>
          <span>鼠标悬停时卡片的动效。</span>
        </div>
        <div class="segmented-control">
          <button
            v-for="option in cardHoverOptions"
            :key="option.value"
            type="button"
            :class="{
              active: settings.cardAppearance[cardAppearanceTab].hoverEffect === option.value
            }"
            @click="setCardField('hoverEffect', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>玻璃高光</strong>
          <span>在卡片顶部添加内描边光泽。</span>
        </div>
        <button
          type="button"
          aria-label="玻璃高光"
          class="toggle-switch"
          :class="{ active: settings.cardAppearance[cardAppearanceTab].glassHighlight }"
          role="switch"
          :aria-checked="settings.cardAppearance[cardAppearanceTab].glassHighlight"
          @click="
            setCardField(
              'glassHighlight',
              !settings.cardAppearance[cardAppearanceTab].glassHighlight
            )
          "
        ></button>
      </div>
    </div>
  </SettingsDisclosure>
</template>
