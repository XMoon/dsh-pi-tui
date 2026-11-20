/**
 * The ONE Client-local extension entry identity.
 *
 * A Client-mounted external `./tui` package uses a deterministic Loader entry
 * id derived from its validated profile Config row id:
 * `pi-tui-client-` + the same 32 lowercase hex characters. Keeping the
 * derivation neutral lets the mount owner and the Host Plugin Manager
 * projection agree without either layer importing the other.
 *
 * @module @xmoon76/dsh-pi-tui/domain/extension-config/client-entry
 */

/** The stable Client entry-id prefix. */
export const CLIENT_EXTENSION_ENTRY_PREFIX = 'pi-tui-client-'
/** The profile Config row prefix whose suffix IS the package hash. */
export const EXTENSION_CONFIG_ROW_PREFIX = 'pi-tui-extcfg-'
const HASH_SUFFIX = /^[0-9a-f]{32}$/u

/**
 * Derive the only allowed Client entry id for one validated Config row id.
 *
 * @param configRowId - the package's `pi-tui-extcfg-<32 hex>` row id.
 * @returns the matching `pi-tui-client-<32 hex>` Loader entry id.
 */
export function clientExtensionEntryId(configRowId: string): string {
  if (!configRowId.startsWith(EXTENSION_CONFIG_ROW_PREFIX)) {
    throw new Error(`client extension: invalid Config row id "${configRowId}"`)
  }
  const suffix = configRowId.slice(EXTENSION_CONFIG_ROW_PREFIX.length)
  if (!HASH_SUFFIX.test(suffix)) {
    throw new Error(`client extension: invalid Config row id hash "${configRowId}"`)
  }
  return `${CLIENT_EXTENSION_ENTRY_PREFIX}${suffix}`
}

/** Whether one Loader entry id is a Client-local ephemeral extension entry. */
export function isClientExtensionEntryId(entryId: string): boolean {
  if (!entryId.startsWith(CLIENT_EXTENSION_ENTRY_PREFIX)) return false
  return HASH_SUFFIX.test(entryId.slice(CLIENT_EXTENSION_ENTRY_PREFIX.length))
}
