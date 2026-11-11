/**
 * The Queue manager controller (PR-Q): the ONE application-level owner of the
 * per-occurrence queue surface, shared by the PiTui Wide Overlay and the TSP
 * native Queue sheet.
 *
 * What it owns:
 * - the short-lived PANEL state (`closed | browse | edit | confirm-delete`),
 *   the selected Host occurrence id and the local edit draft;
 * - the ONE admission rule for editing (the Host occurrence's RAW content must
 *   be text-only — never the display summary, never a `📄` marker in a text
 *   block);
 * - the ONE write shape: `SessionWriter.updateQueue(exactSessionId,
 *   exactOccurrenceId, {kind:'edit'|'remove'})` inside the existing
 *   `withWriter` admission, guarded by the captured owner token + live scope
 *   and settled with the existing {@link WriteOutcome} vocabulary.
 *
 * What it does NOT own: the Host queue itself (that is the
 * `PendingInputReader` projection), the pending presentation join, the
 * composer, any renderer object, any Host service and any file system. It
 * keeps no durable queue mirror: a browse view re-reads the reader on every
 * render, and a write re-validates the exact occurrence immediately before it
 * is sent. The panel's selected id, edit draft and confirmation are UI-local
 * and never a second source of Host truth.
 *
 * @module @xmoon76/dsh-pi-tui/app/queue/manager
 */

import type { PendingInputItem, PendingInputReader } from '../../runtime/pending-input-reader-port.ts'
import type { SessionWriter, WriteOutcome } from '../../runtime/session-writer-port.ts'
import { SessionScopeSupersededError, type LiveSessionScope } from '../session/scope.ts'
import { TransitionInProgressError } from '../session/operation-barrier.ts'
import { formatBytes } from '../../domain/media/format.ts'

/** The queue panel's state machine. */
export type QueueManagerMode = 'closed' | 'browse' | 'edit' | 'confirm-delete'

/** Why the browse list has no rows (never collapsed into "0 queued"). */
export type QueueManagerListState = 'ready' | 'no-session' | 'unavailable'

/** One Host-accepted queued occurrence, projected for the panel. */
export interface QueueManagerRow {
  /** The Host occurrence id — the ONLY write target identity. */
  readonly id: string
  /** The occurrence's text blocks, joined for display (single-line projection
   * happens in the renderer). */
  readonly text: string
  /** Whether EVERY raw content block is text (the edit admission fact). */
  readonly textOnly: boolean
  /** Display summaries of the occurrence's non-text attachments. */
  readonly attachments: readonly string[]
  readonly fileCount: number
  readonly imageCount: number
}

/** One notice the panel paints (info or a failed operation). */
export interface QueueManagerNotice {
  readonly text: string
  readonly kind: 'info' | 'error'
}

/** The panel's read-only presentation DTO. */
export interface QueueManagerView {
  readonly mode: QueueManagerMode
  readonly list: QueueManagerListState
  readonly rows: readonly QueueManagerRow[]
  /** The Host occurrence count (authoritative rows only). */
  readonly count: number
  readonly selectedId: string | undefined
  readonly selected: QueueManagerRow | undefined
  /** The local edit draft (edit mode only). */
  readonly draft: string | undefined
  /** A write is in flight; every mutation intent is refused while true. */
  readonly pending: boolean
  readonly notice: QueueManagerNotice | undefined
}

/** The renderer-side presentation sink. Exactly ONE surface is mounted. */
export interface QueueManagerPresentation {
  /** The controller's state changed: mount/repaint/close the panel from
   * `controller.view()`. Called synchronously after every committed intent. */
  present(): void
  /** The mounted surface is going away: close any panel and drop local state. */
  retire(): void
}

