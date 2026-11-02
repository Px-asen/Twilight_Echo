<script setup lang="ts">
import { computed, type Ref } from 'vue'
import type { LyricLine, LyricVoiceLayer } from '../utils/lyrics.ts'
import { resolveLyricVoiceLayout, type LyricTextDirection } from '../utils/lyricVoiceLayout.ts'
import { isSupportingVoiceActive } from '../utils/lyricSupportingVoice.ts'
import PlayingLyricWords from './PlayingLyricWords.vue'

interface LyricClockSnapshot {
  epoch: number
  revision: number
  position: number
}

const props = defineProps<{
  line: LyricLine
  singing: boolean
  karaokeEnabled: boolean
  offsetSeconds: number
  motionMode: 'full' | 'reduced' | 'off'
  clock: {
    snapshot: Ref<LyricClockSnapshot>
    isPlaying: Ref<boolean>
    positionAt: (at?: number) => number
  }
  translationStyle: Record<string, string>
  romanizationStyle: Record<string, string>
  harmonyStyle: Record<string, string>
  align: 'left' | 'center' | 'right'
}>()

const lineDirection = computed<LyricTextDirection>(() => {
  const text = props.line.voices?.map((voice) => voice.text).join(' ') || props.line.text
  return /[\u0590-\u08ff]/.test(text) ? 'rtl' : 'ltr'
})
const voiceLayout = computed(() => resolveLyricVoiceLayout(props.line, lineDirection.value))
const dynamicVoiceKeys = computed(
  () =>
    new Set(
      voiceLayout.value.ordered
        .filter((voice) => (voice.words?.length ?? 0) > 0)
        .slice(0, 4)
        .map((voice) => voice.voiceKey)
    )
)
const hasVoiceTranslation = computed(() =>
  voiceLayout.value.ordered.some((voice) => Boolean(voice.translation?.text))
)
const hasVoiceRomanization = computed(() =>
  voiceLayout.value.ordered.some((voice) => Boolean(voice.romanization?.text))
)
const hasSplitSideLanes = computed(
  () => voiceLayout.value.start.length > 0 && voiceLayout.value.end.length > 0
)
const supportingPosition = computed<number | null>(() => {
  if (!props.singing) return null
  // Depend on the shared clock revision only for the currently singing row;
  // distant lyric rows remain isolated from playback ticks.
  void props.clock.snapshot.value.revision
  return props.clock.positionAt() + props.offsetSeconds
})

function isSupportingVoiceVisible(voice: LyricVoiceLayer): boolean {
  const position = supportingPosition.value
  return position != null && isSupportingVoiceActive(voice, props.line, position, props.singing)
}

function voiceClass(voice: LyricVoiceLayer): Record<string, boolean> {
  const supporting = voice.role !== 'lead'
  return {
    'lyric-voice--lead': voice.role === 'lead',
    'lyric-voice--background': voice.role === 'background',
    'lyric-voice--harmony': voice.role === 'harmony',
    'lyric-voice--supporting': supporting,
    'lyric-voice--supporting-visible': supporting && isSupportingVoiceVisible(voice)
  }
}

function voiceStyle(voice: LyricVoiceLayer): Record<string, string> | undefined {
  return voice.role === 'lead' ? undefined : props.harmonyStyle
}

function voiceTranslationStyle(voice: LyricVoiceLayer): Record<string, string> {
  return voice.role === 'lead' ? props.translationStyle : props.harmonyStyle
}

function voiceRomanizationStyle(voice: LyricVoiceLayer): Record<string, string> {
  return voice.role === 'lead' ? props.romanizationStyle : props.harmonyStyle
}

function voiceMotionRole(voice: LyricVoiceLayer): 'lead' | 'background' | 'harmony' {
  return voice.role
}
</script>

