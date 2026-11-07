/**
 * The UI-neutral Schedule editor form model (S5-PR4): the typed draft for one
 * official {@link ScheduleTiming} and {@link ScheduleTargetRequest}, the exact
 * mapping from an official record back into that draft, and the minimal
 * {@link SchedulePatch} an edit submits.
 *
 * This module is pure data and encoding. It performs the SMALL structural
 * checks a text field can prove locally (a non-empty title/prompt, an integer
 * second count, a `YYYY-MM-DD`/`HH:mm:ss` shape, a non-empty weekday set, a
 * present Session choice) and leaves every calendar, time-zone, futureness,
 * cron and RRULE rule to the official Host — a local refusal here never
 * becomes a Host write, and nothing here ever talks to a Host.
 *
 * @module @xmoon76/dsh-pi-tui/domain/schedule/form
 */

import type {
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  SchedulePatch,
  ScheduleRecord,
  ScheduleSessionCreateSpec,
  ScheduleTargetRequest,
  ScheduleTiming,
} from '../../runtime/schedule-port.ts'

/** One of the seven official timing kinds the editor can select. */
export type ScheduleTimingKind = ScheduleTiming['kind']

/** One of the three official target kinds the editor can select. */
export type ScheduleTargetKind = ScheduleTargetRequest['kind']

/** The typed draft of the seven official timing selectors. Text fields stay
 *  strings until encoding, so the user can type freely. */
export type ScheduleTimingDraft =
  | { readonly kind: 'after'; readonly afterSeconds: string }
  | { readonly kind: 'at'; readonly date: string; readonly time: string; readonly timeZone: string }
  | { readonly kind: 'every'; readonly everySeconds: string }
  | { readonly kind: 'daily'; readonly time: string; readonly timeZone: string }
  | {
    readonly kind: 'weekly'
    readonly time: string
    readonly timeZone: string
    readonly weekdays: readonly number[]
  }
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }
  | { readonly kind: 'rrule'; readonly rrule: string }

/** The typed draft of the three official target selectors. */
export type ScheduleTargetDraft =
  | { readonly kind: 'session'; readonly sessionId: string | undefined }
  | { readonly kind: 'new_once'; readonly cwd: string; readonly agentPreset: string }
  | { readonly kind: 'new'; readonly cwd: string; readonly agentPreset: string }

/** The editor's draft: either a create form or an edit of one task. */
export interface ScheduleEditorDraft {
  readonly mode: 'create' | 'edit'
  /** The edited task, absent for a create draft. */
  readonly id?: string
  /** The revision the edit read; explicit `null` when the record carried none. */
  readonly expectedUpdatedAt?: string | null
  readonly title: string
  readonly prompt: string
  readonly timing: ScheduleTimingDraft
  /** Whether the user changed any timing field: an untouched timing is never
   *  patched (no rule recompilation, no time-zone rewrite, no re-anchoring). */
  readonly timingEdited: boolean
  readonly target: ScheduleTargetDraft
  /** Whether the user changed the target: an untouched target is never patched
   *  (`new_once` keeps its reserved Session identity). */
  readonly targetEdited: boolean
  /** The advanced `cwd`/`agentPreset` inputs are visible. */
  readonly advanced: boolean
  /** The focused field index within {@link editorFields}. */
  readonly focused: number
  /** Per-kind LAST typed timing values, so switching kind away and back never
   *  resets the user's rule to a default. */
  readonly timingMemory?: Readonly<Partial<Record<ScheduleTimingKind, ScheduleTimingDraft>>>
  /** Per-kind LAST target values, so switching target away and back preserves
   *  the chosen Session / creation values. */
  readonly targetMemory?: Readonly<Partial<Record<ScheduleTargetKind, ScheduleTargetDraft>>>
}

/** The default new-task timing: a daily wall-clock reminder in UTC. UTC is
 *  deliberate — the form never guesses the terminal's zone. */
export const DEFAULT_TIMING_DRAFT: ScheduleTimingDraft = {
  kind: 'daily',
  time: '09:00:00',
  timeZone: 'UTC',
}

/** The default new-task target: the official omission semantics (one Session
 *  created at first delivery), rendered and submitted explicitly. */
export const DEFAULT_TARGET_DRAFT: ScheduleTargetDraft = { kind: 'new_once', cwd: '', agentPreset: '' }

/** A local structural refusal: the form never sends this to a Host. */
export class ScheduleFormError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'ScheduleFormError'
    this.field = field
  }
}

