import { ref, shallowRef } from 'vue'
import type { AppearanceDraft } from '../../../shared/appAppearance.ts'
export type AppearanceEditorArea = 'background' | 'material' | 'advanced'
export const appearanceEditorOpen = ref(false)
export const appearanceFullWindowPreview = ref(false)
// A full-window chrome preview is an override, never a write to confirmed settings.
export const appearanceChromePreview = shallowRef<Pick<
  AppearanceDraft,
  'navigationPages' | 'playerBar' | 'appearanceLayers'
> | null>(null)
export const appearanceEditorArea = ref<AppearanceEditorArea>('background')
export function openAppearanceEditor(area: AppearanceEditorArea = 'background'): void {
  appearanceEditorArea.value = area
  appearanceEditorOpen.value = true
}
