/**
 * The Host-owned provider-native authorization bridge (M6-1 F7A).
 *
 * The installed official `ctx.authorization` service and the official
 * `ctx.credentials` store remain the ONLY authorization authority: this service
 * never writes a grant/token, never invents a flow and never decides that an
 * attempt succeeded. It owns exactly one private concern — turning the official
 * callback-shaped interaction into ONE ordered Remote stream per attempt, with
 * an exact Owner-peer ACL:
 *
 * ```text
 * run(key, method)  -> [started] -> notice/prompt/prompt-withdrawn -> [settled]
 * respond(attemptId, promptId, answer)  -> answer the exact pending prompt
 * cancel(attemptId)                     -> request official withdrawal (no forged terminal)
 * list()                                -> the official roster as detached targets
 * ```
 *
 * The official `authorization.begin()` may still refuse NO_FLOW /
 * UNKNOWN_METHOD / ALREADY_IN_FLIGHT, and it settles `authorized` only after it
 * observed a credential-record commit inside this attempt. The bridge therefore
 * publishes `started` as a STREAM admission, never as an authorization success,
 * and terminates the stream exactly once from the official outcome (or from the
 * official thrown failure).
 *
 * A peer that owns no attempt can neither answer another peer's secret prompt
 * nor cancel another peer's attempt: `respond`/`cancel` compare the exact
 * `RemoteInvocation.peer.id` captured by `run`. Different keys remain
 * independent (the official service enforces the per-key mutual exclusion).
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/authorization
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type PeerId, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import {
  AuthorizationDeclinedError,
  type AuthorizationEntry,
  type AuthorizationInteraction,
  type AuthorizationNotice,
  type AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import {
  credentialKeyId,
  credentialKeyScope,
  type CredentialKey,
} from '@deepseek-ai/dsh-credentials'
import {
  MAX_PI_TUI_AUTHORIZATION_ATTEMPT_FRAMES,
  PI_TUI_AUTHORIZATION_NAMESPACE,
  type AuthorizationTargetsSnapshot,
  type AuthorizationWireFrame,
} from '../../../runtime/remote/pi-tui-authorization-contract.ts'
import { cancellationError } from '../../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../../runtime/process/errors.ts'
import type { AuthorizationFlowTarget, AuthorizationPromptEvent } from '../../../runtime/config-port.ts'

/**
 * The provider scope the official `llm-pi-ai` flows write under. The SAME
 * official constant the Direct adapter interprets (`RECORD_SCOPE` of
 * `@deepseek-ai/dsh-llm-pi-ai`); a key outside it is a foreign flow with NO
 * provider route.
 */
const LLM_PI_AI_SCOPE = 'llm-pi-ai'

/** The official authorization face this bridge consumes (structural, no
 *  Direct-adapter dependency: this is a Host feature, and the app layer may
 *  not import `runtime/direct/**`). */
export interface AuthorizationServiceLike {
  list(): readonly AuthorizationEntry[]
  begin(request: {
    key: CredentialKey
    method?: string
    interaction: AuthorizationInteraction
    signal?: AbortSignal
  }): Promise<{ status: 'authorized' | 'cancelled' }>
  cancel(key: CredentialKey): void
}

/** One prompt the current attempt is waiting on, keyed by the wire promptId. */
interface PendingPrompt {
  resolve(answer: string): void
  reject(error: unknown): void
  /** Remove the prompt's own abort listener (every settlement path runs it). */
  cleanup(): void
}

/** The private per-attempt bridge state (temporary; never persisted). */
interface Attempt {
  readonly attemptId: string
  /** The exact owner Peer that opened the stream. */
  readonly peerId: PeerId
  readonly key: CredentialKey
  /** Withdraws THIS attempt's official run (prompt withdrawal does not use it). */
  readonly controller: AbortController
  /** Ordered frames awaiting the Client read (bounded). */
  readonly frames: AuthorizationWireFrame[]
  /** Resume the waiting generator, if one is parked. */
  wake: (() => void) | undefined
  /** Pending prompts of THIS attempt. */
  readonly prompts: Map<string, PendingPrompt>
  /** The one terminal frame has been queued (or the bridge failed). */
  terminal: boolean
  /** The stream reader has released the attempt. */
  closed: boolean
}

/** The narrow official authorization face this bridge consumes. */
export type PiTuiAuthorizationHostDeps = {
  /** Read PER CALL: a Host without the plugin answers `unavailable`. */
  authorization(): AuthorizationServiceLike | undefined
}