/** The controller's narrow injected dependencies (composition-owned). */
export interface QueueManagerDeps {
  /** The ONE Host pending-input read projection. */
  readonly reader: PendingInputReader
  /** The ONE semantic session writer. */
  readonly writer: SessionWriter
  /** The current main Session id, or undefined while sessionless. */
  readonly captureSessionId: () => string | undefined
  /** Capture the owner-subject identity token synchronously. */
  readonly captureSubject: () => unknown
  /** Whether a captured owner token is still the current owner. */
  readonly isSubjectCurrent: (token: unknown) => boolean
  /** Capture the live writer scope synchronously (undefined while sessionless). */
  readonly captureScope: () => LiveSessionScope | undefined
  /** Whether a captured scope is still current. */
  readonly isScopeCurrent: (scope: LiveSessionScope) => boolean
  /** A subagent viewer is read-only: never mutate a hidden parent queue. */
  readonly isViewing: () => boolean
  /** `SessionRuntime.withWriter`: the scope-bound writer admission. */
  readonly withWriter: <T>(scope: LiveSessionScope, task: () => Promise<T>) => Promise<T>
  /** The accepted business-write lifetime of this queue mutation. */
  readonly beginClientWrite: () => () => void
  /** Owned-task entry (no bare fire-and-forget promise). */
  readonly runOwned: (label: string, task: () => Promise<void>) => void
  /** Re-read the Host queue projection after a confirmed mutation. */
  readonly refreshPendingInput: () => void
  /** The renderer-neutral notice sink for a refused intent. */
  readonly notify: (message: string, kind: 'info' | 'error') => void
  /** The occurrence's display text projection (text verbatim, image/file
   * markers for the summary). */
  readonly textOf: (content: readonly unknown[]) => string
}

/** One raw content block as this controller reads it (structural only). */
type RawBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment?: { readonly name?: string } }
  | { readonly type: 'file'; readonly attachment?: { readonly name?: string; readonly bytes?: number } }
  | { readonly type: string }

const CLOSED_VIEW: QueueManagerView = {
  mode: 'closed',
  list: 'no-session',
  rows: [],
  count: 0,
  selectedId: undefined,
  selected: undefined,
  draft: undefined,
  pending: false,
  notice: undefined,
}

/**
 * The ONE queue manager. Constructed once by the composition root; the mounted
 * renderer attaches its presentation at mount and detaches it at teardown.
 */
export class QueueManagerController {
  private readonly deps: QueueManagerDeps
  private presentation: QueueManagerPresentation | undefined
  private mode: QueueManagerMode = 'closed'
  private sessionId: string | undefined
  private subject: unknown = undefined
  private selectedId: string | undefined
  private lastIndex = 0
  private draft = ''
  private originalText = ''
  private notice: QueueManagerNotice | undefined
  private pending = false
  /** The last read failure (distinguishes "unavailable" from an empty queue). */
  private listState: QueueManagerListState = 'no-session'
  /** Monotonic write token: a superseded settle never overwrites a newer panel. */
  private writeToken = 0
  /** A Dock preselection that vanished suppresses the browse fallback until the
   *  user explicitly selects a live row: a stale id must never silently become
   *  the first row's edit/delete target. */
  private selectionSuppressed = false

  constructor(deps: QueueManagerDeps) {
    this.deps = deps
  }

  /** Attach the mounted renderer's presentation. A second attach replaces the
   * previous one (the previous surface is gone). */
  attach(presentation: QueueManagerPresentation): void {
    if (this.presentation !== undefined && this.presentation !== presentation) {
      this.presentation.retire()
    }
    this.presentation = presentation
  }

  /** Detach ONE presentation (idempotent; a newer surface is never detached by
   * a late teardown of the previous one). */
  detach(presentation: QueueManagerPresentation): void {
    if (this.presentation !== presentation) return
    this.presentation = undefined
    this.reset()
  }

  /** Whether the manager is open (browse/edit/confirm). */
  isOpen(): boolean {
    return this.mode !== 'closed'
  }

