/**
 * The ONE Schedule workspace controller (S5-PR4): the transport-neutral state
 * machine behind `/schedule`. It owns the open workspace's read epochs, the
 * filter/search projection, the selected task, the editor draft and the one
 * in-flight mutation; it never renders, never imports a TUI module and never
 * keeps a second Host task store.
 *
 * Currentness rules that every path below obeys:
 *
 * - `catalog`/`view`/`history` results are published only while their own read
 *   epoch is still current, so an earlier selection's late answer can never
 *   repaint a newer one;
 * - an invalidation (`schedule/changed` or a Connection replacement) makes the
 *   in-flight read obsolete and coalesces into ONE newest read;
 * - a mutation is dispatched at most once per draft, and a dispatched mutation
 *   whose outcome is unknown is NEVER replayed — the workspace re-reads the
 *   authoritative catalog instead;
 * - the last successful catalog survives a failed read as `stale` rows, but a
 *   first failure is an explicit `error` with no rows and no behavior.
 *
 * Host writes run through the injected owned-task entry (`runOwned`), so a
 * `/reload-client` cannot run silently between a confirmation and the Host's
 * settlement. The controller never cancels a dispatched write on close: the
 * Host state simply becomes unknown until the next read.
 *
 * @module @xmoon76/dsh-pi-tui/app/schedule/workspace-controller
 */

import type {
  ScheduleCatalogEntry,
  ScheduleConfirm,
  ScheduleEditorRecovery,
  ScheduleEditorDraft,
  ScheduleFilter,
  ScheduleHistoryView,
  ScheduleIntent,
  ScheduleNotice,
  ScheduleSessionChoice,
  ScheduleSessionRosterState,
  ScheduleTargetKind,
  ScheduleWorkspaceSnapshot,
  ScheduleWorkspaceStatus,
} from './presentation.ts'
import { SCHEDULE_COPY } from './presentation.ts'
import type { SchedulePort } from '../../runtime/schedule-port.ts'
import {
  ScheduleOutcomeUnknownError,
  ScheduleUnavailableError,
  type ScheduleDeliveryHistoryResult,
  type ScheduleEditResult,
  type ScheduleViewResult,
} from '../../runtime/schedule-port.ts'
import type { SessionSwitchOutcome } from '../session/runtime.ts'
import type { SessionReader, SessionSummary } from '../../runtime/session-reader-port.ts'
import {
  DEFAULT_TARGET_DRAFT,
  DEFAULT_TIMING_DRAFT,
  ScheduleFormError,
  applyFieldValue,
  draftFromRecord,
  editorFields,
  encodeCreate,
  encodePatch,
  encodeTarget,
  scheduleSessionId,
  selectTimingKind,
  selectTimingQuantityUnit,
  sameTargetDraft,
  sameTimingDraft,
  type ScheduleEditorBaseline,
  type ScheduleQuantityUnit,
  type ScheduleTargetDraft,
  type ScheduleTimingDraft,
  type ScheduleTimingPreset,
} from '../../domain/schedule/form.ts'
import { copyFailureDetails, remoteFailureCode, remoteFailureMessage } from '../../runtime/remote/write-failure.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'

/** The owned-task entry the composition supplies (the app's `runOwned`). */
export type ScheduleOwnedRunner = (label: string, task: () => Promise<void>) => void

/** The controller's construction inputs. */
export interface ScheduleWorkspaceControllerDeps {
  readonly port: SchedulePort
  readonly sessionReader: SessionReader
  /** The app-owned task entry: one visible owner per Host mutation. */
  readonly runOwned: ScheduleOwnedRunner
  /** Captures the current Session scope synchronously before the roster await. */
  readonly captureSessionSwitch: () => (sessionId: string) => Promise<SessionSwitchOutcome>
  /** Closes the current Schedule lease after a proven Session switch. */
  readonly closeWorkspace: () => void
  /** Called when a Host change/invalidation must repaint the screen. */
  readonly onChange?: () => void
}

/** The initial list page size the Host catalog read asks for. */
const LIST_PAGE_SIZE = 500
/** The history page size the plan fixes for the first read. */
const HISTORY_PAGE_SIZE = 20

/** The ONE Schedule workspace state machine. */
export class ScheduleWorkspaceController {
  private readonly port: SchedulePort
  private readonly sessionReader: SessionReader
  private readonly runOwned: ScheduleOwnedRunner
  private readonly captureSessionSwitch: ScheduleWorkspaceControllerDeps['captureSessionSwitch']
  private readonly closeWorkspace: () => void
  private readonly onChange: () => void
  private readonly listeners = new Set<() => void>()

  private disposed = false
  private status: ScheduleWorkspaceStatus = 'loading'
  private statusMessage: string | undefined
  private catalog: readonly ScheduleCatalogEntry[] = []
  private filter: ScheduleFilter = 'all'
  private query = ''
  private selectedId: string | undefined
  private mode: ScheduleWorkspaceSnapshot['mode'] = 'list'
  private detail: ScheduleCatalogEntry | undefined
  private historyView: ScheduleHistoryView | undefined
  private editor: ScheduleEditorDraft | undefined
  /** Monotonic EDITOR INSTANCE identity: two editors of the same task are
   *  different owners, so an old write/reload cannot settle the new one. */
  private editorToken = 0
  /** Whether the pending write was issued from an Editor (create/edit). */
  private busyEditor = false
  /** The newest accepted `reload-latest` request; older answers are discarded. */
  private reloadEpoch = 0
  private editorBaseline: ScheduleEditorBaseline | undefined
  private editorRecovery: ScheduleEditorRecovery | undefined
  private confirm: ScheduleConfirm | undefined
  /** The task a confirmed Discard must open next (a navigation that arrived
   *  while the dirty editor was still open). */
  private pendingDetailId: string | undefined
  /** The page Help was opened FROM; closing Help returns there with the draft
   *  and any history page intact. */
  private helpReturn: ScheduleWorkspaceSnapshot['mode'] | undefined
  private notice: ScheduleNotice | undefined
  private limits: { readonly newSessionIntervalSeconds: number } | undefined
  private sessions: readonly ScheduleSessionChoice[] = []
  private sessionRosterState: ScheduleSessionRosterState = 'checking'
  private availableSessionIds: readonly string[] = []
  private rosterAbort: AbortController | undefined
  private rosterEpoch = 0
  private navigationEpoch = 0
  private navigationPending = false
  private busy = false

  /** Page INSTANCE generation (snapshot `pageEpoch`): the interaction-ownership
   *  generation. Bumped by EVERY accepted user navigation that leaves, re-enters
   *  or retargets a page (openDetail/back/Help/Editor/History entry, selection
   *  move, modal takeover and its settlement). Never bumped by background
   *  re-reads, pure repaints, scrolls or Host facts updates (those stay guarded
   *  by subjectFacts + Host CAS), so a normal repaint never invalidates a
   *  gesture (G0). */
  private pageEpoch = 0

  /** The ONE interaction-ownership transition marker. */
  private bumpPage(): void {
    this.pageEpoch += 1
  }
  private openEpoch = 0
  private readEpoch = 0
  private detailEpoch = 0
  private historyEpoch = 0
  private confirmToken = 0
  private readAbort: AbortController | undefined
  private detailAbort: AbortController | undefined
  private historyAbort: AbortController | undefined
  private chooserAbort: AbortController | undefined
  private editReadAbort: AbortController | undefined
  private queuedRefresh = false
  private idle: Promise<void> | undefined
  private resolveIdle: (() => void) | undefined
  private unsubscribeChanged: (() => void) | undefined

  constructor(deps: ScheduleWorkspaceControllerDeps) {
    this.port = deps.port
    this.sessionReader = deps.sessionReader
    this.runOwned = deps.runOwned
    this.captureSessionSwitch = deps.captureSessionSwitch
    this.closeWorkspace = deps.closeWorkspace
    this.onChange = deps.onChange ?? (() => {})
  }

  /** Begin the ONE open workspace: the first authoritative read starts now. */
  open(): void {
    if (this.disposed) return
    this.openEpoch += 1
    this.unsubscribeChanged = this.port.onChanged(() => this.invalidate())
    this.own('schedule catalog read', () => this.read())
    this.own('schedule Session roster read', async () => { await this.readSessionRoster() })
  }

