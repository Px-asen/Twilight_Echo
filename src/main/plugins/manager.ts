import { app, utilityProcess } from 'electron'
import { TwilightPluginManager as CorePluginManager } from '../../core/plugins/manager.ts'
import type { TwilightPluginManagerOptions as CorePluginManagerOptions } from '../../core/plugins/manager.ts'
import type { PluginHostProcess } from '../../core/plugins/platform.ts'
import { PluginSettingsRepository } from '../../core/plugins/settingsRepository.ts'
import { protectJsonValue, unprotectJsonValue } from '../security/secureStorage.ts'
import { providerPlaybackIdentities } from '../audio/providerPlaybackIdentity.ts'
import { createPluginManagerPlatform } from './platform.ts'
import { openQqMusicOfficialLogin } from './qqmusicOfficialLogin.ts'
export type { TwilightProviderCallOptions } from '../../core/plugins/manager.ts'
export interface TwilightPluginManagerOptions extends Omit<
  CorePluginManagerOptions,
  'platform' | 'settings' | 'recordPlaybackIdentity'
> {
  hostEntry: string
  getProxyEnv?: () => Record<string, string>
}

/** Legacy main entry; the business implementation is shared with the utility Core. */
export class TwilightPluginManager extends CorePluginManager {
  constructor(options: TwilightPluginManagerOptions) {
    super({
      ...options,
      qqmusicOfficialLogin: options.qqmusicOfficialLogin ?? openQqMusicOfficialLogin,
      recordPlaybackIdentity: (...args) => providerPlaybackIdentities.record(...args),
      settings: new PluginSettingsRepository({
        protect: protectJsonValue,
        unprotect: unprotectJsonValue
      }),
      platform: createPluginManagerPlatform({
        userData: app.getPath('userData'),
        launchHost: (id) => {
          const proxyEnv = options.getProxyEnv?.() ?? {}
          return utilityProcess.fork(options.hostEntry, [], {
            serviceName: 'twilight-plugin-' + id,
            stdio: 'pipe',
            ...(Object.keys(proxyEnv).length > 0 ? { env: { ...process.env, ...proxyEnv } } : {})
          }) as unknown as PluginHostProcess
        }
      })
    })
  }
}
