/**
 * TspInteractionSeat (PR3-B B3 — the B3 addendum's §3.4-§3.8): the TSP
 * renderer's ONE modal presentation owner.
 *
 * Authority (nothing here is a second business source):
 *
 * - the OFFICIAL `InteractionPort` request and its promise stay the approval
 *   authority; this seat only renders the request and completes that SAME
 *   promise exactly once (`cancelled` is the only implicit outcome, never an
 *   allow);
 * - the OFFICIAL question request plus the ONE `QuestionSurfaceController` own
 *   claim/timed/continued/park/settled semantics; this seat owns only the
 *   foreground form's local progress (`QuestionFlowDraft` shaped) and returns
 *   answers in the original `TuiQuestionAnswer[]` format;
 * - the SDK owns the tty and the one input loop; this seat owns only the
 *   modal-first DECISION for a key the session routes in, and the layer/focus
 *   projection it hands back through `renderLayer()`/`desiredFocusId()`.
 *
 * It creates no Session, no renderer, no second input stream and no question
 * registry: `Alt+Q` reads the controller's fresh `attentionRows()` through the
 * injected callback and reopens through the controller's own `reopen()` recheck.
 *
 * @module @xmoon76/dsh-pi-tui/tui/tsp/interaction
 */

import { ui } from '@stencil-hq/tern'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import type { ActionEvent, ChangeEvent, Key, Node, Question, TspEvent } from '@stencil-hq/tern'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import { cancellationError } from '../../runtime/process/tasks.ts'
import type {
  ApprovalOutcome,
  ApprovalPromptRequest,
  SettledQuestionAnswersLookup,
  SurfaceInteractionPresenter,
  TuiQuestion,
  TuiQuestionAnswer,
  TuiQuestionStatus,
} from '../../app/surface/interaction-presenter.ts'
import type { QuestionFlowDraft } from '../../tui-app.ts'

/**
 * The layer region's root node key. The REGION id is the region name (`layer`)
 * — the root node's own key is inert for the id — so a direct child of the
 * root is addressed as `layer.<child key>` (the same rule the composer relies
 * on for `dock.composer`).
 */
const LAYER_KEY = 'interaction-layer'
/** The region id every layer node id is derived from. */
const LAYER_ID = 'layer'
/** The free-text `ui.input` key; its node id is `layer.modal-<epoch>.answer`. */
const ANSWER_KEY = 'answer'
/** The native Questions form's key, scoped by the page visit. */
const QUESTIONS_KEY = 'qform'
/** The native Tool approval's key. */
const APPROVAL_TOOL_KEY = 'approval-tool'
/** The Review button row's key, scoped by the page visit. */
const REVIEW_ROW_KEY = 'review-actions'
/** The safe (optionless/Masked) form's button row key, scoped by the visit. */
const FORM_ROW_KEY = 'form-actions'
/**
 * The arguments block's bound: a FRACTION of its overlay body, so the native
 * decision controls stay inside the visible card on a narrow or short pane
 * while the FULL text stays readable by scrolling. It is a relation to the real
 * container, never a measured pixel or line budget.
 */
const APPROVAL_ARGS_BOUNDS = { h: 0.5 } as const

/**
 * The one scoped role of the native Tool approval. The seat paints it and the
 * renderer's ONE scoped stylesheet keys on it, so the two cannot drift: it is
 * exported for exactly that reason, not as a general-purpose surface API.
 */
export const NATIVE_APPROVAL_ROLE = 'dsh-native-approval'
/** The Native item token prefix: a stable INDEX, never a source question id. */
const ITEM_PREFIX = 'q-'
/** The Native choice token prefix: a stable INDEX, never a source label. */
const CHOICE_PREFIX = 'o-'
/** The pointer action names of the Review page's three real buttons. */
const REVIEW_SUBMIT_ACTION = 'review-submit'
const REVIEW_BACK_ACTION = 'review-back'
const REVIEW_CANCEL_ACTION = 'review-cancel'
/** The pointer action names of the safe form's three real buttons. */
const FORM_NEXT_ACTION = 'form-next'
const FORM_BACK_ACTION = 'form-back'
const FORM_CANCEL_ACTION = 'form-cancel'
/** The pointer action of one option of the safe form's own choice list. */
const FORM_CHOICE_ACTION = 'form-choice'
/** The safe form's choice-list row key, scoped by the visit like its button row. */
const FORM_CHOICES_KEY = 'form-choices'
/** The native page actions the client emits on the Questions form itself. */
const PAGE_NEXT = 'next'
const PAGE_BACK = 'back'
const PAGE_SKIP = 'skip'
const PAGE_SUBMIT = 'submit'
/** The native approval actions that may carry a decision at all. */
const TOOL_ALLOW = 'allow'
const TOOL_DENY = 'deny'
/** One bullet per grapheme cluster for a masked value's DISPLAY. */
const MASK_GLYPH = '•'

/** The narrow continued-row projection the seat consumes (presentation only). */
export interface TspContinuedRow {
  readonly sessionId: string
  readonly callId: string
  readonly presentation: 'visible' | 'parked'
}

/** The application callbacks the session binds for the seat (B3 §3.3.2). */
export interface TspInteractionCallbacks {
  /** The FRESH authoritative rows; the seat filters `presentation === 'parked'`. */
  readonly listContinuedQuestions: () => readonly TspContinuedRow[]
  /** Reopen through the ORIGINAL controller (`false` = no longer answerable). */
  readonly reopenContinuedQuestion: (sessionId: string, callId: string) => boolean
}

/**
 * The event the seat gates: the official SDK union, narrowed by its `ev`
 * discriminant inside `handleEvent`. The seat reads the transport's own field
 * names (`sf`/`id`/`act`/`item`/`value`) and never a copy of them.
 */
export type TspInteractionEvent = TspEvent

/** What the seat needs from the owning renderer (session.ts). */
export interface TspInteractionSeatOptions {
  /**
   * Commit ONE frame (the session's single render path, which also applies the
   * seat's desired focus AFTER the commit). Called with the seat's current
   * `renderLayer()`/`desiredFocusId()` state.
   */
  readonly render: () => void
  /**
   * The renderer's fatal sink: a synchronous frame/focus failure while settling
   * a prompt must reach the runner's fatal lifecycle, never masquerade as an
   * ordinary modal cancellation.
   */
  readonly onFatal: (error: unknown) => void
  /** The renderer's transient notice sink. */
  readonly notify: (text: string, kind?: 'info' | 'error') => void
  /** Forward the authoritative settled-answer lookup to the transcript owner. */
  readonly setSettledQuestionAnswersLookup: (lookup: SettledQuestionAnswersLookup | undefined) => void
  /**
   * B3-A2: run when an official Approval/Question slot actually TAKES the seat
   * (in `activate`, before it becomes the visible/answerable form). The
   * renderer uses it to retire its temporary Work Details Screen, which may
   * still be painted in front of this pane: a form that is logically active
   * while physically hidden must never accept a key.
   *
   * It is NOT called for a refused/invalid request that never occupies the
   * seat, and it is idempotent (a promoted slot may run it again).
   */
  readonly beforeModalSeat?: () => void
  /**
   * The id of the ONE base surface this seat presents into. A native pointer
   * event addressed at another surface (a temporary Screen, a foreign session)
   * is a foreign object, never a near-miss: the seat checks `event.sf` against
   * this id before it reads the event's node id at all.
   */
  readonly surfaceId: string
  /**
   * Whether THIS pane negotiated the exact kind set the native Questions form
   * paints (`questions` + `button` + `input` + `overlay` + `col` + `text`).
   * Derived once from the negotiated handshake at mount — never guessed from a
   * version string or a window size. Without it the seat keeps the legacy text
   * presentation for every question.
   */
  readonly nativeQuestions: boolean
  /**
   * Whether THIS pane can carry the native Tool approval (`tool` + `overlay` +
   * `col` + `text` + `code` AND the `styles` feature). The feature half is not
   * decoration: the approval is only honest once the pane can hide the client's
   * Enter keycap, which the application deliberately refuses to treat as an
   * approval. Without it the seat keeps the legacy text approval.
   */
  readonly nativeApproval: boolean
}

/** The seat's narrow surface for its owning renderer. */
export interface TspInteractionSeat {
  /** The renderer-facing presenter (the session's `interaction` projection). */
  readonly presenter: SurfaceInteractionPresenter
  /** Whether a modal (an official request or the Alt+Q list) owns the seat. */
  hasModalSeat(): boolean
  /** Route one key. A modal seat consumes EVERY key (returns `true`). */
  handleKey(key: Key, callbacks: TspInteractionCallbacks): boolean
  /** Open the transient continued list; `false` when there is nothing to list. */
  openContinuedList(callbacks: TspInteractionCallbacks): boolean
  /** Gate one SDK event; `true` = consumed (a modal seat keeps the caret). */
  handleEvent(event: TspInteractionEvent): boolean
  /** The ONE `layer` region node for the current frame (never undefined). */
  renderLayer(): Node
  /**
   * The seat's own EMPTY layer: the same region root `renderLayer()` returns
   * when no slot and no transient list are presented. The renderer uses it to
   * hold the base surface's layer while another owner (the bounded Reader) is
   * still physically in front of this pane, so no operable form is published
   * ahead of its own visibility. It is not a queue and not a second seat.
   */
  renderEmptyLayer(): Node
  /** The node id that should hold the hardware caret (`null` = none). */
  desiredFocusId(): string | null
  /** The parked-Question count projected into the dock (`0` hides the line). */
  attentionCount(): number
  /**
   * Close the transient Alt+Q list if it is open. Called when a newly committed
   * Session takes the presentation (P3): the list belongs to the subject that
   * opened it, so it must not survive a replacement and keep consuming keys (its
   * rows are re-read FRESH from the authority the next time it opens).
   */
  closeTransientList(): void
  /** Retire every owner slot and settle every pending promise (idempotent). */
  dispose(): void
  /**
   * PR3-B B3 (finding C): withdraw ONE official request's PRESENTATION,
   * identified by the exact lifetime object its presenter call received. The
   * slot leaves the seat (it is neither rendered nor answered) while its
   * promise and its abort listener stay intact, so the Host's own cancellation
   * still settles that same promise through the ordinary classified path. A
   * replaced Session's form must never keep the modal seat or the input.
   */
  withdrawPresentations(lifetimes: readonly AbortSignal[]): void
  /** One lifetime's presentation (the batch above with a single member). */
  withdrawPresentation(lifetime: AbortSignal): void
}

// ── Client-local text helpers (the B1 editor's grapheme/UTF-16 constraints) ──
// The seat's free-text editor is deliberately NOT the composer object (the
// dock composer is a separate owner with its own lifetime), so the same
// cluster-boundary rules are applied here by the same means: one
// `Intl.Segmenter`, a boundary-aligned UTF-16 caret, and cluster-aligned
// deletion endpoints.

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Normalize a caret candidate onto a grapheme-cluster boundary (forward
 *  affinity, mirroring `tui/tsp/editor.ts`). */
