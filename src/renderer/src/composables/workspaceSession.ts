import { getCurrentInstance, inject, onBeforeUnmount, provide, type InjectionKey } from 'vue'

// Closed workspaces retain JSON only. Editors, DOM, observers and preview images
// belong to the mounted scope and are released with it.
const sessions = new Map<string, string>()
interface WorkspaceSession {
  read<T>(id: string): T | undefined
  register(id: string, snapshot: () => unknown): () => void
}
const sessionKey: InjectionKey<WorkspaceSession> = Symbol('workspace-session')

export function provideWorkspaceSession(
  key: string,
  revision?: number | (() => number | undefined)
) {
  const currentRevision = () => (typeof revision === 'function' ? revision() : revision)
  const saved = sessions.get(key)
  const previous = saved ? JSON.parse(saved) : undefined
  sessions.delete(key)
  const values: Record<string, unknown> =
    previous?.revision === currentRevision() ? (previous?.values ?? {}) : {}
  const readers = new Map<string, () => unknown>()
  const session: WorkspaceSession = {
    read: <T>(id: string) => {
      const value = values[id] as T | undefined
      delete values[id]
      return value
    },
    register(id, snapshot) {
      readers.set(id, snapshot)
      return () => {
        if (readers.get(id) === snapshot) readers.delete(id)
      }
    }
  }
  provide(sessionKey, session)
  function capture(): void {
    sessions.set(
      key,
      JSON.stringify({
        revision: currentRevision(),
        values: { ...values, ...Object.fromEntries([...readers].map(([id, read]) => [id, read()])) }
      })
    )
  }
  onBeforeUnmount(capture)
  return { ...session, capture }
}

export function useWorkspaceState<T>(id: string, snapshot: () => T) {
  const instance = getCurrentInstance()
  const session = instance ? inject(sessionKey, undefined) : undefined
  const unregister = session?.register(id, snapshot)
  if (instance) onBeforeUnmount(() => unregister?.())
  return {
    restore(apply: (value: T) => void): boolean {
      const value = session?.read<T>(id)
      if (value === undefined) return false
      apply(value)
      return true
    }
  }
}
