/**
 * The Remote provider-native authorization adapter (M6-1 F7A): the semantic
 * {@link AuthorizationConfig} over the package's ONE private
 * `piTuiAuthorization` Client namespace.
 *
 * The Host bridge is the only attempt authority. This adapter owns:
 *
 * - the generation fence: the Connection generation is captured before every
 *   dispatch and every stream item is checked against it; a late frame or a
 *   reply from a superseded generation never reaches the current page;
 * - the `started` admission: `begin()` resolves only after the legal `started`
 *   first frame. A transport failure BEFORE that frame is a dispatch-unknown
 *   error, never `unavailable` (which would claim the Host proved nothing ran);
 * - the fourth outcome: a stream that disappears without an official terminal
 *   (carrier loss, generation replacement, an invalid frame, a lost answer
 *   acknowledgement) yields `unconfirmed`, never a fabricated
 *   failed/cancelled/authorized. Nothing is replayed automatically;
 * - the roster currentness: `refreshTargets()` re-reads the Host roster once
 *   per explicit page read; `targetsState()` is `ready`, `unavailable` (the
 *   Host has no authorization service) or `stale` (no authoritative read for
 *   THIS generation). A stale roster is never reported as an empty one.
 *
 * The secret boundary: a `secret` prompt's answer is the only user-typed value
 * this module sends; it rides the authenticated unary `respond` call once and
 * is never stored, logged, echoed in an event or retried.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/authorization-remote
 */

import type {
  AuthorizationConfig,
  AuthorizationFlowEvent,
  AuthorizationFlowTarget,
} from '../config-port.ts'
import { SupersededReadError } from '../read-error.ts'
import {
  parsePiTuiAuthorizationFrame,
  parsePiTuiAuthorizationTargetsSnapshot,
  type PiTuiAuthorizationNamespace,
  type PiTuiAuthorizationRunStream,
} from './pi-tui-authorization-contract.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'

/**
 * The attempt was dispatched (the Host may have started it) but the `started`
 * first frame could not be observed. This is a DEFINITE dispatch, unknown
 * outcome: the caller must not retry automatically.
 */
export class AuthorizationDispatchUnknownError extends Error {
  readonly code = 'DISPATCH_UNKNOWN'

  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationDispatchUnknownError'
  }
}

/** One Client-observed attempt pump. */
interface ClientAttempt {
  readonly attemptId: string
  readonly generation: RemoteConnectionGeneration
  readonly streamSignal: AbortSignal
  readonly handle: PiTuiAuthorizationRunStream
  /** The attempt's own cancellation (the caller's signal is combined into it). */
  readonly controller: AbortController
  /** One terminal/unconfirmed event has already been emitted for this attempt. */
  reported: boolean
}

/** The semantic authorization port over the private Client namespace. */
export class RemoteAuthorizationConfig implements AuthorizationConfig {
  private readonly namespace: PiTuiAuthorizationNamespace | undefined
  private readonly generation: RemoteConnectionGenerationSource
  private readonly listeners = new Set<(event: AuthorizationFlowEvent) => void>()
  private readonly attempts = new Map<string, ClientAttempt>()
  private readonly unsubscribeGeneration: () => void
  private targets: readonly AuthorizationFlowTarget[] = []
  private state: 'ready' | 'unavailable' | 'stale' = 'stale'
  /** Monotone same-generation roster read id; only the latest may commit. */
  private rosterSerial = 0
  /** One-shot invalidators for `begin()` calls still waiting on the started frame. */
  private readonly pendingOpens = new Set<() => void>()
  private disposed = false

  constructor(
    namespace: PiTuiAuthorizationNamespace | undefined,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.namespace = namespace
    this.generation = generation
    // A generation replacement invalidates the roster AT ONCE, whatever the
    // previous state was: a last-known `inFlight` from another Host, and an
    // `unavailable` verdict from a Host WITHOUT the authorization service, are
    // both facts about the OLD generation. The new generation's capability is
    // unknown until it is read (`stale`), so /login cannot route from the old
    // conclusion and describe() re-reads it.
    this.unsubscribeGeneration = generation.subscribe(() => {
      this.state = 'stale'
      // A roster read for the old generation must not commit after this point.
      this.rosterSerial += 1
      // The attempt/pending-open result belongs to the generation that opened
      // its stream: close both at once instead of waiting for a frame that may
      // never arrive.
      for (const attempt of [...this.attempts.values()]) {
        this.markUnconfirmed(attempt, 'the Connection changed before the authorization settled')
      }
      for (const invalidate of [...this.pendingOpens]) invalidate()
    })
  }

