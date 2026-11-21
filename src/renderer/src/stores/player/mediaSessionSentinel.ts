/**
 * Chromium only publishes an MPRIS player on Linux for a MediaSession that is
 * backed by a live HTMLMediaElement: the bridge is created from the media
 * element's WebMediaPlayer, not from `navigator.mediaSession` alone. Twilight
 * Echo plays through the native ALSA engine on Linux, so the renderer never owns
 * a media element while audio is running, and the exported
 * `org.mpris.MediaPlayer2` name stays an empty stub: `CanPlay`, `CanPause`,
 * `CanGoNext` and `CanSeek` all read false and `Metadata` carries only
 * `mpris:length: 0`, so desktop media widgets and `playerctl` cannot reach the
 * player.
 *
 * Arming a silent sentinel element fixes that. Measured against Electron 43 on
 * Wayland, the MPRIS name appears once the element is playing with
 * `muted === false`; `muted === true` produces no player at all. Silence
 * therefore comes from `volume = 0` over a silent PCM source instead of muting.
 * The name also survives a later pause, so one long-lived element is enough: it
 * is armed once, stays silent, and never competes with the native engine for the
 * audio device.
 */

const SENTINEL_OBJECT_URL_TYPE = 'audio/wav'

/**
 * Builds a short silent mono 8-bit PCM WAV payload.
 *
 * 8-bit PCM encodes silence as 0x80 (unsigned midpoint), not 0x00, and the RIFF
 * and `data` chunk sizes must match the payload exactly or Chromium rejects the
 * source and publishes no player.
 */
export function silentWavBytes(milliseconds = 100, sampleRate = 8000): Uint8Array {
  const dataSize = Math.max(1, Math.round((sampleRate * milliseconds) / 1000))
  const buffer = new Uint8Array(44 + dataSize)
  const view = new DataView(buffer.buffer)
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++)
      buffer[offset + index] = text.charCodeAt(index)
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate, true) // byte rate = rate * channels * bytesPerSample
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)
  buffer.fill(0x80, 44)
  return buffer
}

/**
 * Builds the same silent PCM WAV as a `data:` URI. Kept for callers and tests
 * that need an inline source; the sentinel itself no longer uses it because the
 * production `media-src` CSP does not allow `data:` (it allows `blob:`).
 */
export function silentWavDataUri(milliseconds = 100, sampleRate = 8000): string {
  const buffer = silentWavBytes(milliseconds, sampleRate)
  let binary = ''
  for (let index = 0; index < buffer.length; index++) binary += String.fromCharCode(buffer[index]!)
  return `data:audio/wav;base64,${btoa(binary)}`
}

export interface MediaSessionSentinel {
  /** Arms the sentinel once; safe to call repeatedly. */
  arm(): void
  /** Releases the element and the MPRIS name it held. */
  dispose(): void
}

export interface MediaSessionSentinelOptions {
  /** Platform gate; only Linux needs the sentinel because the native engine owns audio. */
  required?: boolean
  createElement?: () => HTMLAudioElement
  /**
   * Overrides the sentinel source. Defaults to a `blob:` URL built from
   * `silentWavBytes`, because production `media-src` CSP includes `blob:` but
   * not `data:`.
   */
  buildSource?: () => string
  /** Wraps a Blob into an object URL; injectable so tests avoid a real Blob URL. */
  createObjectUrl?: (blob: Blob) => string
  /** Releases an object URL; injectable so tests can assert revocation. */
  revokeObjectUrl?: (url: string) => void
  onError?: (error: unknown) => void
}

export function createMediaSessionSentinel(
  options: MediaSessionSentinelOptions = {}
): MediaSessionSentinel {
  if (options.required === false) {
    return {
      arm() {
        // This platform does not need a sentinel.
      },
      dispose() {
        // The disabled sentinel owns no media element to release.
      }
    }
  }
  const createElement =
    options.createElement ??
    (() => {
      const audio = new Audio()
      audio.preload = 'auto'
      audio.loop = true
      return audio
    })
  const createObjectUrl = options.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revokeObjectUrl = options.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url))
  let objectUrl: string | null = null
  const defaultBuildSource = (): string => {
    // Reuse the same URL across arms so a failed first arm (for example a
    // blocked autoplay) cannot strand an extra object URL.
    if (!objectUrl)
      objectUrl = createObjectUrl(
        // The DOM lib types BlobPart against ArrayBuffer views, but a plain
        // Uint8Array is a valid part at runtime; cast like the cover loader does.
        new Blob([silentWavBytes() as unknown as BlobPart], { type: SENTINEL_OBJECT_URL_TYPE })
      )
    return objectUrl
  }
  const buildSource = options.buildSource ?? defaultBuildSource
  let element: HTMLAudioElement | null = null
  let playPendingOrSucceeded = false
  let disposed = false

  function report(error: unknown): void {
    options.onError?.(error)
  }

  function startPlay(audio: HTMLAudioElement): void {
    playPendingOrSucceeded = true
    try {
      void Promise.resolve(audio.play()).catch((error) => {
        if (element === audio && !disposed) playPendingOrSucceeded = false
        report(error)
      })
    } catch (error) {
      playPendingOrSucceeded = false
      report(error)
    }
  }

  function releaseObjectUrl(): void {
    if (!objectUrl) return
    const url = objectUrl
    objectUrl = null
    try {
      revokeObjectUrl(url)
    } catch (error) {
      report(error)
    }
  }

  return {
    arm(): void {
      if (disposed) return
      if (element) {
        if (!playPendingOrSucceeded) startPlay(element)
        return
      }
      let audio: HTMLAudioElement
      try {
        audio = createElement()
      } catch (error) {
        report(error)
        return
      }
      // `muted` must stay false: Chromium publishes no MPRIS player for a muted
      // element. Silence comes from volume instead, so nothing is audible.
      audio.muted = false
      audio.volume = 0
      audio.loop = true
      try {
        audio.src = buildSource()
      } catch (error) {
        report(error)
        return
      }
      element = audio
      // Autoplay can be blocked before the first gesture, so a rejection is
      // expected and must not surface as a playback error. The element stays
      // silent and unpublished until a later arm() succeeds.
      startPlay(audio)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      playPendingOrSucceeded = false
      const audio = element
      element = null
      try {
        if (audio) {
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
        }
      } catch (error) {
        report(error)
      }
      releaseObjectUrl()
    }
  }
}
