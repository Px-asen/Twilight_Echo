import {
  isQueueWorkspaceDocument,
  type QueueWorkspaceDocument
} from '../../shared/queueWorkspace.ts'
import {
  PersistentDataRevisionConflictError,
  createPersistentDataRevisionConflictResponse
} from '../../shared/versionedPersistence.ts'
import type { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import { stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'

export const MAX_QUEUE_WORKSPACE_BYTES = 32 * 1024 * 1024

export function createQueueWorkspaceHandlers(
  store: VersionedDataStore<QueueWorkspaceDocument>,
  assertSender: (event: unknown) => void
) {
  return {
    load: async (event: unknown) => {
      assertSender(event)
      return store.load()
    },
    save: async (event: unknown, document: unknown, expectedRevision: number) => {
      assertSender(event)
      stringifyJsonForIpcStorage(document, 'queue workspace', MAX_QUEUE_WORKSPACE_BYTES)
      if (!isQueueWorkspaceDocument(document)) throw new Error('队列会话格式或容量无效')
      try {
        return await store.save(document, expectedRevision)
      } catch (error) {
        if (error instanceof PersistentDataRevisionConflictError) {
          return createPersistentDataRevisionConflictResponse(error)
        }
        throw error
      }
    }
  }
}
