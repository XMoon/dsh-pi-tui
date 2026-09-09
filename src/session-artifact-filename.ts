/**
 * The fixed artifact filenames (Pre-Stage-D export convergence): the archive
 * filename is upstream-authoritative (`sessionLogZipFilename`), and the
 * transcript filename uses the SAME safe full Session id convention (the
 * upstream safe-segment helper is private; this mirrors it exactly and is
 * test-pinned against the upstream archive filename parity). The filename is
 * owned by the command/artifact and is never user input.
 * @module @xmoon76/dsh-pi-tui/session-artifact-filename
 */

import { sessionLogZipFilename } from '@deepseek-ai/dsh-session-log-export'

/** One filesystem-safe path segment from a Session id (the upstream archive
 * convention: every non `[A-Za-z0-9_-]` character becomes `_`). */
export function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The fixed artifact filename for one Session: the full safe Session id
 * plus the artifact extension. The archive name is the official DSH
 * convention; the transcript name shares the same safe-id normalization. */
export function sessionArtifactFilename(sessionId: string, kind: 'archive' | 'transcript'): string {
  if (kind === 'archive') return sessionLogZipFilename(sessionId)
  return `dsh-session-${safeSessionIdSegment(sessionId)}.md`
}
