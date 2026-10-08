/**
 * The Remote terminal-progress Client source (plan R2 §7.1): the ONE narrow
 * adapter that turns the private Host evidence stream into neutral
 * `RemoteMainProgressFact`s for the Surface.
 *
 * It owns exactly the transport side of the contract — the exact Connection
 * generation and retained Session binding captured when the watch opens, the
 * structural validation of every frame (the framework does NOT apply the
 * descriptor's result codec to stream downlink items, see the contract module),
 * and the `hostEpoch`/`agentEpoch`/`revision` fencing. It does NOT classify
 * outcomes: the Host already owns that, with the SAME shared interval fold the
 * Direct branch uses.
 *
 * Snapshot provenance (plan §6.3): a watch ALWAYS opens with the authoritative
 * snapshot of the instant it subscribed, but a snapshot may only carry a
 * `done`/`error` when it CONTINUES an interval this Client already observed —
 * same `hostEpoch` + same `agentEpoch` as the last accepted frame. Any other
 * snapshot is honestly `idle` (a new binding must never inherit a historical
 * result it cannot prove), so the Surface never displays a stale completion
 * and the completion controller is never fed by an opening snapshot.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/terminal-progress-source
 */

import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { TerminalProgressOutcome } from '../../domain/terminal-progress/settings.ts'
import {
  parsePiTuiTerminalProgressFrame,
  type PiTuiTerminalProgressFrame,
} from '../../runtime/remote/pi-tui-terminal-progress-contract.ts'
import type { RemoteMainProgressFact } from '../application-runtime.ts'

/** The private Remote namespace the Client `$mount`ed. */
interface PiTuiTerminalProgressRemoteFace {
  readonly piTuiTerminalProgress: {
    watch(sessionId: string, signal?: AbortSignal): RemoteStreamHandle<PiTuiTerminalProgressFrame, never>
  }
}

/** The exact transport identity one watch is authorized under. */
export interface RemoteTerminalProgressSourceDeps {
  /** The typed Remote face carrying `piTuiTerminalProgress` (the augmented `ctx.remote`). */
  readonly remote: PiTuiTerminalProgressRemoteFace
  /** The official Connection generation source (captured per watch). */
  readonly generation: { getSnapshot(): unknown }
  /** The official retained Session binding (`undefined` when not retained). */
  binding(sessionId: string): object | undefined
}

/** The neutral Remote progress source the bootstrap consumes. */
export interface RemoteTerminalProgressSource {
  /**
   * Open the ONE Host evidence stream of one session. The caller owns the
   * iteration (and therefore its cancellation): aborting `signal` cancels the
   * Host stream, breaking out of the loop does the same, and the stream ends
   * when the Host retires it (Agent disposal, Host fiber teardown).
   * @throws when a frame violates the contract or the transport identity moved.
   */
  open(sessionId: string, signal: AbortSignal): AsyncIterable<RemoteMainProgressFact>
}

/** One accepted frame: the provenance the next frame is judged against. */
interface AcceptedState {
  readonly sessionId: string
  readonly hostEpoch: string
  readonly agentEpoch: number
  readonly revision: number
}

/**
 * Assemble the source over the ONE Remote Client graph. It constructs no
 * Client, owns no subscription of its own, and retains only the provenance of
 * the last accepted frame of the last watch (per session), so a reconnect can
 * recognise the interval it already observed without ever inventing one.
 */
