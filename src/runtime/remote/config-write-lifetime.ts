/**
 * The ONE accepted-write lifetime counter shared by the Remote configuration
 * port and the Remote session-policy port (M6-1 F8).
 *
 * Every write sink (the settings mirror's `mutate`, the credential reference
 * writes, the exact-Session approval-policy write) brackets its accepted work
 * with `begin()`; the Client reload safety gate reads `hasUnsettledWrites()`
 * so it can never retire the Client while a persisted write is still in
 * flight. Read-only calls never register. There is deliberately NO second
 * "configuration write in flight" fact anywhere else.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/config-write-lifetime
 */

export class RemoteConfigWriteLifetime {
  private pending = 0

  /** Register one accepted write; the returned release is idempotent. */
  begin(): () => void {
    this.pending += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.pending -= 1
    }
  }

  hasUnsettledWrites(): boolean {
    return this.pending > 0
  }
}
