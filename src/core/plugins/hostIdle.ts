/**
 * Idle bookkeeping for plugin host processes.
 *
 * Only pure providers may hibernate. Background tools stay resident.
 * Provider calls, UI commands and subscribed events restart the countdown.
 * Hosts serving a local playback proxy must stay resident even between calls:
 * issued URLs can still be playing, paused or retained in playback queues. The
 * tracker arms one timer per plugin, resets it on every activity, and asks
 * the owner whether the plugin may hibernate when the timer fires. Plugins
 * that are still busy are simply re-armed.
 */
export interface PluginHostIdleTrackerOptions {
  idleTimeoutMs: number
  /** Return false to keep the host resident this round; it is re-armed. */
  canHibernate: (pluginId: string) => boolean
  onIdle: (pluginId: string) => void
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

export const DEFAULT_PLUGIN_HOST_IDLE_TIMEOUT_MS = 60 * 1000

/** A loopback playback URL depends on a service in the live plugin host. */
export function isPluginHostedPlaybackUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname)
  } catch {
    return false
  }
}

export class PluginHostIdleTracker {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly idleTimeoutMs: number
  private readonly schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void
  private readonly canHibernate: (pluginId: string) => boolean
  private readonly onIdle: (pluginId: string) => void
  private stopped = false

  constructor(options: PluginHostIdleTrackerOptions) {
    this.idleTimeoutMs = Math.max(1, Math.floor(options.idleTimeoutMs))
    this.schedule = options.setTimeout ?? setTimeout
    this.cancel = options.clearTimeout ?? clearTimeout
    this.canHibernate = options.canHibernate
    this.onIdle = options.onIdle
  }

  /** Records activity for a plugin and restarts its idle countdown. */
  touch(pluginId: string): void {
    if (this.stopped) return
    this.clear(pluginId)
    const timer = this.schedule(() => {
      this.timers.delete(pluginId)
      if (this.stopped) return
      if (!this.canHibernate(pluginId)) {
        this.touch(pluginId)
        return
      }
      this.onIdle(pluginId)
    }, this.idleTimeoutMs)
    this.timers.set(pluginId, timer)
  }

  /** Stops tracking a plugin (it exited, was disabled, or hibernated). */
  clear(pluginId: string): void {
    const timer = this.timers.get(pluginId)
    if (!timer) return
    this.cancel(timer)
    this.timers.delete(pluginId)
  }

  isTracking(pluginId: string): boolean {
    return this.timers.has(pluginId)
  }

  destroy(): void {
    this.stopped = true
    for (const timer of this.timers.values()) this.cancel(timer)
    this.timers.clear()
  }
}