function boundaryCursor(text: string, cursor: number): number {
  const clamped = Math.max(0, Math.min(text.length, cursor))
  let end = 0
  let lastClusterEnd = 0
  for (const { index, segment } of segmenter.segment(text)) {
    const clusterEnd = index + segment.length
    if (index < clamped && clusterEnd > clamped) return clusterEnd
    if (clusterEnd <= clamped) end = clusterEnd
    lastClusterEnd = clusterEnd
  }
  return clamped >= lastClusterEnd ? text.length : end
}

/** The start of the cluster immediately left of a boundary-aligned caret. */
function previousGraphemeStart(text: string, cursor: number): number {
  let result = 0
  for (const { index } of segmenter.segment(text)) {
    if (index < cursor) result = index
    else break
  }
  return result
}

/** The end of the cluster at/right of a boundary-aligned caret. */
function nextGraphemeEnd(text: string, cursor: number): number {
  for (const { index, segment } of segmenter.segment(text)) {
    const end = index + segment.length
    if (end > cursor) return end
  }
  return text.length
}

/** How many grapheme clusters start before a boundary-aligned caret. */
function graphemeCountBefore(text: string, cursor: number): number {
  let count = 0
  for (const { index } of segmenter.segment(text)) {
    if (index >= cursor) break
    count += 1
  }
  return count
}

/** The masked DISPLAY value: one bullet per grapheme cluster. */
function maskedValue(text: string): string {
  return MASK_GLYPH.repeat([...segmenter.segment(text)].length)
}

/** A key with no modifier at all (shift included). */
function bare(key: Key): boolean {
  return key.ctrl !== true && key.alt !== true && key.meta !== true && key.shift !== true
}

/**
 * A bare digit as a 0-based option index — the same numbers the native form
 * prints on its choice keycaps. `Key.name` is a lowercase character, so `1`–`9`
 * arrive as themselves and every other name parses to `NaN`.
 */
function digitOf(key: Key): number | undefined {
  const value = Number.parseInt(key.name, 10)
  return Number.isNaN(value) || value < 1 || value > 9 ? undefined : value - 1
}

