/**
 * The Remote ACP listener control adapter: the semantic {@link AcpAccessPort}
 * over the package's ONE private `piTuiAcpAccess` Client namespace.
 *
 * The Host stays the only authority for the current listener state; this adapter
 * owns no truth, no cache and no optimistic update. Its only policy is
 * CURRENTNESS: the Connection generation is captured BEFORE dispatch and compared
 * after it, so a reply carried by a superseded generation is reported as a
 * superseded read instead of being presented as the new generation's definite
 * outcome. A side-effecting request is never replayed (an unknown-write after a
 * dispatch is never resent).
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/acp-access-remote
 */

import { SupersededReadError } from '../read-error.ts'
import type { AcpAccessPort, AcpAccessStatus } from '../acp-access-port.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/**
 * The private `piTuiAcpAccess` namespace slice this adapter calls. It is the
 * structural Client face the mounted contribution publishes; the concrete
 * methods are typed by the contract module's `TypertRemoteNamespaceMap`
 * augmentation.
 */
export interface RemoteAcpAccessNamespace {
  getStatus(): Promise<RemoteResultLike<AcpAccessStatus>>
  setEnabled(enabled: boolean): Promise<RemoteResultLike<AcpAccessStatus>>
}

/** One official result's business value, or its refusal thrown. */
function unwrap<T>(result: RemoteResultLike<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** The semantic ACP access port over the private Client namespace. */
export class RemoteAcpAccessPort implements AcpAccessPort {
  private readonly namespace: RemoteAcpAccessNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    namespace: RemoteAcpAccessNamespace | undefined,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespace = namespace
    this.generation = generation
  }

  async getStatus(): Promise<AcpAccessStatus> {
    return this.fenced('status', namespace => namespace.getStatus())
  }

  async setEnabled(enabled: boolean): Promise<AcpAccessStatus> {
    return this.fenced('toggle', namespace => namespace.setEnabled(enabled))
  }

  /**
   * One Remote call fenced to the Connection generation captured BEFORE
   * dispatch. The namespace is mounted by the Client contribution; a Host or
   * connection without it is a definite unavailable, never a Direct fallback.
   */
  private async fenced<T>(
    operation: string,
    call: (namespace: RemoteAcpAccessNamespace) => Promise<RemoteResultLike<T>>,
  ): Promise<T> {
    const namespace = this.namespace
    if (namespace === undefined) {
      throw new Error('acp access: the piTuiAcpAccess Remote namespace is not mounted')
    }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      throw new Error('acp access: the Client is not connected to a Host')
    }
    const stillCurrent = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let value: T
    try {
      value = unwrap(await call(namespace))
    } catch (error) {
      // A refusal and a transport rejection are just as generation-bound as a
      // success: a stale failure must never be presented as the new
      // generation's definite state.
      if (!stillCurrent()) throw new SupersededReadError(`acp access ${operation} superseded`)
      throw error
    }
    if (!stillCurrent()) throw new SupersededReadError(`acp access ${operation} superseded`)
    return value
  }
}
