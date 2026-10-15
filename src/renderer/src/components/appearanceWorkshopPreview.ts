import type { WorkshopProject } from '../../../shared/themeWorkshop.ts'
import type { WorkshopDiagnostic } from '../../../shared/themeWorkshopDiagnostics.ts'
import type { WorkshopPreviewScene } from './theme-workshop/useWorkshopDiagnostics'

export interface AppearanceWorkshopPreviewModel {
  css: string
  project: WorkshopProject | undefined
  scene: WorkshopPreviewScene
  selectedLayer: string
  canvasEditing: boolean
  checking: boolean
}

export interface AppearanceWorkshopPreviewAdapter {
  inspect(): Promise<WorkshopDiagnostic[]>
  highlight(selector: string): void
}