  /**
   * Open the manager. `initialItemId` is a Dock-row preselection: it is only a
   * hint and must still be a CURRENT authoritative `queued` occurrence; an id
   * that disappeared opens Browse without selecting a row and states why.
   */
  open(options: { readonly initialItemId?: string } = {}): { readonly opened: boolean; readonly message?: string } {
    if (this.deps.isViewing()) {
      const message = 'Queue management is unavailable in a subagent viewer'
      this.deps.notify(message, 'info')
      return { opened: false, message }
    }
    if (this.presentation === undefined) {
      const message = 'Queue management is unavailable on this renderer'
      this.deps.notify(message, 'error')
      return { opened: false, message }
    }
    // A repeated KEYBOARD/Manage open on a live panel is a toggle-close in
    // every renderer: the SAME entry opened the panel, so it must also close
    // it. A Dock ROW click (a concrete preselection id) never closes the open
    // manager: it moves the Browse selection to that live occurrence, so a
    // pointer can never discard an open edit/confirmation accidentally.
    if (this.mode !== 'closed') {
      if (options.initialItemId === undefined) {
        this.close()
        return { opened: true }
      }
      if (this.mode === 'browse') {
        const rows = this.readRows()
        if (rows.some(row => row.id === options.initialItemId)) {
          this.select(options.initialItemId)
        } else {
          // The clicked occurrence vanished while the sheet was open. Keeping
          // the previous highlight would let the next Enter/D act on an
          // occurrence the user did not click, so the selection is dropped.
          this.selectedId = undefined
          this.lastIndex = 0
          this.selectionSuppressed = true
          this.notice = { text: 'This message is no longer queued', kind: 'info' }
          this.changed()
        }
      }
      return { opened: true }
    }
    this.reset()
    this.mode = 'browse'
    this.sessionId = this.deps.captureSessionId()
    this.subject = this.deps.captureSubject()
    const rows = this.readRows()
    const initial = options.initialItemId
    if (initial !== undefined && !rows.some(row => row.id === initial)) {
      // The clicked occurrence disappeared before the panel read it. Browse
      // opens with NO selection: the first/next live row is a different
      // occurrence and must never inherit the stale click's edit/delete target.
      this.selectedId = undefined
      this.lastIndex = 0
      this.selectionSuppressed = true
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
    } else {
      this.selectedId = initial ?? rows[0]?.id
      this.lastIndex = Math.max(0, rows.findIndex(row => row.id === this.selectedId))
    }
    this.changed()
    return { opened: true }
  }

  /** Close the panel, dropping the local draft and confirmation. An in-flight
   * write still settles (it may already have reached the Host); its result
   * never reopens the panel or notifies a newer Session. */
  close(): void {
    if (this.mode === 'closed') return
    this.reset()
    this.changed()
  }

  /** Retire the panel when the captured Session owner is no longer current.
   * Called at the surface's presentation commit points (session switch, viewer
   * enter/exit, cold rehydrate). */
  retireIfStale(): void {
    if (this.mode === 'closed') return
    if (this.deps.captureSessionId() === this.sessionId
      && this.deps.isSubjectCurrent(this.subject)) return
    this.close()
  }

  /**
   * The panel's read DTO. Browse re-reads the ONE Host projection on every
   * call (no local queue mirror); edit/confirm keep the captured target and
   * draft while still re-validating the session owner. A selection whose id
   * disappeared moves to the row that now occupies the same position (then
   * the previous row) — a stale id is never re-pointed at a live occurrence
   * for an already-started operation.
   */
  view(): QueueManagerView {
    if (this.mode === 'closed') return CLOSED_VIEW
    if (this.deps.captureSessionId() !== this.sessionId || !this.deps.isSubjectCurrent(this.subject)) {
      // The owner moved while the panel was open: retire internally. The
      // renderer's own next presentation commit closes the physical panel.
      this.reset()
      return CLOSED_VIEW
    }
    const rows = this.readRows()
    if (this.mode === 'browse') {
      if (this.selectionSuppressed) {
        // A lost preselection stays unselected until the user picks a live row
        // or one of the other browse fallbacks below applies to a REAL
        // selection that disappeared while the panel was open.
        this.selectedId = undefined
      } else if (this.selectedId === undefined || !rows.some(row => row.id === this.selectedId)) {
        if (rows.length > 0) {
          const next = Math.min(Math.max(0, this.lastIndex), rows.length - 1)
          this.selectedId = rows[next]!.id
          this.lastIndex = next
        } else {
          this.selectedId = undefined
        }
      } else {
        this.lastIndex = rows.findIndex(row => row.id === this.selectedId)
      }
    }
    const selected = this.selectedId === undefined
      ? undefined
      : rows.find(row => row.id === this.selectedId)
    return {
      mode: this.mode,
      list: this.listState,
      rows,
      count: rows.length,
      selectedId: this.selectedId,
      selected,
      draft: this.mode === 'edit' ? this.draft : undefined,
      pending: this.pending,
      notice: this.notice,
    }
  }

  /** Select one Host occurrence (keyboard navigation or a row click). */
  select(id: string): void {
    if (this.mode !== 'browse' || this.pending) return
    const rows = this.readRows()
    const index = rows.findIndex(row => row.id === id)
    if (index === -1) {
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
      this.changed()
      return
    }
    this.selectedId = id
    this.lastIndex = index
    this.selectionSuppressed = false
    this.notice = undefined
    this.changed()
  }

