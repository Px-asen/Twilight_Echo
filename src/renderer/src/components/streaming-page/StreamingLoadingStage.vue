<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  providerLabel?: string
  title?: string
  hint?: string
}>()

const stageTitle = computed(() => props.title ?? '正在唤醒你的云端曲库')
const stageHint = computed(
  () => props.hint ?? `正在同步 ${props.providerLabel ?? '在线音源'} 的歌单与收藏`
)
</script>

<template>
  <div class="tls-stage" role="status" aria-live="polite" :aria-label="stageTitle">
    <div class="tls-orb tls-orb-a" aria-hidden="true"></div>
    <div class="tls-orb tls-orb-b" aria-hidden="true"></div>

    <div class="tls-emblem" aria-hidden="true">
      <span class="tls-halo"></span>
      <span class="tls-orbit">
        <span class="tls-orbit-dot"></span>
      </span>
      <span class="tls-disc">
        <span class="tls-disc-label">
          <i class="pi pi-headphones"></i>
        </span>
        <span class="tls-disc-sheen"></span>
      </span>
      <span class="tls-eq"> <i></i><i></i><i></i><i></i><i></i> </span>
    </div>

    <p class="tls-kicker">Twilight Echo · 在线漫游</p>
    <h2 class="tls-title">{{ stageTitle }}</h2>
    <p class="tls-hint">
      <span>{{ stageHint }}</span>
      <span class="tls-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    </p>

    <div class="tls-progress" aria-hidden="true">
      <span class="tls-progress-beam"></span>
    </div>

    <div class="tls-ghost" aria-hidden="true">
      <span class="tls-ghost-card"></span>
      <span class="tls-ghost-card"></span>
      <span class="tls-ghost-card"></span>
    </div>
  </div>
</template>

<style scoped>
.tls-stage {
  --tls-ink: var(--te-neutral-900);
  --tls-ink-soft: var(--te-neutral-500);
  --tls-primary-tint: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  --tls-cyan-tint: color-mix(in srgb, var(--te-accent-cyan) 13%, transparent);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: clamp(420px, 58vh, 560px);
  padding: 56px 24px 40px;
  text-align: center;
  border: 1px solid var(--te-card-border);
  border-radius: 22px;
  background: var(--te-card-bg);
  overflow: hidden;
  box-shadow: 0 18px 44px color-mix(in srgb, var(--te-neutral-900) 8%, transparent);
  animation: tls-stage-in 0.62s var(--te-ease-out-quint) both;
}

@keyframes tls-stage-in {
  from {
    opacity: 0;
    transform: translateY(26px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ── Ambient orbs ──────────────────────────────────────────────────── */

.tls-orb {
  position: absolute;
  border-radius: 999px;
  filter: blur(56px);
  pointer-events: none;
}

.tls-orb-a {
  width: 360px;
  height: 360px;
  left: -100px;
  top: -140px;
  background: color-mix(in srgb, var(--te-primary-500) 16%, transparent);
  animation: tls-drift-a 12s ease-in-out infinite;
}

.tls-orb-b {
  width: 320px;
  height: 320px;
  right: -90px;
  bottom: -120px;
  background: color-mix(in srgb, var(--te-accent-cyan) 15%, transparent);
  animation: tls-drift-b 14s ease-in-out infinite;
}

@keyframes tls-drift-a {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(38px, 24px);
  }
}

@keyframes tls-drift-b {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(-32px, -22px);
  }
}

/* ── Emblem: vinyl + halo + orbit + eq ─────────────────────────────── */

.tls-emblem {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 168px;
  height: 168px;
  animation: tls-rise 0.62s var(--te-ease-out-quint) 0.05s both;
}

.tls-halo {
  position: absolute;
  inset: 10px;
  border-radius: 999px;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--te-primary-500) 22%, transparent),
    transparent 68%
  );
  animation: tls-breathe 3.2s ease-in-out infinite;
}

@keyframes tls-breathe {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.7;
  }
  50% {
    transform: scale(1.14);
    opacity: 1;
  }
}

.tls-orbit {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  border: 1px dashed color-mix(in srgb, var(--tls-ink) 14%, transparent);
  animation: tls-spin 9s linear infinite;
}

.tls-orbit-dot {
  position: absolute;
  top: -4px;
  left: 50%;
  width: 9px;
  height: 9px;
  margin-left: -4.5px;
  border-radius: 999px;
  background: var(--te-primary-500);
  box-shadow: 0 0 14px color-mix(in srgb, var(--te-primary-500) 70%, transparent);
}

.tls-disc {
  position: relative;
  width: 122px;
  height: 122px;
  border-radius: 999px;
  overflow: hidden;
  background: repeating-radial-gradient(
    circle at 50% 50%,
    color-mix(in srgb, var(--tls-ink) 90%, transparent) 0 2.5px,
    color-mix(in srgb, var(--tls-ink) 76%, transparent) 2.5px 5px
  );
  box-shadow:
    0 18px 40px color-mix(in srgb, var(--te-neutral-900) 26%, transparent),
    0 0 0 1px color-mix(in srgb, var(--te-card-bg) 40%, transparent);
  animation: tls-spin 6.5s linear infinite;
}

.tls-disc-label {
  position: absolute;
  inset: 32px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  color: var(--te-card-bg);
  font-size: calc(var(--te-font-size-body, 14px) * 20 / 14);
  background: linear-gradient(
    135deg,
    var(--te-primary-500),
    color-mix(in srgb, var(--te-primary-500) 46%, var(--te-accent-cyan))
  );
  box-shadow: inset 0 0 0 3px color-mix(in srgb, var(--te-card-bg) 22%, transparent);
}

