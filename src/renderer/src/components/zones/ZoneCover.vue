<script setup lang="ts">
import { computed } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import type { CoreTrackView } from '../../../../shared/coreViews.ts'
import type { ZoneLight } from './zonesPresentation.ts'

/**
 * The window of a zone. Its album cover is the light inside: full colour while
 * the zone plays, dimmed while it rests, switched off when the output is gone.
 */
const props = withDefaults(
  defineProps<{
    track: CoreTrackView | null
    light: ZoneLight
    /** Short Chinese message for the unlit states. */
    message?: string
    /** Secondary line under the message, e.g. the peer name of an offline output. */
    detail?: string
    size?: 'sm' | 'md'
    compact?: boolean
  }>(),
  { message: '', detail: '', size: 'md', compact: false }
)

const lit = computed(() => props.light === 'playing' || props.light === 'paused')
const glyph = computed(() => {
  if (props.light === 'offline') return 'ph-plugs'
  if (props.light === 'unpaired') return 'ph-link-simple-break'
  return 'ph-music-notes-simple'
})
</script>

<template>
  <div
    class="zone-cover"
    :class="[`is-${light}`, { 'is-compact': compact }]"
    :data-light="light"
  >
    <template v-if="lit && track">
      <CoverImg
        :key="track.id"
        class="zone-cover-image"
        :core-track-id="track.id"
        :identity="track.id"
        :size="size"
        alt=""
        loading="lazy"
      >
        <template #placeholder>
          <span class="zone-cover-blank" aria-hidden="true">
            <i class="ph ph-music-notes-simple" />
          </span>
        </template>
      </CoverImg>
      <span v-if="light === 'playing'" class="zone-cover-live" aria-hidden="true">
        <i /><i /><i />
      </span>
    </template>
    <div v-else class="zone-cover-dark">
      <span class="zone-cover-glyph" aria-hidden="true"><i class="ph" :class="glyph" /></span>
      <strong v-if="message">{{ message }}</strong>
      <small v-if="detail && !compact">{{ detail }}</small>
      <div v-if="$slots.action && !compact" class="zone-cover-action"><slot name="action" /></div>
    </div>
    <slot />
  </div>
</template>
