/**
 * The /login provider surface: a merged catalog of every credential target
 * the deployment can authenticate — deepseek official, every configured
 * llm-pi-ai provider route, and every route the adapter's configurable-
 * provider directory offers (the installed catalog, dormant or not, plus
 * hand-declared profiles). Pure and structurally typed: the llm and settings
 * services are read through minimal interfaces, so an absent service degrades
 * to fewer options instead of failing.
 *
 * The merge mirrors the web Models page (`ui-settings-models` store):
 *   - the llm directory (`listConfigurableProviders`) is the source of what
 *     CAN be configured and where its profile lives (`settingsNs` +
 *     `settingsPath` inside that namespace's section);
 *   - a profile that already exists supplies its `apiKeyEnv` reference;
 *     a route without one falls back to the conventional derived reference
 *     (`<ROUTE>_API_KEY`), exactly like the web's `deriveKeyRef`;
 *   - the deepseek official adapter always leads.
 *
 * @module @xmoon76/dsh-pi-tui/provider-catalog
 */

/** One /login credential target: a human label plus the env-var ref to set. */
export interface LoginCredentialOption {
  readonly label: string
  readonly ref: string
}

/** Extra facts the picker needs beyond a plain option. */
export interface ProviderOption extends LoginCredentialOption {
  /** The provider route key (the settings dict key, e.g. `acme-gateway`). */
  readonly route: string
  /** Whether a user profile already exists in the settings section. */
  readonly configured: boolean
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a hand-written gateway the installed catalog ships nothing
   * about. Only such routes need the full add wizard.
   */
  readonly declared: boolean
  /** Group label for the picker (configured / available / custom). */
  readonly group: 'configured' | 'available' | 'custom'
  /** The settings namespace whose section configures this route ('' when none). */
  readonly settingsNs: string
  /** Path from the namespace root to this route's profile object ('' when the whole section is the profile). */
  readonly settingsPath: readonly string[]
}

/** The structural llm service surface /login reads. */
export interface ProviderCatalogLlm {
  listConfigurableProviders(): readonly ProviderCatalogEntry[]
}

/** One configurable-provider directory entry (dsh-llm LlmConfigurableProvider). */
export interface ProviderCatalogEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly declared?: boolean
}

/** The structural settings service surface /login reads. */
export interface ProviderCatalogSettings {
  get(ns: string): unknown
}

/**
 * Read a value at a dotted path inside a plain object (the web schema-form
 * `getPath` semantics, structural here so /login needs no schema package).
 * @param value - the object to walk.
 * @param path - path segments; the empty path returns `value` itself.
 * @returns the value at the path, or undefined when any segment is missing.
 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Derive the conventional credential reference for a provider route: the web
 * Models page never asks for an environment-variable name, so a typed key
 * stores under this derived reference and the profile records it as
 * `apiKeyEnv`. Kept byte-identical to the web's `deriveKeyRef`.
 * @param provider - provider route id (e.g. `anthropic`, `minimax-cn`).
 * @returns the derived reference name (e.g. `MINIMAX_CN_API_KEY`).
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * A route id usable as a settings key AND as the stem of a credential name.
 * The web create card's pattern: the leading letter is the second half of
 * that — `deriveKeyRef` uppercases the id and replaces every non-alphanumeric
 * run with `_`, and a credential reference is a POSIX shell identifier, which
 * cannot start with a digit. A digit-leading id passes every check this card
 * makes and then fails at the credential seam with a raw regular expression
 * the user cannot act on.
 */
export const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** The wire protocols a hand-declared route may name. Mirrors the pi-ai
 * adapter's `supportedProtocols()`; keep in step with
 * `@deepseek-ai/dsh-llm-pi-ai`'s `PROTOCOLS` table (the drift gate is the
 * adapter's own — a protocol it stops serving must be removed here too). */
export const PROTOCOL_CHOICES = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const