  /**
   * Enter the edit page for one occurrence. Editing is admitted by the
   * occurrence's RAW content: only an all-text occurrence may be edited. An
   * attachment-bearing occurrence stays selectable and deletable and states
   * why it cannot be edited.
   */
  startEdit(id?: string): void {
    if (this.mode !== 'browse' || this.pending) return
    const targetId = id ?? this.selectedId
    if (targetId === undefined) {
      this.notice = { text: 'Select a queued message', kind: 'info' }
      this.changed()
      return
    }
    const rows = this.readRows()
    const row = rows.find(candidate => candidate.id === targetId)
    if (row === undefined) {
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
      this.changed()
      return
    }
    if (!row.textOnly) {
      this.selectedId = row.id
      this.notice = { text: 'Contains attachments · Editing unavailable', kind: 'info' }
      this.changed()
      return
    }
    this.selectedId = row.id
    this.lastIndex = rows.indexOf(row)
    this.selectionSuppressed = false
    this.originalText = this.rawTextOf(row.id)
    this.draft = this.originalText
    this.notice = undefined
    this.mode = 'edit'
    this.changed()
  }

  /** Replace the local edit draft (never a Host write). */
  setDraft(text: string): void {
    if (this.mode !== 'edit' || this.pending) return
    this.draft = text
    this.changed()
  }

  /** Save the local draft as the occurrence's new text through the official
   * `edit` mutation. */
  save(): void {
    if (this.mode !== 'edit' || this.pending) return
    if (this.draft.trim() === '') {
      this.notice = { text: 'A queued message must contain non-whitespace text', kind: 'error' }
      this.changed()
      return
    }
    const id = this.selectedId
    if (id === undefined) {
      this.mode = 'browse'
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
      this.changed()
      return
    }
    const scope = this.deps.captureScope()
    if (scope === undefined) {
      this.notice = { text: 'Queue management requires a live session', kind: 'error' }
      this.changed()
      return
    }
    const capturedSession = this.sessionId
    if (capturedSession === undefined) {
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
      this.mode = 'browse'
      this.changed()
      return
    }
    const capturedSubject = this.subject
    const capturedText = this.draft
    const originalText = this.originalText
    const token = ++this.writeToken
    this.pending = true
    this.notice = undefined
    this.changed()
    const endWrite = this.deps.beginClientWrite()
    this.deps.runOwned('queue edit', async () => {
      let outcome: WriteOutcome | undefined
      try {
        outcome = await this.deps.withWriter(scope, async () => {
          // The exact owner/scope fence after the barrier, BEFORE the write.
          if (!this.deps.isSubjectCurrent(capturedSubject) || !this.deps.isScopeCurrent(scope)) {
            throw new SessionScopeSupersededError()
          }
          const current = this.deps.reader.snapshot(capturedSession)
          const item = current?.items.find(candidate => candidate.id === id && candidate.placement === 'queued')
          if (item === undefined) {
            return { kind: 'rejected', error: { code: 'session/queue-item-not-found', message: 'this message is no longer queued' } }
          }
          if (!isTextOnly(item.content)) {
            return { kind: 'rejected', error: { code: 'session/attachment-invalid', message: 'this message contains attachments' } }
          }
          if (textOfContent(item.content) !== originalText) {
            return { kind: 'rejected', error: { code: 'session/queue-item-changed', message: 'this message changed while it was being edited' } }
          }
          return this.deps.writer.updateQueue(capturedSession, id, {
            kind: 'edit',
            content: [{ type: 'text', text: capturedText }],
          })
        })
      } catch (error) {
        if (this.writeToken !== token) return
        this.pending = false
        if (error instanceof SessionScopeSupersededError) {
          // The captured owner is gone: release local state silently, never
          // notify the replacement Session.
          this.reset()
          this.changed()
          return
        }
        if (error instanceof TransitionInProgressError) {
          this.notice = { text: 'A session transition is in progress — try again in a moment', kind: 'info' }
          this.changed()
          return
        }
        this.notice = { text: `Could not update the queued message: ${errorMessage(error)}`, kind: 'error' }
        this.changed()
        return
      } finally {
        endWrite()
      }
      if (this.writeToken !== token) {
        // The panel lease was closed/replaced while the write was in flight.
        // The Host may still have committed, so the shared projection is
        // refreshed; the retired panel is never repainted or reopened.
        if (outcome?.kind === 'committed') this.deps.refreshPendingInput()
        return
      }
      this.pending = false
      if (outcome === undefined) return
      if (outcome.kind === 'committed') {
        if (this.deps.captureSessionId() === capturedSession && this.deps.isSubjectCurrent(capturedSubject)) {
          this.mode = 'browse'
          this.originalText = ''
          this.draft = ''
          this.notice = undefined
          this.deps.refreshPendingInput()
        } else {
          this.reset()
        }
        this.changed()
        return
      }
      this.notice = { text: settlementNotice('update', outcome), kind: 'error' }
      this.changed()
    })
  }

