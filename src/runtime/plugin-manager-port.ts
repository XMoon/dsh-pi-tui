/**
 * The Plugin Manager semantic port (P1-A): detached facts and semantic
 * operations the TUI's `/plugins` surface renders and performs.
 *
 * The official `@deepseek-ai/dsh-plugin-manager` Host service owns
 * package/profile truth, compatibility and the install lifecycle; this port
 * carries only the facts a TUI screen acts on and never exposes a Host
 * service object, a profile path, a package manifest, or a Cordis context.
 * A future Remote adapter maps the same port onto the official client
 * contract; nothing here may name a transport.
 *
 * Full contract: docs/architecture/host-client.md (Host authority and
 * currentness) and docs/architecture/surface-behavior.md (controller/workspace).
 * @module @xmoon76/dsh-pi-tui/runtime/plugin-manager-port
 */

/** Why a Host control cannot modify one entry (official `ReadOnlyReason`). */
export type PluginReadOnlyReason = 'management-required' | 'unaddressable'

/** One package the running DSH version rejects without an exact exemption. */
export interface PluginIncompatibleFact {
  readonly name: string
  readonly version: string
  readonly runtimeVersion: string
  /** Only the requirements the running version does not satisfy, keyed
   * `engines.dsh` or by DSH peer package name (the 0.2.1-rc.1 official
   * `IncompatiblePlugin.requirements` fact). */
  readonly requirements: Readonly<Record<string, string>>
}

/** A Host management failure, actionable rather than a generic "failed". */
export interface PluginErrorFact {
  readonly code: string
  readonly diagnostic?: string
  /** Present with `incompatible-version`: the rejected packages. */
  readonly incompatible?: readonly PluginIncompatibleFact[]
}

/**
 * Where a bundle's files live, exactly as the official `BundleInfo.availability`
 * reports it: shipped with the installation, held by the profile, or not
 * readable at all (a discoverable on-demand catalog entry included).
 */
export type PluginAvailability = 'installation' | 'profile' | 'missing'

/** The official released Host version offered for an on-demand catalog entry. */
export interface PluginInstallTargetFact {
  readonly spec: string
  readonly version: string
}

/** One package operation's raw completion facts (official `PackageResult`). */
export interface PluginPackageResultFact {
  readonly exitCode: number
  readonly output: string
  readonly truncated: boolean
  readonly kind?: string
  readonly timedOut?: boolean
  readonly incompatible?: readonly PluginIncompatibleFact[]
}

/** One row a bundle's patch declares. */
export interface PluginBundleRowFact {
  readonly rowId: string
  readonly moduleName: string
  /** Resolved display title (English fallback), when the package publishes one. */
  readonly title?: string
  /** Resolved display description (English fallback), when published. */
  readonly description?: string
  /** The live Loader entry carrying this row, when exactly one entry matches. */
  readonly entryId?: string
}

/** One shipped, profile-installed, or discoverable bundle (official `BundleInfo`). */
export interface PluginBundleFact {
  readonly name: string
  /** Project-maintained shipped optional bundle or on-demand catalog entry,
   * independent of installation and selection. */
  readonly official: boolean
  /** Where the bundle's files live. */
  readonly availability: PluginAvailability
  /** The official released Host version offered for an on-demand catalog entry. */
  readonly installTarget?: PluginInstallTargetFact
  readonly version?: string
  readonly title?: string
  readonly description?: string
  /** The Host's default GUI visibility decision after its own package/Host
   * checks; absent when the Host declares none. It only answers "listed by
   * default", never enablement, installation or load success. */
  readonly listedByDefault?: boolean
  /** Selected in the profile manifest. */
  readonly enabled: boolean
  /** Whether the profile's own dependencies hold the package. */
  readonly installed: boolean
  /** Shipped by the installation for the user to switch on; never removable. */
  readonly optional: boolean
  /** The spec `pnpm add` accepts for a profile-owned dependency (user
   * information removed by the Host), when one is declared. */
  readonly source?: string
  readonly removable: boolean
  /** Whether the Host accepts `listVersions`/`updateBundle` for this bundle: a
   * declared Host capability only. It never answers which version is newer. */
  readonly updatable: boolean
  readonly readOnlyReason?: PluginReadOnlyReason
  readonly error?: PluginErrorFact
  readonly rows: readonly PluginBundleRowFact[]
  /** Built-in row ids this bundle's patch changes without declaring. */
  readonly overrides: readonly string[]
}

/** One running-profile entry and its persistent control availability. */
export interface PluginRowFact {
  readonly entryId: string
  readonly moduleName: string
  readonly title?: string
  readonly description?: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  /** Official `PluginFiberPhase`; `null` when no live root fiber exists. */
  readonly fiberPhase: string | null
  /** Present when the entry is addressable through the profile patch. */
  readonly patchId?: string
  readonly readOnlyReason?: PluginReadOnlyReason
}

