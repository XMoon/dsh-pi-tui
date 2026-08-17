/**
 * Open-time session lock: prevent two dsh processes from holding one session.
 *
 * dsh has no cross-process session coordination: two processes can resume the
 * same session, and the SECOND resume makes the persistence layer synthesize
 * interrupted-turn closers into the shared log while the FIRST process keeps
 * appending from its own in-memory seq — the classic seq collision that
 * corrupts the log (the `session/end-seed` marker colliding with the other
 * process's next append). The divergence guard (`guard.ts`) only protects the
 * WRITE path: it compares the file's committed event count against this
 * process's memory right before an append, so a second process that resumes
 * while the first is mid-turn sees a file that matches its own freshly loaded
 * memory and sails through — the corruption happens later, on the FIRST
 * process's next append.
 *
 * This module closes the OPEN path: whoever resumes a session first records a
 * tiny lock file next to the session log; a second process attempting to open
 * the same session finds the lock, verifies whether the owning process is
 * actually alive and still the same dsh invocation, and refuses when it is.
 *
 * Lock lifecycle:
 * - acquire (`O_CREAT|O_EXCL`): the first opener wins. The lock file records
 *   the owner's pid, its `/proc/<pid>/stat` starttime (the pid-reuse guard),
 *   the profile, and a human-readable start time.
 * - release: the owner deletes the file on a clean exit or session switch.
 *   Idempotent — a missing file is not an error.
 * - stale takeover: a crashed/killed owner leaves the file behind. The next
 *   opener reads it and probes the recorded pid against /proc: a missing
 *   process, a zombie, a reused pid (starttime mismatch) or a different
 *   executable is a STALE lock and is taken over atomically.
 * - No heartbeat: the lock means "this process holds the session", not "this
 *   process is currently writing". A live, matching owner is a valid lock
 *   even while idle (SIGSTOP, long GC, laptop sleep) — expiring it early
 *   would create the exact double-writer window the lock exists to prevent.
 *
 * The lock only guards TUI-vs-TUI opens. A web surface or an older TUI that
 * knows nothing about the lock can still write concurrently; the divergence
 * guard remains the write-path backstop and is deliberately untouched.
 *
 * The module is deliberately narrow and structural (like `guard.ts`): it
 * declares only the filesystem and /proc surfaces it uses, injected so the
 * headless suite can drive every branch without a real process.
 * @module @xmoon76/dsh-pi-tui/session-lock
 */

/** The owner record written into the lock file. */
export interface SessionLockInfo {
  /** Owner process id. */
  pid: number
  /** `/proc/<pid>/stat` field 22 (starttime in ticks) — the pid-reuse guard. */
  starttime: number
  /** Epoch-ms when the lock was taken, for the human-readable notice. */
  startedAt: number
  /** The `dsh --profile` name the owner runs under, when known. */
  profile?: string
  /** The owner's controlling terminal, when known (best-effort). */
  tty?: string
}

/** The session identity the lock resolves against (a `GuardSessionLike`-shaped surface). */
export interface SessionLockSession {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** The persistence surface needed to locate the session's artifact directory. */
export interface SessionLockPersistence {
  locate(meta: { id: string; cwd?: string }): { kind: string; path: string } | undefined
}

/** The filesystem surface the lock needs. `writeFileSync` MUST create
 * exclusively (`wx`) — a plain `w` write would silently overwrite another
 * process's lock and the whole exclusion collapses. */
export interface SessionLockFs {
  readFileSync(path: string): string
  writeFileSync(path: string, content: string, options?: { flag?: string }): void
  unlinkSync(path: string): void
}

/**
 * The /proc probe: decides whether a recorded owner pid still refers to the
 * same live dsh invocation. Injectable so tests can simulate dead/zombie/
 * reused/mismatched owners without real processes.
 */
export interface SessionLockProc {
  /**
   * Probe one recorded owner.
   * @param owner - the lock file's owner record.
   * @param self - this process's identity (for the same-process shortcut).
   * @returns `{ kind: 'alive' }` when the owner is the same live dsh
   *          invocation; `{ kind: 'stale' }` when the process is gone,
   *          zombie, or does not match (pid reused / different program);
   *          `{ kind: 'unknown' }` when the probe cannot verify (no /proc,
   *          permission) — the caller must NOT take the lock over.
   */
  probe(owner: SessionLockInfo, self: SessionLockInfo): { kind: 'alive' } | { kind: 'stale' } | { kind: 'unknown' }
}

/** One lock acquisition attempt's outcome. */
export type SessionLockOutcome =
  /** This process now owns the session. */
  | { kind: 'acquired'; release: () => void }
  /** Another live dsh process owns the session; opening would risk corruption. */
  | { kind: 'held'; owner: SessionLockInfo }
  /** A dead owner's lock was removed and this process took ownership. */
  | { kind: 'taken-over-stale'; release: () => void }
  /** The owner could not be verified; refusing is the safe default. */
  | { kind: 'unverifiable'; owner: SessionLockInfo | undefined }
  /** The deployment cannot lock (no persistence/artifact/write access); do not block. */
  | { kind: 'unavailable'; reason: 'no-persistence' | 'no-artifact' | 'no-lock-dir' | 'write-error' }

/** The lock file name, next to `session.jsonl[.zstd]` in the session directory. */
export const LOCK_FILE_NAME = 'owner.lock'

/** How many times the takeover path retries the atomic create on EEXIST. */
const TAKEOVER_RETRIES = 2

/** A tiny deterministic serializer for the lock record (single-line JSON). */
export function serializeLockInfo(info: SessionLockInfo): string {
  return JSON.stringify(info)
}

/** Parse a lock file's content; malformed content yields undefined. */
export function parseLockInfo(content: string): SessionLockInfo | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid)) return undefined
    if (typeof parsed.starttime !== 'number' || !Number.isSafeInteger(parsed.starttime)) return undefined
    if (typeof parsed.startedAt !== 'number' || !Number.isSafeInteger(parsed.startedAt)) return undefined
    return {
      pid: parsed.pid,
      starttime: parsed.starttime,
      startedAt: parsed.startedAt,
      ...typeof parsed.profile === 'string' ? { profile: parsed.profile } : {},
      ...typeof parsed.tty === 'string' ? { tty: parsed.tty } : {},
    }
  } catch {
    return undefined
  }
}