const CLOCK_PATTERN = /^\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/** Encode one timing draft into the official request union. */
export function encodeTiming(draft: ScheduleTimingDraft): ScheduleTiming {
  switch (draft.kind) {
    case 'after':
      return { kind: 'after', after_seconds: positiveInteger('after seconds', draft.afterSeconds) }
    case 'at':
      return {
        kind: 'at',
        at: {
          date: requirePattern('date', draft.date, DATE_PATTERN, 'YYYY-MM-DD'),
          time: requirePattern('time', draft.time, CLOCK_PATTERN, 'HH:mm:ss'),
          time_zone: requireTimeZone(draft.timeZone),
        },
      }
    case 'every':
      return { kind: 'every', every_seconds: positiveInteger('interval seconds', draft.everySeconds) }
    case 'daily':
      return {
        kind: 'daily',
        daily: {
          time: requirePattern('time', draft.time, CLOCK_PATTERN, 'HH:mm:ss'),
          time_zone: requireTimeZone(draft.timeZone),
        },
      }
    case 'weekly':
      return {
        kind: 'weekly',
        weekly: {
          time: requirePattern('time', draft.time, CLOCK_PATTERN, 'HH:mm:ss'),
          time_zone: requireTimeZone(draft.timeZone),
          weekdays: normalizeWeekdaySelection(draft.weekdays),
        },
      }
    case 'cron':
      return {
        kind: 'cron',
        cron: {
          expression: requireText('cron expression', draft.expression),
          time_zone: requireTimeZone(draft.timeZone),
        },
      }
    case 'rrule':
      return { kind: 'rrule', rrule: requireText('RRULE text', draft.rrule) }
  }
}

/** Encode one target draft into the official request union. The `new_once` and
 *  `new` targets ALWAYS state their kind explicitly (the official omission is
 *  equivalent, but the submitted form is explicit); their optional creation
 *  values are sent only when the user typed them. */
export function encodeTarget(draft: ScheduleTargetDraft): ScheduleTargetRequest {
  switch (draft.kind) {
    case 'session':
      if (draft.sessionId === undefined || draft.sessionId === '') {
        throw new ScheduleFormError('target', 'Choose an existing Session for this target.')
      }
      return { kind: 'session', sessionId: scheduleSessionId(draft.sessionId) }
    case 'new_once':
    case 'new': {
      const create = encodeCreateSpec(draft)
      return create === undefined ? { kind: draft.kind } : { kind: draft.kind, create }
    }
  }
}

/** The branded Session identity one official `session` target carries. */
export type ScheduleSessionId = Extract<ScheduleTargetRequest, { kind: 'session' }>['sessionId']

/**
 * Admit one Session id the SessionReader listed as an official target
 * identity. The brand is compile-time only and the identity came from the
 * Host's own listing; no other string may be passed through this boundary.
 */
export function scheduleSessionId(id: string): ScheduleSessionId {
  return id as ScheduleSessionId
}

/** One create request built from the draft. */
export function encodeCreate(draft: ScheduleEditorDraft): ScheduleCreateRequest {
  return {
    title: requireText('title', draft.title),
    prompt: requireText('prompt', draft.prompt),
    timing: encodeTiming(draft.timing),
    target: encodeTarget(draft.target),
  }
}

/**
 * The minimal atomic patch one edit submits. Only fields the user actually
 * changed are present: an untouched timing is NEVER re-sent (the Host would
 * recompile the rule and re-anchor its occurrence), and an untouched target is
 * never re-sent (a `new_once` target would reserve a new Session identity).
 */
export function encodePatch(
  baseline: ScheduleEditorBaseline,
  draft: ScheduleEditorDraft,
): SchedulePatch {
  const patch: {
    title?: string
    prompt?: string
    timing?: ScheduleTiming
    target?: ScheduleTargetRequest
  } = {}
  if (draft.title !== baseline.title) patch.title = requireText('title', draft.title)
  if (draft.prompt !== baseline.prompt) patch.prompt = requireText('prompt', draft.prompt)
  // The comparison is between the FINAL typed values, never "did the user
  // interact": re-sending an unchanged `timing` recompiles/re-anchors the rule,
  // and re-sending an unchanged `new_once` target re-reserves its Session
  // identity. Only a genuinely different encoded rule/target travels.
  if (!sameTimingDraft(draft.timing, baseline.timing)) patch.timing = encodeTiming(draft.timing)
  if (!sameTargetDraft(draft.target, baseline.target)) patch.target = encodeTarget(draft.target)
  if (Object.keys(patch).length === 0) {
    throw new ScheduleFormError('form', 'Nothing changed yet.')
  }
  return patch
}

