/**
 * The Schedule workspace's pure display formatting (S5-PR4): official Host
 * facts in, terminal text out. Nothing here reads a Host, dispatches, starts a
 * timer or derives an occurrence: every timestamp below is the OFFICIAL
 * `scheduledAt`/`deliveryFloorEndsAt`/receipt instant rendered for display.
 *
 * The stored rule expression is never interpreted. A cron expression and an
 * RRULE are shown verbatim; the next occurrence is only the Host's committed
 * instant, formatted locally and labelled with the rule's official zone.
 *
 * @module @xmoon76/dsh-pi-tui/tui/schedule/format
 */

import type { ScheduleCatalogEntry } from '../../runtime/schedule-port.ts'

/** The official task state. It is never mixed with execution activity. */
export type ScheduleTaskStatus = ScheduleCatalogEntry['status']

/** The official destination of the next delivery. */
export type ScheduleTarget = ScheduleCatalogEntry['target']

/** The official receipt of the most recent acknowledged delivery. */
export type ScheduleDeliveryReceipt = NonNullable<ScheduleCatalogEntry['lastDelivery']>

/**
 * The ONE shared status marker (design-language D5/D7): every status paints the
 * same `‣`; the Title Case word carries the state. No per-status glyph exists.
 */
export function scheduleStatusMarker(_status: ScheduleTaskStatus): string {
  return '‣'
}

/** The Title Case user-facing word for an official task status (D12). */
export function scheduleStatusWord(status: ScheduleTaskStatus): string {
  switch (status) {
    case 'active': return 'Active'
    case 'paused': return 'Paused'
    case 'ended': return 'Ended'
  }
}

/** `‣ Active` / `‣ Paused` / `‣ Ended`. This is the TASK status only. */
export function scheduleStatusText(entry: ScheduleCatalogEntry): string {
  return `${scheduleStatusMarker(entry.status)} ${scheduleStatusWord(entry.status)}`
}

/**
 * Format one official RFC 3339 instant as the CANONICAL UTC value the Host
 * committed. Display only: the instant comes from the official record and is
 * never recomputed, and no Client-local zone is ever inferred (a Split Client
 * may sit in a different zone than the Host rule).
 */
export function formatLocalInstant(instant: string): string {
  return instant
}

/** The official time zone of one rule. `at`, `after` and `every` records carry
 * only a canonical UTC instant, so their official zone label is UTC.
 */
export function officialTimeZone(record: ScheduleCatalogEntry): string {
  return 'timeZone' in record ? record.timeZone : 'UTC'
}

/**
 * The occurrence prefix. An ACTIVE record has a next obligation, a PAUSED one
 * keeps its stored (not yet executed) occurrence, and only an ENDED one has a
 * final occurrence — a pause never means "already executed".
 */
export function occurrencePrefix(record: ScheduleCatalogEntry): 'next' | 'scheduled' | 'final' {
  if (record.status === 'active') return 'next'
  return record.status === 'ended' ? 'final' : 'scheduled'
}

/**
 * The official occurrence formatted locally for display and labelled with the
 * rule's official zone. The value always comes from `record.scheduledAt`; no
 * cron/RRULE evaluation happens here.
 */
export function formatOccurrence(record: ScheduleCatalogEntry): string {
  return `${occurrencePrefix(record)} ${formatLocalInstant(record.scheduledAt)} · ${officialTimeZone(record)}`
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

/**
 * The official rule summary. Wall-clock kinds show their stored time and zone,
 * the cron expression and RRULE text are shown verbatim (never interpreted),
 * and the one-shot kinds show their stored instant/delay.
 */
export function formatRuleSummary(record: ScheduleCatalogEntry): string {
  switch (record.kind) {
    case 'after':
      return `after ${formatSeconds(record.afterSeconds)}`
    case 'at':
      return `at ${formatLocalInstant(record.scheduledAt)} UTC`
    case 'every':
      return `every ${formatSeconds(record.everySeconds)}`
    case 'daily':
      return `daily ${record.time} · ${record.timeZone}`
    case 'weekly': {
      const days = record.weekdays.map(day => WEEKDAY_LABELS[day] ?? String(day)).join(', ')
      return `weekly ${record.time} · ${record.timeZone} · ${days}`
    }
    case 'cron':
      return `cron "${record.expression}" · ${record.timeZone}`
    case 'rrule':
      return `rrule ${record.rrule}`
  }
}

/** `target session <id>`, `target new_once`, or `target new` (plain text: the
 *  arrow is an EAW-ambiguous glyph and is not part of this surface's chrome). */
export function formatTargetSummary(target: ScheduleTarget): string {
  switch (target.kind) {
    case 'session':
      return `target session ${target.sessionId}`
    case 'new_once':
      return 'target new_once'
    case 'new':
      return 'target new'
  }
}

/** The official execution activity of the reused target Session. Never a task status. */
export function formatExecutionActivity(entry: ScheduleCatalogEntry): string {
  return entry.executionActive === true ? 'in progress' : 'idle'
}

/** The official delivery floor, formatted locally. Never a task status. */
export function formatDeliveryFloor(entry: ScheduleCatalogEntry): string | undefined {
  return entry.deliveryFloorEndsAt === undefined
    ? undefined
    : `until ${formatLocalInstant(entry.deliveryFloorEndsAt)} UTC`
}

/** The official facts of one stored delivery receipt. */
export interface DeliveryFacts {
  readonly scheduledAt: string
  readonly deliveredAt: string
  readonly messageId: string
  readonly targetSessionId: string
}

/** Project one receipt into its display facts (no clock, no derivation). */
export function deliveryFacts(receipt: ScheduleDeliveryReceipt): DeliveryFacts {
  return {
    scheduledAt: `${formatLocalInstant(receipt.scheduledAt)} UTC`,
    deliveredAt: `${formatLocalInstant(receipt.deliveredAt)} UTC`,
    messageId: receipt.messageId,
    targetSessionId: receipt.targetSessionId,
  }
}

/** A human delay/interval: `60 seconds`, `1 second`. */
export function formatSeconds(seconds: number): string {
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}

/** The shortest distinctive tail of a task identity, for confirmations. */
export function shortScheduleId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8)
}
