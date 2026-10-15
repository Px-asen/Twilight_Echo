<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue'

// osu!lazer-style textbox: each committed grapheme pops in with a spring, and
// shrinks away on delete. A transparent native <input> keeps focus/IME/caret
// behavior; an overlaid mirror renders the per-character animation.
const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    maxAnimatedLength?: number
    animate?: boolean
  }>(),
  { placeholder: '', maxAnimatedLength: 60, animate: false }
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

defineOptions({ inheritAttrs: false })

const attrs = useAttrs()
const rootClass = computed(() => attrs.class)
const rootStyle = computed(() => attrs.style)
const inputAttrs = computed(() => {
  const { class: _class, style: _style, ...rest } = attrs
  return rest
})

interface AnimatedChar {
  id: number
  char: string
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
let nextCharId = 1
const chars = ref<AnimatedChar[]>([])
const inputEl = ref<HTMLInputElement | null>(null)
const scrollX = ref(0)
const composing = ref(false)

// Diff by common prefix/suffix so mid-string edits keep stable ids: untouched
// characters must not re-key, or every keystroke would replay all animations.
function reconcile(value: string): void {
  const prev = chars.value
  const next = Array.from(segmenter.segment(value), (part) => part.segment)
  let start = 0
  const shared = Math.min(prev.length, next.length)
  while (start < shared && prev[start].char === next[start]) start++
  let prevEnd = prev.length
  let nextEnd = next.length
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1].char === next[nextEnd - 1]) {
    prevEnd--
    nextEnd--
  }
  const inserted = next.slice(start, nextEnd).map((char) => ({ id: nextCharId++, char }))
  chars.value = [...prev.slice(0, start), ...inserted, ...prev.slice(prevEnd)]
}

watch(() => props.modelValue, reconcile, { immediate: true })

// Per-character motion is opt-in by scenario, not inferred from length: search
// boxes take hundreds of keystrokes a day and must never animate, while a
// one-off playlist-name field can afford it. maxAnimatedLength still caps the
// opted-in case so a long paste does not spawn dozens of transitions.
const animated = computed(() => props.animate && chars.value.length <= props.maxAnimatedLength)

function syncScroll(): void {
  requestAnimationFrame(() => {
    if (inputEl.value) scrollX.value = inputEl.value.scrollLeft
  })
}

// Mirror native v-model semantics. The native <input> always owns the true
// value, so every input event carries the current text — including IME
// composition updates and the final commit. We must NOT drop input events
// while composing: on X11/XIM the input event for the committed text may
// arrive after compositionend (or compositionend may not fire reliably),
// so emitting from input keeps the committed text flowing into modelValue.
// During composition the raw text is shown via the .is-composing class.
function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  syncScroll()
}

function commitCompositionValue(): void {
  const value = inputEl.value?.value ?? ''
  emit('update:modelValue', value)
  syncScroll()
}

function onCompositionUpdate(): void {
  composing.value = true
  syncScroll()
}

function onCompositionEnd(): void {
  composing.value = false
  // Fallback: on some platforms the committed text is only visible after a
  // tick (X11/XIM), or the final input event is dropped. Reading the value
  // asynchronously guarantees the committed grapheme reaches modelValue.
  window.setTimeout(commitCompositionValue, 0)
}

function onCompositionCancel(): void {
  composing.value = false
}
</script>

<template>
  <span
    class="animated-input"
    :class="[rootClass, { 'is-composing': composing }]"
    :style="rootStyle"
  >
    <input
      ref="inputEl"
      class="animated-input-field"
      :value="modelValue"
      :placeholder="placeholder"
      v-bind="inputAttrs"
      @input="onInput"
      @scroll="syncScroll"
      @compositionstart="composing = true"
      @compositionupdate="onCompositionUpdate"
      @compositionend="onCompositionEnd"
      @compositioncancel="onCompositionCancel"
    />
    <span class="animated-input-mirror" aria-hidden="true">
      <span class="animated-input-track" :style="{ transform: `translate3d(${-scrollX}px, 0, 0)` }">
        <TransitionGroup v-if="animated" name="ai-char">
          <span v-for="c in chars" :key="c.id" class="ai-char">{{ c.char }}</span>
        </TransitionGroup>
        <span v-else class="ai-plain">{{ modelValue }}</span>
      </span>
    </span>
  </span>
</template>

<style scoped>
.animated-input {
  position: relative;
  display: inline-flex;
  align-items: center;
  overflow: hidden;
}

.animated-input:has(.animated-input-field:focus-visible) {
  outline: var(--ai-focus-outline, 2px solid var(--te-control-focus-color));
  outline-offset: 2px;
}

.animated-input-field {
  width: 100%;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  letter-spacing: inherit;
  color: transparent;
  /* Wins over host selectors that set `color` on descendant inputs. */
  -webkit-text-fill-color: transparent;
  caret-color: var(--ai-caret, var(--te-primary-500));
}

.animated-input-field::placeholder {
  color: var(--ai-placeholder, var(--te-neutral-500));
  -webkit-text-fill-color: var(--ai-placeholder, var(--te-neutral-500));
}

.animated-input-field::selection {
  color: transparent;
  background: color-mix(in srgb, var(--te-primary-500) 24%, transparent);
}

/* While composing, show the raw native text so the inline IME string stays visible. */
.animated-input.is-composing .animated-input-field {
  color: inherit;
  -webkit-text-fill-color: currentColor;
}

.animated-input.is-composing .animated-input-mirror {
  opacity: 0;
}

.animated-input-mirror {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  /* Track the host's padding so mirrored text lines up with the native caret. */
  padding: inherit;
  display: flex;
  align-items: center;
  justify-content: var(--ai-justify, flex-start);
  overflow: hidden;
  pointer-events: none;
}

.animated-input-track {
  display: inline-flex;
  align-items: baseline;
  white-space: pre;
  will-change: transform;
}

.ai-char,
.ai-plain {
  display: inline-block;
  white-space: pre;
  transform-origin: 50% 80%;
}

.ai-char-enter-active {
  transition:
    opacity 180ms ease-out,
    transform var(--te-motion-panel) var(--te-ease-spring);
}

.ai-char-enter-from {
  opacity: 0;
  transform: translateY(0.35em) scale(0.9);
}

.ai-char-leave-active {
  position: absolute;
  transition:
    opacity var(--te-motion-return) ease,
    transform var(--te-motion-return) var(--te-ease-out-quint);
}

.ai-char-leave-to {
  opacity: 0;
  transform: translateY(0.3em) scale(0.9);
}

.ai-char-move {
  transition: transform var(--te-motion-panel) var(--te-ease-out-quint);
}

@media (prefers-reduced-motion: reduce) {
  @scope (:root:not([data-te-motion='full'])) {
    .ai-char-enter-active,
    .ai-char-leave-active,
    .ai-char-move {
      transition: none;
    }
  }
}
</style>
