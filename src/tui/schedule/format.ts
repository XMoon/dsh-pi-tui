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
 * The ONE status marker set the frozen workspace contract paints
 * (`● active`, `○ paused`, `– ended`).
 */
export function scheduleStatusMarker(status: ScheduleTaskStatus): string {
  switch (status) {
    case 'active': return '●'
    case 'paused': return '○'
    case 'ended': return '–'
  }
}

/** The user-facing word for an official task status. */
export function scheduleStatusWord(status: ScheduleTaskStatus): string {
  switch (status) {
    case 'active': return 'active'
    case 'paused': return 'paused'
    case 'ended': return 'ended'
  }
}

/** `● active` / `○ paused` / `– ended`. This is the TASK status only. */
export function scheduleStatusText(entry: ScheduleCatalogEntry): string {
  return `${scheduleStatusMarker(entry.status)} ${scheduleStatusWord(entry.status)}`
}

/**
 * Format one official RFC 3339 instant in the terminal user's LOCAL zone.
 * This is display only: correctness never depends on the local clock, and the
 * instant is never recomputed from a rule.
 */
export function formatLocalInstant(instant: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return instant
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The official time zone of one rule. `at`, `after` and `every` records carry
 * only a canonical UTC instant, so their official zone label is UTC.
 */
export function officialTimeZone(record: ScheduleCatalogEntry): string {
  return 'timeZone' in record ? record.timeZone : 'UTC'
}

/** The occurrence prefix: only an ACTIVE record has a next occurrence. */
export function occurrencePrefix(record: ScheduleCatalogEntry): 'next' | 'final' {
  return record.status === 'active' ? 'next' : 'final'
}

/**
 * The official occurrence formatted locally for display and labelled with the
 * rule's official zone. The value always comes from `record.scheduledAt`; no
 * cron/RRULE evaluation happens here.
 */
export function formatOccurrence(record: ScheduleCatalogEntry): string {
  return `${occurrencePrefix(record)} ${formatLocalInstant(record.scheduledAt)} local · ${officialTimeZone(record)}`
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
      return `at ${formatLocalInstant(record.scheduledAt)} local`
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

/** `→ session <id>`, `→ new_once`, or `→ new`. */
export function formatTargetSummary(target: ScheduleTarget): string {
  switch (target.kind) {
    case 'session':
      return `→ session ${target.sessionId}`
    case 'new_once':
      return '→ new_once'
    case 'new':
      return '→ new'
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
    : `until ${formatLocalInstant(entry.deliveryFloorEndsAt)} local`
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
    scheduledAt: `${formatLocalInstant(receipt.scheduledAt)} local`,
    deliveredAt: `${formatLocalInstant(receipt.deliveredAt)} local`,
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