/** The registries the Host offers: configured first, fallbacks, pnpm's own. */
export interface PluginRegistriesFact {
  readonly registry: string | null
  readonly fallbackRegistries: readonly string[]
  readonly resolved: string | null
}

/** One exact plugin-version exemption saved in the profile. */
export interface PluginExemptionFact {
  readonly packageVersion: string
  readonly runtimeVersions: readonly string[]
}

/** Everything the read-only management surface renders, read together. */
export interface PluginManagerSnapshot {
  readonly bundles: readonly PluginBundleFact[]
  readonly plugins: readonly PluginRowFact[]
  readonly registries: PluginRegistriesFact
  readonly exemptions: readonly PluginExemptionFact[]
  /** Problems the exemption reader rejected (reported, never fatal). */
  readonly exemptionWarnings: readonly string[]
}

/** What a spec names before installation (official `PluginSpecInspection`). */
export type PluginSpecInspectionFact =
  | {
    readonly status: 'accepted'
    readonly kind: string
    readonly name?: string
    readonly version?: string
    readonly description?: string
    /** Whether the package declares a bundle patch; null when the form cannot say. */
    readonly bundle: boolean | null
    readonly registry: string | null
    readonly host?: string
  }
  | {
    readonly status: 'refused'
    readonly problem: string
    readonly reason: string
    readonly registries?: readonly (string | null)[]
  }

/** One persisted change and its independently observed application outcome.
 * Carries the rc.2 `ChangeResult` facts D1 renders: the restart reason, the
 * actual installed manifest version, pending/approved build scripts, the raw
 * package result, the registries asked and what failed to answer. */
export interface PluginChangeFact {
  readonly changed: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  /** Present with `restart-required`: why the change waits for the next start. */
  readonly restartReason?: string
  readonly stage: 'install' | 'enable' | 'remove'
  readonly target: string
  readonly enabled?: boolean
  readonly error?: PluginErrorFact
  readonly warnings?: readonly string[]
  /** The bundle an installation added, once pnpm and the bundle check accepted it. */
  readonly bundle?: string
  /** The installed bundle's manifest version, when declared. */
  readonly version?: string
  /** Exact package names awaiting explicit script approval after a failed run. */
  readonly pendingBuilds?: readonly string[]
  /** Package script permissions saved before this installation attempt. */
  readonly approvedBuilds?: readonly string[]
  /** One package operation's completion facts. */
  readonly packageResult?: PluginPackageResultFact
  /** The registries the installation asked, in order. */
  readonly registries?: readonly (string | null)[]
  /** What the last failed run could not reach or get an answer from. */
  readonly failedAt?: 'registry' | 'spec-host'
}

/** One user install attempt: exactly one request id owns it. */
export interface PluginInstallRequest {
  /** Caller-owned identity: the SAME id addresses waitForInstall/cancelInstall. */
  readonly requestId: string
  readonly spec: string
  /** The registry asked first; null = the one pnpm's own configuration names. */
  readonly registry: string | null
  readonly enabled?: boolean
  /** Explicitly allow these pending packages' scripts for this profile. */
  readonly approvedBuilds?: readonly string[]
}

/** One official install-phase announcement, correlated by request id. */
export interface PluginInstallPhaseFact {
  readonly requestId: string
  readonly phase: 'installing' | 'cancelling' | 'applying'
  readonly attempt?: {
    readonly registry: string | null
    readonly index: number
    readonly total: number
  }
}

/** One registry a version lookup asked, and why it gave no usable answer. */
export interface PluginRegistryAttemptFact {
  readonly registry: string | null
  readonly problem?: 'not-found' | 'network' | 'unknown'
  readonly reason?: string
}

/** One published version newer than the installed one (official `PluginVersion`). */
export interface PluginVersionFact {
  readonly version: string
  readonly publishedAt?: string
  readonly tags: readonly string[]
  readonly prerelease: boolean
  readonly deprecated?: string
  /** Whether the version declares a `dsh.bundle`; only such a version can replace a bundle. */
  readonly bundle: boolean
  /** Present when the running DSH version rejects this version without an exemption. */
  readonly incompatible?: PluginIncompatibleFact
}

/**
 * The versions a registry offers for an installed registry package, read WITHOUT
 * changing the profile. The Host is the registry and compatibility authority;
 * this port carries its answer verbatim, in the Host's own order.
 */
export type PluginVersionListFact =
  | {
    readonly status: 'listed'
    /** The installed version the list is newer than. */
    readonly installed: string
    /** The registry that answered; an update installs from exactly this one. */
    readonly registry: string | null
    readonly attempts: readonly PluginRegistryAttemptFact[]
    readonly versions: readonly PluginVersionFact[]
    /** Newer versions beyond the Host's own limit that the list leaves out. */
    readonly omitted: number
  }
  | {
    readonly status: 'refused'
    readonly problem: 'not-updatable' | 'not-found' | 'network' | 'unknown'
    readonly reason: string
    readonly attempts: readonly PluginRegistryAttemptFact[]
  }

