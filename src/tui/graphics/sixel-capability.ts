/**
 * The ONE Client-local Direct SIXEL admission classifier (Image-8 / I8-1B).
 *
 * SIXEL is admitted only from a REAL terminal observation: Windows Terminal
 * omits the XTSMGRAPHICS query and answers a primary DA1 whose parameters
 * include the SIXEL attribute `4`. Nothing in the environment may stand in for
 * that observation — `WT_SESSION`, `TERM_PROGRAM` and pane DA1 replies are
 * topology hints, never capability proof.
 *
 * This module deliberately does NOT publish pixels. It derives a candidate
 * verdict for a future consumer (`I8-2A`), where `effectiveImageProtocol()`
 * will fold it into the single per-frame protocol answer. `I8-1` therefore
 * leaves `getCapabilities().images`, `EffectiveImageProtocol` and every media
 * consumer untouched: admitting here means "this Direct terminal reported
 * SIXEL", not "this app may paint SIXEL".
 *
 * The verdict is a projection of the observation owned by `ProcessTerminal`
 * (`Terminal.onSixelSupport`). This file keeps no second mutable "supported"
 * flag: `observed` is that single fact and `verdict` is derived from it.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/sixel-capability
 */

import { getCapabilities, type Terminal } from '@xmoon76/pi-tui'
import { imageProtocolPreference } from './image-protocol-preference.ts'

/** Admission state of the Direct SIXEL candidate for this terminal lifetime. */
export type SixelDirectVerdict = 'pending' | 'admitted' | 'denied'

/** One Direct SIXEL candidate: an observation plus the verdict derived from it. */
export interface SixelDirectCapability {
  /** `pending` until the terminal answers, then `admitted` or `denied`. */
  readonly verdict: SixelDirectVerdict
  /** The terminal's own DA1 SIXEL answer; `undefined` while still unknown. */
  readonly observed: boolean | undefined
  /**
   * Observe every later DA1 answer on the same terminal. The owner uses this
   * to re-evaluate readiness; the capability itself remains the only fact.
   */
  observe(listener: () => void): () => void
  /** Idempotent: unsubscribes and freezes the verdict. */
  dispose(): void
}

/** Whether the topology is a multiplexer whose pane must admit its own protocol. */
function isMultiplexedTopology(environment: NodeJS.ProcessEnv): boolean {
  // A set-but-empty marker is not a session (the ZELLIJ precedent in
  // `image-capability.ts`); a real TMUX/STY value is always a socket path.
  for (const marker of ['TMUX', 'ZELLIJ', 'STY']) {
    if ((environment[marker] ?? '') !== '') return true
  }
  const term = (environment.TERM ?? '').toLowerCase()
  if (term.startsWith('tmux') || term.startsWith('screen')) return true
  return (environment.TERM_PROGRAM ?? '').toLowerCase() === 'herdr'
}

/**
 * Why this terminal may not even be a Direct SIXEL candidate, or `undefined`
 * when the real DA1 observation should decide. These reasons are static
 * configuration/topology facts; they never guess a pixel capability.
 */
function staticDenial(environment: NodeJS.ProcessEnv, legacyImages: 'kitty' | 'iterm2' | null): string | undefined {
  const preference = imageProtocolPreference(environment)
  if (preference === 'none') return 'pi-image-protocol-hard-off'
  if (preference === 'kitty' || preference === 'iterm2') return 'pi-image-protocol-explicit-legacy'
  if (isMultiplexedTopology(environment)) return 'multiplexed-topology'
  // `sixel` deliberately bypasses ONLY the fork's static Kitty/iTerm2 brand
  // precedence: the real DA1 attribute, the Screen cell/background facts and
  // the single owner below still decide whether anything is painted.
  if (preference === 'auto' && legacyImages !== null) return 'legacy-image-protocol'
  return undefined
}

/**
 * Create the Direct SIXEL candidate for one terminal instance.
 *
 * A statically denied topology never subscribes: no probe, no query, no bytes.
 * Otherwise the candidate subscribes to the terminal's passive DA1 observation
 * and stays `pending` until a complete primary DA1 answers. `pending` is not
 * permission — a consumer must treat it as "not paintable".
 */
export function createDirectSixelCapability(
  terminal: Terminal,
  environment: NodeJS.ProcessEnv = process.env,
  legacyImages: 'kitty' | 'iterm2' | null = getCapabilities().images,
): SixelDirectCapability {
  const denial = staticDenial(environment, legacyImages)
  let observed: boolean | undefined
  let disposed = false
  let unsubscribe: (() => void) | undefined

  if (denial === undefined) {
    unsubscribe = terminal.onSixelSupport?.((supported) => {
      // A queued callback may race a dispose(); afterwards nothing may change.
      if (disposed) return
      observed = supported
    })
  }

  const verdict = (): SixelDirectVerdict => {
    if (denial !== undefined) return 'denied'
    if (observed === undefined) return 'pending'
    return observed ? 'admitted' : 'denied'
  }

  return {
    get verdict(): SixelDirectVerdict {
      return verdict()
    },
    get observed(): boolean | undefined {
      return observed
    },
    observe(listener: () => void): () => void {
      if (disposed || denial !== undefined) return () => {}
      return terminal.onSixelSupport?.(() => listener()) ?? (() => {})
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}
