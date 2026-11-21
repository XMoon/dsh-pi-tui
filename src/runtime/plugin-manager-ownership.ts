/**
 * Process-local ownership registry for Direct Client-local `./tui` Loader
 * entries.
 *
 * The Host Plugin Manager projection may only hide entries that the actual
 * Client mount owner created; an arbitrary profile/Host row whose id merely
 * looks like `pi-tui-client-<32 hex>` must stay visible and manageable. The
 * owner marks an entry after a successful `loader.create`, unmarks it after
 * the official Loader removal, and the Direct Plugin Manager adapter reads
 * exactly that live set for its current Loader instance.
 *
 * The registry is intentionally process-local and WeakMap-scoped: it is not a
 * second Host inventory, not persisted, and never crosses the wire.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/plugin-manager-ownership
 */

import { symbols } from '@deepseek-ai/cordis'

const OWNED = new WeakMap<object, Set<string>>()

/** Normalize a Cordis service proxy to its ONE underlying loader object. */
function loaderIdentity(loader: object): object {
  const original = (loader as unknown as Record<symbol, object | undefined>)[symbols.original]
  return original ?? loader
}

/** Mark one entry as created by the CURRENT Client mount owner. */
export function markOwnedClientExtensionEntry(loader: object, entryId: string): void {
  const key = loaderIdentity(loader)
  let entries = OWNED.get(key)
  if (entries === undefined) {
    entries = new Set()
    OWNED.set(key, entries)
  }
  entries.add(entryId)
}

/** Remove one entry from the current Client mount owner's set. */
export function unmarkOwnedClientExtensionEntry(loader: object, entryId: string): void {
  OWNED.get(loaderIdentity(loader))?.delete(entryId)
}

/**
 * The exact ids owned by a Client mount owner on this Loader, or `undefined`
 * when the Process has no loader service.
 */
export function ownedClientExtensionEntryIds(loader: object | undefined): ReadonlySet<string> | undefined {
  if (loader === undefined) return undefined
  return OWNED.get(loaderIdentity(loader))
}
