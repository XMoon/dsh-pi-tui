/**
 * One Native Client composition per Node realm.
 *
 * The reservation is process-local and is created before any installed-runtime
 * import, discovery read, authentication or Context construction. It is not a
 * Host lock and says nothing about another process; it only prevents two public
 * headless compositions from racing in the same realm.
 */

let activeReservation: symbol | undefined

export function reserveNativeClientRealm(): () => void {
  if (activeReservation !== undefined) {
    throw Object.assign(new Error('native-client: another attach is active in this Node realm'), {
      code: 'NATIVE_CLIENT_REALM_BUSY',
    })
  }
  const token = Symbol('native-client-realm')
  activeReservation = token
  let released = false
  return () => {
    if (released) return
    released = true
    if (activeReservation === token) activeReservation = undefined
  }
}
