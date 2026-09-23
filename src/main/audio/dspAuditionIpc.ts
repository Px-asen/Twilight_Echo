import type { DspAuditionManager } from './dspAuditionManager.ts'
import type { DspAuditionRequest } from '../../shared/dspAudition.ts'
import { normalizeIpcString, stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'

export function createDspAuditionHandlers(
  manager: DspAuditionManager,
  assertSender: (event: unknown) => void
) {
  return {
    measure: async (event: unknown, value: unknown) => {
      assertSender(event)
      stringifyJsonForIpcStorage(value, '试听配置', 128 * 1024)
      if (!value || typeof value !== 'object') throw new Error('试听配置无效')
      return manager.measure(value as DspAuditionRequest)
    },
    select: async (event: unknown, id: unknown, side: unknown) => {
      assertSender(event)
      if (side !== 'a' && side !== 'b') throw new Error('试听选择无效')
      return manager.select(normalizeIpcString(id, '试听会话', 128), side)
    },
    end: async (event: unknown) => {
      assertSender(event)
      await manager.end()
    },
    status: async (event: unknown) => {
      assertSender(event)
      return manager.status()
    }
  }
}