/**
 * Merge the configurable-provider directory with the existing settings
 * section into the /login option list.
 *
 * @param entries - the llm directory entries (or undefined when the llm
 *   service is absent — degrades to the official target only).
 * @param readSection - read one settings namespace's resolved section (the
 *   settings service's `get`); absent namespaces read as undefined.
 * @returns the merged options, deepseek official first, deduped by ref.
 */
export function providerOptionsFor(
  entries: readonly ProviderCatalogEntry[] | undefined,
  readSection: (ns: string) => unknown,
): ProviderOption[] {
  const options: ProviderOption[] = []
  const seen = new Set<string>()
  const push = (option: ProviderOption): void => {
    if (seen.has(option.ref)) return
    seen.add(option.ref)
    options.push(option)
  }
  // The deepseek official adapter leads; it is the one route every deployment
  // can name regardless of the directory (the old /login behavior). It is
  // always "configured" in the sense that its target always exists.
  push({ label: 'deepseek official', ref: 'DEEPSEEK_API_KEY', route: 'deepseek-official', configured: true, declared: false, group: 'configured', settingsNs: '', settingsPath: [] })
  if (entries === undefined) return options
  for (const entry of entries) {
    if (entry.provider.length === 0 || entry.settingsNs.length === 0) continue
    const section = readSection(entry.settingsNs)
    const profile = entry.settingsPath.length === 0
      ? section
      : getPath(section, entry.settingsPath)
    const configured = typeof profile === 'object' && profile !== null
    const namedRef = configured && typeof (profile as { apiKeyEnv?: unknown }).apiKeyEnv === 'string'
      ? (profile as { apiKeyEnv: string }).apiKeyEnv
      : undefined
    const ref = namedRef !== undefined && namedRef !== '' ? namedRef : deriveKeyRef(entry.provider)
    push({
      label: entry.displayName,
      ref,
      route: entry.provider,
      configured,
      declared: entry.declared === true,
      group: configured ? 'configured' : entry.declared === true ? 'custom' : 'available',
      settingsNs: entry.settingsNs,
      settingsPath: [...entry.settingsPath],
    })
  }
  return options
}

/** The credential-target options for /login and /logout: the deepseek
 * official ref always first, then every llm-pi-ai provider route's
 * apiKeyEnv (deduped by ref). `providers` is the llm-pi-ai settings
 * section's `providers` dict, or undefined when the adapter or the settings
 * service is absent — which degrades /login to the official target only.
 * Kept as the settings-only fallback when the llm directory is absent. */
export function credentialOptionsFor(
  providers: Record<string, { apiKeyEnv?: string } | undefined> | undefined,
): LoginCredentialOption[] {
  const options: LoginCredentialOption[] = [{ label: 'deepseek official', ref: 'DEEPSEEK_API_KEY' }]
  if (providers === undefined) return options
  const seen = new Set<string>(options.map(option => option.ref))
  for (const [route, profile] of Object.entries(providers)) {
    const ref = profile?.apiKeyEnv
    if (ref === undefined || ref === '' || seen.has(ref)) continue
    seen.add(ref)
    options.push({ label: route, ref })
  }
  return options
}

/** Resolve a /login or /logout argument to a credential ref. A
 * case-insensitive llm-pi-ai route name wins, then a literal env-var-looking
 * name (any casing, uppercased like the old behavior — `/login my_key` sets
 * `MY_KEY`); anything else is unknown and returns undefined so the caller
 * can list the valid options. */
export function resolveCredentialArg(arg: string, options: readonly LoginCredentialOption[]): string | undefined {
  const trimmed = arg.trim()
  if (trimmed === '') return undefined
  // A route name matches its label; a label's FIRST WORD is an alias, so
  // `/login deepseek` reaches the "deepseek official" entry (the official
  // adapter's route is deepseek).
  const needle = trimmed.toLowerCase()
  const route = options.find(option =>
    option.label.toLowerCase() === needle
    || option.label.split(' ')[0]!.toLowerCase() === needle)
  if (route !== undefined) return route.ref
  // Env-var-looking names are used verbatim (uppercased for convenience,
  // preserving the old `/login <anything>` behavior).
  if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed)) return trimmed.toUpperCase()
  return undefined
}
