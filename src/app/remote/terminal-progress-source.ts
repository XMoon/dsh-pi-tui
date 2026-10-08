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
 * Snapshot provenance (plan §6.3, owner review P1): a watch ALWAYS opens with the
 * snapshot of the instant it subscribed, and provenance NEVER crosses watches —
 * the baseline carries only the Host's CURRENT `running` truth with `idle` and is
 * marked `restart`. A proven `done`/`error` is only ever delivered by an `update`
 * of the watch that observed its interval, so a re-adopted owner, a re-retained
 * binding or a reconnect can never inherit a historical result (the plan's "a new
 * binding defaults to idle"). The Surface therefore never displays a stale
 * completion, and an opening snapshot is never completion evidence.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/terminal-progress-source
 */

import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
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

/**
 * One consumption of the Remote progress authority (plan §6.4/§7.1).
 *
 * The Host RETIRES a watch when the watched Agent lifetime ends (an Agent
 * disposal — which rc.2 requires before a same-id replacement can be entered).
 * The authority for the SAME owner must therefore be re-established: a fresh
 * watch opens with a snapshot carrying the new `agentEpoch`, which the Surface
 * re-baselines as a `restart`. A watch that ends WITHOUT a single frame is a
 * broken authority, so those retries are bounded and reported as a failure
 * instead of spinning.
 */
export interface RemoteTerminalProgressConsumer {
  /** Re-checked before every fact AND before every re-open. `false` = the owner
   *  moved (switch/reconnect/teardown) and this consumption must stop quietly. */
  isCurrent(): boolean
  onFact(fact: RemoteMainProgressFact): void
}

/** Consecutive frame-less watch endings tolerated before failing closed. */
const EMPTY_WATCH_REOPEN_LIMIT = 3

/**
 * Consume the ONE Remote progress watch of one session for as long as the caller
 * stays current, re-establishing it whenever the Host retires it.
 *
 * @param source - the Remote progress source.
 * @param sessionId - the main session this authority belongs to.
 * @param signal - the caller's lifetime; aborting it stops the consumption at
 * the next fact and before any re-open.
 * @param consumer - the currentness fence and the fact sink.
 * @throws when the Host keeps ending the watch without ever delivering a frame.
 */
export async function consumeRemoteTerminalProgress(
  source: RemoteTerminalProgressSource,
  sessionId: string,
  signal: AbortSignal,
  consumer: RemoteTerminalProgressConsumer,
): Promise<void> {
  let emptyReopens = 0
  for (;;) {
    let frames = 0
    try {
      for await (const fact of source.open(sessionId, signal)) {
        if (signal.aborted || !consumer.isCurrent()) return
        frames += 1
        consumer.onFact(fact)
      }
    } catch (error) {
      // The caller's own abort cancels the Host invocation: that IS the expected
      // end (teardown / owner switch), never a stream failure to report.
      if (signal.aborted) return
      throw error
    }
    if (signal.aborted || !consumer.isCurrent()) return
    if (frames === 0) {
      emptyReopens += 1
      if (emptyReopens > EMPTY_WATCH_REOPEN_LIMIT) {
        throw new Error(
          `the Remote terminal-progress watch of ${sessionId} ended without a frame ${String(emptyReopens)} times`,
        )
      }
    } else {
      emptyReopens = 0
    }
  }
}

/**
 * One accepted frame of ONE watch: the provenance the next frame is judged
 * against. It is created per watch and never crosses one.
 */
interface AcceptedState {
  readonly hostEpoch: string
  readonly agentEpoch: number
  readonly revision: number
}

/**
 * Assemble the source over the ONE Remote Client graph. It constructs no
 * Client and owns no subscription of its own; the provenance of an accepted
 * frame lives only for the watch that observed it (see {@link createRemoteTerminalProgressSource}).
 */
export function createRemoteTerminalProgressSource(
  deps: RemoteTerminalProgressSourceDeps,
): RemoteTerminalProgressSource {
  /**
   * Judge one frame against the provenance of THIS watch.
   *
   * @param previous - the last frame accepted by this watch, or `undefined`
   * before its opening baseline. It deliberately never crosses watches: a
   * settled `done`/`error` belongs to the interval ONE watch observed, so a new
   * watch (a reconnect, a re-adopted session, a re-retained binding, another TUI
   * owner) opens on the Host's current `running` truth and `idle` — the plan's
   * "a new binding default to idle" — instead of inheriting a result it cannot
   * prove.
   * @param opened - whether this watch already delivered its opening baseline.
   * @returns the fact to publish, or `undefined` for a frame that must be dropped.
   * @throws when the stream cannot be interpreted at all.
   */
  const acceptFrame = (
    frame: PiTuiTerminalProgressFrame,
    sessionId: string,
    opened: boolean,
    previous: AcceptedState | undefined,
  ): RemoteMainProgressFact | undefined => {
    if (!opened) {
      if (frame.kind !== 'snapshot') {
        throw new Error(`the Remote terminal-progress stream of ${sessionId} did not open with a snapshot`)
      }
      return { kind: 'snapshot', restart: true, running: frame.running, outcome: 'idle' }
    }
    if (previous !== undefined && frame.revision < previous.revision) {
      throw new Error(`the Remote terminal-progress stream of ${sessionId} moved its revision backwards`)
    }
    if (frame.kind === 'snapshot') {
      // A second snapshot re-baselines this same watch: same conservative rule.
      return { kind: 'snapshot', restart: true, running: frame.running, outcome: 'idle' }
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
        /** This watch's own provenance: it dies with the watch. */
        let accepted: AcceptedState | undefined
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
          const fact = acceptFrame(frame, sessionId, opened, accepted)
          if (fact === undefined) continue
          opened = true
          accepted = { hostEpoch: frame.hostEpoch, agentEpoch: frame.agentEpoch, revision: frame.revision }
          yield fact
        }
      } finally {
        handle.dispose()
      }
    },
  }
}
