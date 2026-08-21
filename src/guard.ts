/**
 * Cross-process divergence guard.
 *
 * dsh's session persistence has no cross-process coordination: each process
 * numbers events with its own in-memory log length (`seq = log.length`) and
 * appends to the same file, so two processes holding one session can mint the
 * same seq and corrupt the log (the classic shape is a `session/end-seed`
 * resume marker colliding with the other process's next append). This guard
 * detects the OTHER writer *before* this process appends: whenever the
 * persisted file's committed event count exceeds this process's in-memory
 * `session.events.length`, an external process has written — continuing would
 * collide.
 *
 * Cost control: a cheap `fs.stat` gate compares the file against the last
 * observed revision; the full committed read (`readFrom`) only runs when the
 * file actually changed since the last consistent check.
 *
 * The guard is deliberately narrow and structural (like `sessions.ts`): it
 * declares only the `sessionPersistence` methods it uses, so it never drags
 * the dsh type graph into the bundle.
 *
 * Force override: a blocked submission mints a ONE-TIME token binding the
 * session, the file revision observed at block time, the write action
 * (`submit` Enter vs `save` Ctrl+S) and a fingerprint of the draft. A second
 * operation only bypasses the guard when every binding still matches; the
 * token is consumed by the force and by every event that could invalidate it
 * (new revision observed, session switch, turn boundaries, editor edits —
 * the latter through the fingerprint, which changes with the draft).
 * @module @xmoon76/dsh-pi-tui/guard
 */

import { createHash } from 'node:crypto'

/** The live-session surface the guard compares against the file. */
export interface GuardSessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  readonly events: readonly unknown[]
}

/** The persistence surface the guard needs: locate + detached file read. */
export interface GuardPersistenceLike {
  /** Resolve the backend artifact path for a session header. */
  locate(meta: { id: string; cwd?: string }): { kind: string; path: string } | undefined
  /** Detached physical committed-prefix read; rejects on corruption. */
  readFrom(id: string, fromSeq: number, signal?: AbortSignal): Promise<{ events: readonly unknown[] }>
}

/** Injectable `fs.statSync`-shaped probe. */
export interface GuardStatLike {
  (path: string): { size: number; mtimeMs: number }
}

/**
 * Mutable per-session guard cursor. `revision` is the file stat observed at
 * the last check; `diverged` latches the bad state so an unchanged file keeps
 * blocking until it changes again and reads clean; `fileEvents` remembers the
 * last observed committed count for stable reporting; `error` latches an
 * unreadable-log diagnosis. `tailMismatch` latches the same-count/different-
 * tail divergence kind, with the last observed tail identities for reporting.
 */
export interface GuardState {
  revision: string
  diverged: boolean
  tailMismatch: boolean
  fileEvents: number
  fileTail: string
  memoryTail: string
  error: string | undefined
}

/** Fresh guard state: forces one real read on the first check. */
export function freshGuardState(): GuardState {
  return { revision: '', diverged: false, tailMismatch: false, fileEvents: 0, fileTail: '', memoryTail: '', error: undefined }
}

export type GuardOutcome =
  /** No external writer; safe to append. */
  | { kind: 'ok'; revision: string; fileEvents?: number }
  /** The file has more committed events than this process's memory. */
  | { kind: 'diverged'; revision: string; fileEvents: number; memoryEvents: number }
  /**
   * The file has the same or fewer committed events than memory, but its
   * tail event does not match the memory event at the same index — the log
   * was rewritten by another writer (count alone cannot see this).
   */
  | {
      kind: 'tail-mismatch'
      revision: string
      fileEvents: number
      memoryEvents: number
      fileTail: string
      memoryTail: string
    }
  /** The file was observed earlier in this process but has since disappeared. */
  | { kind: 'removed'; revision: string }
  /** The committed prefix cannot be read (corrupt or mid-write). */
  | { kind: 'unreadable'; revision: string; error: string }
  /** The guard cannot run for this deployment/session; do not block. */
  | { kind: 'unavailable'; revision: string; reason: 'no-persistence' | 'no-artifact' }

/** The two guardable write actions: Enter submit and Ctrl+S save/steer. */
export type GuardAction = 'submit' | 'save'

/**
 * One-time force-override token. Minted when a submission is blocked; a
 * later operation may force only when session id, file revision, action and
 * draft fingerprint ALL match, and the token is consumed by the force.
 */
export interface GuardForceToken {
  sessionId: string
  revision: string
  action: GuardAction
  draftFingerprint: string
}

/**
 * Lightweight stable fingerprint of a draft, for in-process consistency
 * checks only (never persisted, never logged, never compared across
 * processes). sha256 truncated to 16 hex chars is plenty for a collision
 * between two different drafts of the same user in the same process.
 */
export function draftFingerprint(draft: string): string {
  return createHash('sha256').update(draft, 'utf8').digest('hex').slice(0, 16)
}

/**
 * The Ctrl+S effective-payload identity: the queued message ids in delivery
 * order (next-turn followups first, then next-step steers) plus the draft.
 * The save force token must bind THIS — a blocked save followed by a local
 * queue splice (add/remove/replace/move) changes the identity, so the
 * retry can never force a DIFFERENT payload through an old token. The
 * identity never includes message content (ids only), so nothing sensitive
 * feeds the fingerprint.
 */
export function savePayloadIdentity(queued: readonly { id: string }[], draft: string): string {
  return `${queued.map(message => message.id).join(',')}|${draft}`
}

