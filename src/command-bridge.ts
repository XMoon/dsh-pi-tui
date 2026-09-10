/**
 * The CommandBridge (M5, plan §10): the extension seam for CLIENT-OWNED
 * commands. A contribution is exactly the DSH client command contribution
 * (`ui-commands` CommandContribution): a slash name whose behavior lives
 * entirely on the client (no host descriptor) and which is merged into the
 * `/` menu with the host catalog. The bridge itself never executes
 * anything — the runner runs the contribution's own handler locally, never
 * steered, exactly like the static LOCAL_COMMANDS set (the TUI's own
 * /status, /settings). A contribution whose name is a host command FAILS
 * LOUD at candidate synthesis and never shadows it.
 *
 * Contract (plan §10):
 * - a contribution needs a declared handler (its client behavior) and needs
 *   no commands-service definition;
 * - `/name args...` ALWAYS keeps `invocation.rawInput` verbatim — the
 *   bridge never re-parses or rewrites arguments (the skill rawInput
 *   regression gate);
 * - a contribution is CLIENT-OWNED while registered; after unload the name
 *   returns to the ordinary routes (a host claim, or an unclaimed prompt —
 *   never a lingering client route);
 * - dynamic unload removes the contribution (fiber-bound, like every
 *   extension registration);
 * - near-synonym command conflicts keep the AGENTS hard rule: the bridge
 *   reports a conflicting registration loudly instead of guessing;
 * - P1-04: a dynamic command can NEVER shadow a host-owned command. The
 *   STATIC ownership catalog (the LOCAL_COMMANDS/SESSIONLESS_COMMANDS sets
 *   plus `/plan`, handed over by the extension host) is validated at
 *   register time — an exact-name or near-synonym collision with a
 *   TUI-owned command name is rejected loudly, never silently overriding
 *   the built-in behavior. A name the CURRENT (session-scoped) host catalog
 *   owns is NOT visible here: that collision is caught at candidate
 *   synthesis, which fails the whole pass (see `mergeContributions` in
 *   commands.ts).
 * @module @xmoon76/dsh-pi-tui/command-bridge
 */

import type { TuiCommandContribution, TuiCommandHandle, TuiLocalCommandHandler, TuiCommandBridgeSnapshot } from './extension/public-types.ts'

/** One client command contribution: a slash name the client owns. */


/** Registration outcome for a new contribution. */
type RegisterOutcome =
  | { kind: 'registered'; handle: TuiCommandHandle }
  | { kind: 'conflict'; existingOwner: string; nearSynonym?: string }

/** The bridge's internal registration record. */
interface Contribution {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly sessionless: boolean
  readonly owner: string
  readonly handler: TuiLocalCommandHandler
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
  /** The STATIC host-owned command names (P1-04): the
   * LOCAL_COMMANDS/SESSIONLESS_COMMANDS ownership sets plus `/plan` — the
   * names the TUI owns and registers itself. A dynamic contribution
   * colliding with this catalog (exact or near-synonym) is rejected at
   * register time — a plugin can never shadow a built-in command. Dynamic
   * and session-scoped host names are NOT in this catalog (it is a fixed
   * set); those collisions surface at candidate synthesis instead.
   * Defaults to empty for standalone tests that exercise the
   * dynamic-vs-dynamic rules only. */
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
    // A contribution IS its client behavior: a caller that bypasses the
    // public types (plain JS, a stale compiled plugin) must fail LOUD at the
    // boundary rather than install a menu row that can never run.
    if (typeof spec.handler !== 'function') {
      throw new Error(`command contribution "${spec.name}" must declare its handler (the client behavior)`)
    }
    // The removed `execution` ownership metadata must never be SILENTLY
    // reinterpreted: a stale plugin still declaring it is rejected loudly
    // (breaking API, explicit migration — see docs/extension-api.md).
    if ('execution' in spec) {
      throw new Error(
        `command contribution "${spec.name}" declares the removed 'execution' ownership metadata — a contribution is a client-owned command now; drop 'execution' and declare 'handler' (see docs/extension-api.md)`,
      )
    }
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
      sessionless: spec.sessionless ?? false,
      owner,
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

  /** The owning fiber of one contribution id (the runner-facing health
   * bridge resolves owners HERE — the runner never passes owners
   * around, which is what keeps the bridge protocol stable). */
  ownerOf(id: string): string | undefined {
    return this.contributions.get(id)?.owner
  }

  /** Whether a command name is a CLIENT-OWNED local command (static core
   * set OR a live contribution). The static set stays the baseline — the
   * bridge only ADDS client-owned names. */
  isLocal(name: string, staticLocal: ReadonlySet<string>): boolean {
    if (staticLocal.has(name)) return true
    for (const contribution of this.contributions.values()) {
      if (contribution.disposed) continue
      if (contribution.name === name) return true
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

  /** The client handler for one name, or undefined (the dispatch falls
   * back to the commands service for TUI-owned sessionless names). */
  handlerFor(name: string): TuiLocalCommandHandler | undefined {
    return this.find(name)?.handler
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
