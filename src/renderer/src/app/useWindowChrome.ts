import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { WindowChromeState } from '../../../shared/windowChrome.ts'

export function useWindowChrome(preview: () => boolean) {
  const maximized = ref(false)
  const fullScreen = ref(false)
  const maximizeBehavior = ref<WindowChromeState['maximizeBehavior']>('maximize')
  const applyState = (state: WindowChromeState): void => {
    maximized.value = state.maximized
    fullScreen.value = state.fullScreen
    maximizeBehavior.value = state.maximizeBehavior
  }
  let active = false
  let receivedEvent = false
  let unsubscribe: (() => void) | undefined
  onMounted(() => {
    if (preview()) return
    active = true
    // Subscribe before reading. Native window events can race the initial reply.
    unsubscribe = window.api.window.onStateChanged?.((state) => {
      if (!active) return
      receivedEvent = true
      applyState(state)
    })
    void window.api.window
      .getState?.()
      .then((state) => {
        if (active && !receivedEvent) applyState(state)
      })
      .catch(() => {
        // A window being destroyed may reject the initial read. Future events
        // remain authoritative; never fabricate a toggled caption state.
      })
  })
  onBeforeUnmount(() => {
    active = false
    unsubscribe?.()
  })
  return { maximized, fullScreen, maximizeBehavior }
}
