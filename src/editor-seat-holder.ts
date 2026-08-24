/**
 * The EditorSeatHolder (M9, plan §14.2): owns WHICH editor occupies the
 * seat and performs the ATOMIC handoff between editors. The host default
 * editor is the fallback; a plugin editor (single-winner from the M9
 * EditorRegistry) can replace it.
 *
 * Atomic handoff (plan §14.2):
 * ```text
 * create next editor
 *   → creation success
 *   → transfer draft/cursor
 *   → mount next
 *   → transfer focus
 *   → dispose old
 * ```
 * - creation THROWS → the current editor keeps working (nothing was
 *   transferred or mounted);
 * - winner unload → the next winner / host default is restored, with the
 *   draft PRESERVED;
 * - the seat never executes submission/session logic — the host owns
 *   every invariant (plan §14.3).
 * @module @xmoon76/dsh-pi-tui/editor-seat-holder
 */

import type { Component } from '@xmoon76/pi-tui'
import type { EditorHost, EditorSnapshot, ExtensionEditor } from './extension/public-types.ts'
import { compileView } from './extension/internal/component-compiler.ts'

function safeEditorErrorMessage(error: unknown): string {
  try {
    return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return 'unknown editor error'
  }
}

/** The seat's occupant surface the host drives. */
interface HostLease {
  readonly seatGeneration: number
  active: boolean
}

interface ChangeSubscription {
  readonly listener: (snapshot: EditorSnapshot) => void
  readonly lease: HostLease
}

export interface SeatEditor {
  readonly id: 'host' | string
  getText(): string
  setText(text: string): void
  getCursor(): number
  setCursor(offset: number): void
  /**
   * Insert text at the cursor (the image-placeholder insertion path). A
   * plugin editor without cursor insertion leaves this absent and the
   * caller falls back to append-at-end.
   */
  insertTextAtCursor?(text: string): void
  readonly focused: boolean
  borderColor: (text: string) => string
  invalidate(): void
  addToHistory(text: string): void
  clearHistory(): void
  readonly component: Component
  /** Whether the occupant's autocomplete dropdown is open (the host
   * editor always answers; a plugin editor may not have one). The host
   * escape branch passes Esc through while it is open so the editor can
   * close it (kimi parity). */
  isShowingAutocomplete?(): boolean
  /** The occupant's editor input mode (the host editor always answers; a
   * plugin editor has no mode — absent means prompt semantics). */
  getInputMode?(): import('./editor-input-mode.ts').EditorInputMode
  /** P1-5: the occupant's input channel — a PLUGIN editor with a
   * handleInput hook receives routed SEMANTIC events here (the host has
   * already decoded the terminal protocol — legacy/CSI-u/modifyOtherKeys
   * encodings, bracketed paste, key release/repeat filtering); the host
   * default has no hook (the fork Editor is the focused component
   * itself). */
  handleInput?(event: import('./extension/public-types.ts').EditorInputEvent): boolean
  dispose(): void
}

/** A host-editor adapter (the fork Editor + history/autocomplete). */
export interface HostEditorAdapter {
  getText(): string
  setText(text: string): void
  /** Whether the host editor's autocomplete dropdown is open. */
  isShowingAutocomplete?(): boolean
  /** The host editor's current input mode (shell-mode serialization). */
  getInputMode?(): import('./editor-input-mode.ts').EditorInputMode
  getCursor?(): number
  /** Best-effort cursor setter for the host editor. */
  setCursor?(offset: number): void
  /** Insert text at the host editor's cursor (image placeholder path). */
  insertTextAtCursor?(text: string): void
  /** Stage replacement text/cursor without resetting host transient state. */
  setTextAndCursor(text: string, cursor: number): void
  /** Forward one declined replacement-editor key through the host editor. */
  handleInput?(data: string): void
  /** Temporarily suppress the host adapter's normal change callback. */
  runWithoutChange?<T>(task: () => T): T
  readonly focused: boolean
  borderColor: (text: string) => string
  invalidate(): void
  addToHistory(text: string): void
  clearHistory(): void
  readonly component: Component
}

