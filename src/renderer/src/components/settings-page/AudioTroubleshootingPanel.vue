<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { audioRecoveryBusy, type AudioRecoveryKind, type AudioRecoveryState } from '../../../../shared/audioRecovery.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useLocale } from '../../app/useLocale.ts'

const emit = defineEmits<{ exportDiagnostics: [] }>()
const core = useCoreConnection()
const { t, errorText } = useLocale()
const state = ref<AudioRecoveryState | null>(null)
const starting = ref(false)
const error = ref('')
const busy = computed(() => starting.value || Boolean(state.value && audioRecoveryBusy(state.value)))
let mounted = false
let timer: ReturnType<typeof setTimeout> | undefined

watch(() => core.state.value?.audioRecovery, value => {
  if (!value) return
  state.value = value
  schedule()
})

function schedule(): void {
  clearTimeout(timer)
  if (mounted && state.value && audioRecoveryBusy(state.value))
    timer = setTimeout(() => void refresh(), 800)
}

async function refresh(): Promise<void> {
  try {
    const result = await core.query('audio.recovery', {})
    if (!mounted) return
    state.value = result
    error.value = ''
  } catch (caught) {
    if (!mounted) return
    error.value = errorText(caught, 'audioRecovery.unavailable')
  } finally {
    schedule()
  }
}

async function restart(kind: AudioRecoveryKind): Promise<void> {
  if (busy.value) return
  starting.value = true
  error.value = ''
  try {
    const result = await core.command('audio.recovery.start', { kind }) as AudioRecoveryState
    if (mounted) state.value = result
  } catch (caught) {
    if (mounted) error.value = errorText(caught, 'audioRecovery.failed')
  } finally {
    starting.value = false
    schedule()
  }
}

onMounted(() => {
  mounted = true
  void refresh()
})
onUnmounted(() => {
  mounted = false
  clearTimeout(timer)
})
</script>

<template>
  <section id="audio-troubleshooting" class="section-block audio-troubleshooting" :aria-label="t('audioRecovery.title')" :aria-busy="busy">
    <h3>{{ t('audioRecovery.title') }}</h3>
    <p class="recovery-intro">{{ t('audioRecovery.guide') }}</p>
    <div class="setting-list">
      <div id="setting-audio-restart" data-setting-id="audio-restart" class="setting-item recovery-row">
        <div class="setting-copy">
          <strong>{{ t('audioRecovery.engine.title') }}</strong>
          <span>{{ t('audioRecovery.engine.description') }}</span>
        </div>
        <button type="button" class="brand-soft-button" :disabled="busy || !state?.engineAvailable" @click="restart('engine')">
          <i class="pi" :class="busy && state?.kind === 'engine' ? 'pi-spinner pi-spin' : 'pi-refresh'" aria-hidden="true" />
          {{ t('audioRecovery.engine.action') }}
        </button>
      </div>
      <template v-if="state?.windowsServicesAvailable">
        <hr />
        <div id="setting-windows-audio-restart" data-setting-id="windows-audio-restart" class="setting-item recovery-row">
          <div class="setting-copy">
            <strong>{{ t('audioRecovery.windows.title') }}</strong>
            <span>{{ t('audioRecovery.windows.description') }}</span>
          </div>
          <button type="button" class="soft-button recovery-system-action" :disabled="busy || !state.engineAvailable" @click="restart('windows-services')">
            <i class="pi" :class="busy && state.kind === 'windows-services' ? 'pi-spinner pi-spin' : 'pi-shield'" aria-hidden="true" />
            {{ t('audioRecovery.windows.action') }}
          </button>
        </div>
      </template>
    </div>
    <p v-if="error || (state && state.phase !== 'idle') || !state" class="recovery-feedback" :data-error="Boolean(error || state?.phase === 'failed')" role="status" aria-live="polite">
      <span v-if="error">{{ error }}</span>
      <template v-else-if="state">
        <span>{{ t(`audioRecovery.phase.${state.phase}`) }}</span>
        <span v-if="state.phase === 'failed' && state.error">{{ state.error }}</span>
      </template>
      <span v-else>{{ t('audioRecovery.loading') }}</span>
      <button v-if="error" type="button" class="soft-button" @click="refresh">{{ t('audioRecovery.refresh') }}</button>
    </p>
    <p v-if="state && !state.engineAvailable && !error" class="recovery-feedback">{{ t('audioRecovery.unavailable') }}</p>
    <div class="recovery-footer">
      <span>{{ t('audioRecovery.diagnostics.description') }}</span>
      <button type="button" class="soft-button" :disabled="busy" @click="emit('exportDiagnostics')">
        <i class="pi pi-download" aria-hidden="true" />
        {{ t('audioRecovery.diagnostics.action') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.recovery-intro,
.recovery-feedback,
.recovery-footer {
  color: var(--te-settings-text-muted);
  font-size: var(--te-setting-description-size, 13px);
  line-height: 1.65;
}
.recovery-intro { margin: 0 0 12px; }
.recovery-row { gap: 20px; }
.recovery-row button { flex-shrink: 0; }
.recovery-system-action { color: var(--te-warning-text, var(--te-settings-text)); }
.recovery-feedback { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0 0; overflow-wrap: anywhere; }
.recovery-feedback[data-error='true'] { color: var(--te-danger-text, #c34545); }
.recovery-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 12px; }
@media (max-width: 680px) {
  .recovery-row, .recovery-footer { align-items: flex-start; flex-direction: column; gap: 12px; }
}
</style>
