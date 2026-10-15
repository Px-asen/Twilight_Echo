import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  THEME_ICON_SLOTS,
  resolveThemeIconUrl,
  type ThemeLibrarySnapshot,
  type ThemeIconSlot,
  type ThemeProfileV2
} from '../../../shared/theme.ts'
import { isThemeLibrarySnapshotNewer } from '../utils/themeRuntimeRevision'

// Icons also run in satellite windows and isolated component previews. Keep
// their reactive input independent of the main settings/plugin runtime.
const profile = shallowRef<ThemeProfileV2 | null>(null)
const urls = computed(() =>
  Object.fromEntries(
    THEME_ICON_SLOTS.map((slot) => [slot, resolveThemeIconUrl(profile.value, slot)])
  )
)

export function setThemeIconProfile(value: ThemeProfileV2 | null): void {
  profile.value = value
}

export function resolveActiveThemeIconUrl(slot: ThemeIconSlot): string {
  return urls.value[slot] ?? ''
}

/** Subscribe without loading the main window's theme, settings or plugin runtime. */
export function observeMiniPlayerThemeIcons(): () => void {
  const api = window.api?.themes
  if (!api) return () => undefined
  let stopped = false
  let current: ThemeLibrarySnapshot | null = null
  const accept = (next: ThemeLibrarySnapshot) => {
    if (stopped || !isThemeLibrarySnapshotNewer(current, next)) return
    current = next
    const selection = next.data.activeTheme
    setThemeIconProfile(
      next.data.windowInheritance.miniPlayer && selection.kind === 'user'
        ? (next.data.profiles.find((candidate) => candidate.id === selection.id) ?? null)
        : null
    )
  }
  const unsubscribe = api.onChanged(accept)
  void api
    .list()
    .then(accept)
    .catch(() => undefined)
  return () => {
    stopped = true
    unsubscribe()
    setThemeIconProfile(null)
  }
}

export function useThemeIconImage(
  slot: MaybeRefOrGetter<ThemeIconSlot>,
  defaultOnly: MaybeRefOrGetter<boolean> = false
) {
  const imageUrl = computed(() =>
    toValue(defaultOnly) ? '' : resolveActiveThemeIconUrl(toValue(slot))
  )
  const loadedUrl = ref('')
  const failedUrl = ref('')
  watch(
    imageUrl,
    () => {
      loadedUrl.value = ''
      failedUrl.value = ''
    },
    { flush: 'sync' }
  )
  const currentImage = (event: Event) => {
    const element = event.target as HTMLImageElement | SVGImageElement
    return (element.getAttribute('src') || element.getAttribute('href')) === imageUrl.value
      ? element
      : null
  }
  return {
    imageUrl,
    customReady: computed(() => !!imageUrl.value && loadedUrl.value === imageUrl.value),
    failed: computed(() => !!imageUrl.value && failedUrl.value === imageUrl.value),
    imageLoaded(event: Event): void {
      const image = currentImage(event)
      if (!image) return
      if (image.tagName.toLowerCase() === 'img' && !(image as HTMLImageElement).naturalWidth)
        failedUrl.value = imageUrl.value
      else loadedUrl.value = imageUrl.value
    },
    imageFailed(event: Event): void {
      if (currentImage(event)) failedUrl.value = imageUrl.value
    }
  }
}