/** One option label with its `(recommended)` presentation suffix split off. */
function parseRecommended(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*\(recommended\)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/**
 * The external-boundary validation of an official question payload (§3.7): a
 * request the seat cannot represent is refused with a visible notice and NO
 * fabricated answer. Returns the diagnostic, or `undefined` when representable.
 */
function unrepresentable(questions: readonly TuiQuestion[]): string | undefined {
  for (const question of questions) {
    if (typeof question.id !== 'string' || question.id === '') return 'a question has no id'
    if (typeof question.question !== 'string' || question.question === '') return 'a question has no text'
    if (question.options === undefined) continue
    if (!Array.isArray(question.options)) return 'a question payload declares no option list'
    for (const option of question.options) {
      if (typeof option?.label !== 'string' || option.label === '') return 'an option has no label'
    }
  }
  return undefined
}

/** One question's local progress (the `QuestionFlowDraft` answer shape). */
interface SlotDraft {
  selected: Set<string>
  custom: string
  skipped: boolean
}

/** One selectable row of the current question. */
interface SeatRow {
  readonly kind: 'option' | 'other'
  /** The presentation label (the `(recommended)` suffix stripped). */
  readonly label: string
  readonly description: string | undefined
  readonly recommended: boolean
  /** The ORIGINAL option label (the answer value); `undefined` for the other row. */
  readonly value: string | undefined
}

interface ApprovalSlot {
  readonly kind: 'approval'
  readonly request: ApprovalPromptRequest
  readonly signal: AbortSignal | undefined
  readonly resolve: (outcome: ApprovalOutcome) => void
  detach: (() => void) | undefined
  settled: boolean
}

interface QuestionSlot {
  readonly kind: 'question'
  readonly questions: readonly TuiQuestion[]
  readonly status: TuiQuestionStatus | undefined
  readonly signal: AbortSignal | undefined
  readonly resolve: (answers: TuiQuestionAnswer[]) => void
  readonly reject: (error: unknown) => void
  readonly drafts: SlotDraft[]
  detach: (() => void) | undefined
  settled: boolean
  /** The current page: `0..questions.length-1`, or `questions.length` = review. */
  tab: number
  /**
   * The page/Review VISIT identity. Every move onto or off a page bumps it, so
   * the native form and the Review buttons of a re-visited page get NEW node
   * ids: a pointer event produced by a superseded visit can never be addressed
   * at the current one. A draft mutation or a status repaint on the SAME page
   * never bumps it (that would remount the native form and drop its own
   * selection/focus). It scopes ids only — never a second page state.
   */
  visitEpoch: number
  /**
   * Whether this page has ASKED for the keyboard cursor (the first Arrow move).
   * The native Questions form has no public highlight prop, so the keyboard
   * path shows its own one-line cursor instead of faking a selection; a real
   * choice or a page change hides it again. Presentation only.
   */
  keyboardCursorShown: boolean
  /** The highlighted row of the current question's option list. */
  highlight: number
  /** The question whose free-text editor is open (`undefined` = list/navigation). */
  editing: number | undefined
  /** The question the live text buffer belongs to (fresh-owner seed rule). */
  textOwner: number
  text: string
  /** A boundary-aligned UTF-16 caret into `text`. */
  cursor: number
}

type Slot = ApprovalSlot | QuestionSlot

/** Create the TSP renderer's ONE interaction seat. */
export function createTspInteractionSeat(options: TspInteractionSeatOptions): TspInteractionSeat {
  /** The slot that currently owns the modal seat. */
  let active: Slot | undefined
  /** The pending official requests, in arrival order (one seat, one queue). */
  const fifo: Slot[] = []
  /**
   * The requests a REPLACED Session's publication withdrew from the seat: they
   * no longer own the presentation, but they are still OWNED here — the promise
   * and its abort listener stay, so the Host's cancellation settles the same
   * request exactly once and a teardown can still reach it.
   */
  const withdrawn: Slot[] = []
  /**
   * The lifetimes a replaced Session retired while their presentation was still
   * OPENING (the controller's timed claim has not returned, so no slot exists
   * yet). The form is never mounted for them: the request keeps its own
   * lifetime and the ordinary abort path still settles that same promise.
   */
  const retiredLifetimes = new WeakSet<AbortSignal>()
  /** The transient Alt+Q list seat (NEVER a Question registry). */
  let listOpen = false
  /** The list's highlighted `(sessionId, callId)` and its last numeric index. */
  let listSelection: { readonly sessionId: string; readonly callId: string } | undefined
  let listIndex = 0
  /** The callbacks the list re-reads the authority through. */
  let listCallbacks: TspInteractionCallbacks | undefined
  /** Scopes the modal node ids and rejects late presentation of an old seat. */
  let modalEpoch = 0
  let attention = 0
  let disposed = false

  // ── Seat ownership ──

  const activate = (slot: Slot): void => {
    active = slot
    modalEpoch += 1
    // B3-A2: the LOGICAL seat is committed above; the renderer now retires any
    // temporary Screen still painted in front of this pane BEFORE the form can
    // accept a key (its own close is asynchronous and owned by the renderer).
    options.beforeModalSeat?.()
  }

  const detachSlot = (slot: Slot): void => {
    slot.detach?.()
    slot.detach = undefined
  }

  /** Remove `slot` from the seat WITHOUT completing its promise. */
  const removeSlot = (slot: Slot): void => {
    detachSlot(slot)
    if (active === slot) active = undefined
    const index = fifo.indexOf(slot)
    if (index >= 0) fifo.splice(index, 1)
    const parked = withdrawn.indexOf(slot)
    if (parked >= 0) withdrawn.splice(parked, 1)
  }

  /**
   * Withdraw ONE request's PRESENTATION (B3 findings C/F6/F7): the slot leaves
   * the seat — never rendered, never answered, its abort listener still attached
   * so the Host's own cancellation settles that SAME promise through the
   * ordinary classified path. The slot stays owned here, so a surface teardown
   * still settles it exactly once. A lifetime whose presentation is still
   * OPENING (the controller's timed claim) has no slot yet: it is remembered as
   * retired, so the form is never mounted once the claim lands.
   */
  const withdrawPresentations = (lifetimes: readonly AbortSignal[]): void => {
    if (disposed || lifetimes.length === 0) return
    // ONE atomic batch (external review round 4): every listed lifetime leaves the
    // seat FIRST, and only then is the successor picked and ONE frame committed.
    // A request that is about to be withdrawn can therefore never be promoted —
    // and never painted — in between, which is the contract a publication owes
    // once the new owner is current.
    const selected = new Set<Slot>()
    for (const lifetime of lifetimes) {
      const slot = (active !== undefined && active.signal === lifetime ? active : undefined)
        ?? fifo.find(candidate => candidate.signal === lifetime)
        ?? withdrawn.find(candidate => candidate.signal === lifetime)
      if (slot === undefined) {
        // A lifetime whose presentation is still OPENING has no slot yet: it is
        // remembered as retired, so the form is never mounted once the claim lands.
        retiredLifetimes.add(lifetime)
        continue
      }
      if (slot.settled) continue
      selected.add(slot)
    }
    if (selected.size === 0) return
    for (const slot of selected) {
      if (active === slot) active = undefined
      const index = fifo.indexOf(slot)
      if (index >= 0) fifo.splice(index, 1)
      withdrawn.push(slot)
    }
    promote()
    try {
      options.render()
    } catch (error) {
      // The renderer's OWN frame/focus commit failed while withdrawing a
      // replaced presentation: the terminal is broken, so this is the SAME
      // fatal path as a failing presentation or settlement (the slots already
      // left the seat and their promises are deliberately NOT settled here — the
      // fatal lifecycle and the surface release owner own the rest). The
      // original error reaches the sink unchanged.
      options.onFatal(error)
    }
  }

  /** One lifetime's presentation (the batch above with a single member). */
  const withdrawPresentation = (lifetime: AbortSignal): void => {
    withdrawPresentations([lifetime])
  }

  /** Hand the seat to the next queued request (only when it is free). */
  const promote = (): void => {
    if (active !== undefined) return
    const next = fifo.shift()
    if (next !== undefined) activate(next)
  }

  const enqueue = (slot: Slot): void => {
    // An official request PREEMPTS the transient list: the list is not a Host
    // request and never delays one (the parked facts stay with the controller;
    // only the presentation is withdrawn).
    if (listOpen) closeList()
    if (active === undefined) activate(slot)
    else fifo.push(slot)
  }

  /**
   * Complete one slot exactly once. The retiring slot leaves the seat, the
   * successor (if any) becomes active, the FRAME of the new seat is committed,
   * and only then does the ORIGINAL promise settle. The two obligations are
   * independent (`runSyncDisposalSteps`): a failing frame commit still settles
   * the promise exactly once and reaches the renderer's fatal lifecycle.
   */
  const settle = (slot: Slot, complete: () => void): void => {
    if (slot.settled) return
    slot.settled = true
    const wasActive = active === slot
    removeSlot(slot)
    if (wasActive) promote()
    try {
      runSyncDisposalSteps('tsp interaction settlement', [
        () => { if (wasActive) options.render() },
        complete,
      ])
    } catch (error) {
      options.onFatal(error)
    }
  }

  const watchAbort = (slot: Slot, onAbort: () => void): void => {
    const signal = slot.signal
    if (signal === undefined) return
    signal.addEventListener('abort', onAbort, { once: true })
    slot.detach = () => { signal.removeEventListener('abort', onAbort) }
  }

  /**
   * A RETIRED lifetime's presentation must never mount (its Session was replaced
   * while the flow was still opening, B3 finding F7): the slot is kept OUT of the
   * seat with its abort listener attached, so only its own lifetime settles it.
   * Returns `true` when the caller must not present the slot.
   */
  const withheld = (slot: Slot): boolean => {
    const lifetime = slot.signal
    if (lifetime === undefined || !retiredLifetimes.has(lifetime)) return false
    withdrawn.push(slot)
    return true
  }

  /**
   * A frame/focus failure while a slot is being PRESENTED for the first time.
   * The terminal is broken, so this is the renderer's FATAL path, never an
   * ordinary modal cancellation: the slot is retired (a ghost seat must not
   * keep swallowing keys while `supportsModals` stays true), its original
   * promise settles exactly once (approval `cancelled` — never an allow —
   * and the question the flow's cancellation error), and the failure reaches
   * the fatal lifecycle through the renderer's own sink.
   */
  const failPresentation = (slot: Slot, error: unknown): void => {
    if (!slot.settled) {
      slot.settled = true
      removeSlot(slot)
      promote()
      if (slot.kind === 'approval') slot.resolve('cancelled')
      else slot.reject(cancellationError('question flow cancelled'))
    }
    options.onFatal(error)
  }

  /** Present the slot that just became active; a failing frame is fatal. */
  const presentActive = (slot: Slot): void => {
    if (active !== slot) return
    try {
      options.render()
    } catch (error) {
      failPresentation(slot, error)
    }
  }

  /** Retire every owner slot, settling each pending promise exactly once. */
  const retireAll = (): void => {
    if (disposed) return
    disposed = true
    listOpen = false
    listCallbacks = undefined
    const slots: Slot[] = [...(active === undefined ? [] : [active]), ...fifo, ...withdrawn]
    active = undefined
    fifo.length = 0
    withdrawn.length = 0
    // A reentrant callback cannot reopen the seat: `disposed` is already
    // latched. The non-truncating batch keeps one refusing promise from
    // stranding the rest.
    runSyncDisposalSteps('tsp interaction seat withdrawal', slots.map(slot => () => {
      slot.settled = true
      detachSlot(slot)
      if (slot.kind === 'approval') slot.resolve('cancelled')
      else slot.reject(cancellationError('question flow cancelled'))
    }))
  }

  // ── The question form's local state ──

  const questionAt = (slot: QuestionSlot, index: number): TuiQuestion | undefined => slot.questions[index]

  /** The selectable rows of the current question (options + the free-text row). */
  const seatRows = (slot: QuestionSlot): readonly SeatRow[] => {
    const question = questionAt(slot, slot.tab)
    if (question === undefined) return []
    const seat: SeatRow[] = (question.options ?? []).map(option => {
      const { label, recommended } = parseRecommended(option.label)
      return {
        kind: 'option' as const,
        label,
        description: option.description,
        recommended: recommended || (question.intent?.approve !== undefined && option.label === question.intent.approve),
        value: option.label,
      }
    })
    if ((question.options?.length ?? 0) > 0) {
      seat.push({ kind: 'other', label: 'Type something.', description: undefined, recommended: false, value: undefined })
    }
    return seat
  }

  /** Whether the current page is a pure free-text question (no option list). */
  const optionless = (slot: QuestionSlot): boolean => {
    if (slot.tab >= slot.questions.length) return false
    const seat = seatRows(slot)
    return seat.length === 0 || (seat.length === 1 && seat[0]?.kind === 'other')
  }

  /** The current question's draft (the drafts array mirrors `questions`). */
  const draftAt = (slot: QuestionSlot, index: number): SlotDraft | undefined => slot.drafts[index]

  const hasCustomAnswer = (draft: SlotDraft): boolean => draft.custom.trim() !== ''

  const draftAnswered = (draft: SlotDraft): boolean =>
    draft.selected.size > 0 || hasCustomAnswer(draft) || draft.skipped

  const snapshotDraft = (slot: QuestionSlot): QuestionFlowDraft => ({
    tab: slot.tab,
    answers: slot.questions.map((_question, index) => {
      const draft = slot.drafts[index] as SlotDraft
      return { selected: [...draft.selected], custom: draft.custom, skipped: draft.skipped }
    }),
  })

  /** The real-answer mutation hook pair (§3.7): the countdown freeze and the
   *  park/reopen draft snapshot both observe REAL answer changes only. */
  const notifyMutation = (slot: QuestionSlot): void => {
    slot.status?.onAnswerMutation?.()
    slot.status?.onDraftChange?.(snapshotDraft(slot))
  }

  /** The answer labels of one question in ORIGINAL option order. */
  const orderedSelection = (question: TuiQuestion, draft: SlotDraft): string[] =>
    (question.options ?? []).filter(option => draft.selected.has(option.label)).map(option => option.label)

  /** The answer summary shown on the review page (masked values stay masked). */
  const answerSummary = (question: TuiQuestion, draft: SlotDraft): string => {
    if (draft.skipped) return '(skipped)'
    const custom = question.masked === true ? maskedValue(draft.custom) : draft.custom
    const parts = [...orderedSelection(question, draft)]
    if (custom.trim() !== '') parts.push(custom.trim())
    return parts.length === 0 ? '(not answered)' : parts.join(' · ')
  }

  /** Seed the free-text editor for the current question (a NEW owner only, so
   *  an Esc → Enter round trip keeps the in-progress text and caret). */
  const seedText = (slot: QuestionSlot): void => {
    if (slot.textOwner === slot.tab) return
    slot.textOwner = slot.tab
    slot.text = draftAt(slot, slot.tab)?.custom ?? ''
    slot.cursor = slot.text.length
  }

  /**
   * The ONE "apply a selection" entry: the keyboard row and the native pointer
   * both arrive here, so there is exactly one answer semantic in the seat.
   * `labels` is the COMPLETE selection the caller wants for the current
   * question. A single-select choice replaces the selection AND clears a custom
   * answer (`submitBatch` prefers a nonblank custom for single-select, so
   * keeping it would submit old text instead of the choice just made) — and the
   * LIVE editor buffer goes with it, or the replaced text would resurrect the
   * moment this question's Other row is opened again. An empty multi-select set
   * clears the choices but never fabricates a skip (the `syncTextDraft` rule).
   * With `toggle` the labels are ADDED to / REMOVED from the existing set (the
   * multi-select rule), so a second pick never discards the first one.
   */
  const applySelection = (slot: QuestionSlot, labels: readonly string[], toggle = false): void => {
    const draft = draftAt(slot, slot.tab)
    const question = questionAt(slot, slot.tab)
    if (draft === undefined || question === undefined) return
    if (question.multiSelect !== true && labels.length > 1) return
    if (toggle && question.multiSelect !== true) return
    const before = answerKey(draft)
    if (!toggle) draft.selected.clear()
    for (const label of labels) {
      if (toggle) {
        if (draft.selected.has(label)) draft.selected.delete(label)
        else draft.selected.add(label)
      } else draft.selected.add(label)
    }
    if (draft.selected.size > 0) draft.skipped = false
    if (question.multiSelect !== true && draft.selected.size > 0) {
      draft.custom = ''
      if (slot.textOwner === slot.tab) {
        slot.text = ''
        slot.cursor = 0
      }
    }
    if (answerKey(draft) !== before) {
      slot.keyboardCursorShown = false
      notifyMutation(slot)
    }
  }


  /** The recommended row (intent.approve match, else a `(recommended)` suffix). */
  const seedHighlight = (slot: QuestionSlot): void => {
    const seat = seatRows(slot)
    if (seat.length === 0) {
      slot.highlight = 0
      return
    }
    const question = questionAt(slot, slot.tab)
    const approve = question?.intent?.approve
    const approveIndex = approve === undefined ? -1 : (question?.options ?? []).findIndex(option => option.label === approve)
    const recommended = seat.findIndex(row => row.recommended)
    slot.highlight = approveIndex >= 0 ? approveIndex : recommended >= 0 ? recommended : 0
  }

  /** Synchronize the page-local mode after a page change (or at construction). */
  const syncQuestionState = (slot: QuestionSlot): void => {
    slot.keyboardCursorShown = false
    // The live buffer belongs to a PAGE: `seedText` re-seeds it whenever the
    // page changes, so a page never paints (or commits) another page's text.
    // This is load-bearing for a masked answer: without it the secret of the
    // previous page would be handed to the next page's answer field, and the
    // native form always paints that field.
    seedText(slot)
    // The SAFE form (masked / optionless) always shows its answer field, so the
    // page opens with that field as the editor — otherwise the pane paints an
    // input no keyboard can reach and the keys would go to the composer seat.
    // A masked page WITH options is the same page: the field is still the
    // primary answer surface, and its choices stay pointer targets.
    // The safe form PRESENTS the same way for masked and optionless pages, but
    // the initial EDITING state is a different question: only a page with NO
    // choices opens with the field, because there is nothing else to operate.
    // A masked page that carries choices opens on option navigation (§2.4: a
    // digit selects directly and stays on the page); its field is entered by
    // clicking it, and Esc then leaves the edit — the two-layer contract.
    if (optionless(slot)) {
      slot.editing = slot.tab
      return
    }
    slot.editing = undefined
    seedHighlight(slot)
  }

  /** The ONE page move. Every entry (keyboard, native Next/Skip/Back/Submit)
   *  goes through here, so a new page always gets a new native node id. */
  const advance = (slot: QuestionSlot): void => {
    slot.tab += 1
    slot.visitEpoch += 1
    syncQuestionState(slot)
  }

  const moveBack = (slot: QuestionSlot): void => {
    slot.tab = Math.max(0, slot.tab - 1)
    slot.visitEpoch += 1
    syncQuestionState(slot)
  }

  /** Forward paging with the ONE continue/skip authority (an unanswered
   *  question is marked skipped; an answered one is left untouched). */
  const moveForward = (slot: QuestionSlot): void => {
    const index = slot.tab
    if (index < slot.questions.length) {
      const draft = draftAt(slot, index)
      if (draft !== undefined && !draftAnswered(draft)) {
        draft.selected.clear()
        draft.custom = ''
        draft.skipped = true
        notifyMutation(slot)
        // `onAnswerMutation` is an external, reentrant callback: it can retire
        // or replace this very request. Nothing below may then page a slot that
        // is no longer the seat's own.
        if (active !== slot || slot.settled) return
      }
    }
    advance(slot)
  }

  /**
   * An explicit Skip of the CURRENT question: its local answer is dropped (a
   * question the user skipped must never carry an old choice into the final
   * batch), the draft is marked skipped, and the page advances once. This is the
   * native Skip button; the keyboard Right keeps {@link moveForward}'s
   * answered-stays rule.
   */
  const skipCurrent = (slot: QuestionSlot): void => {
    const draft = draftAt(slot, slot.tab)
    if (draft !== undefined) {
      const before = answerKey(draft)
      draft.selected.clear()
      draft.custom = ''
      draft.skipped = true
      if (slot.textOwner === slot.tab) {
        slot.text = ''
        slot.cursor = 0
      }
      if (answerKey(draft) !== before) notifyMutation(slot)
      if (active !== slot || slot.settled) return
    }
    advance(slot)
  }

  /** Open the Review page (the one `tab === questions.length` state). */
  const goReview = (slot: QuestionSlot): void => {
    advance(slot)
  }

  const enterEdit = (slot: QuestionSlot): void => {
    slot.editing = slot.tab
    seedText(slot)
  }

  /** Sync the live editor text into the draft (the QuestionFlow
   *  `syncCustomDraft` semantics: a real value change only; a nonblank custom
   *  replaces a single-select choice; clearing never fabricates a skip). */
  const syncTextDraft = (slot: QuestionSlot): void => {
    const draft = draftAt(slot, slot.tab)
    if (draft === undefined) return
    if (slot.text === draft.custom) return
    draft.custom = slot.text
    draft.skipped = false
    if (hasCustomAnswer(draft) && questionAt(slot, slot.tab)?.multiSelect !== true) draft.selected.clear()
    notifyMutation(slot)
  }

  const insertText = (slot: QuestionSlot, text: string): void => {
    if (text === '') return
    slot.text = slot.text.slice(0, slot.cursor) + text + slot.text.slice(slot.cursor)
    slot.cursor = boundaryCursor(slot.text, slot.cursor + text.length)
    syncTextDraft(slot)
  }

  const deleteBackward = (slot: QuestionSlot): void => {
    if (slot.cursor === 0) return
    const start = previousGraphemeStart(slot.text, slot.cursor)
    slot.text = slot.text.slice(0, start) + slot.text.slice(slot.cursor)
    slot.cursor = start
    syncTextDraft(slot)
  }

  const deleteForward = (slot: QuestionSlot): void => {
    if (slot.cursor >= slot.text.length) return
    const end = nextGraphemeEnd(slot.text, slot.cursor)
    slot.text = slot.text.slice(0, slot.cursor) + slot.text.slice(end)
    syncTextDraft(slot)
  }

  /** Enter / the Input's submit seam while editing: the empty answer continues
   *  (a skipped mark with no earlier selection), a nonblank value is committed
   *  as the answer, then the flow advances. */
  const commitText = (slot: QuestionSlot): void => {
    const draft = draftAt(slot, slot.tab)
    if (draft === undefined) return
    if (slot.text.trim() === '') {
      if (draft.selected.size === 0 && !draft.skipped) {
        draft.skipped = true
        notifyMutation(slot)
      }
    } else {
      syncTextDraft(slot)
    }
    slot.editing = undefined
    advance(slot)
  }

  /**
   * The ANSWER SEMANTICS of one draft: exactly the values `submitBatch` reads,
   * so a mutation that changes none of them is a no-op for the controller's
   * real-answer hooks (re-confirming the same option, re-entering the same
   * text, a restored `initialDraft` the user simply accepts).
   */
  const answerKey = (draft: SlotDraft): string =>
    JSON.stringify({ selected: [...draft.selected].sort(), custom: draft.custom, skipped: draft.skipped })

  /** Enter (or Space on the free-text row) on the option list. */
  const confirmRow = (slot: QuestionSlot): void => {
    const seat = seatRows(slot)
    const row = seat[slot.highlight]
    if (row === undefined || row.kind === 'other') {
      enterEdit(slot)
      return
    }
    const question = questionAt(slot, slot.tab)
    if (question === undefined || row.value === undefined) return
    if (question.multiSelect === true) {
      // Enter on a multi-select list is the continue/skip authority, never a
      // toggle (Space is the toggle).
      moveForward(slot)
      return
    }
    applySelection(slot, [row.value])
    advance(slot)
  }

  /** Space on a multi-select option (a real change only). */
  const toggleRow = (slot: QuestionSlot): void => {
    const seat = seatRows(slot)
    const row = seat[slot.highlight]
    if (row === undefined) return
    if (row.kind === 'other') {
      enterEdit(slot)
      return
    }
    const draft = draftAt(slot, slot.tab)
    if (draft === undefined || row.value === undefined) return
    const labels = [...draft.selected]
    applySelection(slot, draft.selected.has(row.value)
      ? labels.filter(label => label !== row.value)
      : [...labels, row.value])
  }

  /** The final answer batch, normalized EXACTLY like `QuestionFlow.submit()`:
   *  `skipped` → no answer; a nonblank single-select custom replaces the
   *  selection; otherwise the real option labels in original order (with an
   *  optional nonblank custom for multi-select). */
  const submitBatch = (slot: QuestionSlot): void => {
    const answers: TuiQuestionAnswer[] = slot.questions.map((question, index) => {
      const draft = slot.drafts[index] as SlotDraft
      if (draft.skipped) return { id: question.id, selected: [] }
      const custom = draft.custom.trim()
      if (custom !== '' && question.multiSelect !== true) return { id: question.id, selected: [], custom }
      return {
        id: question.id,
        selected: orderedSelection(question, draft),
        ...custom === '' ? {} : { custom },
      }
    })
    settleQuestion(slot, () => slot.resolve(answers))
  }

  /** Settle a question slot, reporting the FINAL draft first (pure navigation
   *  progress survives a park, exactly like the live flow's own teardown). */
  const settleQuestion = (slot: QuestionSlot, complete: () => void): void => {
    if (slot.settled) return
    slot.status?.onDraftChange?.(snapshotDraft(slot))
    settle(slot, complete)
  }

  const cancelQuestion = (slot: QuestionSlot): void => {
    settleQuestion(slot, () => slot.reject(cancellationError('question flow cancelled')))
  }

  // ── The Alt+Q continued list (presentation of the ONE controller's rows) ──

  const closeList = (): void => {
    listOpen = false
    listSelection = undefined
    listCallbacks = undefined
  }

  const listRows = (callbacks: TspInteractionCallbacks): readonly TspContinuedRow[] =>
    callbacks.listContinuedQuestions().filter(row => row.presentation === 'parked')

  /** The current frame's list rows and highlight, re-read from the authority:
   *  the previous selection is kept by identity, else the numeric index is
   *  clamped into range. */
  const listState = (callbacks: TspInteractionCallbacks): { rows: readonly TspContinuedRow[]; index: number } => {
    const rows = listRows(callbacks)
    if (rows.length === 0) return { rows, index: 0 }
    const selected = listSelection
    const found = selected === undefined
      ? -1
      : rows.findIndex(row => row.sessionId === selected.sessionId && row.callId === selected.callId)
    const index = found >= 0 ? found : Math.max(0, Math.min(listIndex, rows.length - 1))
    const row = rows[index]
    if (row !== undefined) {
      listIndex = index
      listSelection = { sessionId: row.sessionId, callId: row.callId }
    }
    return { rows, index }
  }

  /** Open the transient list; `false` when there is nothing to show. */
  const openContinuedList = (callbacks: TspInteractionCallbacks): boolean => {
    if (disposed || active !== undefined) return false
    const rows = listRows(callbacks)
    if (rows.length === 0) {
      options.notify('No continued questions', 'info')
      return false
    }
    listOpen = true
    listCallbacks = callbacks
    listIndex = 0
    const first = rows[0]
    listSelection = first === undefined ? undefined : { sessionId: first.sessionId, callId: first.callId }
    modalEpoch += 1
    options.render()
    return true
  }

  const closeTransientList = (): void => {
    if (disposed || !listOpen) return
    closeList()
    try {
      options.render()
    } catch (error) {
      // Same fatal contract as the withdrawal above: the publication commit calls
      // this synchronously, so a frame failure must reach the fatal sink rather
      // than escape into the transaction.
      options.onFatal(error)
    }
  }

  /** Enter on the list: capture the candidate, close the list and commit the
   *  empty seat FIRST, then let the ORIGINAL controller decide. A refusal is
   *  only notified — the seat never mounts a form of its own. */
  const reopenSelected = (callbacks: TspInteractionCallbacks): void => {
    const { rows, index } = listState(callbacks)
    const row = rows[index]
    closeList()
    options.render()
    if (row === undefined) return
    if (!callbacks.reopenContinuedQuestion(row.sessionId, row.callId)) {
      options.notify('That question is no longer answerable', 'info')
    }
  }

  const handleListKey = (key: Key, callbacks: TspInteractionCallbacks): boolean => {
    const { rows, index } = listState(callbacks)
    if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) {
      closeList()
      options.render()
      return true
    }
    if (key.name === 'up') {
      listIndex = Math.max(0, index - 1)
      const row = rows[listIndex]
      listSelection = row === undefined ? undefined : { sessionId: row.sessionId, callId: row.callId }
      options.render()
      return true
    }
    if (key.name === 'down') {
      listIndex = Math.min(rows.length - 1, index + 1)
      const row = rows[listIndex]
      listSelection = row === undefined ? undefined : { sessionId: row.sessionId, callId: row.callId }
      options.render()
      return true
    }
    if (key.name === 'enter' && bare(key)) {
      reopenSelected(callbacks)
      return true
    }
    return true
  }

  // ── Per-kind key routing ──

  const handleApprovalKey = (slot: ApprovalSlot, key: Key): boolean => {
    if (key.name === 'escape' || (key.ctrl === true && key.name === 'c')) {
      settle(slot, () => slot.resolve('cancelled'))
      return true
    }
    if (bare(key) && key.name === 'y') {
      settle(slot, () => slot.resolve('allowed-once'))
      return true
    }
    if (bare(key) && key.name === 'n') {
      settle(slot, () => slot.resolve('rejected'))
      return true
    }
    // Every other key (Ctrl+D, Enter, Alt/Ctrl-modified y/n, a pasted `y`, an
    // unknown control key) is consumed and never reaches the composer.
    return true
  }

  const handleQuestionKey = (slot: QuestionSlot, key: Key): boolean => {
    const cancel = key.name === 'escape' || (key.ctrl === true && key.name === 'c')
    if (slot.tab >= slot.questions.length) {
      // The review page: only an unmodified Enter submits; ← returns to the
      // last question (a presentation-only move); Esc/Ctrl+C cancels the form.
      if (cancel) {
        cancelQuestion(slot)
        return true
      }
      if (key.name === 'enter' && bare(key)) {
        submitBatch(slot)
        return true
      }
      if (key.name === 'left') {
        moveBack(slot)
        options.render()
        return true
      }
      return true
    }
    if (slot.editing === slot.tab) {
      // Free-text editing: the first Esc leaves the edit (the text survives).
      if (cancel) {
        slot.editing = undefined
        options.render()
        return true
      }
      if (key.name === 'enter' && bare(key)) {
        commitText(slot)
        options.render()
        return true
      }
      if (key.name === 'paste' && key.text !== undefined) {
        insertText(slot, key.text)
        options.render()
        return true
      }
      if (key.name === 'backspace') {
        deleteBackward(slot)
        options.render()
        return true
      }
      if (key.name === 'delete') {
        deleteForward(slot)
        options.render()
        return true
      }
      if (key.name === 'left') {
        slot.cursor = previousGraphemeStart(slot.text, slot.cursor)
        options.render()
        return true
      }
      if (key.name === 'right') {
        slot.cursor = nextGraphemeEnd(slot.text, slot.cursor)
        options.render()
        return true
      }
      if (key.name === 'home') {
        slot.cursor = 0
        options.render()
        return true
      }
      if (key.name === 'end') {
        slot.cursor = slot.text.length
        options.render()
        return true
      }
      if (key.text !== undefined && key.ctrl !== true && key.alt !== true && key.meta !== true) {
        insertText(slot, key.text)
        options.render()
        return true
      }
      return true
    }
    // The option list / navigation state.
    if (cancel) {
      cancelQuestion(slot)
      return true
    }
    const seat = seatRows(slot)
    if (key.name === 'up') {
      slot.highlight = Math.max(0, slot.highlight - 1)
      slot.keyboardCursorShown = true
      options.render()
      return true
    }
    if (key.name === 'down') {
      slot.highlight = Math.min(seat.length - 1, slot.highlight + 1)
      slot.keyboardCursorShown = true
      options.render()
      return true
    }
    if (key.name === 'left') {
      moveBack(slot)
      options.render()
      return true
    }
    if (key.name === 'right') {
      moveForward(slot)
      options.render()
      return true
    }
    if (key.name === 'enter' && bare(key)) {
      confirmRow(slot)
      options.render()
      return true
    }
    if (key.name === 'space' && questionAt(slot, slot.tab)?.multiSelect === true) {
      toggleRow(slot)
      options.render()
      return true
    }
    // A bare digit picks the option it numbers on the native form and STAYS on
    // the page (the native keycaps are the same numbers).
    const digit = digitOf(key)
    if (digit !== undefined && bare(key)) {
      const row = seat[digit]
      if (row !== undefined && row.kind === 'option' && row.value !== undefined) {
        const draft = draftAt(slot, slot.tab)
        if (draft !== undefined) {
          const multi = questionAt(slot, slot.tab)?.multiSelect === true
          // A digit applies the SAME one selection entry as a click or Enter:
          // a single-select choice, or one member of the multi-select set
          // (which toggles, exactly like Space).
          applySelection(slot, multi && draft.selected.has(row.value)
            ? [...draft.selected].filter(label => label !== row.value)
            : multi ? [...draft.selected, row.value] : [row.value])
          slot.highlight = digit
        }
      }
      options.render()
      return true
    }
    // Tab, Shift+Tab and every other control key are consumed with no second
    // shortcut vocabulary.
    return true
  }

  // ── The layer projection ──

  const overlayKey = (): string => `modal-${modalEpoch}`

  /** The wire id of one DIRECT child of the current modal overlay. The id is
   *  the region name plus the keys the tree was really built with — the same
   *  derivation the SDK performs — never a guessed path. */
  const overlayId = (key: string): string => `${LAYER_ID}.${overlayKey()}.${key}`

  /** The native Questions form's key/id for THIS page visit. The visit epoch is
   *  what makes a superseded visit's node id unreachable. */
  const questionsKey = (slot: QuestionSlot): string => `${QUESTIONS_KEY}-${slot.visitEpoch}`
  const questionsId = (slot: QuestionSlot): string => overlayId(questionsKey(slot))

  /** The SDK's `other` answer child of the native form: keyed `<item>.other`. */
  const otherKey = (slot: QuestionSlot): string => `${ITEM_PREFIX}${slot.tab}.other`
  const otherId = (slot: QuestionSlot): string => `${questionsId(slot)}.${otherKey(slot)}`

  /** The Review row's key/id: scoped by the visit, so an earlier visit's
   *  Submit button is a DIFFERENT node and can never commit again. */
  const reviewRowKey = (slot: QuestionSlot): string => `${REVIEW_ROW_KEY}-${slot.visitEpoch}`
  /** The safe form's button row, scoped by the visit for the same reason. */
  const formRowKey = (slot: QuestionSlot): string => `${FORM_ROW_KEY}-${slot.visitEpoch}`
  /** The safe form's own choice list, and one option's pick button inside it. */
  const formChoicesKey = (slot: QuestionSlot): string => `${FORM_CHOICES_KEY}-${slot.visitEpoch}`
  const formChoiceId = (slot: QuestionSlot, index: number): string =>
    `${overlayId(formChoicesKey(slot))}.${CHOICE_PREFIX}${index}.pick`

  /** One button of the current Review row / safe-form row, by its real id. */
  const rowButtonId = (rowKey: string, buttonKey: string): string => `${overlayId(rowKey)}.${buttonKey}`

  /** Whether the CURRENT page is the native choice/steps presentation. */
  const usesNativeSteps = (slot: QuestionSlot): boolean => {
    if (!options.nativeQuestions || slot.tab >= slot.questions.length) return false
    const question = slot.questions[slot.tab] as TuiQuestion
    return question.masked !== true && (question.options?.length ?? 0) > 0
  }

  /**
   * Whether the CURRENT page is a same-style "safe" page (masked or optionless).
   * It is the ONE predicate behind both the presentation choice and the page's
   * initial editing state, so an input can never be painted as unreachable.
   */
  const safeFormPage = (slot: QuestionSlot): boolean => {
    if (slot.tab >= slot.questions.length) return false
    const question = slot.questions[slot.tab] as TuiQuestion
    return question.masked === true || optionless(slot)
  }

  /** Whether the CURRENT page uses the same-style safe form (a non-native pane
   *  keeps the legacy text presentation instead: it has no `button` kind). */
  const usesSafeForm = (slot: QuestionSlot): boolean =>
    options.nativeQuestions && safeFormPage(slot)

  /**
   * The Native `items` projection: one entry per source question, IN SOURCE
   * ORDER, addressed by a stable index token (`q-N` / `o-N`) so a duplicate
   * option label or an odd source id can never collide with another answer.
   * The mapping lives only here — there is no second dictionary — and the
   * projection neither reads nor writes the Host. Labels keep the request's
   * real text (nothing is shortened for a screenshot); `recommended` is a
   * plain, non-misleading note on the real option. `required` is deliberately
   * `false` for every question: this flow allows Skip, so the Native form must
   * not invent a stronger business rule than the source request carries.
   */
  const nativeItems = (slot: QuestionSlot): readonly Question[] => slot.questions.map((question, index) => {
    const choices = (question.options ?? []).map((option, at) => {
      const { label } = parseRecommended(option.label)
      const recommended = isRecommended(question, option)
      const detail = option.description === undefined || option.description === ''
        ? undefined
        : sanitizeDisplayText(option.description)
      return {
        value: `${CHOICE_PREFIX}${at}`,
        label: sanitizedPhysicalLine(label),
        ...(recommended
          ? { detail: detail === undefined ? 'Recommended' : `${detail} · Recommended` }
          : detail === undefined ? {} : { detail }),
      }
    })
    const plain = choices.length === 0 ? {} : { choices }
    return {
      id: `${ITEM_PREFIX}${index}`,
      prompt: sanitizeDisplayText(question.question),
      ...(question.detail === undefined || question.detail === '' ? {} : { description: sanitizeDisplayText(question.detail) }),
      ...plain,
      ...(question.multiSelect === true ? { multi: true } : {}),
      ...(choices.length === 0 || question.masked === true ? {} : { other: { placeholder: 'Type something…' } }),
      required: false,
    }
  })

  /**
   * The Native `answers` projection: a Render Props view of `slot.drafts`, and
   * a SELECTION-ONLY one. A custom answer belongs to the controlled `other`
   * input (two different semantics are never merged into one Native value), a
   * skipped or unanswered question is simply absent, and a masked question is
   * NEVER projected — its plaintext can therefore not reach `answers` at all.
   * This is not a second answer store: every later decision re-derives from the
   * drafts.
   */
  const nativeAnswers = (slot: QuestionSlot): Record<string, string | readonly string[]> => {
    const answers: Record<string, string | readonly string[]> = {}
    for (const [index, question] of slot.questions.entries()) {
      if (question.masked === true) continue
      const draft = slot.drafts[index] as SlotDraft
      const picked: string[] = []
      for (const [at, option] of (question.options ?? []).entries()) {
        if (draft.selected.has(option.label)) picked.push(`${CHOICE_PREFIX}${at}`)
      }
      if (picked.length === 0) continue
      answers[`${ITEM_PREFIX}${index}`] = question.multiSelect === true ? picked : (picked[0] as string)
    }
    return answers
  }

  /** The one-line keyboard cursor of a page the native form cannot highlight. */
  /**
   * The one-line keyboard cursor of the current page: which row the arrows are
   * on, and the key that actually acts on it. The hint is the REAL binding — a
   * multi page toggles with Space and continues with Enter, a single page
   * selects with Enter — so a user who follows it can never be misled.
   */
  const keyboardCursorLine = (slot: QuestionSlot): string => {
    const row = seatRows(slot)[slot.highlight]
    if (row === undefined) return 'Keyboard cursor: none · up/down move'
    const label = sanitizedPhysicalLine(row.label)
    if (row.kind === 'other') return `Keyboard cursor: [${slot.highlight + 1}] ${label} · Enter type`
    const multi = questionAt(slot, slot.tab)?.multiSelect === true
    return `Keyboard cursor: [${slot.highlight + 1}] ${label} · `
      + (multi ? 'space toggle · enter continue' : 'enter select')
  }

  /**
   * The native page's answer field, as the SDK's `<item>.other` child. A masked
   * page sends BULLETS only (one per grapheme, with the caret counted the same
   * way), so the plaintext can never reach the frame; a plain page sends its own
   * text. Either way the value is the CURRENT page's buffer (see
   * `syncQuestionState`), never another page's.
   */
  const nativeOtherField = (slot: QuestionSlot): { text: string; cursor: number; placeholder: string } => {
    const question = questionAt(slot, slot.tab)
    if (question?.masked === true) {
      return {
        text: maskedValue(slot.text),
        cursor: graphemeCountBefore(slot.text, slot.cursor),
        placeholder: 'Type your answer',
      }
    }
    return { text: slot.text, cursor: slot.cursor, placeholder: 'Type something…' }
  }

  /**
   * Whether one option of the CURRENT page is the recommended one.
   *
   * There is exactly ONE rule — the one `seatRows` already applies: an explicit
   * `(recommended)` suffix OR the request's `intent.approve` label. Every
   * projection (native steps, safe form, legacy rows) reads it here, so a
   * projection can never silently redefine what "recommended" means.
   */
  const isRecommended = (question: TuiQuestion, option: { readonly label: string }): boolean => {
    const { recommended } = parseRecommended(option.label)
    return recommended || (question.intent?.approve !== undefined && option.label === question.intent.approve)
  }

  /** The native choice/steps page of the current question. */
  const nativeStepsOverlay = (slot: QuestionSlot): Node => {
    const question = slot.questions[slot.tab] as TuiQuestion
    const total = slot.questions.length
    const body: Node[] = []
    // The controller's status and the question's own heading are REAL facts of
    // this request, so they go on a small first line of the SAME overlay rather
    // than into a field the SDK does not have.
    const statusText = slot.status?.text
    if (statusText !== undefined && statusText !== '') body.push(ui.text({ key: 'status', text: sanitizedPhysicalLine(statusText) }))
    if (question.header !== undefined) body.push(ui.text({ key: 'header', text: sanitizedPhysicalLine(question.header) }))
    body.push(ui.questions({
      key: questionsKey(slot),
      variant: 'steps',
      items: nativeItems(slot),
      step: slot.tab,
      answers: nativeAnswers(slot),
      submit: 'Review answers',
    }, ui.input({ key: otherKey(slot), ...nativeOtherField(slot) })))
    if (slot.keyboardCursorShown) body.push(ui.text({ key: 'keyboard-cursor', text: keyboardCursorLine(slot) }))
    return ui.overlay({ key: overlayKey(), modal: true, head: `Question ${slot.tab + 1}/${total}`, anchor: 'center', size: 'lg' }, ...body)
  }

  /**
   * The optionless / masked page: the same overlay style, but a real controlled
   * input and REAL buttons — never a text line that pretends to be one. A
   * masked value is projected as bullets ONLY (the input's own `secret` affordance
   * would hand the plaintext to the client, so the seat keeps computing bullets).
   */
  const safeFormOverlay = (slot: QuestionSlot): Node => {
    const question = slot.questions[slot.tab] as TuiQuestion
    const total = slot.questions.length
    const masked = question.masked === true
    const rowKey = formRowKey(slot)
    const body: Node[] = []
    const statusText = slot.status?.text
    if (statusText !== undefined && statusText !== '') body.push(ui.text({ key: 'status', text: sanitizedPhysicalLine(statusText) }))
    if (question.header !== undefined) body.push(ui.text({ key: 'header', text: sanitizedPhysicalLine(question.header) }))
    body.push(ui.text({ key: 'question', wrap: 'word', text: sanitizeDisplayText(question.question) }))
    if (question.detail !== undefined) body.push(ui.text({ key: 'detail', wrap: 'word', text: sanitizeDisplayText(question.detail) }))
    // `masked` does not mean "no choices": a request may carry BOTH options and
    // a secret free-text answer (the PiTui flow supports it). Those choices are
    // painted here as REAL buttons, because a choice the user cannot see but can
    // still hit with a key is not a choice. The selection still lands in the same
    // `slot.drafts` through the same `applySelection` entry as every other path.
    const seat = seatRows(slot)
    const options = question.options ?? []
    if (options.length > 0) {
      body.push(ui.col({ key: formChoicesKey(slot), gap: 'xs' },
        ...options.map((option, index) => ui.col({ key: `${CHOICE_PREFIX}${index}`, gap: 'none' },
          ui.button({
            key: 'pick',
            // The suffix is stripped for the label, so the mark is put back as
            // its own non-misleading note — the answer value stays the raw label.
            text: sanitizedPhysicalLine(parseRecommended(option.label).label
              + (isRecommended(question, option) ? ' (recommended)' : '')),
            // A digit only reaches 1–9 (see `digitOf`); a 10th option must not
            // advertise a keycap that cannot act.
            keys: index < 9 ? [String(index + 1)] : undefined,
            on: draftAt(slot, slot.tab)?.selected.has(option.label) === true,
            actions: { click: FORM_CHOICE_ACTION },
          }),
          ...(option.description === undefined || option.description === ''
            ? []
            : [ui.text({ key: 'detail', wrap: 'word', text: sanitizeDisplayText(option.description) })]),
        )),
      ))
    }
    body.push(ui.input({
      key: ANSWER_KEY,
      text: masked ? maskedValue(slot.text) : slot.text,
      cursor: masked ? graphemeCountBefore(slot.text, slot.cursor) : slot.cursor,
      prompt: '> ',
      placeholder: 'Type your answer',
    }))
    // The SAME cursor line the native steps page paints: a page whose choices
    // are keyboard-operable must show which one the keys will hit, and here too
    // a pointer pick hides it.
    if (options.length > 0 && slot.keyboardCursorShown) {
      body.push(ui.text({ key: 'keyboard-cursor', text: keyboardCursorLine(slot) }))
    }
    body.push(ui.row({ key: rowKey, gap: 'md', justify: 'between' },
      ui.button({ key: 'back', text: 'Back', actions: { click: FORM_BACK_ACTION } }),
      ui.button({ key: 'next', text: 'Next', variant: 'primary', keys: ['⏎'], actions: { click: FORM_NEXT_ACTION } }),
      ui.button({ key: 'cancel', text: 'Cancel', actions: { click: FORM_CANCEL_ACTION } }),
    ))
    return ui.overlay({ key: overlayKey(), modal: true, head: `Question ${slot.tab + 1}/${total}`, anchor: 'center', size: 'lg' }, ...body)
  }

  /**
   * The Review page (the ONE `tab === questions.length` state): the real
   * question text with its real answer in source order, so the confirmation is
   * readable rather than indexed. Its three buttons are the only pointer path to
   * the original `submitBatch` / back / `cancelQuestion`.
   */
  const reviewOverlay = (slot: QuestionSlot): Node => {
    const rowKey = reviewRowKey(slot)
    // Three mutually exclusive buckets, so the summary line never leaves a
    // question unaccounted for (an unanswered page is neither answered nor skipped).
    const answered = slot.drafts.filter(draft => !draft.skipped && (draft.selected.size > 0 || draft.custom.trim() !== '')).length
    const skipped = slot.drafts.filter(draft => draft.skipped).length
    const unanswered = slot.drafts.length - answered - skipped
    const body: Node[] = [
      ui.text({
        key: 'summary',
        text: sanitizedPhysicalLine(`${slot.questions.length} question${slot.questions.length === 1 ? '' : 's'} · ${answered} answered · ${skipped} skipped`
          + (unanswered === 0 ? '' : ` · ${unanswered} not answered`)),
      }),
    ]
    for (const [index, question] of slot.questions.entries()) {
      const draft = slot.drafts[index] as SlotDraft
      body.push(ui.col({ key: `entry-${index}`, gap: 'none' },
        ui.text({ key: 'prompt', wrap: 'word', text: sanitizeDisplayText(question.question) }),
        ui.text({ key: 'answer', wrap: 'word', text: sanitizeDisplayText(answerSummary(question, draft)) }),
      ))
    }
    body.push(ui.row({ key: rowKey, gap: 'md', justify: 'between' },
      ui.button({ key: 'back', text: 'Back', actions: { click: REVIEW_BACK_ACTION } }),
      ui.button({ key: 'submit', text: 'Submit answers', variant: 'primary', keys: ['⏎'], actions: { click: REVIEW_SUBMIT_ACTION } }),
      ui.button({ key: 'cancel', text: 'Cancel', actions: { click: REVIEW_CANCEL_ACTION } }),
    ))
    return ui.overlay({ key: overlayKey(), modal: true, head: 'Review answers', anchor: 'center', size: 'lg' }, ...body)
  }

  /** The legacy text form, kept for a pane without the native interaction kinds. */
  const legacyQuestionOverlay = (slot: QuestionSlot): Node => {
    const total = slot.questions.length
    const body: Node[] = []
    if (slot.tab >= total) {
      body.push(ui.text({ key: 'review', text: 'Review your answers' }))
      for (const [index, question] of slot.questions.entries()) {
        const draft = slot.drafts[index] as SlotDraft
        body.push(ui.text({ key: `answer-${index}`, text: sanitizeDisplayText(`${index + 1}. ${answerSummary(question, draft)}`) }))
      }
      body.push(ui.text({ key: 'hint', text: 'enter submit · left back · esc cancel' }))
      return ui.overlay({ key: overlayKey(), modal: true, head: 'Review', anchor: 'center', size: 'md' }, ...body)
    }
    const question = slot.questions[slot.tab] as TuiQuestion
    const draft = slot.drafts[slot.tab] as SlotDraft
    body.push(ui.text({ key: 'progress', text: `question ${slot.tab + 1}/${total}` }))
    const statusText = slot.status?.text
    if (statusText !== undefined && statusText !== '') body.push(ui.text({ key: 'status', text: sanitizedPhysicalLine(statusText) }))
    if (question.header !== undefined) body.push(ui.text({ key: 'header', text: sanitizedPhysicalLine(question.header) }))
    body.push(ui.text({ key: 'question', text: sanitizeDisplayText(question.question) }))
    if (question.detail !== undefined) body.push(ui.text({ key: 'detail', text: sanitizeDisplayText(question.detail) }))
    const seat = seatRows(slot)
    if (slot.editing === slot.tab) {
      for (const [index, row] of seat.entries()) {
        body.push(ui.text({ key: `row-${index}`, text: `${index === slot.highlight ? '❯' : ' '} ${sanitizedPhysicalLine(row.label)}` }))
      }
      const masked = question.masked === true
      body.push(ui.input({
        key: ANSWER_KEY,
        text: masked ? maskedValue(slot.text) : slot.text,
        cursor: masked ? graphemeCountBefore(slot.text, slot.cursor) : slot.cursor,
        prompt: '> ',
        placeholder: 'Type your answer',
      }))
      body.push(ui.text({ key: 'hint', text: 'enter confirm · esc back' }))
      return ui.overlay({ key: overlayKey(), modal: true, head: `Question ${slot.tab + 1}/${total}`, anchor: 'center', size: 'md' }, ...body)
    }
    if (seat.length === 0) {
      // The navigation state of an optionless question (Esc left the edit).
      const masked = question.masked === true
      const shown = masked ? maskedValue(draft.custom) : draft.custom
      body.push(ui.text({ key: 'free', text: sanitizeDisplayText(shown === '' ? '(type an answer)' : shown) }))
      body.push(ui.text({ key: 'hint', text: 'enter edit · left/right page · esc cancel' }))
      return ui.overlay({ key: overlayKey(), modal: true, head: `Question ${slot.tab + 1}/${total}`, anchor: 'center', size: 'md' }, ...body)
    }
    for (const [index, row] of seat.entries()) {
      const pointer = index === slot.highlight ? '❯' : ' '
      const marker = row.kind === 'other'
        ? '  '
        : question.multiSelect === true
          ? draft.selected.has(row.value ?? '') ? '[x] ' : '[ ] '
          : draft.selected.has(row.value ?? '') ? '(•) ' : '( ) '
      const description = row.description === undefined ? '' : ` — ${row.description}`
      const recommended = row.recommended ? ' [recommended]' : ''
      // The label is ONE line; the optional description keeps its prose policy
      // (a legitimate multi-line description stays multi-line).
      body.push(ui.text({ key: `row-${index}`, text: `${pointer} ${marker}${sanitizedPhysicalLine(row.label)}${sanitizeDisplayText(`${recommended}${description}`)}` }))
    }
    const custom = draft.custom
    if (hasCustomAnswer(draft) || draft.skipped) {
      const shown = custom.trim() === '' ? '(skipped)' : question.masked === true ? maskedValue(custom) : custom
      body.push(ui.text({ key: 'other-value', text: sanitizeDisplayText(`other: ${shown}`) }))
    }
    body.push(ui.text({
      key: 'hint',
      text: question.multiSelect === true ? 'space toggle · enter continue · left/right page · esc cancel' : 'enter select · up/down move · left/right page · esc cancel',
    }))
    return ui.overlay({ key: overlayKey(), modal: true, head: `Question ${slot.tab + 1}/${total}`, anchor: 'center', size: 'md' }, ...body)
  }

  /**
   * The presentation this pane negotiated: Review, then the safe form for a
   * masked/optionless page, then the native steps form — all as ordinary
   * children of the ONE modal overlay, and all reading the same Slot. A pane
   * without the native kinds keeps the legacy text form (a smaller fallback,
   * not a second flow).
   */
  const questionOverlay = (slot: QuestionSlot): Node => {
    if (!options.nativeQuestions) return legacyQuestionOverlay(slot)
    if (slot.tab >= slot.questions.length) return reviewOverlay(slot)
    if (usesNativeSteps(slot)) return nativeStepsOverlay(slot)
    return safeFormOverlay(slot)
  }

  /** The native approval: the full tool facts FIRST, then the native control. */
  const nativeApprovalOverlay = (slot: ApprovalSlot): Node => {
    const request = slot.request
    // The tool identity is a ONE-line label: fold it so an embedded LF can never
    // forge an extra approval row. The reason/args prose stays multi-line.
    const body: Node[] = [
      ui.text({ key: 'tool-name', wrap: 'word', text: sanitizedPhysicalLine(`Tool: ${request.toolName}`) }),
    ]
    if (request.reason !== undefined && request.reason !== '') {
      body.push(ui.text({ key: 'reason', wrap: 'word', text: sanitizeDisplayText(request.reason) }))
    }
    if (request.danger === true) {
      // The danger decision already happened upstream; the seat only presents it
      // (never re-runs `dangerCommand`).
      body.push(ui.badge({ key: 'danger', tone: 'error', text: 'Dangerous command' }))
    }
    if (request.arguments !== undefined) {
      // The full argument body stays COMPLETE and readable, but it is bounded to
      // a fraction of the overlay's own body: a measured client run showed an
      // unbounded code block pushes the native decision buttons below the
      // visible card on a 400px-wide or short pane. A fraction is a relation to
      // the real container, not a pixel or line budget.
      body.push(ui.scroll({ key: 'args', variant: 'bar', max: APPROVAL_ARGS_BOUNDS },
        ui.code({ key: 'body', wrap: true, text: sanitizeDisplayText(request.arguments) })))
    }
    // The native approval control comes LAST and carries NO body children: a
    // client draws its buttons between the head and the body, so putting the
    // arguments inside the tool would offer the decision before the evidence.
    // `always:false` removes the long-lived grant this product cannot honour,
    // and the Tool has NO SDK handler: its events fall through to the Session
    // iterator, which is the one admission point.
    body.push(ui.tool({
      key: APPROVAL_TOOL_KEY,
      role: NATIVE_APPROVAL_ROLE,
      name: sanitizedPhysicalLine(request.toolName),
      title: 'Approve tool call',
      status: 'ask',
      confirm: 'card',
      frame: 'inline',
      ask: { text: 'Allow this tool call?', allow: 'Allow once', deny: 'Reject', always: false },
    }))
    body.push(ui.text({ key: 'hint', text: 'Y allow once · N reject · Esc cancel' }))
    return ui.overlay({ key: overlayKey(), modal: true, head: 'Approval required', anchor: 'center', size: 'lg' }, ...body)
  }

  /** The legacy text approval (a pane without the native approval capability). */
  const legacyApprovalOverlay = (slot: ApprovalSlot): Node => {
    // The tool identity is a ONE-line label: fold it so an embedded LF can never
    // forge an extra approval row. The reason/args prose below stays multi-line.
    const body: Node[] = [ui.text({ key: 'tool', text: sanitizedPhysicalLine(`tool: ${slot.request.toolName}`) })]
    if (slot.request.reason !== undefined && slot.request.reason !== '') {
      body.push(ui.text({ key: 'reason', text: sanitizeDisplayText(slot.request.reason) }))
    }
    if (slot.request.arguments !== undefined) {
      body.push(ui.code({ key: 'args', text: sanitizeDisplayText(slot.request.arguments) }))
    }
    if (slot.request.danger === true) {
      body.push(ui.text({ key: 'danger', text: 'Dangerous command', tone: 'error' }))
    }
    body.push(ui.text({ key: 'hint', text: 'y allow once · n reject · esc cancel' }))
    return ui.overlay({ key: overlayKey(), modal: true, head: 'Approval required', anchor: 'center', size: 'md' }, ...body)
  }

  const approvalOverlay = (slot: ApprovalSlot): Node =>
    options.nativeApproval ? nativeApprovalOverlay(slot) : legacyApprovalOverlay(slot)

  const listOverlay = (callbacks: TspInteractionCallbacks): Node => {
    const { rows, index } = listState(callbacks)
    const body: Node[] = rows.map((row, position) =>
      ui.text({ key: `continued-${position}`, text: sanitizeDisplayText(`${position === index ? '❯' : ' '} ${row.sessionId} · ${row.callId}`) }))
    body.push(ui.text({ key: 'hint', text: 'enter open · esc close' }))
    return ui.overlay({ key: overlayKey(), modal: true, head: 'Continued questions', anchor: 'center', size: 'md' }, ...body)
  }

  /**
   * The Review page's three real buttons. The event must address the EXACT
   * button node id of the CURRENT review visit — not a substring, not the
   * overlay — so a button of an earlier visit can never submit again.
   */
  const reviewActionEvent = (slot: QuestionSlot, event: ActionEvent): boolean => {
    if (event.id === rowButtonId(reviewRowKey(slot), 'submit') && event.act === REVIEW_SUBMIT_ACTION) {
      submitBatch(slot)
      return true
    }
    if (event.id === rowButtonId(reviewRowKey(slot), 'back') && event.act === REVIEW_BACK_ACTION) {
      moveBack(slot)
      options.render()
      return true
    }
    if (event.id === rowButtonId(reviewRowKey(slot), 'cancel') && event.act === REVIEW_CANCEL_ACTION) {
      cancelQuestion(slot)
      return true
    }
    return false
  }

  /** The safe form's buttons AND its own option list: same exact-id rule. */
  const formActionEvent = (slot: QuestionSlot, event: ActionEvent): boolean => {
    if (event.act === FORM_CHOICE_ACTION) {
      const question = questionAt(slot, slot.tab)
      const offered = question?.options ?? []
      for (const [index, option] of offered.entries()) {
        if (event.id !== formChoiceId(slot, index)) continue
        // A pointer pick hides the keyboard cursor whether or not the answer
        // changed: the cursor line exists only while the keyboard is in use.
        slot.keyboardCursorShown = false
        // ONE selection entry, and the question's OWN selection rule with it:
        // a multi page toggles (a second pick adds, a repeat removes), a single
        // page replaces. `applySelection` still fires the controller hook only
        // on a real semantic change.
        applySelection(slot, [option.label], question?.multiSelect === true)
        options.render()
        return true
      }
      return false
    }
    if (event.id === rowButtonId(formRowKey(slot), 'next') && event.act === FORM_NEXT_ACTION) {
      // A click on Next is exactly the keyboard commit for this page.
      commitText(slot)
      options.render()
      return true
    }
    if (event.id === rowButtonId(formRowKey(slot), 'back') && event.act === FORM_BACK_ACTION) {
      moveBack(slot)
      options.render()
      return true
    }
    if (event.id === rowButtonId(formRowKey(slot), 'cancel') && event.act === FORM_CANCEL_ACTION) {
      cancelQuestion(slot)
      return true
    }
    return false
  }

  /**
   * A native choice `change`: admitted only for the CURRENT visit's form node,
   * only for the CURRENT page's item token, and only with a value made of
   * `o-N` tokens this question really offers. The client's JSON is treated as a
   * claim to verify, never as authority: an out-of-range or malformed token is
   * dropped instead of inventing an answer.
   */
  const nativeChoiceEvent = (slot: QuestionSlot, event: ChangeEvent): boolean => {
    if (event.id !== questionsId(slot)) return false
    if (event.item !== `${ITEM_PREFIX}${slot.tab}`) return false
    const question = questionAt(slot, slot.tab)
    if (question === undefined || question.masked === true) return false
    const raw = event.value
    const tokens = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : undefined
    if (tokens === undefined) return false
    if (question.multiSelect !== true && tokens.length !== 1) return false
    const offered = question.options ?? []
    const labels: string[] = []
    for (const token of tokens) {
      if (typeof token !== 'string' || !token.startsWith(CHOICE_PREFIX)) return false
      const index = Number.parseInt(token.slice(CHOICE_PREFIX.length), 10)
      const option = offered[index]
      // The token must be BOTH in range and canonically spelled, so a payload
      // like `o-01` or `o-` is a refusal, not a coerced answer.
      if (option === undefined || `${CHOICE_PREFIX}${index}` !== token) return false
      labels.push(option.label)
    }
    // A pointer pick always answers the keyboard cursor line (the plan's rule),
    // independently of whether the answer itself changed — `applySelection`
    // still fires the controller hook only on a real semantic change.
    slot.keyboardCursorShown = false
    applySelection(slot, labels)
    options.render()
    return true
  }

  /**
   * A native page action (`next` / `skip` / `back` / `submit`). The node id
   * already pins the request AND the page visit; an `item` that names a
   * different page is refused, and `submit` is honoured only on the last
   * question — where it opens the Review page and NEVER settles.
   */
  const nativePageEvent = (slot: QuestionSlot, event: ActionEvent): boolean => {
    if (event.id !== questionsId(slot)) return false
    // The client emits `item` as the CURRENT question on every page action and
    // NO item on the final submit (measured on the pinned client). The admission
    // follows that shape exactly: a page action without its exact `q-N` is
    // malformed and dropped, not applied to whichever page happens to be current.
    if (event.act === PAGE_SUBMIT) {
      if (event.item !== undefined) return false
      if (slot.tab !== slot.questions.length - 1) return false
      goReview(slot)
      options.render()
      return true
    }
    if (event.item !== `${ITEM_PREFIX}${slot.tab}`) return false
    if (event.act === PAGE_NEXT) {
      moveForward(slot)
      options.render()
      return true
    }
    if (event.act === PAGE_SKIP) {
      skipCurrent(slot)
      options.render()
      return true
    }
    if (event.act === PAGE_BACK) {
      moveBack(slot)
      options.render()
      return true
    }
    return false
  }

  /**
   * A native Tool approval. ONLY the current approval Tool node's own
   * `allow`/`deny` with NO scope value is a decision: `always`, a
   * `session`/`always` value, another node's action, a settled slot, an aborted
   * lifetime or a replaced request all fall through as nothing. The decision
   * then runs the ORIGINAL settlement, exactly like the `y`/`n` keys.
   */
  const approvalEvent = (slot: ApprovalSlot, event: ActionEvent | ChangeEvent): boolean => {
    if (event.ev !== 'action') return false
    if (event.id !== overlayId(APPROVAL_TOOL_KEY)) return false
    if (event.value !== undefined) return false
    if (slot.signal?.aborted === true) return false
    if (event.act === TOOL_ALLOW) {
      settle(slot, () => slot.resolve('allowed-once'))
      return true
    }
    if (event.act === TOOL_DENY) {
      settle(slot, () => slot.resolve('rejected'))
      return true
    }
    return false
  }

  /**
   * Gate one pointer/native event of the active modal.
   *
   * `true` means the CALLER must re-assert the seat's own focus — the existing
   * contract for a claim addressed at the (masked) composer underneath. A
   * native action the seat applied already committed its own frame through
   * `options.render()` (which applies focus), so it answers `false`; anything
   * that is not an exact hit on the current form answers `false` too and is
   * still swallowed by the modal-first branch, because a form that owns the
   * keyboard owns the pane.
   */
  const handleEvent = (event: TspInteractionEvent): boolean => {
    if (active === undefined && !listOpen) return false
    const slot = active
    // `sf` is absent on the events that address no surface at all (theme,
    // motion); an event without this surface's id is foreign to the seat.
    if (slot !== undefined && slot.settled !== true && slot.signal?.aborted !== true
      && 'sf' in event && event.sf === options.surfaceId) {
      if (slot.kind === 'approval') {
        if ((event.ev === 'action' || event.ev === 'change') && approvalEvent(slot, event)) return false
      } else if (slot.tab >= slot.questions.length) {
        if (event.ev === 'action' && reviewActionEvent(slot, event)) return false
      } else if (usesNativeSteps(slot)) {
        if (event.ev === 'change') {
          if (nativeChoiceEvent(slot, event)) return false
          // A refused change (another item, a foreign payload) leaves the client
          // showing a pick the seat does not hold. Re-commit the seat's own
          // projection so the painted form and the authority cannot diverge.
          options.render()
          return false
        }
        if (event.ev === 'action' && nativePageEvent(slot, event)) return false
        // A click that claims THIS page's own answer field is the pointer path
        // into the same editor the keyboard opens; the SDK never becomes a
        // second input owner (a keystroke still arrives as a key).
        if (event.ev === 'focus' && event.id === otherId(slot)) {
          enterEdit(slot)
          options.render()
          return true
        }
      } else if (usesSafeForm(slot)) {
        if (event.ev === 'action' && formActionEvent(slot, event)) return false
        if (event.ev === 'focus' && event.id === overlayId(ANSWER_KEY)) {
          enterEdit(slot)
          options.render()
          return true
        }
      }
    }
    // The SDK has no modal input-capture concept: an event addressed at the
    // underlying composer (a terminal focus claim, or a native edit/undo/send
    // that B2 never advertised) must not take the seat, so the seat's own caret
    // is re-asserted. Every other unmatched event is still swallowed by the
    // modal-first branch and reaches no Model/Preset/Work/Visual business path.
    return event.ev === 'focus' || event.ev === 'edit' || event.ev === 'undo' || event.ev === 'send'
  }

  const renderEmptyLayer = (): Node => ui.col({ key: LAYER_KEY })

  const renderLayer = (): Node => {
    if (active !== undefined) {
      return ui.col({ key: LAYER_KEY }, active.kind === 'approval' ? approvalOverlay(active) : questionOverlay(active))
    }
    const callbacks = listCallbacks
    if (listOpen && callbacks !== undefined) return ui.col({ key: LAYER_KEY }, listOverlay(callbacks))
    return renderEmptyLayer()
  }

  const desiredFocusId = (): string | null => {
    const slot = active
    if (slot === undefined || slot.kind !== 'question') return null
    if (slot.editing !== slot.tab || slot.tab >= slot.questions.length) return null
    // Both branches are the ids the tree THIS render actually built: the native
    // page's answer field is a child of the native form, the safe/legacy page's
    // is a direct child of the overlay. Never a guessed path.
    return usesNativeSteps(slot) ? otherId(slot) : overlayId(ANSWER_KEY)
  }

  // ── The renderer-facing presenter ──

  const presenter: SurfaceInteractionPresenter = {
    showApprovalPrompt(request) {
      if (disposed || request.signal?.aborted === true) {
        // An already-gone request settles `cancelled` synchronously — the
        // approved outcome is NEVER an implicit allow.
        return Promise.resolve<ApprovalOutcome>('cancelled')
      }
      if (typeof request.toolName !== 'string' || request.toolName === '') {
        // The real external boundary refused it: the refusal is visible and the
        // outcome stays fail-closed. The presenter contract (the PiTui dialog's
        // vocabulary) has no `unavailable`, so the official CANCEL rule is the
        // available fail-closed outcome — never an allow.
        options.notify('cannot answer this request in the TSP renderer', 'error')
        return Promise.resolve<ApprovalOutcome>('cancelled')
      }
      return new Promise<ApprovalOutcome>(resolve => {
        const slot: ApprovalSlot = {
          kind: 'approval',
          request,
          signal: request.signal,
          resolve,
          detach: undefined,
          settled: false,
        }
        watchAbort(slot, () => { settle(slot, () => resolve('cancelled')) })
        if (withheld(slot)) return
        enqueue(slot)
        presentActive(slot)
      })
    },
    askQuestions(questions, signal, status) {
      if (questions.length === 0) {
        // The original contract: an empty ask succeeds immediately with no form.
        return Promise.resolve<TuiQuestionAnswer[]>([])
      }
      if (signal?.aborted === true) return Promise.reject(cancellationError('question flow aborted'))
      if (disposed) return Promise.reject(cancellationError('question flow cancelled'))
      const refusal = unrepresentable(questions)
      if (refusal !== undefined) {
        // A payload this renderer cannot represent is refused with a notice and
        // the flow's cancellation error — NEVER a simulated successful answer.
        options.notify('cannot answer this request in the TSP renderer', 'error')
        return Promise.reject(cancellationError('question flow cancelled'))
      }
      return new Promise<TuiQuestionAnswer[]>((resolve, reject) => {
        const initial = status?.initialDraft
        const slot: QuestionSlot = {
          kind: 'question',
          questions,
          status,
          signal,
          resolve,
          reject,
          drafts: questions.map((_question, index) => {
            const seed = initial?.answers[index]
            return {
              selected: new Set(seed?.selected ?? []),
              custom: seed?.custom ?? '',
              skipped: seed?.skipped ?? false,
            }
          }),
          detach: undefined,
          settled: false,
          tab: initial === undefined ? 0 : Math.min(Math.max(0, initial.tab), questions.length),
          visitEpoch: 0,
          keyboardCursorShown: false,
          highlight: 0,
          editing: undefined,
          textOwner: -1,
          text: '',
          cursor: 0,
        }
        syncQuestionState(slot)
        watchAbort(slot, () => {
          settleQuestion(slot, () => reject(cancellationError('question flow aborted')))
        })
        if (withheld(slot)) return
        enqueue(slot)
        presentActive(slot)
      })
    },
    setSettledQuestionAnswersLookup(lookup) {
      // After retirement a stale lookup is never re-installed (the interaction
      // owner clears it at teardown).
      options.setSettledQuestionAnswersLookup(disposed ? undefined : lookup)
    },
    notify(text, kind) {
      options.notify(text, kind)
    },
    presentedModalKind() {
      // PR-B F4: the seat's ACTIVE slot is the presented truth (a queued
      // request never claims the waiting phase).
      return active?.kind
    },
    setQuestionAttention(parkedCount) {
      if (disposed || parkedCount === attention) return
      attention = parkedCount
      try {
        options.render()
      } catch (error) {
        // The park-count projection rides the same frame path as every other
        // presentation: a broken terminal reaches the renderer's fatal sink
        // instead of throwing into whoever asked for the repaint.
        options.onFatal(error)
      }
    },
    withdrawPending() {
      retireAll()
    },
    withdrawPresentations(lifetimes) {
      withdrawPresentations(lifetimes)
    },
    closeTransientList() {
      closeTransientList()
    },
  }

  return {
    presenter,
    hasModalSeat: () => active !== undefined || listOpen,
    handleKey(key, callbacks) {
      if (disposed) return false
      const slot = active
      if (slot !== undefined) {
        return slot.kind === 'approval' ? handleApprovalKey(slot, key) : handleQuestionKey(slot, key)
      }
      if (!listOpen) return false
      listCallbacks = callbacks
      return handleListKey(key, callbacks)
    },
    openContinuedList,
    handleEvent,
    renderLayer,
    renderEmptyLayer,
    desiredFocusId,
    attentionCount: () => attention,
    closeTransientList,
    withdrawPresentations,
    withdrawPresentation,
    dispose: retireAll,
  }
}
