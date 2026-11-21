/**
 * The Remote Web frontend control adapter (M5-W PR-C): the semantic
 * {@link WebAccessPort} over the package's ONE private `piTuiWebAccess` Client
 * namespace.
 *
 * The Host stays the only authority for the current Web state and for the
 * official launch URL; this adapter owns no truth, no cache and no optimistic
 * update. Its only policy is CURRENTNESS: the Connection generation is captured
 * BEFORE dispatch and compared after it, so a reply carried by a superseded
 * generation is reported as a superseded read instead of being presented as the
 * new generation's definite outcome. A side-effecting request is never replayed.
 *
 * The authenticated URL is deliberately not logged, not redacted into a
 * diagnostic and not retained: the caller is one explicit user action.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/web-access-remote
 */

import { SupersededReadError } from '../read-error.ts'
import type { WebAccessPort, WebAccessStatus, WebAccessUrl } from '../web-access-port.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/**
 * The private `piTuiWebAccess` namespace slice this adapter calls. It is the
 * structural Client face the mounted contribution publishes; the concrete
 * methods are typed by the contract module's `TypertRemoteNamespaceMap`
 * augmentation.
 */
export interface RemoteWebAccessNamespace {
  getStatus(): Promise<RemoteResultLike<WebAccessStatus>>
  setEnabled(enabled: boolean): Promise<RemoteResultLike<WebAccessStatus>>
  getAuthenticatedUrl(): Promise<RemoteResultLike<WebAccessUrl>>
}

/** One official result's business value, or its refusal thrown. */
function unwrap<T>(result: RemoteResultLike<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/** The semantic Web access port over the private Client namespace. */
export class RemoteWebAccessPort implements WebAccessPort {
  private readonly namespace: RemoteWebAccessNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    namespace: RemoteWebAccessNamespace | undefined,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespace = namespace
    this.generation = generation
  }

  async getStatus(): Promise<WebAccessStatus> {
    return this.fenced('status', namespace => namespace.getStatus())
  }

  async setEnabled(enabled: boolean): Promise<WebAccessStatus> {
    return this.fenced('toggle', namespace => namespace.setEnabled(enabled))
  }

  async getAuthenticatedUrl(): Promise<WebAccessUrl> {
    return this.fenced('link', namespace => namespace.getAuthenticatedUrl())
  }

  /**
   * One Remote call fenced to the Connection generation captured BEFORE
   * dispatch. The namespace is mounted by the Client contribution; a Host or
   * connection without it is a definite unavailable, never a Direct fallback.
   */
  private async fenced<T>(
    operation: string,
    call: (namespace: RemoteWebAccessNamespace) => Promise<RemoteResultLike<T>>,
  ): Promise<T> {
    const namespace = this.namespace
    if (namespace === undefined) {
      throw new Error('web access: the piTuiWebAccess Remote namespace is not mounted')
    }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      throw new Error('web access: the Client is not connected to a Host')
    }
    const stillCurrent = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let value: T
    try {
      value = unwrap(await call(namespace))
    } catch (error) {
      // A refusal and a transport rejection are just as generation-bound as a
      // success: a stale failure must never be presented as the new
      // generation's definite state.
      if (!stillCurrent()) throw new SupersededReadError(`web access ${operation} superseded`)
      throw error
    }
    if (!stillCurrent()) throw new SupersededReadError(`web access ${operation} superseded`)
    return value
  }
}
