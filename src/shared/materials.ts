import { CARD_SURFACE_SELECTOR } from './cardSurfaces.ts'
/** Host material contract. Recipes consume theme/editor inputs; they never save preferences. */
export const MATERIAL_CONTRACT_VERSION = 1
export const MATERIAL_MODES = ['standard', 'transparent', 'liquidGlass'] as const
export type MaterialMode = (typeof MATERIAL_MODES)[number]
export const MIN_READING_FADE = 0.66
/** Configuration pages quiet only the wallpaper; preview samples keep their real material. */
export function readingMaterialTreatment(mode: string): { blur: number; fade: number } {
  if (mode === 'liquidGlass') return { blur: 28, fade: 0.68 }
  if (mode === 'frosted') return { blur: 20, fade: 0.7 }
  if (mode === 'transparent') return { blur: 24, fade: MIN_READING_FADE }
  return { blur: 12, fade: 0.8 }
}
export const MATERIAL_ROLES = [
  'canvas',
  'content',
  'navigation',
  'titlebar',
  'panel',
  'popover',
  'dialog',
  'transport',
  'control'
] as const
export type MaterialRole = (typeof MATERIAL_ROLES)[number]
export type MaterialField = 'background' | 'solid' | 'ink' | 'border' | 'shadow' | 'filter'

interface MaterialDeclaration {
  purpose: string
  optical: boolean
  transparent: boolean
  recipe: Readonly<Record<MaterialField, string>>
}
const solid = 'var(--te-card-bg-solid, var(--te-card-bg))'
const ink = 'var(--te-neutral-900)'
const border = 'var(--te-card-border)'
const quiet = { ink, border, shadow: 'none', filter: 'none' }
const floatingShadow =
  '0 12px 36px color-mix(in srgb, var(--te-chrome-shadow-color) 16%, transparent), 0 1px 4px color-mix(in srgb, var(--te-chrome-shadow-color) 8%, transparent)'
export const MATERIAL_DECLARATIONS: Readonly<Record<MaterialRole, MaterialDeclaration>> = {
  canvas: {
    purpose: 'Page backdrop; no foreground optics',
    optical: false,
    transparent: true,
    recipe: {
      ...quiet,
      background: 'var(--te-app-bg)',
      solid: 'var(--te-app-bg)',
      border: 'transparent'
    }
  },
  content: {
    purpose: 'Readable content cards; existing editor inputs remain authoritative',
    optical: false,
    transparent: true,
    recipe: {
      ...quiet,
      background: 'var(--te-card-bg)',
      solid,
      shadow: 'var(--te-card-shadow, none)'
    }
  },
  navigation: {
    purpose: 'Attached window navigation and playback queue',
    optical: true,
    transparent: true,
    recipe: {
      ...quiet,
      background: 'var(--te-chrome-navigation-surface)',
      solid: 'var(--te-chrome-material-solid)',
      ink: 'var(--te-chrome-text, var(--te-navigation-text))',
      border: 'var(--te-navigation-border)',
      shadow: 'var(--te-chrome-navigation-elevation)',
      filter: 'var(--te-chrome-attached-filter)'
    }
  },
  titlebar: {
    purpose: 'Attached window chrome; no extra border or elevation',
    optical: true,
    transparent: true,
    recipe: {
      ...quiet,
      background: 'var(--te-chrome-attached-surface)',
      solid: 'var(--te-titlebar-material-surface, var(--te-app-bg))',
      ink: 'var(--te-shell-control-text)',
      border: 'transparent',
      filter: 'var(--te-chrome-attached-filter)'
    }
  },
  panel: {
    purpose: 'Account subpage and readable floating panels',
    optical: false,
    transparent: false,
    recipe: {
      ...quiet,
      background: 'var(--te-chrome-material-solid)',
      solid: 'var(--te-chrome-material-solid)',
      shadow: floatingShadow
    }
  },
  popover: {
    purpose: 'Anchored tools and secondary filters',
    optical: false,
    transparent: false,
    recipe: {
      ...quiet,
      background: 'color-mix(in srgb, var(--te-control-bg) 98%, transparent)',
      solid: 'var(--te-control-bg)',
      ink: 'var(--te-control-fg)',
      border: 'var(--te-control-border)',
      shadow: floatingShadow,
      filter: 'blur(20px) saturate(120%)'
    }
  },
  dialog: {
    purpose: 'Modal decisions; opaque and readable in every material mode',
    optical: false,
    transparent: false,
    recipe: { ...quiet, background: solid, solid, shadow: floatingShadow }
  },
  transport: {
    purpose: 'Standard floating playback; mini/compact remain flat',
    optical: true,
    transparent: true,
    recipe: {
      ...quiet,
      background: 'var(--te-playbar-bg, var(--te-card-bg))',
      solid,
      ink: 'var(--te-playbar-text, var(--te-neutral-900))',
      border: 'transparent',
      shadow: 'var(--te-bohr-contact), var(--te-bohr-elevation)'
    }
  },
  control: {
    purpose: 'Fields and compact controls without additional glass layers',
    optical: false,
    transparent: false,
    recipe: {
      ...quiet,
      background: 'var(--te-control-bg)',
      solid: 'var(--te-control-bg)',
      ink: 'var(--te-control-fg)'
    }
  }
}
for (const declaration of Object.values(MATERIAL_DECLARATIONS)) {
  Object.freeze(declaration.recipe)
  Object.freeze(declaration)
}
Object.freeze(MATERIAL_DECLARATIONS)

