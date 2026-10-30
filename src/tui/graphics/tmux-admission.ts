/**
 * Strict admission for the tmux virtual Kitty backend (Image-7B-A).
 *
 * A tmux pane forwards a Kitty graphics APC to the outer terminal only when
 * the pane's `allow-passthrough` option is `all` AND the single ordinary display
 * client is a trustworthy transport topology. Neither fact can be inferred from the
 * TUI's own environment: `TERM_PROGRAM`, `KITTY_WINDOW_ID` and
 * `PI_IMAGE_PROTOCOL` are inherited by the pane and say nothing about which
 * client is attached NOW. This module therefore asks the real tmux server,
 * through fixed argv and without a shell, and fails closed on ANY ambiguity.
 * The client's terminal type is recorded here but only becomes one source of
 * Unicode-placeholder evidence; an unknown renderer continues to the live U1
 * feature probe instead of being rejected at the server boundary.
 *
 * The admission is a one-way latch: once the live client binding, the pane
 * option or the session identity changes, the handle is revoked for the rest of
 * this TUI lifetime. Recovering requires a restart; a new client is never
 * silently adopted and no residency is reused across that boundary.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/tmux-admission
 */

import { execFileSync } from 'node:child_process'

/**
 * The environment variable that gates the tmux virtual backend. Leaving it unset
 * allows the automatic admission attempt; the exact value `1` is the equivalent
 * explicit attempt for users who already configured it. `0` and every other
 * value deny the backend before any tmux query runs.
 */
export const TMUX_KITTY_IMAGES_ENV = 'PI_TUI_TMUX_KITTY_IMAGES'

/**
 * The explicit user assertion that the outer terminal implements Kitty Unicode
 * placeholders (`U=1`) even though it cannot answer the `e=T,U=1` feature
 * query. It replaces ONLY the U1 capability proof: the live tmux
 * transport/identity admission, the one-way revoke and every hard opt-out
 * still apply. Only the exact value `1` is an assertion; leaving it unset runs
 * the automatic feature probe.
 */
export const TMUX_KITTY_PLACEHOLDERS_ENV = 'PI_TUI_TMUX_KITTY_PLACEHOLDERS'

/** Every tmux query is bounded: a hung server may not stall a TUI frame. */
const PROBE_TIMEOUT_MS = 500
/** The fixed output ceiling of one probe command (far above any valid reply). */
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024
/** The short real-probe cache used by the component render path. */
const PROBE_CACHE_TTL_MS = 250

/** The immutable identity of the ONE ordinary display tmux client a handle may use. */
export interface TmuxDisplayIdentity {
  readonly paneId: string
  readonly sessionName: string
  readonly clientName: string
  readonly clientTty: string
  readonly clientTermname: string
  readonly clientTermtype: string
}

/** The tmux Kitty handle keeps the historical name for the same identity shape. */
export interface TmuxKittyIdentity extends TmuxDisplayIdentity {}

export function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/** One `list-clients` record that is an ordinary display terminal. */
export interface TmuxDisplayClient {
  readonly name: string
  readonly tty: string
  readonly session: string
  readonly termname: string
  readonly termtype: string
}

/**
 * Classify every raw `list-clients` record. The server's live
 * `#{client_control_mode}` is the ONLY control-connection authority: `1`
 * explicitly excludes a Control Mode client, `0` is an ordinary display client.
 * Any other value, a missing column or a malformed record fails the whole
 * report closed; a control connection is never inferred from its name or TTY.
 */
export function parseTmuxDisplayClients(report: string): TmuxDisplayClient[] | undefined {
  const displayClients: TmuxDisplayClient[] = []
  // `list-clients` terminates every record with exactly one newline. Remove
  // that one command terminator only: any extra blank/whitespace record must
  // stay visible to the strict six-column parse and fail closed.
  const records = report.endsWith('\n') ? report.slice(0, -1) : report
  for (const line of records.split('\n')) {
    const fields = line.split('\t')
    if (fields.length !== 6) return undefined
    const [name, tty, session, termname, termtype, controlMode] = fields as [
      string, string, string, string, string, string,
    ]
    if (controlMode === '1') continue
    if (controlMode !== '0') return undefined
    displayClients.push({ name, tty, session, termname, termtype })
  }
  return displayClients
}

