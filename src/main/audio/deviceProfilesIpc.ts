import type { AudioEngineManager } from '../audioEngineManager.ts'
import { normalizeAudioDeviceProfile } from '../../shared/audioDeviceProfiles.ts'
import { normalizeFiniteNumber, normalizeIpcString } from '../security/ipcValidation.ts'

export function createDeviceProfileHandlers(
  ensureEngine: () => Promise<
    Pick<
      AudioEngineManager,
      'getDeviceProfiles' | 'saveDeviceProfile' | 'deleteDeviceProfile' | 'applyDeviceProfile'
    >
  >,
  assertSender: (event: unknown) => void
) {
  return {
    get: async (event: unknown) => {
      assertSender(event)
      return (await ensureEngine()).getDeviceProfiles()
    },
    save: async (event: unknown, value: unknown) => {
      assertSender(event)
      const profile = normalizeAudioDeviceProfile(value)
      if (!profile) throw new Error('设备档案格式无效，必须选择有稳定 ID 的设备')
      const raw = value as Record<string, unknown>
      profile.id = normalizeIpcString(raw.id, 'device profile id', 128)
      profile.name = normalizeIpcString(raw.name, 'device profile name', 100)
      profile.volumeCeiling = normalizeFiniteNumber(raw.volumeCeiling, 'volume ceiling', 0.7, 0, 1)
      return (await ensureEngine()).saveDeviceProfile(profile)
    },
    remove: async (event: unknown, id: unknown) => {
      assertSender(event)
      const normalized = normalizeIpcString(id, 'device profile id', 128)
      return (await ensureEngine()).deleteDeviceProfile(normalized)
    },
    apply: async (event: unknown, id: unknown) => {
      assertSender(event)
      const normalized = normalizeIpcString(id, 'device profile id', 128)
      return (await ensureEngine()).applyDeviceProfile(normalized)
    }
  }
}
