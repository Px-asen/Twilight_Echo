<script setup lang="ts">
import { computed } from 'vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import type { ZoneView } from '../../../../../shared/coreZones.ts'
import { zoneThumb, type ZoneThumb } from './zoneDialogRules.ts'

/**
 * A small window of a zone for dialog rows, lit like the wall. Decorative: the
 * row next to it always names the zone.
 */
const props = withDefaults(
  defineProps<{
    /** Null draws an empty slot, e.g. a handoff target not chosen yet. */
    zone: ZoneView | null
    /** Show the zone's music even while its output is silent. */
    music?: boolean
    small?: boolean
  }>(),
  { music: false, small: false }
)

const thumb = computed<ZoneThumb>(() => {
  const zone = props.zone
  if (!zone) return { trackId: null, glyph: 'ph-speaker-simple-high' }
  if (props.music) return { trackId: zone.track?.id ?? null, glyph: 'ph-music-notes-simple' }
  return zoneThumb(zone)
})
</script>

<template>
  <span
    class="zones-dialog-thumb"
    :class="{ 'zones-dialog-thumb--sm': small, 'zones-dialog-thumb--empty': !zone }"
    aria-hidden="true"
  >
    <CoverImg
      v-if="thumb.trackId"
      :key="thumb.trackId"
      class="zones-dialog-thumb-image"
      :core-track-id="thumb.trackId"
      :identity="thumb.trackId"
      size="sm"
      alt=""
    >
      <template #placeholder>
        <i class="ph ph-music-notes-simple" />
      </template>
    </CoverImg>
    <i v-else class="ph" :class="thumb.glyph" />
  </span>
</template>
