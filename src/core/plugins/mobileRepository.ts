import { compareSemver, isCompatibleTwilightRange, validatePluginManifest } from './manifest.ts'
import type { TwilightAndroidPluginRuntime } from '../../shared/pluginTypes.ts'

/** The mobile host executes bundled ES2015 scripts, not Node/Electron entry points. */
export type AndroidPluginRuntime = TwilightAndroidPluginRuntime

export function androidPluginRuntime(raw: unknown): AndroidPluginRuntime {
  const value = raw as AndroidPluginRuntime | undefined
  if (!value || value.apiVersion !== 1) throw new Error('此插件尚未提供 Android 运行入口')
  if (typeof value.entry !== 'string' || !/^[\w/-]+\.js$/.test(value.entry) ||
      value.entry.split('/').some(part => part === '..' || part === '') || value.entry.startsWith('/'))
    throw new Error('Android 插件入口路径无效')
  if (!Array.isArray(value.permissions) || value.permissions.some(p => !['network', 'settings'].includes(p)))
    throw new Error('此插件需要 Android 尚不支持的权限')
  if (!Array.isArray(value.networkHosts) || value.networkHosts.length > 32 ||
      value.networkHosts.some(host => typeof host !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host)))
    throw new Error('插件网络授权必须是明确的 HTTPS 主机名')
  return { ...value, permissions: [...new Set(value.permissions)], networkHosts: [...new Set(value.networkHosts)] }
}

export function mobilePluginManifest(raw: any, appVersion = '1.4.0-perview0') {
  const manifest = validatePluginManifest(raw)
  if (!isCompatibleTwilightRange(manifest.engines.twilightEcho, appVersion)) throw new Error('插件需要其他版本的 Twilight Echo')
  if (manifest.type.length !== 1 || manifest.type[0] !== 'provider' || manifest.binary ||
      Object.keys(manifest.dependencies ?? {}).length) throw new Error('Android 当前支持独立的 JavaScript Provider 插件')
  return { ...manifest, androidRuntime: androidPluginRuntime(raw.androidRuntime) }
}

/** Pure coordination shared by mobile hosts. IO, integrity and execution stay in adapters. */
export function mobileRepositoryRequest(input: any): unknown {
  switch (input.operation) {
    case 'manifest': return mobilePluginManifest(input.manifest)
    case 'catalog': {
      if (input.index?.schemaVersion !== 1 || !Array.isArray(input.index.plugins) || input.index.plugins.length > 1000)
        throw new Error('插件仓库索引格式无效')
      const seen = new Set<string>()
      return input.index.plugins.map((raw: any) => {
        const manifest = validatePluginManifest(raw)
        if (seen.has(manifest.id)) throw new Error('插件仓库包含重复 ID')
        seen.add(manifest.id)
        if (!/^[a-f0-9]{64}$/i.test(raw.checksumSha256)) throw new Error('插件缺少有效的完整性校验')
        if (typeof raw.sourceUrl !== 'string' || !raw.sourceUrl) throw new Error('插件缺少下载地址')
        let unsupportedReason: string | null = null
        try { mobilePluginManifest(raw) } catch (e) { unsupportedReason = (e as Error).message }
        const installed = (input.installed ?? []).find((p: any) => p.id === manifest.id)
        return { ...manifest, androidRuntime: raw.androidRuntime, sourceUrl: raw.sourceUrl,
          checksumSha256: raw.checksumSha256.toLowerCase(), unsupportedReason,
          installedVersion: installed?.version ?? null, enabled: installed?.enabled === true,
          updateAvailable: installed ? compareSemver(manifest.version, installed.version) > 0 : false }
      })
    }
    case 'verifyIdentity': {
      const manifest = mobilePluginManifest(input.manifest)
      if (manifest.id !== input.expected.id || manifest.version !== input.expected.version)
        throw new Error('插件包与仓库声明的身份不一致')
      if (JSON.stringify(manifest.androidRuntime) !== JSON.stringify(androidPluginRuntime(input.expected.androidRuntime)))
        throw new Error('插件包权限与仓库声明不一致')
      return manifest
    }
    default: throw new Error('未知的插件仓库操作')
  }
}