/** The handoff target for a plugin editor. */
export interface PluginEditorTarget {
  readonly id: string
  create(host: EditorHost): ExtensionEditor
  dispose?(): void
}

/** The host actions a plugin editor may dispatch (executed by the host —
 * never by the seat). */
export interface SeatActionSink {
  (action: 'submit' | 'queue-submit' | 'steer' | 'open-external-editor'): boolean
}

/** The host's view-swap callback: the seat re-mounts a newly compiled
 * plugin view (round-2 P1 — a live plugin editor view must be recompiled
 * on invalidate, never a compile-time snapshot). */
export type SeatViewSwap = (component: Component) => void

/**
 * The editor seat holder. One instance per TuiApp. The host drives the
 * CURRENT occupant through the {@link SeatEditor} surface; the holder
 * performs handoffs when the winner changes.
 */
export class EditorSeatHolder {
  /** The current occupant (always defined — the host default is the
   * fallback, never removed). */
  private current: SeatEditor
  /** Monotonic seat-owner epoch. Every handoff invalidates capabilities
   * captured by the previous occupant, even when the surface generation is
   * unchanged. */
  private seatGeneration = 0
  /** The lease belonging to the current plugin occupant, if any. */
  private currentHostLease: HostLease | undefined
  /** Lease exposed while the winner's create() callback is constructing it;
   * subscriptions made during create() are valid once the handoff commits. */
  private creatingHostLease: HostLease | undefined
  /** P1-12: the holder's FINAL disposal latch — after it flips, every
   * host capability captured by a plugin editor (replaceText, dispatch,
   * subscribe, invalidate) is INERT: a late plugin callback can no
   * longer mutate the seat or dispatch a real submission. */
  private disposed = false
  /** The id + registry REVISION of the LAST target whose creation threw
   * (round-1: the failure notify triggers a render → reconcile →
   * re-create → re-throw loop; the guard makes a failed target inert
   * UNTIL the registry changes — a same-id re-registration bumps the
   * revision, so the guard clears and the new editor is tried again). */
  private failedTarget: { id: string; revision: number } | undefined
  /** User callbacks may synchronously request another reconcile. */
  private handoffInProgress = false
  private pendingHandoff: { target: PluginEditorTarget | undefined; registryRevision: number } | undefined
  private readonly hostAdapter: () => HostEditorAdapter
  private readonly surfaceId: string
  private readonly generation: () => number
  private readonly actionSink: SeatActionSink
  private readonly notifyError: (message: string) => void
  /** Runner-owned health callback for editor create/input failures. */
  private readonly recordError: ((id: string, message: string) => void) | undefined
  private readonly clearError: ((id: string) => void) | undefined
  /** The host's view-swap callback (re-mounts a recompiled plugin view). */
  private readonly viewSwap: SeatViewSwap

  constructor(options: {
    hostAdapter: () => HostEditorAdapter
    surfaceId: string
    generation: () => number
    actionSink: SeatActionSink
    notifyError: (message: string) => void
    recordError?: (id: string, message: string) => void
    clearError?: (id: string) => void
    viewSwap: SeatViewSwap
  }) {
    this.hostAdapter = options.hostAdapter
    this.surfaceId = options.surfaceId
    this.generation = options.generation
    this.actionSink = options.actionSink
    this.notifyError = options.notifyError
    this.recordError = options.recordError
    this.clearError = options.clearError
    this.viewSwap = options.viewSwap
    this.current = this.adaptHost()
  }

  /** Report an editor contribution failure without allowing diagnostic hooks
   * to escape into the host's handoff or input path. */
  private reportEditorError(id: string, error: unknown): void {
    const message = safeEditorErrorMessage(error)
    try { this.recordError?.(id, message) } catch {}
    try { this.notifyError(message) } catch {}
  }

  /** Report a host-adapter failure without attributing it to a plugin. */
  private reportHostError(error: unknown): void {
    const message = safeEditorErrorMessage(error)
    try { this.notifyError(message) } catch {}
  }

  private clearEditorError(id: string): void {
    try { this.clearError?.(id) } catch {}
  }

