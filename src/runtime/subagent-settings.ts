import type {
  SubagentLimits,
  SubagentModelSelection,
  SubagentAllowedModelRoute,
} from './config-port.ts'

/** Detached typed projections of the official Host-owned Settings sections. */
export interface SubagentSectionProjection<T extends object> {
  readonly effective: T
  readonly inherited: T
  readonly overridden: Readonly<Record<keyof T, boolean>>
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined
}

function validLimits(value: Record<string, unknown>): value is Record<'maxDepth' | 'maxActiveSubagents', number> {
  return Object.hasOwn(value, 'maxDepth')
    && typeof value.maxDepth === 'number'
    && Number.isSafeInteger(value.maxDepth)
    && value.maxDepth >= 0
    && Object.hasOwn(value, 'maxActiveSubagents')
    && typeof value.maxActiveSubagents === 'number'
    && Number.isSafeInteger(value.maxActiveSubagents)
    && value.maxActiveSubagents >= 1
}

function routesOf(value: unknown): readonly SubagentAllowedModelRoute[] | undefined {
  if (!Array.isArray(value)) return undefined
  const routes: SubagentAllowedModelRoute[] = []
  for (const item of value) {
    const route = plainRecord(item)
    if (route === undefined || typeof route.provider !== 'string' || route.provider.length === 0
      || typeof route.model !== 'string' || route.model.length === 0) return undefined
    routes.push(Object.freeze({ provider: route.provider, model: route.model }))
  }
  return Object.freeze(routes)
}

function modelSelectionOf(value: Record<string, unknown>): SubagentModelSelection | undefined {
  if (!Object.hasOwn(value, 'enabled') || typeof value.enabled !== 'boolean') return undefined
  const allowedModels = routesOf(value.allowedModels)
  if (allowedModels === undefined) return undefined
  return Object.freeze({ enabled: value.enabled, allowedModels })
}

function sameRoutes(
  left: readonly SubagentAllowedModelRoute[],
  right: readonly SubagentAllowedModelRoute[],
): boolean {
  return left.length === right.length && left.every((route, index) =>
    route.provider === right[index]?.provider && route.model === right[index]?.model)
}

export function projectSubagentLimits(
  effectiveValue: unknown,
  inheritedValue: unknown,
): SubagentSectionProjection<SubagentLimits> | undefined {
  const effectiveRecord = plainRecord(effectiveValue)
  const inheritedRecord = plainRecord(inheritedValue)
  if (effectiveRecord === undefined || inheritedRecord === undefined
    || !validLimits(effectiveRecord) || !validLimits(inheritedRecord)) return undefined

  const effective = Object.freeze({
    maxDepth: effectiveRecord.maxDepth,
    maxActiveSubagents: effectiveRecord.maxActiveSubagents,
  })
  const inherited = Object.freeze({
    maxDepth: inheritedRecord.maxDepth,
    maxActiveSubagents: inheritedRecord.maxActiveSubagents,
  })
  return Object.freeze({
    effective,
    inherited,
    overridden: Object.freeze({
      maxDepth: effective.maxDepth !== inherited.maxDepth,
      maxActiveSubagents: effective.maxActiveSubagents !== inherited.maxActiveSubagents,
    }),
  })
}

export function projectSubagentModelSelection(
  effectiveValue: unknown,
  inheritedValue: unknown,
): SubagentSectionProjection<SubagentModelSelection> | undefined {
  const effectiveRecord = plainRecord(effectiveValue)
  const inheritedRecord = plainRecord(inheritedValue)
  if (effectiveRecord === undefined || inheritedRecord === undefined) return undefined
  const effective = modelSelectionOf(effectiveRecord)
  const inherited = modelSelectionOf(inheritedRecord)
  if (effective === undefined || inherited === undefined) return undefined
  return Object.freeze({
    effective,
    inherited,
    overridden: Object.freeze({
      enabled: effective.enabled !== inherited.enabled,
      allowedModels: !sameRoutes(effective.allowedModels, inherited.allowedModels),
    }),
  })
}
