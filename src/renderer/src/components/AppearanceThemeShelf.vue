<script setup lang="ts">
import { computed, ref } from 'vue'
import { useThemeStore } from '../stores/useThemeStore'
import { useExtensionRegistry } from '../extensions/registry'
import { getPluginThemeKey } from '../extensions/themeSelection'
import {
  BUILT_IN_THEME_PRESETS,
  resolveThemeProfileTokens,
  type BuiltInThemePresetId
} from '../../../shared/theme'

const props = defineProps<{ disabled: boolean }>()
const store = useThemeStore()
const { themeContributions } = useExtensionRegistry()
const error = ref('')
const changing = ref(false)
const selected = computed(() => {
  const active = store.activeTheme.value
  return active.kind === 'builtin' || active.kind === 'user' ? `${active.kind}:${active.id}` : ''
})
const selectedSkin = computed(() => {
  const active = store.activeTheme.value
  return active.kind === 'plugin' ? `${active.pluginId}:${active.themeId}` : ''
})
const featured = computed(() => {
  const presets = BUILT_IN_THEME_PRESETS.slice(0, 6)
  const active = BUILT_IN_THEME_PRESETS.find((item) => `builtin:${item.id}` === selected.value)
  if (active && !presets.includes(active)) presets[presets.length - 1] = active
  return presets
})
function swatch(preset: (typeof BUILT_IN_THEME_PRESETS)[number]): Record<string, string> {
  const tokens = resolveThemeProfileTokens(preset, 'dark')
  return { '--preset-bg': tokens['surface.app'], '--preset-accent': tokens['color.primary.500'] }
}
async function choose(value: string): Promise<void> {
  if (props.disabled || changing.value) return
  changing.value = true
  error.value = ''
  try {
    const preset = BUILT_IN_THEME_PRESETS.find((item) => `builtin:${item.id}` === value)
    const profile = store.profiles.value.find((item) => `user:${item.id}` === value)
    const plugin = themeContributions.value.find(
      (item) => `plugin:${getPluginThemeKey(item)}` === value
    )
    if (preset) await store.setActive({ kind: 'builtin', id: preset.id as BuiltInThemePresetId })
    else if (profile) await store.setActive({ kind: 'user', id: profile.id })
    else if (plugin)
      await store.setActive({ kind: 'plugin', pluginId: plugin.pluginId, themeId: plugin.id })
  } catch {
    error.value = '主题未能应用，请重试。'
  } finally {
    changing.value = false
  }
}
</script>
<template>
  <section class="appearance-theme-shelf" aria-label="主题与皮肤选择">
    <h2 class="appearance-theme-heading">主题与皮肤</h2>
    <div class="appearance-theme-pickers">
      <label
        >主题选择
        <select
          :value="selected"
          :disabled="disabled || changing"
          @change="choose(($event.target as HTMLSelectElement).value)"
        >
          <option v-if="!selected" value="" disabled>正在使用插件皮肤</option>
          <optgroup label="内置主题">
            <option
              v-for="preset in BUILT_IN_THEME_PRESETS"
              :key="preset.id"
              :value="`builtin:${preset.id}`"
            >
              {{ preset.name }}
            </option>
          </optgroup>
          <optgroup v-if="store.profiles.value.length" label="个人主题">
            <option
              v-for="profile in store.profiles.value"
              :key="profile.id"
              :value="`user:${profile.id}`"
            >
              {{ profile.name }}
            </option>
          </optgroup>
        </select>
      </label>
      <label
        >插件皮肤
        <select
          :value="selectedSkin"
          :disabled="disabled || changing || !themeContributions.length"
          @change="
            choose(
              ($event.target as HTMLSelectElement).value
                ? `plugin:${($event.target as HTMLSelectElement).value}`
                : 'builtin:builtin:twilight-echo-default'
            )
          "
        >
          <option value="">
            {{ themeContributions.length ? '不使用插件皮肤' : '暂无已启用的皮肤' }}
          </option>
          <option
            v-for="theme in themeContributions"
            :key="getPluginThemeKey(theme)"
            :value="getPluginThemeKey(theme)"
          >
            {{ theme.name }}
          </option>
        </select>
      </label>
      <span class="appearance-theme-status" role="status">{{
        changing ? '应用中…' : disabled ? '先应用或放弃当前调整' : '选择后应用'
      }}</span>
      <span v-if="error" class="appearance-theme-error" role="alert">{{ error }}</span>
    </div>
    <div class="appearance-preset-strip" aria-label="内置皮肤预设">
      <button
        v-for="preset in featured"
        :key="preset.id"
        type="button"
        :aria-pressed="selected === `builtin:${preset.id}`"
        :disabled="disabled || changing"
        @click="choose(`builtin:${preset.id}`)"
        :title="preset.description"
        :aria-label="preset.name"
      >
        <span class="appearance-preset-swatch" :style="swatch(preset)" aria-hidden="true"
          ><i /><i /><i
        /></span>
        <span>{{ preset.name }}</span>
        <i v-if="selected === `builtin:${preset.id}`" class="pi pi-check" aria-hidden="true" />
      </button>
    </div>
  </section>
