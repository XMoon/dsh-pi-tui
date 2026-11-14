/**
 * The private `piTuiAcpAccess` Host service — the ONE facade the Client reaches
 * to read or toggle the local Host ACP v1 Unix socket listener.
 *
 * ```text
 * service    piTuiAcpAccess                       (Host Cordis service key)
 * authority  the Host-entry-owned ACP runtime controller (piTuiAcpOwner)
 * methods    getStatus() / setEnabled(enabled)    (see the contract module)
 * ```
 *
 * This service owns NO socket, no scope and no enabled flag: the SINGLE socket
 * owner stays the Host entry's runtime controller (it must NOT live in a
 * business Fiber that a profile recomposition could dispose). Every call reads
 * the CURRENT controller from the root Host Context (`ctx.reflect.get`) and
 * forwards strictly; there is no lifecycle here, no independent shutdown and no
 * Scope algorithm. A Host without an installed owner (Direct, or a Split Host
 * before the entry provides it) answers `unavailable` and never starts a Host or
 * a second listener.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/acp-access
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  PI_TUI_ACP_ACCESS_NAMESPACE,
  type PiTuiAcpAccessStatus,
} from '../../../runtime/remote/pi-tui-acp-access-contract.ts'

/**
 * The Host-entry-owned controller this facade forwards to. It is a structural
 * view of the entry-local object provided as the `piTuiAcpOwner` Cordis value;
 * the entry keeps the real socket owner, the serialized mutation chain and the
 * synchronous quiescing latch. This service never imports that module (the
 * dependency direction stays app/host/features -> runtime/remote contract).
 */
export interface AcpOwnerLike {
  getStatus(): Promise<PiTuiAcpAccessStatus>
  setEnabled(enabled: boolean): Promise<PiTuiAcpAccessStatus>
}

/** The fixed, redacted reason a Host with no controller reports. */
const NO_OWNER_REASON = 'the local ACP listener controller is not available on this Host'

/**
 * The private ACP listener control facade. One instance per built-in Host
 * Runtime; it leaves with the owning fiber. It holds no runtime state: every
 * method resolves the CURRENT controller from the root Context per call.
 */
export class PiTuiAcpAccessHostService extends TypertRemoteService {
  /** The Typert registry owns the descriptors; the owner is read per call. */
  static readonly inject = ['typert']

  /**
   * @param ctx - the Host context this row is mounted in.
   */
  constructor(ctx: Context) {
    super(ctx, PI_TUI_ACP_ACCESS_NAMESPACE)
  }

  /**
   * The private status method (`piTuiAcpAccess/getStatus`). Reads the current
   * controller's live listener fact on every call; never a cached flag.
   */
  async getStatus(): Promise<PiTuiAcpAccessStatus> {
    const owner = this.owner()
    if (owner === undefined) return { state: 'unavailable', reason: NO_OWNER_REASON }
    return owner.getStatus()
  }

  /**
   * The private mutation method (`piTuiAcpAccess/setEnabled`). Forwards to the
   * ONE entry-owned controller, which serializes bind/close and reports the
   * reached state. A rejected enable (unsafe inode / socket in use / system
   * failure) rejects here and never fabricates `enabled`.
   *
   * @param enabled - whether the local ACP listener must be serving.
   * @returns the status the Host actually reached, never the requested boolean.
   */
  async setEnabled(enabled: boolean): Promise<PiTuiAcpAccessStatus> {
    const owner = this.owner()
    if (owner === undefined) return { state: 'unavailable', reason: NO_OWNER_REASON }
    return owner.setEnabled(enabled)
  }

  /** Read the current entry-owned controller from the root Host Context. */
  private owner(): AcpOwnerLike | undefined {
    return this.ctx.reflect.get('piTuiAcpOwner') as AcpOwnerLike | undefined
  }
}
