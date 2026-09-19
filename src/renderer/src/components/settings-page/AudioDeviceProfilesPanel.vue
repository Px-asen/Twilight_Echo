<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type {
  AudioDeviceProfile,
  AudioDeviceProfilesSnapshot
} from '../../../../shared/audioDeviceProfiles.ts'
import { matchAudioDeviceProfile } from '../../../../shared/audioDeviceProfiles.ts'
import AudioDeviceProfileEditor from '@renderer/components/settings-page/AudioDeviceProfileEditor.vue'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'

defineProps<{ compact?: boolean }>()
const snapshot = shallowRef<AudioDeviceProfilesSnapshot | null>(null)
const draft = ref<AudioDeviceProfile | null>(null)
const busy = ref(false)
const error = ref('')
const feedback = ref('')
const deleteTarget = ref('')
const createButton = ref<HTMLButtonElement | null>(null)
const outputStore = useAudioOutputDspStore()
let readSequence = 0
let actionSequence = 0
let unsubscribe: (() => void) | undefined

async function refresh(): Promise<void> {
  const sequence = ++readSequence
  try {
    const state = await window.api.audioEngine.getDeviceProfiles()
    if (sequence === readSequence) snapshot.value = state
  } catch (reason) {
    if (sequence === readSequence) error.value = String(reason)
  }
}

onMounted(() => {
  unsubscribe = window.api.onDeviceProfilesChanged(() => void refresh())
  void refresh()
})
onUnmounted(() => {
  unsubscribe?.()
  readSequence += 1
  actionSequence += 1
})

function edit(profile?: AudioDeviceProfile, copy = false): void {
  if (!snapshot.value) return
  draft.value = structuredClone(profile ?? snapshot.value.current)
  if (!profile || copy) draft.value.id = crypto.randomUUID()
  if (copy) {
    draft.value.name += ' 副本'
    draft.value.autoApply = false
  }
  error.value = ''
  feedback.value = ''
}

async function closeEditor(): Promise<void> {
  draft.value = null
  await nextTick()
  createButton.value?.focus()
}

async function run(
  operation: () => Promise<AudioDeviceProfilesSnapshot>,
  message: string,
  close = false
): Promise<void> {
  const sequence = ++actionSequence
  busy.value = true
  error.value = ''
  feedback.value = ''
  try {
    const state = await operation()
    if (sequence !== actionSequence) return
    readSequence += 1
    snapshot.value = state
    feedback.value = message
    if (close) await closeEditor()
    await outputStore.refreshAudioOutputState()
  } catch (reason) {
    if (sequence === actionSequence)
      error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (sequence === actionSequence) busy.value = false
  }
}

function save(): void {
  if (!draft.value) return
  const profile = JSON.parse(JSON.stringify(draft.value)) as AudioDeviceProfile
  void run(
    () => window.api.audioEngine.saveDeviceProfile(profile),
    '档案已保存，选择应用后生效',
    true
  )
}

function apply(profile: AudioDeviceProfile): void {
  void run(() => window.api.audioEngine.applyDeviceProfile(profile.id), `已应用 ${profile.name}`)
}

function remove(profile: AudioDeviceProfile): void {
  void run(() => window.api.audioEngine.deleteDeviceProfile(profile.id), '档案已删除')
  deleteTarget.value = ''
}

function describe(profile: AudioDeviceProfile): string {
  const state = snapshot.value!
  const device = matchAudioDeviceProfile(profile, state.devices)[0]?.label ?? '未连接'
  const scene = profile.dspSceneId
    ? (state.scenes.find((scene) => scene.id === profile.dspSceneId)?.name ?? '场景已删除')
    : '按规则选择场景'
  return `${profile.backend.toUpperCase()} · ${device} · ${profile.exclusiveMode ? '独占' : '共享'} · ${profile.outputConfig.preferredBufferSize || '自动'} 帧 / ${profile.outputConfig.routingMode} · 音量上限 ${Math.round(profile.volumeCeiling * 100)}% · SRC ${profile.outputStage.targetSampleRate === 'device' ? '跟随设备' : profile.outputStage.targetSampleRate + ' Hz'} · DSD ${profile.processing.dsdOutputMode} · ${scene}`
}
</script>

