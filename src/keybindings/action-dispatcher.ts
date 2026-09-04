/**
 * The AppActionDispatcher (plan §9): the semantic routing layer between a
 * resolved action and the Host's business methods.
 *
 * ```text
 * the resolver decides what the input MEANS
 * the dispatcher decides how it EXECUTES
 * ```
 *
 * The dispatcher NEVER re-implements business state — it calls the Host
 * methods (submitDraft, steerDraft, …) which already own the guards. A
 * host method returns `true` when it consumed the key, `false` when the
 * key must fall through (e.g. pasteMedia without a clipboard handler).
 * @module @xmoon76/dsh-pi-tui/keybindings/action-dispatcher
 */

import type { KeyId } from '@xmoon76/pi-tui'
import type { AppKeybindingId } from './types.ts'

/** The Host business surface the dispatcher routes to. Every method
 * returns whether the key was consumed (false lets the input fall through
 * to the editor/plugin stages). */
export interface AppActionHost {
  /** Submit the draft (forceQueue = the Ctrl+Enter parity). */
  submitDraft(forceQueue?: boolean): boolean
  /** Steer the running agent with the draft. */
  steerDraft(): boolean
  /** Pull queued input back into the editor. */
  dequeueDraft(): boolean
  /** Interrupt the current activity (the Esc path). */
  interruptActivity(): boolean
  /** Request TUI exit for the resolved effective key. */
  requestExit(key: KeyId): boolean
  /** Open the transcript search overlay. */
  openTranscriptSearch(): boolean
  /** Return the transcript presentation to the live tail. */
  jumpLatest(): boolean
  /** Close the transcript search overlay. */
  closeTranscriptSearch(): boolean
  /** Jump to the next search match. */
  searchNext(): boolean
  /** Jump to the previous search match. */
  searchPrevious(): boolean
  /** Toggle the transcript/tool expansion master switch. */
  toggleTranscriptExpand(): boolean
  /** Toggle thinking visibility. */
  toggleThinking(): boolean
  /** Toggle fullscreen mode. */
  toggleFullscreen(): boolean
  /** Toggle the todo panel. */
  toggleTodo(): boolean
  /** Cycle the permission preset. */
  cyclePermission(): boolean
  /** Open the external editor with the current draft. */
  openExternalEditor(): boolean
  /** Paste media from the clipboard (false = no handler, fall through). */
  pasteMedia(): boolean
  /** Open the task browser. */
  openTasks(): boolean
  /** Open the input-history search panel. */
  openHistorySearch(): boolean
  /** Dismiss settled local shell cards. */
  dismissSettledShell(): boolean
}

/** The semantic action → Host method router. */
export class AppActionDispatcher {
  private readonly host: AppActionHost

  constructor(host: AppActionHost) {
    this.host = host
  }

  /** Dispatch one resolved action. Returns whether the key was consumed.
   * @param action - the resolved semantic action.
   * @param key - the effective key that resolved. Exit confirmation owns
   *   same-key semantics at the TuiApp ingress; an absent key is invalid. */
  dispatch(action: AppKeybindingId, key?: KeyId): boolean {
    switch (action) {
      case 'app.input.submit':
        return this.host.submitDraft(false)
      case 'app.input.queue':
        return this.host.submitDraft(true)
      case 'app.input.steer':
        return this.host.steerDraft()
      case 'app.input.dequeue':
        return this.host.dequeueDraft()
      case 'app.agent.interrupt':
        return this.host.interruptActivity()
      case 'app.exit.request':
        // Never fabricate a key for a key-sensitive exit request. The host
        // ingress treats an absent identity as consumed but non-exiting.
        if (key === undefined) return true
        return this.host.requestExit(key)
      case 'app.transcript.search':
        return this.host.openTranscriptSearch()
      case 'app.transcript.jumpLatest':
        return this.host.jumpLatest()
      case 'app.transcript.search.next':
        return this.host.searchNext()
      case 'app.transcript.search.previous':
        return this.host.searchPrevious()
      case 'app.transcript.search.close':
        return this.host.closeTranscriptSearch()
      case 'app.transcript.toggleExpand':
        return this.host.toggleTranscriptExpand()
      case 'app.transcript.toggleThinking':
        return this.host.toggleThinking()
      case 'app.transcript.toggleFullscreen':
        return this.host.toggleFullscreen()
      case 'app.todo.toggle':
        return this.host.toggleTodo()
      case 'app.permission.cycle':
        return this.host.cyclePermission()
      case 'app.editor.external':
        return this.host.openExternalEditor()
      case 'app.clipboard.pasteMedia':
        return this.host.pasteMedia()
      case 'app.tasks.open':
        return this.host.openTasks()
      case 'app.history.search':
        return this.host.openHistorySearch()
      case 'app.shell.dismissSettled':
        return this.host.dismissSettledShell()
      // Reserved session/model actions have no host wiring yet (plan §3.2):
      // resolving one is a no-op (the key is consumed — the user bound it
      // deliberately, and a silent fall-through would be surprising).
      case 'app.session.open':
      case 'app.session.new':
      case 'app.session.resume':
      case 'app.model.open':
        return true
      // Focused-component actions never reach the HOST dispatcher (their
      // components own them); a stray resolution is a no-op.
      case 'question.confirm':
      case 'question.cancel':
      case 'question.previous':
      case 'question.next':
      case 'question.cursorUp':
      case 'question.cursorDown':
      case 'question.pageUp':
      case 'question.pageDown':
      case 'question.toggleExpand':
      case 'tasks.open':
      case 'tasks.search.enter':
      case 'tasks.search.exit':
      case 'tasks.scope.toggle':
      case 'tasks.type.next':
      case 'tasks.tree.expand':
      case 'tasks.tree.collapse':
      case 'tasks.running.next':
      case 'tasks.running.previous':
      case 'tasks.stop':
      case 'tasks.view.full':
      case 'tasks.refresh':
      case 'tasks.confirm':
      case 'tasks.cancel':
      case 'tasks.cursorUp':
      case 'tasks.cursorDown':
      case 'tasks.pageUp':
      case 'tasks.pageDown':
      case 'tasks.cycleType':
      case 'tasks.interrupt':
        return true
    }
  }
}
