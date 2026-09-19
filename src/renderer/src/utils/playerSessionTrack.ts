import type { Track } from '../types/music'
import { getTrackSource } from './playerTrackUtils.ts'

export function cloneTrackForPlaybackSession(track: Track): Track {
  // Shallow copy — strip lyrics/translatedLyrics/bpmAnalysis to avoid massive
  // memory usage when the entire queue is cloned for session persistence
  const source = getTrackSource(track)
  const cloned: Track = {
    id: track.id,
    queueEntryId: track.queueEntryId,
    title: track.title,
    artist: track.artist,
    artists: track.artists?.map((item) => ({ ...item })),
    album: track.album,
    filePath: track.filePath,
    fileName: track.fileName,
    dir: track.dir,
    subTrack: track.subTrack,
    cueRange: track.cueRange ? { ...track.cueRange } : undefined,
    cueSheetPath: track.cueSheetPath,
    cueEncoding: track.cueEncoding,
    duration: track.duration,
    size: track.size,
    cover: track.cover,
    coverSource: track.coverSource ?? null,
    lyrics: null,
    source: track.source,
    ncmSongId: track.ncmSongId,
    networkSource: track.networkSource,
    streamUrl: source === 'local' ? track.streamUrl : null,
    format: track.format,
    sampleRate: track.sampleRate,
    bitrate: track.bitrate,
    bitDepth: track.bitDepth,
    bpm: track.bpm,
    // bpmAnalysis 不进会话克隆：tempoMap 动辄数百段/轨，全队列克隆时代价过高，
    // 且队列与会话恢复界面从不消费它；播放时分析结果可按需重取。
    replayGainTrackGainDb: track.replayGainTrackGainDb,
    replayGainAlbumGainDb: track.replayGainAlbumGainDb,
    replayGainTrackPeak: track.replayGainTrackPeak,
    replayGainAlbumPeak: track.replayGainAlbumPeak,
    r128TrackGainDb: track.r128TrackGainDb,
    r128AlbumGainDb: track.r128AlbumGainDb
  }
  return cloned
}
