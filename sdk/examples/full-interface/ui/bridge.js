// The iframe has no window.api, Node or Electron access. All host calls use this port.
export function connectExperience(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      window.removeEventListener('pagehide', cancelled)
    }
    const cancelled = () => {
      cleanup()
      reject(new Error('界面已关闭'))
    }
    const receive = (event) => {
      if (
        event.source !== parent ||
        event.data?.type !== 'twilight-experience-connect' ||
        event.data.bridgeVersion !== 2 ||
        !event.ports[0]
      )
        return
      cleanup()
      resolve(createClient(event.ports[0]))
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('未连接到 Twilight Echo，请在宿主中打开此插件。'))
    }, timeoutMs)
    window.addEventListener('message', receive)
    window.addEventListener('pagehide', cancelled, { once: true })
    // Only the parent window can transfer the session port; the host validates our origin.
    parent.postMessage({ type: 'twilight-experience-ready', bridgeVersion: 2 }, '*')
  })
}

function createClient(port) {
  let nextId = 0
  let closed = false
  const pending = new Map()
  const listeners = new Map()
  const dispose = () => {
    if (closed) return
    closed = true
    window.removeEventListener('pagehide', dispose)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('界面连接已关闭'))
    }
    pending.clear()
    listeners.clear()
    port.close()
  }
  port.onmessage = ({ data }) => {
    if (closed || !data) return
    if (typeof data.event === 'string') {
      for (const listener of listeners.get(data.event) ?? []) listener(data.value)
      return
    }
    const request = pending.get(data.id)
    if (!request) return
    pending.delete(data.id)
    clearTimeout(request.timer)
    if (typeof data.error === 'string') request.reject(new Error(data.error))
    else request.resolve(data.value)
  }
  port.onmessageerror = dispose
  port.start()
  window.addEventListener('pagehide', dispose, { once: true })
  return {
    call(method, args = {}, timeoutMs = 30000) {
      if (closed) return Promise.reject(new Error('界面连接已关闭'))
      if (pending.size >= 16) return Promise.reject(new Error('请求过多，请稍后重试'))
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          // A timed-out mutation may still finish in the host. Do not retry it automatically.
          reject(new Error(`操作超时，请刷新状态后重试：${method}`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          port.postMessage({ id, method, args })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
      return () => listeners.get(event)?.delete(listener)
    },
    dispose
  }
}
