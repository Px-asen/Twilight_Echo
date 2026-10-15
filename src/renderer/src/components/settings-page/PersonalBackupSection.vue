<script setup lang="ts">
import { ref } from 'vue'
import {
  PERSONAL_DOMAIN_LABELS,
  type PersonalBackupPreview,
  type PersonalDomain,
  type PathMapping
} from '../../../../shared/personalBackup'
import { readPersonalRendererData } from '../../app/personalRestore'
import { useMusicStore } from '../../stores/useMusicStore'
import {
  useListeningStatsStore,
  waitForListeningStatsReady
} from '../../stores/useListeningStatsStore'
import { getMusicVersions } from '../../stores/musicVersions'
import { useFocusTrap, useEscapeToClose } from '../../app/useDismissLayer'

const api = window.api
const busy = ref(false),
  error = ref(''),
  message = ref(''),
  staged = ref(false)
const preview = ref<PersonalBackupPreview | null>(null)
const selected = ref<PersonalDomain[]>([])
const mappings = ref<PathMapping[]>([])
const conflict = ref<'keep-local' | 'use-backup'>('keep-local')
const root = ref<HTMLElement | null>(null)
useFocusTrap(root, () => !!preview.value)
useEscapeToClose(
  () => !!preview.value && !busy.value,
  () => {
    preview.value = null
  }
)
async function rendererData() {
  await waitForListeningStatsReady()
  const music = useMusicStore()
  await music.flushSaveLibrary()
  if (!(await music.flushPlaylists())) throw new Error('歌单尚未保存成功，请先重试保存')
  const { usePlayerStore } = await import('../../stores/usePlayerStore')
  await usePlayerStore().queueWorkspace.flush()
  return {
    ...readPersonalRendererData(),
    statistics: JSON.parse(JSON.stringify(useListeningStatsStore().listeningStats.value)),
    versions: getMusicVersions()
  }
}
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败，请重试'
  } finally {
    busy.value = false
  }
}
function exportBackup() {
  void run(async () => {
    if (await window.api.data.exportPersonalBackup(await rendererData()))
      message.value = '个人数据备份已导出'
  })
}
function importBackup() {
  void run(async () => {
    const value = await window.api.data.previewPersonalBackup(await rendererData())
    preview.value = value
    selected.value = value?.rows.map((r) => r.domain) || []
    mappings.value = value?.roots.map((from) => ({ from, to: '' })) || []
  })
}
async function chooseMapping(mapping: PathMapping) {
  await run(async () => {
    const path = await window.api.data.chooseRestoreFolder()
    if (path) mapping.to = path
  })
}
function restore() {
  void run(async () => {
    await window.api.data.stagePersonalRestore({
      conflict: conflict.value,
      mappings: mappings.value.filter((m) => m.to),
      domains: selected.value
    })
    preview.value = null
    staged.value = true
    message.value = '恢复已安排。请重启应用，启动时会先备份当前数据并执行恢复。'
  })
}
</script>
<template>
  <div data-setting-id="personal-backup" id="setting-personal-backup" class="personal-backup">
    <strong>个人数据备份与迁移</strong>
    <p>
      包含曲库索引、歌单收藏、队列、歌词编辑、书签、统计、版本关系、电台和播客。音频文件、账号登录和插件不随备份迁移；设置可通过上方单独导出。
    </p>
    <div class="buttons">
      <button type="button" class="soft-button" :disabled="busy || staged" @click="exportBackup">
        导出个人数据</button
      ><button type="button" class="soft-button" :disabled="busy || staged" @click="importBackup">
        选择备份并预览</button
      ><button
        v-if="staged"
        type="button"
        class="soft-button"
        :disabled="busy"
        @click="run(() => api.app.relaunch())"
      >
        现在重启恢复
      </button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error && !preview" role="alert">{{ error }}</p>
    <Teleport to="body"
      ><div v-if="preview" class="restore-overlay">
        <section
          ref="root"
          class="restore-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-title"
          tabindex="-1"
        >
          <h2 id="restore-title">恢复预览</h2>
          <p>
            备份时间：{{ new Date(preview.createdAt).toLocaleString() }} · 格式版本
            {{ preview.version }}
          </p>
          <p>
            只恢复勾选的项目；未冲突的记录会合并保留。同一歌单、队列会话、播客订阅按整条记录处理。当前播放队列和版本关系按完整文档处理。
          </p>
          <table>
            <thead>
              <tr>
                <th>恢复项目</th>
                <th>备份</th>
                <th>本机</th>
                <th>身份重叠</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in preview.rows" :key="row.domain">
                <td>
                  <label
                    ><input
                      v-model="selected"
                      type="checkbox"
                      :value="row.domain"
                      :disabled="busy"
                    />{{ PERSONAL_DOMAIN_LABELS[row.domain] }}</label
                  >
                </td>
                <td>{{ row.incoming }}</td>
                <td>{{ row.current }}</td>
                <td>{{ row.conflicts }}</td>
              </tr>
            </tbody>
          </table>
          <label class="conflict"
            >冲突处理
            <select v-model="conflict" :disabled="busy">
              <option value="keep-local">保留本机记录</option>
              <option value="use-backup">使用备份记录</option>
            </select></label
          >
          <p>
            统计按日期和曲目合并，不相加，避免重复计算。预览是当前快照；重启恢复时会按所选规则与最新保存记录合并。
          </p>
          <div v-if="mappings.length">
            <h3>音乐路径映射</h3>
            <p>
              更换电脑或盘符时，为每个原目录选择新位置。原目录尚未授权时也需要重新选择。这里只更新引用，不移动音频。
            </p>
            <div v-for="mapping in mappings" :key="mapping.from" class="mapping">
              <span>{{ mapping.from }}</span
              ><button type="button" :disabled="busy" @click="chooseMapping(mapping)">
                {{ mapping.to || '选择此目录在本机的位置' }}
              </button>
            </div>
          </div>
          <p v-if="error" role="alert">{{ error }}</p>
          <div class="buttons">
            <button type="button" :disabled="busy" @click="preview = null">取消</button
            ><button type="button" :disabled="busy || !selected.length" @click="restore">
              确认，在下次启动时恢复
            </button>
          </div>
        </section>
      </div></Teleport
    >
  </div>
