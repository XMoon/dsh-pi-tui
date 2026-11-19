/**
 * The Client's narrow Computer Use access port (PR-5 / MAC-09 v2).
 *
 * ONE semantic surface for the official CUA provider's permission and
 * application-decision work, served by each backend's own adapter:
 *
 * ```text
 * Direct  the official Host `cuaAccess` service in the running dsh Context
 *         (absent until the official Computer Use bundle is actually loaded)
 * Remote  the official generated `@deepseek-ai/dsh-cua/remote` namespace over
 *         the ONE mounted Client contribution and the authenticated connection
 * ```
 *
 * The port owns NO permission truth, cache or optimistic state: every read and
 * write reaches the Host provider and returns exactly what the provider
 * reached. The Host remains the only authority for Accessibility, Screen
 * Recording, helper/launch-application identity, PTC execution state and
 * persisted application decisions.
 *
 * Deliberately independent of the package's private wire types: this DTO is
 * the TUI's semantic vocabulary and does not publish a Typert contract.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/cua-access-port
 */

/** The two macOS privacy privileges the official CUA helper needs. */
export type CuaPermission = 'accessibility' | 'screenRecording'

/** One native process identity the official provider reports. */
export interface CuaProcessIdentity {
  readonly pid: number
  readonly path?: string
  readonly name?: string
}

/** The application macOS reports as responsible for the helper. */
export interface CuaLaunchApplication {
  readonly name: string
  readonly path: string
  readonly icon?: string
}

/**
 * The official provider's platform-tagged permission observation.
 *
 * The macOS branch is the only branch this PR's UI can operate; a non-darwin
 * Host carries a truthful platform fact and is presented as unsupported, never
 * as a macOS denial or a Windows CUA enablement.
 */
export type CuaSystemStatus =
  | {
    readonly platform: 'darwin'
    readonly accessibility: boolean
    readonly screenRecording: boolean
    readonly helper: CuaProcessIdentity
    readonly parent: CuaProcessIdentity
    readonly launchApplication?: CuaLaunchApplication
  }
  | {
    readonly platform: 'win32'
    readonly sessionLocked: boolean | null
    readonly captureAvailable: boolean
    readonly elevated: boolean
    readonly helper: CuaProcessIdentity
  }

/** One opaque persisted application decision identity. */
export type CuaApplicationId = string

/** One persisted application decision, including the display label. */
export interface CuaApplicationFact {
  readonly id: CuaApplicationId
  readonly name: string
  readonly executablePath?: string
}

/** The official fresh stored application decisions. */
export interface CuaApplicationState {
  /** Saved grants that survive every Session. */
  readonly allowedApps: readonly CuaApplicationFact[]
  /** Refusals from any Session; other Sessions may still hold session access. */
  readonly blockedApps: readonly CuaApplicationFact[]
  /** Whether durable storage is available on this Host. */
  readonly persistentAvailable: boolean
}

/** The official PTC execution state, editable only when `writable`. */
export interface CuaPtcConfiguration {
  readonly persistent: boolean
  readonly writable: boolean
}

/**
 * The Host/provider cannot serve the CUA access surface at all: the official
 * bundle is not loaded, the provider is unavailable, the generated Remote
 * namespace is not mounted, or the Client has no Host connection. This is a
 * definite unavailable, never a denied permission or a fabricated Ready.
 */
export class CuaAccessUnavailableError extends Error {
  constructor(message = 'the official Computer Use access service is not available on this Host') {
    super(message)
    this.name = 'CuaAccessUnavailableError'
  }
}

/**
 * The Host observation basis of the CUA access port: a token that changes when
 * the provider/service or the Split connection generation changes, plus the
 * subscription that lets a per-open page discard an older observation before
 * it can paint or dispatch against the new one.
 */
export interface CuaAccessObservation {
  readSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/**
 * The ONE Client-side access surface of the official CUA provider.
 *
 * Reads never mutate; every write is an explicit user action and its result is
 * an action receipt, not a permission state. A caller that needs the resulting
 * permission state must perform a fresh read afterwards.
 */
export interface CuaAccessPort {
  /** The Host observation basis this port's reads and actions belong to. */
  readonly observation: CuaAccessObservation
  /** Read the official platform-tagged permission observation. */
  readSystemStatus(): Promise<CuaSystemStatus>
  /** Read fresh stored application decisions without issuing a native request. */
  readApplications(): Promise<CuaApplicationState>
  /** Load presentation icons separately from application decisions. */
  readApplicationIcons(): Promise<Readonly<Record<string, string>>>
  /** Read PTC execution state separately from native permission checks. */
  readPtcConfiguration(): Promise<CuaPtcConfiguration>
  /** Request the selected system privilege through the official native guide. */
  requestPermission(permission: CuaPermission, locale: string): Promise<CuaSystemStatus>
  /** Open the macOS privacy pane selected by the user. */
  openSettings(permission: CuaPermission, locale: string): Promise<void>
  /** Persist in-memory PTC execution through the official profile editor. */
  enablePersistentPtc(): Promise<void>
  /** Remove the exact saved/session application access and join affected work. */
  revoke(id: CuaApplicationId): Promise<void>
  /** Clear one application's refusals across Sessions; it grants nothing. */
  retryApproval(id: CuaApplicationId): Promise<void>
}
