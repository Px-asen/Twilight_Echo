import type { AppSettings } from '../../shared/appSettings.ts'
import { normalizeDspScenes, type DspScene } from '../../shared/dspGraph.ts'
import type { DspAssetLibrary } from './dspAssetLibrary.ts'

type Assets = Pick<DspAssetLibrary, 'get' | 'getPath'>
type AuthorizeImpulse = (path: string) => Promise<string>

export async function authorizeDspScenes(
  scenes: DspScene[],
  processing: AppSettings['audioProcessing'],
  assets: Assets,
  authorizeImpulse: AuthorizeImpulse
): Promise<DspScene[]> {
  const result = normalizeDspScenes(scenes, processing)
  for (const scene of result)
    for (const node of scene.graph.nodes) {
      const path = node.params.impulseResponsePath
      if (node.params.impulseResponseAssetId) {
        const asset = await assets.get(String(node.params.impulseResponseAssetId))
        if (asset?.kind !== 'impulseResponse') throw new Error('Managed impulse response not found')
        await assets.getPath(asset.id)
        delete node.params.impulseResponsePath
      } else if (typeof path === 'string' && path)
        node.params.impulseResponsePath = await authorizeImpulse(path)
    }
  return result
}

export async function authorizeDspSettings(
  next: AppSettings,
  assets: Assets,
  authorizeImpulse: AuthorizeImpulse
): Promise<AppSettings> {
  const audioProcessing = { ...next.audioProcessing }
  if (audioProcessing.convolverIrPath)
    audioProcessing.convolverIrPath = await authorizeImpulse(audioProcessing.convolverIrPath)
  const dspScenes = await authorizeDspScenes(
    next.dspScenes,
    audioProcessing,
    assets,
    authorizeImpulse
  )
  return { ...next, audioProcessing, dspScenes }
}