/** The immutable record values one edit patches against, as typed drafts. */
export interface ScheduleEditorBaseline {
  readonly title: string
  readonly prompt: string
  readonly timing: ScheduleTimingDraft
  readonly target: ScheduleTargetDraft
}

/** Whether two typed timing drafts encode to the SAME official rule. */
export function sameTimingDraft(left: ScheduleTimingDraft, right: ScheduleTimingDraft): boolean {
  return JSON.stringify(encodeTiming(left)) === JSON.stringify(encodeTiming(right))
}

/** The fields the editor shows for one timing kind, in focus order. */
export interface ScheduleFormField {
  /** Stable field identity across frames and key dispatch. */
  readonly id: string
  /** English label the panel paints. */
  readonly label: string
  /** `text` fields edit a string; `choice`/`weekday`/`toggle` fields are
   *  activated rather than typed into. */
  readonly kind: 'text' | 'choice' | 'weekday' | 'toggle'
  readonly value: string
}

/** The editor field list for one draft: identity, prompt, the timing/zone
 *  fields of the SELECTED official kind, the target selector and the advanced
 *  creation values. The panel paints these in order; focus is an index into
 *  this list. */
export function editorFields(draft: ScheduleEditorDraft): readonly ScheduleFormField[] {
  const fields: ScheduleFormField[] = [
    { id: 'title', label: 'Title', kind: 'text', value: draft.title },
    { id: 'prompt', label: 'Prompt', kind: 'text', value: draft.prompt },
    { id: 'timing-kind', label: 'Timing', kind: 'choice', value: TIMING_LABELS[draft.timing.kind] },
    ...timingFields(draft.timing),
    { id: 'target-kind', label: 'Target', kind: 'choice', value: TARGET_LABELS[draft.target.kind] },
    ...targetFields(draft),
  ]
  if (draft.target.kind !== 'session') {
    fields.push({ id: 'target-advanced', label: 'Advanced create values', kind: 'toggle', value: draft.advanced ? 'shown' : 'hidden' })
    if (draft.advanced) {
      fields.push(
        { id: 'target-cwd', label: 'cwd', kind: 'text', value: draft.target.cwd },
        { id: 'target-agent-preset', label: 'Agent preset', kind: 'text', value: draft.target.agentPreset },
      )
    }
  }
  return fields
}

/** The field the editor's focus currently addresses, or `undefined` when the
 *  draft's field list shrank below the stored index. */
export function focusedField(draft: ScheduleEditorDraft): ScheduleFormField | undefined {
  return editorFields(draft)[draft.focused]
}

/** The canonical English label of each official timing kind. */
export const TIMING_LABELS: Readonly<Record<ScheduleTimingKind, string>> = {
  after: 'after',
  at: 'at',
  every: 'every',
  daily: 'daily',
  weekly: 'weekly',
  cron: 'cron',
  rrule: 'rrule',
}

/** The canonical English label of each official target kind. */
export const TARGET_LABELS: Readonly<Record<ScheduleTargetKind, string>> = {
  session: 'session',
  new_once: 'new_once',
  new: 'new',
}

/** Every selectable timing kind, in the plan's order. */
export const TIMING_KINDS: readonly ScheduleTimingKind[] = ['after', 'at', 'every', 'daily', 'weekly', 'cron', 'rrule']

/** Every selectable target kind, in the plan's order. */
export const TARGET_KINDS: readonly ScheduleTargetKind[] = ['session', 'new_once', 'new']

/** ISO weekdays Monday 1 … Sunday 7 (the official storage order). */
export const SCHEDULE_WEEKDAYS: readonly number[] = [...WEEKDAYS]

/** Replace one timing kind, keeping the shared wall-clock/zone values a user
 *  already typed when the new kind has them. */
export function selectTimingKind(current: ScheduleTimingDraft, kind: ScheduleTimingKind): ScheduleTimingDraft {
  if (current.kind === kind) return current
  switch (kind) {
    case 'after':
      return { kind, afterSeconds: current.kind === 'after' ? current.afterSeconds : '60' }
    case 'every':
      return { kind, everySeconds: current.kind === 'every' ? current.everySeconds : '3600' }
    case 'at':
      return {
        kind,
        date: current.kind === 'at' ? current.date : utcToday(),
        time: sharedTime(current),
        timeZone: sharedZone(current),
      }
    case 'daily':
      return { kind, time: sharedTime(current), timeZone: sharedZone(current) }
    case 'weekly':
      return {
        kind,
        time: sharedTime(current),
        timeZone: sharedZone(current),
        weekdays: current.kind === 'weekly' ? current.weekdays : [1, 2, 3, 4, 5],
      }
    case 'cron':
      return {
        kind,
        expression: current.kind === 'cron' ? current.expression : '0 9 * * *',
        timeZone: sharedZone(current),
      }
    case 'rrule':
      return {
        kind,
        rrule: current.kind === 'rrule' ? current.rrule : 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY',
      }
  }
}

