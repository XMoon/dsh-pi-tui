/**
 * The native TSP Queue manager presenter (PR-Q).
 *
 * It owns ONE panel's local admission (serial, frame revision, editor focus)
 * and NOTHING else: the application-level {@link QueueManagerController} owns
 * every read and every Host write, exactly like the PiTui panel's controller.
 * The presenter renders the controller's view into the native `layer` region,
 * routes the raw SDK key stream through the shared controller intents, and
 * admits pointer events only when the node id belongs to the CURRENT frame.
 *
 * `ui.overlay({modal:true})` masks the picture but does not capture the
 * keyboard; the session's `routeInput` seat order is the real modal boundary,
 * and this presenter is one more non-blocking seat in that ladder.
 *
 * @module @xmoon76/dsh-pi-tui/tui/tsp/queue-manager
 */

import { View, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import type { QueueManagerController, QueueManagerPresentation, QueueManagerView } from '../../app/queue/manager.ts'
import { createTspComposer, type TspComposer } from './editor.ts'
import { queueManagerLayer, type QueueManagerIntent } from './queue-manager-view.ts'

/** What the presenter needs from the mounted renderer. */
export interface TspQueueManagerDeps {
  readonly controller: QueueManagerController
  /** Commit one renderer frame. */
  render(): void
  /** Whether a key/pointer may act (not disposed, input bound, no modal seat). */
  canInteract(): boolean
  /** The raw-key match for the LIVE `app.queue.open` effective binding. */
  readonly queueOpenKeys: () => readonly string[]
  notify(message: string, kind?: 'info' | 'error'): void
}

/** One action id's frame token. */
const ACTION_TOKEN = '#'

export class TspQueueManager {
  private readonly deps: TspQueueManagerDeps
  private serial = 0
  private revision = 0
  private targets = new Map<string, number>()
  private editComposer: TspComposer | undefined
  private editId: string | undefined
  private editorId: string | undefined
  private lastOpen = false

  readonly presentation: QueueManagerPresentation = {
    present: () => this.present(),
    retire: () => this.retire(),
  }

  constructor(deps: TspQueueManagerDeps) {
    this.deps = deps
  }

  /** The live controller (the Dock's rows and the sheet share it). */
  get controller(): QueueManagerController {
    return this.deps.controller
  }

  isOpen(): boolean {
    return this.deps.controller.isOpen()
  }

  /** The controller changed: bump the frame revision, keep the local editor in
   * sync and commit one frame. */
  private present(): void {
    const view = this.deps.controller.view()
    const open = this.deps.controller.isOpen()
    if (open && !this.lastOpen) this.serial += 1
    this.lastOpen = open
    this.revision += 1
    if (view.mode === 'edit') this.syncEditor(view)
    else this.dismissEditor()
    this.deps.render()
  }

  /** The mounted surface is going away. */
  private retire(): void {
    this.dismissEditor()
    this.targets.clear()
    this.editorId = undefined
  }

  /** A display-subject commit: retire the sheet when its captured Session
   *  owner is gone, and repaint when that retirement closed it. */
  retireIfStale(): void {
    const wasOpen = this.isOpen()
    this.deps.controller.retireIfStale()
    if (wasOpen && !this.isOpen()) this.deps.render()
  }

  /** The surface's modal suspension: every node of the previous frame becomes
   *  inert (a stale click can never act after a modal took the seat). */
  suspend(): void {
    // No render() here: this is called FROM the frame commit, and a render
    // would recurse into the same suspension.
    this.revision += 1
    this.targets.clear()
  }

  /** The editor's wire id for the session's focus projection (Edit only). */
  desiredFocusId(): string | undefined {
    return this.deps.controller.view().mode === 'edit' ? this.editorId : undefined
  }

  /** The queue-open raw key (the SAME effective `app.queue.open` binding). */
  matchesOpenKey(key: Key): boolean {
    return this.deps.queueOpenKeys().some(chord => matchesChord(key, chord))
  }

  /** Open from the raw SDK key stream (Alt+I / a user remap). */
  openFromKey(): void {
    if (!this.deps.canInteract()) return
    if (this.isOpen()) {
      this.deps.controller.close()
      return
    }
    this.deps.controller.open()
  }

  /** A Dock row click: exact Host occurrence preselection. An already-open
   *  Browse sheet only moves its selection; a local echo (no id) never closes
   *  the open sheet. */
  openRow(id?: string): void {
    if (!this.deps.canInteract()) return
    if (this.deps.controller.isOpen()) {
      if (id !== undefined) this.deps.controller.select(id)
      return
    }
    this.deps.controller.open(id === undefined ? {} : { initialItemId: id })
  }

  /** A Dock `Manage` click: open Browse. */
  openManage(): void {
    if (!this.deps.canInteract()) return
    this.deps.controller.open()
  }

  /** TRUE when this presenter consumed the key (the composer must not see it). */
  handleKey(key: Key): boolean {
    const view = this.deps.controller.view()
    if (view.mode === 'closed') return false
    // Ctrl+C always belongs to the application cancel owner.
    if (key.ctrl === true && key.name === 'c') return false
    if (!this.deps.canInteract()) return true
    switch (view.mode) {
      case 'browse':
        return this.handleBrowseKey(view, key)
      case 'edit':
        return this.handleEditKey(view, key)
      case 'confirm-delete':
        return this.handleConfirmKey(key)
      default:
        return false
    }
  }

  private handleBrowseKey(view: QueueManagerView, key: Key): boolean {
    if (key.name === 'up' || key.name === 'down') {
      const delta = key.name === 'up' ? -1 : 1
      this.moveSelection(view, delta)
      return true
    }
    if (key.name === 'pageUp' || key.name === 'pageDown') {
      this.moveSelection(view, key.name === 'pageUp' ? -5 : 5)
      return true
    }
    if (key.name === 'escape' && !key.ctrl && !key.alt && !key.meta) {
      this.deps.controller.close()
      return true
    }
    if (key.name === 'enter' && !key.ctrl && !key.alt && !key.meta && !key.shift) {
      if (view.selectedId !== undefined) this.deps.controller.startEdit(view.selectedId)
      return true
    }
    if (key.name === 'd' && !key.ctrl && !key.alt && !key.meta && !key.shift) {
      this.deps.controller.startDelete()
      return true
    }
    // Every other key is consumed: the sheet owns the seat, and a stray
    // letter must never edit the background composer.
    return true
  }

  private handleEditKey(view: QueueManagerView, key: Key): boolean {
    if (key.name === 'escape' && !key.ctrl && !key.alt && !key.meta) {
      this.deps.controller.cancelBack()
      return true
    }
    if (key.ctrl === true && key.name === 's') {
      this.deps.controller.save()
      return true
    }
    const composer = this.editComposer
    if (composer === undefined) return true
    const edit = composer.applyKey(key)
    if (edit.kind === 'edited') this.deps.controller.setDraft(composer.state().text)
    void view
    return true
  }

  private handleConfirmKey(key: Key): boolean {
    if (key.name === 'escape' && !key.ctrl && !key.alt && !key.meta) {
      this.deps.controller.cancelBack()
      return true
    }
    if (key.name === 'enter' && !key.ctrl && !key.alt && !key.meta && !key.shift) {
      this.deps.controller.confirmDelete()
      return true
    }
    return true
  }

  private moveSelection(view: QueueManagerView, delta: number): void {
    if (view.rows.length === 0) return
    const current = view.rows.findIndex(row => row.id === view.selectedId)
    const index = Math.min(Math.max(0, (current === -1 ? 0 : current) + delta), view.rows.length - 1)
    this.deps.controller.select(view.rows[index]!.id)
  }

  /** Render the ONE layer node for the controller's current mode. */
  renderLayer(): Node | undefined {
    this.targets.clear()
    this.editorId = undefined
    const view = this.deps.controller.view()
    if (view.mode === 'closed') return undefined
    const revision = this.revision
    const layer = queueManagerLayer(view, {
      serial: this.serial,
      revision,
      editor: this.editComposer === undefined
        ? undefined
        : { text: this.editComposer.state().text, cursor: this.editComposer.state().cursor },
      actionId: base => `${base}${ACTION_TOKEN}${revision}`,
      bind: intent => () => this.act(intent, revision),
    })
    if (layer === undefined) return undefined
    const editorKey = `queue-edit-input-${this.serial}`
    // Index every node of THIS frame by wire id (the SDK-assigned id): a
    // select/activate event whose picker id is absent (a retired frame) is
    // never routed. The walk also resolves the editor's real wire id for the
    // focus projection.
    for (const root of View.from({ layer }).regions) {
      const visit = (node: typeof root): void => {
        if (node === undefined) return
        this.targets.set(node.id, revision)
        if (node.props['key'] === editorKey) this.editorId = node.id
        for (const child of node.children) visit(child)
      }
      visit(root)
    }
    return layer
  }

  /** Route one picker select/activate/action event through the frame gate. */
  handleEvent(event: TspEvent): boolean {
    if (event.ev !== 'select' && event.ev !== 'activate' && event.ev !== 'action') return false
    const id = 'id' in event && typeof event.id === 'string' ? event.id : undefined
    if (id === undefined) return false
    const revision = this.targets.get(id)
    if (revision === undefined || revision !== this.revision) return false
    const view = this.deps.controller.view()
    if (view.mode === 'closed' || !this.deps.canInteract()) return true
    if (event.ev === 'action') {
      const base = actionBase(event.act, this.revision)
      if (base === undefined) return false
      this.act({ kind: base === 'edit' ? 'edit' : base === 'delete' ? 'delete' : 'close' }, revision)
      return true
    }
    const item = event.item
    if (item === undefined) return true
    if (event.ev === 'select') this.act({ kind: 'select', id: item }, revision)
    else this.act({ kind: 'activate', id: item }, revision)
    return true
  }

  private act(intent: QueueManagerIntent, revision: number): void {
    if (!this.deps.canInteract() || revision !== this.revision) return
    const controller = this.deps.controller
    switch (intent.kind) {
      case 'select':
        controller.select(intent.id)
        return
      case 'activate':
        controller.startEdit(intent.id)
        return
      case 'edit':
        if (controller.view().selectedId !== undefined) controller.startEdit()
        return
      case 'delete':
        controller.startDelete()
        return
      case 'save':
        controller.save()
        return
      case 'confirm':
        controller.confirmDelete()
        return
      case 'cancel':
        if (controller.view().mode === 'browse') controller.close()
        else controller.cancelBack()
        return
      case 'close':
        controller.close()
        return
    }
  }

  private syncEditor(view: QueueManagerView): void {
    if (this.editComposer === undefined) {
      const composer = createTspComposer(
        {
          onChanged: () => { this.deps.render() },
          setSubmitPending: () => {},
          notify: (message, kind) => { this.deps.notify(message, kind) },
        },
        { entries: () => [], admitDraft: () => true },
        { enterInsertsNewline: true },
      )
      composer.setDraft(view.draft ?? '')
      this.editComposer = composer
      this.editId = view.selectedId
      return
    }
    if (this.editId !== view.selectedId) {
      // A different occurrence (or a re-opened editor): the local draft is the
      // controller's captured text, never the previous occurrence's buffer.
      this.editComposer.setDraft(view.draft ?? '')
      this.editId = view.selectedId
      return
    }
    if (this.editComposer.state().text !== (view.draft ?? '')) {
      // The controller refused a write and kept the SAME draft; only a real
      // divergence (a programmatic replacement) resets the composer.
      this.editComposer.setDraft(view.draft ?? '')
    }
  }

  private dismissEditor(): void {
    this.editComposer = undefined
    this.editId = undefined
    this.editorId = undefined
  }
}

/** The base of a revision-bound action id, or undefined for a stale token. */
function actionBase(act: string, revision: number): 'edit' | 'delete' | 'close' | undefined {
  const at = act.lastIndexOf(ACTION_TOKEN)
  if (at === -1) return undefined
  if (act.slice(at + 1) !== String(revision)) return undefined
  const base = act.slice(0, at)
  return base === 'edit' || base === 'delete' || base === 'close' ? base : undefined
}

/** The renderer's raw-key chord comparison (the model/visual precedent). */
function matchesChord(
  key: { readonly name: string; readonly ctrl?: boolean; readonly alt?: boolean; readonly shift?: boolean; readonly meta?: boolean },
  chord: string,
): boolean {
  const parts = chord.split('+')
  const base = parts[parts.length - 1] as string
  return key.name === base
    && (key.ctrl === true) === parts.includes('ctrl')
    && (key.alt === true) === parts.includes('alt')
    && (key.shift === true) === parts.includes('shift')
    && (key.meta === true) === parts.includes('super')
}