  /** Invalidate one seat-owner lease and remove only its subscriptions. */
  private invalidateLease(lease: HostLease): void {
    lease.active = false
    for (const subscription of [...this.changeListeners]) {
      if (subscription.lease === lease) this.changeListeners.delete(subscription)
    }
  }

  /** Dispose an editor that was created but never committed to the seat. */
  private discardCreatedEditor(id: string, editor: ExtensionEditor, lease: HostLease): void {
    try {
      editor.dispose()
    } catch (error) {
      this.reportEditorError(id, error)
    }
    this.invalidateLease(lease)
    if (this.creatingHostLease === lease) this.creatingHostLease = undefined
  }

  /** The host default editor adapted to the seat surface. */
  private adaptHost(): SeatEditor {
    const editor = this.hostAdapter()
    const seat: SeatEditor = {
      id: 'host',
      getText: () => editor.getText(),
      setText: (text) => editor.setText(text),
      isShowingAutocomplete: () => editor.isShowingAutocomplete?.() ?? false,
      getInputMode: () => editor.getInputMode?.() ?? 'prompt',
      getCursor: () => editor.getCursor?.() ?? 0,
      setCursor: (offset) => editor.setCursor?.(offset),
      insertTextAtCursor: (text) => editor.insertTextAtCursor?.(text),
      get focused() { return editor.focused },
      borderColor: (text) => editor.borderColor(text),
      invalidate: () => editor.invalidate(),
      addToHistory: (text) => editor.addToHistory(text),
      clearHistory: () => editor.clearHistory(),
      component: editor.component,
      dispose: () => {},
    }
    return seat
  }

  /** The current occupant. */
  currentEditor(): SeatEditor {
    return this.current
  }

  /** The current seat snapshot (Phase 2: the ADVANCED editor controls
   * read the seat through this — same shape as the EditorHost contract). */
  snapshot(): EditorSnapshot {
    return this.snapshotOf(this.current.id === 'host' ? '' : this.current.id)
  }

  /**
   * Perform the atomic handoff to a new winner. Called by the host when
   * the editor registry's winner changed. Creation runs FIRST — a throw
   * keeps the current editor working (nothing transferred). On success:
   * transfer draft/cursor → mount → focus → dispose the old editor.
   * @param target - the new winner (undefined = restore the host default).
   */
  handoff(target: PluginEditorTarget | undefined, registryRevision = 0): void {
    if (this.disposed) return
    if (this.handoffInProgress) {
      this.pendingHandoff = { target, registryRevision }
      return
    }
    this.handoffInProgress = true
    try {
      this.performHandoff(target, registryRevision)
    } finally {
      this.handoffInProgress = false
      const pending = this.pendingHandoff
      this.pendingHandoff = undefined
      if (pending !== undefined && !this.disposed) this.handoff(pending.target, pending.registryRevision)
    }
  }

