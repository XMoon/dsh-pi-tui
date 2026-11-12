/**
 * The CLI Session-launch decision policy (session CLI PR2): pure, UI-neutral
 * classifiers over the official main Session roster and Workspace membership.
 *
 * These functions decide WHICH listed Session a `--session`/`-c` launch names.
 * They perform no Host IO, hold no cache and start no work: the composition
 * root supplies the official `SessionReader.list()` rows and the official
 * Workspace membership, then owns the ONE pre-mount `SessionLifecycle.open()`.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/session-launch-intent
 */

import { findSessionMatch, type SessionMatchRow } from '../../domain/session/browser.ts'

/** The listed-row shape the launch policy reads. */
export interface LaunchSessionRow extends SessionMatchRow {
  /** A subagent child is never an AUTOMATIC main-Session selection. */
  readonly origin?: 'subagent'
}

/** A canonical full Session id: the `session-`/`session_` prefix plus 32 hex
 * characters, optionally written as a hyphenated canonical UUID. A BARE UUID
 * is NOT a canonical Session id — it must match an official listed row. */
const CANONICAL_SESSION_ID = /^session[-_](?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The CLI automatic-prefix rule: at least four ASCII hex digits after the
 * optional `session-`/`session_` prefix. Deliberately stricter than the
 * `/resume` matcher; the CLI must not auto-resume a word-like query. */
const CLI_PREFIX = /^[0-9a-f]{4,}$/i

/** Whether `query` is a canonical full Session id that may be opened WITHOUT
 * a roster read (the explicit full-id launch contract). */
export function canonicalFullSessionId(query: string): boolean {
  return CANONICAL_SESSION_ID.test(query)
}

/** The legal automatic prefix `query` carries, or undefined. The returned
 * value is the bare hex prefix (the leading Session prefix stripped). */
export function cliAutoPrefix(query: string): string | undefined {
  const bare = query.replace(/^session[-_]/i, '')
  return CLI_PREFIX.test(bare) ? bare : undefined
}

/**
 * Resolve one non-canonical `--session` value against the official main
 * roster: an exact official row id first (including historical non-standard
 * ids), then — only for a legal CLI automatic prefix — the SAME unique-prefix
 * primitive `/resume` uses. An ambiguous, missing or word-like query returns
 * undefined so the startup entry opens the Browser with the query instead of
 * guessing.
 */
export function chooseListedSession(rows: readonly LaunchSessionRow[], query: string): string | undefined {
  // A blank query or the bare Session prefix carries no identity: it always
  // searches, even if a malformed listed row happens to carry that exact text.
  if (query === '' || /^session[-_]$/i.test(query)) return undefined
  const exact = rows.find(row => row.id === query)
  if (exact !== undefined) return exact.id
  if (cliAutoPrefix(query) === undefined) return undefined
  // A prefix is shared by MANY ids by construction; an automatic launch must
  // never land on a subagent child.
  const mainRows = rows.filter(row => row.origin !== 'subagent')
  return findSessionMatch(mainRows, query)?.id
}

/**
 * The `-c` choice: the FIRST row of the official main roster that is a
 * non-subagent member of the confirmed Host Workspace. The roster order is
 * kept verbatim (the Host already orders newest-first); this function never
 * re-sorts and never falls back to a different Workspace.
 */
export function chooseContinueSession(
  rows: readonly LaunchSessionRow[],
  workspaceSessionIds: readonly string[],
): string | undefined {
  const members = new Set(workspaceSessionIds)
  return rows.find(row => row.origin !== 'subagent' && members.has(row.id))?.id
}
