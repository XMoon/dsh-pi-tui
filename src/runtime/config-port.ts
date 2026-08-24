/**
 * The config domain port (M1.9) — the semantic contract between the TUI
 * and the Host-owned CONFIGURATION it reads and mutates: the TUI settings
 * document, provider profiles, credentials, authorization flows, permission
 * presets and the saved preset default. Implemented by
 * `src/runtime/direct/` (Direct) today and by a Remote adapter in a later
 * milestone.
 *
 * The port deliberately exposes semantic operations, never generic
 * settings/credentials/authorization service objects (no
 * `settings.get(namespace)` / `settings.mutate(namespace, arbitraryPatch)`
 * god API — the Direct adapter owns the Host schema knowledge, e.g. the
 * `llm-pi-ai` / `permission` / `agent-presets` namespaces). Host schema
 * knowledge is NOT the consumer's business: a command handler never names
 * a settings namespace or path — and the DTOs that cross the port carry
 * SEMANTIC facts only (`CredentialProviderOption.canProvisionProfile`),
 * never a namespace or a path (the adapter maps its schema knowledge to
 * the flag; a Remote adapter computes the same flag from the wire).
 *
 * Future wire mapping (M2): `settings.*` / `credentials.*` remotes and the
 * authorization capabilities; operations with no 1:1 Remote today are
 * recorded as gaps in the contract comments.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/config-port
 */

import type { AuthorizationTarget } from '../authorization.ts'

/** The TUI settings document (theme/iconStyle/footer/footerLayout/
 * fullscreen/busyEnter/localShellSandbox/homeEndKeys/focusMode). The old
 * `history` field moved to $DSH_HOME/user-history/*.jsonl and is
 * deliberately NOT part of the document anymore. `footerLayout` is the
 * M2 versioned custom layout (nested settings object), absent when not
 * configured. The user keybinding overrides (`keybindings`) ride along
 * as an unknown-key pass-through of the schemastery-registered document
 * — the field is RAW EXTENSION DATA, deliberately not a semantic DTO:
 * the keybinding shape is owned by src/keybindings/config.ts (the only
 * validator), and the settings document is the storage the Direct
 * adapter passes through verbatim. A future Remote adapter MUST preserve
 * this raw field verbatim too (get/replace round-trip), never reinterpret
 * it — add a Remote-shaped contract test when the wire backend lands. */
export interface TuiSettingsDoc {
  theme: string
  iconStyle: string
  footer: string
  footerLayout?: unknown
  fullscreen: string
  busyEnter: string
  localShellSandbox: string
  homeEndKeys: string
  focusMode: string
  keybindings?: unknown
}

/** The TUI settings document surface (get/replace — the same shape the
 * commands surface consumes; the runner wires the registered settings
 * document). The port is deliberately get/replace ONLY: no watch /
 * subscribe callback. Change observation is explicit on the consumer
 * side — e.g. `/keybindings reload` re-reads the document — because a
 * callback could not map across the process boundary in the future
 * Remote adapter (migration rule: no callbacks across the wire). */
export interface TuiSettingsConfig {
  get(): TuiSettingsDoc
  replace(doc: TuiSettingsDoc): unknown
}

/** The TUI settings document surface as the commands surface names it
 * (kept as the public commands-surface type — see commands.ts). Like
 * TuiSettingsConfig: get/replace only, never a watch callback. */
export interface TuiSettingsLike {
  get(): TuiSettingsDoc
  replace(doc: TuiSettingsDoc): unknown
}

/** One /login credential target as the CLIENT sees it — a detached DTO
 * with SEMANTIC facts only. The adapter owns every Host schema fact: a
 * consumer never sees a settings namespace or path, only
 * `canProvisionProfile` (whether a keyless profile write for this route
 * would be accepted by the Host). A Remote adapter computes the same flag
 * from the wire. */
