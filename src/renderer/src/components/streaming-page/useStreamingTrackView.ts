import { computed, ref, watch, type Ref } from 'vue'
import type { Track } from '@renderer/types/music'
import {
  buildStreamingTrackView,
  indexStreamingTracks,
  type StreamingTrackSort,
  type StreamingSortDirection
} from '@renderer/components/streaming-page/streamingTrackView'

export function useStreamingTrackView(source: Ref<Track[]>, identity: () => unknown) {
  const query = ref('')
  const sort = ref<StreamingTrackSort>('default')
  const direction = ref<StreamingSortDirection>('asc')
  const index = computed(() => indexStreamingTracks(source.value))
  const tracks = computed(() =>
    buildStreamingTrackView(source.value, index.value, query.value, sort.value, direction.value)
  )
  watch(identity, () => {
    query.value = ''
    sort.value = 'default'
    direction.value = 'asc'
  })
  return { query, sort, direction, tracks }
}