  /** Drop every subscription and make late async results unpublishable. It
   *  never cancels a Host write that was already dispatched. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.openEpoch += 1
    this.navigationEpoch += 1
    this.rosterAbort?.abort()
    this.rosterAbort = undefined
    this.unsubscribeChanged?.()
    this.unsubscribeChanged = undefined
    this.readAbort?.abort()
    this.detailAbort?.abort()
    this.historyAbort?.abort()
    this.chooserAbort?.abort()
    this.editReadAbort?.abort()
    this.readAbort = undefined
    this.detailAbort = undefined
    this.historyAbort = undefined
    this.chooserAbort = undefined
    this.editReadAbort = undefined
    this.listeners.clear()
  }

  /** Resolves when no Host mutation is in flight (tests and teardown use it). */
  whenIdle(): Promise<void> {
    return this.idle ?? Promise.resolve()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(): ScheduleWorkspaceSnapshot {
    const statusCounts = { active: 0, paused: 0, ended: 0 }
    for (const entry of this.catalog) statusCounts[entry.status] += 1
    return {
      status: this.status,
      ...(this.statusMessage === undefined ? {} : { statusMessage: this.statusMessage }),
      filter: this.filter,
      query: this.query,
      rows: this.projectedRows(),
      total: this.catalog.length,
      statusCounts,
      ...(this.selectedId === undefined ? {} : { selectedId: this.selectedId }),
      mode: this.mode,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.historyView === undefined ? {} : { history: this.historyView }),
      ...(this.editor === undefined ? {} : {
        editor: this.editor,
        editorEpoch: this.editorToken,
        editorDirty: this.editorDirty(),
      }),
      ...(this.editorRecovery === undefined ? {} : { editorRecovery: this.editorRecovery }),
      ...(this.confirm === undefined ? {} : { confirm: this.confirm }),
      ...(this.notice === undefined ? {} : { notice: this.notice }),
      ...(this.limits === undefined ? {} : { limits: this.limits }),
      sessions: this.sessions,
      sessionRosterState: this.sessionRosterState,
      availableSessionIds: this.availableSessionIds,
      navigationPending: this.navigationPending,
      busy: this.busy,
      pageEpoch: this.pageEpoch,
    }
  }

