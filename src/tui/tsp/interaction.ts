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
import type { Key, Node } from '@stencil-hq/tern'
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
 * The event projection the seat gates: only the discriminant is read. The SDK
 * yields the full `TspEvent` union; a narrow structural read keeps the seat
 * free of transport DTOs.
 */
export interface TspInteractionEvent {
  readonly ev: string
}

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
  const withdrawPresentation = (lifetime: AbortSignal): void => {
    if (disposed) return
    const slot = (active !== undefined && active.signal === lifetime ? active : undefined)
      ?? fifo.find(candidate => candidate.signal === lifetime)
      ?? withdrawn.find(candidate => candidate.signal === lifetime)
    if (slot === undefined) {
      retiredLifetimes.add(lifetime)
      return
    }
    if (slot.settled) return
    if (active === slot) active = undefined
    const index = fifo.indexOf(slot)
    if (index >= 0) fifo.splice(index, 1)
    withdrawn.push(slot)
    promote()
    try {
      options.render()
    } catch (error) {
      // The renderer's OWN frame/focus commit failed while withdrawing a
      // replaced presentation: the terminal is broken, so this is the SAME
      // fatal path as a failing presentation or settlement (the slot already
      // left the seat and its promise is deliberately NOT settled here — the
      // fatal lifecycle and the surface release owner own the rest). The
      // original error reaches the sink unchanged.
      options.onFatal(error)
    }
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
    if (optionless(slot)) {
      slot.editing = slot.tab
      seedText(slot)
      return
    }
    slot.editing = undefined
    seedHighlight(slot)
  }

  const advance = (slot: QuestionSlot): void => {
    slot.tab += 1
    syncQuestionState(slot)
  }

  const moveBack = (slot: QuestionSlot): void => {
    slot.tab = Math.max(0, slot.tab - 1)
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
      }
    }
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
    const draft = draftAt(slot, slot.tab)
    const question = questionAt(slot, slot.tab)
    if (draft === undefined || question === undefined || row.value === undefined) return
    if (question.multiSelect === true) {
      // Enter on a multi-select list is the continue/skip authority, never a
      // toggle (Space is the toggle).
      if (!draftAnswered(draft)) {
        const before = answerKey(draft)
        draft.selected.clear()
        draft.custom = ''
        draft.skipped = true
        if (answerKey(draft) !== before) notifyMutation(slot)
      }
      advance(slot)
      return
    }
    const before = answerKey(draft)
    draft.selected.clear()
    draft.selected.add(row.value)
    // An ordinary single-select choice REPLACES a custom answer (submit prefers
    // a nonblank custom for single-select, so keeping it would submit the OLD
    // text instead of the option the user just chose) — and the LIVE editor
    // buffer goes with it, or the replaced text would resurrect the moment this
    // question's Other row is opened again.
    draft.custom = ''
    draft.skipped = false
    if (slot.textOwner === slot.tab) {
      slot.text = ''
      slot.cursor = 0
    }
    if (answerKey(draft) !== before) notifyMutation(slot)
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
    const before = answerKey(draft)
    if (draft.selected.has(row.value)) draft.selected.delete(row.value)
    else draft.selected.add(row.value)
    draft.skipped = false
    if (answerKey(draft) !== before) notifyMutation(slot)
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
    options.render()
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
      options.render()
      return true
    }
    if (key.name === 'down') {
      slot.highlight = Math.min(seat.length - 1, slot.highlight + 1)
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
    // Tab, Shift+Tab, digits and every other control key are consumed with no
    // second shortcut vocabulary.
    return true
  }

  // ── The layer projection ──

  const overlayKey = (): string => `modal-${modalEpoch}`

  const approvalOverlay = (slot: ApprovalSlot): Node => {
    const body: Node[] = [ui.text({ key: 'tool', text: `tool: ${slot.request.toolName}` })]
    if (slot.request.reason !== undefined && slot.request.reason !== '') {
      body.push(ui.text({ key: 'reason', text: slot.request.reason }))
    }
    if (slot.request.arguments !== undefined) {
      body.push(ui.code({ key: 'args', text: slot.request.arguments }))
    }
    if (slot.request.danger === true) {
      // The danger decision already happened upstream; the seat only presents it
      // (never re-runs `dangerCommand`).
      body.push(ui.text({ key: 'danger', text: 'Dangerous command', tone: 'error' }))
    }
    body.push(ui.text({ key: 'hint', text: 'y allow once · n reject · esc cancel' }))
    return ui.overlay({ key: overlayKey(), modal: true, head: 'Approval required', anchor: 'center', size: 'md' }, ...body)
  }

  const questionOverlay = (slot: QuestionSlot): Node => {
    const total = slot.questions.length
    const body: Node[] = []
    if (slot.tab >= total) {
      body.push(ui.text({ key: 'review', text: 'Review your answers' }))
      for (const [index, question] of slot.questions.entries()) {
        const draft = slot.drafts[index] as SlotDraft
        body.push(ui.text({ key: `answer-${index}`, text: `${index + 1}. ${answerSummary(question, draft)}` }))
      }
      body.push(ui.text({ key: 'hint', text: 'enter submit · left back · esc cancel' }))
      return ui.overlay({ key: overlayKey(), modal: true, head: 'Review', anchor: 'center', size: 'md' }, ...body)
    }
    const question = slot.questions[slot.tab] as TuiQuestion
    const draft = slot.drafts[slot.tab] as SlotDraft
    body.push(ui.text({ key: 'progress', text: `question ${slot.tab + 1}/${total}` }))
    const statusText = slot.status?.text
    if (statusText !== undefined && statusText !== '') body.push(ui.text({ key: 'status', text: statusText }))
    if (question.header !== undefined) body.push(ui.text({ key: 'header', text: question.header }))
    body.push(ui.text({ key: 'question', text: question.question }))
    if (question.detail !== undefined) body.push(ui.text({ key: 'detail', text: question.detail }))
    const seat = seatRows(slot)
    if (slot.editing === slot.tab) {
      for (const [index, row] of seat.entries()) {
        body.push(ui.text({ key: `row-${index}`, text: `${index === slot.highlight ? '❯' : ' '} ${row.label}` }))
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
      body.push(ui.text({ key: 'free', text: shown === '' ? '(type an answer)' : shown }))
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
      body.push(ui.text({ key: `row-${index}`, text: `${pointer} ${marker}${row.label}${recommended}${description}` }))
    }
    const custom = draft.custom
    if (hasCustomAnswer(draft) || draft.skipped) {
      const shown = custom.trim() === '' ? '(skipped)' : question.masked === true ? maskedValue(custom) : custom
      body.push(ui.text({ key: 'other-value', text: `other: ${shown}` }))
    }
    body.push(ui.text({
      key: 'hint',
      text: question.multiSelect === true ? 'space toggle · enter continue · left/right page · esc cancel' : 'enter select · up/down move · left/right page · esc cancel',
    }))
    return ui.overlay({ key: overlayKey(), modal: true, head: `Question ${slot.tab + 1}/${total}`, anchor: 'center', size: 'md' }, ...body)
  }

  const listOverlay = (callbacks: TspInteractionCallbacks): Node => {
    const { rows, index } = listState(callbacks)
    const body: Node[] = rows.map((row, position) =>
      ui.text({ key: `continued-${position}`, text: `${position === index ? '❯' : ' '} ${row.sessionId} · ${row.callId}` }))
    body.push(ui.text({ key: 'hint', text: 'enter open · esc close' }))
    return ui.overlay({ key: overlayKey(), modal: true, head: 'Continued questions', anchor: 'center', size: 'md' }, ...body)
  }

  const renderLayer = (): Node => {
    if (active !== undefined) {
      return ui.col({ key: LAYER_KEY }, active.kind === 'approval' ? approvalOverlay(active) : questionOverlay(active))
    }
    const callbacks = listCallbacks
    if (listOpen && callbacks !== undefined) return ui.col({ key: LAYER_KEY }, listOverlay(callbacks))
    return ui.col({ key: LAYER_KEY })
  }

  const desiredFocusId = (): string | null => {
    if (active !== undefined && active.kind === 'question' && active.editing === active.tab) {
      // The input is a DIRECT child of the overlay, so the id derives from the
      // two keys the tree was built with (never a guessed path).
      return `${LAYER_ID}.${overlayKey()}.${ANSWER_KEY}`
    }
    return null
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
    setQuestionAttention(parkedCount) {
      if (disposed || parkedCount === attention) return
      attention = parkedCount
      options.render()
    },
    withdrawPending() {
      retireAll()
    },
    withdrawPresentation(lifetime) {
      withdrawPresentation(lifetime)
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
    handleEvent(event) {
      if (active === undefined && !listOpen) return false
      // The SDK has no modal input-capture concept: an event addressed at the
      // underlying composer (a terminal focus claim, or a native edit/undo/send
      // that B2 never advertised) must not take the seat. Anything else keeps
      // its existing handling.
      return event.ev === 'focus' || event.ev === 'edit' || event.ev === 'undo' || event.ev === 'send'
    },
    renderLayer,
    desiredFocusId,
    attentionCount: () => attention,
    closeTransientList,
    withdrawPresentation,
    dispose: retireAll,
  }
}
