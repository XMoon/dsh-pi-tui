/**
 * Strict admission for the tmux virtual Kitty backend (Image-7B-A).
 *
 * A tmux pane forwards a Kitty graphics APC to the outer terminal only when
 * the pane's `allow-passthrough` option is `all` AND the single attached client
 * is a trustworthy transport topology. Neither fact can be inferred from the
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

/** The immutable identity of the ONE attached tmux client a handle may use. */
export interface TmuxKittyIdentity {
  readonly paneId: string
  readonly sessionName: string
  readonly clientName: string
  readonly clientTty: string
  readonly clientTermname: string
  readonly clientTermtype: string
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== ''
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
 * caller fails closed.
 */
function runTmux(args: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf8',
      env,
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
    }).trim()
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
 * query. It reads only the real server report, never an inherited
 * `TERM_PROGRAM`/`KITTY_WINDOW_ID` hint.
 */
export function tmuxKittyHasKnownUnicodePlaceholders(identity: TmuxKittyIdentity): boolean {
  const program = clientProgramName(identity.clientTermtype)
  const termname = identity.clientTermname.toLowerCase()
  if (program === 'kitty') return termname === 'xterm-kitty' || termname === 'kitty'
  // Ghostty's XTVERSION reply uses a space ("ghostty 1.4.0"). Its own terminfo
  // entry may fall back to xterm-256color when the remote terminfo install is
  // unavailable; the live XTVERSION reply still identifies the emulator.
  if (program === 'ghostty') {
    return termname === 'xterm-ghostty' || termname === 'ghostty' || termname === 'xterm-256color'
  }
  return false
}

function sameIdentity(left: TmuxKittyIdentity, right: TmuxKittyIdentity): boolean {
  return left.paneId === right.paneId
    && left.sessionName === right.sessionName
    && left.clientName === right.clientName
    && left.clientTty === right.clientTty
    && left.clientTermname === right.clientTermname
    && left.clientTermtype === right.clientTermtype
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
 *  5. the whole server has exactly ONE attached client, whose session matches
 *     the pane and whose tty/name are non-empty.
 *
 * The client's terminal name/type are recorded for the U1 evidence decision,
 * but an unknown renderer is NOT rejected here: it may proceed to the live
 * `e=T,U=1` feature probe.
 */
export function probeTmuxKittyIdentity(env: NodeJS.ProcessEnv = process.env): TmuxKittyIdentity | undefined {
  if (!environmentAdmits(env)) return undefined
  const paneId = env.TMUX_PANE
  if (paneId === undefined) return undefined

  const passthrough = runTmux(['show-options', '-Apqv', '-t', paneId, 'allow-passthrough'], env)
  if (passthrough !== 'all') return undefined

  const sessionName = runTmux(['display-message', '-p', '-t', paneId, '#{session_name}'], env)
  if (!nonEmpty(sessionName)) return undefined

  const clients = runTmux([
    'list-clients',
    '-F',
    '#{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}',
  ], env)
  if (!nonEmpty(clients)) return undefined
  const lines = clients.split('\n')
  if (lines.length !== 1) return undefined
  const fields = lines[0]!.split('\t')
  if (fields.length !== 5) return undefined
  const [clientName, clientTty, clientSession, clientTermname, clientTermtype] = fields as [
    string, string, string, string, string,
  ]
  if (!nonEmpty(clientName) || !nonEmpty(clientTty)) return undefined
  if (clientSession !== sessionName) return undefined

  return { paneId, sessionName, clientName, clientTty, clientTermname, clientTermtype }
}

/**
 * The live admission latch for one factory handle.
 *
 * `isAllowed(false)` may answer from a real probe at most 250 ms old: the
 * component render path runs for every frame and must not spawn tmux commands
 * per cell row. `isAllowed(true)` bypasses that cache and is used by the facade
 * before a physical write that carries a managed command. Once any probe fails
 * or the six identity fields change, `revoked` latches and nothing can grant
 * again. A client change inside the 250 ms window is not detected atomically;
 * that is the documented hot-migration boundary, not an acknowledgement.
 */
export class TmuxKittyAdmission {
  private readonly initial: TmuxKittyIdentity
  private readonly env: NodeJS.ProcessEnv
  private readonly placeholderAllowed: (() => boolean) | undefined
  private revoked = false
  private hasProbed = false
  private lastProbeAt = 0
  private lastProbeAllowed = false

  constructor(initial: TmuxKittyIdentity, env: NodeJS.ProcessEnv = process.env, placeholderAllowed?: () => boolean) {
    this.initial = initial
    this.env = env
    this.placeholderAllowed = placeholderAllowed
  }

  isAllowed(force = false): boolean {
    if (this.revoked) return false
    // The U1 feature probe owns its own pending/probing/allowed/denied state.
    // Pending/denied is not an identity failure: report no pixels without
    // spawning a tmux probe and without latching the identity revoke.
    if (this.placeholderAllowed !== undefined && !this.placeholderAllowed()) return false
    const now = Date.now()
    if (!force && this.hasProbed && now - this.lastProbeAt < PROBE_CACHE_TTL_MS) {
      return this.lastProbeAllowed
    }
    const probed = probeTmuxKittyIdentity(this.env)
    const allowed = probed !== undefined && sameIdentity(probed, this.initial)
    this.hasProbed = true
    this.lastProbeAt = now
    this.lastProbeAllowed = allowed
    if (!allowed) this.revoked = true
    return allowed
  }
}
