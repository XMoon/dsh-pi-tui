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
 * One run is a single foreground ONE-SHOT execution: it settles once with the
 * bounded per-stream output and the real exit/signal facts. There is no
 * incremental chunk stream, no consumption acknowledgement and no second
 * output owner; `execute()` resolves the semantic result (or a truthful
 * unavailable/indeterminate admission).
 *
 * Full contract: docs/architecture/host-client.md (user shell section) +
 * docs/architecture/surface-behavior.md (user shell behavior).
 * @module @xmoon76/dsh-pi-tui/runtime/host-user-shell-port
 */

/** The Host execution policy for one user-shell run. `bypass` is the
 * user/system execution policy (default); `sandbox` is the Host sandboxed
 * execution policy. Neither is a locality choice. */
export type HostUserShellPolicy = 'bypass' | 'sandbox'

/**
 * The retained bounded text of one settled stream. `text` is the TAIL of the
 * stream when `truncated` is true. `spillPath` — when an executor provided
 * one — names a full-stream file on the HOST that produced the run; it is a
 * Host-local fact and is never presented as Client-readable.
 */
export interface HostUserShellOutput {
  readonly text: string
  readonly truncated: boolean
  readonly spillPath?: string
}

/** How one Host user-shell run settled. */
export type HostUserShellExit =
  | { readonly kind: 'exit'; readonly code: number }
  | { readonly kind: 'signal'; readonly signal: string }

/** The final settled result of one one-shot Host user-shell run. Both streams
 * are already bounded and report their own truncation truthfully. */
export interface HostUserShellResult {
  readonly exit: HostUserShellExit
  readonly stdout: HostUserShellOutput
  readonly stderr: HostUserShellOutput
  readonly sandboxDenied: boolean
  /** Whether the run was ended by the caller's abort rather than its own
   * exit. An aborted run is a settled run; its bounded output is real. */
  readonly aborted: boolean
  /** Whether an executor deadline (never a caller abort) cut the run short. */
  readonly timedOut: boolean
}

/** Why a Host user-shell execution is unavailable. */
export interface HostUserShellUnavailable {
  /** Stable reason code (surfaced to the user verbatim via the message). */
  readonly reason: 'carrier-gap' | 'policy-unavailable'
  /** User-facing explanation (already localized to the TUI's language). */
  readonly message: string
}

/** The outcome of one Host user-shell admission. */
export type HostUserShellOutcome =
  | { readonly kind: 'settled'; readonly result: HostUserShellResult }
  | { readonly kind: 'unavailable'; readonly reason: HostUserShellUnavailable }
  | { readonly kind: 'indeterminate'; readonly message: string }

/** A started Remote run lost its terminal fact; automatic replay is forbidden. */
export class HostUserShellOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostUserShellOutcomeUnknownError'
  }
}

/** The Host proved the sandbox runner/enforcement failed for this run. */
export class HostUserShellSandboxRunnerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostUserShellSandboxRunnerError'
  }
}

/** The truthfulness state of the port itself, read before any admission. */
export interface HostUserShellAvailability {
  /** Whether this backend can execute user-shell commands at all. */
  readonly supported: boolean
  /** Which Host execution policies this backend can serve. */
  readonly policies: readonly HostUserShellPolicy[]
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
  /** Caller-owned cancellation; the adapter forwards it to the Host executor. */
  readonly signal: AbortSignal
}

/** The Host user-shell execution domain port. Direct is served by the
 * in-process Host adapter; Remote serves the authenticated Host one-shot
 * invocation and fails admission truthfully when its Host connection is
 * unavailable. */
export interface HostUserShellPort {
  /** The static availability read (no side effects). */
  readonly availability: HostUserShellAvailability
  /** Run one user-shell command to settlement; never throws for a
   * command-level failure. A started Remote run whose terminal fact is lost
   * rejects with {@link HostUserShellOutcomeUnknownError} instead of claiming
   * nothing executed. */
  execute(request: HostUserShellRequest): Promise<HostUserShellOutcome>
}

/** The retained-tail bound of one settled stream. It is the semantic result
 * bound shared by the Host mapping, the private wire decoder and the
 * application's Session text. */
export const MAX_HOST_USER_SHELL_STREAM_BYTES = 64 * 1024
/** Bound on one refusal/failure message carried back to the Client. */
export const MAX_HOST_USER_SHELL_MESSAGE_BYTES = 2 * 1024
/** Bound on a Host-local spill path carried as a semantic fact. */
export const MAX_HOST_USER_SHELL_SPILL_PATH_BYTES = 4 * 1024
/** Total output budget of one settled result across BOTH streams. One stream
 * may use the full per-stream cap; the other is then tail-clamped to the
 * remainder, so the Session text can never grow with two independent caps. */
export const MAX_HOST_USER_SHELL_RESULT_BYTES = 96 * 1024

function tailOnCodePoint(bytes: Buffer, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  if (bytes.length <= maxBytes) return { text: bytes.toString('utf8'), truncated: false }
  let start = bytes.length - maxBytes
  // Never start inside a UTF-8 continuation byte: advancing to the next lead
  // byte keeps the retained tail decodable without a replacement character.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  return { text: bytes.subarray(start).toString('utf8'), truncated: true }
}

/**
 * Map one executor-collected stream to the bounded semantic output. The
 * executor's own truncation fact is preserved; a stream larger than the
 * semantic bound is clamped to its tail and marked truncated here.
 * @param output - the executor's collected output for one stream.
 * @param maxBytes - retained-tail bound (defaults to the per-stream cap).
 * @returns the bounded semantic output.
 */
export function boundedHostUserShellOutput(
  output: {
    readonly text: string
    readonly truncated: boolean
    readonly spillPath?: string
  },
  maxBytes = MAX_HOST_USER_SHELL_STREAM_BYTES,
): HostUserShellOutput {
  const bounded = tailOnCodePoint(Buffer.from(output.text, 'utf8'), maxBytes)
  return {
    text: bounded.text,
    truncated: output.truncated || bounded.truncated,
    ...(output.spillPath === undefined ? {} : { spillPath: output.spillPath }),
  }
}

/**
 * Apply the TOTAL result budget across both streams. The per-stream caps are
 * independent; when both are large the second stream (stderr) is tail-clamped
 * to the remaining total budget and marked truncated, so one Session row can
 * never carry two full per-stream caps.
 * @param stdout - already per-stream bounded stdout.
 * @param stderr - already per-stream bounded stderr.
 * @returns the pair that satisfies the total result bound.
 */
export function boundedHostUserShellResultStreams(
  stdout: HostUserShellOutput,
  stderr: HostUserShellOutput,
): { readonly stdout: HostUserShellOutput; readonly stderr: HostUserShellOutput } {
  const stdoutBytes = Buffer.byteLength(stdout.text, 'utf8')
  if (stdoutBytes + Buffer.byteLength(stderr.text, 'utf8') <= MAX_HOST_USER_SHELL_RESULT_BYTES) {
    return { stdout, stderr }
  }
  const remaining = Math.max(0, MAX_HOST_USER_SHELL_RESULT_BYTES - stdoutBytes)
  return { stdout, stderr: boundedHostUserShellOutput(stderr, remaining) }
}
