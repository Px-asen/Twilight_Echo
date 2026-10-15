import { readFile, writeFile } from 'node:fs/promises'
import { compileMaterialCss, materialContract } from '../src/shared/materials.ts'
const outputs = [
  ['../src/renderer/src/assets/materials.css', compileMaterialCss()],
  [
    '../packages/plugin-api/material-contract.json',
    `${JSON.stringify(materialContract(), null, 2)}\n`
  ]
] as const
for (const [path, content] of outputs) {
  const target = new URL(path, import.meta.url)
  if (process.argv.includes('--check')) {
    if ((await readFile(target, 'utf8').catch(() => '')) !== content)
      throw Error(`Stale material contract: ${path}; run generate:materials`)
  } else await writeFile(target, content, 'utf8')
}
