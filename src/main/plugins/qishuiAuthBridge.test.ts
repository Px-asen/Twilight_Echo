import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { QishuiAuthBridge, type QishuiAuthModule } from './qishuiAuthBridge.ts'

test('loads the host-owned Qishui security module and returns only login DTOs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-qishui-auth-'))
  await writeFile(join(root, 'qishui-auth-v6.cjs'), '')
  let hooks: Parameters<QishuiAuthModule['configure']>[0] | null = null
  let configureCount = 0
  let clearCount = 0
  const module: QishuiAuthModule = {
    configure(nextHooks) {
      hooks = nextHooks
      configureCount += 1
    },
    async getQrCode() {
      hooks?.updateConfig({ msToken: 'not-returned-to-plugin' })
      return {
        message: 'success',
        data: {
          token: 'secure-token',
          qrcode: 'data:image/png;base64,SECURE',
          scan_url: 'https://bff-pc.qishui.com/light/invoke/scan_login?token=secure-token',
          expire_time: 120
        }
      }
    },
    async checkQrConnect(token) {
      assert.equal(token, 'secure-token')
      hooks?.updateConfig({ cookie: 'sessionid=secure-session' })
      return { message: 'success', data: { error_code: 0, status: '3' } }
    },
    async clear() {
      clearCount += 1
    }
  }

  try {
    const bridge = new QishuiAuthBridge(() => module)
    const qr = await bridge.getQrLogin(root)
    assert.deepEqual(qr, {
      key: 'secure-token',
      qrContent: 'https://bff-pc.qishui.com/light/invoke/scan_login?token=secure-token',
      imageDataUrl: 'data:image/png;base64,SECURE',
      expiresInSeconds: 120
    })
    const status = await bridge.checkQrLogin(root, qr.key)
    assert.deepEqual(status, {
      json: { message: 'success', data: { error_code: 0, status: '3' } },
      cookie: 'sessionid=secure-session'
    })
    assert.equal(configureCount, 1)
    assert.equal(clearCount, 0)

    await bridge.clear(root)
    assert.equal(clearCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