/** Replace one focusable field's string value. Unknown ids are ignored. */
export function applyFieldValue(draft: ScheduleEditorDraft, fieldId: string, value: string): ScheduleEditorDraft {
  if (fieldId === 'title') return { ...draft, title: value }
  if (fieldId === 'prompt') return { ...draft, prompt: value }
  const timing = applyTimingField(draft.timing, fieldId, value)
  if (timing !== undefined) return { ...draft, timing, timingEdited: true }
  const target = applyTargetField(draft.target, fieldId, value)
  if (target !== undefined) return { ...draft, target, targetEdited: true }
  return draft
}

/** The draft of one official record, exactly as stored, for an edit form. */
export function draftFromRecord(entry: ScheduleCatalogEntry): {
  readonly title: string
  readonly prompt: string
  readonly timing: ScheduleTimingDraft
  readonly target: ScheduleTargetDraft
} {
  const target: ScheduleTargetDraft = entry.target.kind === 'session'
    ? { kind: 'session', sessionId: entry.target.sessionId }
    : {
        kind: entry.target.kind,
        cwd: entry.target.create.cwd ?? '',
        agentPreset: entry.target.create.agentPreset ?? '',
      }
  return { title: entry.title, prompt: entry.prompt, timing: timingDraftFromRecord(entry), target }
}

/** Whether two target drafts address the same official target. */
export function sameTargetDraft(left: ScheduleTargetDraft, right: ScheduleTargetDraft): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'session') return right.kind === 'session' && left.sessionId === right.sessionId
  return right.kind !== 'session' && left.cwd === right.cwd && left.agentPreset === right.agentPreset
}

function timingFields(timing: ScheduleTimingDraft): readonly ScheduleFormField[] {
  switch (timing.kind) {
    case 'after':
      return [{ id: 'timing-after', label: 'Delay seconds', kind: 'text', value: timing.afterSeconds }]
    case 'at':
      return [
        { id: 'timing-date', label: 'Date (YYYY-MM-DD)', kind: 'text', value: timing.date },
        { id: 'timing-time', label: 'Time (HH:mm:ss)', kind: 'text', value: timing.time },
        { id: 'timing-zone', label: 'IANA time zone', kind: 'text', value: timing.timeZone },
      ]
    case 'every':
      return [{ id: 'timing-every', label: 'Interval seconds', kind: 'text', value: timing.everySeconds }]
    case 'daily':
      return [
        { id: 'timing-time', label: 'Time (HH:mm:ss)', kind: 'text', value: timing.time },
        { id: 'timing-zone', label: 'IANA time zone', kind: 'text', value: timing.timeZone },
      ]
    case 'weekly':
      return [
        { id: 'timing-time', label: 'Time (HH:mm:ss)', kind: 'text', value: timing.time },
        { id: 'timing-zone', label: 'IANA time zone', kind: 'text', value: timing.timeZone },
        ...WEEKDAYS.map(day => ({
          id: `timing-weekday-${day}`,
          label: WEEKDAY_LABELS[day],
          kind: 'weekday' as const,
          value: timing.weekdays.includes(day) ? 'on' : 'off',
        })),
      ]
    case 'cron':
      return [
        { id: 'timing-cron', label: 'Cron (minute hour day month weekday)', kind: 'text', value: timing.expression },
        { id: 'timing-zone', label: 'IANA time zone', kind: 'text', value: timing.timeZone },
      ]
    case 'rrule':
      return [{ id: 'timing-rrule', label: 'RRULE', kind: 'text', value: timing.rrule }]
  }
}

function targetFields(draft: ScheduleEditorDraft): readonly ScheduleFormField[] {
  if (draft.target.kind !== 'session') return []
  return [{
    id: 'target-session',
    label: 'Session',
    kind: 'choice',
    value: draft.target.sessionId ?? '',
  }]
}

