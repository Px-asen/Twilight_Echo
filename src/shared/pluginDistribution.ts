export const OFFICIAL_PLUGIN_INDEX_URL = 'https://plugins.aaapi.fun/plugins.json'

export const LEGACY_GITHUB_PLUGIN_INDEX_URL =
  'https://raw.githubusercontent.com/Px-asen/Twilight-Echo-plugins/main/plugins.json'

export const DEFAULT_PLUGIN_INDEX_URL = OFFICIAL_PLUGIN_INDEX_URL

export function resolvePluginIndexUrl(value?: string): string {
  return value?.trim() || DEFAULT_PLUGIN_INDEX_URL
}
