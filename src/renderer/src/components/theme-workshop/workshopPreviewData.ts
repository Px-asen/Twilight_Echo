import type { Track } from '@renderer/types/music'
import type { ProviderHomeSection } from '@renderer/components/streaming-page/providerHomeTypes'

export const workshopPreviewTracks: Track[] = Array.from({ length: 48 }, (_, index) => ({
  id: `workshop-preview:${index}`,
  title: ['夜空中的旋律', '初夏的风', 'Twilight Echo', '遥远的星光'][index % 4],
  artist: ['示例歌手', 'Hatsune Miku'][index % 2],
  album: ['青色回忆', '星海'][index % 2],
  duration: 180 + index * 3,
  filePath: '',
  fileName: '',
  size: 0,
  cover: null,
  lyrics: null,
  format: 'FLAC',
  sampleRate: 44100,
  bitDepth: 16
}))

export const workshopPreviewSections: ProviderHomeSection[] = [
  {
    key: 'daily',
    title: '每日推荐',
    icon: 'ph ph-music-notes',
    tracks: workshopPreviewTracks.slice(0, 6)
  }
]