  available(): boolean {
    return this.namespace !== undefined && this.state !== 'unavailable'
  }

  listTargets(): readonly AuthorizationFlowTarget[] {
    // Detached copies: the method/option objects never alias the cache the
    // next refresh replaces.
    return this.targets.map(target => ({
      ...target,
      methods: target.methods.map(method => ({ ...method })),
    }))
  }

  targetsState(): 'ready' | 'unavailable' | 'stale' {
    return this.state
  }

  /**
   * One authoritative roster read for the current generation. A failed or
   * superseded read leaves the state `stale` and rethrows; it never publishes
   * an empty roster as current.
   */
  async refreshTargets(): Promise<void> {
    if (this.disposed) throw new Error('authorization: the Remote adapter is disposed')
    // Same-generation latest-wins: overlapping page refreshes can complete out
    // of order, and only the newest request may commit the shared roster cache.
    const serial = ++this.rosterSerial
    const isCurrent = (generation: RemoteConnectionGeneration): boolean =>
      serial === this.rosterSerial
      && !this.disposed
      && Object.is(generation, this.generation.getSnapshot())
    const namespace = this.namespace
    if (namespace === undefined) {
      this.targets = []
      this.state = 'unavailable'
      return
    }
    const generation = this.generation.getSnapshot()
    if (generation === undefined) {
      this.state = 'stale'
      throw new Error('authorization: the Client is not connected to a Host')
    }
    let result
    try {
      result = await namespace.list()
    } catch (error) {
      if (!isCurrent(generation)) {
        throw new SupersededReadError('authorization roster superseded')
      }
      this.state = 'stale'
      throw error
    }
    if (!isCurrent(generation)) {
      throw new SupersededReadError('authorization roster superseded')
    }
    if (!result.ok) {
      this.state = 'stale'
      throw result.error
    }
    const snapshot = parsePiTuiAuthorizationTargetsSnapshot(result.value)
    if (snapshot.kind === 'unavailable') {
      this.targets = []
      this.state = 'unavailable'
      return
    }
    this.targets = snapshot.targets
    this.state = 'ready'
  }

