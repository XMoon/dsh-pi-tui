/** The list-only Schedule formatting preserves official timing facts. */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ScheduleCatalogEntry, ScheduleRecord } from '../../src/runtime/schedule-port.ts'
import {
  formatListOccurrence,
  formatListRepeat,
  formatOccurrence,
} from '../../src/tui/schedule/format.ts'

function catalogEntry(
  record: ScheduleRecord,
  overrides: Partial<Pick<ScheduleCatalogEntry, 'status' | 'executionActive' | 'deliveryFloorEndsAt'>> = {},
): ScheduleCatalogEntry {
  return {
    ...record,
    target: { kind: 'new_once', sessionId: 'session-1' as never, create: {} },
    involvedSessionIds: [],
    status: 'active',
    ...overrides,
  }
}

function daily(overrides: Partial<Extract<ScheduleRecord, { kind: 'daily' }>> = {}): ScheduleRecord {
  return {
    id: 'schedule-daily' as never,
    kind: 'daily',
    title: 'Daily report',
    prompt: 'Prepare the report.',
    time: '09:00:00.000',
    timeZone: 'Asia/Shanghai',
    scheduledAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  }
}

test('a committed occurrence is formatted in its explicit official zone, independent of process TZ', () => {
  const entry = catalogEntry(daily())
  const original = process.env.TZ
  try {
    process.env.TZ = 'Pacific/Honolulu'
    const honolulu = formatListOccurrence(entry)
    process.env.TZ = 'Europe/Berlin'
    const berlin = formatListOccurrence(entry)
    assert.equal(honolulu, 'Next 2026-06-01 17:00 Asia/Shanghai')
    assert.equal(berlin, honolulu)
    assert.equal(formatListOccurrence(catalogEntry({
      id: 'schedule-at' as never,
      kind: 'at',
      title: 'One time',
      prompt: 'Prompt',
      scheduledAt: '2026-06-01T09:00:00.000Z',
    })), 'Next 2026-06-01 09:00 UTC')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('a later delivery floor is shown as eligibility, while an earlier floor leaves the committed Next time', () => {
  const scheduledAt = '2026-06-01T09:00:00.000Z'
  assert.equal(formatListOccurrence(catalogEntry(daily(), {
    deliveryFloorEndsAt: '2026-06-01T10:30:00.000Z',
  })), 'Eligible from 2026-06-01 18:30 Asia/Shanghai')
  assert.equal(formatListOccurrence(catalogEntry(daily({ scheduledAt }), {
    deliveryFloorEndsAt: '2026-06-01T08:00:00.000Z',
  })), 'Next 2026-06-01 17:00 Asia/Shanghai')
})

test('paused and ended records never claim a next or eligible run, even while execution is active', () => {
  const entry = daily()
  assert.equal(formatListOccurrence(catalogEntry(entry, {
    status: 'paused',
    executionActive: true,
    deliveryFloorEndsAt: '2026-06-01T10:30:00.000Z',
  })), 'Paused · Scheduled 2026-06-01 17:00 Asia/Shanghai')
  assert.equal(formatListOccurrence(catalogEntry(entry, {
    status: 'ended',
    executionActive: true,
    deliveryFloorEndsAt: '2026-06-01T10:30:00.000Z',
  })), 'Ended · Final 2026-06-01 17:00 Asia/Shanghai')
})

test('wall-clock repeat records use their official zone while fixed and custom records remain UTC', () => {
  const weekly = catalogEntry({
    id: 'schedule-weekly' as never,
    kind: 'weekly',
    title: 'Weekdays',
    prompt: 'Prompt',
    time: '09:00:00.000',
    timeZone: 'Europe/Berlin',
    weekdays: [1, 2, 3, 4, 5],
    scheduledAt: '2026-06-01T09:00:00.000Z',
  })
  const cron = catalogEntry({
    id: 'schedule-cron' as never,
    kind: 'cron',
    title: 'Cron',
    prompt: 'Prompt',
    expression: '0 9 * * *',
    timeZone: 'Pacific/Auckland',
    scheduledAt: '2026-06-01T09:00:00.000Z',
  })
  const every = catalogEntry({
    id: 'schedule-every' as never,
    kind: 'every',
    title: 'Interval',
    prompt: 'Prompt',
    everySeconds: 3600,
    scheduledAt: '2026-06-01T09:00:00.000Z',
  })
  const rrule = catalogEntry({
    id: 'schedule-rrule' as never,
    kind: 'rrule',
    title: 'Custom',
    prompt: 'Prompt',
    rrule: 'DTSTART;TZID=America/New_York:20260601T090000\nRRULE:FREQ=DAILY',
    scheduledAt: '2026-06-01T09:00:00.000Z',
  })
  assert.equal(formatListOccurrence(weekly), 'Next 2026-06-01 11:00 Europe/Berlin')
  assert.equal(formatListOccurrence(cron), 'Next 2026-06-01 21:00 Pacific/Auckland')
  assert.equal(formatListOccurrence(every), 'Next 2026-06-01 09:00 UTC')
  assert.equal(formatListOccurrence(rrule), 'Next 2026-06-01 09:00 UTC')
  assert.equal(formatListRepeat(weekly), 'Weekly Mon–Fri')
  assert.equal(formatListRepeat(cron), 'Cron')
  assert.equal(formatListRepeat(rrule), 'Custom')
})

test('list repeat summaries stay compact across all seven official timing kinds', () => {
  const records: readonly [ScheduleRecord, string][] = [
    [{ id: 'after' as never, kind: 'after', title: 'After', prompt: 'Prompt', afterSeconds: 60, scheduledAt: '2026-06-01T09:00:00.000Z' }, 'Once after 60 seconds'],
    [{ id: 'at' as never, kind: 'at', title: 'At', prompt: 'Prompt', scheduledAt: '2026-06-01T09:00:00.000Z' }, 'Once'],
    [{ id: 'every' as never, kind: 'every', title: 'Every', prompt: 'Prompt', everySeconds: 3600, scheduledAt: '2026-06-01T09:00:00.000Z' }, 'Every 3600 seconds'],
    [daily(), 'Daily'],
    [{ id: 'weekly' as never, kind: 'weekly', title: 'Weekly', prompt: 'Prompt', time: '09:00:00.000', timeZone: 'UTC', weekdays: [1, 3, 5], scheduledAt: '2026-06-01T09:00:00.000Z' }, 'Weekly Mon,Wed,Fri'],
    [{ id: 'cron' as never, kind: 'cron', title: 'Cron', prompt: 'Prompt', expression: '0 9 * * *', timeZone: 'UTC', scheduledAt: '2026-06-01T09:00:00.000Z' }, 'Cron'],
    [{ id: 'rrule' as never, kind: 'rrule', title: 'RRule', prompt: 'Prompt', rrule: 'DTSTART;TZID=UTC:20260601T090000\nRRULE:FREQ=DAILY', scheduledAt: '2026-06-01T09:00:00.000Z' }, 'Custom'],
  ]
  for (const [record, expected] of records) {
    assert.equal(formatListRepeat(catalogEntry(record)), expected, record.kind)
  }
})

test('the existing detail occurrence formatter remains canonical UTC text', () => {
  assert.equal(formatOccurrence(catalogEntry(daily())), 'next 2026-06-01T09:00:00.000Z · Asia/Shanghai')
})
