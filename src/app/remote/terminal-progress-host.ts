/**
 * The private `piTuiTerminalProgress` Host service (plan R2 §6): the additive
 * Cordis row the Remote Host composition mounts, owning
 *
 * ```text
 * the Host-side shared interval fold instance (ONE per live Agent)
 * the per-session snapshot + ordered-update truth the private stream serves
 * the stream's subscriber queues and their lifetime
 * ```
 *
 * It is the Remote branch's ONLY terminal-outcome authority: it observes the
 * durable `turn/start` / `turn/end(reason.kind)` and the live `agent/status`
 * edges of the REAL Host Context in the true synchronous order, classifies
 * them with the SAME `domain/terminal-progress/interval.ts` fold the Direct
 * adapter uses, and publishes ONE atomic `{running, outcome}` per transition.
 *
 * Identity discipline (plan §6.4): the live Agent is resolved through the
 * authoritative `agents` registry (`agentFor`) and the durable event's Session
 * must be the EXACT `agent.session` object of the bound Agent — never a
 * same-id string match. A replaced Agent lifetime opens a NEW `agentEpoch` and
 * inherits nothing (no retained `done`/`error`), and an Agent disposal retires
 * the live interval to `idle`, ends the watchers and drops the record (no
 * unbounded session retention).
 *
 * The row never writes a terminal byte (OSC encoding stays with TuiApp), never
 * touches the Direct evidence path and never blocks: an unknown upstream
 * `reason.kind` is reported through the injected diagnostics reporter and fails
 * closed to `idle`.
 *
 * LAYER NOTE: this row lives in `app/remote/**` (the composition owns it and
 * its lifetime); the shared classification stays in `domain/**`.
 *
 * The Typert CONTRIBUTION (the descriptor the Gateway dispatches on) is owned
 * by the composition, not by this row: rc.2 admits exactly one contribution per
 * package identity, so all of this package's private invocations are registered
 * together in `runtime/remote/pi-tui-remote-contribution.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/terminal-progress-host
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  createTerminalProgressInterval,
  type IntervalProgress,
  type TerminalProgressInterval,
} from '../../domain/terminal-progress/interval.ts'
import type { TerminalProgressOutcome } from '../../domain/terminal-progress/settings.ts'
import {
  PI_TUI_TERMINAL_PROGRESS_NAMESPACE,
  type PiTuiTerminalProgressFrame,
} from '../../runtime/remote/pi-tui-terminal-progress-contract.ts'

/**
 * The Host facts the row needs from its composition. Structural on purpose:
 * the row must not import a Host Agent package (the boundary gate counts even
 * type-only Host imports), and the Agent object itself never crosses the wire.
 */
export interface LiveAgentLike {
  readonly id: string
  /** The EXACT durable Session object of this Agent (`agent.session`). */
  readonly session: { readonly id: string }
  /** The live lifecycle state (`running` while a driver is active). */
  readonly status: string
}

/** The narrow Host inputs of the terminal-progress row. */
export interface PiTuiTerminalProgressHostDeps {
  /**
   * Resolve the LIVE Agent of one session id through the authoritative Host
   * registry (`ctx.agents.get(id)`). Read PER EVENT: a replaced registry or a
   * replaced Agent must be observed, never a composition-time snapshot.
   */
  agentFor(sessionId: string): LiveAgentLike | undefined
  /**
   * Report an unknown upstream `turn/end.reason.kind` (fails closed to `idle`).
   * Required so a real Host composition cannot silently drop the diagnostic.
   */
  onUnknownReason(kind: string): void
}

/** One session's evidence state. */
interface SessionRecord {
  /** The session id this record serves (the wire frame's identity). */
  readonly sessionId: string
  /** The bound Agent object of the CURRENT lifetime, or undefined until bound. */
  agent: LiveAgentLike | undefined
  /** The exact Session object of the bound Agent (identity fence for events). */
  session: object | undefined
  /** Bumped on every Agent lifetime change; 0 until the first bind. */
  agentEpoch: number
  readonly fold: TerminalProgressInterval
  /** Monotonic within one `hostEpoch + sessionId`. */
  revision: number
  running: boolean
  outcome: TerminalProgressOutcome
  readonly subscribers: Set<FrameQueue>
}

/** The structural `turn/start` / `turn/end` payload read (never a guessed shape). */
function turnOf(data: unknown): number | undefined {
  const turn = (data as { readonly turn?: unknown } | null | undefined)?.turn
  return typeof turn === 'number' ? turn : undefined
}

/** The merge-extensible `turn/end.reason.kind` discriminant. */
function reasonKindOf(data: unknown): string | undefined {
  const reason = (data as { readonly reason?: { readonly kind?: unknown } } | null | undefined)?.reason
  return typeof reason?.kind === 'string' ? reason.kind : undefined
}

