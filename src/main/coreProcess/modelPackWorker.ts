import '../../adapters-node/index.ts'
import { createServicePort } from '../services/servicePort.ts'
import { initializeUtilityDiagnostics } from '../diagnostics/utility.ts'
import { CoreModelPackService } from '../../core/audio/modelPackService.ts'
import type {
  ModelPackPlatformCall,
  ModelPackWorkerMessage,
  ModelPackWorkerRequest
} from './modelPackWorkerProtocol.ts'

initializeUtilityDiagnostics('twilight-model-install')
let service: CoreModelPackService | undefined
let closed = false
let sequence = 0
const calls = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void; dispose(): void }
>()
const port = createServicePort<ModelPackWorkerRequest, ModelPackWorkerMessage>({
  onClose: () => {
    closed = true
    for (const call of calls.values()) {
      call.dispose()
      call.reject(new Error('Model installation host disconnected'))
    }
    calls.clear()
    void service?.shutdown().finally(() => process.exit(0))
  }
})

function platform<T>(call: ModelPackPlatformCall, signal?: AbortSignal): Promise<T> {
  if (closed) return Promise.reject(new Error('Model installation host disconnected'))
  signal?.throwIfAborted()
  const id = ++sequence
  return new Promise<T>((resolve, reject) => {
    const cancel = () => port.postMessage({ kind: 'platform-cancel', id })
    calls.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      dispose: () => signal?.removeEventListener('abort', cancel)
    })
    signal?.addEventListener('abort', cancel, { once: true })
    port.postMessage({ kind: 'platform', id, ...call })
    // Cancellation joins the platform's reply, including decoder process exit.
    // Rejecting here would let staging cleanup race that external writer.
  })
}

port.on('message', (message) => {
  if (message.kind === 'platform-result') {
    const call = calls.get(message.id)
    if (!call) return
    calls.delete(message.id)
    call.dispose()
    if (message.ok) call.resolve(message.value)
    else call.reject(new Error(message.error))
  } else if (message.kind === 'cancel') service?.cancel()
  else if (message.kind === 'shutdown') {
    if (service) void service.shutdown().catch(() => {})
    else {
      closed = true
      port.postMessage({
        kind: 'finished',
        state: { phase: 'cancelled', completedBytes: 0, totalBytes: 0 }
      })
    }
  } else if (message.kind === 'start' && !service && !closed) {
    service = new CoreModelPackService({
      root: message.root,
      checkpointSha256: message.checkpointSha256,
      chooseArchive: (signal) =>
        platform({ operation: 'chooseArchive', payload: undefined }, signal),
      decode: (payload, signal) => platform({ operation: 'decode', payload }, signal),
      probe: (payload, signal) => platform({ operation: 'probe', payload }, signal),
      installed: (payload) => platform({ operation: 'installed', payload }),
      changed: () => {
        if (!closed && service) port.postMessage({ kind: 'state', state: service.state() })
      }
    })
    service.start(message.enableAfterInstall)
    void (async () => {
      try {
        await service!.waitForIdle()
      } catch (error) {
        console.error('[model-install]', error)
      } finally {
        await service!.shutdown().catch(() => {})
        if (!closed) port.postMessage({ kind: 'finished', state: service!.state() })
      }
    })()
  }
})
port.postMessage({ kind: 'ready' })
