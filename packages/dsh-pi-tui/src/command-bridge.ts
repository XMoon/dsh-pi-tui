/**
 * The CommandBridge (M5, plan §10): the extension seam over the host's
 * slash-command execution. It does NOT re-implement command execution —
 * actual execution continues through the existing `ctx.commands` service
 * (register + execute). The bridge adds the TUI's OWNERSHIP metadata:
 *
 * - `execution: 'local'` — the command ALWAYS executes locally (TUI
 *   control commands like /status, /settings), never steered, regardless
 *   of the busyEnter preference. This is exactly the semantic of the
 *   static LOCAL_COMMANDS set, now extensible by plugins.
 * - `execution: 'submission'` — the command flows through the session
 *   submission policy (steer/queue) like any skill invocation.
 *
 * Contract (plan §10):
 * - `/name args...` ALWAYS keeps `invocation.rawInput` verbatim — the
 *   bridge never re-parses or rewrites arguments (the skill rawInput
 *   regression gate);
 * - busy Enter keeps classifying by the EFFECTIVE ownership: a dynamic
 *   local command is local while registered, submission after unload;
 * - dynamic unload removes the contribution (fiber-bound, like every
 *   extension registration);
 * - near-synonym command conflicts keep the AGENTS hard rule: the bridge
 *   reports a conflicting registration loudly instead of guessing;
 * - P1-04: a dynamic command can NEVER shadow a host-owned command. The
 *   authoritative static catalog (TUI-registered commands + the
 *   LOCAL_COMMANDS/SESSIONLESS_COMMANDS ownership sets) is validated at
 *   register time — an exact-name or near-synonym collision with a
 *   host-owned command name is rejected loudly, never silently overriding
 *   the built-in behavior.
 * @module @xmoon76/dsh-pi-tui/command-bridge
 */

import type { TuiAutocompleteProvider } from './extension/public-types.ts'
import type { TuiCommandContribution, TuiCommandHandle, TuiLocalCommandHandler, TuiCommandBridgeSnapshot } from './extension/public-types.ts'

/** One command contribution: ownership metadata over an existing command. */


/** Conflict-detection outcome for a new registration. */
type RegisterOutcome =
  | { kind: 'registered'; handle: TuiCommandHandle }
  | { kind: 'conflict'; existingOwner: string; nearSynonym?: string }

/** The bridge's internal registration record. */
interface Contribution {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly execution: 'local' | 'submission'
  readonly sessionless: boolean
  readonly owner: string
  readonly argumentProvider: TuiAutocompleteProvider | undefined
  readonly handler: TuiLocalCommandHandler | undefined
  disposed: boolean
}

/**
 * The command bridge. One instance backs the runner; the extension service
 * exposes registration (M5) and the runner consults
 * {@link isLocal} / {@link find} / {@link snapshot}.
 */
