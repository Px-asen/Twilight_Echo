import {
  buildAvTransportSoap,
  buildRenderingControlSoap,
  formatUpnpTime,
  parseUpnpTime
} from '../../shared/soap.ts'
import type { CastSample } from './castBackend.ts'

export async function dlnaSetAvTransportUri(
  controlUrl: string,
  mediaUrl: string,
  metadataXml = '',
  signal?: AbortSignal
): Promise<void> {
  const soap = buildAvTransportSoap('SetAVTransportURI', {
    CurrentURI: mediaUrl,
    CurrentURIMetaData: metadataXml
  })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaPlay(controlUrl: string, signal?: AbortSignal): Promise<void> {
  const soap = buildAvTransportSoap('Play', { Speed: '1' })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaPause(controlUrl: string, signal?: AbortSignal): Promise<void> {
  const soap = buildAvTransportSoap('Pause')
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaStop(controlUrl: string, signal?: AbortSignal): Promise<void> {
  const soap = buildAvTransportSoap('Stop')
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaSeek(
  controlUrl: string,
  positionSeconds: number,
  signal?: AbortSignal
): Promise<void> {
  const soap = buildAvTransportSoap('Seek', {
    Unit: 'REL_TIME',
    Target: formatUpnpTime(positionSeconds)
  })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

export async function dlnaSetVolume(
  controlUrl: string,
  volume0to1: number,
  signal?: AbortSignal
): Promise<void> {
  const desired = Math.round(Math.min(1, Math.max(0, volume0to1)) * 100)
  const soap = buildRenderingControlSoap('SetVolume', { DesiredVolume: desired })
  await postSoap(controlUrl, soap.soapAction, soap.body, signal)
}

async function postSoap(
  controlUrl: string,
  soapAction: string,
  body: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      soapaction: soapAction,
      'user-agent': 'TwilightEcho/1.0 DLNA'
    },
    body,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`DLNA SOAP failed (${response.status}): ${text.slice(0, 200)}`)
  }
  return response.text()
}

/** Read the actual renderer clock, not an interpolated frontend progress value. */
export async function dlnaStatus(controlUrl: string, signal?: AbortSignal): Promise<CastSample> {
  const read = async (action: 'GetTransportInfo' | 'GetPositionInfo') => {
    const soap = buildAvTransportSoap(action)
    return postSoap(controlUrl, soap.soapAction, soap.body, signal)
  }
  const [transport, position] = await Promise.all([
    read('GetTransportInfo'),
    read('GetPositionInfo')
  ])
  const field = (xml: string, name: string) =>
    new RegExp(`<(?:(?:[\\w-]+):)?${name}(?:\\s[^>]*)?>([^<]*)</`).exec(xml)?.[1] ?? ''
  const state = field(transport, 'CurrentTransportState')
  return {
    state: state === 'PLAYING' ? 'playing' : state === 'PAUSED_PLAYBACK' ? 'paused' : 'stopped',
    buffering: state === 'TRANSITIONING',
    position: parseUpnpTime(field(position, 'RelTime')) ?? 0,
    duration: parseUpnpTime(field(position, 'TrackDuration')) ?? 0,
    ended: state === 'STOPPED'
  }
}