<template>
  <span
    class="lyric-row-content"
    :class="[
      { 'lyric-row-content--duet': voiceLayout.hasDuet },
      `lyric-row-content--align-${align}`
    ]"
    :dir="lineDirection"
    aria-hidden="true"
  >
    <span v-if="voiceLayout.center.length" class="lyric-lane lyric-lane--center">
      <span
        v-for="voice in voiceLayout.center"
        :key="voice.voiceKey"
        class="lyric-voice"
        :class="voiceClass(voice)"
        :style="voiceStyle(voice)"
        :aria-hidden="voice.role !== 'lead' && !isSupportingVoiceVisible(voice)"
        dir="auto"
      >
        <PlayingLyricWords
          v-if="voice.words?.length"
          :words="voice.words"
          :active="singing && dynamicVoiceKeys.has(voice.voiceKey)"
          :offset-seconds="offsetSeconds"
          :clock="clock"
          :karaoke-enabled="karaokeEnabled"
          :motion-mode="motionMode"
          :voice-role="voiceMotionRole(voice)"
          :direction="lineDirection"
        />
        <span v-else class="lyric-text">{{ voice.text }}</span>
        <PlayingLyricWords
          v-if="voice.translation?.words?.length"
          class="lyric-voice-translation"
          :words="voice.translation.words"
          :active="singing"
          :offset-seconds="offsetSeconds"
          :clock="clock"
          :karaoke-enabled="karaokeEnabled"
          :motion-mode="motionMode"
          :voice-role="voiceMotionRole(voice)"
          :direction="lineDirection"
          :style="voiceTranslationStyle(voice)"
        />
        <span
          v-else-if="voice.translation?.text"
          class="lyric-voice-translation"
          :style="voiceTranslationStyle(voice)"
          >{{ voice.translation.text }}</span
        >
        <PlayingLyricWords
          v-if="voice.romanization?.words?.length"
          class="lyric-voice-romanization"
          :words="voice.romanization.words"
          :active="singing"
          :offset-seconds="offsetSeconds"
          :clock="clock"
          :karaoke-enabled="karaokeEnabled"
          :motion-mode="motionMode"
          :voice-role="voiceMotionRole(voice)"
          :direction="lineDirection"
          :style="voiceRomanizationStyle(voice)"
        />
        <span
          v-else-if="voice.romanization?.text"
          class="lyric-voice-romanization"
          :style="voiceRomanizationStyle(voice)"
          >{{ voice.romanization.text }}</span
        >
      </span>
    </span>

    <span
      v-if="voiceLayout.start.length || voiceLayout.end.length"
      class="lyric-duet-grid"
      :class="{ 'lyric-duet-grid--split': hasSplitSideLanes }"
    >
      <span v-if="voiceLayout.start.length" class="lyric-lane lyric-lane--start">
        <span
          v-for="voice in voiceLayout.start"
          :key="voice.voiceKey"
          class="lyric-voice"
          :class="voiceClass(voice)"
          :style="voiceStyle(voice)"
          :aria-hidden="voice.role !== 'lead' && !isSupportingVoiceVisible(voice)"
          dir="auto"
        >
          <PlayingLyricWords
            v-if="voice.words?.length"
            :words="voice.words"
            :active="singing && dynamicVoiceKeys.has(voice.voiceKey)"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
          />
          <span v-else class="lyric-text">{{ voice.text }}</span>
          <PlayingLyricWords
            v-if="voice.translation?.words?.length"
            class="lyric-voice-translation"
            :words="voice.translation.words"
            :active="singing"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
            :style="voiceTranslationStyle(voice)"
          />
          <span
            v-else-if="voice.translation?.text"
            class="lyric-voice-translation"
            :style="voiceTranslationStyle(voice)"
            >{{ voice.translation.text }}</span
          >
          <PlayingLyricWords
            v-if="voice.romanization?.words?.length"
            class="lyric-voice-romanization"
            :words="voice.romanization.words"
            :active="singing"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
            :style="voiceRomanizationStyle(voice)"
          />
          <span
            v-else-if="voice.romanization?.text"
            class="lyric-voice-romanization"
            :style="voiceRomanizationStyle(voice)"
            >{{ voice.romanization.text }}</span
          >
        </span>
      </span>
      <span v-if="voiceLayout.end.length" class="lyric-lane lyric-lane--end">
        <span
          v-for="voice in voiceLayout.end"
          :key="voice.voiceKey"
          class="lyric-voice"
          :class="voiceClass(voice)"
          :style="voiceStyle(voice)"
          :aria-hidden="voice.role !== 'lead' && !isSupportingVoiceVisible(voice)"
          dir="auto"
        >
          <PlayingLyricWords
            v-if="voice.words?.length"
            :words="voice.words"
            :active="singing && dynamicVoiceKeys.has(voice.voiceKey)"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
          />
          <span v-else class="lyric-text">{{ voice.text }}</span>
          <PlayingLyricWords
            v-if="voice.translation?.words?.length"
            class="lyric-voice-translation"
            :words="voice.translation.words"
            :active="singing"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
            :style="voiceTranslationStyle(voice)"
          />
          <span
            v-else-if="voice.translation?.text"
            class="lyric-voice-translation"
            :style="voiceTranslationStyle(voice)"
            >{{ voice.translation.text }}</span
          >
          <PlayingLyricWords
            v-if="voice.romanization?.words?.length"
            class="lyric-voice-romanization"
            :words="voice.romanization.words"
            :active="singing"
            :offset-seconds="offsetSeconds"
            :clock="clock"
            :karaoke-enabled="karaokeEnabled"
            :motion-mode="motionMode"
            :voice-role="voiceMotionRole(voice)"
            :direction="lineDirection"
            :style="voiceRomanizationStyle(voice)"
          />
          <span
            v-else-if="voice.romanization?.text"
            class="lyric-voice-romanization"
            :style="voiceRomanizationStyle(voice)"
            >{{ voice.romanization.text }}</span
          >
        </span>
      </span>
    </span>

    <span
      v-if="line.translation && !hasVoiceTranslation"
      class="lyric-translation"
      :style="translationStyle"
      dir="auto"
    >
      {{ line.translation }}
    </span>
    <span
      v-if="line.romanization && !hasVoiceRomanization"
      class="lyric-romanization"
      :style="romanizationStyle"
      dir="auto"
    >
      {{ line.romanization }}
    </span>
  </span>
