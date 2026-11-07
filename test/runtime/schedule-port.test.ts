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
  assert.deepEqual(encodeTiming({ kind: 'after', afterSeconds: '90' }), {
    kind: 'after',
    after_seconds: 90,
  })
  assert.deepEqual(encodeTiming({ kind: 'at', date: '2026-12-31', time: '23:30:00', timeZone: 'Asia/Shanghai' }), {
    kind: 'at',
    at: { date: '2026-12-31', time: '23:30:00', time_zone: 'Asia/Shanghai' },
  })
  assert.deepEqual(encodeTiming({ kind: 'every', everySeconds: '3600' }), {
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
  assert.throws(() => encodeTiming({ kind: 'after', afterSeconds: '0' }), ScheduleFormError)
  assert.throws(() => encodeTiming({ kind: 'after', afterSeconds: '1.5' }), ScheduleFormError)
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

test('L1: a create request is the official shape and the default target is new_once', () => {
  const draft = createDraft()
  const request = encodeCreate(draft)
  assert.deepEqual(request, {
    title: 'Daily build check',
    prompt: 'Check the build',
    timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } },
    target: { kind: 'new_once' },
  })
  assert.equal(draft.target.kind, 'new_once', 'the editor default target is the official omission semantics')
  assert.throws(() => encodeCreate(createDraft({ title: '   ' })), ScheduleFormError)
})

test('L1: an edit sends ONLY the changed fields and never re-sends an untouched rule or target', () => {
  const baseline = { title: 'Title', prompt: 'Prompt' }
  const untouched = createDraft({
    mode: 'edit',
    id: 'schedule-1',
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    title: 'Title',
    prompt: 'Prompt',
    timing: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    target: { kind: 'new_once', cwd: '', agentPreset: '' },
  })
  assert.deepEqual(encodePatch(baseline, { ...untouched, title: 'Renamed' }), { title: 'Renamed' })
  // The same edit with an explicitly edited timing carries the rule exactly.
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
      id: 'schedule-at' as ScheduleCatalogEntry['id'],
      kind: 'at',
      title: 'At',
      prompt: 'Prompt',
      scheduledAt: '2026-01-01T09:30:00.000Z',
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
    { kind: 'at', at: { date: '2026-01-01', time: '09:30:00', time_zone: 'UTC' } },
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
  // A `new_once` draft keeps the RESERVED Session identity untouched; an edit
  // that does not touch the target therefore never re-sends it.
  const onceDraft = draftFromRecord(records[2])
  assert.equal(onceDraft.target.kind, 'new_once')
  assert.equal(onceDraft.target.kind === 'new_once' ? onceDraft.target.cwd : '', '/work')
  assert.equal(onceDraft.target.kind === 'new_once' ? onceDraft.target.agentPreset : '', 'minimal')
})

test('L1: replacing the timing kind keeps the shared wall-clock values and never invents a local zone', () => {
  const daily: ReturnType<typeof selectTimingKind> = selectTimingKind(
    { kind: 'daily', time: '07:45:00', timeZone: 'Europe/Berlin' },
    'weekly',
  )
  assert.deepEqual(daily, {
    kind: 'weekly',
    time: '07:45:00',
    timeZone: 'Europe/Berlin',
    weekdays: [1, 2, 3, 4, 5],
  })
  assert.deepEqual(selectTimingKind(daily, 'cron'), {
    kind: 'cron',
    expression: '0 9 * * *',
    timeZone: 'Europe/Berlin',
  })
  assert.deepEqual(selectTimingKind(daily, 'rrule'), {
    kind: 'rrule',
    rrule: 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY',
  })
})

test('L1: field edits dispatch through the stable field ids the panel paints', () => {
  const draft = createDraft()
  const ids = editorFields(draft).map(field => field.id)
  assert.deepEqual(ids.slice(0, 6), ['title', 'prompt', 'timing-kind', 'timing-time', 'timing-zone', 'target-kind'])
  const renamed = applyFieldValue(draft, 'title', 'New title')
  assert.equal(renamed.title, 'New title')
  assert.equal(renamed.prompt, draft.prompt)
  const weeklyDraft = createDraft({
    timing: { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5] },
  })
  const weekly = applyFieldValue(applyFieldValue(weeklyDraft, 'timing-weekday-6', 'on'), 'timing-weekday-7', 'on')
  assert.equal(weekly.timingEdited, true)
  assert.deepEqual(weekly.timing.kind === 'weekly' ? weekly.timing.weekdays : [], [1, 2, 3, 4, 5, 6, 7])
  const toggled = applyFieldValue(weeklyDraft, 'timing-weekday-1', 'off')
  assert.deepEqual(toggled.timing.kind === 'weekly' ? toggled.timing.weekdays : [], [2, 3, 4, 5])
})