<template>
  <details id="device-profiles" class="device-profiles" :open="!compact">
    <summary>
      设备档案
      <span v-if="snapshot?.activeProfileId"
        >·
        {{
          snapshot.profiles.find((profile) => profile.id === snapshot?.activeProfileId)?.name
        }}</span
      >
    </summary>
    <p class="intro">
      一次应用设备、输出策略、软件音量上限和 DSP 场景。<span v-if="snapshot"
        >当前软件音量上限 {{ Math.round(snapshot.volumeCeiling * 100) }}%。</span
      >
    </p>
    <p v-if="!snapshot && !error" role="status">正在读取设备档案…</p>
    <p v-if="error || snapshot?.error" class="error" role="alert">
      {{ error || snapshot?.error }} <button type="button" @click="refresh">刷新</button>
    </p>
    <p v-if="feedback || snapshot?.phase === 'applying'" role="status">
      {{ snapshot?.phase === 'applying' ? '正在静音切换并确认输出与 DSP…' : feedback }}
    </p>
    <template v-if="snapshot">
      <button ref="createButton" type="button" :disabled="busy || !!draft" @click="edit()">
        从当前配置创建
      </button>
      <p v-if="!snapshot.profiles.length && !draft" class="intro">
        还没有设备档案。连接设备后保存当前配置，即可快速切换。
      </p>
      <AudioDeviceProfileEditor
        v-if="draft"
        v-model="draft"
        :devices="snapshot.devices"
        :scenes="snapshot.scenes"
        :busy="busy"
        @save="save"
        @cancel="closeEditor"
      />
      <ul class="profiles-list">
        <li v-for="profile in snapshot.profiles" :key="profile.id">
          <div class="profile-name">
            <strong>{{ profile.name }}</strong
            ><span v-if="snapshot.activeProfileId === profile.id">已应用</span
            ><span v-else-if="profile.autoApply">自动应用</span>
          </div>
          <p>{{ describe(profile) }}</p>
          <p v-if="snapshot.unavailable[profile.id]" class="error">
            {{ snapshot.unavailable[profile.id] }}
          </p>
          <div class="actions">
            <button
              type="button"
              :disabled="!!snapshot.unavailable[profile.id] || !!draft"
              @click="apply(profile)"
            >
              应用
            </button>
            <button type="button" :disabled="busy || !!draft" @click="edit(profile)">编辑</button>
            <button type="button" :disabled="busy || !!draft" @click="edit(profile, true)">
              复制
            </button>
            <button type="button" :disabled="busy" @click="deleteTarget = profile.id">删除</button>
          </div>
          <div
            v-if="deleteTarget === profile.id"
            class="actions"
            role="group"
            aria-label="确认删除档案"
          >
            <span>删除“{{ profile.name }}”？当前输出配置将保留。</span>
            <button type="button" :disabled="busy" @click="remove(profile)">确认删除</button>
            <button type="button" @click="deleteTarget = ''">取消</button>
          </div>
        </li>
      </ul>
    </template>
  </details>
</template>

<style scoped>
.device-profiles {
  border: 1px solid var(--border-color, #8884);
  border-radius: 12px;
  padding: 16px;
  color: var(--text-primary);
}
summary {
  cursor: pointer;
  font-weight: 600;
}
summary span {
  font-size: 12px;
  font-weight: 400;
}
.intro,
li p {
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.75;
  overflow-wrap: anywhere;
}
.profiles-list {
  list-style: none;
  padding: 0;
  margin: 12px 0 0;
  max-height: 420px;
  overflow: auto;
}
li {
  padding: 12px 0;
  border-top: 1px solid var(--border-color, #8883);
}
.profile-name,
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.profile-name span {
  color: var(--accent-color);
  font-size: 11px;
}
.actions {
  margin-top: 8px;
  font-size: 12px;
}
button {
  cursor: pointer;
  font: inherit;
  color: inherit;
  border: 1px solid var(--border-color, #8884);
  border-radius: 8px;
  background: var(--bg-secondary, #8881);
  padding: 7px 10px;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
:is(button, summary):focus-visible {
  outline: 2px solid var(--accent-color, #7c4dff);
  outline-offset: 3px;
}
.error {
  color: var(--color-danger, #cd5959);
  font-size: 12px;
  line-height: 1.6;
}
</style>