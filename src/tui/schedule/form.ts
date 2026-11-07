/**
 * The Schedule editor's terminal field layout (S5-PR4): the labels, per-field
 * hints, chooser option lists and focus arithmetic the panel paints. All
 * encoding and validation stay in `domain/schedule/form.ts`; this module only
 * maps the domain field list onto terminal presentation and intents.
 *
 * @module @xmoon76/dsh-pi-tui/tui/schedule/form
 */

import {
  TARGET_LABELS,
  TIMING_LABELS,
  TARGET_KINDS,
  TIMING_KINDS,
  editorFields,
  type ScheduleEditorDraft,
  type ScheduleFormField,
} from '../../domain/schedule/form.ts'
import type { ScheduleIntent, ScheduleSessionChoice } from '../../app/schedule/presentation.ts'

/** One option painted by an in-panel editor chooser. */
export interface ScheduleEditorChoice {
  readonly label: string
  readonly value: string
}

/** The field label column shared by every editor row. */
export const EDITOR_LABEL_WIDTH = 18

/** The user-facing editor mode word. */
export function editorModeLabel(mode: ScheduleEditorDraft['mode']): string {
  return mode === 'create' ? 'Create' : 'Edit'
}

/**
 * The ONE hint of a field. A text field is typed into; a choice/weekday/toggle
 * field is activated with Enter (which opens the chooser or toggles in place).
 */
export function editorFieldHint(field: ScheduleFormField): string {
  switch (field.id) {
    case 'timing-kind':
      return 'Enter choose timing'
    case 'target-kind':
      return 'Enter choose target'
    case 'target-session':
      return 'Enter choose Session'
    case 'target-advanced':
      return 'Enter show/hide'
    default:
      if (field.kind === 'weekday') return 'Enter toggle day'
      return field.kind === 'text' ? 'Type to edit' : 'Enter change'
  }
}

/** Whether the focused field accepts typed text. */
export function isEditorTextInput(field: ScheduleFormField): boolean {
  return field.kind === 'text'
}

/** The ISO weekday (1–7) one weekday field toggles, or undefined. */
export function weekdayFromField(field: ScheduleFormField): number | undefined {
  if (field.kind !== 'weekday' || !field.id.startsWith('timing-weekday-')) return undefined
  const day = Number(field.id.slice('timing-weekday-'.length))
  return Number.isInteger(day) && day >= 1 && day <= 7 ? day : undefined
}

/** The current index of a stable field identity, or undefined when it left. */
export function fieldIndexById(
  fields: readonly ScheduleFormField[],
  fieldId: string,
): number | undefined {
  const index = fields.findIndex(field => field.id === fieldId)
  return index < 0 ? undefined : index
}

/**
 * The focus intent of one Tab/Shift+Tab step. A step inside the current field
 * list is `next-field`; a step PAST either end is `focus-field`, so the panel
 * never dispatches an out-of-range next-field.
 */
export function editorFocusIntent(draft: ScheduleEditorDraft, delta: number): ScheduleIntent {
  const fields = editorFields(draft)
  if (fields.length === 0) return { kind: 'focus-field', index: 0 }
  const focused = Math.max(0, Math.min(draft.focused, fields.length - 1))
  const target = focused + delta
  if (target >= 0 && target < fields.length) return { kind: 'next-field', delta }
  return { kind: 'focus-field', index: (target + fields.length) % fields.length }
}

/** The heading of the chooser one field opens. */
export function editorChooserTitle(field: ScheduleFormField): string {
  switch (field.id) {
    case 'timing-kind':
      return 'Choose timing'
    case 'target-kind':
      return 'Choose target'
    case 'target-session':
      return 'Choose Session'
    default:
      return 'Choose'
  }
}

/** Every selectable official timing kind. */
export function timingChooserOptions(): readonly ScheduleEditorChoice[] {
  return TIMING_KINDS.map(kind => ({ label: TIMING_LABELS[kind], value: kind }))
}

/** Every selectable official target kind. */
export function targetChooserOptions(): readonly ScheduleEditorChoice[] {
  return TARGET_KINDS.map(kind => ({ label: TARGET_LABELS[kind], value: kind }))
}

/** The listed Session candidates as chooser options: id, then optional title. */
export function sessionChooserOptions(
  sessions: readonly ScheduleSessionChoice[],
): readonly ScheduleEditorChoice[] {
  return sessions.map(session => ({
    label: session.title === undefined ? session.id : `${session.id} · ${session.title}`,
    value: session.id,
  }))
}
