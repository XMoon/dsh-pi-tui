/** Pure provider/model directory projection shared by the staged Subagent
 * settings page. The Host-owned Settings writer lives behind ConfigPort. */
import type { ModelDirectoryDto } from '../../runtime/catalog-port.ts'
import type { SubagentAllowedModelRoute } from '../../runtime/config-port.ts'

/** Format the outer settings row's value for one allowlist state. */
export function allowlistSummary(routes: readonly SubagentAllowedModelRoute[]): string {
  return routes.length === 1 ? '1 route' : `${routes.length} routes`
}

/** Whether toggling `route` would violate the official "enabled requires
 *  at least one route" rule (removing the last route while enabled). */
export function lastRouteWhileEnabled(
  enabled: boolean,
  routes: readonly SubagentAllowedModelRoute[],
  route: SubagentAllowedModelRoute,
): boolean {
  return enabled
    && routes.length === 1
    && routes[0]!.provider === route.provider
    && routes[0]!.model === route.model
}

/** One flattened, identity-complete model presentation row. */
export interface SubagentAllowlistModelRow {
  readonly providerId: string
  readonly providerName: string
  readonly modelId: string
  readonly modelName?: string
  readonly allowed: boolean
  /** Present only when the row exists because the allowlist carries the
   *  route (still removable). `absent` = a READY directory that loaded this
   *  provider provably does not list it; the other values say the catalog
   *  authority could NOT answer — absence is never claimed from a loading,
   *  failed, or provider-failed catalog. */
  readonly savedRoute?: 'absent' | 'catalog-loading' | 'catalog-unavailable' | 'provider-unavailable'
}

/** The catalog authority state behind the rows — the distinction that keeps
 *  "not in the current catalog" a provable claim instead of a guess. */
export type AllowlistCatalogState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly directory: ModelDirectoryDto }
  | { readonly state: 'failed'; readonly reason: string }

/** One provider whose directory group failed to load; inert in the list. */
export interface SubagentAllowlistFailureRow {
  readonly providerId: string
  readonly providerName: string
  readonly message: string
}

export interface SubagentAllowlistProjection {
  readonly models: readonly SubagentAllowlistModelRow[]
  readonly failures: readonly SubagentAllowlistFailureRow[]
}

/** Full logical identity of an allowlist route. Model ids are not globally
 *  unique, so `(provider, model)` is the only safe key. */
export function allowlistRouteKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`
}

/**
 * Project the official model directory into identity-complete presentation
 * rows in CATALOG ORDER (provider group order × model order), plus one
 * removable trailing row per SAVED route the directory does not list. The
 * allowlist is a saved row's only source; WHICH saved-row note it carries is
 * decided by the catalog authority state: only a READY directory that loaded
 * the route's provider can claim `absent` — a loading catalog, a failed
 * whole-directory read, or a provider-side group failure renders the route
 * as saved WITHOUT the absence claim. Pure — unit testable.
 */
export function projectSubagentAllowlist(input: {
  catalog: AllowlistCatalogState
  allowed: readonly SubagentAllowedModelRoute[]
}): SubagentAllowlistProjection {
  const models: SubagentAllowlistModelRow[] = []
  const failures: SubagentAllowlistFailureRow[] = []
  const listed = new Set<string>()
  const failedProviders = new Set<string>()
  const catalog = input.catalog
  if (catalog.state === 'failed') {
    failures.push({ providerId: 'model-directory', providerName: 'Model directory', message: catalog.reason })
  }
  if (catalog.state === 'ready') {
    for (const failure of catalog.directory.failures) {
      failedProviders.add(failure.id)
      failures.push({ providerId: failure.id, providerName: failure.name, message: failure.message })
    }
    for (const group of catalog.directory.groups) {
      for (const model of group.models) {
        listed.add(allowlistRouteKey(group.id, model.id))
        models.push({
          providerId: group.id,
          providerName: group.name === '' ? group.id : group.name,
          modelId: model.id,
          ...model.name === undefined || model.name === '' ? {} : { modelName: model.name },
          // Full (provider, model) identity: a same-id model under another
          // provider must never inherit the allowed marker.
          allowed: input.allowed.some(route => route.provider === group.id && route.model === model.id),
        })
      }
    }
  }
  for (const route of input.allowed) {
    if (listed.has(allowlistRouteKey(route.provider, route.model))) continue
    models.push({
      providerId: route.provider,
      providerName: route.provider,
      modelId: route.model,
      allowed: true,
      savedRoute: catalog.state === 'loading'
        ? 'catalog-loading'
        : catalog.state === 'failed'
          ? 'catalog-unavailable'
          : failedProviders.has(route.provider)
            ? 'provider-unavailable'
            : 'absent',
    })
  }
  return { models, failures }
}