  /** Enter the delete-confirmation page for one occurrence. */
  startDelete(id?: string): void {
    if (this.mode !== 'browse' || this.pending) return
    const targetId = id ?? this.selectedId
    if (targetId === undefined) {
      this.notice = { text: 'Select a queued message', kind: 'info' }
      this.changed()
      return
    }
    const rows = this.readRows()
    const row = rows.find(candidate => candidate.id === targetId)
    if (row === undefined) {
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
      this.changed()
      return
    }
    this.selectedId = row.id
    this.lastIndex = rows.indexOf(row)
    this.selectionSuppressed = false
    this.notice = undefined
    this.mode = 'confirm-delete'
    this.changed()
  }

  /** Confirm the delete: ONE official `remove` mutation for the exact id. */
  confirmDelete(): void {
    if (this.mode !== 'confirm-delete' || this.pending) return
    const id = this.selectedId
    if (id === undefined) {
      this.mode = 'browse'
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
      this.changed()
      return
    }
    const scope = this.deps.captureScope()
    if (scope === undefined) {
      this.notice = { text: 'Queue management requires a live session', kind: 'error' }
      this.changed()
      return
    }
    const capturedSession = this.sessionId
    if (capturedSession === undefined) {
      this.notice = { text: 'This message is no longer queued', kind: 'info' }
      this.mode = 'browse'
      this.changed()
      return
    }
    const capturedSubject = this.subject
    const capturedIndex = this.lastIndex
    const token = ++this.writeToken
    this.pending = true
    this.notice = undefined
    this.changed()
    const endWrite = this.deps.beginClientWrite()
    this.deps.runOwned('queue remove', async () => {
      let outcome: WriteOutcome | undefined
      let disappeared = false
      try {
        outcome = await this.deps.withWriter(scope, async () => {
          if (!this.deps.isSubjectCurrent(capturedSubject) || !this.deps.isScopeCurrent(scope)) {
            throw new SessionScopeSupersededError()
          }
          const current = this.deps.reader.snapshot(capturedSession)
          const item = current?.items.find(candidate => candidate.id === id && candidate.placement === 'queued')
          if (item === undefined) {
            disappeared = true
            return { kind: 'rejected', error: { code: 'session/queue-item-not-found', message: 'this message is no longer queued' } }
          }
          return this.deps.writer.updateQueue(capturedSession, id, { kind: 'remove' })
        })
      } catch (error) {
        if (this.writeToken !== token) return
        this.pending = false
        if (error instanceof SessionScopeSupersededError) {
          this.reset()
          this.changed()
          return
        }
        if (error instanceof TransitionInProgressError) {
          this.notice = { text: 'A session transition is in progress — try again in a moment', kind: 'info' }
          this.changed()
          return
        }
        this.notice = { text: `Could not delete the queued message: ${errorMessage(error)}`, kind: 'error' }
        this.changed()
        return
      } finally {
        endWrite()
      }
      if (this.writeToken !== token) {
        if (outcome?.kind === 'committed') this.deps.refreshPendingInput()
        return
      }
      this.pending = false
      if (outcome === undefined) return
      if (outcome.kind === 'committed') {
        if (this.deps.captureSessionId() === capturedSession && this.deps.isSubjectCurrent(capturedSubject)) {
          this.mode = 'browse'
          this.selectedId = undefined
          this.lastIndex = capturedIndex
          this.notice = undefined
          this.deps.refreshPendingInput()
        } else {
          this.reset()
        }
        this.changed()
        return
      }
      if (disappeared) {
        this.mode = 'browse'
        this.selectedId = undefined
        this.notice = { text: 'This message is no longer queued', kind: 'info' }
        this.deps.refreshPendingInput()
        this.changed()
        return
      }
      this.notice = { text: settlementNotice('delete', outcome), kind: 'error' }
      this.changed()
    })
  }