</template>

<style scoped>
.lyric-row-content {
  display: flex;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  overflow: visible;
  transform: scale(var(--lyric-line-scale, 1));
  transform-origin: center;
  /* Let Chromium re-rasterize scaled text instead of pinning every row's texture. */
}

/* Keep the reading edge fixed while the active row grows.  A centered scale
 * makes a left-aligned line spill into the previous column on both sides. */
.lyric-row-content--align-left {
  transform-origin: left center;
  padding-right: 2%;
}

.lyric-row-content--align-right {
  transform-origin: right center;
  padding-left: 2%;
}

.lyric-row-content--align-center {
  transform-origin: center center;
}

.lyric-lane,
.lyric-voice {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.lyric-lane {
  gap: 4px;
}

.lyric-lane--center {
  align-items: center;
  text-align: center;
}

.lyric-row-content--align-left .lyric-lane--center {
  align-items: flex-start;
  text-align: start;
}

.lyric-row-content--align-right .lyric-lane--center {
  align-items: flex-end;
  text-align: end;
}

.lyric-row-content--align-left .lyric-translation,
.lyric-row-content--align-left .lyric-romanization {
  text-align: start;
}

.lyric-row-content--align-right .lyric-translation,
.lyric-row-content--align-right .lyric-romanization {
  text-align: end;
}

.lyric-row-content--duet .lyric-translation,
.lyric-row-content--duet .lyric-romanization {
  text-align: center;
}

.lyric-duet-grid {
  display: grid;
  width: 100%;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  gap: 32px;
  align-items: start;
}

.lyric-duet-grid--split {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.lyric-lane--start {
  align-items: flex-start;
  text-align: start;
}

.lyric-lane--end {
  align-items: flex-end;
  text-align: end;
}

.lyric-voice {
  width: 100%;
  unicode-bidi: plaintext;
}

.lyric-lane--end .lyric-voice {
  align-items: flex-end;
}

.lyric-voice--supporting {
  max-height: 0;
  overflow: hidden;
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
  transform-origin: center top;
  visibility: hidden;
  pointer-events: none;
  font-size: clamp(12px, var(--lyric-style-font-size, 14px), 48px);
  line-height: var(--lyric-style-line-height, 1.3);
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  text-align: var(--lyric-style-align, center);
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-weight: var(--lyric-style-font-weight, 500);
  font-style: var(--lyric-style-font-style, normal);
  color: var(--lyric-style-color, var(--te-playback-lyric-harmony, rgba(255, 255, 255, 0.48)));
  background: var(--lyric-style-background, transparent);
  background-image: var(--lyric-style-background-image, none);
  backdrop-filter: var(--lyric-style-backdrop-filter, none);
  -webkit-backdrop-filter: var(--lyric-style-backdrop-filter, none);
  text-shadow: var(--lyric-style-highlight, none);
  -webkit-text-stroke: var(--lyric-style-stroke, 0 transparent);
  transition:
    max-height 320ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 220ms ease,
    transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
    visibility 0s linear 320ms;
}

.lyric-voice--supporting-visible {
  max-height: 14em;
  opacity: var(--lyric-style-opacity, 0.62);
  transform: translateY(0) scale(1);
  visibility: visible;
  pointer-events: auto;
}

.lyric-text,
.lyric-translation,
.lyric-romanization,
.lyric-voice-translation,
.lyric-voice-romanization {
  min-width: 0;
  width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}

.lyric-text {
  font-size: clamp(12px, var(--lyric-style-font-size, var(--te-lyric-font-size, 18px)), 48px);
  line-height: var(--lyric-style-line-height, var(--te-lyric-line-height, 1.85));
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  text-align: var(--lyric-style-align, inherit);
}

.lyric-translation {
  margin-top: max(2px, var(--te-lyric-translation-spacing, 0px));
  padding: 0;
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-size: var(--lyric-style-font-size, 14px);
  font-weight: var(--lyric-style-font-weight, 500);
  font-style: var(--lyric-style-font-style, normal);
  line-height: var(--lyric-style-line-height, 1.3);
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  color: var(--lyric-style-color, var(--te-playback-lyric-translation));
  opacity: var(--lyric-style-opacity, 1);
  text-align: center;
}

.lyric-voice-translation,
.lyric-voice-romanization {
  width: 100%;
  padding: 0;
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-size: var(--lyric-style-font-size, 14px);
  font-weight: var(--lyric-style-font-weight, 500);
  font-style: var(--lyric-style-font-style, normal);
  line-height: var(--lyric-style-line-height, 1.3);
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  text-align: var(--lyric-style-align, center);
  color: var(--lyric-style-color, var(--te-playback-lyric-translation));
  opacity: var(--lyric-style-opacity, 0.88);
  background: var(--lyric-style-background, transparent);
  background-image: var(--lyric-style-background-image, none);
  backdrop-filter: var(--lyric-style-backdrop-filter, none);
  -webkit-backdrop-filter: var(--lyric-style-backdrop-filter, none);
  text-shadow: var(--lyric-style-highlight, none);
  -webkit-text-stroke: var(--lyric-style-stroke, 0 transparent);
}

.lyric-voice-translation {
  margin-top: max(2px, var(--te-lyric-translation-spacing, 0px));
}

.lyric-voice-romanization {
  margin-top: 1px;
  color: var(--lyric-style-color, var(--te-playback-lyric-romanization));
}

.lyric-lane--start .lyric-text,
.lyric-lane--start .lyric-voice-translation,
.lyric-lane--start .lyric-voice-romanization {
  text-align: start;
}

.lyric-lane--end .lyric-text,
.lyric-lane--end .lyric-voice-translation,
.lyric-lane--end .lyric-voice-romanization {
  text-align: end;
}

.lyric-romanization {
  margin-top: max(2px, var(--te-lyric-translation-spacing, 0px));
  font-family: var(--lyric-style-font-family, var(--te-lyric-font-family, inherit));
  font-size: var(--lyric-style-font-size, 13px);
  font-weight: var(--lyric-style-font-weight, 400);
  font-style: var(--lyric-style-font-style, normal);
  line-height: var(--lyric-style-line-height, 1.25);
  letter-spacing: var(--lyric-style-letter-spacing, 0);
  color: var(--lyric-style-color, var(--te-playback-lyric-romanization));
  opacity: var(--lyric-style-opacity, 1);
  text-align: center;
}

:global(.lyric-row.is-singing .lyric-voice--lead) {
  color: var(--te-playback-lyric-active-text);
}

:global(html[data-te-motion='reduced']) .lyric-voice--supporting,
:global(html[data-te-motion='off']) .lyric-voice--supporting {
  transition: none;
  transform: none;
}

:global(.lyric-row.is-singing .lyric-translation),
:global(.lyric-row.is-singing .lyric-voice-translation) {
  color: var(
    --lyric-style-active-color,
    var(--te-playback-lyric-translation-active, rgba(255, 255, 255, 0.82))
  );
}

:global(.lyric-row.is-singing .lyric-romanization),
:global(.lyric-row.is-singing .lyric-voice-romanization) {
  color: var(
    --lyric-style-active-color,
    var(--te-playback-lyric-romanization-active, rgba(255, 255, 255, 0.72))
  );
}

@media (max-width: 620px) {
  .lyric-duet-grid--split {
    grid-template-columns: minmax(0, 1fr);
  }

  .lyric-duet-grid {
    gap: 12px;
    margin-bottom: 4px;
  }

  .lyric-lane--start,
  .lyric-lane--end {
    width: 100%;
  }
}

:global(html[data-te-motion='reduced']) .lyric-row-content,
:global(html[data-te-motion='off']) .lyric-row-content {
  transform: none !important;
}

@media (forced-colors: active) {
  :global(.lyric-row.is-singing .lyric-voice--lead) {
    color: CanvasText;
    text-decoration: underline;
    text-decoration-thickness: 0.08em;
  }
}
</style>
