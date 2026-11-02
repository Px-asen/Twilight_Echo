import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAvTransportSoap,
  buildRenderingControlSoap,
  formatUpnpTime,
  parseUpnpTime
} from './soap.ts'

test('buildAvTransportSoap wraps Play action', () => {
  const soap = buildAvTransportSoap('Play', { Speed: '1' })
  assert.match(soap.soapAction, /AVTransport:1#Play/)
  assert.match(soap.body, /<u:Play /)
  assert.match(soap.body, /<InstanceID>0<\/InstanceID>/)
  assert.match(soap.body, /<Speed>1<\/Speed>/)
})

test('buildAvTransportSoap escapes metadata XML entities', () => {
  const soap = buildAvTransportSoap('SetAVTransportURI', {
    CurrentURI: 'http://example/a&b',
    CurrentURIMetaData: '<x>"y"</x>'
  })
  assert.match(soap.body, /a&amp;b/)
  assert.match(soap.body, /&lt;x&gt;&quot;y&quot;&lt;\/x&gt;/)
})

test('buildRenderingControlSoap includes Master channel', () => {
  const soap = buildRenderingControlSoap('SetVolume', { DesiredVolume: 42 })
  assert.match(soap.soapAction, /RenderingControl:1#SetVolume/)
  assert.match(soap.body, /<Channel>Master<\/Channel>/)
  assert.match(soap.body, /<DesiredVolume>42<\/DesiredVolume>/)
})

test('formatUpnpTime / parseUpnpTime round-trip', () => {
  assert.equal(formatUpnpTime(0), '0:00:00')
  assert.equal(formatUpnpTime(65), '0:01:05')
  assert.equal(formatUpnpTime(3723), '1:02:03')
  assert.equal(formatUpnpTime(12.75), '0:00:12.75')
  assert.equal(formatUpnpTime(0.125), '0:00:00.125')
  assert.equal(formatUpnpTime(59.9999999), '0:01:00')
  assert.equal(parseUpnpTime('0:00:12.75'), 12.75)
  assert.equal(parseUpnpTime('1:02:03.125'), 3723.125)
  assert.ok(Math.abs(parseUpnpTime(formatUpnpTime(1 / 75))! - 1 / 75) < 0.000001)
  assert.equal(parseUpnpTime('0:01:05'), 65)
  assert.equal(parseUpnpTime('1:02:03'), 3723)
  assert.equal(parseUpnpTime('bad'), null)
  assert.equal(parseUpnpTime('0:60:00'), null)
})
