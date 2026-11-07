/**
 * The Schedule workspace presentation contract (S5-PR4): the ONE snapshot the
 * PiTui panel paints and the ONE intent set the panel dispatches. It carries
 * only official Schedule records plus UI state; it never carries a second task
 * model, a persisted client copy or a Host handle.
 *
 * @module @xmoon76/dsh-pi-tui/app/schedule/presentation
 */

import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleRunResult,
  ScheduleViewResult,
} from '../../runtime/schedule-port.ts'
import type { ScheduleEditorDraft, ScheduleTimingKind, ScheduleTargetKind } from '../../domain/schedule/form.ts'

export type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleRunResult,
  ScheduleViewResult,
  ScheduleEditorDraft,
  ScheduleTimingKind,
  ScheduleTargetKind,
}

/** The list filter. `all` is the unfiltered Host catalog projection. */
export type ScheduleFilter = 'all' | 'active' | 'paused' | 'ended'

/** The workspace read state. `stale` keeps the last successful rows visible
 *  while the newest read failed; `error` has no successful snapshot at all. */
export type ScheduleWorkspaceStatus = 'loading' | 'ready' | 'stale' | 'error'

/** One newest-first page of saved deliveries, plus this workspace's read
 *  state for that page. */
export interface ScheduleHistoryView {
  readonly status: 'loading' | 'ready' | 'error'
  readonly records: readonly {
    readonly scheduledAt: string
    readonly deliveredAt: string
    readonly messageId: string
    readonly prompt?: string
  }[]
  readonly earlierRecordsUnavailable: boolean
  readonly earlierRecordsPruned: boolean
  /** The cursor for the next page; present only while older records remain. */
  readonly nextBefore?: string
  /** The exact official miss code when the page cursor or the task vanished. */
  readonly missCode?: 'schedule_not_found' | 'delivery_cursor_not_found'
  readonly message?: string
}

/** The ONE pending confirmation. Exactly one question is open at a time, and
 *  its `token` is the generation a `y` commits against. */
export type ScheduleConfirm =
  | {
    readonly kind: 'delete'
    readonly token: number
    readonly id: string
    readonly title: string
    readonly shortId: string
    /** The CAS revision captured WHEN THE QUESTION OPENED: the confirmed task
     *  version is frozen, so a change during the confirmation is a conflict
     *  instead of deleting content the user never saw. */
    readonly expectedUpdatedAt: string | null
  }
  | { readonly kind: 'clear-ended'; readonly token: number }
  | { readonly kind: 'run'; readonly token: number; readonly id: string; readonly title: string }
  | { readonly kind: 'discard'; readonly token: number }

/** One non-modal outcome line the panel paints (never a Host fact store). */
export interface ScheduleNotice {
  readonly text: string
  readonly kind: 'info' | 'error'
}

/** One Session candidate the `session` target chooser offers: a listed,
 *  non-subagent Session with its projection title when the Host supplied one. */
export interface ScheduleSessionChoice {
  readonly id: string
  readonly title?: string
}

/** The complete painted state of the Schedule workspace. */
export interface ScheduleWorkspaceSnapshot {
  readonly status: ScheduleWorkspaceStatus
  /** The failure that left the workspace stale/error, safe for display. */
  readonly statusMessage?: string
  readonly filter: ScheduleFilter
  readonly query: string
  /** The authoritative Host rows, projected by the current filter/search. */
  readonly rows: readonly ScheduleCatalogEntry[]
  /** The number of Host tasks BEFORE the filter/search projection. */
  readonly total: number
  readonly selectedId?: string
  readonly mode: 'list' | 'detail' | 'history' | 'editor' | 'help'
  /** The detail snapshot (the official `view` value). */
  readonly detail?: ScheduleCatalogEntry
  readonly history?: ScheduleHistoryView
  readonly editor?: ScheduleEditorDraft
  readonly confirm?: ScheduleConfirm
  readonly notice?: ScheduleNotice
  readonly limits?: { readonly newSessionIntervalSeconds: number }
  readonly sessions: readonly ScheduleSessionChoice[]
  /** A Host mutation is in flight; the panel refuses a second one. */
  readonly busy: boolean
}

/** Every action the panel can request. The controller owns all semantics; the
 *  panel never reads a Host and never mutates a task directly. */
export type ScheduleIntent =
  | { readonly kind: 'set-filter'; readonly filter: ScheduleFilter }
  | { readonly kind: 'set-query'; readonly query: string }
  | { readonly kind: 'move'; readonly delta: number }
  | { readonly kind: 'open-detail'; readonly id?: string }
  | { readonly kind: 'open-history' }
  | { readonly kind: 'history-more' }
  /** Esc: one layer back (help → confirm → editor → history → detail → list). */
  | { readonly kind: 'back' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'open-create' }
  | { readonly kind: 'open-edit' }
  | { readonly kind: 'focus-field'; readonly index: number }
  | { readonly kind: 'next-field'; readonly delta: number }
  | { readonly kind: 'set-field'; readonly fieldId: string; readonly value: string }
  | { readonly kind: 'select-timing-kind'; readonly timing: ScheduleTimingKind }
  | { readonly kind: 'toggle-weekday'; readonly weekday: number }
  | { readonly kind: 'select-target-kind'; readonly target: ScheduleTargetKind }
  | { readonly kind: 'select-target-session'; readonly sessionId: string }
  | { readonly kind: 'toggle-advanced' }
  | { readonly kind: 'save' }
  /** Re-read the current task and rebase the draft's CAS revision on it,
   *  keeping every typed field (the explicit conflict recovery: no silent
   *  merge, no automatic overwrite). */
  | { readonly kind: 'reload-latest' }
  | { readonly kind: 'toggle-active' }
  | { readonly kind: 'ask-run' }
  | { readonly kind: 'ask-delete' }
  | { readonly kind: 'ask-clear-ended' }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'open-help' }
  | { readonly kind: 'close-help' }
  | { readonly kind: 'dismiss-notice' }

/** The ONE statement of each required product outcome (plan §8). */
export const SCHEDULE_COPY = {
  serviceUnavailable: 'Schedule service is unavailable on this Host.',
  taskGone: 'Task no longer exists. Reload tasks.',
  conflict: 'Task changed on the Host. Review latest before saving.',
  executionPending: 'Run not started: another execution is pending.',
  historyChanged: 'Delivery history changed. Reopen history.',
  targetArchived: 'Target Session is archived. Choose another.',
  permissionDenied: 'Schedule permission denied.',
  outcomeUnknown: 'Outcome unknown. Refresh before retrying.',
  updated: 'Updated',
  reloaded: 'Loaded the latest Host revision. Re-apply the changes you still want, then save.',
  deliveryQueued: 'Delivery queued',
  noEnded: 'No ended tasks to clear.',
  cleared: (count: number) => `Cleared ${count} ended tasks.`,
  invalid: (detail: string) => `Invalid schedule input: ${detail}.`,
} as const