/** ONE prompt's detached wire shape (no callback, no signal). */
function detachedPrompt(prompt: AuthorizationPrompt): AuthorizationPromptEvent {
  if (prompt.kind === 'select') {
    return {
      kind: 'select',
      message: prompt.message,
      options: (prompt.options ?? []).map(option => ({
        id: option.id,
        label: option.label,
        ...(option.description !== undefined && option.description !== ''
          ? { description: option.description }
          : {}),
      })),
    }
  }
  return {
    kind: prompt.kind,
    message: prompt.message,
    ...(prompt.placeholder !== undefined && prompt.placeholder !== ''
      ? { placeholder: prompt.placeholder }
      : {}),
  }
}

export class PiTuiAuthorizationHostService extends TypertRemoteService {
  static readonly inject = ['typert']

  private readonly deps: PiTuiAuthorizationHostDeps
  private readonly lifecycle = new AbortController()
  private readonly attempts = new Map<string, Attempt>()
  private disposed = false

  constructor(ctx: Context, deps: PiTuiAuthorizationHostDeps) {
    super(ctx, PI_TUI_AUTHORIZATION_NAMESPACE)
    this.deps = deps
    ctx.effect(() => () => {
      this.disposed = true
      this.lifecycle.abort()
      for (const attempt of [...this.attempts.values()]) this.closeAttempt(attempt)
    }, 'pi-tui-authorization-attempts')
  }

  /** Live attempt count (qualification evidence: teardown returns it to 0). */
  get activeAttempts(): number {
    return this.attempts.size
  }

  /**
   * The roster read. Owner-only and fail-closed BEFORE reading the official
   * registry; a Host without the official plugin is a definite `unavailable`,
   * which is never the same fact as an empty roster.
   */
  async list(signal: AbortSignal): Promise<AuthorizationTargetsSnapshot> {
    signal.throwIfAborted()
    if (!this.isOwnerInvocation(this.ctx.invocation)) {
      throw new Error('piTuiAuthorization: the authorization roster is restricted to the authenticated Owner peer')
    }
    if (this.disposed || this.lifecycle.signal.aborted) {
      return { kind: 'unavailable', reason: 'the Host authorization bridge is stopping' }
    }
    const authorization = this.deps.authorization()
    if (authorization === undefined) {
      return { kind: 'unavailable', reason: 'the Host authorization service is not installed' }
    }
    // The SAME route-derivation rule the Direct adapter uses: the `llm-pi-ai`
    // scope id is the provider route; any other scope has no route.
    const targets: AuthorizationFlowTarget[] = authorization.list().map(entry => ({
      kind: 'authorization',
      ...(credentialKeyScope(entry.key) === LLM_PI_AI_SCOPE
        ? { route: credentialKeyId(entry.key) }
        : {}),
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      inFlight: entry.inFlight,
    }))
    return { kind: 'ready', targets }
  }

