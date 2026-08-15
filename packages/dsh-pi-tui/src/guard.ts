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
 * @module @xmoon76/dsh-pi-tui/guard
 */

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
 * unreadable-log diagnosis.
 */
export interface GuardState {
  revision: string
  diverged: boolean
  fileEvents: number
  error: string | undefined
}

/** Fresh guard state: forces one real read on the first check. */
export function freshGuardState(): GuardState {
  return { revision: '', diverged: false, fileEvents: 0, error: undefined }
}

export type GuardOutcome =
  /** No external writer; safe to append. */
  | { kind: 'ok'; revision: string; fileEvents?: number }
  /** The file has more committed events than this process's memory. */
  | { kind: 'diverged'; revision: string; fileEvents: number; memoryEvents: number }
  /** The committed prefix cannot be read (corrupt or mid-write). */
  | { kind: 'unreadable'; revision: string; error: string }
  /** The guard cannot run for this deployment/session; do not block. */
  | { kind: 'unavailable'; revision: string; reason: 'no-persistence' | 'no-artifact' }

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
    // A missing artifact is a fresh session (lazy materialization): nothing
    // external can have written it. Anything else is unreadable.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', revision: state.revision }
    }
    state.diverged = true
    return { kind: 'unreadable', revision: state.revision, error: error instanceof Error ? error.message : String(error) }
  }
  const revision = statRevision(current)

  // File untouched since the last consistent check: nothing new to learn.
  if (revision === state.revision) {
    if (!state.diverged) return { kind: 'ok', revision }
    return state.error !== undefined
      ? { kind: 'unreadable', revision, error: state.error }
      : { kind: 'diverged', revision, fileEvents: state.fileEvents, memoryEvents: session.events.length }
  }

  let fileEvents: number
  try {
    const stored = await persistence.readFrom(session.id, 0)
    fileEvents = stored.events.length
  } catch (error) {
    state.revision = revision
    state.diverged = true
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
    return { kind: 'diverged', revision, fileEvents, memoryEvents }
  }
  state.diverged = false
  return { kind: 'ok', revision, fileEvents }
}
