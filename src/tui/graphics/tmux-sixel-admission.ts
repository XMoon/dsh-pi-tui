/**
 * Strict admission for the tmux NATIVE SIXEL backend (Image-8 / I8-4).
 *
 * tmux 3.4+ can parse a pane's own SIXEL DCS and paint it on the attached
 * client, but only when the SERVER was built with SIXEL support AND the live
 * display client's effective terminal description advertises Sxl. Neither fact
 * may be inferred from the pane environment, a terminal brand or a pane DA1
 * reply: tmux can fabricate the SIXEL attribute on its own DA1 answer even when
 * the outer client cannot draw pixels.
 *
 * This module therefore asks the real server through fixed argv and fails
 * closed on ANY ambiguity:
 *
 *   Q1 `display-message -p -t <pane> '#{session_name}'` -> one session name
 *   Q2 `display-message -p -t <pane> '#{sixel_support}'` -> exactly `1`
 *   Q3 `list-clients -F <six columns>` -> exactly one ordinary display client
 *      whose session is Q1 and which is not a nested multiplexer
 *   Q4 `show-messages -T -t <exact client>` -> exactly one `Sxl: (flag) true`
 *
 * The admission is a one-way latch: a changed pane/session/client/termname/
 * termtype, a lost server SIXEL capability or a lost Sxl line permanently
 * revokes this TUI lifetime. Recovery requires a restart; a new client is never
 * adopted silently.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/tmux-sixel-admission
 */

import {
  isNestedTmuxClient,
  nonEmpty,
  parseTmuxDisplayClients,
  runTmux,
  sameTmuxDisplayIdentity,
  tmuxPaneEnvironmentAdmits,
  type TmuxDisplayIdentity,
} from './tmux-admission.ts'

/** The immutable live binding a native tmux SIXEL handle may use. */
export interface TmuxSixelIdentity extends TmuxDisplayIdentity {}

/** The short live-probe cache used by the component render path. */
const PROBE_CACHE_TTL_MS = 250

/** Legacy/explicit protocols that must never be overridden by tmux SIXEL. */
function protocolDeniesSixel(env: NodeJS.ProcessEnv): boolean {
  const protocol = (env.PI_IMAGE_PROTOCOL ?? '').toLowerCase()
  return protocol === 'none' || protocol === '0' || protocol === 'kitty' || protocol === 'iterm2'
}

/** One line-terminated value: exactly one non-empty line, no hidden records. */
function singleLine(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const withoutTerminator = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  const value = withoutTerminator.trim()
  if (value === '' || value.includes('\n')) return undefined
  return value
}

/**
 * Whether a `show-messages -T` report proves the client's effective terminal
 * description advertises SIXEL. Exactly one Sxl-bearing line is allowed and it
 * must be the complete positive form; a false/duplicate/truncated/decoy line
 * (`X-Sxl`, `Sxl true-ish`) fails closed.
 */
export function tmuxSixelFlagReportAllows(report: string | undefined): boolean {
  if (report === undefined || report === '') return false
  const lines = report.split('\n').filter((line) => line.includes('Sxl'))
  if (lines.length !== 1) return false
  return /^\s*\d+: Sxl: \(flag\) true$/.test(lines[0]!)
}

/**
 * Probe the ONE server + client binding that may paint native tmux SIXEL.
 *
 * Everything here is server/client evidence; no inherited terminal brand,
 * `TERM_PROGRAM`, `WT_SESSION`, `KITTY_WINDOW_ID` or pane DA1 attribute is
 * consulted. Any query failure (missing binary, non-zero exit, timeout,
 * overflow) is "no answer" and denies.
 */
export function probeTmuxSixelIdentity(env: NodeJS.ProcessEnv = process.env): TmuxSixelIdentity | undefined {
  if (protocolDeniesSixel(env)) return undefined
  if (!tmuxPaneEnvironmentAdmits(env)) return undefined
  const paneId = env.TMUX_PANE
  if (paneId === undefined) return undefined

  const sessionName = singleLine(runTmux(['display-message', '-p', '-t', paneId, '#{session_name}'], env))
  if (!nonEmpty(sessionName)) return undefined

  const sixelSupport = singleLine(runTmux(['display-message', '-p', '-t', paneId, '#{sixel_support}'], env))
  if (sixelSupport !== '1') return undefined

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
  const identity: TmuxSixelIdentity = {
    paneId,
    sessionName,
    clientName: client.name,
    clientTty: client.tty,
    clientTermname: client.termname,
    clientTermtype: client.termtype,
  }
  if (isNestedTmuxClient(identity)) return undefined

  const messages = runTmux(['show-messages', '-T', '-t', client.name], env)
  if (!tmuxSixelFlagReportAllows(messages)) return undefined

  return identity
}

/**
 * The live admission latch for one native tmux SIXEL handle.
 *
 * `isAllowed(false)` may answer from a real probe at most 250 ms old. Every
 * complete trusted DCS write forces `isAllowed(true)`, which bypasses the cache
 * and re-proves the whole binding. Any failure or identity change latches
 * `revoked` and notifies the owner exactly once; nothing can grant again.
 */
export class TmuxSixelAdmission {
  private readonly initial: TmuxSixelIdentity
  private readonly env: NodeJS.ProcessEnv
  private readonly revokedListeners = new Set<() => void>()
  private revoked = false
  private hasProbed = false
  private lastProbeAt = 0
  private lastProbeAllowed = false

  constructor(initial: TmuxSixelIdentity, env: NodeJS.ProcessEnv = process.env) {
    this.initial = initial
    this.env = env
  }

  /** The two-state admission projection the SIXEL owner consumes. */
  get verdict(): 'admitted' | 'denied' {
    return this.isAllowed(false) ? 'admitted' : 'denied'
  }

  isAllowed(force = false): boolean {
    if (this.revoked) return false
    const now = Date.now()
    if (!force && this.hasProbed && now - this.lastProbeAt < PROBE_CACHE_TTL_MS) {
      return this.lastProbeAllowed
    }
    const probed = probeTmuxSixelIdentity(this.env)
    const allowed = probed !== undefined && sameTmuxDisplayIdentity(probed, this.initial)
    this.hasProbed = true
    this.lastProbeAt = now
    this.lastProbeAllowed = allowed
    if (!allowed) this.revoke()
    return allowed
  }

  /** Observe the one-way revoke. The owner clears every paintable fact here. */
  observe(listener: () => void): () => void {
    if (this.revoked) {
      listener()
      return () => {}
    }
    this.revokedListeners.add(listener)
    return () => {
      this.revokedListeners.delete(listener)
    }
  }

  dispose(): void {
    this.revokedListeners.clear()
  }

  private revoke(): void {
    if (this.revoked) return
    this.revoked = true
    for (const listener of [...this.revokedListeners]) listener()
    this.revokedListeners.clear()
  }
}