/** Derive the lock file path from the session artifact path. */
export function lockPathOf(artifactPath: string): string {
  return `${artifactPath}.${LOCK_FILE_NAME}`
}

/**
 * Try to acquire the lock with an atomic create. Returns the path when this
 * process owns it, undefined when another process holds it or the create
 * cannot happen. Never throws.
 */
function tryCreate(
  fs: SessionLockFs,
  lockPath: string,
  self: SessionLockInfo,
): { created: true } | { created: false; reason: 'exists' | 'error' } {
  try {
    // Exclusive create: a plain write would overwrite a live owner's lock.
    fs.writeFileSync(lockPath, serializeLockInfo(self), { flag: 'wx' })
    return { created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
      return { created: false, reason: 'exists' }
    }
    return { created: false, reason: 'error' }
  }
}

/**
 * Acquire the open-time lock for one session.
 *
 * Returns `acquired` (with an idempotent `release`), `held` (another live dsh
 * process owns it), `taken-over-stale` (a dead owner's lock was replaced),
 * `unverifiable` (the owner could not be probed — refuse), or `unavailable`
 * (this deployment cannot lock; callers should proceed as before, the guard
 * still protects the write path). Never throws.
 */
export function acquireSessionLock(
  deps: { persistence: SessionLockPersistence | undefined; fs: SessionLockFs; proc: SessionLockProc },
  session: SessionLockSession,
  self: SessionLockInfo,
): SessionLockOutcome {
  const { persistence, fs, proc } = deps
  if (persistence === undefined) {
    return { kind: 'unavailable', reason: 'no-persistence' }
  }
  const artifact = persistence.locate({ id: session.id, cwd: session.header?.cwd })
  if (artifact === undefined) {
    return { kind: 'unavailable', reason: 'no-artifact' }
  }
  const lockPath = lockPathOf(artifact.path)
  // Whether this acquire already removed a stale owner's lock. A successful
  // create after a removal is a TAKEOVER, not a first open — callers use the
  // distinction for the notice wording.
  let tookOver = false

  for (let attempt = 0; ; attempt += 1) {
    // Missing lock file (or a fresh create attempt): try to take ownership.
    const created = tryCreate(fs, lockPath, self)
    if (created.created) {
      return tookOver
        ? { kind: 'taken-over-stale', release: makeRelease(fs, lockPath) }
        : { kind: 'acquired', release: makeRelease(fs, lockPath) }
    }
    if (created.reason === 'error') {
      // The lock directory may not exist yet for a lazy session, or write
      // permission is missing: do not block the open.
      return { kind: 'unavailable', reason: 'no-lock-dir' }
    }

    // The lock file exists. Read it and decide: same process (allow), a live
    // matching owner (held), a stale owner (take over), or unverifiable.
    let owner: SessionLockInfo | undefined
    try {
      owner = parseLockInfo(fs.readFileSync(lockPath))
    } catch {
      // Unreadable lock file: treat as unverifiable (never destroy a lock we
      // cannot inspect — the owner might be alive).
      return { kind: 'unverifiable', owner: owner }
    }
    if (owner === undefined) {
      // Malformed lock file: refuse rather than guess.
      return { kind: 'unverifiable', owner: owner }
    }
    if (owner.pid === self.pid && owner.starttime === self.starttime) {
      // Same process re-opening its own session (e.g. /sessions back to the
      // current session): the lock is already ours.
      return { kind: 'acquired', release: makeRelease(fs, lockPath) }
    }
    const verdict = proc.probe(owner, self)
    if (verdict.kind === 'alive') {
      return { kind: 'held', owner }
    }
    if (verdict.kind === 'unknown') {
      return { kind: 'unverifiable', owner }
    }
    // Stale: remove and retry the atomic create. A concurrent taker may have
    // recreated the file between our unlink and create; the loop re-reads.
    try {
      fs.unlinkSync(lockPath)
      tookOver = true
    } catch {
      // Already gone — the retry create decides.
    }
    if (attempt >= TAKEOVER_RETRIES) {
      // The lock keeps reappearing under our hands: someone else is taking
      // it over too. Refuse as held (the notice explains the situation).
      return { kind: 'held', owner }
    }
  }
}

/** An idempotent release: removing a missing file is not an error. */
function makeRelease(fs: SessionLockFs, lockPath: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // Already gone (crash cleanup by a takeover, manual removal): fine.
    }
  }
}