  private performHandoff(target: PluginEditorTarget | undefined, registryRevision: number): void {
    const previous = this.current
    // A target whose creation failed is INERT while the registry is
    // UNCHANGED (its notify triggered a render → reconcile → re-create
    // loop otherwise). A same-id re-registration bumps the revision →
    // the guard clears and the new editor is tried again.
    if (target !== undefined && this.failedTarget !== undefined
      && target.id === this.failedTarget.id && registryRevision === this.failedTarget.revision) return
    if (target === undefined || target.id === 'host') {
      this.failedTarget = undefined
      // Restore the host default, preserving the draft. Construct and stage
      // the replacement host BEFORE disposing the current occupant: if the
      // host adapter ever fails to initialize or restore, the current seat
      // remains available and the handoff stays atomic.
      let host: SeatEditor
      try {
        const draft = previous.getText()
        const cursor = previous.getCursor()
        host = this.adaptHost()
        host.setText(draft)
        // Restore both draft and cursor through the host adapter. Older
        // structural adapters may still implement setCursor as a no-op, but
        // the vendored fork's adapter preserves the active cursor as well.
        host.setCursor(cursor)
      } catch (error) {
        this.reportHostError(error)
        return
      }
      // Commit the staged host before calling user-owned dispose(). This
      // fences the old host capability first and leaves a valid seat even if
      // the old editor's teardown throws or re-enters through its old host.
      if (this.currentHostLease !== undefined) this.invalidateLease(this.currentHostLease)
      this.currentHostLease = undefined
      this.current = host
      ++this.seatGeneration
      try {
        previous.dispose()
      } catch (error) {
        // Teardown is user-owned and must not break restoration of the host
        // seat; the host is already the selected occupant.
        this.reportHostError(error)
      }
      return
    }
    // Atomic: create BEFORE any transfer (a throw keeps the current
    // editor working — plan §14.2).
    let created: ExtensionEditor
    const lease: HostLease = { seatGeneration: this.seatGeneration + 1, active: true }
    this.creatingHostLease = lease
    try {
      created = target.create(this.hostFor(target.id, lease))
      if (this.disposed || !lease.active || this.creatingHostLease !== lease) {
        this.discardCreatedEditor(target.id, created, lease)
        return
      }
      this.failedTarget = undefined
      try {
        this.clearEditorError(target.id)
      } catch {
        // Health callbacks are observational and must not abort a successful
        // editor creation.
      }
    } catch (error) {
      this.invalidateLease(lease)
      this.creatingHostLease = undefined
      this.failedTarget = { id: target.id, revision: registryRevision }
      this.reportEditorError(target.id, error)
      return
    }
    this.creatingHostLease = undefined
    if (this.disposed || !lease.active) {
      this.discardCreatedEditor(target.id, created, lease)
      return
    }
    // Transfer draft/cursor — INSIDE the guarded block (P2-02): a
    // throwing setText/setCursor must dispose the newly created editor
    // and keep the current one working (the atomic handoff promise
    // extends to EVERY post-create step, never a leak).
    try {
      if (this.disposed || !lease.active) throw new Error('editor seat disposed during handoff')
      const draft = previous.getText()
      const cursor = previous.getCursor()
      created.setText(draft)
      created.setCursor?.(cursor)
    } catch (error) {
      try {
        created.dispose()
      } catch (disposeError) {
        this.reportEditorError(target.id, disposeError)
      }
      this.invalidateLease(lease)
      this.failedTarget = { id: target.id, revision: registryRevision }
      this.reportEditorError(target.id, error)
      return
    }
    // Compile the plugin component BEFORE disposing the old editor
    // (round-2 finding 3): adaptPlugin's compileView can throw — a broken
    // view must keep the OLD editor working, exactly like a creation
    // throw. Nothing is disposed until every throwing step succeeded.
    let adapted: SeatEditor
    try {
      if (this.disposed || !lease.active) throw new Error('editor seat disposed during handoff')
      adapted = this.adaptPlugin(target.id, created)
    } catch (error) {
      // P2-02: the transfer succeeded but the compile failed — dispose the
      // created editor (it never mounted), keep the current one working.
      try {
        created.dispose()
      } catch (disposeError) {
        this.reportEditorError(target.id, disposeError)
      }
      this.invalidateLease(lease)
      this.failedTarget = { id: target.id, revision: registryRevision }
      this.reportEditorError(target.id, error)
      return
    }
    // Mount + dispose old (atomic: everything succeeded). A throwing old
    // dispose is reported but cannot leave the new editor unowned.
    if (this.disposed || !lease.active) {
      this.discardCreatedEditor(target.id, created, lease)
      return
    }
    lease.active = true
    if (this.currentHostLease !== undefined) this.invalidateLease(this.currentHostLease)
    this.current = adapted
    this.currentHostLease = lease
    ++this.seatGeneration
    // The creating lease becomes the committed seat owner only here; any
    // create-time subscriptions retained their lease and now receive changes.
    try {
      previous.dispose()
    } catch (error) {
      this.reportEditorError(previous.id, error)
    }
  }

