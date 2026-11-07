import type { AutoMixSelection } from '../../shared/twilightAutoMix.ts'

export type AutoMixNativeSelect = (request: string) => Promise<AutoMixSelection>
export interface AutoMixMaterialExport {
  select(request: string, native: AutoMixNativeSelect): Promise<AutoMixSelection>
  release(selection?: AutoMixSelection): Promise<void>
}
/** A coordinated host owns member-specific tickets, exports and lifetimes.
 * The existing stem service supplies its normal worker/cache operations. */
export interface AutoMixMaterialHost {
  select(request: string, material: AutoMixMaterialExport): Promise<AutoMixSelection>
  prepare(selection: AutoMixSelection, prepare: (member: AutoMixSelection) => Promise<Record<string, unknown> | null>): Promise<Record<string, unknown> | null>
  release(selection?: AutoMixSelection): Promise<void>
}