/**
 * Whether a candidate second operation may consume the token: same session,
 * same observed file revision, same action, same draft fingerprint. Any
 * difference (edited draft, Ctrl+S vs Enter swap, session switch, file
 * changed again) invalidates the token.
 */
export function forceTokenAllows(
  token: GuardForceToken | undefined,
  candidate: {
    sessionId: string
    revision: string
    action: GuardAction
    draftFingerprint: string
  },
): token is GuardForceToken {
  return token !== undefined
    && token.sessionId === candidate.sessionId
    && token.revision === candidate.revision
    && token.action === candidate.action
    && token.draftFingerprint === candidate.draftFingerprint
}

/** Mint a fresh one-time force token for a blocked submission. */
export function mintForceToken(params: {
  sessionId: string
  revision: string
  action: GuardAction
  draftFingerprint: string
}): GuardForceToken {
  return { ...params }
}

/**
 * A stable, content-free identity for one event's tail position:
 * `seq:type:hash-of-data`. The hash is one-way and only ever used for
 * equality comparison, so no prompt/API-key content escapes into
 * diagnostics. Returns undefined when the event is not a well-formed
 * session event (then the caller skips the tail check).
 */
function tailIdentity(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const candidate = event as { seq?: unknown; type?: unknown; data?: unknown }
  if (typeof candidate.seq !== 'number' || typeof candidate.type !== 'string') return undefined
  let summary = '?'
  try {
    summary = createHash('sha256').update(JSON.stringify(candidate.data ?? null)).digest('hex').slice(0, 12)
  } catch {
    // Unserializable data: the seq:type prefix still identifies the position.
  }
  return `${candidate.seq}:${candidate.type}:${summary}`
}

function statRevision(stat: { size: number; mtimeMs: number }): string {
  return `${stat.size}:${stat.mtimeMs}`
}

/**
 * Check whether an external process has written the session since the last
 * consistent observation. Mutates `state` (revision + divergence latch).
 * Never throws.
 */
export async function checkDivergence(
  persistence: GuardPersistenceLike | undefined,
  session: GuardSessionLike,
  stat: GuardStatLike,
  state: GuardState,
): Promise<GuardOutcome> {
  if (persistence === undefined) {
    return { kind: 'unavailable', revision: state.revision, reason: 'no-persistence' }
  }
  const artifact = persistence.locate({ id: session.id, cwd: session.header?.cwd })
  if (artifact === undefined) {
    return { kind: 'unavailable', revision: state.revision, reason: 'no-artifact' }
  }

  let current: { size: number; mtimeMs: number }
  try {
    current = stat(artifact.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A missing artifact is a fresh session (lazy materialization): nothing
      // external can have written it. But when this process already observed
      // a committed file earlier, disappearance means the log was removed
      // externally — the next append would ENOENT and could take down the
      // process, so block before the write instead.
      if (state.revision !== '') {
        state.diverged = true
        return { kind: 'removed', revision: state.revision }
      }
      return { kind: 'ok', revision: state.revision }
    }
    // Anything else is unreadable.
    state.diverged = true
    state.tailMismatch = false
    return { kind: 'unreadable', revision: state.revision, error: error instanceof Error ? error.message : String(error) }
  }
  const revision = statRevision(current)

  // File untouched since the last consistent check: nothing new to learn.
  if (revision === state.revision) {
    if (!state.diverged) return { kind: 'ok', revision }
    if (state.error !== undefined) {
      return { kind: 'unreadable', revision, error: state.error }
    }
    if (state.tailMismatch) {
      return {
        kind: 'tail-mismatch',
        revision,
        fileEvents: state.fileEvents,
        memoryEvents: session.events.length,
        fileTail: state.fileTail,
        memoryTail: state.memoryTail,
      }
    }
    return { kind: 'diverged', revision, fileEvents: state.fileEvents, memoryEvents: session.events.length }
  }

  let fileEvents: number
  let fileTail: string | undefined
  let memoryTail: string | undefined
  try {
    const stored = await persistence.readFrom(session.id, 0)
    fileEvents = stored.events.length
    // Tail identity comparison (only meaningful when both sides have the
    // event at the same index): same count but a different tail means the
    // file was rewritten by another writer — the next append would mint the
    // same seq as theirs and corrupt the log, exactly like a count lead.
    if (fileEvents >= 1) fileTail = tailIdentity(stored.events[fileEvents - 1])
    if (fileEvents >= 1 && session.events.length >= fileEvents) {
      memoryTail = tailIdentity(session.events[fileEvents - 1])
    }
  } catch (error) {
    state.revision = revision
    state.diverged = true
    state.tailMismatch = false
    state.fileEvents = -1
    state.error = error instanceof Error ? error.message : String(error)
    return { kind: 'unreadable', revision, error: state.error }
  }

  const memoryEvents = session.events.length
  state.revision = revision
  state.fileEvents = fileEvents
  state.error = undefined
  if (fileEvents > memoryEvents) {
    state.diverged = true
    state.tailMismatch = false
    return { kind: 'diverged', revision, fileEvents, memoryEvents }
  }
  if (fileTail !== undefined && memoryTail !== undefined && fileTail !== memoryTail) {
    state.diverged = true
    state.tailMismatch = true
    state.fileTail = fileTail
    state.memoryTail = memoryTail
    return { kind: 'tail-mismatch', revision, fileEvents, memoryEvents, fileTail, memoryTail }
  }
  state.diverged = false
  state.tailMismatch = false
  return { kind: 'ok', revision, fileEvents }
}