function applyTimingField(
  timing: ScheduleTimingDraft,
  fieldId: string,
  value: string,
): ScheduleTimingDraft | undefined {
  if (fieldId.startsWith('timing-weekday-')) {
    if (timing.kind !== 'weekly') return undefined
    const day = Number(fieldId.slice('timing-weekday-'.length))
    const selected = value === 'on'
    const weekdays = selected
      ? [...new Set([...timing.weekdays, day])].sort((left, right) => left - right)
      : timing.weekdays.filter(entry => entry !== day)
    return { ...timing, weekdays }
  }
  switch (fieldId) {
    case 'timing-after':
      return timing.kind === 'after' ? { ...timing, afterSeconds: value } : undefined
    case 'timing-every':
      return timing.kind === 'every' ? { ...timing, everySeconds: value } : undefined
    case 'timing-date':
      return timing.kind === 'at' ? { ...timing, date: value } : undefined
    case 'timing-time':
      return 'time' in timing ? { ...timing, time: value } : undefined
    case 'timing-zone':
      return 'timeZone' in timing ? { ...timing, timeZone: value } : undefined
    case 'timing-cron':
      return timing.kind === 'cron' ? { ...timing, expression: value } : undefined
    case 'timing-rrule':
      return timing.kind === 'rrule' ? { ...timing, rrule: value } : undefined
    default:
      return undefined
  }
}

function applyTargetField(
  target: ScheduleTargetDraft,
  fieldId: string,
  value: string,
): ScheduleTargetDraft | undefined {
  if (fieldId === 'target-session') return { kind: 'session', sessionId: value === '' ? undefined : value }
  if (target.kind === 'session') return undefined
  if (fieldId === 'target-cwd') return { ...target, cwd: value }
  if (fieldId === 'target-agent-preset') return { ...target, agentPreset: value }
  return undefined
}

function timingDraftFromRecord(record: ScheduleRecord): ScheduleTimingDraft {
  switch (record.kind) {
    case 'after':
      return { kind: 'after', afterSeconds: String(record.afterSeconds) }
    case 'at':
      // The official `at` record stores only the committed UTC instant. The
      // draft renders it in UTC so a resubmission without an explicit edit is
      // the SAME instant; it never guesses a local zone.
      return { kind: 'at', ...utcParts(record.scheduledAt), timeZone: 'UTC' }
    case 'every':
      return { kind: 'every', everySeconds: String(record.everySeconds) }
    case 'daily':
      return { kind: 'daily', time: record.time, timeZone: record.timeZone }
    case 'weekly':
      return { kind: 'weekly', time: record.time, timeZone: record.timeZone, weekdays: [...record.weekdays] }
    case 'cron':
      return { kind: 'cron', expression: record.expression, timeZone: record.timeZone }
    case 'rrule':
      return { kind: 'rrule', rrule: record.rrule }
  }
}

function encodeCreateSpec(draft: { readonly cwd: string; readonly agentPreset: string }): ScheduleSessionCreateSpec | undefined {
  const cwd = draft.cwd.trim()
  const agentPreset = draft.agentPreset.trim()
  if (cwd === '' && agentPreset === '') return undefined
  return {
    ...(cwd === '' ? {} : { cwd }),
    ...(agentPreset === '' ? {} : { agentPreset }),
  }
}

function requireText(label: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new ScheduleFormError(label, `The ${label} is required.`)
  return trimmed
}

function positiveInteger(label: string, value: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) throw new ScheduleFormError(label, `The ${label} must be a whole number.`)
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ScheduleFormError(label, `The ${label} must be a positive whole number.`)
  }
  return parsed
}

function requirePattern(label: string, value: string, pattern: RegExp, shape: string): string {
  const trimmed = value.trim()
  if (!pattern.test(trimmed)) throw new ScheduleFormError(label, `The ${label} must be ${shape}.`)
  return trimmed
}

function requireTimeZone(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new ScheduleFormError('time zone', 'The time zone is required (for example UTC or Asia/Shanghai).')
  return trimmed
}

function normalizeWeekdaySelection(weekdays: readonly number[]): number[] {
  const unique = [...new Set(weekdays)].sort((left, right) => left - right)
  if (unique.length === 0) throw new ScheduleFormError('weekdays', 'Choose at least one weekday.')
  for (const day of unique) {
    if (!(WEEKDAYS as readonly number[]).includes(day)) throw new ScheduleFormError('weekdays', `"${day}" is not an ISO weekday (1-7).`)
  }
  return unique
}

function sharedTime(timing: ScheduleTimingDraft): string {
  return 'time' in timing ? timing.time : '09:00:00'
}

function sharedZone(timing: ScheduleTimingDraft): string {
  return 'timeZone' in timing ? timing.timeZone : 'UTC'
}

function utcParts(instant: string): { readonly date: string; readonly time: string } {
  return { date: instant.slice(0, 10), time: instant.slice(11, 19) }
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

const WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
}
