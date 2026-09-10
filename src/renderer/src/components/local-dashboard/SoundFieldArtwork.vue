<script setup lang="ts">
import CoverImg from '@renderer/components/CoverImg.vue'

defineProps<{
  cover?: string | null
  coverSource?: string | null
  identity?: string
  title: string
  eager?: boolean
}>()
</script>

<template>
  <span class="sf-artwork" :data-motif="(title.charCodeAt(0) || 0) % 3">
    <span class="sf-artwork-fallback" aria-hidden="true">
      <span class="sf-artwork-form"></span>
      <i class="ph ph-waveform"></i>
      <span>{{ title.slice(0, 1) || 'S' }}</span>
      <small>SOUND FIELD</small>
    </span>
    <CoverImg
      :cover="cover"
      :cover-source="coverSource"
      :identity="identity"
      :loading="eager ? 'eager' : 'lazy'"
      fallback=""
      alt=""
    />
  </span>
</template>

<style scoped>
.sf-artwork {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--te-neutral-200);
}
.sf-artwork :deep(img) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.sf-artwork-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  padding: 10%;
  color: var(--te-neutral-900);
  background: color-mix(in srgb, var(--te-primary-300) 35%, var(--te-neutral-100));
}
.sf-artwork[data-motif='1'] .sf-artwork-fallback {
  background: color-mix(in srgb, var(--te-accent-cyan) 20%, var(--te-neutral-100));
}
.sf-artwork[data-motif='2'] .sf-artwork-fallback {
  background: var(--te-neutral-200);
}
.sf-artwork-form {
  position: absolute;
  top: 30%;
  left: 40%;
  width: 110%;
  aspect-ratio: 1;
  border: 28px solid color-mix(in srgb, var(--te-primary-500) 25%, transparent);
  border-radius: 50%;
}
.sf-artwork[data-motif='1'] .sf-artwork-form {
  top: 50%;
  left: 10%;
  width: 100%;
  border: 0;
  border-radius: 42% 0 0;
  background: color-mix(in srgb, var(--te-accent-cyan) 35%, transparent);
  transform: rotate(-25deg);
}
.sf-artwork[data-motif='2'] .sf-artwork-form {
  top: 32%;
  left: 66%;
  width: 26%;
  height: 85%;
  border: 0;
  border-radius: 0;
  background: color-mix(in srgb, var(--te-neutral-900) 17%, transparent);
  box-shadow: -28px 32px 0 color-mix(in srgb, var(--te-primary-500) 26%, transparent);
}
.sf-artwork-fallback > i {
  font-size: calc(var(--te-font-size-body, 14px) * 24 / 14);
  color: var(--te-primary-500);
}
.sf-artwork-fallback > span:not(.sf-artwork-form) {
  position: relative;
  align-self: center;
  font: 500 54px / 1 var(--te-font-display);
}
.sf-artwork-fallback > small {
  position: relative;
  font: 500 8px / 1 var(--te-font-sans);
  letter-spacing: 0;
}
</style>