/**
 * The environment facts a tmux pane may be trusted to report about itself.
 * They are necessary but never sufficient: the real server query below is what
 * decides the live binding.
 */
function environmentAdmits(env: NodeJS.ProcessEnv): boolean {
  const optIn = env[TMUX_KITTY_IMAGES_ENV]
  if (optIn !== undefined && optIn !== '1') return false
  if (!nonEmpty(env.TMUX) || !nonEmpty(env.TMUX_PANE)) return false
  if (env.ZELLIJ !== undefined || env.STY !== undefined) return false
  if (!(env.TERM ?? '').startsWith('tmux')) return false
  if (env.TERM_PROGRAM === 'herdr') return false
  const protocol = (env.PI_IMAGE_PROTOCOL ?? '').toLowerCase()
  if (protocol === 'none' || protocol === '0' || protocol === 'iterm2') return false
  return true
}

/**
 * Run one tmux query with the fixed production argv shape: no shell, a 500 ms
 * timeout and a bounded output buffer. Any failure (missing binary, non-zero
 * exit, timeout, overflow) is indistinguishable from "no answer" and the
 * caller fails closed. The RAW stdout is returned: a caller that parses
 * positional columns must not let whitespace normalization hide a malformed
 * record, while single-value queries may trim their own command terminator.
 */
export function runTmux(args: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf8',
      env,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    })
  } catch {
    return undefined
  }
}

/**
 * The program name tmux recorded from the outer terminal's XTVERSION reply.
 * Kitty replies `kitty(0.41.1)` and Ghostty replies `ghostty 1.4.0`; the
 * program is the first token before a space or parenthesis.
 */
