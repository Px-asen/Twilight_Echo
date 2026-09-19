import { useMusicStore } from '@renderer/stores/useMusicStore.ts'
import { useRadioStore, radioStationToTrack } from '@renderer/stores/useRadioStore.ts'
import { usePodcastStore, podcastEpisodeToTrack } from '@renderer/stores/usePodcastStore.ts'
import { syncPluginProviders, useMediaProviders } from '@renderer/providers/index.ts'
import type { Track } from '@renderer/types/music'
import type { SavedQueueTrack } from '../../../../shared/queueWorkspace.ts'
import type { QueueSessionRestoreSources } from '@renderer/stores/player/queueSessionRestore.ts'

export async function getQueueSessionSources(
  entries: SavedQueueTrack[]
): Promise<Omit<QueueSessionRestoreSources, 'isCurrent'>> {
  const sources = new Set(entries.map((entry) => entry.source))
  const radio = useRadioStore()
  const podcasts = usePodcastStore()
  const hasProviders = [...sources].some(
    (source) => !['local', 'radio', 'podcast', 'network'].includes(source)
  )
  const [, , , profiles] = await Promise.all([
    sources.has('radio') ? radio.ensureLoaded() : undefined,
    sources.has('podcast') ? podcasts.ensureLoaded() : undefined,
    hasProviders ? syncPluginProviders() : undefined,
    sources.has('network') ? window.api.networkSources.listProfiles() : []
  ])
  if (sources.has('radio') && radio.error.value) throw new Error(radio.error.value)
  if (sources.has('podcast') && podcasts.error.value) throw new Error(podcasts.error.value)
  const savedStreams = new Map<string, Track>()
  if (sources.has('radio'))
    for (const station of radio.stations.value) {
      savedStreams.set(`radio:${station.id}`, radioStationToTrack(station))
    }
  if (sources.has('podcast'))
    for (const subscription of podcasts.subscriptions.value) {
      for (const episode of subscription.episodes) {
        const track = podcastEpisodeToTrack(subscription, episode)
        savedStreams.set(`podcast:${track.id}`, track)
      }
    }
  const localTracks = new Map<string, Track>()
  const library = useMusicStore()
  for (const entry of entries) {
    if (entry.source !== 'local') continue
    const track = library.getTrackById(entry.id)
    if (track) localTracks.set(track.id, track)
  }
  const availableProviders = new Set<string>()
  if (hasProviders)
    for (const source of sources) {
      const provider = useMediaProviders().get(source)
      if (
        provider?.getPlaybackUrl &&
        provider.health?.available !== false &&
        (!provider.isEnabled || (await provider.isEnabled()))
      )
        availableProviders.add(source)
    }
  return {
    localTracks,
    savedStreams,
    availableProviders,
    networkProfiles: new Set(profiles.map((profile) => profile.id)),
    authorizeFiles: (paths) => window.api.fs.areAudioFilesAuthorized(paths)
  }
}
