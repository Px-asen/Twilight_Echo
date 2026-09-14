import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { extname } from 'node:path'

const renderer = new URL('../src/renderer/src/', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@renderer/')) return nextResolve(specifier, context)
    const path = specifier.slice('@renderer/'.length)
    let url = new URL(path, renderer)
    if (!extname(path)) {
      url = new URL(`${path}.ts`, renderer)
      if (!existsSync(url)) url = new URL(`${path}/index.ts`, renderer)
    }
    return nextResolve(url.href, context)
  }
})
