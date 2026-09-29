/**
 * The Direct interaction adapter (M1.6 round 4; M3-3B Question
 * reconvergence) — the in-process implementation of `InteractionPort` over
 * the dsh `userQuestions` / `approval` services, the Cordis
 * `approval/request` event, and the official `userQuestions` / `inbox`
 * Session projections. This is the ONLY module in the interaction path that
 * touches `ctx`; the listeners/providers are registered by the surface owner
 * (`SurfaceRuntime.attachInteraction`) and render through TuiApp, and the
 * Remote adapter implements the SAME interface.
 *
 * M3-3B maps the SAME official rc.2 Question semantics the Remote adapter
 * maps, never a Direct-only reduction:
 *
 * ```text
 * live request     -> ctx user-questions/request waterfall
 * session identity -> request.agent.session.id (resolved HERE)
 * timed claim      -> ctx.userQuestions.attachWait(live agent, callId, signal)
 * durable state    -> ctx.sessionProjections.stateOf(session, 'userQuestions')
 * queued reply     -> ctx.sessionProjections.stateOf(session, 'inbox')
 * late answer      -> ctx.userQuestions.answer(live agent, callId, batch)
 * ```
 *
 * The Direct adapter may resolve a live Agent because that is its provider
 * implementation detail; the semantic port never exposes that fact. The
 * identity-based `setApprovalPolicy(sessionId)` is resolved to the live Agent
 * HERE (runner-injected resolver); the approval request listener is adapted
 * from the official ApprovalRequest (which carries a same-process Agent) onto
 * the transport-neutral ApprovalRequestLike.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/interaction-direct
 */

