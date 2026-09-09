/**
 * The fixed artifact filenames (Pre-Stage-D export convergence): the archive
 * filename mirrors the upstream `sessionLogZipFilename` convention exactly
 * (the upstream safe-segment helper is private; the mirror is test-pinned
 * against the upstream archive filename parity), and the transcript filename
 * uses the SAME safe full Session id convention. The filename is owned by
 * the command/artifact and is never user input. This module is CLIENT_LOCAL
 * and deliberately imports no `@deepseek-ai/*` package — the upstream naming
 * convention is pinned by the parity test instead of a runtime import.
 * @module @xmoon76/dsh-pi-tui/session-artifact-filename
 */

/** One filesystem-safe path segment from a Session id (the upstream archive
 * convention: every non `[A-Za-z0-9_-]` character becomes `_`). */
export function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The fixed artifact filename for one Session: the full safe Session id
 * plus the artifact extension. The archive name mirrors the official DSH
 * convention (`dsh-session-<safe-id>.zip` — test-pinned against the
 * upstream `sessionLogZipFilename`); the transcript name shares the same
 * safe-id normalization. */
export function sessionArtifactFilename(sessionId: string, kind: 'archive' | 'transcript'): string {
  if (kind === 'archive') return `dsh-session-${safeSessionIdSegment(sessionId)}.zip`
  return `dsh-session-${safeSessionIdSegment(sessionId)}.md`
}
