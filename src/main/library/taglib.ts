import { createRequire } from 'module'
import type * as Taglib from 'node-taglib-sharp'

export type { Taglib }

const require = createRequire(import.meta.url)
let taglib: typeof Taglib | null = null

/** node-taglib-sharp costs ~100 ms to load; only tag writes and downloads need it. */
export function loadTaglib(): typeof Taglib {
  taglib ??= require('node-taglib-sharp') as typeof Taglib
  return taglib
}
