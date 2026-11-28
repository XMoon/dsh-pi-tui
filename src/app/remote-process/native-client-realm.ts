/**
 * One Native Client composition per Node realm.
 *
 * The reservation is process-local and is created before any installed-runtime
 * import, discovery read, authentication or Context construction. It is not a
 * Host lock and says nothing about another process; it only prevents two public
 * headless compositions from racing in the same realm.
 */

const REALM_STATE_KEY = Symbol.for('@xmoon76/dsh-pi-tui/native-client-realm')
const realm = globalThis as unknown as Record<symbol, { activeReservation?: symbol }>
const realmState = realm[REALM_STATE_KEY] ??= {}

export function reserveNativeClientRealm(): () => void {
  if (realmState.activeReservation !== undefined) {
    throw Object.assign(new Error('native-client: another attach is active in this Node realm'), {
      code: 'NATIVE_CLIENT_REALM_BUSY',
    })
  }
  const token = Symbol('native-client-realm')
  realmState.activeReservation = token
  let released = false
  return () => {
    if (released) return
    released = true
    if (realmState.activeReservation === token) realmState.activeReservation = undefined
  }
}

/** Release the realm only after the caller's Client-owned cleanup has settled successfully. */
export async function completeNativeClientRealm(release: () => void, cleanup: () => Promise<void>): Promise<void> {
  await cleanup()
  release()
}