function clientProgramName(termtype: string): string | undefined {
  const match = /^([A-Za-z][A-Za-z0-9._+-]*)(?=\s|\(|$)/.exec(termtype.trim())
  return match?.[1]?.toLowerCase()
}

/**
 * Whether the live tmux client report is one of the terminals already known to
 * implement Kitty Unicode placeholders (`U=1`) from the pre-feature-query
 * compatibility line. This is ONE source of U1 evidence, not an allowlist:
 * every other renderer can still earn admission through the live feature
 * query. The XTVERSION program in `client_termtype` is the authoritative live
 * identity; `client_termname` is only a transport hint and may legitimately be
 * a generic fallback such as `xterm-256color` when the dedicated terminfo is
 * unavailable. It never reads an inherited `TERM_PROGRAM`/`KITTY_WINDOW_ID`.
 */
export function tmuxKittyHasKnownUnicodePlaceholders(identity: TmuxKittyIdentity): boolean {
  const program = clientProgramName(identity.clientTermtype)
  // A real XTVERSION reply (Kitty: `kitty(0.41.1)`, Ghostty: `ghostty 1.4.0`)
  // is sufficient. Requiring a brand-specific client_termname would regress a
  // Kitty/Ghostty client using the generic xterm-256color fallback.
  return program === 'kitty' || program === 'ghostty'
}

/**
 * The environment facts that identify a real tmux pane without guessing any
 * client capability. Empty multiplexer markers are not sessions; a nested
 * `screen`/`tmux`/Zellij/Herdr topology is outside every tmux transport family.
 */
export function tmuxPaneEnvironmentAdmits(env: NodeJS.ProcessEnv): boolean {
  if (!nonEmpty(env.TMUX) || !nonEmpty(env.TMUX_PANE)) return false
  if ((env.ZELLIJ ?? '') !== '') return false
  if ((env.STY ?? '') !== '') return false
  if (!(env.TERM ?? '').startsWith('tmux')) return false
  if (env.TERM_PROGRAM === 'herdr') return false
  return true
}

/**
 * Whether the upstream terminal behind a tmux client is another multiplexer.
 * The identity fields are the live server report, never an inherited
 * `TERM_PROGRAM`/`KITTY_WINDOW_ID`.
 */
export function isNestedTmuxClient(identity: TmuxDisplayIdentity): boolean {
  const termname = identity.clientTermname.toLowerCase()
  const program = clientProgramName(identity.clientTermtype)
  return termname.startsWith('tmux')
    || termname.startsWith('screen')
    || program === 'tmux'
    || program === 'screen'
}

export function sameTmuxDisplayIdentity(left: TmuxDisplayIdentity, right: TmuxDisplayIdentity): boolean {
  return left.paneId === right.paneId
    && left.sessionName === right.sessionName
    && left.clientName === right.clientName
    && left.clientTty === right.clientTty
    && left.clientTermname === right.clientTermname
    && left.clientTermtype === right.clientTermtype
}

/**
 * Probe the ONE ordinary display client of this tmux server and return the
 * immutable pane/session/client binding. This is the shared server half of
 * every tmux transport: the caller decides which additional capability facts
 * (Kitty passthrough, native SIXEL) its own protocol needs.
 *
 * The whole `list-clients` report must parse as strict six-column records;
 * exactly one `client_control_mode=0` client with a non-empty name/tty, whose
 * session is this pane's, is admitted. Control Mode clients are excluded from
 * the display count; any other state fails closed. A nested tmux/screen client
 * is rejected because its own DCS/APC lifetime is a different transport.
 */
export function probeTmuxDisplayIdentity(env: NodeJS.ProcessEnv = process.env): TmuxDisplayIdentity | undefined {
  if (!tmuxPaneEnvironmentAdmits(env)) return undefined
  const paneId = env.TMUX_PANE
  if (paneId === undefined) return undefined

  const sessionName = runTmux(['display-message', '-p', '-t', paneId, '#{session_name}'], env)?.trim()
  if (!nonEmpty(sessionName)) return undefined

  const report = runTmux([
    'list-clients',
    '-F',
    '#{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}\t#{client_control_mode}',
  ], env)
  if (!nonEmpty(report)) return undefined
  const displayClients = parseTmuxDisplayClients(report)
  if (displayClients === undefined || displayClients.length !== 1) return undefined
  const client = displayClients[0]!
  if (
    !nonEmpty(client.name)
    || !nonEmpty(client.tty)
    || !nonEmpty(client.termname)
    || !nonEmpty(client.termtype)
  ) return undefined
  if (client.session !== sessionName) return undefined
  const identity: TmuxDisplayIdentity = {
    paneId,
    sessionName,
    clientName: client.name,
    clientTty: client.tty,
    clientTermname: client.termname,
    clientTermtype: client.termtype,
  }
  if (isNestedTmuxClient(identity)) return undefined

  return identity
}

/**
 * Probe the ONE trusted tmux + Kitty topology, or return undefined.
 *
 * Production order (fixed by the Image-7B-A plan, extended by Image-7C-1):
 *  1. the opt-in is ABSENT (automatic attempt) or exactly `1` (explicit
 *     attempt); `0` and every other value deny before any query runs;
 *  2. a tmux pane environment, not a nested multiplexer, with no protocol
 *     opt-out;
 *  3. the real pane option `allow-passthrough` is exactly `all`;
 *  4. the real pane session name is non-empty;
 *  5. the whole server has exactly ONE ordinary display client
 *     (`client_control_mode=0`), whose session matches the pane and whose
 *     tty/name are non-empty. Explicit Control Mode clients
 *     (`client_control_mode=1`) are excluded from that count and may coexist;
 *     any other/missing control value or malformed record fails closed.
 *
 * The client's terminal name/type are recorded for the U1 evidence decision,
 * but an unknown renderer is NOT rejected here: it may proceed to the live
 * `e=T,U=1` feature probe. A live client that identifies itself as another
 * tmux/screen instance IS rejected: nested multiplexers remain outside this
 * transport contract.
 */
export function probeTmuxKittyIdentity(env: NodeJS.ProcessEnv = process.env): TmuxKittyIdentity | undefined {
  if (!environmentAdmits(env)) return undefined
  const paneId = env.TMUX_PANE
  if (paneId === undefined) return undefined

  const passthrough = runTmux(['show-options', '-Apqv', '-t', paneId, 'allow-passthrough'], env)?.trim()
  if (passthrough !== 'all') return undefined

  return probeTmuxDisplayIdentity(env)
}

/**
 * The live admission latch for one factory handle.
 *
 * `isAllowed(false)` may answer from a real probe at most 250 ms old: the
 * component render path runs for every frame and must not spawn tmux commands
 * per cell row. `isAllowed(true)` bypasses that cache and is used by the facade
 * before a physical write that carries a managed command. Once any probe fails
 * or the six identity fields change, `revoked` latches and nothing can grant
 * again. A Control Mode client is not one of those identity fields: its join,
 * exit or change never revokes; only the ordinary display client binding can.
 * A client change inside the 250 ms window is not detected atomically;
 * that is the documented hot-migration boundary, not an acknowledgement.
 * When a U1 feature gate is present, pending state is checked after the live
 * identity check: pending is not an identity failure, but a client change while
 * pending still revokes the handle. A permanent feature denial short-circuits
 * before any further tmux probe because that handle can never paint again.
 */
export class TmuxKittyAdmission {
  private readonly initial: TmuxKittyIdentity
  private readonly env: NodeJS.ProcessEnv
  private readonly placeholderAllowed: (() => boolean) | undefined
  private readonly placeholderDenied: (() => boolean) | undefined
  private revoked = false
  private hasProbed = false
  private lastProbeAt = 0
  private lastProbeAllowed = false

  constructor(
    initial: TmuxKittyIdentity,
    env: NodeJS.ProcessEnv = process.env,
    placeholderAllowed?: () => boolean,
    placeholderDenied?: () => boolean,
  ) {
    this.initial = initial
    this.env = env
    this.placeholderAllowed = placeholderAllowed
    this.placeholderDenied = placeholderDenied
  }

  isAllowed(force = false): boolean {
    // A denied U1 proof is permanent: the handle can never paint pixels, so
    // do not spawn synchronous tmux queries on every later image render.
    if (this.placeholderDenied?.() === true) return false
    if (!this.isIdentityAllowed(force)) return false
    // The U1 feature probe owns its own pending/probing/allowed/denied state.
    // Pending is not an identity failure, but the identity probe above still
    // observes and latches a live client change while pending; denied already
    // returned above and starts no further tmux query.
    return this.placeholderAllowed === undefined || this.placeholderAllowed()
  }

  /**
   * The live-client half of the admission, independent of the U1 feature gate.
   * Pending feature state must still observe a live client change and latch the
   * one-way revoke; otherwise another client's later feature reply could be
   * attributed to the original identity. The 250 ms cache and the forced
   * physical-write re-probe keep their existing semantics.
   */
  isIdentityAllowed(force = false): boolean {
    if (this.revoked) return false
    const now = Date.now()
    if (!force && this.hasProbed && now - this.lastProbeAt < PROBE_CACHE_TTL_MS) {
      return this.lastProbeAllowed
    }
    const probed = probeTmuxKittyIdentity(this.env)
    const allowed = probed !== undefined && sameTmuxDisplayIdentity(probed, this.initial)
    this.hasProbed = true
    this.lastProbeAt = now
    this.lastProbeAllowed = allowed
    if (!allowed) this.revoked = true
    return allowed
  }
}