/** One Host update step announcement (official `PluginUpdateProgress`). */
export interface PluginUpdateProgressFact {
  readonly requestId: string
  readonly step: 'checking' | 'removing' | 'installing' | 'restoring'
}

/**
 * How one official update ended: `result` belongs to the last step that ran and
 * `restore` reports the reinstallation of the former version, when one ran.
 * The two are INDEPENDENT outcomes and must never be collapsed into one.
 */
export interface PluginUpdateResultFact {
  readonly from: string
  readonly to: string
  readonly step: 'check' | 'remove' | 'install'
  readonly result: PluginChangeFact
  readonly restore?: PluginChangeFact
}

/** One chunk of a pnpm run's output. */
export interface PluginInstallLogFact {
  readonly requestId?: string
  readonly jobId: string
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

/** An official install event, discriminated so the controller filters by kind. */
export type PluginInstallEvent =
  | { readonly kind: 'phase'; readonly phase: PluginInstallPhaseFact }
  | { readonly kind: 'log'; readonly log: PluginInstallLogFact }

/**
 * One plugin mutation's result arrived after the operation's authoritative
 * currentness context was superseded. The write may have been applied, so this
 * is NOT a refusal: the caller must present the outcome as indeterminate and
 * let the authoritative inventory reread decide what is true. A backend
 * adapter raises it only when its own currentness authority proves the reply
 * belongs to a superseded context; this module names no transport.
 */
export class PluginManagerStaleResultError extends Error {
  constructor(operation: string) {
    super(
      `pluginManager.${operation} returned after its currentness context was superseded; `
      + 'the authoritative inventory reread decides the outcome',
    )
    this.name = 'PluginManagerStaleResultError'
  }
}

/** Cancellation is confirmed only after Host cleanup has completed. */
export interface PluginInstallCancellationFact {
  readonly status: 'cancelled' | 'too-late' | 'not-running'
}

/**
 * The TUI's semantic Plugin Manager facade. Every method is one official
 * operation; the port owns no installed-package database, no enabled truth
 * and no compatibility evaluation.
 */
export interface PluginManagerPort {
  /** Read bundles, plugins, offered registries and version exemptions together. */
  snapshot(): Promise<PluginManagerSnapshot>
  /** Read what a spec names before installing it. */
  inspect(spec: string, registry?: string | null, signal?: AbortSignal): Promise<PluginSpecInspectionFact>
  /** Select or remove a bundle layer, retaining installed dependencies. */
  setBundleEnabled(name: string, enabled: boolean): Promise<PluginChangeFact>
  /** Persist one Loader entry's desired enablement. */
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginChangeFact>
  /** Unload and remove a profile-owned bundle dependency. */
  removeBundle(name: string): Promise<PluginChangeFact>
  /** Install a package under one caller-owned request id. */
  startInstall(request: PluginInstallRequest): Promise<PluginChangeFact>
  /** Recover an active installation's result without cancelling it; null = unknown. */
  waitForInstall(requestId: string): Promise<PluginChangeFact | null>
  /** Stop an active installation and wait until its files are back. */
  cancelInstall(requestId: string): Promise<PluginInstallCancellationFact>
  /** Subscribe to the official install progress/log events. */
  subscribeInstall(listener: (event: PluginInstallEvent) => void): () => void
  /**
   * Read the published versions newer than one installed profile registry
   * bundle, through the Host's default registry plan. The Host is the registry
   * and compatibility authority: this never guesses a version locally and does
   * not change the profile. `signal` ends the read only.
   */
  listVersions(name: string, signal?: AbortSignal): Promise<PluginVersionListFact>
  /**
   * Replace one installed profile registry bundle with one EXACT published
   * version through the official Host update. `registry` is the one the Host's
   * own `listVersions` answer named (or null for pnpm's configuration).
   * `requestId` names the update progress and its target installation; the
   * Host alone performs the write, its automatic restore and the final result.
   */
  updateBundle(name: string, version: string, registry: string | null, requestId: string): Promise<PluginUpdateResultFact>
  /** Subscribe to the official update step announcements. */
  subscribeUpdate(listener: (progress: PluginUpdateProgressFact) => void): () => void
  /**
   * Subscribe to one transport-neutral invalidation hint: the question it
   * answers is "has something happened that makes the cached snapshot
   * potentially stale, and therefore worthy of an authoritative
   * {@link PluginManagerPort.snapshot} reread?".
   *
   * The listener carries NO new business truth and is NOT authority: only
   * `snapshot()` answers with inventory. It never implies polling, and a
   * consumer that is not showing the inventory must not turn it into a
   * background read. The returned disposer releases exactly this subscription.
   */
  subscribeInvalidation(listener: () => void): () => void
}
