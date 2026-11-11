/**
 * Node construction for the native TSP Queue manager sheet (PR-Q).
 *
 * Pure: the application-level controller's view DTO in, the native `ui` tree
 * out. Every interactive node binds ONE presenter intent (or an `action` id
 * carrying the frame revision), so a pointer and a key land on the same
 * admission point. The renderer paints no PiTui frame and no ASCII box here —
 * the client's own `picker`/`overlay`/`editor`/`button` vocabulary is the whole
 * presentation.
 *
 * @module @xmoon76/dsh-pi-tui/tui/tsp/queue-manager-view
 */

import { ui, type Node, type PickerAction, type PickerItem } from '@stencil-hq/tern'
import { QUEUE_CHORDS } from '../keybindings/hints.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { attachmentCountLabel, type QueueManagerRow, type QueueManagerView } from '../../app/queue/manager.ts'

/** One intent the sheet's nodes can raise. */
export type QueueManagerIntent =
  | { readonly kind: 'select'; readonly id: string }
  | { readonly kind: 'activate'; readonly id: string }
  | { readonly kind: 'edit' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'save' }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'close' }

/** The bindings one frame's nodes consume. */
export interface QueueLayerDeps {
  readonly serial: number
  /** The frame revision: action ids carry it, so a retired frame's event is
   *  never accepted. */
  readonly revision: number
  /** Bind one direct intent to THIS frame. */
  readonly bind: (intent: QueueManagerIntent) => () => void
  /** Build one revision-bound picker action id. */
  readonly actionId: (base: 'edit' | 'delete' | 'close') => string
  /** The controlled editor state for the Edit page (absent outside it). */
  readonly editor: { readonly text: string; readonly cursor: number } | undefined
}

/** The ONE visible row of the native picker (value = Host occurrence id). */
function rowItem(row: QueueManagerRow): PickerItem {
  const badge = attachmentCountLabel(row.fileCount, row.imageCount)
  return {
    id: row.id,
    label: singleLine(row.text),
    ...(row.attachments.length === 0 ? {} : { detail: singleLine(row.attachments.join(' · ')) }),
    ...(badge === undefined ? {} : { badges: [{ text: badge }] }),
    // A non-text occurrence stays selectable (Delete must remain reachable);
    // the reason is stated in words, never by colour alone.
    ...(row.textOnly ? {} : { disabled: 'Contains attachments · Editing unavailable' }),
  }
}

/** The Browse picker: the queue list plus the native action bar. */
function browseLayer(view: QueueManagerView, deps: QueueLayerDeps): Node {
  const selected = view.selected
  const canEdit = selected !== undefined && selected.textOnly
  const noSelection = selected === undefined
  const actions: PickerAction[] = [
    {
      id: deps.actionId('edit'),
      label: 'Edit',
      keys: [QUEUE_CHORDS.edit.label],
      ...(canEdit
        ? {}
        : { disabled: noSelection ? 'Select a queued message' : 'Contains attachments · Editing unavailable' }),
    },
    {
      id: deps.actionId('delete'),
      label: 'Delete',
      keys: [QUEUE_CHORDS.remove.label],
      danger: true,
      ...(noSelection ? { disabled: 'Select a queued message' } : {}),
    },
    { id: deps.actionId('close'), label: 'Close', keys: [QUEUE_CHORDS.cancel.label], end: true },
  ]
  return ui.picker({
    key: `queue-picker-${deps.serial}`,
    size: 'lg',
    layout: 'rows',
    preview: 'none',
    title: 'Queue',
    subtitle: `${view.count} queued`,
    state: 'ready',
    total: view.count,
    items: view.rows.map(rowItem),
    // ALWAYS send `selected` (empty = no cursor): omitting the prop in a later
    // frame would leave the client's previous highlight alive.
    selected: view.selectedId ?? '',
    actions,
    empty: view.list === 'no-session'
      ? 'No active session'
      : view.list === 'unavailable'
        ? 'Queue unavailable'
        : 'No queued messages',
    ...(view.notice === undefined ? {} : { message: singleLine(view.notice.text) }),
  })
}