</template>
<style scoped>
.appearance-theme-shelf {
  flex-shrink: 0;
  padding-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--te-settings-text) 7%, transparent);
}
.appearance-theme-heading {
  display: none;
}
.appearance-theme-pickers {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 10px;
  font-size: 12px;
}
label {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}
select {
  width: 168px;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--te-settings-text) 10%, transparent);
  border-radius: 8px;
  background: var(--te-settings-backplate);
  color: inherit;
}
.appearance-theme-status {
  margin-left: auto;
  color: var(--te-settings-text-muted);
  font-size: 11px;
}
.appearance-theme-error {
  color: var(--te-error, #e96262);
}
.appearance-preset-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}
.appearance-preset-strip button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
}
.appearance-preset-strip button > span:not(:first-child) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.appearance-preset-strip button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
}
.appearance-preset-strip button:hover {
  background: color-mix(in srgb, var(--te-settings-text) 6%, transparent);
}
.appearance-preset-strip button > .pi {
  margin-left: auto;
  color: var(--te-primary-500);
  font-size: 11px;
}
.appearance-preset-swatch {
  display: grid;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  grid-template-columns: 1fr;
  gap: 0;
  padding: 4px;
  border-radius: 6px;
  border: 1px solid #8883;
  background: var(--preset-bg);
}
.appearance-preset-swatch i:first-child {
  background: var(--preset-accent);
  border-radius: 50%;
}
.appearance-preset-swatch i:nth-child(2) {
  display: none;
}
.appearance-preset-swatch i:last-child {
  display: none;
}
button:disabled,
select:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
@media (max-width: 1100px) {
  .appearance-preset-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
  .appearance-preset-strip button {
    padding: 6px 10px;
  }
  .appearance-preset-swatch {
    height: 24px;
    width: 24px;
  }
}
@media (max-width: 760px) {
  .appearance-theme-pickers {
    gap: 10px;
    flex-wrap: wrap;
  }
  label {
    flex: 1;
    min-width: 0;
    gap: 6px;
  }
  select {
    min-width: 0;
    flex: 1;
    width: 120px;
  }
  .appearance-theme-status {
    display: none;
  }
  .appearance-preset-strip button {
    gap: 6px;
    font-size: 11px;
  }
}
@media (min-width: 1000px) {
  .appearance-theme-shelf {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    padding: 72px 0 0;
    border: 0;
    min-height: 0;
  }
  .appearance-theme-heading {
    display: block;
    margin: 0 0 20px;
    font-size: 14px;
    font-weight: 600;
  }
  .appearance-theme-pickers {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
    margin-bottom: 16px;
  }
  label {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    color: var(--te-settings-text-muted);
  }
  select {
    width: 100%;
    color: var(--te-settings-text);
    min-height: 34px;
  }
  .appearance-theme-status {
    margin-left: 0;
  }
  .appearance-preset-strip {
    grid-template-columns: minmax(0, 1fr);
    gap: 3px;
  }
  .appearance-preset-strip button {
    padding: 7px 10px;
    gap: 10px;
  }
  .appearance-preset-swatch {
    width: 24px;
    height: 24px;
  }
}
@media (min-width: 1000px) and (max-height: 760px) {
  .appearance-theme-shelf {
    padding-top: 24px;
  }
  .appearance-theme-heading {
    margin-bottom: 14px;
  }
  .appearance-theme-pickers {
    gap: 12px;
    margin-bottom: 12px;
  }
  .appearance-preset-strip button {
    padding-block: 5px;
  }
  .appearance-preset-swatch {
    width: 20px;
    height: 20px;
  }
}
</style>