  /** Build the EditorHost handed to a plugin editor. */
  private hostFor(replacementId: string, lease: HostLease): EditorHost {
    const holder = this
    const hostGeneration = this.generation()
    const inertSnapshot: EditorSnapshot = {
      text: '',
      cursor: 0,
      focused: false,
      replacementId: undefined,
      composing: false,
    }
    // During create(), the old seat is still committed. The new host may
    // register a listener so it becomes live after commit, but all seat
    // observations/mutations remain inert until this lease is committed.
    const live = (): boolean => !holder.disposed
      && lease.active
      && holder.generation() === hostGeneration
      && holder.currentHostLease === lease
    const canSubscribe = (): boolean => !holder.disposed
      && lease.active
      && holder.generation() === hostGeneration
      && (holder.currentHostLease === lease || holder.creatingHostLease === lease)
    return {
      surfaceId: this.surfaceId,
      generation: hostGeneration,
      // A stale or not-yet-committed host must not inspect or disclose the
      // current seat. Return a fixed inert snapshot rather than falling
      // through to the previous occupant.
      getSnapshot: () => live() ? holder.snapshotOf(replacementId) : inertSnapshot,
      replaceText: (text, cursor) => {
        if (!live()) return
        holder.current.setText(text)
        if (cursor !== undefined) holder.current.setCursor(cursor)
        holder.notifyChanged()
      },
      dispatch: (action) => {
        if (!live()) return { kind: 'ignored' }
        const accepted = holder.actionSink(action)
        return accepted ? { kind: 'accepted' } : { kind: 'ignored' }
      },
      subscribe: (listener) => canSubscribe() ? holder.subscribe(listener, lease) : () => {},
      invalidate: () => {
        if (!live()) return
        holder.current.invalidate()
      },
    }
  }

  /** Adapt a plugin editor to the seat surface. The component is compiled
   * FRESH on every invalidate (round-2 P1): the M4 compiler caches the
   * styled content at construction, so a plugin view that changed its
   * state must be recompiled + re-mounted to repaint — the seat's
   * invalidate() does exactly that through the host's view-swap. */
  private adaptPlugin(id: string, editor: ExtensionEditor): SeatEditor {
    const holder = this
    let component = this.compileView(editor.component)
    return {
      id,
      getText: () => editor.getText(),
      setText: (text) => editor.setText(text),
      getCursor: () => editor.getCursor?.() ?? 0,
      setCursor: (offset) => editor.setCursor?.(offset),
      get focused() { return editor.focused ?? false },
      borderColor: editor.borderColor ?? ((value: string) => value),
      invalidate: () => {
        // Recompile the CURRENT view + swap it into the seat (the host's
        // viewSwap re-mounts the child without a handoff). ISOLATED like
        // the handoff (round-3 finding 1 + round-4 follow-up 2): BOTH the
        // compile AND the swap are guarded — a throw must NOT escape into
        // the host input/render path; the current component stays, the
        // error is reported, and no swap happens.
        let next: Component
        try {
          next = holder.compileView(editor.component)
          holder.viewSwap(next)
        } catch (error) {
          holder.reportEditorError(id, error)
          return
        }
        holder.clearEditorError(id)
        component = next
      },
      addToHistory: () => {}, // the host default owns history recall
      clearHistory: () => {},
      // P1-5: the plugin editor's input channel — the host's routeInput
      // delivers every editor-routed event here as a SEMANTIC event (the
      // host decoded the terminal protocol); consume=true stops the event
      // (the plugin owns it), false/undefined lets the host default
      // editor handle it.
      handleInput: editor.handleInput === undefined
        ? undefined
        : (event) => {
            if (holder.disposed) return true
            try {
              const consumed = editor.handleInput!(event)
              if (consumed) {
                holder.clearEditorError(id)
                holder.current.invalidate()
              }
              return consumed
            } catch (error) {
              holder.reportEditorError(id, error)
              return true // a throwing plugin input handler never crashes the host
            }
          },
      // A GETTER (round-2 P1): invalidate() recompiles the view; the
      // seat's component always reflects the CURRENT compiled view.
      get component() { return component },
      dispose: () => editor.dispose(),
    }
  }

  /** Compile the plugin's ExtensionView into a mountable component. */
  private compileView(view: import('./extension/public-types.ts').ExtensionView): Component {
    return compileView(view).component
  }

