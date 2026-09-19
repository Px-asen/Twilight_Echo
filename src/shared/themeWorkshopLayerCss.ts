import type { WorkshopProject } from './themeWorkshop.ts'
import type { WorkshopSurface } from './themeWorkshopLayers.ts'

export const WORKSHOP_SURFACE_SELECTORS: Record<WorkshopSurface, string> = {
  app: '.app-shell',
  'local.home': '.dashboard-wrapper',
  'streaming.home': '.streaming-content:has(.music-home)',
  'local.library': '.song-list',
  'streaming.library': '.streaming-content:not(:has(.music-home))',
  settings: '.settings-preview-page',
  player: '.player-bar'
}

export function compileWorkshopLayers(project: WorkshopProject): string {
  const css: string[] = []
  for (const tone of ['pureWhite', 'dark'] as const) {
    for (const [surface, layers] of Object.entries(project.layers?.[tone] ?? {})) {
      const host = `html[data-theme='${tone}'] ${WORKSHOP_SURFACE_SELECTORS[surface as WorkshopSurface]}`
      css.push(`${host}{isolation:isolate;position:relative}`)
      for (const [index, layer] of layers.entries()) {
        if (!layer.visible) continue
        const asset = project.assets?.find((a) => a.id === layer.assetId)
        const image =
          layer.kind === 'gradient'
            ? `linear-gradient(${layer.angle}deg,${layer.colorStart},${layer.colorEnd})`
            : asset
              ? `url('${asset.dataUrl}')`
              : 'none'
        const selector = `${host} > .workshop-decoration > :nth-child(${index + 1})`
        const fade = layer.fade
        const crop = layer.crop
        const masks = `linear-gradient(to right,transparent,#000 ${fade.left}%,#000 ${100 - fade.right}%,transparent),linear-gradient(to bottom,transparent,#000 ${fade.top}%,#000 ${100 - fade.bottom}%,transparent)`
        css.push(
          `${selector}{display:block;left:${layer.x}%;top:${layer.y}%;width:${layer.width}%;height:${layer.height}%;opacity:${layer.opacity};filter:blur(${layer.blur}px);transform:translate(-50%,calc(-50% - ${layer.attachment === 'scroll' ? 'var(--te-workshop-scroll-y,0px)' : '0px'})) scale(${layer.scale}) rotate(${layer.rotation}deg);background-image:${image};background-size:${layer.fit};background-position:center;background-repeat:no-repeat;mask-image:${masks};mask-composite:intersect;clip-path:inset(${crop.top}% ${crop.right}% ${crop.bottom}% ${crop.left}%);background-attachment:${layer.attachment === 'scroll' ? 'local' : 'scroll'}}`
        )
        css.push(
          `${selector}::after{content:'';position:absolute;inset:0;background:${layer.maskColor};opacity:${layer.maskOpacity}}`
        )
        if (layer.condition !== 'always') {
          const condition = {
            empty: ':is(.empty-state,.empty-placeholder,.empty)',
            loading: ':is(.loading,.loading-state,.spinner)',
            done: ':is(.success,.completed)',
            listening: ':is(.playing,.is-playing)'
          }[layer.condition]
          css.push(
            `${host}:not(:has(${condition})):not([data-workshop-state='${layer.condition}']) > .workshop-decoration > :nth-child(${index + 1}){display:none}`
          )
        }
      }
    }
  }
  return css.join('\n')
}
