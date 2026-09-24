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
 * Full contract: docs/client-server-migration.md §P1 capability ledger and
 * docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/plugin-manager-port
 */

/** Why a Host control cannot modify one entry (official `ReadOnlyReason`). */
export type PluginReadOnlyReason = 'management-required' | 'unaddressable'

/** One package the running DSH version rejects without an exact exemption. */
export interface PluginIncompatibleFact {
  readonly name: string
  readonly version: string
  readonly runtimeVersion: string
  /** Only the DSH peer ranges the running version does not satisfy. */
  readonly peers: Readonly<Record<string, string>>
}

/** A Host management failure, actionable rather than a generic "failed". */
export interface PluginErrorFact {
  readonly code: string
  readonly diagnostic?: string
  /** Present with `incompatible-version`: the rejected packages. */
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

/** One installed or installation-provided bundle (official `BundleInfo`). */
export interface PluginBundleFact {
  readonly name: string
  readonly version?: string
  readonly title?: string
  readonly description?: string
  /** Selected in the profile manifest. */
  readonly enabled: boolean
  /** Whether the profile's own dependencies hold the package. */
  readonly installed: boolean
  /** Shipped by the installation for the user to switch on; never removable. */
  readonly optional: boolean
  readonly removable: boolean
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
 * Only the facts the TUI renders: the port never mirrors the whole upstream
 * `ChangeResult` (no package output, no Host log path, no profile facts). */
export interface PluginChangeFact {
  readonly changed: boolean
  readonly application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  readonly stage: 'install' | 'enable' | 'remove'
  readonly target: string
  readonly error?: PluginErrorFact
  readonly warnings?: readonly string[]
  /** The bundle an installation added, once pnpm and the bundle check accepted it. */
  readonly bundle?: string
}

/** One user install attempt: exactly one request id owns it. */
export interface PluginInstallRequest {
  /** Caller-owned identity: the SAME id addresses waitForInstall/cancelInstall. */
  readonly requestId: string
  readonly spec: string
  /** The registry asked first; null = the one pnpm's own configuration names. */
  readonly registry: string | null
  readonly enabled?: boolean
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
}