  /**
   * Forward one key to the hidden host editor and synchronize its resulting
   * text/cursor back into the visible replacement. This is the host fallback
   * promised by ExtensionEditor.handleInput returning false; doing it here
   * keeps all pi-tui editing semantics (graphemes, paste, history and
   * autocomplete) in the vendored Editor instead of reimplementing them in
   * the consumer.
   */
  handleHostFallbackInput(data: string): boolean {
    const current = this.current
    if (current.id === 'host') return false
    const reportError = (error: unknown): void => {
      this.reportEditorError(current.id, error)
    }
    try {
      const host = this.hostAdapter()
      if (host.handleInput === undefined) return false
      const text = current.getText()
      const cursor = current.getCursor()
      const run = <T>(task: () => T): T => {
        if (host.runWithoutChange !== undefined) return host.runWithoutChange(task)
        return task()
      }
      run(() => {
        host.setTextAndCursor(text, cursor)
        host.handleInput!(data)
        const nextText = host.getText()
        const nextCursor = host.getCursor?.() ?? 0
        current.setText(nextText)
        current.setCursor(nextCursor)
      })
      // The host adapter may invoke the normal host onChange for a mutation,
      // and the fallback itself is also a seat mutation. The host callback is
      // suppressed above; emit exactly one final snapshot here.
      this.notifyChanged()
      current.invalidate()
      this.clearEditorError(current.id)
    } catch (error) {
      reportError(error)
      // A throwing replacement fallback must consume the event and leave the
      // seat in a coherent state; never let plugin-owned code escape the host
      // input dispatcher.
    }
    return true
  }

  /** The current snapshot (the EditorHost contract). */
  private snapshotOf(replacementId: string): EditorSnapshot {
    return {
      text: this.current.getText(),
      cursor: this.current.getCursor(),
      focused: this.current.focused,
      replacementId: this.current.id === 'host' ? undefined : replacementId,
      composing: false,
    }
  }

  /** Subscribe to snapshot changes (poll-free: the host notifies on
   * change; the holder forwards through a change counter). The listener
   * is bound to the CREATING host's generation (P1-12): a stale host's
   * subscription stops delivering once the surface moved on — and a
   * disposed holder clears every listener (P1-11 delivery ends). */
  private subscribe(
    listener: (snapshot: EditorSnapshot) => void,
    lease: HostLease,
  ): () => void {
    if (this.disposed || !lease.active) return () => {}
    const subscription: ChangeSubscription = { listener, lease }
    this.changeListeners.add(subscription)
    return () => {
      this.changeListeners.delete(subscription)
    }
  }

  /** Change listeners (host-driven notifications). */
  private readonly changeListeners = new Set<ChangeSubscription>()

  /** The host calls this after every editor mutation; listeners fire
   * with the CURRENT snapshot (bounded — the fork's editor onChange). */
  notifyChanged(): void {
    if (this.disposed) return
    const replacementId = this.current.id === 'host' ? undefined : this.current.id
    const snapshot = this.snapshotOf(replacementId ?? '')
    // P2-02: per-listener isolation — a throwing plugin listener must
    // never abort the delivery to the remaining listeners (or escape into
    // the host's editor mutation path).
    for (const subscription of [...this.changeListeners]) {
      if (!subscription.lease.active || subscription.lease !== this.currentHostLease) {
        this.changeListeners.delete(subscription)
        continue
      }
      try {
        subscription.listener(snapshot)
      } catch {
        // A hostile listener is dropped (it cannot keep poisoning the
        // channel); the host's own paths never see its throw.
        this.changeListeners.delete(subscription)
      }
    }
  }

  /** P1-12: FINAL disposal of the holder — every captured host capability
   * becomes inert and every listener stops delivering. Called by TuiApp
   * from its own dispose() (the surface's final teardown). */
  dispose(): void {
    this.disposed = true
    this.pendingHandoff = undefined
    if (this.currentHostLease !== undefined) this.invalidateLease(this.currentHostLease)
    if (this.creatingHostLease !== undefined) this.invalidateLease(this.creatingHostLease)
    this.currentHostLease = undefined
    this.creatingHostLease = undefined
    this.changeListeners.clear()
  }
}
