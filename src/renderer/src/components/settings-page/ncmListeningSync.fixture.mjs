import { createApp, h, nextTick, ref, reactive } from 'vue'
import NcmListeningSyncSetting from './NcmListeningSyncSetting.vue'
import '../../assets/base.css'
import './SettingsPage.css'
import './SettingsLayout.css'

const settings = ref({ ncmListeningSyncEnabled: true })
const status = reactive({
  enabled: true,
  available: true,
  pending: 0,
  lastSubmitted: null,
  error: null
})
const patches = []
let rejectSave = false
export function useSettingsStore() {
  return {
    settings,
    updateSettings: async (patch) => {
      if (rejectSave) throw new Error('设置保存失败，请重试')
      patches.push(patch)
      settings.value = { ...settings.value, ...patch }
      status.enabled = settings.value.ncmListeningSyncEnabled
      return settings.value
    }
  }
}
export function useCoreConnection() {
  return {
    query: async (name) => {
      if (name !== 'listeningSync.status') throw new Error(`Unexpected query: ${name}`)
      return status
    }
  }
}
createApp({
  render: () =>
    h('main', { class: 'settings-preview-page', 'data-settings-layout': 'categories' }, [
      h('section', { class: 'glass-card preview-section' }, [
        h('h2', '连接与控制'),
        h('div', { class: 'section-block' }, [
          h('h3', '听歌记录'),
          h('div', { class: 'setting-list' }, [h(NcmListeningSyncSetting)])
        ])
      ])
    ])
}).mount('#app')

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}
const check = (value, message) => {
  if (!value) throw new Error(message)
}
window.runListeningSyncUi = async () => {
  await settle()
  const button = document.querySelector('[role="switch"]')
  const text = () => document.querySelector('[role="status"]').textContent
  check(button.getAttribute('aria-checked') === 'true', 'sync must default on')
  check(!button.disabled, 'supported sync can be disabled')
  button.click()
  await settle()
  check(button.getAttribute('aria-checked') === 'false', 'saved disable choice is reflected')
  check(patches.length === 1 && patches[0].ncmListeningSyncEnabled === false, 'one settings writer')
  button.click()
  await settle()
  check(button.getAttribute('aria-checked') === 'true', 'switch reflects saved setting')
  check(patches.length === 2 && patches[1].ncmListeningSyncEnabled === true, 'sync can be re-enabled')
  status.pending = 1
  await settle()
  check(text().includes('正在提交'), 'pending state is visible')
  status.pending = 0
  status.error = 'PLV 成功但 PLD 失败'
  await settle()
  check(text().includes('PLD 失败'), 'partial upload must not display success')
  status.error = null
  status.lastSubmitted = {
    title: '暮光回响 · 一首在本地播放器实际收听并已提交至网易云的歌曲',
    seconds: 186,
    at: Date.now()
  }
  await settle()
  check(text().includes('已提交') && text().includes('186 秒'), 'successful submission receipt')
  rejectSave = true
  button.click()
  await settle()
  check(button.getAttribute('aria-checked') === 'true', 'failed saves cannot toggle optimistically')
  check(text().includes('保存失败'), 'save error is visible')
  rejectSave = false
  button.click()
  await settle()
  check(button.getAttribute('aria-checked') === 'false', 'sync can be disabled')
  button.click()
  await settle()
  check(button.getAttribute('aria-checked') === 'true', 'sync can be re-enabled')
  return 'NCM_LISTENING_UI_OK'
}
window.checkListeningSyncLayout = async () => {
  await settle()
  const row = document.querySelector('[data-setting-id="ncm-listening-sync"]')
  const label = row.querySelector('.setting-copy').getBoundingClientRect()
  const toggle = row.querySelector('button').getBoundingClientRect()
  check(row.scrollWidth <= row.clientWidth + 1, 'row overflows')
  check(label.right <= toggle.left + 1, 'copy overlaps switch')
}