.tls-disc-sheen {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    color-mix(in srgb, var(--te-card-bg) 26%, transparent) 40deg,
    transparent 88deg,
    transparent 180deg,
    color-mix(in srgb, var(--te-card-bg) 14%, transparent) 216deg,
    transparent 260deg
  );
}

@keyframes tls-spin {
  to {
    transform: rotate(360deg);
  }
}

.tls-eq {
  position: absolute;
  bottom: -18px;
  display: inline-flex;
  align-items: flex-end;
  gap: 4px;
  height: 18px;
}

.tls-eq i {
  width: 4px;
  border-radius: 2px;
  background: linear-gradient(
    180deg,
    var(--te-primary-400),
    color-mix(in srgb, var(--te-primary-500) 66%, var(--te-accent-cyan))
  );
  transform-origin: bottom;
  animation: tls-eq-bounce 1s ease-in-out infinite;
}

.tls-eq i:nth-child(1) {
  height: 46%;
  animation-delay: 0s;
}

.tls-eq i:nth-child(2) {
  height: 90%;
  animation-delay: 0.16s;
}

.tls-eq i:nth-child(3) {
  height: 64%;
  animation-delay: 0.32s;
}

.tls-eq i:nth-child(4) {
  height: 100%;
  animation-delay: 0.48s;
}

.tls-eq i:nth-child(5) {
  height: 52%;
  animation-delay: 0.64s;
}

@keyframes tls-eq-bounce {
  0%,
  100% {
    transform: scaleY(0.42);
  }
  50% {
    transform: scaleY(1);
  }
}

/* ── Copy ──────────────────────────────────────────────────────────── */

.tls-kicker {
  position: relative;
  z-index: 1;
  margin-top: 42px;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 700;
  letter-spacing: 0.32em;
  color: var(--tls-ink-soft);
  animation: tls-rise 0.62s var(--te-ease-out-quint) 0.12s both;
}

.tls-title {
  position: relative;
  z-index: 1;
  margin: 12px 0 0;
  font-family: var(--te-font-display);
  font-size: clamp(24px, 2.8vw, 32px);
  font-weight: 900;
  letter-spacing: -0.01em;
  color: var(--tls-ink);
  animation: tls-rise 0.62s var(--te-ease-out-quint) 0.18s both;
}

.tls-hint {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  margin: 12px 0 0;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  font-weight: 500;
  color: var(--tls-ink-soft);
  animation: tls-rise 0.62s var(--te-ease-out-quint) 0.24s both;
}

.tls-dots {
  display: inline-flex;
  gap: 3px;
  margin-left: 2px;
}

.tls-dots i {
  width: 3.5px;
  height: 3.5px;
  border-radius: 999px;
  background: currentColor;
  animation: tls-dot-blink 1.3s ease-in-out infinite;
}

.tls-dots i:nth-child(2) {
  animation-delay: 0.18s;
}

.tls-dots i:nth-child(3) {
  animation-delay: 0.36s;
}

@keyframes tls-dot-blink {
  0%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }
  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

@keyframes tls-rise {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ── Indeterminate progress beam ───────────────────────────────────── */

.tls-progress {
  position: relative;
  z-index: 1;
  width: min(300px, 62%);
  height: 3px;
  margin-top: 30px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--tls-ink) 8%, transparent);
  animation: tls-rise 0.62s var(--te-ease-out-quint) 0.3s both;
}

.tls-progress-beam {
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--te-primary-500),
    color-mix(in srgb, var(--te-primary-500) 55%, var(--te-accent-cyan)),
    transparent
  );
  animation: tls-beam 1.6s var(--te-ease-out-quint) infinite;
}

@keyframes tls-beam {
  from {
    transform: translateX(-110%);
  }
  to {
    transform: translateX(380%);
  }
}

/* ── Ghost preview cards ───────────────────────────────────────────── */

.tls-ghost {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  width: min(520px, 86%);
  margin-top: 40px;
  animation: tls-rise 0.62s var(--te-ease-out-quint) 0.36s both;
}

.tls-ghost-card {
  position: relative;
  height: 64px;
  border-radius: 14px;
  overflow: hidden;
  background: color-mix(in srgb, var(--tls-ink) 6%, transparent);
}

.tls-ghost-card::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--te-card-bg) 60%, transparent),
    transparent
  );
  animation: tls-shimmer 1.5s ease-in-out infinite;
}

.tls-ghost-card:nth-child(2)::after {
  animation-delay: 0.2s;
}

.tls-ghost-card:nth-child(3)::after {
  animation-delay: 0.4s;
}

@keyframes tls-shimmer {
  to {
    transform: translateX(100%);
  }
}

/* ── Reduced motion ────────────────────────────────────────────────── */

@media (prefers-reduced-motion: reduce) {
  .tls-stage,
  .tls-emblem,
  .tls-halo,
  .tls-orbit,
  .tls-disc,
  .tls-eq i,
  .tls-kicker,
  .tls-title,
  .tls-hint,
  .tls-dots i,
  .tls-progress,
  .tls-progress-beam,
  .tls-ghost,
  .tls-ghost-card::after,
  .tls-orb-a,
  .tls-orb-b {
    animation: none;
  }

  .tls-progress-beam {
    width: 100%;
    opacity: 0.5;
    transform: none;
  }
}
</style>