  /**
   * ONE ordered attempt stream. The frame order is fixed: `started`, then every
   * notice/prompt/prompt-withdrawn in Host order, then exactly one terminal.
   */
  async *run(
    key: string,
    method: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<AuthorizationWireFrame> {
    signal.throwIfAborted()
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      throw new Error('piTuiAuthorization: provider authorization is restricted to the authenticated Owner peer')
    }
    if (this.disposed || this.lifecycle.signal.aborted) {
      throw new Error('piTuiAuthorization: the Host authorization bridge is stopping')
    }
    const authorization = this.deps.authorization()
    const attempt: Attempt = {
      attemptId: randomUUID(),
      peerId: invocation.peer.id,
      key: key as CredentialKey,
      controller: new AbortController(),
      frames: [],
      wake: undefined,
      prompts: new Map(),
      terminal: false,
      closed: false,
    }
    this.attempts.set(attempt.attemptId, attempt)
    // Queue `started` BEFORE the official begin: the flow may notify or prompt
    // synchronously, and the ordering fact is that the stream is admitted first.
    this.pushFrame(attempt, { kind: 'started', attemptId: attempt.attemptId })

    if (authorization !== undefined) {
      const runSignal = AbortSignal.any([
        signal,
        invocation.signal,
        invocation.peer.signal,
        this.lifecycle.signal,
        attempt.controller.signal,
      ])
      let begin: Promise<{ status: 'authorized' | 'cancelled' }> | undefined
      try {
        begin = authorization.begin({
          key: attempt.key,
          ...(method === undefined ? {} : { method }),
          interaction: {
            notify: (notice: AuthorizationNotice) => {
              this.pushFrame(attempt, {
                kind: 'notice',
                attemptId: attempt.attemptId,
                notice: {
                  message: notice.message,
                  ...(notice.url === undefined ? {} : { url: notice.url }),
                  ...(notice.code === undefined ? {} : { code: notice.code }),
                },
              })
            },
            prompt: (prompt: AuthorizationPrompt) => this.bridgePrompt(attempt, prompt),
          },
          signal: runSignal,
        })
      } catch (error) {
        this.failAttempt(attempt, error)
      }
      if (begin !== undefined) {
        // The attempt runs detached from the read loop: its settlement is a
        // stream frame, never a return value. The handlers are idempotent against
        // a stream close that already released the attempt.
        void begin.then( // allowlist: both settlement branches are handled here; the promise is the official run itself
          (outcome) => {
            this.pushFrame(attempt, {
              kind: 'settled',
              attemptId: attempt.attemptId,
              status: outcome.status === 'authorized' ? 'authorized' : 'cancelled',
            })
          },
          (error: unknown) => {
            this.failAttempt(attempt, error)
          },
        )
      }
    } else {
      this.pushFrame(attempt, {
        kind: 'settled',
        attemptId: attempt.attemptId,
        status: 'failed',
        code: 'NO_FLOW',
        message: 'the Host authorization service is not installed',
      })
    }

    try {
      for (;;) {
        if (attempt.frames.length === 0) {
          if (attempt.terminal || attempt.closed) return
          await new Promise<void>((resolve) => { attempt.wake = resolve })
          continue
        }
        const frame = attempt.frames.shift() as AuthorizationWireFrame
        if (frame.kind === 'settled' || frame.kind === 'unconfirmed') {
          // Release the attempt state BEFORE the terminal reaches the consumer:
          // a Remote stream reader stops at the terminal frame and does not ask
          // for `done`, so waiting for `finally` would keep the attempt (and its
          // official slot) alive until the carrier closes.
          this.closeAttempt(attempt)
          yield frame
          return
        }
        yield frame
      }
    } finally {
      // Reached on a terminal read, a Client dispose, a carrier loss or a Host
      // teardown. Releasing the bridge withdraws only THIS attempt's
      // non-committing official run; other peers' attempts are untouched.
      this.closeAttempt(attempt)
    }
  }

  /**
   * Answer the EXACT pending prompt of the EXACT attempt owned by the calling
   * peer. Atomic removal happens BEFORE the resolve/reject, so a re-entrant
   * answer can never reach the same prompt twice. `null` is the human's decline
   * (the official `AuthorizationDeclinedError`), never a withdrawal.
   */
  async respond(
    attemptId: string,
    promptId: string,
    answer: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    const attempt = this.ownedAttempt(attemptId)
    const pending = attempt.prompts.get(promptId)
    if (pending === undefined) {
      throw new Error('piTuiAuthorization: the prompt is no longer pending for this attempt')
    }
    attempt.prompts.delete(promptId)
    pending.cleanup()
    if (answer === null) {
      pending.reject(new AuthorizationDeclinedError('the human declined the authorization prompt'))
    } else {
      pending.resolve(answer)
    }
  }

  /**
   * Request withdrawal of the exact attempt owned by the calling peer. This
   * only aborts the official attempt: the final frame still comes from the
   * official settlement, which may be `authorized` when the commit was already
   * accepted.
   */
  async cancel(attemptId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const attempt = this.ownedAttempt(attemptId)
    attempt.controller.abort()
  }

  /** The exact owned attempt, or a refusal read before any prompt/abort action. */
  private ownedAttempt(attemptId: string): Attempt {
    const invocation = this.ctx.invocation
    if (!this.isOwnerInvocation(invocation)) {
      throw new Error('piTuiAuthorization: this operation is restricted to the authenticated Owner peer')
    }
    const attempt = this.attempts.get(attemptId)
    if (attempt === undefined || attempt.closed || attempt.terminal) {
      throw new Error('piTuiAuthorization: the authorization attempt is no longer active')
    }
    if (!Object.is(attempt.peerId, invocation.peer.id)) {
      throw new Error('piTuiAuthorization: the authorization attempt belongs to a different peer')
    }
    return attempt
  }

  private isOwnerInvocation(invocation: RemoteInvocation | undefined): invocation is RemoteInvocation {
    return invocation !== undefined
      && invocation.peer.principal.kind === 'owner'
      && !invocation.signal.aborted
      && !invocation.peer.signal.aborted
  }