/**
 * Frames one subscriber may fall behind by before the stream is failed instead
 * of silently losing an edge. A real run produces a handful of transitions, so
 * only a consumer that stopped draining can reach it.
 */
const SUBSCRIBER_QUEUE_LIMIT = 64

/**
 * One subscriber's ordered frame queue. The Host ALWAYS mutates the record
 * before pushing, so a queue can never observe a frame the record has not
 * committed, and `close()` is idempotent.
 *
 * An overflowing queue FAILS the reader: dropping frames and continuing would
 * let a stream report a settlement whose running edge it lost (plan §6.5).
 */
class FrameQueue {
  private readonly frames: PiTuiTerminalProgressFrame[] = []
  private wake: (() => void) | undefined
  private closed = false
  private failure: Error | undefined
  private readonly limit = SUBSCRIBER_QUEUE_LIMIT

  push(frame: PiTuiTerminalProgressFrame): void {
    if (this.closed || this.failure !== undefined) return
    if (this.frames.length >= this.limit) {
      this.failure = new Error('piTuiTerminalProgress: the subscriber queue overflowed')
      this.frames.length = 0
      const wake = this.wake
      this.wake = undefined
      wake?.()
      return
    }
    this.frames.push(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  /**
   * End the consumer's read AFTER every frame already committed to it: a
   * disposal publishes the retired interval BEFORE it ends the watchers, and a
   * committed terminal fact must never be dropped in flight.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async next(): Promise<IteratorResult<PiTuiTerminalProgressFrame>> {
    for (;;) {
      const frame = this.frames.shift()
      if (frame !== undefined) return { value: frame, done: false }
      if (this.failure !== undefined) throw this.failure
      if (this.closed) return { value: undefined, done: true }
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}

/**
 * The Host endpoint of the private stream. One instance per Remote Host
 * composition; the descriptors and the subscriptions leave with the fiber.
 */
export class PiTuiTerminalProgressHostService extends TypertRemoteService {
  /** The Typert registry owns the explicit invocation definition. */
  static readonly inject = ['typert']
  /** One opaque identity per Host plugin instance: a Host restart, a new
   *  composition or a re-mounted fiber all invalidate older frames. */
  private readonly hostEpoch: string = `host-${randomEpoch()}`
  private readonly records = new Map<string, SessionRecord>()
  /** Monotonic Agent-lifetime counter: a replacement ALWAYS outranks every
   *  earlier lifetime of the same session, even after its record was dropped. */
  private epochCounter = 0
  private disposed = false

  /**
   * @param ctx - the Host context this row is mounted in.
   * @param deps - the narrow Host facts the composition resolved.
   */
  constructor(ctx: Context, private readonly deps: PiTuiTerminalProgressHostDeps) {
    super(ctx, PI_TUI_TERMINAL_PROGRESS_NAMESPACE)
    // The Typert contribution is owned by the composition (one contribution per
    // package identity; see runtime/remote/pi-tui-remote-contribution.ts).
    // `global: true` is the official Cordis option that skips the scope filter:
    // the row must observe the session/agent events of the REAL main Agent (and
    // of every other Agent in this Host) regardless of the mount level of the
    // fiber that carries it, and must not depend on being mounted at the root.
    ctx.on('agent/status', ({ agent, status }) => {
      this.onAgentStatus(agent as unknown as LiveAgentLike, status)
    }, { global: true })
    ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event.type, event.data)
    }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => {
      this.onAgentDisposed(agent as unknown as LiveAgentLike)
    }, { global: true })
    ctx.effect(() => () => { this.closeAll() }, 'pi-tui-terminal-progress-watchers')
  }

  /**
   * The private Remote method (`piTuiTerminalProgress/watch`): the ONE
   * per-session ordered stream, opening with the authoritative snapshot of the
   * instant it subscribes and then every real Host-side change (plan §6.5).
   *
   * The subscriber is registered and the cut (revision + current state) is
   * captured in the SAME synchronous block before the first `yield`, so an
   * update can neither be lost between the snapshot and the subscription nor be
   * replayed twice.
   */
  async *watch(sessionId: string, signal: AbortSignal): AsyncGenerator<PiTuiTerminalProgressFrame> {
    const record = this.recordFor(sessionId)
    const queue = new FrameQueue()
    const cut = record.revision
    const snapshot: PiTuiTerminalProgressFrame = {
      kind: 'snapshot',
      sessionId,
      hostEpoch: this.hostEpoch,
      agentEpoch: record.agentEpoch,
      revision: cut,
      running: record.running,
      outcome: record.outcome,
    }
    record.subscribers.add(queue)
    const onAbort = (): void => { queue.close() }
    if (signal.aborted) queue.close()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      yield snapshot
      for (;;) {
        const next = await queue.next()
        if (next.done === true) return
        yield next.value
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      record.subscribers.delete(queue)
    }
  }