export interface CredentialProviderOption {
  /** The provider route key (the settings dict key, e.g. `acme-gateway`). */
  readonly route: string
  /** The human label (the picker row). */
  readonly label: string
  /** The env-var reference this target names (to set or clear). */
  readonly ref: string
  /** Whether a user profile already exists for the route. */
  readonly configured: boolean
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a hand-written gateway the installed catalog ships nothing
   * about. Only such routes need the full add wizard.
   */
  readonly declared: boolean
  /**
   * Whether the route's profile EXPLICITLY names a credential reference
   * (`apiKeyEnv` set to a non-empty env-var name). False for a keyless
   * profile (provider-native auth — an authorization flow owns the
   * credential record), for a bare profile, and for the unconfigured case
   * where the reference is only the derived convention. An explicitly
   * named reference wins over any authorization flow for the same route.
   */
  readonly namesCredential: boolean
  /** Group label for the picker (configured / available / custom). */
  readonly group: 'configured' | 'available' | 'custom'
  /** Whether a keyless profile write for this route would be ACCEPTED by
   * the Host (a real writable slot exists — false for the deepseek
   * official builtin, which has no provider-profile section, and for a
   * route whose directory entry does not map to one). A directory race
   * after the read is still reported by the write's explicit outcome. */
  readonly canProvisionProfile: boolean
}

/** The provider-profile sub-domain: the add-provider wizard and the
 * /login merge. The adapter owns the Host schema knowledge — a consumer
 * names a ROUTE, never a settings namespace or path: the merged
 * credential options (directory + per-entry sections + the settings-only
 * fallback) arrive as one semantic read of detached DTOs, and the keyless
 * profile write resolves the route's location internally. */
export interface ProviderProfileConfig {
  /** Whether the settings service (the persistence surface) is present. */
  available(): boolean
  /** The merged /login credential options: the llm configurable-provider
   * directory over its PER-ENTRY settings sections when the llm service
   * is present, the settings-only fallback otherwise (the pure
   * provider-catalog.ts merge, wired by the adapter). Detached DTOs with
   * semantic flags only — no settings namespace or path ever crosses. */
  listCredentialOptions(): readonly CredentialProviderOption[]
  /** Persist one provider profile (the add-provider wizard; the adapter
   * owns the llm-pi-ai schema). */
  writeProfile(route: string, profile: Record<string, unknown>): Promise<void>
  /** After a successful authorization: write a MINIMAL keyless profile for
   * a catalog route (never an apiKeyEnv — provider-native auth keeps the
   * request path off an unset reference). The adapter resolves the
   * route's profile location internally from the CURRENT directory. The
   * outcome is EXPLICIT: a hostile route (or a route that vanished from
   * the directory) is a `skipped` result with the reason — a caller can
   * never present a non-write as a success. */
  writeKeylessProfile(route: string): Promise<{ kind: 'written' } | { kind: 'skipped'; reason: string }>
}

/** The credentials sub-domain: API-key references and stored credential
 * records. Common DTOs never carry secret values — a secret appears only
 * as the explicit write parameter of `setReference`. */
export interface CredentialConfig {
  /** Whether the credentials service is available in this deployment. */
  available(): boolean
  /** Store one reference credential (the /login API-key path). */
  setReference(ref: string, secret: string): Promise<void>
  /** Clear one reference credential (/logout). */
  unsetReference(ref: string): Promise<void>
  /** Delete one stored credential record (/logout; the authorization
   * flow's durable record). */
  deleteRecord(key: string): Promise<void>
  /** Whether one reference is configured (presence only). */
  describeReference(ref: string): Promise<{ configured: boolean; source?: string }>
  /** Every stored credential record (presence + kind only). */
  listRecords(): Promise<readonly { key: string; kind?: string }[]>
  /** Subscribe to credential surface changes (reference- and
   * record-updated — the footer/welcome refresh; a listener is a LOCAL
   * subscription callback, never a wire callback). Returns the
   * UNSUBSCRIBE — a surface remount/HMR must dispose, never accumulate. */
  onChanged(listener: () => void): () => void
}

/** One authorization flow as the /login surface sees it (detached — the
 * same DTO the authorization.ts helpers consume). */
export type AuthorizationFlowTarget = AuthorizationTarget

/** A detached authorization notice (the message, and the page/code the
 * human must act on — never a secret). */
export interface AuthorizationNoticeEvent {
  message: string
  url?: string
  code?: string
}

/** A detached authorization prompt: the QUESTION the human must answer.
 * `select` answers with the chosen option's id. No callback, no signal —
 * the answer rides `respond`, and a flow withdrawing a prompt arrives as
 * a `prompt-withdrawn` event. */
