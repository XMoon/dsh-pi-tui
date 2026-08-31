/**
 * Pure Session model-selection policy.
 *
 * A model choice has two different representations in a Session log:
 * `model/selection` records a pending user intent, while `request/header`
 * records the configuration actually used by a request.  Keeping this fold
 * independent of Cordis and Host services lets Direct and future Remote
 * adapters share the same ownership rules without importing DSH internals.
 *
 * @module @xmoon76/dsh-pi-tui/model-selection
 */

/** Detached provider/model/effort data used at the semantic boundary. */
export interface ModelSelectionValue {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The durable model-selection state at one Session event cursor. */
export interface FoldedModelSelection {
  /** The latest request's effective, user-visible selection. */
  readonly lastUsed?: ModelSelectionValue
  /** A later selection intent not consumed by a matching request header. */
  readonly pending?: ModelSelectionValue
}

/** A structural request header shape; the concrete DSH header stays out of this module. */
interface RequestHeaderLike {
  readonly config?: unknown
  readonly adapterDefaults?: unknown
}

/** A structural Session event shape; this remains compatible with older DSH declarations. */
interface SessionEventLike {
  readonly type?: unknown
  readonly data?: unknown
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * Normalize untrusted event data into a detached model-selection value.
 * Provider and model identifiers are intentionally not trimmed: whitespace is
 * part of an identifier if a provider elected to use it.
 */
export function normalizeModelSelection(value: unknown): ModelSelectionValue | undefined {
  const record = recordOf(value)
  if (record === undefined || typeof record.provider !== 'string' || record.provider.length === 0
    || typeof record.model !== 'string' || record.model.length === 0) return undefined
  if (record.reasoningEffort === undefined || record.reasoningEffort === null) {
    return { provider: record.provider, model: record.model }
  }
  if (typeof record.reasoningEffort !== 'string' || record.reasoningEffort.length === 0) return undefined
  return {
    provider: record.provider,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
  }
}

/** Compare provider, model, and the presence/value of reasoning effort.
 *  Defensive by contract: malformed runtime values (null, non-objects) are
 *  never equal to anything, so untrusted event data cannot throw here. */
export function sameModelSelection(
  left: ModelSelectionValue | undefined,
  right: ModelSelectionValue | undefined,
): boolean {
  if (left === undefined || right === undefined) return false
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function requestConfig(header: unknown): Record<string, unknown> | undefined {
  const headerRecord = recordOf(header)
  return headerRecord === undefined ? undefined : recordOf(headerRecord.config)
}

function adapterDefaultedReasoning(header: unknown): boolean {
  const headerRecord = recordOf(header)
  const defaults = recordOf(headerRecord?.adapterDefaults)
  return defaults?.reasoningEffort === true
}

/**
 * Read the raw selection used for pending-intent matching.  This intentionally
 * keeps an adapter-generated effort: consumption compares the exact request
 * header fields, not the sanitized user-facing representation.
 */
export function rawSelectionFromRequestHeader(header: unknown): ModelSelectionValue | undefined {
  const config = requestConfig(header)
  if (config === undefined || typeof config.provider !== 'string' || config.provider.length === 0
    || typeof config.model !== 'string' || config.model.length === 0) return undefined
  if (config.reasoningEffort === undefined || config.reasoningEffort === null) {
    return { provider: config.provider, model: config.model }
  }
  if (typeof config.reasoningEffort !== 'string' || config.reasoningEffort.length === 0) return undefined
  return {
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  }
}

/**
 * Read the effective selection for the Session UI.  An effort materialized by
 * the adapter's default is not an explicit Session choice and is therefore
 * omitted from the restored value.
 */
export function selectionFromRequestHeader(header: unknown): ModelSelectionValue | undefined {
  const raw = rawSelectionFromRequestHeader(header)
  if (raw === undefined || adapterDefaultedReasoning(header)) return raw === undefined
    ? undefined
    : { provider: raw.provider, model: raw.model }
  return raw
}

/** Fold durable pending intents and request headers in event order. */
export function foldPendingModelSelection(events: readonly unknown[]): FoldedModelSelection {
  let pending: ModelSelectionValue | undefined
  let lastUsed: ModelSelectionValue | undefined

  for (const event of events) {
    const candidate = recordOf(event) as SessionEventLike | undefined
    if (candidate?.type === 'model/selection') {
      const next = normalizeModelSelection(candidate.data)
      if (next !== undefined) pending = next
      continue
    }
    if (candidate?.type !== 'request/header') continue
    const data = recordOf(candidate.data)
    const header = data?.header as RequestHeaderLike | undefined
    const effective = selectionFromRequestHeader(header)
    const raw = rawSelectionFromRequestHeader(header)
    if (effective !== undefined) lastUsed = effective
    if (sameModelSelection(pending, raw)) pending = undefined
  }

  return {
    ...lastUsed === undefined ? {} : { lastUsed },
    ...pending === undefined ? {} : { pending },
  }
}

/** Alias spelling for callers that want to emphasize the complete fold result. */
export const foldModelSelection = foldPendingModelSelection

/** Clone a detached value so a Host-owned selection cannot cross the boundary by alias. */
export function copyModelSelection(value: ModelSelectionValue | undefined): ModelSelectionValue | undefined {
  return value === undefined
    ? undefined
    : {
        provider: value.provider,
        model: value.model,
        ...value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort },
      }
}