export class CommandBridge {
  /** Contributions by id (diagnostic identity; also the registry key). */
  private readonly contributions = new Map<string, Contribution>()
  /** The AUTHORITATIVE host-owned command names (P1-04): TUI-registered
   * commands + the LOCAL_COMMANDS/SESSIONLESS_COMMANDS ownership sets. A
   * dynamic contribution colliding with this catalog (exact or
   * near-synonym) is rejected at register time — a plugin can never
   * shadow a built-in command. Defaults to empty for standalone tests
   * that exercise the dynamic-vs-dynamic rules only. */
  private readonly staticCatalog: ReadonlySet<string>
  /** Local names, derived on demand (never stored twice). */
  private revision = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}, staticCatalog: ReadonlySet<string> = new Set()) {
    this.onInvalidate = onInvalidate
    this.staticCatalog = staticCatalog
  }

  /**
   * Register one command contribution. A name collision with an EXISTING
   * contribution returns a conflict outcome (never a silent override — the
   * AGENTS near-synonym rule). A duplicate id is an error.
   * @param spec - the contribution.
   * @param owner - the Cordis fiber name (diagnostics + owner disposal).
   */
  register(spec: TuiCommandContribution, owner: string): RegisterOutcome {
    if (this.contributions.has(spec.id)) {
      throw new Error(`duplicate command contribution id "${spec.id}" (owner "${this.contributions.get(spec.id)?.owner}")`)
    }
    if (spec.name === '') throw new Error('command contribution name must not be empty')
    // P1-04: the host-owned catalog is authoritative — an EXACT collision
    // with a host command is rejected loudly (a plugin can never shadow
    // /status, /sessions, ...). Near-synonyms of host names are rejected
    // too (the AGENTS hard rule applies to the static set as well).
    for (const hostName of this.staticCatalog) {
      if (hostName === spec.name) {
        return { kind: 'conflict', existingOwner: 'host' }
      }
      const shorter = hostName.length <= spec.name.length ? hostName : spec.name
      const longer = hostName.length <= spec.name.length ? spec.name : hostName
      if (shorter !== longer && longer.startsWith(shorter)) {
        return { kind: 'conflict', existingOwner: 'host', nearSynonym: `${shorter} ↔ ${longer}` }
      }
    }
    for (const existing of this.contributions.values()) {
      if (existing.disposed) continue
      if (existing.name === spec.name) {
        return { kind: 'conflict', existingOwner: existing.owner }
      }
    }
    // Near-synonym detection (AGENTS hard rule — /session vs /sessions):
    // a command name that is a PREFIX of another registered name (or vice
    // versa) is a confusion risk the user must resolve explicitly. The
    // rule is deliberately conservative (exact prefix only, never fuzzy
    // edit distance — a false positive would block legitimate names).
    for (const existing of this.contributions.values()) {
      if (existing.disposed) continue
      const shorter = existing.name.length <= spec.name.length ? existing.name : spec.name
      const longer = existing.name.length <= spec.name.length ? spec.name : existing.name
      if (shorter !== longer && longer.startsWith(shorter)) {
        return {
          kind: 'conflict',
          existingOwner: existing.owner,
          nearSynonym: `${shorter} ↔ ${longer}`,
        }
      }
    }
    const contribution: Contribution = {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      execution: spec.execution,
      sessionless: spec.sessionless ?? false,
      owner,
      argumentProvider: spec.argumentProvider,
      handler: spec.handler,
      disposed: false,
    }
    this.contributions.set(spec.id, contribution)
    this.revision += 1
    this.onInvalidate()
    return {
      kind: 'registered',
      handle: {
        id: spec.id,
        dispose: () => this.dispose(spec.id),
      },
    }
  }

  /** Remove one contribution by id (idempotent). */
  dispose(id: string): void {
    const contribution = this.contributions.get(id)
    if (contribution === undefined || contribution.disposed) return
    contribution.disposed = true
    this.contributions.delete(id)
    this.revision += 1
    this.onInvalidate()
  }

  /** Dispose every contribution owned by one fiber name (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, contribution] of [...this.contributions]) {
      if (contribution.owner === owner) this.dispose(id)
    }
  }

  /** Whether a command name is EFFECTIVELY local (static core set OR a
   * live dynamic local contribution). The static set stays the baseline —
   * the bridge only ADDS dynamic ownership. */
  isLocal(name: string, staticLocal: ReadonlySet<string>): boolean {
    if (staticLocal.has(name)) return true
    for (const contribution of this.contributions.values()) {
      if (contribution.disposed) continue
      if (contribution.name === name && contribution.execution === 'local') return true
    }
    return false
  }

  /** Whether a command name is sessionless (static set OR a live dynamic
   * sessionless contribution). */
  isSessionless(name: string, staticSessionless: ReadonlySet<string>): boolean {
    if (staticSessionless.has(name)) return true
    for (const contribution of this.contributions.values()) {
      if (contribution.disposed) continue
      if (contribution.name === name && contribution.sessionless) return true
    }
    return false
  }

  /** The live contribution for one name, or undefined. */
  find(name: string): Contribution | undefined {
    for (const contribution of this.contributions.values()) {
      if (contribution.disposed) continue
      if (contribution.name === name) return contribution
    }
    return undefined
  }

  /** The live contribution id for one name, or undefined for host-owned
   * commands. Runtime health callbacks use the contribution id, never the
   * command's display name. */
  idFor(name: string): string | undefined {
    return this.find(name)?.id
  }

  /** The handler for one name, or undefined (dispatch falls back to the
   * commands service). */
  handlerFor(name: string): TuiLocalCommandHandler | undefined {
    return this.find(name)?.handler
  }

  /** The argument autocomplete provider for one name, or undefined. */
  argumentProviderFor(name: string): TuiAutocompleteProvider | undefined {
    return this.find(name)?.argumentProvider
  }

  /** An immutable snapshot (diagnostics + /status). */
  snapshot(): TuiCommandBridgeSnapshot {
    const entries = [...this.contributions.values()]
      .filter(contribution => !contribution.disposed)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(contribution => ({
        id: contribution.id,
        name: contribution.name,
        description: contribution.description,
        execution: contribution.execution,
        sessionless: contribution.sessionless,
        owner: contribution.owner,
      }))
    return { entries, revision: this.revision }
  }

  /** Whether any contribution is live (health /status). */
  hasAny(): boolean {
    for (const contribution of this.contributions.values()) {
      if (!contribution.disposed) return true
    }
    return false
  }
}