export type AuthorizationPromptEvent =
  | { kind: 'text'; message: string; placeholder?: string }
  | { kind: 'secret'; message: string; placeholder?: string }
  | { kind: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] }

/** One attempt event as the consumer sees it (detached DTOs only — a
 * Remote adapter replays the same shapes from the wire). */
export type AuthorizationFlowEvent =
  | { kind: 'notice'; attemptId: string; notice: AuthorizationNoticeEvent }
  | { kind: 'prompt'; attemptId: string; promptId: string; prompt: AuthorizationPromptEvent }
  | { kind: 'prompt-withdrawn'; attemptId: string; promptId: string }
  | { kind: 'settled'; attemptId: string; status: 'authorized' | 'cancelled' | 'failed'; code?: string; message?: string }

/** The authorization sub-domain: provider sign-in flows. The seam owns
 * the protocol/lifecycle; this port exposes the targets and an
 * EVENT-DRIVEN attempt surface — the TUI never hands the Host a
 * callback-bearing interaction (transport rule: only data, identities,
 * methods and events cross the boundary). */
export interface AuthorizationConfig {
  /** Whether the authorization service is available in this deployment. */
  available(): boolean
  /** The registered flows as detached targets. */
  listTargets(): readonly AuthorizationFlowTarget[]
  /** Start one flow. The attempt's notices/prompts/settlement arrive on
   * the event subscription; `respond`/`cancel` answer it. */
  begin(request: {
    key: string
    method?: string
    signal?: AbortSignal
  }): Promise<{ kind: 'started'; attemptId: string } | { kind: 'unavailable' }>
  /** Subscribe to attempt events (a LOCAL listener — never a wire
   * callback); returns the unsubscribe. */
  onEvent(listener: (event: AuthorizationFlowEvent) => void): () => void
  /** Answer the pending prompt of an attempt (null = the human declined).
   */
  respond(attemptId: string, promptId: string, answer: string | null): Promise<void>
  /** Withdraw one whole attempt (a Cancel action). */
  cancel(attemptId: string): Promise<void>
}

/** The permission sub-domain: permission preset names, the persisted
 * default, and preset application (/yolo). */
export interface PermissionConfig {
  /** The advertised preset names, in the preset table's declaration order. */
  presetNames(): readonly string[]
  /** The persisted default preset (settings), undefined when absent or
   * unreadable. */
  defaultPreset(): string | undefined
  /** Persist the default preset for future sessions. */
  setDefaultPreset(name: string): Promise<void>
  /** Apply one permission preset to a live session (/yolo applies
   * `danger-full-access` through the OFFICIAL command line so the switch
   * takes the exact host path — sandbox + approval writer + policy-change
   * message + preset log). */
  applyPermissionPreset(
    sessionId: string,
    presetId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: 'applied' } | { kind: 'unavailable'; cause: 'commands' | 'permission' }>
}

/** The saved agent-preset default sub-domain (`/preset default`): the
 * persisted default (settings `agent-presets.default`), falling back to
 * the roster's own default. */
export interface PresetDefaultConfig {
  /** Whether the settings service (the persistence surface) is present. */
  available(): boolean
  /** The saved default preset id (settings), falling back to the roster
   * default when no user value is saved. */
  get(): string | undefined
  /** Persist the default preset for future sessions. */
  set(id: string): Promise<void>
}

/** The config assembly — one narrow sub-interface per config domain.
 * Consumers depend on the sub-interface they use, never on the whole
 * assembly (no generic settings god API). */
export interface ConfigPort {
  /** The TUI settings document (theme/footer/...). */
  readonly tuiSettings: TuiSettingsConfig | undefined
  /** Provider profiles (the add-provider wizard + /login section reads). */
  readonly providers: ProviderProfileConfig
  /** Credentials (API keys + stored records). */
  readonly credentials: CredentialConfig
  /** Provider authorization flows. */
  readonly authorization: AuthorizationConfig
  /** Permission presets (names/default/apply). */
  readonly permissions: PermissionConfig
  /** The saved default agent preset. */
  readonly presetDefault: PresetDefaultConfig
}
