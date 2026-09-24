import { ref } from 'vue'
import type { UiContribution } from '../../extensions/registry'
import type { PluginSettingsForm } from './types'
import {
  missingRequiredPluginSettingsField,
  normalizePluginSettingsForm,
  pluginSettingsFormValues
} from './pluginSettingsForm.ts'

type ExecuteCommand = (command: string, args: unknown[]) => Promise<unknown>

const LIVE_SUBMIT_DELAY_MS = 250
const AUTO_LOAD_RETRY_MS = 50

const defaultExecute: ExecuteCommand = (command, args) =>
  window.api.extensions.executeCommand(command, args)

/**
 * State and actions for plugin `settingsPanel` contributions. Every panel is
 * keyed by `pluginId:panelId` so results, errors and drafts never leak between
 * plugins. Live forms submit on change without blocking the other panels.
 */
export function usePluginSettingsPanels(execute: ExecuteCommand = defaultExecute) {
  const runningPluginSettingsCommand = ref('')
  const pluginSettingsResult = ref<Record<string, string>>({})
  const pluginSettingsError = ref<Record<string, string>>({})
  const pluginSettingsForms = ref<Record<string, PluginSettingsForm | null>>({})
  const pluginSettingsValues = ref<Record<string, Record<string, string>>>({})

  const liveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const liveInFlight = new Set<string>()
  const liveDirty = new Set<string>()
  const draftRevisions = new Map<string, number>()
  const autoLoadedPanels = new Set<string>()

  function pluginPanelStateKey(panel: UiContribution): string {
    return `${panel.pluginId}:${panel.id}`
  }

  function setFeedback(stateKey: string, result: string, error = ''): void {
    pluginSettingsResult.value = { ...pluginSettingsResult.value, [stateKey]: result }
    pluginSettingsError.value = { ...pluginSettingsError.value, [stateKey]: error }
  }

  function setError(stateKey: string, err: unknown): void {
    setFeedback(stateKey, '', err instanceof Error ? err.message : String(err))
  }

  function setValues(stateKey: string, values: Record<string, string>): void {
    pluginSettingsValues.value = { ...pluginSettingsValues.value, [stateKey]: values }
  }

  function applyForm(stateKey: string, form: PluginSettingsForm | null): void {
    pluginSettingsForms.value = { ...pluginSettingsForms.value, [stateKey]: form }
    if (form) setValues(stateKey, pluginSettingsFormValues(form))
  }

  function submitResultMessage(result: unknown): string {
    if (typeof result === 'string') return result
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
    return typeof record?.message === 'string' ? record.message.slice(0, 500) : '设置已保存'
  }

  function refreshedForm(result: unknown): PluginSettingsForm | null {
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : null
    return normalizePluginSettingsForm(record?.form)
  }

  function cancelLiveSubmit(stateKey: string): void {
    const timer = liveTimers.get(stateKey)
    if (timer !== undefined) clearTimeout(timer)
    liveTimers.delete(stateKey)
  }

  async function runPluginSettingsPanel(panel: UiContribution): Promise<void> {
    const stateKey = pluginPanelStateKey(panel)
    if (!panel.command || runningPluginSettingsCommand.value) return
    cancelLiveSubmit(stateKey)
    runningPluginSettingsCommand.value = stateKey
    setFeedback(stateKey, '')
    try {
      const result = await execute(panel.command, [{ source: 'settingsPanel', panelId: panel.id }])
      const form = normalizePluginSettingsForm(result)
      applyForm(stateKey, form)
      if (!form) {
        setFeedback(
          stateKey,
          result == null ? '已执行' : typeof result === 'string' ? result : JSON.stringify(result)
        )
      }
    } catch (err) {
      setError(stateKey, err)
    } finally {
      runningPluginSettingsCommand.value = ''
    }
  }

  function setPluginSettingsField(panel: UiContribution, key: string, value: string): void {
    const stateKey = pluginPanelStateKey(panel)
    setValues(stateKey, {
      ...(pluginSettingsValues.value[stateKey] ?? {}),
      [key]: value.slice(0, 4096)
    })
    draftRevisions.set(stateKey, (draftRevisions.get(stateKey) ?? 0) + 1)
    if (!pluginSettingsForms.value[stateKey]?.live) return
    cancelLiveSubmit(stateKey)
    liveTimers.set(
      stateKey,
      setTimeout(() => {
        liveTimers.delete(stateKey)
        void flushLiveSubmit(stateKey)
      }, LIVE_SUBMIT_DELAY_MS)
    )
  }

  async function flushLiveSubmit(stateKey: string): Promise<void> {
    const form = pluginSettingsForms.value[stateKey]
    if (!form?.live) return
    if (liveInFlight.has(stateKey)) {
      // Coalesce edits made while a submit is in flight into one follow-up.
      liveDirty.add(stateKey)
      return
    }
    const values = pluginSettingsValues.value[stateKey] ?? {}
    const missingField = missingRequiredPluginSettingsField(form, values)
    if (missingField) {
      setFeedback(stateKey, '', `请填写${missingField.label}`)
      return
    }
    const revision = draftRevisions.get(stateKey) ?? 0
    liveInFlight.add(stateKey)
    try {
      const result = await execute(form.submitCommand, [{ ...values }])
      // Only adopt the plugin's canonical values if the user has not kept
      // editing; otherwise a slow round-trip would snap sliders backwards.
      const nextForm = refreshedForm(result)
      if (nextForm && draftRevisions.get(stateKey) === revision) applyForm(stateKey, nextForm)
      setFeedback(stateKey, submitResultMessage(result))
    } catch (err) {
      setError(stateKey, err)
    } finally {
      liveInFlight.delete(stateKey)
      if (liveDirty.delete(stateKey)) void flushLiveSubmit(stateKey)
    }
  }

  async function submitPluginSettingsForm(panel: UiContribution): Promise<void> {
    const stateKey = pluginPanelStateKey(panel)
    const form = pluginSettingsForms.value[stateKey]
    if (!form || runningPluginSettingsCommand.value) return
    const values = pluginSettingsValues.value[stateKey] ?? {}
    const missingField = missingRequiredPluginSettingsField(form, values)
    if (missingField) {
      setFeedback(stateKey, '', `请填写${missingField.label}`)
      return
    }
    runningPluginSettingsCommand.value = stateKey
    setFeedback(stateKey, '')
    try {
      const result = await execute(form.submitCommand, [{ ...values }])
      const nextForm = refreshedForm(result)
      if (nextForm) {
        applyForm(stateKey, nextForm)
      } else {
        setValues(
          stateKey,
          Object.fromEntries(
            form.fields.map((field) => [
              field.key,
              field.type === 'password' ? '' : (values[field.key] ?? '')
            ])
          )
        )
      }
      setFeedback(stateKey, submitResultMessage(result))
    } catch (err) {
      setError(stateKey, err)
    } finally {
      runningPluginSettingsCommand.value = ''
    }
  }

  async function resetPluginSettingsForm(panel: UiContribution): Promise<void> {
    const stateKey = pluginPanelStateKey(panel)
    const form = pluginSettingsForms.value[stateKey]
    if (!form?.resetCommand || runningPluginSettingsCommand.value) return
    cancelLiveSubmit(stateKey)
    liveDirty.delete(stateKey)
    runningPluginSettingsCommand.value = stateKey
    setFeedback(stateKey, '')
    try {
      const result = await execute(form.resetCommand, [])
      const nextForm = refreshedForm(result)
      if (nextForm) {
        draftRevisions.set(stateKey, (draftRevisions.get(stateKey) ?? 0) + 1)
        applyForm(stateKey, nextForm)
      }
      setFeedback(stateKey, submitResultMessage(result))
    } catch (err) {
      setError(stateKey, err)
    } finally {
      runningPluginSettingsCommand.value = ''
    }
  }

  /** Flush pending live edits instead of dropping them when the page closes. */
  function disposePluginSettingsPanels(): void {
    for (const stateKey of [...liveTimers.keys()]) {
      cancelLiveSubmit(stateKey)
      void flushLiveSubmit(stateKey)
    }
  }

  /**
   * Open every `autoLoad` panel once per page visit. Panels load one after
   * another because settings commands are mutually exclusive.
   */
  async function autoLoadPluginSettingsPanels(panels: readonly UiContribution[]): Promise<void> {
    for (const panel of panels) {
      const stateKey = pluginPanelStateKey(panel)
      if (!panel.autoLoad || !panel.command || autoLoadedPanels.has(stateKey)) continue
      autoLoadedPanels.add(stateKey)
      while (runningPluginSettingsCommand.value) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_LOAD_RETRY_MS))
      }
      await runPluginSettingsPanel(panel)
    }
  }

  return {
    runningPluginSettingsCommand,
    pluginSettingsResult,
    pluginSettingsError,
    pluginSettingsForms,
    pluginSettingsValues,
    pluginPanelStateKey,
    runPluginSettingsPanel,
    setPluginSettingsField,
    submitPluginSettingsForm,
    resetPluginSettingsForm,
    autoLoadPluginSettingsPanels,
    disposePluginSettingsPanels
  }
}
