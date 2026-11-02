export type AvTransportAction =
  | 'Play'
  | 'Pause'
  | 'Stop'
  | 'Seek'
  | 'SetAVTransportURI'
  | 'GetTransportInfo'
  | 'GetPositionInfo'

export type RenderingControlAction = 'SetVolume' | 'GetVolume' | 'SetMute'

export interface SoapEnvelopeOptions {
  serviceType: string
  action: string
  arguments?: Record<string, string | number | boolean>
}

export function buildSoapEnvelope(options: SoapEnvelopeOptions): string {
  const args = options.arguments ?? {}
  const bodyArgs = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(String(value))}</${key}>`)
    .join('')
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">',
    '<s:Body>',
    `<u:${options.action} xmlns:u="${options.serviceType}">`,
    bodyArgs,
    `</u:${options.action}>`,
    '</s:Body>',
    '</s:Envelope>'
  ].join('')
}

export function buildAvTransportSoap(
  action: AvTransportAction,
  args: Record<string, string | number | boolean> = {}
): { soapAction: string; body: string; serviceType: string } {
  const serviceType = 'urn:schemas-upnp-org:service:AVTransport:1'
  return {
    serviceType,
    soapAction: `"${serviceType}#${action}"`,
    body: buildSoapEnvelope({
      serviceType,
      action,
      arguments: { InstanceID: 0, ...args }
    })
  }
}

export function buildRenderingControlSoap(
  action: RenderingControlAction,
  args: Record<string, string | number | boolean> = {}
): { soapAction: string; body: string; serviceType: string } {
  const serviceType = 'urn:schemas-upnp-org:service:RenderingControl:1'
  return {
    serviceType,
    soapAction: `"${serviceType}#${action}"`,
    body: buildSoapEnvelope({
      serviceType,
      action,
      arguments: { InstanceID: 0, Channel: 'Master', ...args }
    })
  }
}

/** UPnP seek target: H+:MM:SS or H+:MM:SS.F */
export function formatUpnpTime(seconds: number): string {
  const micros = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1_000_000)
  const total = Math.floor(micros / 1_000_000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const fraction = String(micros % 1_000_000).padStart(6, '0').replace(/0+$/, '')
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${fraction ? `.${fraction}` : ''}`
}

export function parseUpnpTime(value: string): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  const s = Number(match[3])
  if (m >= 60 || s >= 60) return null
  return h * 3600 + m * 60 + s + (match[4] ? Number(`0.${match[4]}`) : 0)
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