  onEvent(listener: (event: AuthorizationFlowEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async begin(request: {
    key: string
    method?: string
    signal?: AbortSignal
  }): Promise<{ kind: 'started'; attemptId: string } | { kind: 'unavailable' }> {
    if (this.disposed) throw new Error('authorization: the Remote adapter is disposed')
    const namespace = this.namespace
    // The private namespace is mounted by this package's ONE contribution. Its
    // absence is a definite capability gap, not a dispatched attempt.
    if (namespace === undefined) return { kind: 'unavailable' }
    const generation = this.generation.getSnapshot()
    if (generation === undefined) throw new Error('authorization: the Client is not connected to a Host')
    request.signal?.throwIfAborted()
    const controller = new AbortController()
    const streamSignal = request.signal === undefined
      ? controller.signal
      : AbortSignal.any([request.signal, controller.signal])
    const handle = namespace.run(request.key, request.method, streamSignal)
    const iterator = handle[Symbol.asyncIterator]()
    // The dispatch window before `started` is a real pending OPEN: the run may
    // already be at the Host while the Client has no attempt id yet. Register it
    // with this adapter so a generation replacement, the caller's abort or an
    // adapter disposal can end `begin()` deterministically instead of leaving
    // the page's Starting state waiting on a stream that never yields.
    let invalidate: () => void = () => {}
    const invalidated = new Promise<'invalidated'>(resolve => {
      invalidate = () => resolve('invalidated')
    })
    const removeGenerationListener = this.generation.subscribe(() => { invalidate() })
    const onAbort = (): void => { invalidate() }
    streamSignal.addEventListener('abort', onAbort, { once: true })
    const invalidatePending = (): void => {
      invalidate()
      controller.abort()
      handle.dispose()
    }
    this.pendingOpens.add(invalidatePending)
    let first: IteratorResult<unknown>
    try {
      const opening = await Promise.race([iterator.next(), invalidated])
      if (opening === 'invalidated') {
        throw new AuthorizationDispatchUnknownError(
          'the Connection changed while the authorization attempt was opening — refresh credentials before retrying',
        )
      }
      first = opening
    } catch (error) {
      handle.dispose()
      if (error instanceof AuthorizationDispatchUnknownError) throw error
      throw new AuthorizationDispatchUnknownError(
        `the Host did not acknowledge the authorization attempt (${safeTransportReason(error)}) — refresh credentials before retrying`,
      )
    } finally {
      removeGenerationListener()
      streamSignal.removeEventListener('abort', onAbort)
      this.pendingOpens.delete(invalidatePending)
    }
    if (first.done === true) {
      handle.dispose()
      throw new AuthorizationDispatchUnknownError(
        'the Host closed the authorization stream before acknowledging the attempt — refresh credentials before retrying',
      )
    }
    let frame
    try {
      frame = parsePiTuiAuthorizationFrame(first.value)
    } catch {
      handle.dispose()
      throw new AuthorizationDispatchUnknownError(
        'the Host sent an invalid authorization frame — refresh credentials before retrying',
      )
    }
    if (frame.kind !== 'started') {
      handle.dispose()
      throw new AuthorizationDispatchUnknownError(
        'the Host did not open the authorization attempt with a start frame — refresh credentials before retrying',
      )
    }
    // The attempt was admitted on the generation that STARTED it. A replacement
    // between the dispatch and the first frame means its later frames belong to
    // a dead carrier: report unknown, never bind the stale attempt.
    if (!Object.is(generation, this.generation.getSnapshot())) {
      handle.dispose()
      throw new AuthorizationDispatchUnknownError(
        'the Connection changed while the authorization attempt was opening — refresh credentials before retrying',
      )
    }
    const attempt: ClientAttempt = {
      attemptId: frame.attemptId,
      generation,
      streamSignal,
      handle,
      controller,
      reported: false,
    }
    this.attempts.set(frame.attemptId, attempt)
    // The pump is OWNED by this adapter until settlement: it is the only reader
    // of the stream and it disposes the handle on every exit path.
    void this.pump(attempt, iterator) // allowlist: pump() contains every failure as an event and never rejects
    return { kind: 'started', attemptId: frame.attemptId }
  }

  async respond(attemptId: string, promptId: string, answer: string | null): Promise<void> {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) throw new Error('authorization: the attempt is no longer active')
    const namespace = this.namespace
    if (namespace === undefined) throw new Error('authorization: the private namespace is not mounted')
    let result
    try {
      result = await namespace.respond(attemptId, promptId, answer)
    } catch (error) {
      // The answer may or may not have reached the Host. It MUST NOT be sent
      // twice; the attempt becomes an observable `unconfirmed` instead of
      // leaving the page waiting for a prompt that will never settle.
      this.markUnconfirmed(attempt, 'the prompt answer acknowledgement was lost')
      throw error
    }
    if (!result.ok) {
      // The Host refused the answer as a definite business result. The answer
      // will NOT be re-sent, and the local flow must not be left waiting for a
      // settlement the Host may never deliver: close the attempt and publish
      // the one observable terminal (`unconfirmed`). A prompt already
      // withdrawn by the Host is still covered by the same rule — the flow is
      // closed instead of hanging, and no secret is retried.
      this.markUnconfirmed(attempt, 'the prompt answer was refused by the Host')
      throw result.error
    }
  }

  async cancel(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined) throw new Error('authorization: the attempt is no longer active')
    const namespace = this.namespace
    if (namespace === undefined) throw new Error('authorization: the private namespace is not mounted')
    const result = await namespace.cancel(attemptId)
    // The ACK only means the Host ACCEPTED the cancel request: the official
    // settlement (possibly `authorized` for an already-accepted commit) still
    // arrives on the attempt stream. No local terminal is forged here.
    if (!result.ok) throw result.error
  }

