export interface ProviderHomePresentation {
  requiresLogin?: boolean
  subtitle?: string
}

export interface ProviderDiscoveryPresentation {
  supportsSort?: boolean
}

export interface ProviderHomeSectionPresentation {
  requiresLogin?: boolean
  eyebrow?: string
  description?: string
}

export interface ProviderStreamingSection extends ProviderHomeSectionPresentation {
  id: string
  title: string
  icon: string
  method: string
  args?: unknown[]
}
