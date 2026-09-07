import type { ProviderHomeSectionPresentation } from '../../../../shared/providerHome'
import type { Track } from '@renderer/types/music'

export interface ProviderHomeSection extends ProviderHomeSectionPresentation {
  key: string
  title: string
  icon: string
  tracks: Track[]
  error?: string
}
