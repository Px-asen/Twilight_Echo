import type { CastDevice, CastLoadRequest, CastSample } from './castBackend.ts'
import {
  dlnaSetAvTransportUri,
  dlnaPlay,
  dlnaPause,
  dlnaStop,
  dlnaSeek,
  dlnaSetVolume,
  dlnaStatus
} from './dlnaClient.ts'
import {
  discoverChromecastDevices,
  chromecastLoad,
  chromecastPlay,
  chromecastPause,
  chromecastStop,
  chromecastSeek,
  chromecastSetVolume,
  chromecastStatus
} from './chromecastClient.ts'
import { buildDidlLiteMetadata } from './didl.ts'
import type { CoreCastSafetyTarget } from '../../shared/coreCast.ts'
import type { DlnaDeviceInfo } from '../../shared/remoteControl.ts'

export interface CoreCastBackend {
  discover(): Promise<CastDevice[]>
  load(device: CastDevice, request: CastLoadRequest, signal: AbortSignal): Promise<void>
  control(
    device: CastDevice,
    command: 'play' | 'pause' | 'stop' | 'seek' | 'volume',
    value?: number
  ): Promise<void>
  sample(device: CastDevice, signal: AbortSignal): Promise<CastSample>
}

/** Reuse both existing wire protocols. Only discovered endpoints reach here. */
export function createCastBackend(
  safety: {
    arm(target: CoreCastSafetyTarget): Promise<void>
    disarm(deviceId: string): Promise<void>
  },
  discoverDlnaDevices: () => Promise<DlnaDeviceInfo[]>
): CoreCastBackend {
  return {
    discover: async () => {
      const [dlna, chromecast] = await Promise.all([
        discoverDlnaDevices(),
        discoverChromecastDevices()
      ])
      return [
        ...dlna.map((device) => ({ ...device, id: device.usn, protocol: 'dlna' as const })),
        ...chromecast
      ].sort((a, b) => a.friendlyName.localeCompare(b.friendlyName, 'zh-CN'))
    },
    load: async (device, request, signal) => {
      if (device.protocol === 'chromecast') {
        return chromecastLoad(device, request, {
          signal,
          confirmed: true,
          receiverReady: (receiverSessionId) =>
            safety.arm({
              deviceId: device.id,
              protocol: 'chromecast',
              host: device.host!,
              port: device.port ?? 8009,
              receiverSessionId
            })
        })
      }
      if (!device.avTransportUrl) throw new Error('DLNA device missing AVTransport')
      await safety.arm({ deviceId: device.id, protocol: 'dlna', controlUrl: device.avTransportUrl })
      signal.throwIfAborted()
      await dlnaSetAvTransportUri(
        device.avTransportUrl,
        request.mediaUrl,
        buildDidlLiteMetadata({
          title: request.title ?? 'Twilight Echo',
          artist: request.artist,
          album: request.album,
          resUrl: request.mediaUrl,
          contentType: request.contentType
        }),
        signal
      )
      if (request.autoplay !== false) await dlnaPlay(device.avTransportUrl, signal)
      if ((request.positionSeconds ?? 0) > 0) {
        await dlnaSeek(device.avTransportUrl, request.positionSeconds!, signal)
      }
    },
    control: async (device, command, value) => {
      if (device.protocol === 'chromecast') {
        switch (command) {
          case 'play':
            return chromecastPlay(device)
          case 'pause':
            return chromecastPause(device)
          case 'stop':
            await chromecastStop(device, { confirmed: true })
            return safety.disarm(device.id)
          case 'seek':
            return chromecastSeek(device, value!)
          case 'volume':
            return chromecastSetVolume(device, value!)
        }
      }
      if (!device.avTransportUrl) throw new Error('DLNA device missing AVTransport')
      switch (command) {
        case 'play':
          return dlnaPlay(device.avTransportUrl)
        case 'pause':
          return dlnaPause(device.avTransportUrl)
        case 'stop':
          await dlnaStop(device.avTransportUrl)
          return safety.disarm(device.id)
        case 'seek':
          return dlnaSeek(device.avTransportUrl, value!)
        case 'volume':
          if (!device.renderingControlUrl) throw new Error('DLNA device missing RenderingControl')
          return dlnaSetVolume(device.renderingControlUrl, value!)
      }
    },
    sample: (device, signal) =>
      device.protocol === 'chromecast'
        ? chromecastStatus(device, signal)
        : dlnaStatus(device.avTransportUrl!, signal)
  }
}