</template>
<style scoped>
.personal-backup {
  padding: var(--te-setting-row-padding, 12px) 0;
}
.personal-backup > strong {
  color: var(--te-settings-text);
  font-size: var(--te-setting-label-size, var(--te-type-body));
  font-weight: var(--te-type-weight-medium);
}
.personal-backup > p {
  margin: 4px 0 12px;
  color: var(--te-settings-text-muted);
  font-size: var(--te-setting-description-size, var(--te-type-caption));
  line-height: var(--te-type-line-caption);
  opacity: 1;
}
p {
  font-size: var(--te-type-caption);
  line-height: 1.6;
  opacity: 0.8;
}
.buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
button,
select {
  font: inherit;
  padding: 6px 10px;
  cursor: pointer;
}
.restore-overlay {
  position: fixed;
  inset: 0;
  z-index: 2200;
  background: var(--te-dialog-backdrop);
  display: grid;
  place-items: center;
  padding: 24px;
}
.restore-dialog {
  width: min(740px, 100%);
  padding: 24px;
  max-height: 85dvh;
  overflow: auto;
  border-radius: 16px;
  color: var(--te-settings-text);
  background: var(--te-app-bg);
}
table {
  border-collapse: collapse;
  width: 100%;
  text-align: left;
  font-size: var(--te-type-caption);
}
td,
th {
  padding: 8px;
  border-bottom: 1px solid var(--te-card-border);
}
.conflict {
  display: block;
  margin-top: 16px;
}
.mapping {
  display: grid;
  gap: 8px;
  padding: 8px 0;
  overflow-wrap: anywhere;
}
button,
select {
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  padding: 7px 12px;
}
button:hover {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
</style>
