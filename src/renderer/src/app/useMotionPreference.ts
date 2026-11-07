import { onBeforeUnmount, watch, type Ref } from 'vue'
import { observeMotionPolicy } from './motion/policy.ts'
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
  const stopInput =
    typeof document === 'undefined' ? () => {} : observeMotionPolicy(document, () => {})
  const mediaQuery = getSystemMotionPreference()

  const apply = (): void => {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.teMotion = resolveDocumentMotionMode(
      preference.value,
      mediaQuery?.matches === true
    )
  }

  const onChange = (): void => apply()
  mediaQuery?.addEventListener('change', onChange)
  watch(preference, apply, { immediate: true })

  onBeforeUnmount(() => {
    stopInput()
    mediaQuery?.removeEventListener('change', onChange)
  })
}