  /** Release every attempt, listener and the generation subscription once. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.rosterSerial += 1
    this.unsubscribeGeneration()
    this.listeners.clear()
    for (const invalidate of [...this.pendingOpens]) invalidate()
    this.pendingOpens.clear()
    for (const attempt of [...this.attempts.values()]) {
      attempt.controller.abort()
      attempt.handle.dispose()
    }
    this.attempts.clear()
    this.targets = []
    this.state = 'stale'
  }

  /** Read the attempt stream to its single terminal (or declare it unconfirmed). */
  private async pump(attempt: ClientAttempt, iterator: AsyncIterator<unknown>): Promise<void> {
    let terminal = false
    let unknownReason: string | undefined
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) {
          unknownReason = 'the authorization stream ended before a confirmed outcome'
          break
        }
        let frame
        try {
          frame = parsePiTuiAuthorizationFrame(next.value)
        } catch {
          unknownReason = 'the Host sent an invalid authorization frame'
          break
        }
        if (frame.attemptId !== attempt.attemptId) {
          // The Host stream is per attempt: a frame naming another attempt is a
          // protocol violation, not a benign interleaving. Fail closed for THIS
          // attempt instead of ignoring it and staying open forever.
          unknownReason = 'the Host sent a frame for another authorization attempt'
          break
        }
        if (!Object.is(attempt.generation, this.generation.getSnapshot())) {
          unknownReason = 'the Connection changed before the authorization settled'
          break
        }
        if (frame.kind === 'started') {
          unknownReason = 'the Host repeated the authorization start frame'
          break
        }
        const terminalFrame = frame.kind === 'settled' || frame.kind === 'unconfirmed'
        if (terminalFrame) {
          // Commit the attempt's terminal state BEFORE any listener runs: a
          // synchronous listener that replaces the generation must not find
          // this attempt in the map and publish a second `unconfirmed` terminal
          // for the settlement it is already receiving.
          attempt.reported = true
          if (this.attempts.get(attempt.attemptId) === attempt) this.attempts.delete(attempt.attemptId)
        }
        this.emit(frame)
        if (terminalFrame) {
          terminal = true
          break
        }
      }
    } catch (error) {
      if (!attempt.streamSignal.aborted && !this.disposed) {
        unknownReason = `the authorization stream was lost (${safeTransportReason(error)})`
      }
    } finally {
      attempt.handle.dispose()
      if (this.attempts.get(attempt.attemptId) === attempt) this.attempts.delete(attempt.attemptId)
    }
    if (terminal || attempt.reported || this.disposed) return
    // A CALLER teardown (the page's own signal) closed this stream while the
    // adapter is still alive. The official settlement is now unobservable
    // through this attempt, so the still-subscribed flow must be closed with
    // the FOURTH outcome instead of awaiting an event that can never arrive.
    // An adapter/Client disposal is different: every listener is gone with it.
    const reason = attempt.streamSignal.aborted
      ? 'the authorization page was closed before the Host settled'
      : unknownReason
    if (reason === undefined) return
    attempt.reported = true
    this.emit({ kind: 'unconfirmed', attemptId: attempt.attemptId, reason })
  }

  /** Close the attempt and publish the ONE unconfirmed terminal for it. */
  private markUnconfirmed(attempt: ClientAttempt, reason: string): void {
    if (this.attempts.get(attempt.attemptId) !== attempt) return
    this.attempts.delete(attempt.attemptId)
    attempt.controller.abort()
    attempt.handle.dispose()
    if (attempt.reported) return
    attempt.reported = true
    this.emit({ kind: 'unconfirmed', attemptId: attempt.attemptId, reason })
  }

  private emit(event: AuthorizationFlowEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A listener must never break the attempt.
      }
    }
  }
}

/** One bounded, redacted transport reason (never a secret/credential payload). */
function safeTransportReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? code : error.message
  }
  return 'transport failure'
}