export interface MaterialContext {
  mode?: MaterialMode
  blurDisabled?: boolean
  reducedEffects?: boolean
  reducedTransparency?: boolean
  increasedContrast?: boolean
  forcedColors?: boolean
  immersive?: boolean
  flatTransport?: boolean
}
/** One permission decision for optics and readability; no DOM reads or observers. */
export function resolveMaterialMode(
  role: MaterialRole,
  context: MaterialContext = {}
): MaterialMode {
  const declaration = MATERIAL_DECLARATIONS[role]
  if (
    context.forcedColors ||
    context.increasedContrast ||
    context.reducedTransparency ||
    context.blurDisabled ||
    context.reducedEffects
  )
    return 'standard'
  if (context.immersive && (role === 'titlebar' || role === 'transport')) return 'transparent'
  if (context.flatTransport && role === 'transport') return 'standard'
  if (context.mode === 'transparent') return declaration.transparent ? 'transparent' : 'standard'
  return context.mode === 'liquidGlass' && declaration.optical ? 'liquidGlass' : 'standard'
}

/** Central chrome foundation; existing public aliases keep theme compatibility. */
export const MATERIAL_FOUNDATION = {
  '--te-chrome-attached-tint': '28%',
  // The frame darkens the foundation under title chrome; the sidebar repeats
  // that neutral wash over content. Neither adds a separate themed colour.
  '--te-chrome-attached-surface': 'transparent',
  '--te-window-foundation-tint': 'rgb(0 0 0 / 10%)',
  '--te-chrome-attached-filter': 'blur(20px)',
  '--te-chrome-attached-liquid-surface':
    'color-mix(in srgb, var(--te-lg-context-material) calc(clamp(0, var(--te-lg-tint, 0.72), 1) * 100%), transparent)',
  '--te-chrome-attached-liquid-filter':
    'blur(var(--te-lg-blur, var(--te-lg-context-diffusion, 16px))) saturate(var(--te-lg-saturate, 124%))',
  '--te-window-base-background':
    'color-mix(in srgb, var(--te-app-bg) var(--te-chrome-attached-tint), transparent)',
  '--te-window-transparent-foundation': 'color-mix(in srgb, var(--te-app-bg) 4%, transparent)',
  '--te-chrome-material-solid':
    'color-mix(in srgb, var(--te-app-bg) 96%, var(--te-shell-control-text))',
  '--te-chrome-material-surface':
    'color-mix(in srgb, var(--te-chrome-material-solid) 76%, transparent)',
  '--te-chrome-navigation-surface': 'var(--te-window-foundation-tint)',
  '--te-chrome-navigation-elevation': 'none',
  '--te-chrome-contact':
    '0 1px 3px color-mix(in srgb, var(--te-chrome-shadow-color) 8%, transparent)',
  '--te-chrome-elevation':
    '0 5px 16px color-mix(in srgb, var(--te-chrome-shadow-color) 8%, transparent)',
  '--te-material-scrim': 'var(--te-dialog-backdrop)',
  '--te-image-card-filter': 'blur(20px) saturate(110%)',
  '--te-bookmark-default-filter': 'var(--te-chrome-attached-filter)',
  '--te-editor-toolbar-shadow': '0 6px 24px #00000014',
  '--te-editor-property-shadow': '0 12px 32px #00000024',
  '--te-editor-choice-surface': 'color-mix(in srgb, var(--te-editor-accent) 10%, transparent)',
  '--te-brand-avatar-fill': 'linear-gradient(135deg, var(--te-primary-500), var(--te-accent-cyan))',
  '--te-material-content-filter':
    'blur(var(--te-card-blur, 0px)) saturate(var(--te-card-saturate, 100%))'
} as const
const darkFoundation = {
  '--te-chrome-contact':
    '0 1px 3px color-mix(in srgb, var(--te-chrome-shadow-color) 20%, transparent)',
  '--te-chrome-elevation':
    '0 5px 16px color-mix(in srgb, var(--te-chrome-shadow-color) 16%, transparent)'
}
export function materialVariable(role: MaterialRole, field: MaterialField): string {
  return `--te-material-${role}-${field}`
}
export function compileMaterialCss(): string {
  const declarations = (values: Readonly<Record<string, string>>): string =>
    Object.entries(values)
      .map(([name, value]) => `  ${name}: ${value};`)
      .join('\n')
  const blocks = [
    '/* Generated from src/shared/materials.ts. Run generate:materials; do not edit. */',
    `:root {\n${declarations(MATERIAL_FOUNDATION)}\n}`,
    `:where(.app-background-ambient) {\n${declarations({
      '--te-home-ambient-surface':
        'radial-gradient(ellipse 520px 520px at 80px 40px, color-mix(in srgb, var(--te-primary-500) 6%, transparent), transparent 72%), radial-gradient(ellipse 420px 420px at calc(100% - 20px) 300px, color-mix(in srgb, var(--te-accent-cyan) 4%, transparent), transparent 72%), radial-gradient(ellipse 360px 360px at 45% 840px, color-mix(in srgb, var(--te-favorite-500) 3%, transparent), transparent 72%)'
    })}\n}`,
    `:where(.dialog-btn.danger) {\n${declarations({
      '--te-danger-control-surface':
        'color-mix(in srgb, var(--te-danger-500, #d14343) 14%, transparent)',
      '--te-danger-control-hover':
        'color-mix(in srgb, var(--te-danger-500, #d14343) 22%, transparent)'
    })}\n}`,
    `html[data-theme='dark'] {\n${declarations(darkFoundation)}\n}`,
    // Resolve context-dependent recipes where they paint, rather than freezing
    // their root values before a preview, page or theme supplies local inputs.
    `:where(.app-shell,[data-te-material],.sidebar-bookmark) {\n${declarations(
      Object.fromEntries(
        [
          '--te-chrome-attached-surface',
          '--te-chrome-navigation-surface',
          '--te-chrome-attached-liquid-surface',
          '--te-chrome-attached-liquid-filter',
          '--te-window-base-background',
          '--te-window-transparent-foundation'
        ].map((name) => [name, MATERIAL_FOUNDATION[name as keyof typeof MATERIAL_FOUNDATION]])
      )
    )}\n}`,
    // Feedback is computed at its painted control, so local artwork/preview ink
    // is used instead of a color frozen on the document root.
    `:where(.page-dock-action,.sidebar-bookmark) {\n${declarations({
      '--te-chrome-control-hover': 'color-mix(in srgb, currentColor 4%, transparent)',
      '--te-chrome-control-selected': 'color-mix(in srgb, currentColor 7%, transparent)',
      '--te-chrome-control-selected-hover': 'color-mix(in srgb, currentColor 9%, transparent)',
      '--te-bookmark-effective-filter':
        'var(--te-bookmark-filter, var(--te-bookmark-default-filter))'
    })}\n}`,
    `:where(.appearance-view-angles) {\n${declarations({
      '--te-editor-ruler-marker-shadow': '0 0 0 2px var(--appearance-ruler-surface)',
      '--te-editor-camera-surface':
        'color-mix(in srgb, var(--appearance-ruler-surface) 68%, transparent)',
      '--te-editor-camera-filter': 'blur(12px)'
    })}\n}`,
    `:where(.settings-preview-page) {\n${declarations({
      '--te-settings-row-hover': 'color-mix(in srgb, var(--te-settings-text) 4%, transparent)',
      '--te-settings-row-focus': 'color-mix(in srgb, var(--te-settings-text) 7%, transparent)'
    })}\n}`,
    `:where(.dsp-signal-chain) {\n${declarations({
      '--te-status-quiet-surface': 'color-mix(in srgb, var(--te-settings-text) 2%, transparent)',
      '--te-status-selected-surface':
        'color-mix(in srgb, var(--te-control-accent) 10%, var(--te-card-bg))'
    })}\n}`,
    `:where(.ctrl-btn,.icon-btn,.mode-btn-right,.time-chip,.lyric-row) {\n${declarations({
      '--te-transport-feedback-surface':
        'var(--te-playback-control-surface, color-mix(in srgb, var(--te-playback-control-text, var(--te-control-fg)) 8%, transparent))',
      '--te-transport-feedback-hover':
        'var(--te-playback-control-hover-surface, color-mix(in srgb, var(--te-playback-control-text, var(--te-control-fg)) 10%, transparent))',
      '--te-transport-feedback-pressed':
        'var(--te-playback-control-hover-surface, color-mix(in srgb, var(--te-playback-control-text, var(--te-control-fg)) 16%, transparent))',
      '--te-transport-feedback-shadow':
        'var(--te-playback-control-hover-shadow, var(--te-chrome-elevation))'
    })}\n}`
  ]
  for (const role of MATERIAL_ROLES) {
    const recipe = MATERIAL_DECLARATIONS[role].recipe
    const variables = Object.fromEntries(
      Object.entries(recipe).map(([field, value]) => [
        materialVariable(role, field as MaterialField),
        value
      ])
    )
    // Resolve at the painted element so page-local theme/preview variables work.
    for (const field of Object.keys(recipe) as MaterialField[])
      variables[`--te-material-${field}`] = `var(${materialVariable(role, field)})`
    blocks.push(`:where([data-te-material='${role}']) {\n${declarations(variables)}\n}`)
    if (MATERIAL_DECLARATIONS[role].transparent)
      blocks.push(
        `html[data-te-surface-material='transparent'] :where([data-te-material='${role}']) {\n  --te-material-background: transparent;\n  --te-material-border: transparent;\n  --te-material-shadow: none;\n  --te-material-filter: none;\n}`
      )
  }
  blocks.push(
    `:where(.te-material) {\n  background: var(--te-material-background);\n  color: var(--te-material-ink);\n  border-color: var(--te-material-border);\n  box-shadow: var(--te-material-shadow);\n  backdrop-filter: var(--te-material-filter);\n  -webkit-backdrop-filter: var(--te-material-filter);\n}`
  )
  const fallback = `  --te-material-background: var(--te-material-solid);\n  --te-material-filter: none;`
  blocks.push(
    `body.te-no-blur [data-te-material], html[data-te-effects-mode='reduced'] [data-te-material] {\n${fallback}\n}`,
    `@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {\n  html [data-te-material] {\n${fallback}\n  }\n}`,
    `@supports not (backdrop-filter: blur(1px)) {\n  html [data-te-material] {\n${fallback}\n  }\n}`,
    `@media (forced-colors: active) {\n  html [data-te-material] {\n    --te-material-background: Canvas;\n    --te-material-ink: CanvasText;\n    --te-material-border: CanvasText;\n    --te-material-shadow: none;\n    --te-material-filter: none;\n  }\n}`
  )
  const imageCards = `:where(html[data-te-local-image-palette='on'][data-te-card-custom='off'] body.te-local-surface,html[data-te-streaming-image-palette='on'][data-te-card-custom='off'] body.te-streaming-surface,html[data-te-settings-image-palette='on'][data-te-card-custom='off'] body.te-settings-surface,html[data-te-app-image-palette='on'][data-te-card-custom='off'] .audio-workspace) :is(${CARD_SURFACE_SELECTOR})`
  const imageCardInk = declarations({
    '--te-neutral-900': 'var(--te-image-control-text)',
    '--te-neutral-800': 'var(--te-image-control-text)',
    '--te-neutral-700': 'var(--te-image-control-muted)',
    '--te-neutral-600': 'var(--te-image-control-muted)',
    '--te-neutral-500': 'var(--te-image-control-muted)',
    '--te-neutral-400': 'var(--te-image-control-muted)',
    '--te-settings-text': 'var(--te-image-control-text)',
    '--te-settings-text-muted': 'var(--te-image-control-muted)',
    '--te-text-primary': 'var(--te-image-control-text)',
    '--text-primary': 'var(--te-image-control-text)',
    '--text-secondary': 'var(--te-image-control-muted)',
    '--online-ink': 'var(--te-image-control-text)',
    '--online-muted': 'var(--te-image-control-muted)',
    '--home-ink': 'var(--te-image-control-text)',
    '--home-muted': 'var(--te-image-control-muted)',
    '--appearance-edit-text': 'var(--te-image-control-text)',
    '--appearance-edit-muted': 'var(--te-image-control-muted)'
  })
  blocks.push(`@layer te-appearance {
html[data-te-card-custom='on'] :is(${CARD_SURFACE_SELECTOR}){background:var(--te-card-bg)!important;border:var(--te-card-border-width) solid var(--te-card-border)!important;border-radius:var(--te-card-radius)!important;box-shadow:var(--te-card-shadow),var(--te-card-glass-highlight)!important;backdrop-filter:var(--te-material-content-filter)!important;-webkit-backdrop-filter:var(--te-material-content-filter)!important}
${imageCards}{background-color:color-mix(in srgb,var(--te-image-control-surface) 72%,transparent)!important;border-color:var(--te-image-control-border)!important;backdrop-filter:var(--te-image-card-filter)!important;-webkit-backdrop-filter:var(--te-image-card-filter)!important}
:where(html:not([data-te-surface-material='transparent'])) ${imageCards}{\n${imageCardInk}\ncolor:var(--te-image-control-text)!important;}
html[data-te-surface-material='transparent'] :is(${CARD_SURFACE_SELECTOR}){background-color:transparent!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
html[data-te-effects-mode='reduced'] :is(${CARD_SURFACE_SELECTOR}),body.te-no-blur :is(${CARD_SURFACE_SELECTOR}){background-color:var(--te-material-solid,var(--te-card-bg-solid))!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more){html:root :is(${CARD_SURFACE_SELECTOR}){background-color:var(--te-material-solid,var(--te-card-bg-solid))!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}}
@supports not(backdrop-filter:blur(1px)){html:root :is(${CARD_SURFACE_SELECTOR}){background-color:var(--te-material-solid,var(--te-card-bg-solid))!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}}
@media(forced-colors:active){html:root :is(${CARD_SURFACE_SELECTOR}){background:Canvas!important;color:CanvasText!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}}
}`)
  return `${blocks.join('\n\n')}\n`
}
export function materialContract(): object {
  return {
    version: MATERIAL_CONTRACT_VERSION,
    attribute: 'data-te-material',
    modes: MATERIAL_MODES,
    roles: MATERIAL_ROLES.map((role) => ({
      id: role,
      purpose: MATERIAL_DECLARATIONS[role].purpose,
      optical: MATERIAL_DECLARATIONS[role].optical,
      transparent: MATERIAL_DECLARATIONS[role].transparent,
      variables: Object.keys(MATERIAL_DECLARATIONS[role].recipe).map((field) =>
        materialVariable(role, field as MaterialField)
      )
    })),
    inputs: ['theme tokens', 'card appearance', 'liquid glass settings', 'background context'],
    fallback:
      'Opaque standard material when effects, transparency or contrast require it. Forced colors use system colors.',
    ownership:
      'Host owns recipes. Plugins consume roles and theme inputs; geometry and artwork remain component-owned.'
  }
}
