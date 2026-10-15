import { onBeforeUnmount, watch, type Ref } from 'vue'
import {
  resolveMotionMode,
  type MotionPreference,
  type ResolvedMotionMode
} from '../../../shared/motion.ts'

function getSystemMotionPreference(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-reduced-motion: reduce)')
}

export function resolveDocumentMotionMode(
  preference: MotionPreference,
  prefersReducedMotion: boolean
): ResolvedMotionMode {
  return resolveMotionMode(preference, prefersReducedMotion)
}

export function useMotionPreference(preference: Ref<MotionPreference>): void {
  const mediaQuery = getSystemMotionPreference()

  const apply = (): void => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.teMotion = resolveDocumentMotionMode(
      preference.value,
      mediaQuery?.matches === true
    )
  }

  const onChange = (): void => apply()
  const applyVisibility = (): void => {
    document.documentElement.dataset.teVisibility = document.hidden ? 'hidden' : 'visible'
  }
  mediaQuery?.addEventListener('change', onChange)
  watch(preference, apply, { immediate: true })
  if (typeof document !== 'undefined') {
    applyVisibility()
    document.addEventListener('visibilitychange', applyVisibility)
  }

  onBeforeUnmount(() => {
    mediaQuery?.removeEventListener('change', onChange)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', applyVisibility)
    }
  })
}
