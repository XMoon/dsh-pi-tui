/**
 * The Ctrl+R session-scope persist gate (plan M-gate): an agent-facing
 * submission's history row must be written AFTER the session exists, with
 * the FINAL session id — the first prompt of a deferred start creates the
 * session, and a row written before creation would carry no sessionId and
 * vanish from the `Current session` scope. Sessionless submissions (local
 * commands, `!!` shells) persist with `sessionId: undefined` and stay
 * visible in `Current directory` / `All directories`.
 *
 * Two pieces:
 * - {@link persistHistoryRecord} — the pure persist decision + write (the
 *   dedupe/image guards, the cwd/ts/sessionId snapshot, the append).
 * - {@link persistAfterSession} — the ORDERING gate: resolve the session
 *   FIRST, then persist with the resolved id. The runner uses it in the
 *   submit path; the test pins the ordering so a future "optimization"
 *   that writes before session creation cannot silently regress the first
 *   prompt of a fresh session.
 * @module @xmoon76/dsh-pi-tui/history-persist
 */

import { appendHistoryRecord } from './history.ts'

/** The persist-time facts of one submission row. */
export interface HistoryPersistContext {
  /** The trimmed submission text. */
  content: string
  /** The cwd at persist time (the row's file key — resolved AFTER session
   * creation so the row lands in the session's cwd file and its `cwd`
   * field agrees with the file hash). */
  cwd: string
  /** The session identity at persist time (undefined = sessionless). */
  sessionId: string | undefined
  /** The USER's submission time (epoch-ms) — never the disk-write time. */
  ts: number
  /** The newest known content (consecutive-repeat dedupe). */
  lastContent: string | undefined
  /** Whether the submission carries staged images (never persisted — the
   * placeholder dies with the draft on consume, so an ↑ recall would
   * re-send it as ordinary text). */
  hasImages: boolean
  /** The history file path for the cwd. */
  file: string
}

/** Persist one submission row; returns whether an entry was written. An
 * empty content, a repeat of `lastContent` and an image-bearing submission
 * are skipped without touching the file (shell-history behavior). */
export function persistHistoryRecord(context: HistoryPersistContext): boolean {
  if (context.content === '' || context.content === context.lastContent || context.hasImages) return false
  return appendHistoryRecord(context.file, {
    v: 2,
    content: context.content,
    cwd: context.cwd,
    ts: context.ts,
    sessionId: context.sessionId,
  }, context.lastContent)
}

/**
 * The deferred-start ordering gate: resolve/create the session FIRST, then
 * persist the submission row with the FINAL session id. The first prompt
 * of a deferred start creates the session inside `resolveSession`; a row
 * written before that would carry no sessionId and vanish from the
 * `Current session` scope. A resolution that resolves `undefined` (a
 * sessionless submission) persists the row without a sessionId — it stays
 * reachable in `Current directory` / `All directories`. A resolution that
 * REJECTS (session creation failed) persists nothing: the submission never
 * reached a session.
 * @param resolveSession - resolves the FINAL session id (undefined when no
 * session exists — sessionless submissions).
 * @param persist - persists the row under the resolved id.
 */
export async function persistAfterSession(
  resolveSession: () => Promise<string | undefined>,
  persist: (sessionId: string | undefined) => void,
): Promise<void> {
  const sessionId = await resolveSession()
  persist(sessionId)
}
