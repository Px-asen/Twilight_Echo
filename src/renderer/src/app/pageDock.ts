import {
  computed,
  inject,
  onScopeDispose,
  provide,
  shallowReactive,
  toValue,
  type InjectionKey,
  type MaybeRefOrGetter
} from 'vue'
import type { ThemeIconSlot } from '../../../shared/theme.ts'

export interface PageDockAction {
  id: string
  label: string
  icon: ThemeIconSlot
  disabled?: boolean
  pressed?: boolean
  run: () => unknown
}

interface PageDockRegistration {
  scope: MaybeRefOrGetter<string>
  actions: MaybeRefOrGetter<readonly PageDockAction[]>
  enabled: MaybeRefOrGetter<boolean>
}

export function createPageDockRegistry(activeScope: MaybeRefOrGetter<string>) {
  const registrations = shallowReactive(new Map<symbol, PageDockRegistration>())
  const actions = computed(() => {
    const visible = new Map<string, PageDockAction>()
    for (const registration of registrations.values()) {
      if (!toValue(registration.enabled) || toValue(registration.scope) !== toValue(activeScope))
        continue
      for (const action of toValue(registration.actions)) visible.set(action.id, action)
    }
    return [...visible.values()]
  })
  return {
    actions,
    register(registration: PageDockRegistration): () => void {
      const owner = Symbol('page-dock')
      registrations.set(owner, registration)
      return () => registrations.delete(owner)
    }
  }
}

const pageDockKey: InjectionKey<ReturnType<typeof createPageDockRegistry>> = Symbol('page-dock')

export function providePageDock(activeScope: MaybeRefOrGetter<string>) {
  const registry = createPageDockRegistry(activeScope)
  provide(pageDockKey, registry)
  return registry
}

export function usePageDock(
  scope: MaybeRefOrGetter<string>,
  actions: MaybeRefOrGetter<readonly PageDockAction[]>,
  enabled: MaybeRefOrGetter<boolean> = true
): void {
  const registry = inject(pageDockKey, null)
  if (!registry) return
  onScopeDispose(registry.register({ scope, actions, enabled }))
}
