/**
 * S5-PR4 L1 contract: the UI-neutral Schedule editor form model.
 *
 * The form proves the official request GRAMMAR: seven timing kinds and three
 * target kinds encode to exactly the published union members, the weekly
 * weekday set is the official ascending ISO numbers, and an edit sends the
 * minimal patch (an untouched timing or target is never re-sent).
 *
 * @module @xmoon76/dsh-pi-tui/schedule-form.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
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
  encodeTiming,
  scheduleSessionId,
  selectTimingKind,
  type ScheduleEditorDraft,
} from '../../src/domain/schedule/form.ts'
import type { ScheduleCatalogEntry } from '../../src/runtime/schedule-port.ts'

function createDraft(overrides: Partial<ScheduleEditorDraft> = {}): ScheduleEditorDraft {
  return {
    mode: 'create',
    title: 'Daily build check',
    prompt: 'Check the build',
    timing: DEFAULT_TIMING_DRAFT,
    timingEdited: false,
    target: DEFAULT_TARGET_DRAFT,
    targetEdited: false,
    advanced: false,
    focused: 0,
    ...overrides,
  }
}

test('L1: every official timing kind encodes to its exact request member', () => {
  assert.deepEqual(encodeTiming({ kind: 'after', afterSeconds: '90', quantityUnit: 'seconds' }), {
    kind: 'after',
    after_seconds: 90,
  })
  assert.deepEqual(encodeTiming({ kind: 'at', date: '2026-12-31', time: '23:30:00', timeZone: 'Asia/Shanghai' }), {
    kind: 'at',
    at: { date: '2026-12-31', time: '23:30:00', time_zone: 'Asia/Shanghai' },
  })
  assert.deepEqual(encodeTiming({ kind: 'every', everySeconds: '3600', quantityUnit: 'hours' }), {
    kind: 'every',
    every_seconds: 3600,
  })
  assert.deepEqual(encodeTiming({ kind: 'daily', time: '09:00:00', timeZone: 'UTC' }), {
    kind: 'daily',
    daily: { time: '09:00:00', time_zone: 'UTC' },
  })
  assert.deepEqual(encodeTiming({ kind: 'weekly', time: '08:15:00', timeZone: 'Europe/Berlin', weekdays: [5, 1, 3] }), {
    kind: 'weekly',
    weekly: { time: '08:15:00', time_zone: 'Europe/Berlin', weekdays: [1, 3, 5] },
  })
  assert.deepEqual(encodeTiming({ kind: 'cron', expression: '0 17 * * 1-5', timeZone: 'UTC' }), {
    kind: 'cron',
    cron: { expression: '0 17 * * 1-5', time_zone: 'UTC' },
  })
  assert.deepEqual(encodeTiming({ kind: 'rrule', rrule: 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY' }), {
    kind: 'rrule',
    rrule: 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY',
  })
})

test('L1: local structure refusals never become a Host request', () => {
  assert.throws(() => encodeTiming({ kind: 'after', afterSeconds: '0', quantityUnit: 'seconds' }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'after', afterSeconds: '1.5', quantityUnit: 'seconds' }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'daily', time: '9:00', timeZone: 'UTC' }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'daily', time: '09:00:00', timeZone: '  ' }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [] }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [0] }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'cron', expression: '  ', timeZone: 'UTC' }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'at', date: '2026/12/31', time: '23:30:00', timeZone: 'UTC' }), ScheduleFormError)
  // The Host owns the domain rules: a structurally valid expression that the
  // Host may still refuse is encoded unchanged, never pre-judged here.
  assert.deepEqual(encodeTiming({ kind: 'cron', expression: '* * * * *', timeZone: 'UTC' }), {
    kind: 'cron',
    cron: { expression: '* * * * *', time_zone: 'UTC' },
  })
})

test('L1: the three target kinds always state their kind explicitly', () => {
  assert.deepEqual(encodeTarget({ kind: 'new_once', cwd: '', agentPreset: '' }), { kind: 'new_once' })
  assert.deepEqual(encodeTarget({ kind: 'new', cwd: '', agentPreset: '' }), { kind: 'new' })
  assert.deepEqual(
    encodeTarget({ kind: 'new_once', cwd: '/work', agentPreset: 'standard' }),
    { kind: 'new_once', create: { cwd: '/work', agentPreset: 'standard' } },
  )
  assert.deepEqual(
    encodeTarget({ kind: 'session', sessionId: scheduleSessionId('session-1') }),
    { kind: 'session', sessionId: 'session-1' },
  )
  assert.throws(() => encodeTarget({ kind: 'session', sessionId: undefined }), ScheduleFormError)
})

test('L1: a create request defaults to one hour after save and a reused conversation', () => {
  const draft = createDraft()
  const request = encodeCreate(draft)
  assert.deepEqual(request, {
    title: 'Daily build check',
    prompt: 'Check the build',
    timing: { kind: 'after', after_seconds: 3600 },
    target: { kind: 'new_once' },
  })
  assert.equal(draft.target.kind, 'new_once', 'the editor default target is the official omission semantics')
  assert.throws(() => encodeCreate(createDraft({ title: '   ' })), ScheduleFormError)
})

test('L1: an edit sends ONLY the changed fields and never re-sends an untouched rule or target', () => {
  const untouched = createDraft({
    mode: 'edit',
    id: 'schedule-1',
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    title: 'Title',
    prompt: 'Prompt',
    timing: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    target: { kind: 'new_once', cwd: '', agentPreset: '' },
  })
  const baseline = {
    title: untouched.title,
    prompt: untouched.prompt,
    timing: untouched.timing,
    target: untouched.target,
  }
  assert.deepEqual(encodePatch(baseline, { ...untouched, title: 'Renamed' }), { title: 'Renamed' })
  // A genuinely different rule travels exactly; the untouched `new_once`
  // target (and its reserved Session identity) is never re-sent.
  const timingEdit = encodePatch(baseline, {
    ...untouched,
    timing: { kind: 'cron', expression: '0 10 * * *', timeZone: 'UTC' },
    timingEdited: true,
  })
  assert.deepEqual(timingEdit, { timing: { kind: 'cron', cron: { expression: '0 10 * * *', time_zone: 'UTC' } } })
  assert.equal('target' in timingEdit, false, 'a `new_once` edit never re-sends its reserved target')
  // An explicitly edited target does travel, with its kind stated.
  assert.deepEqual(
    encodePatch(baseline, { ...untouched, target: { kind: 'new', cwd: '', agentPreset: '' }, targetEdited: true }),
    { target: { kind: 'new' } },
  )
  // Toggle a field away and back: the FINAL typed value equals the stored one,
  // so the patch stays empty (no rule recompile, no re-reserved Session).
  assert.throws(
    () => encodePatch(baseline, {
      ...untouched,
      timing: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
      timingEdited: true,
      target: { kind: 'new_once', cwd: '', agentPreset: '' },
      targetEdited: true,
    }),
    ScheduleFormError,
    'reverting a field leaves nothing to patch',
  )
  assert.throws(() => encodePatch(baseline, untouched), ScheduleFormError, 'an empty edit is a local refusal')
})

test('L1: the draft of an official record round-trips the stored rule exactly', () => {
  const records: ScheduleCatalogEntry[] = [
    {
      id: 'schedule-after' as ScheduleCatalogEntry['id'],
      kind: 'after',
      title: 'After',
      prompt: 'Prompt',
      afterSeconds: 120,
      scheduledAt: '2026-01-01T00:02:00.000Z',
      target: { kind: 'session', sessionId: 'session-1' as never },
      involvedSessionIds: [],
      status: 'active',
    },
    {
      id: 'schedule-every' as ScheduleCatalogEntry['id'],
      kind: 'every',
      title: 'Every',
      prompt: 'Prompt',
      everySeconds: 61,
      scheduledAt: '2026-01-01T00:01:01.000Z',
      target: { kind: 'session', sessionId: 'session-every' as never },
      involvedSessionIds: [],
      status: 'active',
    },
    {
      id: 'schedule-at' as ScheduleCatalogEntry['id'],
      kind: 'at',
      title: 'At',
      prompt: 'Prompt',
      scheduledAt: '2026-01-01T09:30:00.123Z',
      target: { kind: 'new', create: {} },
      involvedSessionIds: [],
      status: 'ended',
    },
    {
      id: 'schedule-daily' as ScheduleCatalogEntry['id'],
      kind: 'daily',
      title: 'Daily',
      prompt: 'Prompt',
      time: '09:00:00.000',
      timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-01-01T01:00:00.000Z',
      target: { kind: 'new_once', sessionId: 'session-2' as never, create: { cwd: '/work', agentPreset: 'minimal' } },
      involvedSessionIds: [],
      status: 'paused',
    },
    {
      id: 'schedule-weekly' as ScheduleCatalogEntry['id'],
      kind: 'weekly',
      title: 'Weekly',
      prompt: 'Prompt',
      time: '08:15:00',
      timeZone: 'UTC',
      weekdays: [1, 3, 5],
      scheduledAt: '2026-01-05T08:15:00.000Z',
      target: { kind: 'session', sessionId: 'session-3' as never },
      involvedSessionIds: [],
      status: 'active',
    },
    {
      id: 'schedule-cron' as ScheduleCatalogEntry['id'],
      kind: 'cron',
      title: 'Cron',
      prompt: 'Prompt',
      expression: '0 17 * * 1-5',
      timeZone: 'America/New_York',
      scheduledAt: '2026-01-05T22:00:00.000Z',
      target: { kind: 'session', sessionId: 'session-4' as never },
      involvedSessionIds: [],
      status: 'active',
    },
    {
      id: 'schedule-rrule' as ScheduleCatalogEntry['id'],
      kind: 'rrule',
      title: 'RRULE',
      prompt: 'Prompt',
      rrule: 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO',
      scheduledAt: '2026-01-05T09:00:00.000Z',
      target: { kind: 'session', sessionId: 'session-5' as never },
      involvedSessionIds: [],
      status: 'active',
    },
  ]
  const expectations = [
    { kind: 'after', after_seconds: 120 },
    { kind: 'every', every_seconds: 61 },
    { kind: 'at', at: { date: '2026-01-01', time: '09:30:00.123', time_zone: 'UTC' } },
    { kind: 'daily', daily: { time: '09:00:00.000', time_zone: 'Asia/Shanghai' } },
    { kind: 'weekly', weekly: { time: '08:15:00', time_zone: 'UTC', weekdays: [1, 3, 5] } },
    { kind: 'cron', cron: { expression: '0 17 * * 1-5', time_zone: 'America/New_York' } },
    { kind: 'rrule', rrule: 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO' },
  ]
  records.forEach((record, index) => {
    const draft = draftFromRecord(record)
    assert.deepEqual(encodeTiming(draft.timing), expectations[index], `${record.kind} round-trips its stored rule`)
    assert.equal(draft.title, record.title)
    assert.equal(draft.prompt, record.prompt)
    assert.equal(draft.target.kind, record.target.kind)
  })
  const afterDraft = draftFromRecord(records[0]!)
  assert.deepEqual(afterDraft.timing, { kind: 'after', afterSeconds: '120', quantityUnit: 'minutes' })
  assert.equal(editorFields({ ...createDraft(), timing: afterDraft.timing }).find(field => field.id === 'timing-quantity')?.value, '2')
  const everyDraft = draftFromRecord(records[1]!)
  assert.deepEqual(everyDraft.timing, { kind: 'every', everySeconds: '61', quantityUnit: 'seconds' })
  assert.equal(editorFields({ ...createDraft(), timing: everyDraft.timing }).find(field => field.id === 'timing-quantity')?.value, '61')
  // A `new_once` draft keeps the RESERVED Session identity untouched; an edit
  // that does not touch the target therefore never re-sends it.
  const onceDraft = draftFromRecord(records.find(record => record.kind === 'daily')!)
  assert.equal(onceDraft.target.kind, 'new_once')
  assert.equal(onceDraft.target.kind === 'new_once' ? onceDraft.target.cwd : '', '/work')
  assert.equal(onceDraft.target.kind === 'new_once' ? onceDraft.target.agentPreset : '', 'minimal')
})

test('L1: replacing the timing kind keeps the shared wall-clock values and never invents a local zone', () => {
  const daily: ReturnType<typeof selectTimingKind> = selectTimingKind(
    { kind: 'daily', time: '07:45:00', timeZone: 'Europe/Berlin' },
    'weekly',
    new Date('2026-06-01T12:34:56.000Z'),
  )
  assert.deepEqual(daily, {
    kind: 'weekly',
    time: '07:45:00',
    timeZone: 'Europe/Berlin',
    weekdays: [1, 2, 3, 4, 5],
  })
  assert.deepEqual(selectTimingKind(daily, 'at', new Date('2026-06-01T12:34:56.000Z')), {
    kind: 'at',
    date: '2026-06-01',
    time: '13:35:00',
    timeZone: 'UTC',
  })
  assert.deepEqual(selectTimingKind(daily, 'cron', new Date('2026-06-01T12:34:56.000Z')), {
    kind: 'cron',
    expression: '0 9 * * *',
    timeZone: 'Europe/Berlin',
  })
  assert.deepEqual(selectTimingKind(daily, 'rrule', new Date('2026-06-01T12:34:56.000Z')), {
    kind: 'rrule',
    rrule: 'DTSTART:20260601T133500Z\nRRULE:FREQ=DAILY',
  })
})

test('L1: field edits dispatch through the stable field ids the panel paints', () => {
  const draft = createDraft()
  const ids = editorFields(draft).map(field => field.id)
  assert.deepEqual(ids.slice(0, 5), ['title', 'prompt', 'timing-kind', 'timing-quantity', 'target-kind'])
  const renamed = applyFieldValue(draft, 'title', 'New title')
  assert.equal(renamed.title, 'New title')
  assert.equal(renamed.prompt, draft.prompt)
  const weeklyDraft = createDraft({
    timing: { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5] },
  })
  const weekdayField = editorFields(weeklyDraft).find(field => field.id === 'timing-weekdays')
  assert.deepEqual(weekdayField, {
    id: 'timing-weekdays',
    label: 'Weekdays',
    kind: 'choice',
    value: 'Mon Tue Wed Thu Fri',
  })
  assert.deepEqual(editorFields(createDraft({ timing: { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [] } }))
    .find(field => field.id === 'timing-weekdays')?.value, 'None selected')
})

test('L1: quantity input converts exact user units to official integer seconds', () => {
  const minutes = createDraft({
    timing: { kind: 'every', everySeconds: '60', quantityUnit: 'minutes' },
  })
  const updated = applyFieldValue(minutes, 'timing-quantity', '90')
  assert.deepEqual(updated.timing, { kind: 'every', everySeconds: '5400', quantityUnit: 'minutes' })
  assert.equal(editorFields(updated).find(field => field.id === 'timing-quantity')?.value, '90')

  const empty = applyFieldValue(minutes, 'timing-quantity', '')
  assert.deepEqual(empty.timing, { kind: 'every', everySeconds: '', quantityUnit: 'minutes' })
  assert.throws(() => encodeTiming(empty.timing), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'after', afterSeconds: '9007199254740992', quantityUnit: 'seconds' }), ScheduleFormError)
})

test('L1: HH:mm gains seconds only at encoding while seconds and milliseconds round-trip', () => {
  assert.deepEqual(encodeTiming({ kind: 'daily', time: '09:30', timeZone: 'UTC' }), {
    kind: 'daily',
    daily: { time: '09:30:00', time_zone: 'UTC' },
  })
  assert.deepEqual(encodeTiming({ kind: 'at', date: '2026-06-01', time: '09:30:45.123', timeZone: 'UTC' }), {
    kind: 'at',
    at: { date: '2026-06-01', time: '09:30:45.123', time_zone: 'UTC' },
  })
})
