import type {
  Track,
  PlatformAlbumIdentity,
  PlatformMetadataResult,
  TwilightMediaProviderHealth,
  TwilightMediaProviderMethodHealth,
  TwilightMediaProviderRegistration,
  TwilightPluginExtensionContribution,
  TwilightStructuredThemeV2,
  TwilightStructuredThemeV3,
  TwilightThemeContribution,
  TwilightUiContribution,
  TwilightUiContributionKind,
  PluginExperience,
  PluginExperienceMessage
} from '../src/index'
import { TWILIGHT_PLUGIN_API_VERSION } from '../src/index'

const sidebarExperience: PluginExperience = {
  id: 'battery',
  name: 'Battery',
  entry: 'ui/index.html',
  bridgeVersion: 2,
  launch: 'sidebar',
  sidebar: { height: 128 }
}
const appearanceMessage: PluginExperienceMessage = {
  event: 'appearance',
  value: {
    theme: 'dark',
    colors: { text: '#fff', muted: '#aaa', accent: '#f8a', surface: '#222', border: '#444' },
    fontFamily: 'sans-serif',
    fontSize: '14px',
    reducedMotion: false
  }
}
void sidebarExperience
void appearanceMessage

const localSidebarKind: TwilightUiContributionKind = 'localSidebarItem'
const nativeMetadata: PlatformMetadataResult = {
  status: 'ok', metadata: { schemaVersion: 1, provider: 'example', kind: 'artist', id: '42', name: 'Artist',
    texts: [{ field: 'introduction', value: 'Biography', language: 'und', url: 'https://example.org/artist/42',
      revision: '', attribution: 'Example', license: '', licenseUrl: '',
      usage: { display: true, cache: true, crossSource: false, export: false } }] }
}
const metadataMethods: Pick<TwilightMediaProviderRegistration, 'fetchArtistMetadata' | 'fetchAlbumMetadata'> = {
  fetchArtistMetadata: async (_id, context) => { context?.signal?.throwIfAborted(); return nativeMetadata },
  fetchAlbumMetadata: async () => ({ status: 'not_provided' })
}
void metadataMethods
const streamingHomeKind: TwilightUiContributionKind = 'streamingHome'

const localSidebarContribution: TwilightUiContribution = {
  id: 'example.local',
  kind: localSidebarKind,
  title: 'Local Tool',
  command: 'example.local.open',
  renderMode: 'html',
  autoLoad: true
}

const streamingHomeContribution: TwilightUiContribution = {
  id: 'example.streaming',
  kind: streamingHomeKind,
  title: 'Streaming Tool',
  command: 'example.streaming.open'
}

const extensionContribution: TwilightPluginExtensionContribution = {
  pluginId: 'com.example.ui',
  ui: [localSidebarContribution, streamingHomeContribution],
  themes: []
}

const structuredThemeV2: TwilightStructuredThemeV2 = {
  schemaVersion: 2,
  variants: {
    dark: { tokens: { 'color.primary.500': '#60a5fa' } }
  },
  modes: {
    navigation: { style: 'rail' },
    player: { layout: 'split', controls: 'pro' },
    visibility: { playerWaveform: false }
  }
}

const themeContribution: TwilightThemeContribution = {
  id: 'mode-theme',
  name: 'Mode Theme',
  structured: structuredThemeV2
}

const structuredThemeV3: TwilightStructuredThemeV3 = {
  schemaVersion: 3,
  variants: {},
  layout: {
    desktop: {
      columns: ['standard', 'fill'],
      rows: ['auto', 'fill', 'auto'],
      areas: [
        ['titleBar', 'titleBar'],
        ['navigation', 'content'],
        ['navigation', 'playerBar']
      ]
    },
    navigation: 'persistent'
  }
}

const playbackUrlHealth: TwilightMediaProviderMethodHealth = {
  totalCalls: 10,
  successfulCalls: 8,
  failedCalls: 2,
  successRate: 0.8,
  lastError: 'HTTP 403',
  lastCheckedAt: '2026-07-02T00:00:00.000Z'
}

const providerHealth: TwilightMediaProviderHealth = {
  providerId: 'example',
  pluginId: 'com.example.provider',
  pluginStatus: 'enabled',
  available: true,
  totalCalls: 14,
  successfulCalls: 11,
  failedCalls: 3,
  successRate: 11 / 14,
  methodStats: {
    getPlaybackUrl: playbackUrlHealth
  },
  lastError: null,
  lastCheckedAt: '2026-07-02T00:00:00.000Z'
}

const providerRegistration: TwilightMediaProviderRegistration = {
  id: 'example',
  name: 'Example Provider',
  capabilities: ['search', 'playbackUrl'],
  health: providerHealth
}

const providerTrackWithBpm: Track = {
  id: 'example:1',
  title: 'Example Track',
  artist: 'Example Artist',
  album: 'Example Album',
  filePath: 'example:1',
  fileName: 'Example Artist - Example Track',
  duration: 180,
  size: 0,
  cover: null,
  lyrics: null,
  streamUrl: null,
  bpm: 128
}

void extensionContribution
void themeContribution
void structuredThemeV3
void TWILIGHT_PLUGIN_API_VERSION
void providerRegistration
void providerTrackWithBpm

const albumIdentity: PlatformAlbumIdentity = {
  schemaVersion: 1, provider: 'example', id: 'album-1', title: 'Album', artists: [{ name: 'Artist' }],
  trackCount: null, complete: false,
  tracks: [{ id: 'song-1', title: 'Song', artists: [{ name: 'Artist' }],
    durationSeconds: 180.25, disc: null, position: null, isrcs: [] }]
}
const identityProvider: TwilightMediaProviderRegistration = {
  id: 'example', name: 'Example', capabilities: ['playlist'],
  fetchAlbumIdentity: async () => albumIdentity
}
void identityProvider
