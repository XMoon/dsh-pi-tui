/**
 * The Schedule editor's terminal field layout (S5-PR4): the labels, per-field
 * hints, chooser option lists and focus arithmetic the panel paints. All
 * encoding and validation stay in `domain/schedule/form.ts`; this module only
 * maps the domain field list onto terminal presentation and intents.
 *
 * @module @xmoon76/dsh-pi-tui/tui/schedule/form
 */

import {
  editorFields,
  type ScheduleEditorDraft,
  type ScheduleFormField,
  type ScheduleTargetKind,
  type ScheduleTimingKind,
  type ScheduleTimingPreset,
} from '../../domain/schedule/form.ts'
import type { ScheduleIntent, ScheduleSessionChoice } from '../../app/schedule/presentation.ts'

/** One option painted by an in-panel editor chooser. */
export interface ScheduleEditorChoice<Value extends string = string> {
  readonly label: string
  readonly value: Value
}

/** The only UI vocabulary for the nine timing presets. */
const TIMING_PRESETS: readonly ScheduleEditorChoice<ScheduleTimingPreset>[] = [
  { label: 'Once · after delay', value: 'once-after' },
  { label: 'Once · at date/time', value: 'once-at' },
  { label: 'Every · minutes', value: 'every-minutes' },
  { label: 'Every · hours', value: 'every-hours' },
  { label: 'Every · exact seconds (advanced)', value: 'every-seconds' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Custom · Cron', value: 'cron' },
  { label: 'Custom · RRULE', value: 'rrule' },
]

const TARGET_CHOICES: readonly ScheduleEditorChoice<ScheduleTargetKind>[] = [
  { label: 'Existing conversation', value: 'session' },
  { label: 'Create and reuse conversation', value: 'new_once' },
  { label: 'New conversation each run', value: 'new' },
]

/** The field label column shared by every editor row. */
export const EDITOR_LABEL_WIDTH = 18

/** The user-facing editor mode word. */
export function editorModeLabel(mode: ScheduleEditorDraft['mode']): string {
  return mode === 'create' ? 'Create' : 'Edit'
}

/**
 * The ONE hint of a field. A text field is typed into; a choice/toggle field
 * is activated with Enter.
 */
export function editorFieldHint(field: ScheduleFormField): string {
  switch (field.id) {
    case 'timing-kind':
      return 'Enter choose repeat'
    case 'target-kind':
      return 'Enter choose destination'
    case 'target-session':
      return 'Enter choose conversation'
    case 'timing-weekdays':
      return 'Enter choose weekdays'
    case 'target-advanced':
      return 'Enter show/hide'
    case 'timing-quantity':
      return 'Type a whole number'
    case 'timing-date':
      return 'YYYY-MM-DD'
    case 'timing-time':
      return 'HH:mm or HH:mm:ss[.SSS]'
    case 'timing-zone':
      return 'UTC / Asia/Shanghai'
    case 'prompt':
    case 'timing-rrule':
      return 'Enter newline · Tab leaves'
    default:
      return field.kind === 'text' ? 'Type to edit' : 'Enter change'
  }
}

export function isEditorTextInput(field: ScheduleFormField): boolean {
  return field.kind === 'text'
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

/** The display value for one choice field, derived from its typed draft. */
export function editorFieldValue(
  field: ScheduleFormField,
  draft: ScheduleEditorDraft,
  sessions: readonly ScheduleSessionChoice[],
): string {
  if (field.id === 'timing-kind') {
    const preset = timingPresetForDraft(draft.timing)
    return TIMING_PRESETS.find(option => option.value === preset)!.label
  }
  if (field.id === 'target-kind') {
    return TARGET_CHOICES.find(option => option.value === draft.target.kind)!.label
  }
  if (field.id === 'target-session') {
    const session = sessions.find(candidate => candidate.id === field.value)
    return session === undefined ? field.value : `${session.title ?? session.id} · ${session.id}`
  }
  return field.value
}

function timingPresetForDraft(timing: ScheduleEditorDraft['timing']): ScheduleTimingPreset {
  switch (timing.kind) {
    case 'after': return 'once-after'
    case 'at': return 'once-at'
    case 'every':
      return timing.quantityUnit === 'minutes'
        ? 'every-minutes'
        : timing.quantityUnit === 'hours' ? 'every-hours' : 'every-seconds'
    case 'daily': return 'daily'
    case 'weekly': return 'weekly'
    case 'cron': return 'cron'
    case 'rrule': return 'rrule'
  }
}

/** The heading of the chooser one field opens. */
export function editorChooserTitle(field: ScheduleFormField): string {
  switch (field.id) {
    case 'timing-kind':
      return 'Choose repeat'
    case 'target-kind':
      return 'Choose destination'
    case 'target-session':
      return 'Choose existing conversation'
    case 'timing-weekdays':
      return 'Choose weekdays'
    default:
      return 'Choose'
  }
}

/** The nine guided timing presets in their frozen user-facing order. */
export function timingChooserOptions(): readonly ScheduleEditorChoice<ScheduleTimingPreset>[] {
  return TIMING_PRESETS
}

/** The three business-facing destination choices. */
export function targetChooserOptions(): readonly ScheduleEditorChoice<ScheduleTargetKind>[] {
  return TARGET_CHOICES
}

/** The listed Session candidates as chooser options: title, then identity. */
export function sessionChooserOptions(
  sessions: readonly ScheduleSessionChoice[],
): readonly ScheduleEditorChoice[] {
  return sessions.map(session => ({
    label: session.title === undefined ? session.id : `${session.title} · ${session.id}`,
    value: session.id,
  }))
}