import type { ApprovalPolicy, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type {
  ApprovalRequestLike,
  ApprovalRequestListener,
  InteractionPort,
  PendingQuestionView,
  QuestionInteractionPort,
  QuestionSurfaceSnapshot,
  QuestionWaitClaim,
  SettledQuestionView,
  UserQuestionProvider,
} from '../interaction-port.ts'
import { QuestionAnswerError, questionAnswerError } from '../interaction-port.ts'

/** The minimal Host context surface the adapter needs (structural — never
 * a package dependency; the services resolve from the dsh installation). */
export interface HostContextLike {
  get(name: string): unknown
  on(event: string, listener: unknown): unknown
}

/** The structural `approval` service surface. */
export interface ApprovalServiceLike {
  setPolicy?(agent: unknown, policy: ApprovalPolicy): unknown
}

/** The structural hosted agent identity resolved from a session id. */
export interface LiveAgentLike {
  readonly session: unknown
}

/** The structural official `userQuestions` service surface (rc.2). */
export interface UserQuestionServiceLike {
  attachWait(agent: unknown, callId: string, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
  answer(agent: unknown, callId: string, answer: AskUserQuestionAnswer): boolean
}

/** The `userQuestions` projection host state, read structurally. */
interface QuestionProjectionStateLike {
  readonly questions?: {
    readonly active?: readonly {
      readonly callId: unknown
      readonly questions: readonly AskUserQuestionItem[]
      readonly state: 'open' | 'continued'
    }[]
    readonly settled?: readonly {
      readonly callId: unknown
      readonly answers: readonly { readonly id: string; readonly selected: string[]; readonly custom?: string }[]
    }[]
  }
}

/** The structural `sessionProjections` registry read the adapter needs. */
export interface SessionProjectionRegistryLike {
  stateOf(session: unknown, key: 'userQuestions' | 'inbox'): unknown
}

/** The structural durable inbox state (only the `source` facts are read). */
interface InboxStateLike {
  readonly 'next-turn'?: readonly unknown[]
  readonly 'next-step'?: readonly unknown[]
}

/** Read one inbox message's `user-question-reply` call id, or undefined. */
function queuedReplyCallId(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as { readonly source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { readonly kind?: unknown; readonly callId?: unknown }
  return record.kind === 'user-question-reply' && typeof record.callId === 'string' ? record.callId : undefined
}

/** The Direct Question sub-domain over the official rc.2 services. */
class DirectQuestionInteractionPort implements QuestionInteractionPort {
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => LiveAgentLike | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
  }

  onRequest(provider: UserQuestionProvider): boolean {
    if (this.ctx.get('userQuestions') === undefined) return false
    // DSH exposes question answerers on the scoped waterfall; the request
    // carries the live Agent, whose Session identity this adapter resolves.
    this.ctx.on('user-questions/request', ((request: {
      readonly agent?: { readonly session?: { readonly id?: unknown } }
      readonly wait?: { readonly callId?: unknown; readonly timed?: unknown }
      readonly questions: readonly AskUserQuestionItem[]
      readonly signal?: AbortSignal
    }, next: () => Promise<AskUserQuestionAnswer>) => {
      const sessionId = request.agent?.session?.id
      // An agentless programmatic request has no human Session identity to
      // key a durable card by: it is not this provider's to answer.
      if (typeof sessionId !== 'string') return next()
      const callId = request.wait?.callId
      return provider({
        sessionId,
        callId: typeof callId === 'string' ? callId : undefined,
        timed: request.wait?.timed === true,
        questions: request.questions,
        ...request.signal === undefined ? {} : { signal: request.signal },
      }, next)
    }) as unknown)
    return true
  }

  snapshot(sessionId: string): QuestionSurfaceSnapshot | undefined {
    const projections = this.ctx.get('sessionProjections') as SessionProjectionRegistryLike | undefined
    const agent = this.agentFor(sessionId)
    if (projections === undefined || agent === undefined) return undefined
    const state = projections.stateOf(agent.session, 'userQuestions') as QuestionProjectionStateLike | undefined
    // The projection unit is registered by `dsh-user-questions`; an absent
    // key is capability absence, never an authoritative empty surface.
    if (state === undefined) return undefined
    const active: PendingQuestionView[] = (state.questions?.active ?? []).map(question => ({
      callId: String(question.callId),
      sessionId,
      questions: question.questions,
      state: question.state,
    }))
    const settled: SettledQuestionView[] = (state.questions?.settled ?? []).map(question => ({
      callId: String(question.callId),
      sessionId,
      answers: question.answers,
    }))
    const inbox = projections.stateOf(agent.session, 'inbox') as InboxStateLike | undefined
    const queuedReplyCallIds = new Set<string>()
    for (const message of [...(inbox?.['next-step'] ?? []), ...(inbox?.['next-turn'] ?? [])]) {
      const callId = queuedReplyCallId(message)
      if (callId !== undefined) queuedReplyCallIds.add(callId)
    }
    return { sessionId, active, settled, queuedReplyCallIds }
  }

  async claimTimedWait(sessionId: string, callId: string): Promise<QuestionWaitClaim | undefined> {
    const userQuestions = this.ctx.get('userQuestions') as UserQuestionServiceLike | undefined
    const agent = this.agentFor(sessionId)
    if (userQuestions === undefined || agent === undefined) return undefined
    const lifetime = new AbortController()
    const iterator = userQuestions.attachWait(agent, callId, lifetime.signal)[Symbol.asyncIterator]()
    const opening = await iterator.next()
    // No first frame: no live timed wait for this call (settled, continued,
    // or never timed). Never a fabricated remaining duration.
    if (opening.done === true) return undefined
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      // Aborting the claim lifetime ends the Host wait for this holder; the
      // drain below then settles `ended`.
      lifetime.abort()
    }
    // The stream ends when the wait settles/expires, this claim releases, or
    // the carrier fails. The drain IS the claim's `ended` lifetime, so there
    // is no detached fire-and-forget promise: a consumer that never awaits
    // `ended` still leaves no unhandled rejection behind.
    const ended = (async () => {
      try {
        await iterator.next()
      } catch {
        // A stream failure ends the claim like any other settlement; the
        // durable answerability comes from the projection, not this stream.
      } finally {
        release()
      }
    })()
    return { remainingMs: opening.value.remainingMs, ended, release }
  }

  async answerContinued(
    sessionId: string,
    callId: string,
    answer: AskUserQuestionAnswer,
  ): Promise<'queued' | 'not-continued'> {
    const userQuestions = this.ctx.get('userQuestions') as UserQuestionServiceLike | undefined
    const agent = this.agentFor(sessionId)
    if (userQuestions === undefined || agent === undefined) {
      throw new QuestionAnswerError(
        'question/answer-unavailable',
        'the Host userQuestions service is unavailable for this Session',
      )
    }
    try {
      // The Host owns the taxonomy: false = the call is no longer answerable
      // as continued; REPLY_QUEUED / BAD_ANSWER / CALLER_NOT_LIVE reject.
      return userQuestions.answer(agent, callId, answer) ? 'queued' : 'not-continued'
    } catch (error) {
      // The SAME error vocabulary the Remote adapter surfaces (Host code).
      throw questionAnswerError(error)
    }
  }
}

/** The Direct backend's interaction port: the ctx services/events behind
 * the semantic `InteractionPort` interface. The `agentFor` resolver
 * converts the identity-based policy call into the live Agent. */
export class DirectInteractionPort implements InteractionPort {
  readonly questions: QuestionInteractionPort
  private readonly ctx: HostContextLike
  private readonly agentFor: (sessionId: string) => LiveAgentLike | undefined

  constructor(ctx: HostContextLike, agentFor: (sessionId: string) => LiveAgentLike | undefined) {
    this.ctx = ctx
    this.agentFor = agentFor
    this.questions = new DirectQuestionInteractionPort(ctx, agentFor)
  }

  onApprovalRequest(listener: ApprovalRequestListener): void {
    this.ctx.on('approval/request', (req: ApprovalRequest, next: unknown) => {
      // Adapt the same-process ApprovalRequest onto the transport-neutral
      // shape the TUI consumes (the listener never needs req.agent).
      const like: ApprovalRequestLike = {
        ...req.signal !== undefined ? { signal: req.signal } : {},
        callId: req.callId !== undefined ? String(req.callId) : undefined,
        toolName: req.toolName,
        reason: req.reason,
      }
      return listener(like, next)
    })
  }

  setApprovalPolicy(sessionId: string, policy: ApprovalPolicy): boolean {
    const approval = this.ctx.get('approval') as ApprovalServiceLike | undefined
    if (approval === undefined || approval.setPolicy === undefined) return false
    // Identity → live Agent resolution happens HERE (never across the
    // port): the Remote backend maps sessionId to the official wire
    // capability instead and fails closed (no public carrier).
    const agent = this.agentFor(sessionId)
    if (agent === undefined) return false
    approval.setPolicy(agent, policy)
    return true
  }
}