export function createRemoteTerminalProgressSource(
  deps: RemoteTerminalProgressSourceDeps,
): RemoteTerminalProgressSource {
  /** The last accepted frame of the last watch, per session (one main session
   *  owner per source instance). */
  let accepted: AcceptedState | undefined

  /**
   * The snapshot outcome rule: only a frame continuing the interval this Client
   * already observed (same `hostEpoch` + same `agentEpoch`) may carry a proven
   * `done`/`error`; everything else is honestly `idle`.
   */
  const snapshotOutcome = (frame: PiTuiTerminalProgressFrame, previous: AcceptedState | undefined): TerminalProgressOutcome => {
    if (previous === undefined) return 'idle'
    if (previous.hostEpoch !== frame.hostEpoch || previous.agentEpoch !== frame.agentEpoch) return 'idle'
    if (frame.revision < previous.revision) {
      throw new Error(`the Remote terminal-progress stream of ${frame.sessionId} moved its revision backwards`)
    }
    return frame.outcome
  }

  /**
   * Judge one frame against the accepted provenance.
   * @param opened - whether this watch already delivered its opening baseline.
   * @returns the fact to publish, or `undefined` for a frame that must be dropped.
   * @throws when the stream cannot be interpreted at all.
   */
  const acceptFrame = (
    frame: PiTuiTerminalProgressFrame,
    sessionId: string,
    opened: boolean,
  ): RemoteMainProgressFact | undefined => {
    const previous = accepted?.sessionId === sessionId ? accepted : undefined
    const continues = previous !== undefined
      && previous.hostEpoch === frame.hostEpoch
      && previous.agentEpoch === frame.agentEpoch
    if (!opened) {
      if (frame.kind !== 'snapshot') {
        throw new Error(`the Remote terminal-progress stream of ${sessionId} did not open with a snapshot`)
      }
      return {
        kind: 'snapshot',
        restart: !continues,
        running: frame.running,
        outcome: snapshotOutcome(frame, previous),
      }
    }
    if (previous !== undefined && frame.revision < previous.revision) {
      throw new Error(`the Remote terminal-progress stream of ${sessionId} moved its revision backwards`)
    }
    if (frame.kind === 'snapshot') {
      // A second snapshot re-baselines the same watch under the same rules.
      return {
        kind: 'snapshot',
        restart: !continues,
        running: frame.running,
        outcome: snapshotOutcome(frame, previous),
      }
    }
    if (previous === undefined) return undefined
    if (frame.hostEpoch !== previous.hostEpoch) {
      // A mid-stream Host identity change without a snapshot baseline cannot be
      // given provenance: drop it rather than trust an unanchored epoch.
      return undefined
    }
    if (frame.agentEpoch < previous.agentEpoch) return undefined
    // Within one interval lineage only strictly newer revisions count, and a new
    // Agent lifetime (a rebind always carries the next revision) must be newer
    // too: a duplicate or out-of-order frame can never overwrite a newer truth.
    if (frame.revision <= previous.revision) return undefined
    return {
      kind: 'update',
      restart: frame.agentEpoch > previous.agentEpoch,
      running: frame.running,
      outcome: frame.outcome,
    }
  }

  return {
    async *open(sessionId: string, signal: AbortSignal): AsyncGenerator<RemoteMainProgressFact> {
      const capturedGeneration = deps.generation.getSnapshot()
      const capturedBinding = deps.binding(sessionId)
      if (capturedGeneration === undefined || capturedBinding === undefined) {
        throw new Error(`the Remote terminal-progress watch of ${sessionId} has no retained Session binding`)
      }
      const handle = deps.remote.piTuiTerminalProgress.watch(sessionId, signal)
      try {
        let opened = false
        for await (const item of handle) {
          if (signal.aborted) return
          // §7.1 fence, re-checked per frame: a Connection generation rollover or
          // a re-retained binding silently voids this watch's authority.
          if (!Object.is(capturedGeneration, deps.generation.getSnapshot())
            || deps.binding(sessionId) !== capturedBinding) {
            throw new Error(`the Remote terminal-progress watch of ${sessionId} lost its transport identity`)
          }
          // The wire is NOT codec-verified on the downlink path: this is the ONE
          // boundary where the frame shape is validated.
          const frame = parsePiTuiTerminalProgressFrame(item)
          if (frame.sessionId !== sessionId) {
            throw new Error(`the Remote terminal-progress stream of ${sessionId} delivered a frame of ${frame.sessionId}`)
          }
          const fact = acceptFrame(frame, sessionId, opened)
          if (fact === undefined) continue
          opened = true
          accepted = { sessionId, hostEpoch: frame.hostEpoch, agentEpoch: frame.agentEpoch, revision: frame.revision }
          yield fact
        }
      } finally {
        handle.dispose()
      }
    },
  }
}
