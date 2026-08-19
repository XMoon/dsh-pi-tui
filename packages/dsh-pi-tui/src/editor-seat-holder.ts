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

/** The seat's occupant surface the host drives. */
export interface SeatEditor {
  readonly id: 'host' | string
  getText(): string
  setText(text: string): void
  getCursor(): number
  setCursor(offset: number): void
  readonly focused: boolean
  borderColor: (text: string) => string
  invalidate(): void
  addToHistory(text: string): void
  clearHistory(): void
  readonly component: Component
  dispose(): void
}

/** A host-editor adapter (the fork Editor + history/autocomplete). */
export interface HostEditorAdapter {
  getText(): string
  setText(text: string): void
  getCursor?(): number
  /** Best-effort: the fork editor has no public cursor setter — the seat
   * treats an absent setter as a no-op (the plugin editor contract still
   * transfers cursors through ExtensionEditor.setCursor). */
  setCursor?(offset: number): void
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
  /** The id + registry REVISION of the LAST target whose creation threw
   * (round-1: the failure notify triggers a render → reconcile →
   * re-create → re-throw loop; the guard makes a failed target inert
   * UNTIL the registry changes — a same-id re-registration bumps the
   * revision, so the guard clears and the new editor is tried again). */
  private failedTarget: { id: string; revision: number } | undefined
  private readonly hostAdapter: () => HostEditorAdapter
  private readonly surfaceId: string
  private readonly generation: () => number
  private readonly actionSink: SeatActionSink
  private readonly notifyError: (message: string) => void
  /** The host's view-swap callback (re-mounts a recompiled plugin view). */
  private readonly viewSwap: SeatViewSwap

  constructor(options: {
    hostAdapter: () => HostEditorAdapter
    surfaceId: string
    generation: () => number
    actionSink: SeatActionSink
    notifyError: (message: string) => void
    viewSwap: SeatViewSwap
  }) {
    this.hostAdapter = options.hostAdapter
    this.surfaceId = options.surfaceId
    this.generation = options.generation
    this.actionSink = options.actionSink
    this.notifyError = options.notifyError
    this.viewSwap = options.viewSwap
    this.current = this.adaptHost()
  }

  /** The host default editor adapted to the seat surface. */
  private adaptHost(): SeatEditor {
    const editor = this.hostAdapter()
    const seat: SeatEditor = {
      id: 'host',
      getText: () => editor.getText(),
      setText: (text) => editor.setText(text),
      getCursor: () => editor.getCursor?.() ?? 0,
      setCursor: (offset) => editor.setCursor?.(offset),
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

  /**
   * Perform the atomic handoff to a new winner. Called by the host when
   * the editor registry's winner changed. Creation runs FIRST — a throw
   * keeps the current editor working (nothing transferred). On success:
   * transfer draft/cursor → mount → focus → dispose the old editor.
   * @param target - the new winner (undefined = restore the host default).
   */
  handoff(target: PluginEditorTarget | undefined, registryRevision = 0): void {
    const previous = this.current
    // A target whose creation failed is INERT while the registry is
    // UNCHANGED (its notify triggered a render → reconcile → re-create
    // loop otherwise). A same-id re-registration bumps the revision →
    // the guard clears and the new editor is tried again.
    if (target !== undefined && this.failedTarget !== undefined
      && target.id === this.failedTarget.id && registryRevision === this.failedTarget.revision) return
    if (target === undefined || target.id === 'host') {
      this.failedTarget = undefined
      // Restore the host default, preserving the draft.
      const draft = previous.getText()
      const cursor = previous.getCursor()
      previous.dispose()
      const host = this.adaptHost()
      host.setText(draft)
      // CURSOR RESTORE IS BEST-EFFORT (round-1 finding 6): the vendored
      // fork's Editor exposes no public cursor setter, so the host
      // adapter's setCursor is a documented no-op — the draft survives
      // the unload handoff, the cursor lands at the fork's default
      // position. This is an explicit SDK contract limit (a plugin
      // editor's OWN cursor transfers through ExtensionEditor.setCursor;
      // only the host-default restore is best-effort).
      host.setCursor(cursor)
      this.current = host
      return
    }
    // Atomic: create BEFORE any transfer (a throw keeps the current
    // editor working — plan §14.2).
    let created: ExtensionEditor
    try {
      created = target.create(this.hostFor(target.id))
      this.failedTarget = undefined
    } catch (error) {
      this.failedTarget = { id: target.id, revision: registryRevision }
      this.notifyError(error instanceof Error ? error.message : String(error))
      return
    }
    // Transfer draft/cursor.
    const draft = previous.getText()
    const cursor = previous.getCursor()
    created.setText(draft)
    created.setCursor?.(cursor)
    // Compile the plugin component BEFORE disposing the old editor
    // (round-2 finding 3): adaptPlugin's compileView can throw — a broken
    // view must keep the OLD editor working, exactly like a creation
    // throw. Nothing is disposed until every throwing step succeeded.
    let adapted: SeatEditor
    try {
      adapted = this.adaptPlugin(target.id, created)
    } catch (error) {
      this.failedTarget = { id: target.id, revision: registryRevision }
      this.notifyError(error instanceof Error ? error.message : String(error))
      return
    }
    // Mount + dispose old (atomic: everything succeeded).
    previous.dispose()
    this.current = adapted
  }

  /** Build the EditorHost handed to a plugin editor. */
  private hostFor(replacementId: string): EditorHost {
    const holder = this
    return {
      surfaceId: this.surfaceId,
      generation: this.generation(),
      getSnapshot: () => holder.snapshotOf(replacementId),
      replaceText: (text, cursor) => {
        holder.current.setText(text)
        if (cursor !== undefined) holder.current.setCursor(cursor)
      },
      dispatch: (action) => {
        const accepted = holder.actionSink(action)
        return accepted ? { kind: 'accepted' } : { kind: 'ignored' }
      },
      subscribe: (listener) => holder.subscribe(listener, replacementId),
      invalidate: () => holder.current.invalidate(),
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
        // the handoff (round-3 finding 1): a compile throw must NOT
        // escape into the host input/render path — the current component
        // stays, the error is reported, and no swap happens.
        let next: Component
        try {
          next = holder.compileView(editor.component)
        } catch (error) {
          holder.notifyError(error instanceof Error ? error.message : String(error))
          return
        }
        component = next
        holder.viewSwap(component)
      },
      addToHistory: () => {}, // the host default owns history recall
      clearHistory: () => {},
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
   * change; the holder forwards through a change counter). */
  private subscribe(listener: (snapshot: EditorSnapshot) => void, replacementId: string): () => void {
    // The host drives the editor; the subscription delivers on every
    // host-driven change (the host calls notifyChanged()).
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  /** Change listeners (host-driven notifications). */
  private readonly changeListeners = new Set<(snapshot: EditorSnapshot) => void>()

  /** The host calls this after every editor mutation; listeners fire
   * with the CURRENT snapshot (bounded — the fork's editor onChange). */
  notifyChanged(): void {
    const replacementId = this.current.id === 'host' ? undefined : this.current.id
    const snapshot = this.snapshotOf(replacementId ?? '')
    for (const listener of this.changeListeners) listener(snapshot)
  }
}
