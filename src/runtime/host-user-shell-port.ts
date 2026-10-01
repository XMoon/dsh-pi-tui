/**
 * The Host user-shell execution domain port (shell amendment, M3-4 PR3):
 * `!` and `!!` are both Host-side user-shell operations — they differ only in
 * whether the completed result enters Session/model context, and that routing
 * decision lives in the application submission owner, NEVER here. `bypass` and
 * `sandbox` are Host execution policies, not locality choices.
 *
 * The Client owns the gesture, editor mode, shell card and presentation; the
 * Host owns cwd/workspace, PATH/environment, shell discovery, the process,
 * exit status and process cancellation. This port exposes exactly that
 * execution authority and nothing else: no `ctx.shell`, no
 * `child_process.ChildProcess`, no PTY screen parser, no raw Host Context and
 * no generated Remote object ever crosses it.
 *
 * Full contract: docs/client-server-migration.md (user shell section) +
 * docs/client-server-coupling.md (user shell ownership).
 * @module @xmoon76/dsh-pi-tui/runtime/host-user-shell-port
 */

/** The Host execution policy for one user-shell run. `bypass` is the
 * user/system execution policy (default); `sandbox` is the Host sandboxed
 * execution policy. Neither is a locality choice. */
export type HostUserShellPolicy = 'bypass' | 'sandbox'

/** One authoritative chunk of execution output, in arrival order. */
export interface HostUserShellOutputChunk {
  /** Decoded text bytes of this chunk (stream-split multi-byte sequences
   * already assembled by the owning adapter). */
  readonly text: string
  /** Wire byte count of this chunk as received from the process. */
  readonly bytes: number
  /** Which stream this chunk came from. */
  readonly stream: 'stdout' | 'stderr'
}

/** How one Host user-shell run settled. */
export type HostUserShellExit =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: string }

/** The final settled result of one Host user-shell run. OUTPUT AUTHORITY:
 * `output()` is the one authority for the run's bytes — `result()` carries
 * ONLY the exit/settlement facts. The application must drain `output()`
 * (which ends at settle) before treating its own bounded capture as
 * complete; the adapter retains no unbounded copy of the stream. */
export interface HostUserShellResult {
  readonly exit: HostUserShellExit
  /** Whether the run was ended by the caller's abort rather than its own
   * exit. An aborted run is a settled run; its partial output is real. */
  readonly aborted: boolean
}

/** Why a Host user-shell execution is unavailable. */
export interface HostUserShellUnavailable {
  /** Stable reason code (surfaced to the user verbatim via the message). */
  readonly reason: 'carrier-gap' | 'policy-unavailable'
  /** User-facing explanation (already localized to the TUI's language). */
  readonly message: string
}

/**
 * One in-flight Host user-shell execution, owned by the adapter. The handle
 * settles EXACTLY once: `result()` resolves with the authoritative exit and
 * the complete output, never rejects for a command-level failure (a nonzero
 * exit, a kill by the caller's abort, or an executor timeout is a RESULT);
 * it rejects only for infrastructure failures (an unusable working directory,
 * a missing shell) — the caller then knows nothing executed.
 */
export interface HostUserShellExecution {
  /**
   * The authoritative settled exit/settlement facts; resolves exactly once.
   * Resolving does NOT imply the caller drained `output()` — the two settle
   * independently; `output()` ends at run settle and the application joins
   * the drain before using its own capture.
   */
  result(): Promise<HostUserShellResult>
  /**
   * THE output authority: every decoded chunk in arrival order, exactly once
   * per subscriber; the iteration ENDS when the run settles (the adapter
   * delivers any buffered tail chunks first). The adapter keeps only a
   * bounded internal buffer for slow subscribers — never an unbounded copy.
   */
  output(): AsyncIterable<HostUserShellOutputChunk>
}

/** The semantic request for one Host user-shell run. */
export interface HostUserShellRequest {
  /** The Session whose Host workspace the run executes in. */
  readonly sessionId: string
  /** The Host workspace path for the run (Session cwd). */
  readonly cwd: string
  /** The command line exactly as the user typed it (no `!` prefix). */
  readonly command: string
  /** The Host execution policy selected by the user's persisted preference. */
  readonly policy: HostUserShellPolicy
  /** Caller-owned cancellation; the adapter forwards it to the Host process. */
  readonly signal: AbortSignal
}

/** The outcome of one Host user-shell admission. */
export type HostUserShellAdmission =
  | { readonly kind: 'executing'; readonly execution: HostUserShellExecution }
  | { readonly kind: 'unavailable'; readonly reason: HostUserShellUnavailable }

/** The truthfulness state of the port itself, read before any admission. */
export interface HostUserShellAvailability {
  /** Whether this backend can execute user-shell commands at all. */
  readonly supported: boolean
  /** Which Host execution policies this backend can serve. */
  readonly policies: readonly HostUserShellPolicy[]
}

/**
 * The Host user-shell execution domain port. Direct is served by the
 * in-process Host adapter; the Remote adapter reports the truthful
 * unavailable state (CARRIER_GAP at rc.2) and executes NOTHING.
 */
export interface HostUserShellPort {
  /** The static availability read (no side effects). */
  readonly availability: HostUserShellAvailability
  /** Admit one user-shell run; never throws for a capability gap. */
  execute(request: HostUserShellRequest): Promise<HostUserShellAdmission>
}
