/**
 * Pure projection rules for one package's extension-config `data` document.
 *
 * A package's Config carrier stores a single non-secret JSON `data` value.
 * Reads must hand consumers an owned JSON tree and must preserve the exact
 * distinction between an absent value, `null`, `false`, `0`, `[]` and `{}`
 * — never re-map any of them to a default. Writes are path edits relative to
 * `data` and are left to the official Settings validator as the only schema
 * authority.
 *
 * @module @xmoon76/dsh-pi-tui/domain/extension-config/data
 */

/** One successful or failed detached projection of a descriptor layer's data. */
export type ExtensionConfigDataProjection =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Distinguishes a non-JSON data projection from an absent `data` field. */
const INVALID_EXTENSION_CONFIG_DATA = Symbol('invalid-extension-config-data')

/** Detach one `data` projection into an owned JSON-only tree. */
function detach(value: unknown, seen: Set<object>): unknown | typeof INVALID_EXTENSION_CONFIG_DATA {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_EXTENSION_CONFIG_DATA
  if (typeof value !== 'object') return INVALID_EXTENSION_CONFIG_DATA
  if (seen.has(value)) return INVALID_EXTENSION_CONFIG_DATA
  seen.add(value)
  if (Array.isArray(value)) {
    const entries: unknown[] = []
    for (const entry of value) {
      const child = detach(entry, seen)
      if (child === INVALID_EXTENSION_CONFIG_DATA) return INVALID_EXTENSION_CONFIG_DATA
      entries.push(child)
    }
    seen.delete(value)
    return entries
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return INVALID_EXTENSION_CONFIG_DATA
  const detached: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const child = detach(entry, seen)
    if (child === INVALID_EXTENSION_CONFIG_DATA) return INVALID_EXTENSION_CONFIG_DATA
    Object.defineProperty(detached, key, { value: child, enumerable: true, writable: true, configurable: true })
  }
  seen.delete(value)
  return detached
}

/** Detach one caller-supplied Config value into an owned JSON-only tree. */
export function detachExtensionConfigValue(value: unknown): ExtensionConfigDataProjection {
  // An absent `data` field is a successful `undefined`, not a non-JSON value:
  // the carrier row is mountable with no document.
  if (value === undefined) return { kind: 'ok', value: undefined }
  const detached = detach(value, new Set())
  return detached === INVALID_EXTENSION_CONFIG_DATA
    ? { kind: 'invalid', reason: 'the extension configuration value is not JSON' }
    : { kind: 'ok', value: detached }
}

/**
 * Project one descriptor layer's `data` field into a detached JSON value.
 * An absent layer or absent `data` is a successful `undefined`; an unreadable
 * layer shape or non-JSON value is `invalid` (the caller reports `unreadable`).
 */
export function projectExtensionConfigData(layer: unknown): ExtensionConfigDataProjection {
  if (layer === undefined) return { kind: 'ok', value: undefined }
  if (typeof layer !== 'object' || layer === null || Array.isArray(layer)) {
    return { kind: 'invalid', reason: 'the official Host settings layer is not a plain form projection' }
  }
  return detachExtensionConfigValue(Reflect.get(layer, 'data'))
}

/**
 * The first non-JSON `set` value in one write batch, or undefined when every
 * caller value can cross the official Settings JSON boundary unchanged.
 *
 * This is a transport-boundary check, not a second schema: field names,
 * paths and volatility remain the official Settings validator's authority.
 * It exists so the Remote wire's JSON encoding cannot silently turn a Date,
 * Map, BigInt or cycle into a different stored value while Direct rejects it.
 */
export function extensionConfigDataOpsRejection(
  ops: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[],
): string | undefined {
  for (const op of ops) {
    if (op.op !== 'set') continue
    const detached = detachExtensionConfigValue(op.value)
    if (detached.kind === 'invalid') return detached.reason
  }
  return undefined
}

/** Whether one descriptor layer owns the `data` field (own-property presence,
 *  never value inequality). */
export function extensionConfigUserDataPresent(user: unknown): boolean {
  return typeof user === 'object' && user !== null && !Array.isArray(user) && Object.hasOwn(user, 'data')
}
