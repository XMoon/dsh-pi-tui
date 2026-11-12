/**
 * The Remote `SessionPolicyPort` (M6-1 F8): the shared neutral contract over
 * the package's ONE private `piTuiSessionPolicy` Client namespace and the
 * SAME Connection generation source every other Remote adapter fences on.
 *
 * Currentness (frozen plan §3.4):
 *
 * - `read` captures the generation OBJECT identity before dispatch; with no
 *   generation the read was not performed (`SupersededReadError`), and a
 *   result that settles after a replacement is superseded — never presented
 *   as the new Host's answer.
 * - `setApproval` validates the id/policy/generation BEFORE the one dispatch,
 *   brackets it with the SHARED accepted-write lifetime (the same counter the
 *   Remote ConfigPort reload gate reads), and classifies: a definite
 *   pre-invocation refusal (`gateway/bad-request`) is `refused`; everything
 *   that cannot prove the setter never ran — a lost ACK, `gateway/internal`,
 *   `gateway/cancelled`, a transport throw, `gateway/result-invalid` — is
 *   `unconfirmed`, never retried and never rendered as "not applied". A
 *   legitimate Host `applied` ACK stays `applied` even if the generation is
 *   replaced afterwards; only the old surface's PRESENTATION ownership ends.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-policy-remote
 */

import { SupersededReadError } from '../read-error.ts'
import type {
  ApprovalPolicy,
  SessionPolicyPort,
  SessionPolicyRead,
  SessionPolicySetOutcome,
} from '../session-policy-port.ts'
import type { PiTuiSessionPolicyNamespace } from './pi-tui-session-policy-contract.ts'
import type { RemoteConfigWriteLifetime } from './config-write-lifetime.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import { remoteFailureCode, remoteFailureMessage } from './write-failure.ts'

/** The mounted namespace, or the truthful capability refusal. */
function requireNamespace(namespace: PiTuiSessionPolicyNamespace | undefined): PiTuiSessionPolicyNamespace {
  if (namespace === undefined) {
    throw new Error(
      'the Remote backend cannot address session policy: the private piTuiSessionPolicy namespace is not mounted',
    )
  }
  return namespace
}

async function settled<T>(promise: Promise<RemoteResultLike<T>>): Promise<RemoteResultLike<T>> {
  return promise.catch((error: unknown): RemoteResultLike<T> => ({ ok: false, error }))
}

/** The Remote session-policy adapter. */
export class RemoteSessionPolicyPort implements SessionPolicyPort {
  private readonly namespace: PiTuiSessionPolicyNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource
  private readonly writeLifetime: RemoteConfigWriteLifetime

  constructor(
    namespace: PiTuiSessionPolicyNamespace | undefined,
    generation: RemoteConnectionGenerationSource,
    writeLifetime: RemoteConfigWriteLifetime,
  ) {
    this.namespace = namespace
    this.generation = generation
    this.writeLifetime = writeLifetime
  }

  async read(sessionId: string, signal?: AbortSignal): Promise<SessionPolicyRead> {
    signal?.throwIfAborted()
    const policy = requireNamespace(this.namespace)
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      throw new SupersededReadError('the session policy was not read: no current Connection generation')
    }
    const result = await settled(policy.read(sessionId, signal))
    // The fence runs BEFORE the result branch: an old success, an old failure
    // and an old empty value are all equally superseded.
    if (!Object.is(captured, this.generation.getSnapshot())) {
      throw new SupersededReadError('the session policy result belongs to a replaced Connection generation')
    }
    signal?.throwIfAborted()
    if (!result.ok) {
      throw new Error(`piTuiSessionPolicy.read failed: ${remoteFailureMessage(result.error)}`)
    }
    // The strict codec already validated the frame on the wire path; the
    // parsed value is returned untouched.
    return result.value
  }

  async setApproval(sessionId: string, policy: ApprovalPolicy, signal?: AbortSignal): Promise<SessionPolicySetOutcome> {
    signal?.throwIfAborted()
    if (sessionId === '') throw new Error('piTuiSessionPolicy.setApproval requires a non-empty session id')
    if (policy !== 'ask' && policy !== 'never') throw new Error('piTuiSessionPolicy.setApproval requires ask or never')
    const target = requireNamespace(this.namespace)
    // PRE-dispatch gate: with no current generation the write provably never
    // left (§9.3 pre-dispatch unavailable).
    if (this.generation.getSnapshot() === undefined) {
      throw new SupersededReadError('the session policy write was not dispatched: no current Connection generation')
    }
    const endWrite = this.writeLifetime.begin()
    try {
      const result = await settled(target.setApproval(sessionId, policy, signal))
      if (result.ok) return result.value
      const code = remoteFailureCode(result.error)
      const message = remoteFailureMessage(result.error)
      // `gateway/bad-request` is the gateway's own pre-invocation admission
      // refusal: the addressed method definitely did not run. Everything else
      // leaves the commit unproven.
      if (code === 'gateway/bad-request') {
        // A pre-invocation admission refusal: nothing was sent. The Host's
        // message rides the diagnostics, not the closed reason vocabulary.
        return { kind: 'refused', reason: 'invalid-request' }
      }
      return { kind: 'unconfirmed', reason: message }
    } finally {
      // Every path — success, definite refusal, unconfirmed — releases the
      // accepted-write lifetime exactly once.
      endWrite()
    }
  }
}