  /** The ONE intent entry: every user action lands here. */
  dispatch(intent: ScheduleIntent): void {
    if (this.disposed) return
    // ONE confirmation owns the surface: a stale row hit from the previous
    // frame can never navigate, write or open an editor behind it.
    if (this.confirm !== undefined && intent.kind !== 'confirm' && intent.kind !== 'cancel' && intent.kind !== 'back') return
    // ONE mode-admission table: an intent that belongs to another page (a stale
    // frame's action, an async navigation, a programmatic call) never executes
    // here. Navigation that LEAVES a dirty editor still goes through the discard
    // question inside `requestDetail`.
    if (!this.admits(intent.kind)) return
    switch (intent.kind) {
      case 'set-filter':
        this.filter = intent.filter
        this.settleSelection()
        this.publish()
        return
      case 'set-query':
        this.query = intent.query
        this.settleSelection()
        this.publish()
        return
      case 'move':
        this.moveSelection(intent.delta)
        return
      case 'open-detail':
        this.requestDetail(intent.id)
        return
      case 'open-history':
        this.pageEpoch += 1
        this.own('schedule history read', () => this.readHistory(undefined))
        return
      case 'history-more':
        this.moreHistory()
        return
      case 'refresh-session-roster':
        this.own('schedule Session roster refresh', async () => { await this.readSessionRoster() })
        return
      case 'open-detail-conversation':
        this.openDetailConversation()
        return
      case 'open-delivery-conversation':
        this.openDeliveryConversation(intent.messageId)
        return
      case 'back':
        this.back()
        return
      case 'refresh':
        this.own('schedule catalog read', () => this.read())
        return
      case 'open-create':
        this.openCreate()
        return
      case 'open-edit':
        this.own('schedule editor open', () => this.openEdit())
        return
      case 'reload-latest':
        // A missing Host task has no revision to reload or recreate from.
        if (this.editorRecovery === 'missing') return
        // Reload is LOSSY: an unsaved draft must be discarded explicitly.
        this.invalidateEditorRead()
        if (this.editorDirty()) {
          this.bumpPage()
          this.confirm = { kind: 'reload', token: ++this.confirmToken }
          this.publish()
          return
        }
        this.own('schedule reload latest', () => this.performReload())
        return
      case 'focus-field': {
        if (this.editor === undefined) return
        const fields = editorFields(this.editor)
        const index = Math.max(0, Math.min(intent.index, fields.length - 1))
        this.editor = { ...this.editor, focused: index }
        this.publish()
        return
      }
      case 'next-field': {
        if (this.editor === undefined) return
        const fields = editorFields(this.editor)
        const next = (this.editor.focused + intent.delta + fields.length) % fields.length
        this.editor = { ...this.editor, focused: next }
        this.publish()
        return
      }
      case 'set-field': {
        if (this.editor === undefined) return
        // A user edit supersedes every reload already in flight: the read must
        // never overwrite content the user typed while waiting.
        this.invalidateEditorRead()
        this.editor = applyFieldValue(this.editor, intent.fieldId, intent.value)
        this.publish()
        return
      }
      case 'select-timing-preset':
        this.selectTimingPreset(intent.preset)
        return
      case 'toggle-weekday':
        this.toggleWeekday(intent.weekday)
        return
      case 'select-target-kind':
        this.selectTarget(intent.target)
        return
      case 'select-target-session':
        this.selectTargetSession(intent.sessionId)
        return
      case 'toggle-advanced':
        if (this.editor === undefined || this.editor.target.kind === 'session') return
        this.invalidateEditorRead()
        this.editor = { ...this.editor, advanced: !this.editor.advanced }
        this.publish()
        return
      case 'save':
        this.save()
        return
      case 'review-with-my-edits':
        this.own('schedule editor review', () => this.performReview())
        return
      case 'toggle-active':
        this.toggleActive()
        return
      case 'ask-run':
        this.askRun()
        return
      case 'ask-delete':
        this.askDelete()
        return
      case 'ask-clear-ended':
        this.askClearEnded()
        return
      case 'confirm':
        this.commitConfirm()
        return
      case 'cancel':
        this.cancelConfirm()
        return
      case 'open-help':
        this.pageEpoch += 1
        // Help is an UNDERLAY: it records the page it was opened from (editor
        // draft, history page, detail) and returns there. It never opens while
        // a confirmation owns the surface.
        if (this.confirm !== undefined) return
        this.helpReturn = this.mode
        this.mode = 'help'
        this.publish()
        return
      case 'close-help':
        if (this.mode === 'help') this.closeHelp()
        return
      case 'dismiss-notice':
        this.notice = undefined
        this.publish()
        return
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** The ONE authoritative catalog read. A read already in flight makes the
   *  next one wait and run once, so a burst of invalidations costs one read. */
  private async read(): Promise<void> {
    if (this.disposed) return
    if (this.readAbort !== undefined) {
      this.queuedRefresh = true
      return
    }
    const epoch = ++this.readEpoch
    const controller = new AbortController()
    this.readAbort = controller
    const openEpoch = this.openEpoch
    if (this.catalog.length === 0) {
      this.status = 'loading'
      this.publish()
    }
    try {
      const [entries, limits] = await Promise.all([
        this.port.catalog(controller.signal),
        this.port.deliveryLimits(controller.signal),
      ])
      if (!this.isCurrentRead(epoch, openEpoch)) return
      this.catalog = entries
      this.limits = limits
      this.status = 'ready'
      this.statusMessage = undefined
      this.settleSelection()
      this.publish()
    } catch (error) {
      if (!this.isCurrentRead(epoch, openEpoch)) return
      if (controller.signal.aborted) return
      if (error instanceof SupersededReadError) return
      this.status = this.catalog.length === 0 ? 'error' : 'stale'
      this.statusMessage = this.describeFailure(error)
      this.publish()
    } finally {
      if (this.readAbort === controller) this.readAbort = undefined
      if (!this.disposed && this.queuedRefresh) {
        this.queuedRefresh = false
        this.own('schedule catalog read', () => this.read())
      }
    }
  }

  /** An invalidation: the committed catalog may have changed. A read in
   *  flight is superseded; one newest read follows. */
  private invalidate(): void {
    if (this.disposed) return
    this.readEpoch += 1
    this.readAbort?.abort()
    this.readAbort = undefined
    this.own('schedule catalog read', () => this.read())
    // A Detail page belongs to the invalidated generation and is re-read below
    // (in place when Help is its underlay). A History PAGE is a user-owned
    // pagination context: an invalidation never aborts it, resets it to the
    // first page or closes the Help underlay — the stale banner is the signal,
    // and the next explicit page/refresh reads the authoritative data.
    this.detailEpoch += 1
    this.detailAbort?.abort()
    this.detailAbort = undefined
    if (this.status === 'ready') this.status = 'stale'
    this.publish()
    this.onChange()
    // A visible Detail/History page is re-read from the authoritative Host so an
    // invalidated answer can never leave it visibly stuck on "Loading".
    if (this.surfaceIs('detail') && this.selectedId !== undefined) {
      // Background refresh of the SAME Detail: re-read IN PLACE through the read
      // path only. It is NOT a user navigation, so it must not retarget the
      // selection, change the page/mode or bump the interaction-ownership epoch
      // — an unchanged task must keep the current gesture valid (pure refresh,
      // not a repaint that retires interaction).
      const id = this.selectedId
      const epoch = ++this.detailEpoch
      const openEpoch = this.openEpoch
      const controller = new AbortController()
      this.detailAbort = controller
      this.own('schedule detail read', () => this.readDetail(id, epoch, openEpoch, controller))
    }
  }

  /**
   * The ONE navigation entry into Detail. A dirty editor is never discarded by
   * navigation: the click asks to discard first, remembers the target, and only
   * a confirmed `y` moves there; a cancel keeps the exact draft.
   */
  private requestDetail(id?: string): void {
    const target = id ?? this.selectedId
    if (target === undefined) return
    if (this.mode === 'editor') {
      this.invalidateEditorRead()
      if (this.editorDirty()) {
        this.pendingDetailId = target
        this.bumpPage()
        this.confirm = { kind: 'discard', token: ++this.confirmToken }
        this.publish()
        return
      }
      this.editor = undefined
      this.editorBaseline = undefined
      this.editorRecovery = undefined
    }
    this.openDetail(target)
  }

  private openDetail(id?: string): void {
    const target = id ?? this.selectedId
    if (target === undefined) return
    this.detailEpoch += 1
    const epoch = this.detailEpoch
    const openEpoch = this.openEpoch
    this.detailAbort?.abort()
    const controller = new AbortController()
    this.detailAbort = controller
    this.selectedId = target
    this.bumpPage()
    this.mode = 'detail'
    this.historyView = undefined
    // A switch IMMEDIATELY retires the previous task's detail: while the new
    // view is in flight, the right pane and every detail action must not fall
    // back to the task the user just left.
    if (this.detail?.id !== target) this.detail = undefined
    this.publish()
    this.own('schedule detail read', () => this.readDetail(target, epoch, openEpoch, controller))
  }

  private async readDetail(target: string, epoch: number, openEpoch: number, controller: AbortController): Promise<void> {
    try {
      const result: ScheduleViewResult = await this.port.view({ id: scheduleId(target) }, controller.signal)
      if (this.disposed || epoch !== this.detailEpoch || openEpoch !== this.openEpoch) return
      // Leaving Detail (or opening a confirmation) while the read is in flight
      // retires its answer: the restored page must not carry a detail snapshot
      // the user left. A confirmation over Detail is still that page.
      if (!this.surfaceIs('detail') || this.selectedId !== target) return
      if ('code' in result) {
        this.notice = errorNotice(SCHEDULE_COPY.taskGone)
        this.detail = undefined
        this.selectedId = undefined
        // Help stays open; its underlay becomes the list it now describes.
        if (this.mode === 'help') this.helpReturn = 'list'
        else this.mode = 'list'
        this.publish()
        this.own('schedule catalog read', () => this.read())
        return
      }
      this.detail = result
      this.publish()
    } catch (error) {
      if (this.disposed || epoch !== this.detailEpoch || openEpoch !== this.openEpoch) return
      if (error instanceof SupersededReadError || controller.signal.aborted) return
      this.notice = errorNotice(this.describeFailure(error))
      this.publish()
    } finally {
      if (this.detailAbort === controller) this.detailAbort = undefined
    }
  }

  private async readHistory(before: string | undefined): Promise<void> {
    // The page belongs to the CURRENT selection: a stale detail of the task the
    // user just left must never own the history read.
    const id = this.selectedId
    if (id === undefined) return
    const epoch = ++this.historyEpoch
    const openEpoch = this.openEpoch
    this.historyAbort?.abort()
    const controller = new AbortController()
    this.historyAbort = controller
    const previous = before === undefined ? undefined : this.historyView
    // Help is an underlay: a refresh must not close the page the user is on.
    if (this.mode !== 'help') this.mode = 'history'
    this.historyView = {
      status: 'loading',
      records: before === undefined ? [] : previous?.records ?? [],
      earlierRecordsUnavailable: previous?.earlierRecordsUnavailable ?? false,
      earlierRecordsPruned: previous?.earlierRecordsPruned ?? false,
    }
    this.publish()
    try {
      const result: ScheduleDeliveryHistoryResult = await this.port.history(
        { id: scheduleId(id), limit: HISTORY_PAGE_SIZE, ...(before === undefined ? {} : { before: messageId(before) }) },
        controller.signal,
      )
      if (this.disposed || epoch !== this.historyEpoch || openEpoch !== this.openEpoch) return
      if (!this.surfaceIs('history')) return
      if ('code' in result) {
        // A vanished cursor ENDS this history page: the user must reopen it,
        // and no retained cursor may silently retry the same page.
        this.historyView = {
          status: 'error',
          records: before === undefined ? [] : previous?.records ?? [],
          earlierRecordsUnavailable: previous?.earlierRecordsUnavailable ?? false,
          earlierRecordsPruned: previous?.earlierRecordsPruned ?? false,
          missCode: result.code,
          message: result.code === 'delivery_cursor_not_found'
            ? SCHEDULE_COPY.historyChanged
            : SCHEDULE_COPY.taskGone,
        }
        this.publish()
        return
      }
      this.historyView = {
        status: 'ready',
        records: [...(before === undefined ? [] : previous?.records ?? []), ...result.records],
        earlierRecordsUnavailable: result.earlierRecordsUnavailable,
        earlierRecordsPruned: result.earlierRecordsPruned,
        ...(result.retention === undefined ? {} : { retention: result.retention }),
        ...(result.nextBefore === undefined ? {} : { nextBefore: result.nextBefore }),
      }
      this.publish()
    } catch (error) {
      if (this.disposed || epoch !== this.historyEpoch || openEpoch !== this.openEpoch) return
      if (error instanceof SupersededReadError || controller.signal.aborted) return
      this.historyView = { ...this.historyView, status: 'error', message: this.describeFailure(error) }
      this.publish()
    } finally {
      if (this.historyAbort === controller) this.historyAbort = undefined
    }
  }

  private moreHistory(): void {
    if (this.mode !== 'history' || this.historyView?.status !== 'ready') return
    const next = this.historyView.nextBefore
    // No cursor means the Host proved there is no older saved record; a
    // client-side page index never substitutes for it.
    if (next === undefined) return
    this.own('schedule history read', () => this.readHistory(next))
  }

  // ── editor ────────────────────────────────────────────────────────────────

  private openCreate(): void {
    if (this.busy) return
    this.pageEpoch += 1
    this.invalidateEditorRead()
    this.editorToken += 1
    this.editorRecovery = undefined
    this.pendingDetailId = undefined
    this.mode = 'editor'
    this.editorBaseline = undefined
    this.editor = {
      mode: 'create',
      title: '',
      prompt: '',
      timing: DEFAULT_TIMING_DRAFT,
      timingEdited: false,
      target: DEFAULT_TARGET_DRAFT,
      targetEdited: false,
      advanced: false,
      focused: 0,
    }
    this.notice = undefined
    this.loadSessionChoices()
    this.publish()
  }

  private async openEdit(): Promise<void> {
    if (this.busy) return
    this.pendingDetailId = undefined
    const known = this.detail?.id === this.selectedId ? this.detail : undefined
    const id = known?.id ?? this.selectedId
    if (id === undefined) return
    // ONE edit-read epoch: a late view of task A can never open the editor for
    // A after the user selected B, left Detail or the workspace was disposed.
    const epoch = ++this.detailEpoch
    const openEpoch = this.openEpoch
    this.invalidateEditorRead()
    const controller = new AbortController()
    this.editReadAbort = controller
    let current = known
    if (current === undefined) {
      try {
        const result = await this.port.view({ id: scheduleId(id) }, controller.signal)
        if (this.disposed || epoch !== this.detailEpoch || openEpoch !== this.openEpoch) return
        if ('code' in result) {
          this.notice = errorNotice(SCHEDULE_COPY.taskGone)
          this.publish()
          this.own('schedule catalog read', () => this.read())
          return
        }
        current = result
      } catch (error) {
        if (this.disposed || epoch !== this.detailEpoch || openEpoch !== this.openEpoch) return
        if (error instanceof SupersededReadError || controller.signal.aborted) return
        this.notice = errorNotice(this.describeFailure(error))
        this.publish()
        return
      } finally {
        if (this.editReadAbort === controller) this.editReadAbort = undefined
      }
    }
    if (this.disposed || !this.surfaceIs('detail') || this.selectedId !== id) return
    const draft = draftFromRecord(current)
    this.mode = 'editor'
    this.editorRecovery = undefined
    this.pageEpoch += 1
    this.editorToken += 1
    this.editorBaseline = {
      title: current.title,
      prompt: current.prompt,
      timing: draft.timing,
      target: draft.target,
    }
    this.editor = {
      mode: 'edit',
      id: current.id,
      expectedUpdatedAt: current.updatedAt ?? null,
      title: draft.title,
      prompt: draft.prompt,
      timing: draft.timing,
      timingEdited: false,
      target: draft.target,
      targetEdited: false,
      advanced: draft.target.kind !== 'session' && (draft.target.cwd !== '' || draft.target.agentPreset !== ''),
      focused: 0,
    }
    this.notice = undefined
    this.loadSessionChoices()
    this.publish()
  }

  private selectTimingPreset(preset: ScheduleTimingPreset): void {
    const edited = this.editor
    if (edited === undefined) return
    let kind: ScheduleTimingDraft['kind']
    let quantityUnit: ScheduleQuantityUnit | undefined
    let firstEverySeconds: string | undefined
    switch (preset) {
      case 'once-after':
        kind = 'after'
        quantityUnit = 'hours'
        break
      case 'once-at':
        kind = 'at'
        break
      case 'every-minutes':
        kind = 'every'
        quantityUnit = 'minutes'
        firstEverySeconds = '60'
        break
      case 'every-hours':
        kind = 'every'
        quantityUnit = 'hours'
        firstEverySeconds = '3600'
        break
      case 'every-seconds':
        kind = 'every'
        quantityUnit = 'seconds'
        firstEverySeconds = '60'
        break
      case 'daily':
        kind = 'daily'
        break
      case 'weekly':
        kind = 'weekly'
        break
      case 'cron':
        kind = 'cron'
        break
      case 'rrule':
        kind = 'rrule'
        break
    }

    const currentTiming = edited.timing
    if (preset === 'once-after' && currentTiming.kind === 'after') return
    if (currentTiming.kind === kind) {
      if (quantityUnit === undefined) return
      const timing = selectTimingQuantityUnit(currentTiming, quantityUnit)
      if (timing === currentTiming) return
      this.invalidateEditorRead()
      const timingMemory = { ...(edited.timingMemory ?? {}), [kind]: timing }
      this.editor = { ...edited, timing, timingMemory, timingEdited: true }
      this.publish()
      return
    }

    this.invalidateEditorRead()
    const timingMemory = { ...(edited.timingMemory ?? {}), [currentTiming.kind]: currentTiming }
    const remembered = timingMemory[kind]
    const baseline = this.editorBaseline?.timing.kind === kind ? this.editorBaseline.timing : undefined
    let timing = remembered ?? baseline
    if (timing === undefined) {
      timing = selectTimingKind(currentTiming, kind, new Date())
      if (timing.kind === 'every' && quantityUnit !== undefined && firstEverySeconds !== undefined) {
        timing = { ...timing, everySeconds: firstEverySeconds, quantityUnit }
      }
    } else if (quantityUnit !== undefined) {
      timing = selectTimingQuantityUnit(timing, quantityUnit)
    }
    this.editor = { ...edited, timing, timingMemory, timingEdited: true }
    this.publish()
  }

  private toggleWeekday(weekday: number): void {
    if (this.editor === undefined || this.editor.timing.kind !== 'weekly') return
    this.invalidateEditorRead()
    const timing: ScheduleTimingDraft = this.editor.timing
    const weekdays = timing.weekdays.includes(weekday)
      ? timing.weekdays.filter(day => day !== weekday)
      : [...timing.weekdays, weekday].sort((left, right) => left - right)
    this.editor = { ...this.editor, timing: { ...timing, weekdays }, timingEdited: true }
    this.publish()
  }

  private selectTarget(kind: ScheduleTargetKind): void {
    if (this.editor === undefined) return
    const current = this.editor.target
    if (current.kind === kind) return
    this.invalidateEditorRead()
    const targetMemory = { ...(this.editor.targetMemory ?? {}), [current.kind]: current }
    const remembered = targetMemory[kind]
    const baselineTarget = this.editorBaseline?.target.kind === kind ? this.editorBaseline.target : undefined
    const target: ScheduleTargetDraft = remembered ?? baselineTarget ?? (kind === 'session'
      ? { kind, sessionId: undefined }
      : { kind, cwd: '', agentPreset: '' })
    this.editor = {
      ...this.editor,
      target,
      targetMemory,
      targetEdited: true,
      advanced: target.kind !== 'session' && (target.cwd !== '' || target.agentPreset !== ''),
    }
    this.publish()
  }

  private selectTargetSession(sessionId: string): void {
    if (this.editor === undefined) return
    this.invalidateEditorRead()
    this.editor = { ...this.editor, target: { kind: 'session', sessionId }, targetEdited: true }
    this.publish()
  }

  private loadSessionChoices(): void {
    this.own('schedule Session roster read', async () => { await this.readSessionRoster() })
  }

  /** Read the single authorized roster and derive both chooser labels and link eligibility. */
  private async readSessionRoster(): Promise<readonly string[] | undefined> {
    this.rosterAbort?.abort()
    const controller = new AbortController()
    this.rosterAbort = controller
    const epoch = ++this.rosterEpoch
    const openEpoch = this.openEpoch
    this.sessionRosterState = 'checking'
    this.availableSessionIds = []
    this.sessions = []
    this.publish()
    const isCurrent = (): boolean => !this.disposed
      && !controller.signal.aborted
      && this.rosterAbort === controller
      && epoch === this.rosterEpoch
      && openEpoch === this.openEpoch
    try {
      const rows = await this.sessionReader.list(undefined, controller.signal)
      if (!isCurrent()) return undefined
      if (rows === undefined) {
        this.sessionRosterState = 'unavailable'
        this.publish()
        return undefined
      }
      const candidates = rows.filter(row => row.origin !== 'subagent')
      this.availableSessionIds = candidates.map(row => row.id)
      this.sessionRosterState = 'ready'
      this.publish()
      let projections = new Map<string, { readonly title?: string }>()
      try {
        projections = await this.sessionReader.projectionBatch(candidates, controller.signal)
      } catch {
        if (!isCurrent()) return undefined
      }
      if (!isCurrent()) return undefined
      this.sessions = candidates.map(row => {
        const title = projections.get(row.id)?.title
        return { id: row.id, ...(title === undefined ? {} : { title }) }
      })
      this.publish()
      return this.availableSessionIds
    } catch {
      if (!isCurrent()) return undefined
      this.sessionRosterState = 'error'
      this.availableSessionIds = []
      this.sessions = []
      this.publish()
      return undefined
    } finally {
      if (this.rosterAbort === controller) this.rosterAbort = undefined
    }
  }

  private openDetailConversation(): void {
    const entry = this.selectedEntry()
    if (entry === undefined) return
    let targetSessionId: string | undefined
    if (entry.lastDelivery !== undefined) targetSessionId = entry.lastDelivery.targetSessionId
    else if (entry.target.kind === 'session') targetSessionId = entry.target.sessionId
    else {
      this.notice = infoNotice(entry.target.kind === 'new_once'
        ? SCHEDULE_COPY.pendingFirstDelivery
        : SCHEDULE_COPY.noDeliveryYet)
      this.publish()
      return
    }
    this.navigateToSession(targetSessionId, { kind: 'detail', selectedId: entry.id, sessionId: targetSessionId })
  }

  private openDeliveryConversation(messageId: string): void {
    const record = this.historyView?.records.find(item => item.messageId === messageId)
    if (record === undefined) return
    this.navigateToSession(record.targetSessionId, {
      kind: 'history',
      selectedId: this.selectedId,
      messageId,
      sessionId: record.targetSessionId,
    })
  }

  private navigateToSession(
    sessionId: string,
    owner: { readonly kind: 'detail'; readonly selectedId: string; readonly sessionId: string }
      | { readonly kind: 'history'; readonly selectedId: string | undefined; readonly messageId: string; readonly sessionId: string },
  ): void {
    if (this.navigationPending || this.busy || this.confirm !== undefined) return
    if (this.sessionRosterState !== 'ready' || !this.availableSessionIds.includes(sessionId)) {
      this.notice = infoNotice(this.sessionAvailabilityMessage(sessionId))
      this.publish()
      return
    }
    const switchSession = this.captureSessionSwitch()
    const epoch = ++this.navigationEpoch
    const pageEpoch = this.pageEpoch
    this.navigationPending = true
    this.notice = infoNotice(SCHEDULE_COPY.openingConversation)
    this.publish()
    this.own('schedule conversation navigation', async () => {
      try {
        const fresh = await this.readSessionRoster()
        if (!this.isCurrentNavigation(epoch, pageEpoch, owner)) return
        if (fresh === undefined) {
          this.notice = infoNotice(this.sessionAvailabilityMessage(sessionId))
          this.publish()
          return
        }
        if (!fresh.includes(sessionId)) {
          this.notice = infoNotice(SCHEDULE_COPY.sessionNotListed)
          this.publish()
          return
        }
        const outcome = await switchSession(sessionId)
        if (!this.isCurrentNavigation(epoch, pageEpoch, owner)) return
        if (outcome.kind === 'committed' || outcome.kind === 'already-current') {
          this.closeWorkspace()
          return
        }
        this.notice = outcome.kind === 'cancelled'
          ? infoNotice('Conversation was not opened.')
          : infoNotice(outcome.message)
        this.publish()
      } finally {
        if (this.navigationEpoch === epoch && !this.disposed) {
          this.navigationPending = false
          this.publish()
        }
      }
    })
  }

  private isCurrentNavigation(
    epoch: number,
    pageEpoch: number,
    owner: { readonly kind: 'detail'; readonly selectedId: string; readonly sessionId: string }
      | { readonly kind: 'history'; readonly selectedId: string | undefined; readonly messageId: string; readonly sessionId: string },
  ): boolean {
    if (this.disposed || epoch !== this.navigationEpoch || pageEpoch !== this.pageEpoch
      || this.confirm !== undefined || this.busy) return false
    if (owner.kind === 'detail') {
      if (!this.surfaceIs('detail') || this.selectedId !== owner.selectedId) return false
      const entry = this.selectedEntry()
      return entry?.id === owner.selectedId
        && (entry.lastDelivery?.targetSessionId ?? (entry.target.kind === 'session' ? entry.target.sessionId : undefined)) === owner.sessionId
    }
    const record = this.historyView?.records.find(item => item.messageId === owner.messageId)
    return this.surfaceIs('history')
      && this.selectedId === owner.selectedId
      && record?.targetSessionId === owner.sessionId
  }

  private sessionAvailabilityMessage(sessionId: string): string {
    if (this.sessionRosterState === 'checking') return SCHEDULE_COPY.sessionChecking
    if (this.sessionRosterState === 'unavailable') return SCHEDULE_COPY.sessionRosterUnavailable
    if (this.sessionRosterState === 'error') return SCHEDULE_COPY.sessionRosterError
    return this.availableSessionIds.includes(sessionId) ? SCHEDULE_COPY.sessionChecking : SCHEDULE_COPY.sessionNotListed
  }

  /** The page identity a Host write must still own when it settles. */
  private surfaceStamp(): { readonly page: string; readonly selectedId: string | undefined; readonly editorId: string | undefined; readonly editorToken: number } {
    // Help is an UNDERLAY: a write issued from the page it covers still owns
    // that page, so a receipt may settle it without closing Help.
    return {
      page: this.mode === 'help' ? (this.helpReturn ?? 'list') : this.mode,
      selectedId: this.selectedId,
      editorId: this.editor?.id,
      editorToken: this.editorToken,
    }
  }

  private sameSurface(stamp: { readonly page: string; readonly selectedId: string | undefined; readonly editorId: string | undefined; readonly editorToken: number }): boolean {
    const page = this.mode === 'help' ? (this.helpReturn ?? 'list') : this.mode
    if (page !== stamp.page) return false
    // An EDITOR is owned by its instance, not by the catalog's selection cursor:
    // a background catalog refresh may move `selectedId` while a Create/Edit is
    // in flight, and that must not strand a successful receipt on the form.
    if (page === 'editor') {
      return this.editor !== undefined
        && this.editor.id === stamp.editorId
        && this.editorToken === stamp.editorToken
    }
    // Detail/list actions ARE scoped to the selected task: a receipt for a task
    // the user left must never touch the page they are on.
    return this.selectedId === stamp.selectedId
  }

  /** The ONE controller-level mode admission table. */
  private admits(kind: ScheduleIntent['kind']): boolean {
    if (this.navigationPending) return false
    // A pending EDITOR save freezes the whole editor surface, not only its text:
    // leaving, discarding or navigating to another task would race the receipt
    // and could create a stale Discard question. Detail/list writes keep
    // navigation free — the settlement stamp already protects their page.
    if (this.busy && this.busyEditor) {
      return kind === 'refresh' || kind === 'dismiss-notice' || kind === 'open-help' || kind === 'close-help'
    }
    if (kind === 'refresh' || kind === 'dismiss-notice' || kind === 'back'
      || kind === 'confirm' || kind === 'cancel') return true
    if (kind === 'open-help') return this.confirm === undefined
    if (kind === 'close-help') return this.mode === 'help'
    const editorOnly: readonly ScheduleIntent['kind'][] = [
      'set-field', 'focus-field', 'next-field', 'select-timing-preset', 'toggle-weekday',
      'select-target-kind', 'select-target-session', 'toggle-advanced', 'save', 'review-with-my-edits', 'reload-latest',
    ]
    if (editorOnly.includes(kind)) return this.mode === 'editor'
    if (kind === 'open-detail') return this.mode === 'list' || this.mode === 'detail' || this.mode === 'editor'
    if (kind === 'open-create' || kind === 'set-filter' || kind === 'set-query') {
      return this.mode === 'list'
    }
    if (kind === 'move') return this.mode === 'list' || this.mode === 'detail'
    if (kind === 'open-edit' || kind === 'open-history' || kind === 'toggle-active'
      || kind === 'ask-run' || kind === 'ask-delete' || kind === 'open-detail-conversation') {
      return this.mode === 'detail'
    }
    if (kind === 'refresh-session-roster') return this.mode === 'detail' || this.mode === 'history'
    if (kind === 'open-delivery-conversation') return this.mode === 'history'
    if (kind === 'ask-clear-ended') return this.mode === 'list' || this.mode === 'detail'
    if (kind === 'history-more') return this.mode === 'history' && !this.busy
    return false
  }

  private async performReload(): Promise<void> {
    const draft = this.editor
    const baseline = this.editorBaseline
    if (draft === undefined || draft.id === undefined || baseline === undefined || this.busy) return
    this.editReadAbort?.abort()
    const controller = new AbortController()
    this.editReadAbort = controller
    const token = this.editorToken
    const epoch = ++this.reloadEpoch
    try {
      const result = await this.port.view({ id: scheduleId(draft.id) }, controller.signal)
      if (!this.isCurrentEditorRead(epoch, token, draft.id, controller)) return
      if ('code' in result) {
        this.editorRecovery = 'missing'
        this.notice = errorNotice(SCHEDULE_COPY.missing)
        this.publish()
        return
      }
      const fromRecord = draftFromRecord(result)
      const latest: ScheduleEditorBaseline = {
        title: result.title,
        prompt: result.prompt,
        timing: fromRecord.timing,
        target: fromRecord.target,
      }
      const next: ScheduleEditorDraft = {
        ...draft,
        title: latest.title,
        prompt: latest.prompt,
        timing: latest.timing,
        target: latest.target,
        timingMemory: undefined,
        targetMemory: undefined,
        timingEdited: false,
        targetEdited: false,
        advanced: latest.target.kind !== 'session' && (latest.target.cwd !== '' || latest.target.agentPreset !== ''),
        expectedUpdatedAt: result.updatedAt ?? null,
      }
      const currentEditor = this.editor
      const currentFocusedId = currentEditor === undefined
        ? 'timing-kind'
        : editorFields(currentEditor)[currentEditor.focused]?.id ?? 'timing-kind'
      this.editor = { ...next, focused: editorFocusIndex(next, currentFocusedId) }
      this.editorBaseline = latest
      this.editorRecovery = undefined
      this.notice = infoNotice(SCHEDULE_COPY.reloaded)
      this.publish()
    } catch (error) {
      if (controller.signal.aborted || error instanceof SupersededReadError) return
      if (!this.isCurrentEditorRead(epoch, token, draft.id, controller)) return
      this.notice = errorNotice(this.describeFailure(error))
      this.publish()
    } finally {
      if (this.editReadAbort === controller) this.editReadAbort = undefined
    }
  }

  private async performReview(): Promise<void> {
    const draft = this.editor
    const baseline = this.editorBaseline
    if (draft === undefined || draft.mode !== 'edit' || draft.id === undefined || baseline === undefined
      || this.busy || this.confirm !== undefined
      || (this.editorRecovery !== 'conflict' && this.editorRecovery !== 'unknown')) return

    const localChanged = {
      title: draft.title !== baseline.title,
      prompt: draft.prompt !== baseline.prompt,
      timing: !safeSameTiming(draft.timing, baseline.timing),
      target: !sameTargetDraft(draft.target, baseline.target),
    }
    const token = this.editorToken
    const id = draft.id
    this.editReadAbort?.abort()
    const controller = new AbortController()
    this.editReadAbort = controller
    const epoch = ++this.reloadEpoch
    try {
      const result = await this.port.view({ id: scheduleId(id) }, controller.signal)
      if (!this.isCurrentEditorRead(epoch, token, id, controller)) return
      if ('code' in result) {
        this.editorRecovery = 'missing'
        this.notice = errorNotice(SCHEDULE_COPY.missing)
        this.publish()
        return
      }
      const fromRecord = draftFromRecord(result)
      const latest: ScheduleEditorBaseline = {
        title: result.title,
        prompt: result.prompt,
        timing: fromRecord.timing,
        target: fromRecord.target,
      }
      const remoteChanged = {
        title: latest.title !== baseline.title,
        prompt: latest.prompt !== baseline.prompt,
        timing: !safeSameTiming(latest.timing, baseline.timing),
        target: !sameTargetDraft(latest.target, baseline.target),
      }
      const target = localChanged.target ? draft.target : latest.target
      const next: ScheduleEditorDraft = {
        ...draft,
        title: localChanged.title ? draft.title : latest.title,
        prompt: localChanged.prompt ? draft.prompt : latest.prompt,
        timing: localChanged.timing ? draft.timing : latest.timing,
        target,
        timingMemory: undefined,
        targetMemory: undefined,
        timingEdited: localChanged.timing,
        targetEdited: localChanged.target,
        advanced: target.kind !== 'session' && (target.cwd !== '' || target.agentPreset !== ''),
        expectedUpdatedAt: result.updatedAt ?? null,
      }
      const currentEditor = this.editor
      const currentFocusedId = currentEditor === undefined
        ? 'timing-kind'
        : editorFields(currentEditor)[currentEditor.focused]?.id ?? 'timing-kind'
      this.editor = { ...next, focused: editorFocusIndex(next, currentFocusedId) }
      this.editorBaseline = latest
      this.editorRecovery = undefined
      const bothChanged = [
        localChanged.title && remoteChanged.title ? 'Title' : undefined,
        localChanged.prompt && remoteChanged.prompt ? 'Instruction' : undefined,
        localChanged.timing && remoteChanged.timing ? 'Repeat' : undefined,
        localChanged.target && remoteChanged.target ? 'Destination' : undefined,
      ].filter((group): group is string => group !== undefined)
      const unchanged = next.title === latest.title
        && next.prompt === latest.prompt
        && safeSameTiming(next.timing, latest.timing)
        && sameTargetDraft(next.target, latest.target)
      this.notice = infoNotice(unchanged
        ? bothChanged.length > 0
          ? SCHEDULE_COPY.hostMatchesWithOverlap(bothChanged.join('/'))
          : SCHEDULE_COPY.hostMatches
        : bothChanged.length > 0
          ? SCHEDULE_COPY.bothChanged(bothChanged.join('/'))
          : SCHEDULE_COPY.reviewed)
      this.publish()
    } catch (error) {
      if (controller.signal.aborted || error instanceof SupersededReadError) return
      if (!this.isCurrentEditorRead(epoch, token, id, controller)) return
      this.notice = errorNotice(this.describeFailure(error))
      this.publish()
    } finally {
      if (this.editReadAbort === controller) this.editReadAbort = undefined
    }
  }

  private isCurrentEditorRead(
    epoch: number,
    token: number,
    id: string,
    controller: AbortController,
  ): boolean {
    return !this.disposed
      && !controller.signal.aborted
      && this.editReadAbort === controller
      && epoch === this.reloadEpoch
      && token === this.editorToken
      && this.editor?.id === id
      && this.surfaceIs('editor')
      && this.confirm === undefined
      && !this.busy
  }

  /** The UNIQUE save action: one local refusal or one Host create/edit. */
  private save(): void {
    const draft = this.editor
    if (draft === undefined || this.busy || this.editorRecovery !== undefined) return
    if (draft.mode === 'edit' && !this.editorDirty()) return
    let request:
      | { readonly kind: 'create'; readonly create: ReturnType<typeof encodeCreate> }
      | { readonly kind: 'edit'; readonly patch: ReturnType<typeof encodePatch> }
    try {
      if (draft.mode === 'create') {
        request = { kind: 'create', create: encodeCreate(draft) }
      } else {
        if (this.editorBaseline === undefined) return
        request = { kind: 'edit', patch: encodePatch(this.editorBaseline, draft) }
      }
    } catch (error) {
      if (error instanceof ScheduleFormError) {
        this.notice = errorNotice(error.message)
        this.publish()
        return
      }
      throw error
    }
    // A write owns the editor from now on; an older read cannot replace this draft.
    this.invalidateEditorRead()
    const id = draft.id
    const expectedUpdatedAt = draft.expectedUpdatedAt ?? null
    this.busyEditor = true
    this.startWrite(draft.mode === 'create' ? 'schedule create' : 'schedule edit', async () => {
      if (request.kind === 'create') await this.createTask(request.create)
      else if (id !== undefined) await this.editTask(id, request.patch, expectedUpdatedAt)
    })
  }

  private async createTask(create: ReturnType<typeof encodeCreate>): Promise<void> {
    const stamp = this.surfaceStamp()
    try {
      const entry = await this.port.create(create)
      if (this.sameSurface(stamp) && this.editor?.mode === 'create') {
        const underHelp = this.mode === 'help'
        this.editor = undefined
        this.editorBaseline = undefined
        this.editorRecovery = undefined
        this.detail = entry
        this.selectedId = entry.id
        if (underHelp) this.helpReturn = 'detail'
        else this.mode = 'detail'
      }
      this.notice = infoNotice(SCHEDULE_COPY.updated)
      this.publish()
      await this.refreshNow()
    } catch (error) {
      if (this.sameSurface(stamp)) {
        this.editorRecovery = error instanceof ScheduleOutcomeUnknownError ? 'unknown' : undefined
        this.notice = errorNotice(error instanceof ScheduleOutcomeUnknownError
          ? SCHEDULE_COPY.createUnknown
          : this.describeFailure(error))
        this.publish()
      }
      if (error instanceof ScheduleOutcomeUnknownError) await this.refreshNow()
    } finally {
      this.busyEditor = false
    }
  }

  private async editTask(id: string, patch: ReturnType<typeof encodePatch>, expectedUpdatedAt: string | null): Promise<void> {
    const stamp = this.surfaceStamp()
    try {
      const result: ScheduleEditResult = await this.port.edit({
        id: scheduleId(id),
        action: 'update',
        patch,
        expectedUpdatedAt,
      })
      if ('code' in result) {
        if (this.sameSurface(stamp) && this.editor?.mode === 'edit') {
          this.editorRecovery = result.code === 'schedule_conflict' ? 'conflict' : 'missing'
          this.notice = errorNotice(result.code === 'schedule_conflict' ? SCHEDULE_COPY.conflict : SCHEDULE_COPY.missing)
          this.publish()
        }
        if (result.code === 'schedule_not_found') await this.refreshNow()
        return
      }
      if (this.sameSurface(stamp) && this.editor?.mode === 'edit') {
        const underHelp = this.mode === 'help'
        this.editor = undefined
        this.editorBaseline = undefined
        this.editorRecovery = undefined
        this.detail = result as ScheduleCatalogEntry
        if (underHelp) this.helpReturn = 'detail'
        else this.mode = 'detail'
      }
      this.notice = infoNotice(SCHEDULE_COPY.updated)
      this.publish()
      await this.refreshNow()
    } catch (error) {
      if (this.sameSurface(stamp)) {
        this.editorRecovery = error instanceof ScheduleOutcomeUnknownError ? 'unknown' : undefined
        this.notice = errorNotice(error instanceof ScheduleOutcomeUnknownError
          ? SCHEDULE_COPY.editorUnknown
          : this.describeFailure(error))
        this.publish()
      }
      if (error instanceof ScheduleOutcomeUnknownError) await this.refreshNow()
    } finally {
      this.busyEditor = false
    }
  }

  // ── list actions ──────────────────────────────────────────────────────────

  /** The ONE record a detail action may act on: never a previous task's stale
   *  detail while a different task is selected. */
  private selectedEntry(): ScheduleCatalogEntry | undefined {
    if (this.selectedId === undefined) return undefined
    if (this.detail?.id === this.selectedId) return this.detail
    return this.catalog.find(row => row.id === this.selectedId)
  }

  private executionBusy(entry: ScheduleCatalogEntry | undefined): boolean {
    if (entry?.executionActive !== true) return false
    this.notice = infoNotice(SCHEDULE_COPY.executionBusy)
    this.publish()
    return true
  }

  private toggleActive(): void {
    if (this.busy) return
    const entry = this.selectedEntry()
    if (entry === undefined || this.executionBusy(entry)) return
    const active = entry.status !== 'active'
    this.startWrite('schedule pause/resume', async () => {
      const stamp = this.surfaceStamp()
      try {
        const result = await this.port.edit({
          id: scheduleId(entry.id),
          action: 'update',
          patch: { active },
          expectedUpdatedAt: entry.updatedAt ?? null,
        })
        const refusal = editRefusal(result)
        if (refusal !== undefined) {
          this.notice = errorNotice(refusal)
          this.publish()
          if ('code' in result && result.code === 'schedule_not_found' && this.sameSurface(stamp)) {
            this.detail = undefined
            this.selectedId = undefined
            this.mode = 'list'
          }
          await this.refreshNow()
          return
        }
        this.notice = infoNotice(SCHEDULE_COPY.updated)
        if (this.sameSurface(stamp)) this.detail = result as ScheduleCatalogEntry
        this.publish()
        await this.refreshNow()
      } catch (error) {
        this.notice = errorNotice(this.describeFailure(error))
        this.publish()
        await this.refreshNow()
      }
    })
  }

  private askRun(): void {
    const entry = this.selectedEntry()
    if (entry === undefined || this.busy || this.executionBusy(entry)) return
    this.bumpPage()
    this.confirm = {
      kind: 'run',
      token: ++this.confirmToken,
      id: entry.id,
      title: entry.title,
      expectedUpdatedAt: entry.updatedAt ?? null,
    }
    this.publish()
  }

  private askDelete(): void {
    const entry = this.selectedEntry()
    if (entry === undefined || this.busy || this.executionBusy(entry)) return
    this.bumpPage()
    this.confirm = {
      kind: 'delete',
      token: ++this.confirmToken,
      id: entry.id,
      title: entry.title,
      shortId: entry.id.slice(-8),
      // Freeze the revision the user is confirming NOW; the write submits it
      // verbatim, so a concurrent edit turns into a conflict, never a silent
      // delete of a newer version.
      expectedUpdatedAt: entry.updatedAt ?? null,
    }
    this.publish()
  }

  private askClearEnded(): void {
    if (this.busy) return
    this.bumpPage()
    this.confirm = { kind: 'clear-ended', token: ++this.confirmToken }
    this.publish()
  }

  private commitConfirm(): void {
    const confirm = this.confirm
    if (confirm === undefined || this.busy) return
    // Commit the intent BEFORE any Host call: one confirmation generation owns
    // exactly one write, and a stale `y` cannot act on a newer question.
    this.confirm = undefined
    this.bumpPage()
    this.publish()
    switch (confirm.kind) {
      case 'discard': {
        const pending = this.pendingDetailId
        this.pendingDetailId = undefined
        this.invalidateEditorRead()
        this.editor = undefined
        this.editorBaseline = undefined
        this.editorRecovery = undefined
        this.notice = undefined
        if (pending !== undefined) {
          this.bumpPage()
          this.openDetail(pending)
          return
        }
        this.mode = this.detail === undefined ? 'list' : 'detail'
        this.publish()
        return
      }
      case 'reload':
        this.own('schedule reload latest', () => this.performReload())
        return
      case 'run': {
        const entry = this.selectedEntry()
        if (entry?.id !== confirm.id) {
          this.notice = infoNotice('Task changed. Reopen the confirmation before continuing.')
          this.publish()
          return
        }
        if (this.executionBusy(entry)) return
        if ((entry.updatedAt ?? null) !== confirm.expectedUpdatedAt) {
          this.notice = infoNotice('Task changed. Reopen the confirmation before running it.')
          this.publish()
          return
        }
        this.runNow(confirm.id)
        return
      }
      case 'delete': {
        const entry = this.selectedEntry()
        if (entry?.id !== confirm.id || this.executionBusy(entry)) return
        this.deleteTask(confirm.id, confirm.expectedUpdatedAt)
        return
      }
      case 'clear-ended':
        this.clearEnded()
        return
    }
  }

  private cancelConfirm(): void {
    if (this.confirm === undefined) return
    this.confirm = undefined
    this.bumpPage()
    this.pendingDetailId = undefined
    this.publish()
  }

  private runNow(id: string): void {
    this.startWrite('schedule run now', async () => {
      const stamp = this.surfaceStamp()
      try {
        const result = await this.port.run({ id: scheduleId(id) })
        if ('code' in result && result.code === 'schedule_execution_pending') {
          this.notice = infoNotice(SCHEDULE_COPY.runPendingInfo)
          this.publish()
          return
        }
        if ('code' in result) {
          this.notice = errorNotice(SCHEDULE_COPY.taskGone)
          this.publish()
          await this.refreshNow()
          return
        }
        this.notice = infoNotice(SCHEDULE_COPY.deliveryQueued)
        if (this.sameSurface(stamp)) this.detail = result
        this.publish()
        await this.refreshNow()
      } catch (error) {
        this.notice = errorNotice(this.describeFailure(error))
        this.publish()
        if (error instanceof ScheduleOutcomeUnknownError) await this.refreshNow()
      }
    })
  }

  private deleteTask(id: string, expectedUpdatedAt: string | null): void {
    this.startWrite('schedule delete', async () => {
      const stamp = this.surfaceStamp()
      try {
        const result = await this.port.edit({
          id: scheduleId(id),
          action: 'delete',
          expectedUpdatedAt,
        })
        if ('deleted' in result && result.deleted === true) {
          this.notice = infoNotice(SCHEDULE_COPY.updated)
          if (this.sameSurface(stamp)) {
            const underHelp = this.mode === 'help'
            this.detail = undefined
            this.selectedId = undefined
            this.historyView = undefined
            this.bumpPage()
            if (underHelp) this.helpReturn = 'list'
            else this.mode = 'list'
          }
          this.publish()
          await this.refreshNow()
          return
        }
        const refusal = editRefusal(result)
        this.notice = errorNotice(refusal ?? SCHEDULE_COPY.taskGone)
        if ('code' in result && result.code === 'schedule_not_found' && this.sameSurface(stamp)) {
          this.detail = undefined
          this.selectedId = undefined
          this.mode = 'list'
        }
        this.publish()
        await this.refreshNow()
      } catch (error) {
        this.notice = errorNotice(this.describeFailure(error))
        this.publish()
        if (error instanceof ScheduleOutcomeUnknownError) await this.refreshNow()
      }
    })
  }

  private clearEnded(): void {
    this.startWrite('schedule clear ended', async () => {
      try {
        const result = await this.port.deleteInactive()
        this.notice = infoNotice(result.deleted === 0
          ? SCHEDULE_COPY.noEnded
          : SCHEDULE_COPY.cleared(result.deleted))
        this.publish()
        await this.refreshNow()
      } catch (error) {
        this.notice = errorNotice(this.describeFailure(error))
        this.publish()
        if (error instanceof ScheduleOutcomeUnknownError) await this.refreshNow()
      }
    })
  }

  // ── navigation ───────────────────────────────────────────────────────────

  private closeHelp(): void {
    this.bumpPage()
    const returnTo = this.helpReturn
    this.helpReturn = undefined
    this.mode = returnTo ?? (this.detail === undefined ? 'list' : 'detail')
    this.publish()
    // A page whose read was retired while Help was up gets ONE newest read; it
    // never stays visibly loading forever.
    if (this.mode === 'history' && this.historyView?.status === 'loading') {
      this.own('schedule history read', () => this.readHistory(undefined))
    } else if (this.mode === 'detail' && this.detail === undefined && this.selectedId !== undefined) {
      const id = this.selectedId
      this.own('schedule detail read', async () => { this.openDetail(id) })
    }
  }

  private back(): void {
    if (this.confirm !== undefined) {
      this.cancelConfirm()
      return
    }
    if (this.mode === 'help') {
      this.closeHelp()
      return
    }
    if (this.mode === 'editor') {
      this.invalidateEditorRead()
      if (this.editorDirty()) {
        this.pendingDetailId = undefined
        this.bumpPage()
        this.confirm = { kind: 'discard', token: ++this.confirmToken }
        this.publish()
        return
      }
      this.editor = undefined
      this.editorBaseline = undefined
      this.editorRecovery = undefined
      this.bumpPage()
      this.mode = this.detail === undefined ? 'list' : 'detail'
      this.publish()
      return
    }
    if (this.mode === 'history') {
      this.bumpPage()
      this.mode = 'detail'
      this.historyView = undefined
      this.publish()
      return
    }
    if (this.mode === 'detail') {
      this.bumpPage()
      this.mode = 'list'
      this.detail = undefined
      this.publish()
      return
    }
  }

  private editorDirty(): boolean {
    const draft = this.editor
    if (draft === undefined) return false
    if (draft.mode === 'create') {
      // A create draft is dirty only when it holds a real user value; merely
      // cycling the timing kind back to its default is not unsaved work.
      return draft.title.trim() !== '' ||
        draft.prompt.trim() !== '' ||
        !safeSameTiming(draft.timing, DEFAULT_TIMING_DRAFT) ||
        !sameTargetDraft(draft.target, DEFAULT_TARGET_DRAFT)
    }
    const baseline = this.editorBaseline
    if (baseline === undefined) return true
    // VALUE comparison against the current accepted baseline: a field reverted
    // to its baseline value is not a pending edit, and an untouched field that a
    // reload adopted is not one either.
    return draft.title !== baseline.title ||
      draft.prompt !== baseline.prompt ||
      !safeSameTiming(draft.timing, baseline.timing) ||
      !sameTargetDraft(draft.target, baseline.target)
  }

  private moveSelection(delta: number): void {
    if (this.mode !== 'list' && this.mode !== 'detail') return
    const rows = this.projectedRows()
    if (rows.length === 0) return
    const current = rows.findIndex(row => row.id === this.selectedId)
    const next = (current < 0 ? 0 : current + delta + rows.length) % rows.length
    const nextId = rows[next].id
    if (nextId === this.selectedId) return
    this.selectedId = nextId
    this.bumpPage()
    if (this.mode === 'detail') this.detail = undefined
    this.publish()
  }

  // ── projection / settlement ───────────────────────────────────────────────

  /** The read-only projection of the committed catalog: the filter and then the
   *  case-insensitive substring over title+prompt. It never requests a Host. */
  private projectedRows(): readonly ScheduleCatalogEntry[] {
    const query = this.query.trim().toLowerCase()
    return this.catalog.filter(entry => {
      if (this.filter === 'active' && entry.status !== 'active') return false
      if (this.filter === 'paused' && entry.status !== 'paused') return false
      if (this.filter === 'ended' && entry.status !== 'ended') return false
      if (query === '') return true
      return entry.title.toLowerCase().includes(query) || entry.prompt.toLowerCase().includes(query)
    })
  }

  private settleSelection(): void {
    const rows = this.projectedRows()
    if (this.selectedId !== undefined && rows.some(row => row.id === this.selectedId)) return
    this.selectedId = rows[0]?.id
    if (this.mode === 'detail') this.detail = undefined
  }

  private startWrite(label: string, work: () => Promise<void>): void {
    if (this.busy || this.disposed) return
    this.busy = true
    this.idle = new Promise<void>(resolve => { this.resolveIdle = resolve })
    this.publish()
    const settle = async (): Promise<void> => {
      try {
        await work()
      } catch (error) {
        if (!this.disposed) {
          this.notice = errorNotice(this.describeFailure(error))
          this.publish()
        }
      } finally {
        this.busy = false
        this.resolveIdle?.()
        this.resolveIdle = undefined
        this.idle = undefined
        if (!this.disposed) this.publish()
      }
    }
    this.runOwned(label, settle)
  }

  /** Run one controller workflow through the app-owned task entry (the ONE
   *  promise-ownership sink; no hand-written `void` chain exists here). */
  private own(label: string, task: () => Promise<void>): void {
    this.runOwned(label, task)
  }

  private invalidateEditorRead(): void {
    this.reloadEpoch += 1
    this.editReadAbort?.abort()
    this.editReadAbort = undefined
  }

  /** Whether `page` is the surface the user is actually looking at: Help is an
   *  UNDERLAY, so a read answer for its `helpReturn` page stays publishable. */
  private surfaceIs(page: 'list' | 'detail' | 'history' | 'editor'): boolean {
    return this.mode === page || (this.mode === 'help' && this.helpReturn === page)
  }

  /** One read that must be newest: used after a mutation settlement. */
  private async refreshNow(): Promise<void> {
    this.readEpoch += 1
    this.readAbort?.abort()
    this.readAbort = undefined
    await this.read()
  }

  private publish(): void {
    if (this.disposed) return
    for (const listener of this.listeners) listener()
  }

  private isCurrentRead(epoch: number, openEpoch: number): boolean {
    return !this.disposed && epoch === this.readEpoch && openEpoch === this.openEpoch
  }

  private describeFailure(error: unknown): string {
    if (error instanceof ScheduleUnavailableError) return SCHEDULE_COPY.serviceUnavailable
    if (error instanceof ScheduleOutcomeUnknownError) return SCHEDULE_COPY.outcomeUnknown
    const code = remoteFailureCode(error)
    if (code === 'schedule/input-invalid') {
      const details = copyFailureDetails(error)
      const detailCode = typeof details?.code === 'string' ? details.code : 'invalid'
      return SCHEDULE_COPY.invalid(detailCode)
    }
    if (code === 'schedule/target-archived') return SCHEDULE_COPY.targetArchived
    if (isPermissionCode(code)) return SCHEDULE_COPY.permissionDenied
    return remoteFailureMessage(error) || safeErrorMessage(error)
  }
}

function editorFocusIndex(draft: ScheduleEditorDraft, fieldId: string): number {
  const fields = editorFields(draft)
  const index = fields.findIndex(field => field.id === fieldId)
  if (index >= 0) return index
  return fields.findIndex(field => field.id === 'timing-kind')
}

/** Whether two timing drafts are the SAME encoded rule; an INVALID intermediate
 *  draft is never "unchanged" (Esc must still treat it as unsaved work). */
function safeSameTiming(left: ScheduleTimingDraft, right: ScheduleTimingDraft): boolean {
  try {
    return sameTimingDraft(left, right)
  } catch {
    return false
  }
}

/** The editor baseline one edit patches against. */
export type { ScheduleEditorBaseline }

/** The official task identity admitted at the adapter boundary. */
function scheduleId(id: string): Parameters<SchedulePort['view']>[0]['id'] {
  // The id came from the Host catalog itself; only the compile-time brand is
  // added here, exactly like the other Direct/Remote identity boundaries.
  return id as Parameters<SchedulePort['view']>[0]['id']
}

function messageId(id: string): NonNullable<Parameters<SchedulePort['history']>[0]['before']> {
  // The cursor came from the Host page itself (the previous `nextBefore`).
  return id as NonNullable<Parameters<SchedulePort['history']>[0]['before']>
}

/** The refusal copy of one edit result, or `undefined` for a committed value. */
function editRefusal(result: ScheduleEditResult): string | undefined {
  // A committed entry (`kind`) and a completed deletion (`deleted`) carry no
  // refusal code; only the two official non-mutating refusals do.
  if (!('code' in result)) return undefined
  return result.code === 'schedule_conflict' ? SCHEDULE_COPY.conflict : SCHEDULE_COPY.taskGone
}

/**
 * The permission refusal the Host itself can PROVE. The installed Gateway's
 * public code union names exactly one: `gateway/interactions-forbidden`. An
 * HTTP 401/403 transport rejection reaches the Client as an unproven transport
 * failure (`gateway/internal`-shaped), so a WRITE keeps the conservative
 * "outcome unknown" wording instead of claiming a permission verdict the
 * Client cannot establish.
 */
function isPermissionCode(code: string | undefined): boolean {
  return code === 'gateway/interactions-forbidden'
}

function errorNotice(text: string): ScheduleNotice {
  return { text, kind: 'error' }
}

function infoNotice(text: string): ScheduleNotice {
  return { text, kind: 'info' }
}

/** Re-exported for the composition/tests: the draft target type the panel
 *  encodes through the same form module. */
export type { ScheduleTargetDraft }
