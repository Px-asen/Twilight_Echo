const track = (index, playlist = 0) => ({
  id: `memory:${playlist}:${index}`,
  title: `Fixture track ${index}`,
  artist: 'Memory Artist',
  album: 'Memory Album',
  duration: 180,
  source: 'memory',
  cover: null
})
const playlist = (index) => ({
  id: index,
  name: `Memory playlist ${index}`,
  cover: null,
  trackCount: 1000,
  creatorName: 'Benchmark'
})
export async function activate(context) {
  await context.twilight.providers.register({
    id: 'memory',
    name: 'Memory fixture',
    capabilities: ['search', 'playlist', 'library', 'playbackUrl'],
    ui: {
      icon: 'pi pi-database',
      authType: 'settings',
      unifiedLibrary: true,
      streamingLibraryTab: true,
      streamingSearch: true,
      streamingHome: { requiresLogin: false },
      streamingSections: [
        {
          id: 'fixture',
          title: 'Memory tracks',
          icon: 'pi pi-music',
          method: 'fetchRecommendSongs',
          requiresLogin: false
        }
      ]
    },
    checkLogin: async () => ({ loggedIn: true }),
    // This catalog participates in favorite lookups; audio is supplied by the local WAV.
    getPlaybackUrl: async () => null,
    fetchRecommendSongs: async () => Array.from({ length: 20 }, (_, i) => track(i)),
    fetchRecommendPlaylists: async () => Array.from({ length: 6 }, (_, i) => playlist(i)),
    fetchUserLibrary: async () => ({
      likedPlaylist: null,
      playlists: Array.from({ length: 6 }, (_, i) => playlist(i))
    }),
    searchSongs: async (_query, limit = 30, offset = 0) => ({
      items: Array.from({ length: Math.min(limit, 1000 - offset) }, (_, i) => track(offset + i)),
      total: 1000
    }),
    fetchPlaylistTracks: async (id) => Array.from({ length: 1000 }, (_, i) => track(i, id)),
    fetchPlaylistTracksPage: async (id, offset = 0, limit = 200) => ({
      tracks: Array.from({ length: Math.min(limit, 1000 - offset) }, (_, i) =>
        track(offset + i, id)
      ),
      total: 1000,
      nextOffset: Math.min(1000, offset + limit),
      hasMore: offset + limit < 1000
    })
  })
}
