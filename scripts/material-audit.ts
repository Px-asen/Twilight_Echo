import { readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { relative, join } from 'node:path'
import { createHash } from 'node:crypto'
import { parse as parseVue } from '@vue/compiler-sfc'
import postcss from 'postcss'
import { MATERIAL_ROLES } from '../src/shared/materials.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const renderer = join(root, 'src/renderer/src')
const baselinePath = new URL('./material-legacy-baseline.json', import.meta.url)
type Finding = { file: string; selector: string; property: string; value: string; count: number }
type LegacyBaseline = { files: Record<string, Record<string, number>> }
function fingerprint(finding: Finding): string {
  return createHash('sha256')
    .update(JSON.stringify([finding.selector, finding.property, finding.value]))
    .digest('hex')
}
export function materialBaseline(findings: Finding[]): LegacyBaseline {
  const files: LegacyBaseline['files'] = {}
  for (const finding of findings) (files[finding.file] ??= {})[fingerprint(finding)] = finding.count
  return { files }
}
export function isIndependentMaterial(property: string, value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (/^(none|transparent|currentColor|inherit|initial|unset|Canvas|CanvasText)$/i.test(normalized))
    return false
  if (/^var\(--[\w-]+(?:,[^()]*)?\)$/.test(normalized)) return false
  if (/^(?:-webkit-)?backdrop-filter$/.test(property)) return true
  if (property === 'box-shadow')
    return /(?:\d|\.)+(?:px|rem)|(?:rgb|hsl)a?\(|#[\da-f]/i.test(normalized)
  return (
    /^(background|background-color)$/.test(property) &&
    (/rgba?\(|hsla?\(|color-mix\(|gradient\(|#[\da-f]{3,8}\b/i.test(normalized) ||
      /^[a-z]+$/i.test(normalized))
  )
}
export function validateMaterialRoles(template: string): void {
  // Vue bindings are expressions, not literal role names.
  for (const match of template.matchAll(/(?:^|\s)data-te-material=(["'])(.*?)\1/g))
    if (!MATERIAL_ROLES.includes(match[2] as (typeof MATERIAL_ROLES)[number]))
      throw Error(`unknown material role ${match[2]}`)
}
export async function scanMaterials(directory = renderer): Promise<Finding[]> {
  const found = new Map<string, Finding>()
  async function scan(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) {
        await scan(file)
        continue
      }
      if (!/\.(vue|css)$/.test(entry.name) || file === join(renderer, 'assets/materials.css'))
        continue
      const source = await readFile(file, 'utf8')
      const name = relative(root, file).replaceAll('\\', '/')
      const descriptor = entry.name.endsWith('.vue')
        ? parseVue(source, { filename: file }).descriptor
        : undefined
      const styles = descriptor ? descriptor.styles.map((style) => style.content) : [source]
      try {
        if (descriptor) validateMaterialRoles(descriptor.template?.content ?? '')
      } catch (error) {
        throw Error(`${name}: ${(error as Error).message}`)
      }
      for (const style of styles)
        postcss.parse(style, { from: file }).walkDecls((declaration) => {
          if (!isIndependentMaterial(declaration.prop, declaration.value)) return
          const value = declaration.value.trim().replace(/\s+/g, ' ')
          const selector =
            declaration.parent?.type === 'rule'
              ? declaration.parent.selector.replace(/\s+/g, ' ')
              : (declaration.parent?.type ?? 'unknown')
          const key = JSON.stringify([name, selector, declaration.prop, value])
          const old = found.get(key)
          if (old) old.count++
          else found.set(key, { file: name, selector, property: declaration.prop, value, count: 1 })
        })
    }
  }
  await scan(directory)
  return [...found.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}
export function addedMaterialDeclarations(current: Finding[], baseline: Finding[]): Finding[] {
  const key = (finding: Finding): string =>
    JSON.stringify([finding.file, finding.selector, finding.property, finding.value])
  const counts = new Map(baseline.map((finding) => [key(finding), finding.count]))
  return current.filter((finding) => finding.count > (counts.get(key(finding)) ?? 0))
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = await scanMaterials()
  if (process.argv.includes('--capture-legacy')) {
    if (
      await readFile(baselinePath, 'utf8').then(
        () => true,
        () => false
      )
    )
      throw Error(
        'Legacy baseline already exists. Review migrations; never widen it automatically.'
      )
    await writeFile(
      baselinePath,
      `${JSON.stringify({ version: 1, purpose: 'Existing declaration fingerprints and occurrence limits. New declarations are forbidden.', ...materialBaseline(findings) }, null, 2)}\n`
    )
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as LegacyBaseline
    const added = findings.filter(
      (finding) => finding.count > (baseline.files[finding.file]?.[fingerprint(finding)] ?? 0)
    )
    if (added.length)
      throw Error(
        `Independent material declarations: consume a role or update the central contract.\n${JSON.stringify(added, null, 2)}`
      )
    console.log(
      `Material contract verified: ${MATERIAL_ROLES.length} roles; ${findings.length} tracked legacy declarations; no new independent recipes.`
    )
  }
}