/** The Edit page: ONE native modal overlay with the controlled editor. */
function editLayer(view: QueueManagerView, deps: QueueLayerDeps): Node {
  const safeDraft = sanitizeDisplayText(view.draft ?? '')
  const editor = deps.editor ?? { text: safeDraft, cursor: safeDraft.length }
  return ui.overlay(
    {
      key: `queue-edit-${deps.serial}`,
      head: 'Edit queued message',
      size: 'lg',
      modal: true,
    },
    ui.col(
      { key: `queue-edit-body-${deps.serial}` },
      ...(view.notice === undefined ? [] : [ui.text({ key: `queue-edit-notice-${deps.serial}`, text: singleLine(view.notice.text) })]),
      ui.editor({
        key: `queue-edit-input-${deps.serial}`,
        text: editor.text,
        cursor: editor.cursor,
        maxLines: 8,
      }),
      ui.row(
        { key: `queue-edit-actions-${deps.serial}`, justify: 'between' },
        ui.button({
          key: `queue-edit-save-${deps.serial}`,
          text: 'Save',
          variant: 'primary',
          keys: [QUEUE_CHORDS.save.label],
          onClick: deps.bind({ kind: 'save' }),
        }),
        ui.button({
          key: `queue-edit-cancel-${deps.serial}`,
          text: 'Cancel',
          keys: [QUEUE_CHORDS.cancel.label],
          onClick: deps.bind({ kind: 'cancel' }),
        }),
      ),
    ),
  )
}

/** The Delete confirmation page: native text + explicit Confirm/Cancel. */
function confirmLayer(view: QueueManagerView, deps: QueueLayerDeps): Node {
  const row = view.selected
  return ui.overlay(
    {
      key: `queue-delete-${deps.serial}`,
      head: 'Delete queued message',
      size: 'lg',
      modal: true,
    },
    ui.col(
      { key: `queue-delete-body-${deps.serial}` },
      ...(row === undefined ? [] : [ui.text({ key: `queue-delete-text-${deps.serial}`, text: singleLine(row.text) })]),
      ...(row === undefined || row.attachments.length === 0
        ? []
        : [ui.text({ key: `queue-delete-files-${deps.serial}`, text: singleLine(row.attachments.join(' · ')) })]),
      ui.text({
        key: `queue-delete-warning-${deps.serial}`,
        text: 'This queued message cannot be restored after deletion.',
      }),
      ...(view.notice === undefined ? [] : [ui.text({ key: `queue-delete-notice-${deps.serial}`, text: singleLine(view.notice.text) })]),
      ui.row(
        { key: `queue-delete-actions-${deps.serial}`, justify: 'between' },
        ui.button({
          key: `queue-delete-confirm-${deps.serial}`,
          text: 'Confirm',
          variant: 'danger',
          keys: [QUEUE_CHORDS.edit.label],
          onClick: deps.bind({ kind: 'confirm' }),
        }),
        ui.button({
          key: `queue-delete-cancel-${deps.serial}`,
          text: 'Cancel',
          keys: [QUEUE_CHORDS.cancel.label],
          onClick: deps.bind({ kind: 'cancel' }),
        }),
      ),
    ),
  )
}

/** Build the ONE layer node for the controller's current mode. The `layer`
 *  region root is a `ui.col` (the verified shape): the picker/overlay is its
 *  child, never the region root itself. */
export function queueManagerLayer(view: QueueManagerView, deps: QueueLayerDeps): Node | undefined {
  const body = view.mode === 'closed'
    ? undefined
    : view.mode === 'browse'
      ? browseLayer(view, deps)
      : view.mode === 'edit'
        ? editLayer(view, deps)
        : confirmLayer(view, deps)
  return body === undefined
    ? undefined
    : ui.col({ key: `queue-layer-${deps.serial}` }, body)
}

/** One line's display projection (no control bytes, no line break). */
function singleLine(text: string): string {
  return sanitizeDisplayText(text).replace(/\s+/gu, ' ').trim()
}