  /** The live `agent/status` transition of one Agent (plan §6.4). */
  private onAgentStatus(agent: LiveAgentLike, status: string): void {
    const record = this.recordFor(agent.session.id)
    if (record.agent === undefined) return
    // Only the running/idle truth of the interval. The settlement happens on
    // the falling edge, from the evidence the durable events captured.
    this.publish(record, record.fold.status(status === 'running'))
  }

  /** One durable Session event (plan §6.4): evidence only, never an interim commit. */
  private onSessionEvent(session: { readonly id: string }, type: string, data: unknown): void {
    const record = this.records.get(session.id)
    if (record === undefined || record.agent === undefined) return
    // The EXACT Session object of the bound Agent: a same-id different Session
    // (a replaced Agent lifetime) can never contribute evidence.
    if (record.session !== session) return
    if (type === 'turn/start') {
      const turn = turnOf(data)
      if (turn !== undefined) record.fold.turnStart(turn)
      return
    }
    if (type === 'turn/end') {
      const turn = turnOf(data)
      const kind = reasonKindOf(data)
      if (turn !== undefined && kind !== undefined) record.fold.turnEnd(turn, kind)
    }
  }

  /** The Agent lifetime ended (plan §6.4): retire honestly, end the watchers. */
  private onAgentDisposed(agent: LiveAgentLike): void {
    const record = this.records.get(agent.session.id)
    if (record === undefined || record.agent !== agent) return
    const retired = record.fold.retire()
    if (retired !== undefined) this.publish(record, retired)
    this.records.delete(agent.session.id)
    for (const subscriber of record.subscribers) subscriber.close()
  }

  /**
   * The record of one session, bound to the live Agent the authoritative Host
   * registry currently holds. Creation AND a replaced Agent lifetime consume a
   * new `agentEpoch` and reset the interval: a new Agent can never inherit the
   * previous lifetime's evidence (plan §6.3/§6.4).
   */
  private recordFor(sessionId: string): SessionRecord {
    let record = this.records.get(sessionId)
    if (record === undefined) {
      record = {
        sessionId,
        agent: undefined,
        session: undefined,
        agentEpoch: 0,
        fold: createTerminalProgressInterval(kind => { this.deps.onUnknownReason(kind) }),
        revision: 0,
        running: false,
        outcome: 'idle',
        subscribers: new Set(),
      }
      this.records.set(sessionId, record)
    }
    const live = this.deps.agentFor(sessionId)
    if (live !== undefined && live !== record.agent) this.rebind(record, live)
    return record
  }

  /**
   * Bind one Agent lifetime: the running truth is read from the Agent's OWN
   * current status (a plugin mounted mid-run may therefore report `working`),
   * but the outcome starts at `idle` — an unobserved start can never prove a
   * settlement. The rebind is ALWAYS published, because the epoch change is
   * itself a fact the Client must fence on.
   */
  private rebind(record: SessionRecord, agent: LiveAgentLike): void {
    record.agent = agent
    record.session = agent.session
    record.agentEpoch = ++this.epochCounter
    const running = agent.status === 'running'
    record.fold.apply({ active: running, outcome: 'idle' })
    record.running = running
    record.outcome = 'idle'
    record.revision += 1
    this.broadcast(record, 'update')
  }

  /** Commit one fold transition: mutate the record FIRST, then broadcast. */
  private publish(record: SessionRecord, next: IntervalProgress | undefined): void {
    if (next === undefined) return
    if (next.active === record.running && next.outcome === record.outcome) return
    record.running = next.active
    record.outcome = next.outcome
    record.revision += 1
    this.broadcast(record, 'update')
  }

  private broadcast(record: SessionRecord, kind: 'update'): void {
    const frame: PiTuiTerminalProgressFrame = {
      kind,
      sessionId: record.sessionId,
      hostEpoch: this.hostEpoch,
      agentEpoch: record.agentEpoch,
      revision: record.revision,
      running: record.running,
      outcome: record.outcome,
    }
    for (const subscriber of record.subscribers) subscriber.push(frame)
  }

  /** End every watcher (the row's fiber is going away). */
  private closeAll(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) {
      for (const subscriber of record.subscribers) subscriber.close()
    }
  }
}

/** An opaque, process-unique Host-plugin identity (the wire sees only a string). */
function randomEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