  /** Bridge one official prompt into ONE prompt frame + one pending answer. */
  private bridgePrompt(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    if (attempt.closed || attempt.terminal) {
      return Promise.reject(cancellationError('the authorization attempt is no longer active'))
    }
    return new Promise<string>((resolve, reject) => {
      const promptId = randomUUID()
      let removeAbortListener = (): void => {}
      const pending: PendingPrompt = {
        resolve: (answer) => { removeAbortListener(); resolve(answer) },
        reject: (error) => { removeAbortListener(); reject(error) },
        cleanup: () => { removeAbortListener() },
      }
      attempt.prompts.set(promptId, pending)
      const withdraw = (): void => {
        if (attempt.prompts.get(promptId) !== pending) return
        attempt.prompts.delete(promptId)
        pending.cleanup()
        // A flow-retired prompt is a cancellation of THAT question, never a
        // human decline: rejecting it as AuthorizationDeclinedError would let a
        // later genuine failure be misread as `cancelled`.
        pending.reject(cancellationError('the authorization prompt was withdrawn'))
        this.pushFrame(attempt, { kind: 'prompt-withdrawn', attemptId: attempt.attemptId, promptId })
      }
      if (prompt.signal?.aborted === true) {
        withdraw()
        return
      }
      if (prompt.signal !== undefined) {
        const promptSignal = prompt.signal
        removeAbortListener = () => { promptSignal.removeEventListener('abort', withdraw) }
        promptSignal.addEventListener('abort', withdraw, { once: true })
      }
      this.pushFrame(attempt, {
        kind: 'prompt',
        attemptId: attempt.attemptId,
        promptId,
        prompt: detachedPrompt(prompt),
      })
    })
  }

  /** Queue one frame in Host order, or fail the bounded bridge loudly. */
  private pushFrame(attempt: Attempt, frame: AuthorizationWireFrame): void {
    if (attempt.closed || attempt.terminal) return
    if (attempt.frames.length >= MAX_PI_TUI_AUTHORIZATION_ATTEMPT_FRAMES) {
      this.overflow(attempt)
      return
    }
    if (frame.kind === 'settled' || frame.kind === 'unconfirmed') attempt.terminal = true
    attempt.frames.push(frame)
    const wake = attempt.wake
    attempt.wake = undefined
    wake?.()
  }

  /**
   * Bounded-queue overflow: never drop a prompt/settlement and then keep
   * reporting success. The bridge is withdrawn and the single terminal frame
   * says `failed`; the local queue is replaced so the one terminal is visible.
   */
  private overflow(attempt: Attempt): void {
    if (attempt.terminal || attempt.closed) return
    attempt.terminal = true
    attempt.frames.length = 0
    attempt.frames.push({
      kind: 'settled',
      attemptId: attempt.attemptId,
      status: 'failed',
      code: 'BRIDGE_OVERFLOW',
      message: 'the authorization event stream overflowed and was withdrawn',
    })
    attempt.controller.abort()
    this.rejectPrompts(attempt, 'the authorization event stream overflowed')
    const wake = attempt.wake
    attempt.wake = undefined
    wake?.()
  }

  /** Map one official failure to the attempt's single `failed` terminal. */
  private failAttempt(attempt: Attempt, error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code
    this.pushFrame(attempt, {
      kind: 'settled',
      attemptId: attempt.attemptId,
      status: 'failed',
      ...(typeof code === 'string' && code !== '' ? { code } : {}),
      message: safeErrorMessage(error),
    })
  }

  private rejectPrompts(attempt: Attempt, reason: string): void {
    for (const [promptId, pending] of attempt.prompts) {
      attempt.prompts.delete(promptId)
      pending.cleanup()
      pending.reject(cancellationError(reason))
    }
  }

  /**
   * The ONE idempotent release path: reject remaining prompt bridges, remove the
   * attempt from the map and abort the official run. A provider that ignores its
   * signal cannot retain the bridge, its queue or its listener.
   */
  private closeAttempt(attempt: Attempt): void {
    if (attempt.closed) return
    attempt.closed = true
    this.attempts.delete(attempt.attemptId)
    this.rejectPrompts(attempt, 'the authorization stream was closed')
    attempt.frames.length = 0
    const wake = attempt.wake
    attempt.wake = undefined
    wake?.()
    attempt.controller.abort()
  }
}