  /** Back out ONE level: Edit/Confirm → Browse (dropping the local draft), and
   * Browse → closed. Never sends a Host request. */
  cancelBack(): void {
    if (this.mode === 'edit' || this.mode === 'confirm-delete') {
      this.mode = 'browse'
      this.draft = ''
      this.originalText = ''
      this.notice = undefined
      this.changed()
      return
    }
    if (this.mode === 'browse') this.close()
  }

  /** The notice shown in the current view. */
  notify(message: string, kind: 'info' | 'error' = 'info'): void {
    if (this.mode === 'closed') return
    this.notice = { text: message, kind }
    this.changed()
  }

  private changed(): void {
    this.presentation?.present()
  }

  private reset(): void {
    // A closed/replaced panel lease invalidates every in-flight write's UI
    // settlement: the Host write may still commit, but its result must never
    // repaint or reopen a panel the user has already left.
    this.writeToken += 1
    this.selectionSuppressed = false
    this.mode = 'closed'
    this.sessionId = undefined
    this.subject = undefined
    this.selectedId = undefined
    this.lastIndex = 0
    this.draft = ''
    this.originalText = ''
    this.notice = undefined
    this.pending = false
    this.listState = 'no-session'
  }

  /** Read the authoritative queued occurrences. `undefined` from the reader is
   * "unavailable", never an empty queue. */
  private readRows(): readonly QueueManagerRow[] {
    if (this.sessionId === undefined) {
      this.listState = 'no-session'
      return []
    }
    const snapshot = this.deps.reader.snapshot(this.sessionId)
    if (snapshot === undefined) {
      this.listState = 'unavailable'
      return []
    }
    this.listState = 'ready'
    const rows: QueueManagerRow[] = []
    for (const item of snapshot.items) {
      if (item.placement !== 'queued') continue
      rows.push(rowOf(item, this.deps.textOf))
    }
    return rows
  }

  /** The occurrence's editable raw text (text blocks joined with '' — the
   * official dsh-web `textOf()` projection). */
  private rawTextOf(id: string): string {
    if (this.sessionId === undefined) return ''
    const item = this.deps.reader.snapshot(this.sessionId)?.items
      .find(candidate => candidate.id === id && candidate.placement === 'queued')
    return item === undefined ? '' : textOfContent(item.content)
  }
}

/** Whether every raw content block is text (the edit admission fact). */
function isTextOnly(content: readonly unknown[]): boolean {
  if (content.length === 0) return false
  return content.every(raw => (raw as RawBlock).type === 'text' && typeof (raw as { text?: unknown }).text === 'string')
}

/** The official `textOf()` projection: every text block joined with ''. */
function textOfContent(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const raw of content) {
    const block = raw as RawBlock
    if (block.type === 'text') parts.push((block as { text: string }).text)
  }
  return parts.join('')
}

/** Project one Host occurrence for the panel. */
function rowOf(item: PendingInputItem, textOf: (content: readonly unknown[]) => string): QueueManagerRow {
  const attachments: string[] = []
  let fileCount = 0
  let imageCount = 0
  for (const raw of item.content) {
    const block = raw as RawBlock
    if (block.type === 'file') {
      fileCount += 1
      const attachment = (block as { attachment?: { name?: string; bytes?: number } }).attachment
      attachments.push(attachment?.name === undefined ? 'file' : attachment.bytes === undefined
        ? attachment.name
        : `${attachment.name} · ${formatBytes(attachment.bytes)}`)
    } else if (block.type === 'image') {
      imageCount += 1
      const attachment = (block as { attachment?: { name?: string } }).attachment
      attachments.push(attachment?.name === undefined ? 'image' : `🖼️ ${attachment.name}`)
    }
  }
  return {
    id: item.id,
    text: textOf(item.content),
    textOnly: isTextOnly(item.content),
    attachments,
    fileCount,
    imageCount,
  }
}

/** One human notice for a non-committed settlement (never a false success). */
function settlementNotice(verb: 'update' | 'delete', outcome: WriteOutcome): string {
  switch (outcome.kind) {
    case 'rejected':
      return `Could not ${verb} the queued message: ${outcome.error.message}`
    case 'cancelled':
      return `The queue ${verb} was cancelled`
    case 'indeterminate':
      return `The queue ${verb} result is unknown — check the queue before retrying`
    case 'unsupported':
      return `The queue ${verb} is not supported: ${outcome.reason}`
    case 'committed':
      return ''
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
