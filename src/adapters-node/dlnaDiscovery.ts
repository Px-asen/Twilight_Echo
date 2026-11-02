import { Buffer } from 'node:buffer'
import { createSocket, type Socket } from 'node:dgram'
import { extractControlUrlsFromDeviceDescription, buildSsdpMSearch, parseSsdpResponse, resolveUpnpUrl, SSDP_MULTICAST_ADDRESS, SSDP_PORT } from '../core/cast/ssdp.ts'
import type { DlnaDeviceInfo } from '../shared/remoteControl.ts'

export type DlnaSocketFactory = (type: 'udp4' | 'udp6' | any, callback?: any) => any

export interface DlnaDiscoveryOptions {
  timeoutMs?: number
  fetchText?: (url: string) => Promise<string>
  createSocket?: DlnaSocketFactory
}

export async function discoverDlnaDevices(
  options: DlnaDiscoveryOptions = {}
): Promise<DlnaDeviceInfo[]> {
  const timeoutMs = options.timeoutMs ?? 2500
  const fetchText =
    options.fetchText ??
    (async (url: string) => {
      const response = await fetch(url, {
        headers: { 'user-agent': 'TwilightEcho/1.0 DLNA' },
        signal: AbortSignal.timeout(4000)
      })
      if (!response.ok) throw new Error(`device description HTTP ${response.status}`)
      return await response.text()
    })
  const socketFactory = options.createSocket ?? createSocket

  const responses = await collectSsdpResponses(socketFactory, timeoutMs)
  const byUsn = new Map<string, DlnaDeviceInfo>()

  for (const response of responses) {
    if (response.statusCode !== 200) continue
    try {
      const xml = await fetchText(response.location)
      const meta = extractControlUrlsFromDeviceDescription(xml)
      const avTransportUrl = resolveUpnpUrl(response.location, meta.avTransportUrl)
      const renderingControlUrl = resolveUpnpUrl(response.location, meta.renderingControlUrl)
      byUsn.set(response.usn, {
        usn: response.usn,
        friendlyName: meta.friendlyName,
        location: response.location,
        manufacturer: meta.manufacturer,
        modelName: meta.modelName,
        avTransportUrl,
        renderingControlUrl,
        lastSeenAt: Date.now()
      })
    } catch {
      // Skip devices that refuse description fetch.
    }
  }

  return Array.from(byUsn.values()).sort((a, b) =>
    a.friendlyName.localeCompare(b.friendlyName, 'zh-CN')
  )
}

function collectSsdpResponses(
  socketFactory: DlnaSocketFactory,
  timeoutMs: number
): Promise<NonNullable<ReturnType<typeof parseSsdpResponse>>[]> {
  return new Promise((resolve) => {
    const found: NonNullable<ReturnType<typeof parseSsdpResponse>>[] = []
    let socket: Socket
    try {
      socket = socketFactory('udp4')
    } catch {
      resolve([])
      return
    }

    const finish = (): void => {
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(found)
    }

    const timer = setTimeout(finish, timeoutMs)

    socket.on('message', (msg: Uint8Array) => {
      const parsed = parseSsdpResponse(Buffer.from(msg).toString('utf8'))
      if (parsed) found.push(parsed)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true)
      } catch {
        // optional
      }
      const payload = Buffer.from(buildSsdpMSearch(), 'utf8')
      socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS)
      // Second burst improves discovery on flaky networks.
      setTimeout(() => {
        try {
          socket.send(payload, 0, payload.length, SSDP_PORT, SSDP_MULTICAST_ADDRESS)
        } catch {
          // ignore
        }
      }, 200)
    })
  })
}

