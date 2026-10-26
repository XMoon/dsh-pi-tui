/**
 * Built-in command definitions for the TUI settings/display domain
 * (/settings, /footer, /display, /focus, /keybindings) plus their
 * domain-local helpers.
 *
 * Registration is explicit: the coordinator (src/commands.ts) calls each
 * registrar at its frozen position in the built-in registration sequence and
 * owns catalog/provenance/disposal state. This module owns command-definition
 * and presentation logic only — never TUI settings persistence authority:
 * every write still goes through the same runner settings/config seams.
 * @module @xmoon76/dsh-pi-tui/commands/settings
 */

import type { SettingItem } from '@xmoon76/pi-tui'
import { getKeybindings } from '@xmoon76/pi-tui'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { TuiApp } from '../../tui-app.ts'
import { applyHomeEndKeyMode, homeEndKeysModeOf } from '../keybindings/home-end-mode.ts'
import { isDisplayPreset, isDisplayPresetAvailable, type DisplayPreset, type DisplayPresetApplyResult } from '../../domain/display/preset.ts'
import { parseProgressUpdates, parseResponseStyle } from '../../domain/communication/policy.ts'
import { parseGitAttributionMode } from '../../domain/communication/git-attribution.ts'
import { parseNotificationMethod, parseNotificationMode } from '../../domain/notification/settings.ts'
import { parseTerminalProgressMode } from '../../domain/terminal-progress/settings.ts'
import { localShellSandboxPreferenceOf } from '../../app/submission/shell-context.ts'
import { WHEEL_SCROLL_LINE_VALUES, wheelScrollLinesOf } from '../../domain/display/wheel-scroll.ts'
import { iconStyleOf } from '../../domain/display/icons.ts'
import { parseUserKeybindings } from '../keybindings/config.ts'
import { formatKeyId } from '../keybindings/hints.ts'
import type { AppKeybindingId } from '../keybindings/types.ts'
import { KeybindingEditorController } from '../keybindings/ui/controller.ts'
import { KeybindingEditorPanel, KeybindingEditorUnavailablePanel } from '../keybindings/ui/list.ts'
import { buildKeybindingEditorModel, type KeybindingEditorModel } from '../keybindings/ui/model.ts'
import { parseFooterLayout, isFooterLayout } from '../../domain/footer/layout.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../../domain/footer/presets.ts'
import { FooterComposer } from '../footer/composer.ts'
import { FooterCustomItemCatalog } from '../footer/custom-item-catalog.ts'
import {
  parseFooterCustomItem,
  parseFooterCustomItems,
  type FooterCustomItemSettings,
} from '../../domain/footer/custom-items.ts'
import { FooterItemRegistry } from '../footer/item-registry.ts'
import { FooterConfiguratorModel, sameFooterCustomItem } from '../footer/configurator-model.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { color } from '../theme/runtime.ts'
import { themeDisplayName as themeDisplayNameOf } from '../pickers/theme-menu.ts'
import { SubagentModelAllowlistPicker, allowlistSummary, lastRouteWhileEnabled } from '../pickers/subagent-model-menu.ts'
import { resolveThemeSelection, themePickerRows } from '../../app/surface/theme-selection.ts'
import { normalizePersistedTheme } from '../../domain/display/theme-selection.ts'
import { serializeTuiSettingsMutation, type ConfigPort, type TuiSettingsDoc, type VisualToolsState, type WebProviderSettings } from '../../runtime/config-port.ts'
import {
  WEB_FETCH_PROVIDER_CANDIDATES,
  WEB_SEARCH_PROVIDER_CANDIDATES,
  WEB_SETTINGS_PAGE_TITLE,
  WebSettingsPage,
  type WebCommitResult,
  type WebSettingRowId,
  type WebSettingsFacts,
} from '../panels/web-settings-page.ts'
import { ModelsWorkspacePage, type ModelsInitialView, type ModelsWorkspaceSource } from '../panels/models-workspace-page.ts'
import { AccountWorkspacePage, type AccountInitialView } from '../panels/account-workspace-page.ts'
import { CredentialWorkflow, type AuthDestination } from '../../app/command/credential-workflow.ts'
import { AccountWorkflow } from '../../app/command/account-workflow.ts'
import { AboutStatusController } from '../../app/command/about-status.ts'
import { bundleVersion, dshVersion, packageVersion } from '../../client/launcher/version.ts'
import { openExternalUrl } from '../../client/url/open.ts'
import type {
  SettingsWorkspaceCategoryId,
  SettingsWorkspaceCommitOutcome,
  SettingsWorkspaceCommitRequest,
  SettingsWorkspaceEdit,
  SettingsWorkspaceEditOption,
  SettingsWorkspaceFreshness,
  SettingsWorkspaceRow,
  SettingsWorkspaceRowId,
  SettingsWorkspaceSnapshot,
  SettingsWorkspaceWritableField,
} from '../panels/settings-workspace-panel.ts'
import { SETTINGS_SPECIALIST_ROUTE_ROW } from '../panels/settings-workspace-panel.ts'
import { displaySessionId } from './sessions.ts'
import type {
  DetachTask,
  RegisterOne,
  RegisterTuiCommand,
  TuiCommandRunner,
} from '../../commands.ts'

/** The runner operations the settings/display commands consume. */
type SettingsCommandRunner = Pick<
  TuiCommandRunner,
  | 'applyFooterSettings'
  | 'backendKind'
  | 'captureLiveSessionScope'
  | 'catalog'
  | 'clientCommands'
  | 'config'
  | 'createPluginManagerPage'
  | 'currentApprovalOverride'
  | 'currentNotificationMethod'
  | 'currentNotificationMode'
  | 'currentPreset'
  | 'currentSessionId'
  | 'currentSessionRouting'
  | 'currentSessionStats'
  | 'diag'
  | 'displayPreset'
  | 'extensions'
  | 'focusEnabled'
  | 'forceContextMeasurementResult'
  | 'gitAttributionState'
  | 'isSessionScopeCurrent'
  | 'progressUpdatesState'
  | 'refreshStatus'
  | 'responseStyleState'
  | 'sessionCwd'
  | 'sessionReader'
  | 'setDisplayPreset'
  | 'setFocusMode'
  | 'setNotificationMethod'
  | 'setNotificationMode'
  | 'setTerminalProgressMode'
  | 'setSessionApprovalPolicy'
  | 'signal'
  | 'subscribeSessionScopeInvalidation'
  | 'copyToClipboard'
  | 'tuiSettings'
>

/** The R1 candidate identities, in their FROZEN order: the raw values the
 *  document stores and the commit sends. The labels are the same lowercase
 *  identities, so a candidate never round-trips through presentation text. */
const ICON_STYLE_CANDIDATES = ['emoji', 'symbols', 'minimal'] as const
const DISCLOSURE_CANDIDATES = ['collapsed', 'expanded'] as const
const PROGRESS_UPDATES_CANDIDATES = ['off', 'milestones', 'frequent'] as const
const RESPONSE_STYLE_CANDIDATES = ['default', 'concise', 'explanatory'] as const

/** C2-R2: the eight migrated Conversation / Input & Terminal candidates, in
 *  their frozen order. Each list is the EXACT raw string the document stores,
 *  so a confirmed candidate never round-trips through presentation text. */
const BUSY_ENTER_CANDIDATES = ['queue', 'steer'] as const
const GIT_ATTRIBUTION_CANDIDATES = ['off', 'product', 'product-model'] as const
const HOME_END_CANDIDATES = ['input', 'viewport'] as const
const FULLSCREEN_CANDIDATES = ['off', 'on'] as const
const NOTIFICATION_MODE_CANDIDATES = ['unfocused', 'always', 'off'] as const
const NOTIFICATION_METHOD_CANDIDATES = ['auto', 'osc9', 'osc777', 'bell'] as const
const TERMINAL_PROGRESS_CANDIDATES = ['9;4+7501', '9;4', '7501', 'off'] as const

/** C2-R3: the Agent category's raw candidate identities. Approval and the
 *  subagent toggle are the official `ask|never` / `off|on` values; the user
 *  shell sandbox policy is the RAW TUI-document value (never the consumer's
 *  bypass fallback). The default-permission roster is NOT a constant: its
 *  candidates are the Host's own advertised preset ids, in Host order. */
const APPROVAL_CANDIDATES = ['ask', 'never'] as const
const SUBAGENT_SELECTION_CANDIDATES = ['off', 'on'] as const
const LOCAL_SHELL_SANDBOX_CANDIDATES = ['bypass', 'sandbox'] as const

/** C2-R5: the Footer page's native-mode candidates, in their frozen order. The
 *  raw stored `command` value is a USER opt-in that this page DISPLAYS but
 *  never offers as a candidate (choosing a native mode replaces it). */
const FOOTER_MODE_CANDIDATES = ['default', 'compact', 'custom'] as const

/** Whether a confirmed value really is one of a field's frozen candidates. The
 *  parsers' default fallbacks are NOT a validation substitute: a writer must
 *  refuse an unknown identity BEFORE it mutates anything. */
function isCandidateOf<T extends string>(value: string, candidates: readonly T[]): value is T {
  return (candidates as readonly string[]).includes(value)
}

export interface SettingsCommandDeps {
  runner: SettingsCommandRunner
  app: TuiApp
  registerOne: RegisterOne
  registerTuiCommand: RegisterTuiCommand
  detach: DetachTask
  recordExtensionError: TuiCommandRunner['recordExtensionError']
  clearExtensionError: TuiCommandRunner['clearExtensionError']
  captureExtensionHealthRef: TuiCommandRunner['captureExtensionHealthRef']
}

export interface SettingsCommandRegistrars {
  registerSettings(): void
  registerFooter(): void
  registerDisplay(): void
  registerFocus(): void
  registerKeybindings(): void
  /** The ONE `/login` / `/logout` navigation entry: resolve the semantic
   *  destination and open the Settings workspace at it. It never executes a
   *  credential operation itself. */
  openAuthWorkspace(destination: AuthDestination): CommandResult
  /**
   * `/plugins`: the canonical sessionless entry into `Settings → Plugins`.
   * It takes the SAME Settings workspace lease (no second screen, no Session
   * create/switch) and lands on the Plugin List with the keyboard on it.
   */
  openPluginsWorkspace(): CommandResult
}

/**
 * Create the settings/display registrars over the coordinator's primitives.
 * The factory only closes over its dependencies; it registers nothing until
 * one of the returned registrars is called at its frozen position.
 */
export function createSettingsCommands(deps: SettingsCommandDeps): SettingsCommandRegistrars {
  const {
    runner,
    app,
    registerOne,
    registerTuiCommand,
    detach,
    recordExtensionError,
    clearExtensionError,
    captureExtensionHealthRef,
  } = deps

  // ── Phase 3C / C2-MA: the ONE credential workflow and the two direct pages ──
  //
  // The workflow owns target resolution + provider/key/record operations over
  // the ConfigPort; the pages own view/draft state only. Both are constructed
  // ONCE per command coordinator (the ConfigPort is stable for the process
  // run) and every page instance receives the SAME semantics.
  let credentialWorkflowInstance: CredentialWorkflow | undefined
  /** Construct the workflows LAZILY: ordinary startup (and every non-Models
   *  command) must not require a ConfigPort at all. */
  const credentialWorkflowOf = (): CredentialWorkflow => {
    credentialWorkflowInstance ??= new CredentialWorkflow({
      providers: runner.config.providers,
      credentials: runner.config.credentials,
      authorization: runner.config.authorization,
      account: runner.config.account,
      catalog: runner.catalog,
      signal: runner.signal,
      diag: runner.diag,
    })
    return credentialWorkflowInstance
  }
  const copyText = (text: string): void => {
    detach('settings copy', () => runner.copyToClipboard(text), { notify: true })
  }
  let accountWorkflowInstance: AccountWorkflow | undefined
  const accountWorkflowOf = (): AccountWorkflow => {
    accountWorkflowInstance ??= new AccountWorkflow({
      account: runner.config.account,
      version: packageVersion(),
      openUrl: (url: string) => openExternalUrl(url),
      copy: copyText,
      run: (label: string, task: () => Promise<void>) => { detach(label, task, { notify: false }) },
      diag: runner.diag,
    })
    return accountWorkflowInstance
  }
  const createModelsSource = (): ModelsWorkspaceSource => {
    const workflow = credentialWorkflowOf()
    return {
    available: runner.config.credentials.available() && runner.config.providers.available(),
    // The ONE catalog read: every provider row comes from ONE provider
    // snapshot, so a refresh never repeats the directory enumeration or the
    // settings read per route.
    readCatalog: async () => {
      const catalog = workflow.readCatalog()
      if (catalog.failure !== undefined) return { kind: 'failed' as const, reason: catalog.failure }
      const profileOf = (route: string) => catalog.profiles.get(route) ?? { route, configured: false, models: [] }
      const optionOf = (route: string) => catalog.options.find(option => option.route === route)
      const rows = catalog.targets.map(target => target.kind === 'reference'
        ? {
            kind: 'reference' as const,
            identity: `route:${target.route}`,
            route: target.route,
            label: target.label,
            ref: target.ref,
            configured: target.configured,
            declared: target.declared,
            namesCredential: target.namesCredential,
            canProvisionProfile: optionOf(target.route)?.canProvisionProfile === true,
            ...(optionOf(target.route)?.group === undefined ? {} : { group: optionOf(target.route)!.group }),
            methods: [],
            inFlight: false,
            profile: profileOf(target.route),
          }
        : {
            kind: 'authorization' as const,
            identity: `auth:${target.key}`,
            route: target.route ?? '',
            label: target.label,
            key: target.key,
            configured: false,
            declared: false,
            namesCredential: false,
            canProvisionProfile: false,
            // A flow that no provider option addresses (a foreign scope) has
            // no group: it is an "Other sign-in", not a provider row.
            ...(optionOf(target.route ?? '')?.group === undefined ? {} : { group: optionOf(target.route!)!.group }),
            methods: target.methods.map(method => ({ ...method })),
            inFlight: target.inFlight,
            profile: target.route === undefined
              ? { route: '', configured: false, models: [] }
              : profileOf(target.route),
          })
      // A stale mirror: the LAST KNOWN rows, explicitly not current.
      if (catalog.stale === true) return { kind: 'stale' as const, rows }
      return { kind: 'ready' as const, rows }
    },
    accountSummary: () => workflow.accountSummary(),
    credentialState: async (ref: string) => {
      const info = await workflow.describeReference(ref)
      return {
        kind: 'known' as const,
        configured: info.configured,
        ...(info.source === undefined ? {} : { source: info.source }),
      }
    },
    recordPresence: () => workflow.recordPresence(),
    storedCredentials: () => workflow.storedCredentials(),
    describeReference: (ref: string) => workflow.describeReference(ref),
    setReference: (ref: string, secret: string) => workflow.setReference(ref, secret),
    clearReference: (ref: string) => workflow.clearReference(ref),
    deleteRecord: (key: string) => workflow.deleteRecord(key),
    beginAuthorization: (key: string, method: string | undefined, signal: AbortSignal) =>
      workflow.beginAuthorization(key, method, signal),
    authorizationEvents: listener => workflow.authorizationEvents(listener),
    respondAuthorization: (attemptId: string, promptId: string, answer: string | null) =>
      workflow.respondAuthorization(attemptId, promptId, answer),
    cancelAuthorization: (attemptId: string) => workflow.cancelAuthorization(attemptId),
    provisionKeylessProfile: (route: string | undefined) => workflow.provisionKeylessProfile(route),
    discoverModels: request => workflow.discoverModels(request),
    createProvider: draft => workflow.createProvider(draft),
    configGuide: () => workflow.configGuide(),
    openUrl: (url: string) => openExternalUrl(url),
    copy: copyText,
    run: (label: string, task: () => Promise<void>) => { detach(label, task, { notify: false }) },
    }
  }
  const createModelsPage = (initial: ModelsInitialView, openAccount: () => void) =>
    new ModelsWorkspacePage(createModelsSource(), () => app.requestRender(), initial, openAccount)
  const createAccountPage = (initial: AccountInitialView) =>
    new AccountWorkspacePage(accountWorkflowOf(), () => app.requestRender(), initial)

  // ── S2/PR-B §3.3 / §B3.4: the Web Search / Fetch settings section ──────
  //
  // The Host owns the values (the `web` / `web-deepseek-api` settings sections
  // and the `ctx.web` selection at CALL time); this command owns only the
  // presentation and the ONE serialized write entry. State vocabulary is the
  // frozen design language §4A.2: `Loading…` / `Saving…` are textDim words,
  // `Verified` is success, `Not saved` is error, `Outcome unknown` is warning,
  // and `Unavailable` states a fact with its reason. `[current]` and
  // `[default]` are INDEPENDENT state chips (§4.5): `[current]` only moves
  // after a mutation AND its authoritative read-back agree.

  /** The `Tools`-category Web page row id (a NAVIGATION row: it never becomes a
   *  Workspace editable field, so the editable-row count is unchanged). */
  const WEB_LAUNCHER_ROW_ID = 'web-settings'
  /** The SAME official candidate identities the Web page renders and the ONE
   *  commit entry accepts (one source, so the page and the writer can never
   *  disagree). */
  const WEB_SEARCH_PROVIDER_VALUES = WEB_SEARCH_PROVIDER_CANDIDATES
  const WEB_FETCH_PROVIDER_VALUES = WEB_FETCH_PROVIDER_CANDIDATES

  /** The last AUTHORITATIVE Web provider read. Never a defaulted value: while
   *  it is undefined the section shows Loading…/Unavailable, never a shipped
   *  default presented as the Host's answer. */
  let webSettings: WebProviderSettings | undefined
  let webReadFailure: string | undefined
  /** The LATEST read: its serial decides which settlement may commit facts (a
   *  read that STARTED earlier must never overwrite a newer observation). */
  let webReadInFlight: { readonly serial: number; readonly promise: Promise<WebProviderSettings | undefined> } | undefined
  let webReadSerial = 0
  /** Whether at least one read COMPLETED (a resolved `undefined` is
   *  Unavailable, never an eternal `Loading…`). */
  let webReadSettled = false

  /**
   * ONE Host read per call: the LATEST settlement owns the facts. A read that
   * started earlier but settles later cannot commit (another read may already
   * have observed the Host AFTER a write), and every commit repaints the panel
   * generation that currently owns the surface — so a Workspace reopened
   * mid-write can never leave the surface permanently on a pre-write snapshot.
   */
  const readWebSettings = async (): Promise<{ settings: WebProviderSettings | undefined; fresh: boolean }> => {
    const serial = ++webReadSerial
    const promise = (async (): Promise<WebProviderSettings | undefined> => await runner.config.web.read())()
    webReadInFlight = { serial, promise }
    let settings: WebProviderSettings | undefined
    let failure: string | undefined
    try {
      settings = await promise
    } catch (error) {
      failure = safeErrorMessage(error)
    }
    const fresh = serial === webReadSerial
    if (fresh) {
      // A resolved read (including `undefined` = no readable authority)
      // REPLACES the previous value; a failure is UNKNOWN and drops it.
      webSettings = failure === undefined ? settings : undefined
      webReadFailure = failure
      webReadSettled = true
      // The committed facts repaint whichever generation owns the surface: a
      // write's verification read must converge a Workspace reopened mid-write.
      // Only the Web launcher ROW changes here — never a second document read.
      activeSettingsWorkspace?.refreshWebRow()
    }
    if (webReadInFlight?.serial === serial) webReadInFlight = undefined
    return { settings: failure === undefined ? settings : undefined, fresh }
  }

  /** Wait until the NEWEST read has SETTLED (its facts are committed): a write
   *  verdict is then decided by the newest authority facts, never by a snapshot
   *  a later read superseded. A read STARTED during the wait is the newer
   *  authority and must settle first too, so the loop re-checks the in-flight
   *  serial after every await. Every iteration awaits a read the Host already
   *  accepted, so the loop can only continue while reads keep being started — it
   *  never spins without an await, and judging from a still-pending snapshot
   *  would be exactly the bug this wait exists to prevent. */
  const awaitWebSettled = async (): Promise<void> => {
    for (;;) {
      const inFlight = webReadInFlight
      if (inFlight === undefined) return
      try {
        await inFlight.promise
      } catch {
        // The failure is recorded by `readWebSettings`; the caller decides from
        // the committed facts (an unreadable authority is never a verdict).
      }
    }
  }

  /** A read issued AFTER a write. It starts from the pending state and reports
   *  whether its settlement was still the LATEST one: a newer read may have
   *  observed the Host after this one was issued, and then THIS snapshot must
   *  not decide a verdict. */
  const rereadWebSettings = async (): Promise<{ settings: WebProviderSettings | undefined; fresh: boolean }> => {
    beginWebSettingsRead()
    return await readWebSettings()
  }

  const webSettingsAvailable = (): boolean => runner.config.web.available()

  /** Why the Web page may not commit right now. The page keeps painting the
   *  LAST read facts (they are readable), but it offers no confirmable
   *  candidate, no endpoint draft and no credential action while the backend is
   *  not current — the commit entry would refuse every one of them at its turn,
   *  so offering them would be a false affordance. */
  const webWritableRefusal = (): string | undefined => {
    if (!webSettingsAvailable()) return 'the Host Web provider settings are not available on this backend'
    const readiness = runner.config.configReadiness()
    if (readiness === 'ready') return undefined
    return readiness === 'stale'
      ? 'the configuration is not current (reconnecting): Web settings are read-only until it reconnects'
      : 'the configuration backend is unavailable: Web settings are read-only'
  }

  /** The LATEST authority facts the Web page renders. A pending read is
   *  `pending` (never a last-known value presented as current); an unavailable
   *  backend, a failed read and a resolved-but-unreadable read each state their
   *  OWN reason. */
  const webSettingsFacts = (): WebSettingsFacts => {
    if (!webSettingsAvailable()) {
      return { kind: 'unavailable', reason: 'the Host Web provider settings are not available on this backend' }
    }
    if (!webReadSettled) return { kind: 'pending' }
    if (webReadFailure !== undefined) return { kind: 'unavailable', reason: webReadFailure }
    if (webSettings === undefined) return { kind: 'unavailable', reason: 'the Host Web settings could not be read' }
    return { kind: 'ready', settings: webSettings }
  }

  /** A provider's official display name, or the configured custom id verbatim
   *  (a custom route is reported as-is and never silently replaced). */
  const providerLabel = (
    values: readonly { readonly id: string; readonly label: string }[],
    id: string | undefined,
  ): string | undefined => id === undefined ? undefined : (values.find(entry => entry.id === id)?.label ?? id)

  /** The SETTLED Host value only (never a transient word): this is what a
   *  choice row positions itself on and what a failed write reverts to. */
  const webSettledValue = (id: WebSettingRowId): string | undefined => {
    if (webSettings === undefined) return undefined
    switch (id) {
      case 'web-search-provider': return providerLabel(WEB_SEARCH_PROVIDER_VALUES, webSettings.searchProvider)
      case 'web-fetch-provider': return providerLabel(WEB_FETCH_PROVIDER_VALUES, webSettings.fetchProvider)
      case 'web-search-count': return String(webSettings.api.count)
      case 'web-send-original-question': return webSettings.api.sendOriginalQuestion ? 'on' : 'off'
      case 'web-search-endpoint': return webSettings.api.baseURL
    }
  }

  /** The launcher row's facts. The Settings workspace snapshot is SYNCHRONOUS
   *  and the command reads the Host BEFORE the workspace leases the screen, so
   *  the first frame already carries authoritative values; a missing or failed
   *  read is stated, never defaulted. */
  const webWorkspaceRowFacts = (): { summary: string; freshness: SettingsWorkspaceFreshness; description: string } => {
    const description = 'Host Web settings for the base profile, not an Optional Bundle. Defaults: Messages search · HTTP fetch; other bundles never change them and the defaults call no billed API. The Search/Fetch APIs are billed separately as opt-in providers (a Messages plan does not guarantee coverage) and send the request to the configured endpoint. Share Original Question is on by default: it sends up to 128 characters of the human question (never the full history or system prompt). The key stays in the official credential reference and is never shown. Enter opens the Web Search / Fetch page in this same workspace: each value is written only by its own explicit Confirm and reads Verified only after the Host write and authoritative read-back agree.'
    if (!webSettingsAvailable()) {
      return { summary: 'Unavailable', freshness: 'unavailable', description: `${description} Not supported on this backend.` }
    }
    if (webReadFailure !== undefined) {
      return { summary: 'Unavailable', freshness: 'read-error', description: `${description} Read error: ${webReadFailure}` }
    }
    if (webSettings === undefined) {
      return webReadSettled
        ? { summary: 'Unavailable', freshness: 'unavailable', description }
        : { summary: 'Loading…', freshness: 'runtime', description }
    }
    return {
      summary: `Search: ${providerLabel(WEB_SEARCH_PROVIDER_VALUES, webSettings.searchProvider) ?? 'unavailable'} · Fetch: ${providerLabel(WEB_FETCH_PROVIDER_VALUES, webSettings.fetchProvider) ?? 'unavailable'}`,
      freshness: 'ready',
      description,
    }
  }

  /** The ONE Web write chain of this command owner. Every Web mutation (the
   *  page's five fields and the endpoint draft) joins THIS chain: a slow
   *  earlier mutation can never land after a newer one. */
  let webWriteChain: Promise<void> = Promise.resolve()

  /** Queue one Web-section operation on the ONE owner FIFO. */
  const queueWebOperation = <T>(task: () => Promise<T>): Promise<T> => {
    const run = webWriteChain.then(task)
    webWriteChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** The exact ConfigPort operation one choice row means (undefined = the value
   *  is not one this UI writes, so the row is restored unchanged). The ENDPOINT
   *  row is owned by the exclusive endpoint editor, which passes its draft
   *  through `commitWebIntent` directly. */
  const webWriteFor = (id: WebSettingRowId, value: string): (() => Promise<void>) | undefined => {
    switch (id) {
      case 'web-search-provider': {
        const candidate = WEB_SEARCH_PROVIDER_VALUES.find(entry => entry.label === value || entry.id === value)
        return candidate === undefined ? undefined : () => runner.config.web.setSearchProvider(candidate.id)
      }
      case 'web-fetch-provider': {
        const candidate = WEB_FETCH_PROVIDER_VALUES.find(entry => entry.label === value || entry.id === value)
        return candidate === undefined ? undefined : () => runner.config.web.setFetchProvider(candidate.id)
      }
      case 'web-search-count': {
        const count = Number(value)
        return Number.isInteger(count) && count >= 1 && count <= 50
          ? () => runner.config.web.setSearchApiCount(count)
          : undefined
      }
      case 'web-send-original-question':
        return value !== 'on' && value !== 'off'
          ? undefined
          : () => runner.config.web.setSendOriginalQuestion(value === 'on')
      case 'web-search-endpoint':
        // Owned by the exclusive endpoint editor (it validates, writes and
        // verifies before closing), so the row's own commit carries no write.
        return undefined
    }
  }

  /** The RAW identity one requested value means, or undefined when this UI never
   *  writes it. Providers accept their official id OR their display label (the
   *  page submits ids, an already-stored label still names the same route); the
   *  write itself only ever uses the official id. */
  const webRequestedIdentity = (id: WebSettingRowId, requested: string): string | undefined => {
    switch (id) {
      case 'web-search-provider':
        return WEB_SEARCH_PROVIDER_VALUES.find(entry => entry.id === requested || entry.label === requested)?.id
      case 'web-fetch-provider':
        return WEB_FETCH_PROVIDER_VALUES.find(entry => entry.id === requested || entry.label === requested)?.id
      case 'web-search-count': {
        const count = Number(requested)
        return Number.isInteger(count) && count >= 1 && count <= 50 ? String(count) : undefined
      }
      case 'web-send-original-question':
        return requested === 'on' || requested === 'off' ? requested : undefined
      case 'web-search-endpoint':
        return requested.trim() === '' ? undefined : requested
    }
  }

  /** The RAW identity the LATEST authoritative settings hold (never a display
   *  label): the write verdict compares THIS against the requested identity, so
   *  a canonical form / a winning external writer is a readable difference. */
  const webCommittedIdentity = (settings: WebProviderSettings, id: WebSettingRowId): string | undefined => {
    switch (id) {
      case 'web-search-provider': return settings.searchProvider
      case 'web-fetch-provider': return settings.fetchProvider
      case 'web-search-count': return String(settings.api.count)
      case 'web-send-original-question': return settings.api.sendOriginalQuestion ? 'on' : 'off'
      case 'web-search-endpoint': return settings.api.baseURL
    }
  }

  /** A read issued AFTER a dispatched write, judged by the NEWEST settlement:
   *  a superseded snapshot never decides the verdict. */
  const settleWebReadAfterWrite = async (): Promise<void> => {
    const verified = await rereadWebSettings()
    if (!verified.fresh) {
      // A newer read owns the facts: WAIT for its settlement and judge by what
      // it committed, never by the superseded snapshot.
      await awaitWebSettled()
    }
  }

  /**
   * The ONE Web commit entry (C2-R4 §5): the page's five fields AND the legacy
   * editor's rows both confirm through this function, so there is exactly ONE
   * FIFO, ONE latest-read fence and ONE settlement vocabulary:
   *
   *  - (1) the caller already decided the exact field + value;
   *  - (2) the intent joins the command-owned chain;
   *  - (3) its turn re-proves readiness/availability and takes the NEWEST
   *    committed read as the base — a snapshot a later read superseded is never
   *    a commit base;
   *  - (4) the candidate / custom-provider / value guard runs with ZERO Host
   *    writes on refusal;
   *  - (5) the ONE official setter is dispatched;
   *  - (6) a fresh read-back decides `verified` / `not-saved` / `outcome-unknown`;
   *  - (7) the result is returned to whichever presentation still exists.
   *
   * An already-current request writes NOTHING and is `verified` from the real
   * authority (browsing/confirming the current value is not a mutation).
   */
  const commitWebIntent = async (id: WebSettingRowId, requested: string): Promise<WebCommitResult> =>
    queueWebOperation(async (): Promise<WebCommitResult> => {
      if (!webSettingsAvailable()) {
        return { kind: 'not-saved', reason: 'the Host Web provider settings are unavailable on this backend' }
      }
      const readiness = runner.config.configReadiness()
      if (readiness !== 'ready') {
        return { kind: 'not-saved', reason: `the configuration is ${readiness}; the Web setting was not changed` }
      }
      await awaitWebSettled()
      // (3) the queue head takes a FRESH official snapshot. A completed read —
      // even the newest one — can predate an EXTERNAL Host settings writer, so
      // the custom-provider / already-current / legality decisions below must
      // never be based on a cached snapshot: that stale base could pass the
      // custom-route guard and overwrite a provider id another writer just set.
      await settleWebReadAfterWrite()
      const base = webSettings
      if (base === undefined) {
        return { kind: 'not-saved', reason: 'the current Web settings could not be read' }
      }
      const requestedIdentity = webRequestedIdentity(id, requested)
      if (requestedIdentity === undefined) {
        return { kind: 'not-saved', reason: `"${requested}" is not a value this page writes` }
      }
      if (id === 'web-search-provider' || id === 'web-fetch-provider') {
        const candidates = id === 'web-search-provider' ? WEB_SEARCH_PROVIDER_VALUES : WEB_FETCH_PROVIDER_VALUES
        const currentId = webCommittedIdentity(base, id)
        // A CUSTOM route is displayed verbatim and is NEVER overwritten here:
        // zero writes, explicit cause. Only a fresh authority can change that.
        if (currentId !== undefined && !candidates.some(candidate => candidate.id === currentId)) {
          return {
            kind: 'not-saved',
            reason: `the configured provider is a custom route (${currentId}); only the official candidates are selectable here`,
          }
        }
        const candidate = candidates.find(entry => entry.id === requestedIdentity)
        // The official auto-selection already applies the default candidate:
        // confirming it is a zero-write Verified, never a redundant pin.
        if (currentId === requestedIdentity || (currentId === undefined && candidate?.default === true)) {
          return { kind: 'verified', actual: requestedIdentity }
        }
      } else if (webCommittedIdentity(base, id) === requestedIdentity) {
        return { kind: 'verified', actual: requestedIdentity }
      }
      const write = id === 'web-search-endpoint'
        ? () => runner.config.web.setSearchApiBaseURL(requested)
        : webWriteFor(id, requested)
      if (write === undefined) {
        return { kind: 'not-saved', reason: `"${requested}" is not a value this page writes` }
      }
      try {
        await write()
      } catch (error) {
        const reason = safeErrorMessage(error)
        // A REJECTED write is attributed from a FRESH read: an authority that no
        // longer carries the requested identity refutes it; an authority that
        // now carries it cannot attribute the rejection, and a rejected write is
        // never Verified.
        await settleWebReadAfterWrite()
        const rejectedActual = webSettings === undefined ? undefined : webCommittedIdentity(webSettings, id)
        if (rejectedActual === undefined) return { kind: 'outcome-unknown', reason }
        if (rejectedActual !== requestedIdentity) return { kind: 'not-saved', reason, actual: rejectedActual }
        return {
          kind: 'outcome-unknown',
          reason: `${reason}; the Host now reads the submitted value, so the rejection cannot be attributed`,
        }
      }
      await settleWebReadAfterWrite()
      const actual = webSettings === undefined ? undefined : webCommittedIdentity(webSettings, id)
      if (actual === undefined) {
        return { kind: 'outcome-unknown', reason: 'the Host write could not be verified: the Web settings could not be read back' }
      }
      if (actual === requestedIdentity) return { kind: 'verified', actual }
      const keeps = webSettledValue(id) ?? actual
      return { kind: 'not-saved', reason: `the Host keeps "${keeps}" instead of the submitted value`, actual }
    })

  /** The ONE Settings workspace open path: the lease is taken SYNCHRONOUSLY
   *  (the first frame is immediate), then the Host Web facts are read for THIS
   *  panel generation and the SAME generation repaints its OWN row when the read
   *  settles. A newer/closed generation never receives the result. The repaint is
   *  ROW-scoped: the Web authority changed, so the TUI settings document is never
   *  read a second time (one guarded document read per surface). */
  let activeSettingsWorkspace: { readonly token: object; readonly refreshWebRow: () => void } | undefined
  /** The MOUNTED Web Search / Fetch page (C2-R4). It is created by the root's
   *  explicit activation, dies with the workspace, and is never a second
   *  settings authority: a fact settlement repaints the root, whose frame
   *  re-renders the page from the LATEST command-owned read. */
  let activeWebPage: WebSettingsPage | undefined

  interface WorkspaceOpenSpec {
    readonly initialRowId?: SettingsWorkspaceRowId
    readonly initialCategory?: import('../panels/settings-workspace-panel.ts').SettingsWorkspaceCategoryId
    readonly initialModelsView?: ModelsInitialView
    readonly initialAccountView?: AccountInitialView
    /** C2-R5: the typed professional page the first painted body mounts. It is
     *  valid ONLY with the exact `initialRowId` the panel's route table names. */
    readonly initialSpecialist?: import('../panels/settings-workspace-panel.ts').SettingsWorkspaceSpecialistRoute
  }

  /**
   * C2-R3: the ONE official-section write queue of this command owner.
   *
   * The official `subagent-model-selection` section is ONE stored value with TWO
   * halves, and every surface (the embedded allowlist picker and the workspace
   * toggle) edits only ONE half per user action. A queue that merely serialized
   * whole-section payloads captured BEFORE their turn would let an earlier
   * intent be erased by a later payload built from a stale snapshot — the exact
   * "a slow earlier write lands after a newer one" failure. Each queued item is
   * therefore an INTENT over ONE half,
   * and its payload is rebuilt from a FRESH official read INSIDE the queue,
   * right before the write:
   *  - a route edit replaces the allowlist and keeps the CURRENT `enabled`;
   *  - an enabled edit sets the flag and keeps the CURRENT routes.
   * It is a serialization + rebase barrier, not a settings authority: the
   * official section stays the only stored value and each caller keeps its own
   * real settlement.
   */
  interface OfficialSectionState {
    readonly enabled: boolean
    readonly allowedModels: readonly import('../../runtime/config-port.ts').SubagentAllowedModelRoute[]
  }
  let subagentSectionTail: Promise<void> = Promise.resolve()
  const enqueueSubagentSectionWrite = <T>(write: () => Promise<T>): Promise<T> => {
    // The tail absorbs the failure so one rejection can never lock the queue;
    // the caller's own promise keeps the REAL settlement.
    const turn = subagentSectionTail.then(write, write)
    subagentSectionTail = turn.then(() => undefined, () => undefined)
    return turn
  }
  /** Whether the official section may be written RIGHT NOW: the section must be
   *  available AND the backend must vouch for its values. A stale/unavailable
   *  mirror keeps readable last-known values, so a write built from it would
   *  overwrite whatever the Host changed while this Client was not current. */
  const subagentSectionWritable = (): boolean =>
    runner.config.subagentModelSelection.available() && runner.config.configReadiness() === 'ready'
  /**
   * Why the official section could not be written when its turn came. A
   * PRECONDITION refusal is the user's own setup problem (navigate + guide);
   * every other cause is a real failure the caller must surface.
   */
  type OfficialSectionRefusal =
    | { readonly kind: 'empty-allowlist' }
    | { readonly kind: 'last-route-while-enabled' }
    | { readonly kind: 'not-writable'; readonly reason: string }
    | { readonly kind: 'unreadable'; readonly reason: string }
  type OfficialSectionEditOutcome =
    | { readonly kind: 'written'; readonly section: OfficialSectionState }
    | { readonly kind: 'refused'; readonly refusal: OfficialSectionRefusal }

  /** The current section, or why it cannot be used as a base right now. */
  const readOfficialSection = (
    section: import('../../runtime/config-port.ts').SubagentModelSelectionConfig,
  ): { readonly section?: OfficialSectionState; readonly refusal?: OfficialSectionRefusal } => {
    // The CAPABILITY is re-proved at the write's own turn, not only when the
    // user acted: a section that became unavailable while this intent waited
    // must not be written from whatever `get()` would answer then.
    if (!section.available()) {
      return { refusal: { kind: 'not-writable', reason: 'the official subagent settings are unavailable on this backend' } }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      // A stale/unavailable backend keeps readable LAST-KNOWN values: writing
      // them back would overwrite whatever the Host changed while this Client
      // was not current.
      return { refusal: { kind: 'not-writable', reason: `the configuration is ${readiness}` } }
    }
    try {
      const latest = section.get()
      return {
        section: {
          enabled: latest.enabled,
          allowedModels: latest.allowedModels.map(route => ({ ...route })),
        },
      }
    } catch (error) {
      // An UNREADABLE official section is never a usable base and never a
      // verifiable result: the caller must surface the failure.
      return { refusal: { kind: 'unreadable', reason: safeErrorMessage(error) } }
    }
  }

  /**
   * Queue ONE section edit. `rebase` runs INSIDE the queue against the FRESH
   * official section and must change ONLY the half this intent owns, copying the
   * other half verbatim. Returning `undefined` refuses the edit with ZERO writes
   * for a caller-declared reason (the setup precondition).
   *
   * The outcome is EXPLICIT about why nothing was written: a non-writable
   * backend and an unreadable section are NOT successful settlements, so no
   * picker can paint a silent rollback as if its intent had committed.
   */
  const queueSubagentSectionEdit = (
    rebase: (fresh: OfficialSectionState) => OfficialSectionState | undefined,
    refusalOf?: (fresh: OfficialSectionState) => OfficialSectionRefusal | undefined,
  ): Promise<OfficialSectionEditOutcome> => enqueueSubagentSectionWrite(async () => {
    const section = runner.config.subagentModelSelection
    const base = readOfficialSection(section)
    if (base.refusal !== undefined) return { kind: 'refused', refusal: base.refusal }
    const fresh = base.section!
    const declared = refusalOf?.(fresh)
    if (declared !== undefined) return { kind: 'refused', refusal: declared }
    const payload = rebase(fresh)
    if (payload === undefined) return { kind: 'refused', refusal: { kind: 'empty-allowlist' } }
    await section.set(payload)
    return { kind: 'written', section: payload }
  })
  /** The narrow queue-backed section adapter the existing picker consumes. A
   *  refusal REJECTS: the picker must never treat "nothing was written" as a
   *  successful settlement. */
  const queuedSubagentSelection = (): import('../../runtime/config-port.ts').SubagentModelSelectionConfig => ({
    available: () => subagentSectionWritable(),
    get: () => runner.config.subagentModelSelection.get(),
    set: async (value) => {
      const outcome = await queueSubagentSectionEdit(fresh => ({
        enabled: fresh.enabled,
        allowedModels: value.allowedModels.map(route => ({ ...route })),
      }))
      if (outcome.kind === 'written') return
      throw new Error(refusalMessage(outcome.refusal))
    },
  })
  /**
   * Apply ONE route intent against the section the queue really holds when the
   * write's turn comes. Two picker instances therefore compose instead of
   * overwriting each other: an add keeps every route the section already has,
   * a remove drops exactly one `(provider, model)` pair.
   */
  const queuedRouteIntent = async (
    route: import('../../runtime/config-port.ts').SubagentAllowedModelRoute,
    direction: 'add' | 'remove',
  ): Promise<void> => {
    const outcome = await queueSubagentSectionEdit(
      fresh => ({
        enabled: fresh.enabled,
        allowedModels: applyRouteIntent(fresh.allowedModels, route, direction),
      }),
      // Removing the LAST route of an ENABLED section would leave the official
      // section invalid. This is decided HERE, from the FRESH section, in FIFO
      // order — a locally-decided version would refuse an operation that a
      // queued `enabled:false` makes legal.
      fresh => lastRouteWhileEnabled(fresh.enabled, fresh.allowedModels, route)
        ? { kind: 'last-route-while-enabled' }
        : undefined,
    )
    if (outcome.kind === 'written') return
    throw new Error(refusalMessage(outcome.refusal))
  }

  const openSettingsWorkspaceWith = (spec: WorkspaceOpenSpec): import('../../tui-app.ts').SettingsWorkspaceHandle => {
    // C2-R5: a typed deeplink NEVER guesses its row. Validate the exact pair
    // BEFORE the screen lease is taken, so a mismatched request fails as a real
    // command error and leaves no Settings/overlay behind.
    if (spec.initialSpecialist !== undefined) {
      const requires = SETTINGS_SPECIALIST_ROUTE_ROW[spec.initialSpecialist]
      if (spec.initialRowId !== requires) {
        throw new Error(`the ${spec.initialSpecialist} deeplink requires the ${requires} row`)
      }
    }
    const token = {}
    // C2-R3: ONE pinned session scope per workspace open. The approval row
    // targets EXACTLY this captured owner generation: a session switch never
    // re-targets the row to the replacement Session (the user must reopen the
    // workspace to speak about the new one). No Session is created here.
    //
    // The capture is LAZY: the panel's first snapshot (inside the app's own
    // open, after the lease was granted) is what pins it, so a REFUSED open
    // captures no scope at all.
    let approvalScope: import('../../app/session/scope.ts').LiveSessionScope | undefined
    let approvalScopePinned = false
    const pinnedApprovalScope = (): import('../../app/session/scope.ts').LiveSessionScope | undefined => {
      if (!approvalScopePinned) {
        approvalScopePinned = true
        approvalScope = runner.captureLiveSessionScope()
      }
      return approvalScope
    }
    // The panel snapshots its source in its CONSTRUCTOR, so the pending state
    // must be in place before the lease is taken.
    if (webSettingsAvailable()) beginWebSettingsRead()
    // C3: the ONE per-open About owner. Its subscription is acquired HERE
    // (page open), its `enter()` runs only AFTER `openSettingsWorkspace`
    // returned the live handle (no synchronous callback can target an
    // unmounted page), and its dispose rides the workspace `onClose`.
    let aboutController: AboutStatusController | undefined
    const aboutStatusSource = (): AboutStatusController => {
      aboutController ??= new AboutStatusController({
        backendKind: runner.backendKind,
        captureLiveSessionScope: () => runner.captureLiveSessionScope(),
        isSessionScopeCurrent: (scope) => runner.isSessionScopeCurrent(scope),
        currentSessionStats: (scope, signal) => runner.currentSessionStats(scope, signal),
        readSessionStatus: (sessionId) => runner.sessionReader.sessionStatus(sessionId),
        sessionStatusFailed: (sessionId) => runner.sessionReader.sessionStatusFailed?.(sessionId) === true,
        forceContextMeasurementResult: () => runner.forceContextMeasurementResult(),
        versionFacts: { tui: bundleVersion(), dsh: dshVersion() },
        subscribeSessionScopeInvalidation: (listener) => runner.subscribeSessionScopeInvalidation(listener),
        diag: runner.diag,
        sessionIdForDiagnostics: () => runner.currentSessionId,
      })
      return aboutController
    }
    let handle: import('../../tui-app.ts').SettingsWorkspaceHandle | undefined
    // C2-R2: the per-open VERIFIED fullscreen intent. A Fullscreen confirm that
    // really stored its preference records the target here; the post-close
    // hand-off applies the LAST verified choice of THIS open only. It is not a
    // second persistence authority — it is the navigation action the stored
    // preference already implies, released with the workspace.
    let verifiedFullscreenIntent: 'on' | 'off' | undefined
    handle = app.openSettingsWorkspace(
      {
        readSnapshot: () => readSettingsWorkspaceSnapshot(pinnedApprovalScope()),
        // The LIVE extension settings directory: the in-process registry's own
        // `{revision,count}`. It is a synchronous projection with no write and
        // no second registry; its revision fences same-id re-registration too.
        extensionDirectory: () => {
          const registry = runner.extensions?.settings.snapshot()
          return { revision: registry?.revision ?? 0, count: registry?.rows.length ?? 0 }
        },
        onRefresh: () => { startWebSettingsRead() },
      },
      {
        onOpenPlugins: (onYieldNavigation) => runner.createPluginManagerPage(onYieldNavigation),
        onCommit: async (request) => {
          const result = await commitSettingsWorkspaceField(request, pinnedApprovalScope())
          // Only a session that still belongs to THIS open may update the
          // intent, and only a VERIFIED Fullscreen result may set it. Any
          // non-verified Fullscreen attempt CLEARS the earlier intent, so a
          // stale success can never fire behind a newer failed choice.
          if (request.field === 'fullscreen' && activeSettingsWorkspace?.token === token) {
            verifiedFullscreenIntent = result.outcome === 'verified' && (request.value === 'on' || request.value === 'off')
              ? request.value
              : undefined
          }
          return result
        },
        createModelsPage,
        createAccountPage,
        // C2-R3: the ONE embedded specialist page — the EXISTING subagent
        // allowlist picker mounted in this same workspace body. It is created
        // only by an explicit Manage/Enter, reads the OFFICIAL section and the
        // official model directory, and writes through the SAME serialized
        // section queue as the workspace toggle.
        createSubagentAllowlistPicker: (done, onAuthoritativeChange) => {
          // The section must be AVAILABLE *and* CURRENT: opening a picker over a
          // stale mirror would let the user toggle routes that can never commit.
          if (!subagentSectionWritable() || !runner.catalog.models.available()) return undefined
          return new SubagentModelAllowlistPicker({
            selection: queuedSubagentSelection(),
            // Each toggle submits ONLY the pair it changed, applied to the
            // section the queue holds at write time (two picker instances compose).
            routeIntent: {
              add: route => queuedRouteIntent(route, 'add'),
              remove: route => queuedRouteIntent(route, 'remove'),
            },
            catalog: runner.catalog.models,
            notify: (message, kind) => app.notify(message, kind),
            requestRender: () => app.requestRender(),
            diag: runner.diag,
            done: () => { done() },
            // A settlement that lands after the user closed the picker still
            // refreshes the Agent row facts of the workspace they are now
            // looking at: the outer surface re-reads the OFFICIAL section, so
            // the picker's display string is never trusted as the fact.
            summarize: () => { onAuthoritativeChange() },
            runOwned: (label, task, options) => {
              runOwned(label, task, {
                diag: runner.diag,
                sessionId: () => runner.currentSessionId,
                ...options,
              })
            },
          })
        },
        // C2-R4: the ONE embedded Web Search / Fetch page, mounted in this same
        // workspace body on the Tools row's explicit activation. The page reads
        // the LATEST command-owned Host read, commits through the SAME single
        // Web FIFO, and hands the credential row's typed Models initial view to
        // the root — it never touches a secret and never runs `/login` text.
        createWebSettingsPage: (done, navigateToModels) => {
          // Entering the page triggers a FRESH authoritative read: the first
          // frame states Loading… instead of presenting a snapshot from an
          // earlier open as the current value.
          startWebSettingsRead()
          const page = new WebSettingsPage({
            readFacts: webSettingsFacts,
            writableRefusal: webWritableRefusal,
            credentialAvailable: () => runner.config.credentials.available(),
            commit: (id, requested) => commitWebIntent(id, requested),
            refresh: () => { startWebSettingsRead() },
            navigateToModels: initial => { navigateToModels(initial) },
            requestRender: () => { if (!app.isDisposed()) app.requestRender() },
            run: (label, task) => detach(label, task, { notify: false }),
            done: () => {
              if (activeWebPage === page) activeWebPage = undefined
              done()
            },
          })
          activeWebPage = page
          return page
        },
        // C2-R5: the two same-lease professional pages. Each factory returns
        // the EXISTING editor over its ONE authority; the root mounts it in this
        // workspace's body and never opens a second overlay.
        createFooterConfiguratorPage: (done, onAuthoritativeChange) => createFooterWorkspacePage(done, onAuthoritativeChange),
        createKeybindingsPage: (done, onAuthoritativeChange) => createKeybindingsWorkspacePage(done, onAuthoritativeChange),
        // The About page's two version facts: read ONCE per workspace open on
        // the Client side. `tui` is this bundle's own version and `dsh` the
        // installed Harness version — neither is derived from the other, and
        // an unreadable DSH version stays `Unknown`.
        aboutVersionFacts: { tui: bundleVersion(), dsh: dshVersion() },
        // C3: the per-open About source (the panel renders its snapshot and
        // the workspace token fences its repaints) + the explicit entry hooks.
        aboutStatusSource,
        onAboutEnter: () => { aboutStatusSource().enter() },
        onAboutLeave: () => { aboutStatusSource().leave() },
        ...spec,
        onClose: (reason) => {
          // Retire the token FIRST: every late callback of this open becomes
          // inert before any physical switch is attempted.
          const wasActive = activeSettingsWorkspace?.token === token
          if (wasActive) activeSettingsWorkspace = undefined
          // C2-R4: the mounted Web page's command reference dies with this open
          // (the panel itself disposes the instance on teardown). A late fact
          // settlement then repaints nothing.
          activeWebPage = undefined
          // The controller dies with the workspace: the subscription and any
          // in-flight read are released exactly once.
          aboutController?.dispose()
          aboutController = undefined
          // C2-R2: apply the last VERIFIED Fullscreen choice only on a real user
          // exit of the workspace that owned it, and only when the stored
          // preference still reads exactly that target. Everything else (a
          // forced teardown, a question/approval takeover) keeps the stored
          // preference for the next mount and swaps NOTHING.
          const target = verifiedFullscreenIntent
          verifiedFullscreenIntent = undefined
          if (!wasActive || reason !== 'user-exit' || target === undefined) return
          if (app.isDisposed()) return
          // The stored preference is re-read from the SAME authority the write
          // verified: a value another writer changed in the meantime (or a
          // non-ready/unreadable document) means this open no longer owns the
          // decision, so nothing is switched.
          const settings = runner.tuiSettings
          if (settings === undefined || runner.config.configReadiness() !== 'ready') return
          let stored: string
          try {
            stored = settings.get().fullscreen
          } catch {
            return
          }
          if (stored !== target) return
          // The app re-proves its own idle claim synchronously; a newer owner
          // that appeared disposes the switch.
          app.setFullscreen(target === 'on', { persistPreference: false, onlyWhenIdle: true })
        },
      },
    )
    activeSettingsWorkspace = { token, refreshWebRow: () => handle?.refreshRow(WEB_LAUNCHER_ROW_ID, webWorkspaceRowFacts()) }
    startWebSettingsRead()
    // C3 (plan §3.2 step 6): the workspace's OWN home is About, so a plain
    // open IS a semantic About entry — exactly ONE scoped snapshot refresh,
    // started only now that `openSettingsWorkspace` returned its live handle
    // (no synchronous callback can target an unmounted page). A deeplink
    // that landed on another category (a /login Models/Account target, a Web
    // row) is NOT an About entry: the page is not About, no read may start
    // behind it, and the panel's own onAboutEnter hook owns the real entry
    // when the user later navigates to About.
    if (spec.initialCategory === undefined && spec.initialRowId === undefined
      && spec.initialModelsView === undefined && spec.initialAccountView === undefined) {
      aboutStatusSource().enter()
    }
    return handle
  }

  const openSettingsWorkspaceAt = (initialRowId?: SettingsWorkspaceRowId): void => {
    openSettingsWorkspaceWith(initialRowId === undefined ? {} : { initialRowId })
  }

  /** Enter the PENDING state synchronously: the previous value AND the
   *  previous error are dropped, so no snapshot taken from here on (including
   *  the very first frame of a workspace) can present either as current. */
  const beginWebSettingsRead = (): void => {
    webSettings = undefined
    webReadFailure = undefined
    webReadSettled = false
  }

  /** Start ONE authority read: the pending state is applied and the launcher
   *  row repainted BEFORE the async read, and the generation that currently
   *  owns the surface repaints its own row (and the mounted Web page) when the
   *  read settles. Used on workspace open, on entering the Web page and on `r`. */
  const startWebSettingsRead = (): void => {
    beginWebSettingsRead()
    activeSettingsWorkspace?.refreshWebRow()
    detach('web provider settings read', async () => {
      // The read's own commit refreshes the generation that currently owns the
      // surface (never a superseded one).
      await readWebSettings()
    }, { notify: false })
  }

  /** Keep USER-owned Custom Text definitions out of whole-document writes that
   * start from a merged settings document. A project layer may contribute the
   * pass-through `footerCustomItems` field, but it must never be copied into
   * USER settings merely because an unrelated setting changed. The raw USER
   * value is intentional here: parsed runtime items would erase unknown/future
   * definitions during a downgrade or a fail-soft read. */
  function withUserFooterCustomItems(doc: TuiSettingsDoc, config: ConfigPort): TuiSettingsDoc {
    const raw = config.footerCustomItems.rawForPersistence()
    if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
    return { ...doc, footerCustomItems: raw.value }
  }

  /**
   * Merge an intentional `/footer` save into the detached USER raw collection.
   * The editor owns every recognized v1 text definition: an existing known id
   * is replaced by its validated draft, and a missing known id is a deliberate
   * delete. Entries this client cannot parse (future kinds or future fields)
   * remain unchanged in their original slots so opening and saving the
   * current UI does not destroy definitions owned by a newer client.
   */
  function mergeFooterCustomItemsForSave(raw: unknown, saved: readonly FooterCustomItemSettings[]): readonly unknown[] {
    if (!Array.isArray(raw)) return saved.map(item => ({ ...item }))
    const savedById = new Map(saved.map(item => [item.id, item] as const))
    const emittedKnown = new Set<string>()
    const result: unknown[] = []
    for (const candidate of raw) {
      const known = parseFooterCustomItem(candidate)
      if (known !== undefined) {
        const replacement = savedById.get(known.id)
        if (replacement !== undefined && !emittedKnown.has(known.id)) {
          result.push({ ...replacement })
          emittedKnown.add(known.id)
        }
        continue
      }
      // An explicitly-created v1 item wins an id collision with a future
      // definition; otherwise preserving both would make the raw collection
      // ambiguous to the newer owner.
      const candidateId = typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
        ? (candidate as { id?: unknown }).id
        : undefined
      if (typeof candidateId !== 'string' || !savedById.has(candidateId)) result.push(candidate)
    }
    for (const item of saved) {
      if (!emittedKnown.has(item.id)) result.push({ ...item })
    }
    return result
  }

  /** Read the canonical preset, with a narrow adapter for old command-only fakes. */
  function displayPresetOf(runner: Pick<TuiCommandRunner, 'displayPreset' | 'focusEnabled'>): DisplayPreset {
    return runner.displayPreset?.() ?? (runner.focusEnabled() ? 'focus' : 'full')
  }

  /** Apply through the canonical setter, retaining only the old test/extension seam. */
  function applyDisplayPreset(runner: Pick<TuiCommandRunner, 'setDisplayPreset' | 'setFocusMode'>, preset: DisplayPreset): DisplayPresetApplyResult {
    if (!isDisplayPresetAvailable(preset)) return { kind: 'unsupported', preset }
    const setter = runner.setDisplayPreset
    if (setter !== undefined) return setter(preset)
    // The legacy seam can only express Focus vs non-Focus. Compact has no
    // representation there, so it must FAIL rather than silently activate Full
    // (Compact must never be a Full alias).
    if (preset !== 'focus' && preset !== 'full') return { kind: 'unsupported', preset }
    runner.setFocusMode(preset === 'focus')
    return { kind: 'applied', preset }
  }

  /** The EFFECTIVE key label for user-facing descriptions (plan §18): a
   * remap updates every row; a disabled action shows a neutral dash. */
  const keyHint = (id: AppKeybindingId): string => {
    const hint = app.keybindingsManager().keyHint(id)
    return hint === '' ? '—' : hint
  }

  /** Build the one editor used by /keybindings and the /settings submenu.
   * The settings row is only a launcher; all reads/writes still go through
   * the controller and the same panel state machine. */
  const createKeybindingEditorPanel = (
    onClose: () => void,
    onModelChange: (model: KeybindingEditorModel) => void = () => {},
  ): KeybindingEditorPanel | undefined => {
    const settings = runner.tuiSettings
    if (settings === undefined) return undefined
    const controller = new KeybindingEditorController({
      settings,
      manager: app.keybindingsManager(),
      projectSettingsForWrite: doc => withUserFooterCustomItems(doc, runner.config),
      onDiagnostic: diagnostic => runner.diag.debug('keybinding configuration', { error: diagnostic }),
    })
    let panel: KeybindingEditorPanel | undefined
    try {
      const model = controller.readModel()
      let unregister = (): void => {}
      panel = new KeybindingEditorPanel({
        model,
        onClose,
        onModelChange,
        onDispose: () => unregister(),
        maxRows: () => app.keybindingEditorMaxRows(),
        requestRender: () => app.requestRender(),
        runMutation: (mutation, onResult, onError) => {
          runOwned('keybinding editor mutation', () => controller.mutate(mutation), {
            diag: runner.diag,
            sessionId: () => runner.currentSessionId,
            onResult,
            onError,
          })
        },
      })
      unregister = app.trackKeybindingEditor(panel)
      return panel
    } catch (error) {
      app.notify(`Could not open keyboard shortcuts: ${safeErrorMessage(error)}`, 'error')
      return undefined
    }
  }

  /**
   * Phase 3B / B2-B: the LIVE runtime palette fact of the theme row — the
   * palette the surface is really painted with, never the persisted document
   * value. A plugin selection reports its source-qualified display name (a gone
   * source falls back to the raw value: the row must not lie about the stored
   * identity).
   */
  const runtimeThemeFact = (): string => {
    const plugin = app.activePluginTheme()
    if (plugin !== undefined) return themeDisplayNameOf(plugin, runner.extensions?.themes)
    const theme = app.currentTheme()
    return theme === 'custom' ? 'custom palette' : theme
  }

  /** The persisted document fact AS THE READ PROVED IT: the stored value, `not
   *  set` for a readable document with no value, or an explicit unknown when there
   *  was no document to read. The panel renders it verbatim and never guesses. */
  const persistedFactOf = (value: string | undefined, readable: boolean): string =>
    !readable
      ? 'unknown — the TUI settings document could not be read'
      : value === undefined || value === ''
        ? 'not set'
        : value

  /**
   * C2-R2: the primary fact of a PERSIST-FIRST row (`busy-enter`, `fullscreen`).
   * These two fields report the stored document, so an unreadable document is
   * an explicit unknown, a legal raw value is reported exactly, and anything
   * else is named as the invalid stored value it is — never replaced by the
   * consumer's default.
   */
  const storedCandidateFactOf = (
    raw: string | undefined,
    readable: boolean,
    candidates: readonly string[],
    unreadable: string,
  ): string => {
    if (!readable) return unreadable
    if (raw === undefined || raw === '') return 'not set'
    return isCandidateOf(raw, candidates) ? raw : `invalid stored value: ${raw}`
  }

  /**
   * C2-R2: the Home/End preset the LIVE keymap really resolves. The Fact is the
   * pair of chords `applyHomeEndKeyMode` writes, read from the keymap the
   * resolver itself uses — never a copied chord table and never the stored
   * document value. `input` is the pair the fork's own definitions resolve to;
   * `viewport` is the pair the preset writes; anything else is a custom mapping
   * named as such rather than labelled with a preset the user is not running.
   */
  const homeEndLiveModeOf = (): string => {
    // The preset is the PAIR OF USER BINDINGS `applyHomeEndKeyMode` writes; the
    // fork's `input` default IS that same pair, so the two presets are the only
    // pairs a preset can produce. Any other pair is a user's own mapping and is
    // reported as such instead of being labelled with a preset it is not.
    const bindings = getKeybindings().getUserBindings()
    const asList = (value: string | readonly string[] | undefined): readonly string[] =>
      value === undefined ? [] : typeof value === 'string' ? [value] : value
    const same = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((entry, index) => entry === right[index])
    const top = asList(bindings['tui.altScreen.top'])
    const bottom = asList(bindings['tui.altScreen.bottom'])
    // The fork's own `input` defaults, read from the resolver's definitions
    // rather than restating the chords here.
    const manager = getKeybindings()
    const defaultTop = asList(manager.getDefinition('tui.altScreen.top').defaultKeys)
    const defaultBottom = asList(manager.getDefinition('tui.altScreen.bottom').defaultKeys)
    if (same(top, defaultTop) && same(bottom, defaultBottom)) return 'input'
    if (same(top, ['home']) && same(bottom, ['end'])) return 'viewport'
    return 'custom/unrecognized'
  }

  /**
   * The candidate source of ONE writable pilot row. A stored value whose source
   * is gone is still listed (the row must not lose the real stored identity) but
   * marked unavailable, so it can never be confirmed back into a write.
   */
  const themeEditOf = (persistedTheme: string | undefined, readable: boolean): SettingsWorkspaceEdit => {
    const options: SettingsWorkspaceEditOption[] = themePickerRows(runner.extensions?.themes).map(row => ({
      value: row.value,
      label: row.displayName,
      available: true,
      current: row.value === persistedTheme,
    }))
    if (persistedTheme !== undefined && !options.some(option => option.value === persistedTheme)) {
      options.push({
        value: persistedTheme,
        label: themeDisplayNameOf(persistedTheme, runner.extensions?.themes),
        available: false,
        current: true,
      })
    }
    return {
      field: 'theme',
      primary: 'persisted',
      options,
      runtime: runtimeThemeFact(),
      persisted: persistedFactOf(persistedTheme, readable),
    }
  }

  const displayEditOf = (persistedPreset: string | undefined, readable: boolean): SettingsWorkspaceEdit => ({
    field: 'display-preset',
    primary: 'runtime',
    options: (['full', 'compact', 'focus'] as const).map(preset => ({
      value: preset,
      label: preset,
      available: isDisplayPresetAvailable(preset),
      current: preset === persistedPreset,
    })),
    runtime: displayPresetOf(runner),
    persisted: persistedFactOf(persistedPreset, readable),
  })

  /**
   * The candidate source of ONE runtime-only disclosure field (`expand`,
   * `thinking`). The live value is the ONE fact that exists: these two rows have
   * no settings-document field, so the persisted half states that it does not
   * apply instead of inventing a stored fact.
   */
  const disclosureEditOf = (
    field: 'expand' | 'thinking',
    runtime: 'expanded' | 'collapsed',
  ): SettingsWorkspaceEdit => ({
    field,
    primary: 'runtime',
    options: DISCLOSURE_CANDIDATES.map(value => ({
      value,
      label: value,
      available: true,
      current: value === runtime,
    })),
    runtime,
    persisted: 'not applicable — runtime-only',
  })

  /**
   * The candidate source of ONE apply-first + persisted TUI-document field. The
   * `[current]` chip follows the LIVE value (the runtime the surface really
   * uses), never the possibly stale stored preference: the Detail's own
   * `Persisted` fact is what names the stored value, so the two can never be
   * conflated.
   */
  const persistedPreferenceEditOf = (
    field: 'icon-style' | 'progress-updates' | 'response-style' | 'git-attribution'
      | 'home-end-keys' | 'wheel-scroll-lines' | 'notification-mode' | 'notification-method'
      | 'terminal-progress',
    runtime: string,
    candidates: readonly string[],
    persisted: string | undefined,
    readable: boolean,
  ): SettingsWorkspaceEdit => ({
    field,
    primary: 'runtime',
    options: candidates.map(value => ({
      value,
      label: value,
      available: true,
      current: value === runtime,
    })),
    runtime,
    persisted: persistedFactOf(persisted, readable),
  })

  /**
   * C2-R2: the candidate source of ONE PERSIST-FIRST field (`busy-enter`,
   * `fullscreen`). The stored document is the authority the Detail reports as
   * its primary `Value`, so a missing or invalid raw value must never be
   * replaced by the consumer's default; the `Runtime` half states the effect
   * the NEXT read of that document will have (or the live screen mode).
   * `[current]` lights up only on an exact raw match.
   */
  const persistedOnlyEditOf = (
    field: 'busy-enter' | 'fullscreen' | 'local-shell-sandbox' | 'footer-mode',
    candidates: readonly string[],
    raw: string | undefined,
    readable: boolean,
    runtime: string,
    persisted: string,
  ): SettingsWorkspaceEdit => ({
    field,
    primary: 'persisted',
    // The row's primary Value/summary is the STORED fact: an exact raw match is
    // the only candidate that may claim `[current]`.
    options: candidates.map(value => ({
      value,
      label: value,
      available: true,
      current: readable && raw === value,
    })),
    runtime,
    persisted,
  })

  /**
   * The profile-wide Visual tools switch (PR-D follow-up). The row's authority
   * is the Host `pi-tui-visual-tools` Config section, never a TUI settings
   * document field: `enabled` decides whether BOTH built-in tools are offered
   * to every agent of this Host profile. Its candidates are literal `on` /
   * `off` identities; the value never round-trips through a display string.
   */
  const visualToolsSummaryOf = (state: VisualToolsState | undefined): string => {
    if (state === undefined) return 'Unavailable'
    // `[default]` marks a value the USER layer does not declare. The Host form
    // exposes exactly that provenance; no schema default is re-derived here.
    return `${state.enabled ? 'On' : 'Off'}${state.userOverridden ? '' : ' [default]'}`
  }

  /** The runtime half of the row: the owning Host row's live registration
   *  fact INTERPRETED against the desired configuration. "Not applied" is a
   *  mismatch between the two facts, never the normal Off state; a backend that
   *  cannot observe the Host registry says so instead of presenting the
   *  committed configuration as a live registration. */
  const visualToolsRuntimeOf = (state: VisualToolsState | undefined): string => {
    if (state === undefined) return 'not read — the Host profile section is unavailable'
    if (state.applied === undefined) return 'Runtime status unobservable — the Host registry has no wire read'
    if (state.enabled) {
      return state.applied
        ? 'Both tools registered'
        : 'Not applied — registration failed'
    }
    return state.applied
      ? 'Not applied — tools remain registered'
      : 'Both tools disabled'
  }

  const visualToolsEditOf = (
    state: VisualToolsState | undefined,
    readiness: 'ready' | 'stale' | 'unavailable',
  ): SettingsWorkspaceEdit => {
    // A non-ready backend or an unreadable section still shows the row (the
    // Tools category exists) but offers NO candidate, so Confirm is impossible
    // instead of writing against a value the Client cannot vouch for.
    const editable = state !== undefined && readiness === 'ready'
    return {
      field: 'visual-tools',
      primary: 'persisted',
      ...(state === undefined ? {} : { revision: state.revision }),
      options: editable
        ? [
            { value: 'On', label: 'On', available: true, current: state.enabled },
            { value: 'Off', label: 'Off', available: true, current: !state.enabled },
          ]
        : [],
      runtime: visualToolsRuntimeOf(state),
      persisted: visualToolsSummaryOf(state),
    }
  }

  /** The profile-wide switch's folder freshness: an unreadable section is
   *  `unavailable` (never a fabricated default), and a stale backend keeps a
   *  readable value only as `last-known`. */
  const visualToolsFreshnessOf = (
    state: VisualToolsState | undefined,
    readiness: 'ready' | 'stale' | 'unavailable',
  ): SettingsWorkspaceFreshness => state === undefined
    ? 'unavailable'
    : readiness === 'ready' ? 'ready' : 'last-known'

  /** A candidate identity ('On'/'Off') as the Host boolean, or undefined for a
   *  value this row never paints. */
  const visualToolsValueOf = (value: string): boolean | undefined =>
    value === 'On' ? true : value === 'Off' ? false : undefined

  /** The authoritative re-read of the committed switch. `agrees` requires the
   *  Host form to carry the requested value; when the backend also observes the
   *  registry (Direct), the live registration must agree as well, otherwise the
   *  commit is `unverified` — never a `Verified` the runtime does not back. */
  const verifyCommittedVisualTools = (expected: boolean): SettingsWorkspaceCommitOutcome => {
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'unverified', reason: `the configuration is ${readiness}; the committed value could not be re-read` }
    }
    const state = runner.config.visualTools.read()
    if (state === undefined) {
      return { outcome: 'unverified', reason: 'the committed Host visual tools setting could not be re-read' }
    }
    if (state.enabled !== expected) {
      return {
        outcome: 'not-saved',
        reason: `the write reported success, but the authoritative Host setting reads ${state.enabled ? 'On' : 'Off'}`,
      }
    }
    if (state.applied !== undefined && state.applied !== expected) {
      return {
        outcome: 'unverified',
        reason: expected
          ? 'the Host profile now stores On, but the Host tool registry did not adopt both registrations'
          : 'the Host profile now stores Off, but the Host tool registry still reports the tools registered',
      }
    }
    return { outcome: 'verified' }
  }

  /** Attribute a REJECTED switch write from a fresh authoritative read: only an
   *  authority still carrying the request's base value REFUTES it; a third or
   *  already-requested value (or an unreadable authority) cannot be attributed
   *  to THIS request. */
  const classifyRejectedVisualTools = (
    expected: boolean,
    base: boolean,
    failureReason: string,
  ): SettingsWorkspaceCommitOutcome => {
    const state = runner.config.configReadiness() === 'ready'
      ? runner.config.visualTools.read()
      : undefined
    if (state === undefined) {
      return { outcome: 'indeterminate', reason: `${failureReason}; the authoritative Host setting could not be re-read` }
    }
    if (state.enabled === base) return { outcome: 'not-saved', reason: failureReason }
    return {
      outcome: 'indeterminate',
      reason: `${failureReason}; the authority no longer reads the value this request started from, so its outcome cannot be attributed`,
    }
  }

  /** Commit the ONE profile-wide switch through the official revision-checked
   *  settings write, then re-read the authority (a resolved write is not a
   *  read-back). `revision` is the revision the painted candidate was read at:
   *  submitting it is what turns a concurrent external edit into a conflict
   *  instead of a silent overwrite. */
  const commitVisualTools = async (
    value: string,
    revision: number | undefined,
  ): Promise<SettingsWorkspaceCommitOutcome> => {
    const enabled = visualToolsValueOf(value)
    if (enabled === undefined) {
      return { outcome: 'not-saved', reason: `"${value}" is not a visual tools candidate` }
    }
    if (revision === undefined) {
      return { outcome: 'not-saved', reason: 'the Host setting exposed no revision this choice could be based on' }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'not-saved', reason: `the configuration is ${readiness}; the visual tools switch was not changed` }
    }
    const base = runner.config.visualTools.read()
    if (base === undefined) {
      return { outcome: 'not-saved', reason: 'the Host visual tools setting is unavailable; the switch was not changed' }
    }
    try {
      await runner.config.visualTools.setEnabled(enabled, revision)
    } catch (error) {
      return classifyRejectedVisualTools(enabled, base.enabled, safeErrorMessage(error))
    }
    return verifyCommittedVisualTools(enabled)
  }

  /** The TUI-settings-document writers. Deliberately NARROWER than
   *  {@link SettingsWorkspaceWritableField}: the Host visual-tools switch and
   *  the two runtime-only disclosure fields have no document field at all, so
   *  they can never reach a document writer. */
  type TuiSettingsField =
    | 'theme' | 'display-preset' | 'icon-style' | 'progress-updates' | 'response-style'
    | 'busy-enter' | 'git-attribution'
    | 'home-end-keys' | 'fullscreen' | 'wheel-scroll-lines'
    | 'notification-mode' | 'notification-method' | 'terminal-progress'
    | 'local-shell-sandbox'
    | 'footer-mode'

  /**
   * The STORED value of one document field, read exactly as the document holds
   * it, plus the comparison the authority's re-read must perform. An exhaustive
   * switch keeps every field mapped to its OWN document key: no binary
   * default can silently attribute a new field to another field's value.
   */
  const readDocumentField = (doc: TuiSettingsDoc, field: TuiSettingsField): string | undefined => {
    switch (field) {
      case 'theme': return normalizePersistedTheme(doc.theme)
      case 'display-preset': return doc.displayPreset
      case 'icon-style': return doc.iconStyle
      case 'progress-updates': return doc.progressUpdates
      case 'response-style': return doc.responseStyle
      case 'busy-enter': return doc.busyEnter
      case 'git-attribution': return doc.gitAttribution
      case 'home-end-keys': return doc.homeEndKeys
      case 'fullscreen': return doc.fullscreen
      case 'wheel-scroll-lines': return doc.wheelScrollLines
      case 'notification-mode': return doc.notificationMode
      case 'notification-method': return doc.notificationMethod
      case 'terminal-progress': return doc.terminalProgress
      case 'local-shell-sandbox': return doc.localShellSandbox
      case 'footer-mode': return doc.footer
      default: {
        // Exhaustiveness fence: a new TuiSettingsField must add its own
        // document mapping here instead of inheriting another field's value.
        const unreachable: never = field
        throw new Error(`unmapped TUI settings field ${String(unreachable)}`)
      }
    }
  }

  /** The persisted value of one writable field, or undefined when unreadable. */
  const persistedValueOf = (field: TuiSettingsField): string | undefined => {
    const settings = runner.tuiSettings
    if (settings === undefined) return undefined
    let doc: TuiSettingsDoc
    try {
      doc = settings.get()
    } catch {
      return undefined
    }
    return readDocumentField(doc, field)
  }

  /** The structured authoritative readback of ONE committed field. */
  type CommittedReadback =
    | { readonly kind: 'agrees' }
    | { readonly kind: 'differs'; readonly actual: string | undefined }
    | { readonly kind: 'unavailable'; readonly reason: string }

  /**
   * Phase 3B / B2-B (extended by C2-R1): the authoritative re-read of ONE
   * committed TUI-document field. `expected` is the value the authority must
   * return for the commit to count as verified; a non-`ready` backend, an
   * unreadable document or a different value is EXPLICIT (never silently
   * reported as saved). A theme value is compared after the canonical
   * normalization (a legacy `custom:X` document still means `file:X`); every
   * other field is compared against the RAW value its own document key holds.
   */
  const readCommittedField = (field: TuiSettingsField, expected: string): CommittedReadback => {
    const settings = runner.tuiSettings
    if (settings === undefined) {
      return { kind: 'unavailable', reason: 'no authoritative TUI settings document is readable' }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { kind: 'unavailable', reason: `the configuration is ${readiness}; the persisted value could not be re-read` }
    }
    let doc: TuiSettingsDoc
    try {
      doc = settings.get()
    } catch (error) {
      return { kind: 'unavailable', reason: `the persisted value could not be re-read: ${safeErrorMessage(error)}` }
    }
    const actual = readDocumentField(doc, field)
    return actual === expected ? { kind: 'agrees' } : { kind: 'differs', actual }
  }

  const verifyCommittedField = (
    field: TuiSettingsField,
    expected: string,
  ): SettingsWorkspaceCommitOutcome => {
    const readback = readCommittedField(field, expected)
    if (readback.kind === 'agrees') return { outcome: 'verified' }
    if (readback.kind === 'unavailable') {
      // The write RETURNED SUCCESS and the authority cannot be re-read: accepted,
      // unverified (the plan's `Commit accepted · verification unavailable`).
      return { outcome: 'unverified', reason: readback.reason }
    }
    // The write returned success and the authority READABLY disagrees: the value is
    // not stored, so this is a failure — never "verification unavailable", which
    // would claim the readback could not be performed.
    return {
      outcome: 'not-saved',
      reason: `the write reported success, but the authoritative document reads ${readback.actual === undefined || readback.actual === '' ? 'no value' : readback.actual}`,
    }
  }

  /**
   * Classify a replace() REJECTION. A failed write is not proof of a refusal: the
   * official Remote service applies the edit and then performs its own post-write
   * describe, reporting a failure of that read as an error even though the write
   * committed — and the Direct backend's failure is a real conflict. The authority is
   * therefore re-read (the Remote adapter re-reads it on the failed RPC itself):
   *  - a current authority still carrying the value this request started from (the
   *    BASE) REFUTES it (`not-saved`),
   *  - a current authority carrying a THIRD value (neither the base nor the requested
   *    one) shows that someone else wrote in between, so this request's outcome cannot
   *    be attributed (`indeterminate`),
   *  - a current authority already carrying the requested value proves only that the
   *    value is in place — an external writer may have set it before this request was
   *    refused — so neither acceptance nor refusal is attributed to THIS commit
   *    (`indeterminate`), and the same holds when the authority cannot be read.
   * Never a `Saved`, and never an acceptance/refusal claim the Client cannot support.
   */
  const classifyRejectedWrite = (
    field: TuiSettingsField,
    expected: string,
    base: string | undefined,
    failureReason: string,
    prefix: string,
  ): SettingsWorkspaceCommitOutcome => {
    const readback = readCommittedField(field, expected)
    if (readback.kind === 'differs') {
      if (readback.actual === base) return { outcome: 'not-saved', reason: `${prefix}${failureReason}` }
      return {
        outcome: 'indeterminate',
        reason: `${prefix}${failureReason}; the authority no longer reads the value this request started from either, so its outcome cannot be attributed`,
      }
    }
    if (readback.kind === 'agrees') {
      return {
        outcome: 'indeterminate',
        reason: `${prefix}${failureReason}; the authority already reads ${expected}, so this request was either refused after that write or committed and not confirmed`,
      }
    }
    return { outcome: 'indeterminate', reason: `${prefix}${failureReason}; ${readback.reason}` }
  }

  /**
   * Phase 3B / B2-B (extended by C2-R1): commit ONE writable Settings-workspace
   * field. The runtime fact applies through its EXISTING owner first (the
   * established apply-first policy), then the persistence commits through the
   * SAME whole-document serialization + USER-custom-item preservation guard every
   * other settings writer uses, and finally the value is re-read from the
   * authority: only a completed write whose re-read agrees is `verified`.
   *
   * The dispatch is an EXHAUSTIVE switch over
   * {@link SettingsWorkspaceWritableField}: every field reaches its own writer
   * or the type system refuses the change. There is deliberately no runtime
   * default — a new field can never inherit another field's writer.
   *
   * The Display preset deliberately does NOT go through the runner's
   * `setDisplayPreset` (which would dispatch a SECOND detached best-effort
   * write): it applies the runtime fact through the same `TuiApp` DisplayState
   * owner the `/display`/`/focus` commands use and persists exactly once here.
   */
  const commitSettingsWorkspaceField = async (
    request: SettingsWorkspaceCommitRequest,
    approvalScope: import('../../app/session/scope.ts').LiveSessionScope | undefined,
  ): Promise<SettingsWorkspaceCommitOutcome> => {
    const outcome = await ((): Promise<SettingsWorkspaceCommitOutcome> => {
      // C2-R6: a dynamic extension row has its OWN runtime authority (the
      // in-process extension settings registry) — never the TUI document, a
      // Host profile section or the shared document serialization queue. The
      // prefix check runs FIRST so the exhaustive static switch below stays a
      // closed literal union.
      if (request.field.startsWith('ext-setting:')) return commitExtensionSetting(request)
      const field = request.field as Exclude<SettingsWorkspaceWritableField, `ext-setting:${string}`>
      switch (field) {
        case 'visual-tools': return commitVisualTools(request.value, request.revision)
        case 'display-preset': return commitDisplayPreset(request.value)
        case 'theme': return commitTheme(request.value)
        case 'icon-style': return commitIconStyle(request.value)
        case 'expand': return Promise.resolve(commitTranscriptDetail(request.value))
        case 'thinking': return Promise.resolve(commitThinkingDetail(request.value))
        case 'progress-updates': return commitProgressUpdates(request.value)
        case 'response-style': return commitResponseStyle(request.value)
        case 'busy-enter': return commitBusyEnter(request.value)
        case 'git-attribution': return commitGitAttribution(request.value)
        case 'home-end-keys': return commitHomeEndKeys(request.value)
        case 'fullscreen': return commitFullscreen(request.value)
        case 'wheel-scroll-lines': return commitWheelScrollLines(request.value)
        case 'notification-mode': return commitNotificationMode(request.value)
        case 'notification-method': return commitNotificationMethod(request.value)
        case 'terminal-progress': return commitTerminalProgress(request.value)
        case 'approval': return Promise.resolve(commitApproval(request.value, approvalScope))
        case 'default-permission': return commitDefaultPermission(request.value)
        case 'subagent-model-selection': return commitSubagentSelection(request.value)
        case 'local-shell-sandbox': return commitLocalShellSandbox(request.value)
        case 'footer-mode': return commitFooterMode(request.value)
        default: {
          // Exhaustiveness fence: a new writable field must name its writer
          // here instead of falling into another field's branch.
          const unreachable: never = field
          throw new Error(`unmapped settings workspace field ${String(unreachable)}`)
        }
      }
    })()
    if (outcome.outcome !== 'verified') {
      // The write OWNER records the real failure/uncertainty: the workspace's
      // settlement is deliberately dropped once its screen lease is gone, and a
      // dispatched write must stay diagnosable either way (§3/§5.5 — never a
      // silently lost failure). The value is a theme/display name, a disclosure
      // level or a switch candidate, never a secret.
      runner.diag.warn('settings write', {
        field: request.field,
        value: request.value,
        outcome: outcome.outcome,
        ...outcome.reason === undefined ? {} : { reason: outcome.reason },
      })
    }
    return outcome
  }

  /**
   * C2-R6: commit ONE dynamic extension setting through the extension settings
   * registry. This writer is deliberately separate from every static one: it
   * never touches the TUI settings document, a Host profile section, the
   * document serialization queue or an optimistic UI value.
   *
   * The REGISTRATION identity is the fence. The request carries the immutable
   * token it was confirmed for, and the registry compares it BEFORE running the
   * plugin's callback, so a same-id HMR replacement can never receive an old
   * confirmation. The health REF is captured at invocation start from the same
   * preflighted record (`{slot:'setting', id, owner}`), so a rejection lands
   * only on the INVOKING owner and an unload/replacement is `gone` without any
   * health report. An accepted apply is re-read from the registry: only an
   * equal LIVE value is `Verified` — this is a runtime readback, never the TUI
   * document's persisted verification.
   */
  const commitExtensionSetting = async (
    request: SettingsWorkspaceCommitRequest,
  ): Promise<SettingsWorkspaceCommitOutcome> => {
    const id = request.field.slice('ext-setting:'.length)
    const token = request.registrationToken
    if (token === undefined || !Number.isInteger(token)) {
      return { outcome: 'not-saved', reason: 'the extension setting registration identity is missing' }
    }
    const registry = runner.extensions?.settings
    if (registry === undefined) {
      return { outcome: 'not-saved', reason: 'the extension settings registry is not available' }
    }
    const record = registry.rows().find(candidate => candidate.id === id)
    if (record === undefined || record.registrationToken !== token) {
      return { outcome: 'not-saved', reason: 'The extension setting was unloaded or replaced' }
    }
    if (!record.values.includes(request.value)) {
      return { outcome: 'not-saved', reason: 'the requested value is not one of the extension setting\'s registered values' }
    }
    // The REF protocol: this apply speaks for the preflighted record's owner.
    // A replaced registration was already refused by the token check above, so
    // the ref can never name another owner's contribution.
    const healthRef = { slot: 'setting', id, owner: record.owner }
    const outcome = await registry.applyDetailed(id, request.value, token)
    if (outcome === 'rejected') {
      recordExtensionError?.(healthRef, new Error('setting rejected'))
      return { outcome: 'not-saved', reason: 'The extension rejected the change' }
    }
    if (outcome === 'stale') {
      // A newer apply superseded this one: the plugin never refused it, so no
      // health record, no revert and no failure notification may be minted.
      return { outcome: 'not-saved', reason: 'Superseded by a newer extension setting change' }
    }
    if (outcome === 'gone') {
      return { outcome: 'not-saved', reason: 'The extension setting was unloaded or replaced' }
    }
    // `accepted`: the LIVE registry is the authority. Re-read the SAME
    // registration; a different current value means a newer change won, which
    // this request cannot claim as verified.
    const applied = registry.rows().find(candidate => candidate.id === id && candidate.registrationToken === token)
    if (applied === undefined) {
      return { outcome: 'not-saved', reason: 'The extension setting was unloaded or replaced' }
    }
    if (applied.currentValue !== request.value) {
      return {
        outcome: 'indeterminate',
        reason: `the extension settings registry now reads ${applied.currentValue === '' ? 'an empty value' : applied.currentValue}`,
      }
    }
    clearExtensionError?.(healthRef)
    return { outcome: 'verified' }
  }

  /**
   * C2-R1: the runtime-only disclosure commits (`expand` / `thinking`). They
   * touch the SAME `TuiApp` state owners the Ctrl+O / Alt+T hotkeys use, read the
   * value back synchronously and never reach a settings document or a Host port:
   * there is no persisted field behind them, so no write may be claimed.
   */
  const commitTranscriptDetail = (value: string): SettingsWorkspaceCommitOutcome => {
    if (!isCandidateOf(value, DISCLOSURE_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a transcript detail candidate` }
    }
    app.setTranscriptDetailExpanded(value === 'expanded')
    return app.isTranscriptDetailExpanded() === (value === 'expanded')
      ? { outcome: 'verified' }
      : { outcome: 'not-saved', reason: 'the live TUI state did not adopt the requested value' }
  }

  const commitThinkingDetail = (value: string): SettingsWorkspaceCommitOutcome => {
    if (!isCandidateOf(value, DISCLOSURE_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a thinking detail candidate` }
    }
    app.setThinkingExpanded(value === 'expanded')
    return app.isThinkingExpanded() === (value === 'expanded')
      ? { outcome: 'verified' }
      : { outcome: 'not-saved', reason: 'the live TUI state did not adopt the requested value' }
  }

  /**
   * C2-R1: the apply-first + persisted writers. Each one, in this exact order:
   *  1. captures the document value this request starts from (reject
   *     attribution),
   *  2. applies the live owner SYNCHRONOUSLY (never rolled back on a failed
   *     persistence — the established product contract),
   *  3. states both halves when there is no document or a non-`ready` backend,
   *  4. otherwise serializes ONE whole-document mutation that re-reads the
   *     document INSIDE the queue and preserves every other field plus the
   *     USER-owned footer definitions,
   *  5. re-reads the committed field: only a readable, equal value is `Verified`.
   * The three fields differ ONLY in their live owner and their document key.
   */
  const commitIconStyle = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, ICON_STYLE_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not an icon style candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('icon-style')
    // The live glyph vocabulary switches immediately: the transcript, tool and
    // disclosure glyphs must not wait for disk persistence.
    app.setIconStyle(value)
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the icon style is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'icon-style',
      value,
      base,
      document: doc => ({ ...doc, iconStyle: value }),
      localNoun: 'the icon style',
    })
  }

  const commitProgressUpdates = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, PROGRESS_UPDATES_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a progress updates candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('progress-updates')
    // The ONE shared prompt-state object the registered SystemPrompt provider
    // reads on its next step: no section is re-registered and no second state
    // is created.
    runner.progressUpdatesState.mode = parseProgressUpdates(value)
    // The Detail's `Runtime` fact is a PULL projection of this same object: a
    // pending commit must show the cadence that already took effect, while
    // `Persisted` keeps reporting the stored value.
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the progress updates cadence is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'progress-updates',
      value,
      base,
      document: doc => ({ ...doc, progressUpdates: value }),
      localNoun: 'the progress updates cadence',
    })
  }

  const commitResponseStyle = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, RESPONSE_STYLE_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a response style candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('response-style')
    // The ONE shared prompt-state object, exactly like progress updates and
    // deliberately independent of it.
    runner.responseStyleState.style = parseResponseStyle(value)
    // Same rule as progress updates: the live axis reaches the pending row now.
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the response style is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'response-style',
      value,
      base,
      document: doc => ({ ...doc, responseStyle: value }),
      localNoun: 'the response style',
    })
  }

  /**
   * The shared persistence half of the apply-first fields: ONE serialized
   * whole-document mutation (whose queue re-reads the live document), the
   * existing refusal classification, then the authoritative re-read. A non-ready
   * backend is refused BEFORE the write, after the runtime already applied.
   */
  const commitAppliedTuiField = async (spec: {
    readonly settings: { get(): TuiSettingsDoc; replace(doc: TuiSettingsDoc): unknown }
    readonly field: TuiSettingsField
    readonly value: string
    readonly base: string | undefined
    readonly document: (doc: TuiSettingsDoc) => TuiSettingsDoc
    readonly localNoun: string
  }): Promise<SettingsWorkspaceCommitOutcome> => {
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return {
        outcome: 'not-saved',
        reason: `${spec.localNoun} is applied locally, but the configuration is ${readiness} so it could not be stored`,
      }
    }
    try {
      await serializeTuiSettingsMutation(spec.settings, async () => {
        // Re-read INSIDE the queue: a document written by a concurrent writer
        // while this request waited must not be overwritten wholesale.
        await spec.settings.replace(
          withUserFooterCustomItems(spec.document(spec.settings.get()), runner.config),
        )
      })
    } catch (error) {
      // Never a blanket `not-saved`: the Remote adapter can commit the write and
      // still fail its post-write describe, so the outcome is attributed from a
      // fresh authoritative read exactly like the theme/display writers.
      return classifyRejectedWrite(
        spec.field,
        spec.value,
        spec.base,
        safeErrorMessage(error),
        `${spec.localNoun} is applied locally, but storing it failed: `,
      )
    }
    return verifyCommittedField(spec.field, spec.value)
  }

  /**
   * C2-R2: the shared persistence half of the two PERSIST-FIRST fields
   * (`busy-enter`, `fullscreen`). The stored document IS the authority, so —
   * unlike the apply-first helper — nothing is applied before the write: the
   * readiness/readability gate refuses BEFORE any mutation, the ONE serialized
   * whole-document mutation carries the field, and only a completed write whose
   * fresh read agrees is `Verified`. Two callers (the busy-Enter input policy
   * and the lease-safe fullscreen preference) share this exact outcome
   * taxonomy instead of growing a second one.
   */
  const commitPersistedOnlyField = async (spec: {
    readonly field: TuiSettingsField
    readonly value: string
    readonly document: (doc: TuiSettingsDoc) => TuiSettingsDoc
    readonly localNoun: string
  }): Promise<SettingsWorkspaceCommitOutcome> => {
    const settings = runner.tuiSettings
    if (settings === undefined) {
      return { outcome: 'not-saved', reason: `no authoritative TUI settings document is available to store ${spec.localNoun}` }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'not-saved', reason: `the configuration is ${readiness}; ${spec.localNoun} was not stored` }
    }
    // A persist-first field has NO runtime half to fall back on: the write is
    // only allowed against a document that can really be read NOW, and the
    // current value is the base a rejection is attributed from.
    let base: string | undefined
    try {
      base = readDocumentField(settings.get(), spec.field)
    } catch (error) {
      return {
        outcome: 'not-saved',
        reason: `${spec.localNoun} was not stored: the TUI settings document could not be read (${safeErrorMessage(error)})`,
      }
    }
    try {
      await serializeTuiSettingsMutation(settings, async () => {
        // Re-read INSIDE the queue: a document written by a concurrent writer
        // while this request waited must not be overwritten wholesale.
        await settings.replace(withUserFooterCustomItems(spec.document(settings.get()), runner.config))
      })
    } catch (error) {
      return classifyRejectedWrite(
        spec.field,
        spec.value,
        base,
        safeErrorMessage(error),
        `storing ${spec.localNoun} failed: `,
      )
    }
    return verifyCommittedField(spec.field, spec.value)
  }

  /**
   * C2-R2: the six apply-first writers. Each one, in this exact order:
   *  1. strict candidate membership (a parser's default is normalization, never
   *     validation) and the base document value the request starts from,
   *  2. the ONE live owner applies SYNCHRONOUSLY (never rolled back later),
   *  3. the pending row's runtime fact is re-read through the app's own push,
   *  4. the shared persistence half writes ONE whole document and re-reads it.
   * They differ ONLY in their live owner and their document key.
   */
  const commitGitAttribution = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, GIT_ATTRIBUTION_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a Git attribution candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('git-attribution')
    // The ONE state the registered `tui:git-attribution` SystemPrompt section
    // reads on its next assembly: no section is re-registered and no second
    // state is created.
    runner.gitAttributionState.mode = parseGitAttributionMode(value)
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the Git attribution guidance is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'git-attribution',
      value,
      base,
      document: doc => ({ ...doc, gitAttribution: value }),
      localNoun: 'the Git attribution guidance',
    })
  }

  const commitHomeEndKeys = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, HOME_END_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a Home/End keys candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('home-end-keys')
    // The ONE keymap owner: the preset rewrites only the two viewport chords,
    // so every other binding survives.
    app.setHomeEndMode(value)
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the Home/End keys preset is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'home-end-keys',
      value,
      base,
      document: doc => ({ ...doc, homeEndKeys: value }),
      localNoun: 'the Home/End keys preset',
    })
  }

  const commitWheelScrollLines = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, WHEEL_SCROLL_LINE_VALUES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a mouse wheel lines candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('wheel-scroll-lines')
    const lines = wheelScrollLinesOf(value)
    // NEXT-mount preference only: the mounted fullscreen viewport keeps its
    // constructor-time step (the fork exposes no setter), so nothing here may
    // claim the LIVE wheel already changed.
    app.setWheelScrollLines(lines)
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the mouse wheel step is set for the next fullscreen entry, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'wheel-scroll-lines',
      value: String(lines),
      base,
      document: doc => ({ ...doc, wheelScrollLines: String(lines) }),
      localNoun: 'the mouse wheel step',
    })
  }

  const commitNotificationMode = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, NOTIFICATION_MODE_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a notification mode candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('notification-mode')
    // The SAME completion controller: the next settle already uses the new
    // policy, and no second controller is created.
    runner.setNotificationMode(value)
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the notification policy is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'notification-mode',
      value,
      base,
      document: doc => ({ ...doc, notificationMode: value }),
      localNoun: 'the notification policy',
    })
  }

  const commitNotificationMethod = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, NOTIFICATION_METHOD_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a notification method candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('notification-method')
    // Delivery axis of the SAME controller. It emits nothing by itself, so no
    // synthetic notification is ever sent to probe the result.
    runner.setNotificationMethod(value)
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the notification method is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'notification-method',
      value,
      base,
      document: doc => ({ ...doc, notificationMethod: value }),
      localNoun: 'the notification method',
    })
  }

  const commitTerminalProgress = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, TERMINAL_PROGRESS_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a terminal progress candidate` }
    }
    const settings = runner.tuiSettings
    const base = persistedValueOf('terminal-progress')
    // The ONE terminal status owner: the OSC 9;4 / OSC 7501 projection follows
    // immediately. The retired `on` value is read compatibility only and is
    // never a candidate this writer accepts.
    runner.setTerminalProgressMode(value)
    app.refreshSettingsWorkspaceRuntimeFacts()
    if (settings === undefined) {
      return {
        outcome: 'not-saved',
        reason: 'the terminal progress selection is applied locally, but no authoritative TUI settings document is available to store it',
      }
    }
    return commitAppliedTuiField({
      settings,
      field: 'terminal-progress',
      value,
      base,
      document: doc => ({ ...doc, terminalProgress: value }),
      localNoun: 'the terminal progress selection',
    })
  }

  /** C2-R2: PERSIST-FIRST busy Enter. The next busy Enter reads this document
   *  field through `SettingsRuntime.busyEnter()`; nothing about a running turn
   *  is rewritten and no local switch is created. */
  const commitBusyEnter = (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, BUSY_ENTER_CANDIDATES)) {
      return Promise.resolve({ outcome: 'not-saved', reason: `"${value}" is not a busy Enter candidate` })
    }
    return commitPersistedOnlyField({
      field: 'busy-enter',
      value,
      document: doc => ({ ...doc, busyEnter: value }),
      localNoun: 'the busy Enter policy',
    })
  }

  /** C2-R2: PERSIST-FIRST fullscreen. The write ONLY stores the preference: the
   *  physical switch is the workspace's post-close action (the lease owns the
   *  screen while this panel is open), so a confirmed value never swaps screens
   *  here and `Verified` only ever means the document was stored and re-read. */
  const commitFullscreen = (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, FULLSCREEN_CANDIDATES)) {
      return Promise.resolve({ outcome: 'not-saved', reason: `"${value}" is not a fullscreen candidate` })
    }
    return commitPersistedOnlyField({
      field: 'fullscreen',
      value,
      document: doc => ({ ...doc, fullscreen: value }),
      localNoun: 'the fullscreen preference',
    })
  }

  /**
   * C2-R3: PERSIST-FIRST user-shell sandbox policy. The stored document IS the
   * authority; `user-shell.ts` reads the SAME raw field through
   * `localShellSandboxPreferenceOf` at the next `!`/`!!`. Nothing about the Host
   * shell routing, the permission presets or the Host sandbox default is
   * touched here, and no local switch is introduced.
   */
  /**
   * The official section for READ-ONLY projection, or `undefined` when the
   * authority cannot answer. Callers must treat `undefined` as "no rows", never
   * as the shipped default: a fabricated `off`/empty section handed to a writer
   * would erase routes the Host still stores.
   */
  const readSubagentSectionOrUndefined = (): OfficialSectionState | undefined => {
    // An UNAVAILABLE section answers with the shipped default rather than
    // throwing (the Direct adapter's absent-service shape), and that default is
    // NOT a stored value: it may not become a rollback target, a write base or a
    // saved summary.
    if (!runner.config.subagentModelSelection.available()) return undefined
    try {
      const latest = runner.config.subagentModelSelection.get()
      return {
        enabled: latest.enabled,
        allowedModels: latest.allowedModels.map(route => ({ ...route })),
      }
    } catch {
      return undefined
    }
  }

  /** Whether two official allowlists carry the SAME ordered (provider,model)
   *  pairs. The pair is the only route identity: a display name never compares. */
  /** The human-readable reason of one section refusal. */
  const refusalMessage = (refusal: OfficialSectionRefusal): string => {
    switch (refusal.kind) {
      case 'empty-allowlist': return 'Select at least one Subagent allowed model before enabling model selection.'
      case 'last-route-while-enabled': return 'disable subagent model selection before removing the last route'
      case 'not-writable': return `${refusal.reason}; the official subagent settings were not changed`
      case 'unreadable': return `the official subagent settings could not be read (${refusal.reason}); nothing was changed`
    }
  }

  /** Apply one route intent to a FRESH route list (the queue's rebase step). */
  const applyRouteIntent = (
    fresh: readonly import('../../runtime/config-port.ts').SubagentAllowedModelRoute[],
    route: import('../../runtime/config-port.ts').SubagentAllowedModelRoute,
    direction: 'add' | 'remove',
  ): readonly import('../../runtime/config-port.ts').SubagentAllowedModelRoute[] => {
    const without = fresh.filter(existing => !(existing.provider === route.provider && existing.model === route.model))
    return direction === 'remove'
      ? without
      : [...without, { provider: route.provider, model: route.model }]
  }

  const sameAllowlist = (
    left: readonly import('../../runtime/config-port.ts').SubagentAllowedModelRoute[],
    right: readonly import('../../runtime/config-port.ts').SubagentAllowedModelRoute[],
  ): boolean => left.length === right.length
    && left.every((route, index) => route.provider === right[index]?.provider && route.model === right[index]?.model)

  const commitLocalShellSandbox = (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, LOCAL_SHELL_SANDBOX_CANDIDATES)) {
      return Promise.resolve({ outcome: 'not-saved', reason: `"${value}" is not a user shell sandbox policy candidate` })
    }
    return commitPersistedOnlyField({
      field: 'local-shell-sandbox',
      value,
      document: doc => ({ ...doc, localShellSandbox: value }),
      localNoun: 'the user shell sandbox policy',
    })
  }

  /**
   * C2-R5: the ONE Footer-mode document transaction of the Settings workspace
   * Footer-mode row. It runs INSIDE
   * the shared TUI-settings FIFO, re-reads the whole document and the detached
   * USER custom-item layer at the commit point, and replaces exactly the three
   * footer fields it owns (`footer`, `footerFallbackMode`, and — for `custom` —
   * a valid `footerLayout`). A `command` mode or any unknown/trust field rides
   * through verbatim; an unreadable USER layer aborts the whole write instead
   * of overwriting future definitions with a merged projection.
   */
  const writeFooterModeDocument = async (
    value: (typeof FOOTER_MODE_CANDIDATES)[number],
    settings: { get(): TuiSettingsDoc; replace(doc: TuiSettingsDoc): unknown },
  ): Promise<{ readonly layout: unknown; readonly customItems: unknown }> => serializeTuiSettingsMutation(settings, async () => {
    const doc = settings.get()
    // Selecting custom with no (valid) layout initializes an editable copy of
    // the default layout.
    const layout = value === 'custom'
      ? !isFooterLayout(parseFooterLayout(doc.footerLayout))
        ? DEFAULT_FOOTER_LAYOUT
        : doc.footerLayout
      : doc.footerLayout
    const raw = runner.config.footerCustomItems.rawForPersistence()
    if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
    await settings.replace({
      ...doc,
      footer: value,
      footerLayout: layout,
      footerFallbackMode: value,
      footerCustomItems: raw.value,
    })
    return { layout, customItems: raw.value }
  })

  /** The authoritative re-read of the ONE Footer-mode commit: the stored mode,
   *  its restart fallback and (for `custom`) the SAME valid layout must agree. */
  const verifyFooterMode = (value: string, expectedLayout: unknown): SettingsWorkspaceCommitOutcome => {
    const settings = runner.tuiSettings
    if (settings === undefined) {
      return { outcome: 'unverified', reason: 'the footer mode was stored, but no settings document is readable to verify it' }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'unverified', reason: `the footer mode was stored, but the configuration is ${readiness} so it could not be verified` }
    }
    let doc: TuiSettingsDoc
    try {
      doc = settings.get()
    } catch (error) {
      return { outcome: 'unverified', reason: `the footer mode was stored, but the document could not be re-read: ${safeErrorMessage(error)}` }
    }
    const writtenLayout = parseFooterLayout(expectedLayout)
    const readLayout = parseFooterLayout(doc.footerLayout)
    // Identity, not merely validity: a concurrent writer replacing the layout
    // with another VALID one must not be reported as this commit's Verified.
    const layoutAgrees = value !== 'custom'
      || (isFooterLayout(writtenLayout) && isFooterLayout(readLayout)
        && JSON.stringify(readLayout) === JSON.stringify(writtenLayout))
    if (doc.footer === value && doc.footerFallbackMode === value && layoutAgrees) return { outcome: 'verified' }
    return {
      outcome: 'not-saved',
      reason: `the write reported success, but the authoritative document reads footer ${doc.footer}, fallback ${doc.footerFallbackMode ?? 'not set'}`
        + (value === 'custom' && !layoutAgrees ? ', with no valid custom layout' : ''),
    }
  }

  /** C2-R5: PERSIST-FIRST Footer mode. The document is the authority; the live
   *  footer is applied ONLY from a completed write, and only an agreeing fresh
   *  read is `Verified`. A non-ready/unreadable document refuses with zero
   *  writes and zero runtime change. */
  const commitFooterMode = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, FOOTER_MODE_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a footer mode candidate` }
    }
    const settings = runner.tuiSettings
    if (settings === undefined) {
      return { outcome: 'not-saved', reason: 'no authoritative TUI settings document is available to store the footer mode' }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'not-saved', reason: `the configuration is ${readiness}; the footer mode was not stored` }
    }
    let base: string | undefined
    try {
      base = readDocumentField(settings.get(), 'footer-mode')
    } catch (error) {
      return {
        outcome: 'not-saved',
        reason: `the footer mode was not stored: the TUI settings document could not be read (${safeErrorMessage(error)})`,
      }
    }
    let next: { readonly layout: unknown; readonly customItems: unknown }
    try {
      next = await writeFooterModeDocument(value, settings)
    } catch (error) {
      return classifyRejectedWrite('footer-mode', value, base, safeErrorMessage(error), 'storing the footer mode failed: ')
    }
    if (app.isDisposed()) {
      return { outcome: 'unverified', reason: 'the footer mode was stored, but the surface was disposed before it could be applied' }
    }
    runner.applyFooterSettings({ footer: value, footerLayout: next.layout, footerCustomItems: next.customItems })
    return verifyFooterMode(value, next.layout)
  }

  /**
   * C2-R3: RUNTIME-ONLY approval policy of the EXACT session this workspace was
   * opened on. The pinned scope is the whole target identity: a scope that is no
   * longer current is refused SYNCHRONOUSLY with no dispatch at all, so a stale
   * Confirm can never land on the replacement Session. `Verified` means the
   * official service now reads this value back for the SAME scope; it makes no
   * persistence claim (there is no document field).
   */
  const commitApproval = (
    value: string,
    approvalScope: import('../../app/session/scope.ts').LiveSessionScope | undefined,
  ): SettingsWorkspaceCommitOutcome => {
    if (!isCandidateOf(value, APPROVAL_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not an approval policy candidate` }
    }
    if (approvalScope === undefined || !runner.isSessionScopeCurrent(approvalScope)) {
      // The row itself is gone from the next snapshot (the captured owner is no
      // longer current), so the refusal must reach the user through the ONE
      // app notice — the ONE app-owned wording for a switched session.
      app.notify('the session changed — the approval policy was not applied', 'error')
      return {
        outcome: 'not-saved',
        reason: 'the session this workspace was opened on is no longer current — reopen Settings to change the approval policy of the new session',
      }
    }
    if (!runner.config.permissions.approvalOverrideAvailable()) {
      return { outcome: 'not-saved', reason: 'this backend does not read or write a session approval override' }
    }
    if (runner.setSessionApprovalPolicy(approvalScope, value) === 'superseded') {
      app.notify('the session changed — the approval policy was not applied', 'error')
      return {
        outcome: 'not-saved',
        reason: 'the session changed — the approval policy was not applied',
      }
    }
    // The official service is the reader: only a same-scope value that really
    // reads back as the requested policy is Verified.
    const readback = runner.currentApprovalOverride(approvalScope)
    if (readback === value) {
      runner.refreshStatus()
      return { outcome: 'verified' }
    }
    if (readback === undefined) {
      return { outcome: 'unverified', reason: 'the session approval override could not be re-read' }
    }
    return {
      outcome: 'not-saved',
      reason: `the session approval override reads ${readback}`,
    }
  }

  /**
   * C2-R3: the Host permission DEFAULT for future sessions. The write is
   * HOST-PERSIST-FIRST: the value must still be a member of the CURRENT roster,
   * the official `permission.defaultPreset` mutation runs, and only a fresh
   * `defaultPreset()` that agrees is `Verified`. The running Session's preset,
   * sandbox and approval knobs are never touched.
   */
  const commitDefaultPermission = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    const permissions = runner.config.permissions
    const roster = [...permissions.presetNames()]
    if (!roster.includes(value)) {
      return { outcome: 'not-saved', reason: `"${value}" is not an available permission preset` }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'not-saved', reason: `the configuration is ${readiness}; the permission default was not changed` }
    }
    const base = permissions.defaultPreset()
    try {
      await permissions.setDefaultPreset(value)
    } catch (error) {
      // Never a blanket `not-saved`: the write may have committed and failed
      // only its read, so the outcome is attributed from a fresh read exactly
      // like the document writers.
      const readback = permissions.defaultPreset()
      if (readback === value) {
        return {
          outcome: 'indeterminate',
          reason: `the write failed (${safeErrorMessage(error)}), but the Host already reads ${value}: this request was either refused after that write or committed and not confirmed`,
        }
      }
      if (readback === base) {
        return { outcome: 'not-saved', reason: safeErrorMessage(error) }
      }
      return {
        outcome: 'indeterminate',
        reason: `${safeErrorMessage(error)}; the Host permission default no longer reads the value this request started from either, so its outcome cannot be attributed`,
      }
    }
    const readback = permissions.defaultPreset()
    if (readback === value) return { outcome: 'verified' }
    if (readback === undefined) {
      return { outcome: 'unverified', reason: 'the Host permission default could not be re-read' }
    }
    return {
      outcome: 'not-saved',
      reason: `the write reported success, but the Host permission default reads ${readback}`,
    }
  }

  /**
   * C2-R3: the official subagent model-selection toggle. It runs INSIDE the one
   * section write queue, so a pending picker write can never be reordered. The
   * fresh section read inside the queue is what decides the payload: enabling
   * with ZERO allowed routes is refused with NO official write at all and the
   * typed follow-up sends the user to the allowlist row. Disabling always keeps
   * every saved route.
   */
  const commitSubagentSelection = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isCandidateOf(value, SUBAGENT_SELECTION_CANDIDATES)) {
      return { outcome: 'not-saved', reason: `"${value}" is not a subagent model selection candidate` }
    }
    const desired = value === 'on'
    return enqueueSubagentSectionWrite(async (): Promise<SettingsWorkspaceCommitOutcome> => {
      const section = runner.config.subagentModelSelection
      if (!section.available()) {
        return { outcome: 'not-saved', reason: 'the official subagent model-selection section is unavailable on this backend' }
      }
      // A stale/unavailable backend keeps readable LAST-KNOWN values: writing
      // them back would overwrite whatever the Host changed while this Client
      // was not current, so the commit is refused BEFORE any dispatch.
      const readiness = runner.config.configReadiness()
      if (readiness !== 'ready') {
        return {
          outcome: 'not-saved',
          reason: `the configuration is ${readiness}; the official subagent section could not be confirmed current, so it was not changed`,
        }
      }
      let latest: OfficialSectionState
      try {
        latest = section.get()
      } catch (error) {
        return { outcome: 'not-saved', reason: `the official subagent model-selection section could not be read: ${safeErrorMessage(error)}` }
      }
      if (desired && latest.allowedModels.length === 0) {
        // Zero official writes: the setup precondition is stated where the user
        // can still read it (the app notice survives the navigation) and the
        // ONE typed follow-up moves the selection to the allowlist row.
        const reason = 'Select at least one Subagent allowed model before enabling model selection.'
        app.notify(reason, 'info')
        return { outcome: 'not-saved', reason, followUpRowId: 'subagent-model-allowlist' }
      }
      // This intent owns the `enabled` half ONLY: the route list comes from the
      // FRESH read made above (inside the queue), so a picker write that landed
      // while this request waited is preserved instead of being overwritten by
      // a stale snapshot.
      const base: OfficialSectionState = {
        enabled: latest.enabled,
        allowedModels: latest.allowedModels.map(route => ({ ...route })),
      }
      try {
        await section.set({ enabled: desired, allowedModels: base.allowedModels.map(route => ({ ...route })) })
      } catch (error) {
        // Attribute from a fresh official read: only a section still carrying
        // the BASE value refutes THIS request. An unreadable readback cannot
        // attribute anything, so the outcome stays indeterminate.
        let readback: OfficialSectionState
        try {
          if (!section.available()) throw new Error('the section is no longer available')
          readback = section.get()
        } catch {
          return {
            outcome: 'indeterminate',
            reason: `${safeErrorMessage(error)}; the official section could not be re-read, so the outcome cannot be attributed`,
          }
        }
        if (readback.enabled === desired && sameAllowlist(readback.allowedModels, base.allowedModels)) {
          return {
            outcome: 'indeterminate',
            reason: `the write failed (${safeErrorMessage(error)}), but the official section already reads this selection`,
          }
        }
        if (readback.enabled === base.enabled && sameAllowlist(readback.allowedModels, base.allowedModels)) {
          return { outcome: 'not-saved', reason: safeErrorMessage(error) }
        }
        return {
          outcome: 'indeterminate',
          reason: `${safeErrorMessage(error)}; the official section no longer reads the value this request started from either`,
        }
      }
      // Save/verify means BOTH halves of the section: the toggle AND the list.
      // A THROWING readback cannot refute the commit — the write DID return
      // success, so the honest verdict is `unverified`, never `not-saved`.
      let readback: OfficialSectionState
      try {
        if (!section.available()) throw new Error('the section is no longer available')
        readback = section.get()
      } catch (error) {
        return {
          outcome: 'unverified',
          reason: `the write reported success, but the official section could not be re-read: ${safeErrorMessage(error)}`,
        }
      }
      if (readback.enabled === desired && sameAllowlist(readback.allowedModels, base.allowedModels)) {
        return { outcome: 'verified' }
      }
      return {
        outcome: 'not-saved',
        reason: `the write reported success, but the official section reads enabled=${readback.enabled ? 'on' : 'off'} with ${readback.allowedModels.length} allowed ${readback.allowedModels.length === 1 ? 'route' : 'routes'}`,
      }
    })
  }

  const commitDisplayPreset = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    if (!isDisplayPreset(value) || !isDisplayPresetAvailable(value)) {
      return { outcome: 'not-saved', reason: `the display preset "${value}" is not available in this build` }
    }
    const settings = runner.tuiSettings
    // The value this request starts from: only an authority still carrying IT refutes
    // the write; a third value means someone else wrote in between.
    const base = persistedValueOf('display-preset')
    // Runtime apply through the ONE shared DisplayState owner. `unchanged` still
    // continues to persistence: the runtime being on the preset says nothing
    // about the stored preference.
    const applied = app.setDisplayPreset(value)
    if (applied.kind === 'unsupported') {
      return { outcome: 'not-saved', reason: `the display preset "${value}" is not available in this build` }
    }
    if (applied.kind === 'applied') runner.refreshStatus()
    if (settings === undefined) {
      // The runtime fact really changed (Client-local); the persisted preference
      // has no authority to write to. Both halves are stated, neither is faked.
      return { outcome: 'not-saved', reason: 'the display preset is applied locally, but no TUI settings document is available to store it' }
    }
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'not-saved', reason: `the display preset is applied locally, but the configuration is ${readiness} so it could not be stored` }
    }
    try {
      await serializeTuiSettingsMutation(settings, async () => {
        await settings.replace(withUserFooterCustomItems({ ...settings.get(), displayPreset: value }, runner.config))
      })
    } catch (error) {
      return classifyRejectedWrite(
        'display-preset',
        value,
        base,
        safeErrorMessage(error),
        'the display preset is applied locally, but storing it failed: ',
      )
    }
    return verifyCommittedField('display-preset', value)
  }

  const commitTheme = async (value: string): Promise<SettingsWorkspaceCommitOutcome> => {
    const settings = runner.tuiSettings
    // See commitDisplayPreset: the base value decides whether a rejection can be
    // attributed to THIS request.
    const base = persistedValueOf('theme')
    if (settings === undefined) {
      return { outcome: 'not-saved', reason: 'no authoritative TUI settings document is available in this deployment' }
    }
    // §9.1 pre-flight: a theme is a HOST-persisted preference — with a backend
    // that cannot vouch for its values neither the apply nor the write may be
    // presented as a real save.
    const readiness = runner.config.configReadiness()
    if (readiness !== 'ready') {
      return { outcome: 'not-saved', reason: `the configuration is ${readiness}; the theme was not changed` }
    }
    const builtin = value === 'auto' || value === 'dark' || value === 'light'
    // VALUE-addressed health tracking (the unified theme protocol).
    const themeRef = builtin ? undefined : captureExtensionHealthRef?.('theme', value)
    // The SYNCHRONOUS latest choice is recorded only by a choice that really took
    // effect at runtime, always BEFORE the first await: the terminal detection's
    // guard must observe this new intent even while the persistence of a previous
    // choice is still in flight (a late OSC answer may never colour over it), and
    // a FAILED candidate must never steal the intent of a still-pending `auto`
    // (a failed apply keeps the previous choice).
    if (value === 'auto') {
      // For `auto`, starting the detection IS the apply. Drop the plugin-theme
      // record FIRST: the unload fallback of a theme the user has left must never
      // force dark and stop the terminal tracking over the stored `auto`.
      app.noteThemeSelection(value)
      app.clearActivePluginTheme()
      app.trackTerminalTheme(true)
      detach('theme autodetect', () => app.autoDetectTheme({
        shouldApply: () => app.themeFollowsTerminal(),
      }))
    } else {
      try {
        if (value === 'dark' || value === 'light') {
          app.clearActivePluginTheme()
          app.applyTheme(value)
        } else {
          // The source identity is resolved AGAIN at commit time: a plugin that
          // unloaded (HMR) or a file that vanished between the choice and the
          // confirm is refused — never redirected to a same-named other source.
          const selection = resolveThemeSelection(value, runner.extensions?.themes)
          if (selection === undefined) {
            if (themeRef !== undefined) recordExtensionError?.(themeRef, new Error('theme not found'))
            return { outcome: 'not-saved', reason: `the theme source for ${value} is no longer available` }
          }
          if (selection.kind === 'plugin') app.applyPluginPalette(selection.value, selection.palette)
          else {
            app.clearActivePluginTheme()
            app.applyPalette(selection.palette)
          }
        }
        app.trackTerminalTheme(false)
        if (themeRef !== undefined) clearExtensionError?.(themeRef)
      } catch (error) {
        if (themeRef !== undefined) recordExtensionError?.(themeRef, error)
        return { outcome: 'not-saved', reason: `the palette could not be applied: ${safeErrorMessage(error)}` }
      }
      // The runtime really changed: only now does this choice own the query guard.
      app.noteThemeSelection(value)
    }
    try {
      await serializeTuiSettingsMutation(settings, async () => {
        await settings.replace(withUserFooterCustomItems({ ...settings.get(), theme: value }, runner.config))
      })
    } catch (error) {
      // The plan's failure wording is `Not saved · <the actual failure>`; a theme is a
      // Host-persisted preference with no separate local fact to name.
      return classifyRejectedWrite('theme', value, base, safeErrorMessage(error), '')
    }
    return verifyCommittedField('theme', value)
  }

  /**
   * Phase 3B / B2-A: the read projection of the Settings workspace. Every call
   * re-reads the LIVE authorities — the ConfigPort readiness and TUI settings
   * document, the Host visual-tools section, the runtime display preset and the
   * Client presentation preference — and assembles the fixed rows; every
   * writable row additionally carries its candidate source and its
   * runtime/persisted facts. It captures NO
   * shadow store: a missing document is `unavailable` (never a persisted
   * default), a stale backend keeps the document as `last-known`, and a throwing
   * `get()` is the row's explicit `read-error`.
   */
  const readSettingsWorkspaceSnapshot = (
    approvalScope: import('../../app/session/scope.ts').LiveSessionScope | undefined,
  ): SettingsWorkspaceSnapshot => {
    const configReadiness = runner.config.configReadiness()
    // ONE synchronous registry read group per snapshot: the concrete live
    // registrations (each carries its immutable per-registration token) plus
    // the revision that describes the SAME directory. No plugin callback runs
    // between the two reads and no second registry/cache is created; the
    // conditional `Extensions` category and every dynamic row come from THIS
    // projection, so a registration between two reads can never produce a
    // category without the row that makes it reachable.
    const extensionSettings = runner.extensions?.settings
    const extensionRecords = extensionSettings?.rows() ?? []
    const extensionRevision = extensionSettings?.snapshot().revision ?? 0
    const settings = runner.tuiSettings
    let doc: TuiSettingsDoc | undefined
    let readIssue: string | undefined
    if (settings !== undefined) {
      try {
        doc = settings.get()
      } catch (error) {
        readIssue = safeErrorMessage(error)
      }
    }
    const configuredFreshness: SettingsWorkspaceFreshness = doc === undefined
      ? readIssue !== undefined ? 'read-error' : 'unavailable'
      : configReadiness === 'ready' ? 'ready' : 'last-known'
    const unavailableNote = 'Unavailable — no authoritative config document'
    const themeRaw = doc?.theme
    const iconRaw = doc?.iconStyle
    const progressRaw = doc?.progressUpdates
    const responseRaw = doc?.responseStyle
    const persistedTheme = doc === undefined ? undefined : normalizePersistedTheme(themeRaw)
    const runtimePreset = displayPresetOf(runner)
    const persistedPreset = doc?.displayPreset
    const thinking = app.isThinkingExpanded() ? 'expanded' : 'collapsed'
    // R1: the FIVE live runtime facts, read from the authority that really owns
    // each of them — never from the document. The icon palette is the running
    // surface's own state: an apply-first write leaves it live even when the
    // persistence was refused, so the stored `iconStyle` can legitimately be
    // older (or absent/garbage) and stays a SEPARATE Persisted fact. The startup
    // normalization (`iconStyleOf`) is what puts a legal value into the app.
    const runtimeIcon = app.currentIconStyle()
    const expand = app.isTranscriptDetailExpanded() ? 'expanded' : 'collapsed'
    const runtimeProgress = runner.progressUpdatesState.mode
    const runtimeResponse = runner.responseStyleState.style
    // C2-R2: the SIX apply-first live owners, read from the same authorities
    // their writers mutate. The document's raw value stays a SEPARATE fact.
    const runtimeGitAttribution = runner.gitAttributionState.mode
    const runtimeHomeEnd = homeEndLiveModeOf()
    const runtimeNotificationMode = runner.currentNotificationMode()
    const runtimeNotificationMethod = runner.currentNotificationMethod()
    const runtimeTerminalProgress = app.currentTerminalProgressMode()
    // The wheel step is a NEXT-mount preference: the live fact must say so,
    // never imply the already-mounted viewport changed (plan §3.2).
    const runtimeWheel = `${app.currentWheelScrollLines()} (next fullscreen entry)`
    // The persist-first rows report the DOCUMENT as their primary fact, so the
    // stored raw value (never the consumer default) is what the Detail shows.
    const storedBusyEnter = storedCandidateFactOf(doc?.busyEnter, doc !== undefined, BUSY_ENTER_CANDIDATES, 'unknown — document unavailable')
    const storedFullscreen = storedCandidateFactOf(doc?.fullscreen, doc !== undefined, FULLSCREEN_CANDIDATES, 'unknown')
    // C2-R5: the Footer mode is a PERSIST-FIRST TUI-document field. `command` is
    // a real USER opt-in whose live surface is the persisted fallback, so it is
    // displayed as `command (manual)` — never as an invalid value and never as a
    // confirmable candidate.
    const storedFooterMode = doc === undefined
      ? 'unknown — document unavailable'
      : doc.footer === undefined || doc.footer === ''
        ? 'not set'
        : doc.footer === 'command'
          ? 'command (manual)'
          : isCandidateOf(doc.footer, FOOTER_MODE_CANDIDATES)
            ? doc.footer
            : `invalid stored value: ${doc.footer}`
    const runtimeFooterMode = app.getFooterMode()
    const footerFallbackFact = doc?.footer === 'command'
      ? `command surface · fallback ${runtimeFooterMode}`
      : `Runtime: ${runtimeFooterMode}`
    const footerLayoutRows = app.getEffectiveFooterLayout().rows.length
    const footerSurfaceSummary = doc?.footer === 'command'
      ? `command → ${runtimeFooterMode} · ${footerLayoutRows} ${footerLayoutRows === 1 ? 'row' : 'rows'}`
      : `${runtimeFooterMode} · ${footerLayoutRows} ${footerLayoutRows === 1 ? 'row' : 'rows'}`
    // C2-R5: the Keyboard shortcuts row's summary comes from the SAME
    // controller the page mutates — read once for this snapshot, never a second
    // keymap store. A missing/unreadable settings document leaves the row
    // discoverable but unopenable.
    let keybindingModel: KeybindingEditorModel | undefined
    if (runner.tuiSettings !== undefined && doc !== undefined) {
      try {
        // The summary is derived from the ONE document read this snapshot
        // already made: no second guarded read per workspace open.
        const parsed = parseUserKeybindings(doc.keybindings)
        for (const message of parsed.diagnostics) runner.diag.debug('keybinding configuration', { message })
        keybindingModel = buildKeybindingEditorModel(app.keybindingsManager(), parsed)
      } catch (error) {
        runner.diag.warn('keybinding editor read', { error: safeErrorMessage(error) })
      }
    }
    // The consumer's NEXT busy Enter policy: the raw document read through the
    // SAME rule `resolveComposerDelivery` applies, with the default called out
    // as such instead of being presented as a saved value.
    const busyEnterRuntime = doc === undefined
      ? 'unknown — the next busy Enter policy cannot be read without the settings document'
      : doc.busyEnter === 'queue' || doc.busyEnter === 'steer'
        ? `Next busy Enter: ${doc.busyEnter}`
        : 'Next busy Enter: queue (default; no valid saved value)'
    // The persisted fact is only a fact once the document was actually READ:
    // an absent document or a throwing read is an UNKNOWN persistence state,
    // never "read and not configured".
    const persistedNote = doc !== undefined
      ? `Persisted preference: ${persistedPreset ?? 'not set'} (last read from the TUI settings document — not the current runtime value).`
      : readIssue !== undefined
        ? `Persisted preference unknown — the TUI settings document could not be read (${readIssue}).`
        : 'Persisted preference unknown — no authoritative TUI settings document is available.'
    // The profile-wide switch has its OWN authority (the Host Config section),
    // read on this same snapshot: an unavailable section is never presented as
    // the shipped default.
    const visualTools = runner.config.visualTools.read()
    const visualToolsFreshness = visualToolsFreshnessOf(visualTools, configReadiness)
    // ── C2-R3: the five Agent rows' read facts ────────────────────────────────
    // PERMISSIONS. The approval row exists only for a LIVE, still-current
    // captured scope on a backend that really reads and writes the override:
    // a Remote composition (no capability) or a sessionless surface paints no
    // approval row at all — never an `ask` the authority did not state.
    const approvalLive = approvalScope !== undefined
      && runner.isSessionScopeCurrent(approvalScope)
      && runner.config.permissions.approvalOverrideAvailable()
    const approvalOverride = approvalLive && approvalScope !== undefined
      ? runner.currentApprovalOverride(approvalScope)
      : undefined
    const approvalRow: SettingsWorkspaceRow[] = !approvalLive ? [] : [{
      id: 'approval',
      category: 'agent',
      label: 'Approval policy (this session)',
      summary: approvalOverride ?? 'not overridden',
      ...approvalOverride === undefined ? {} : { value: approvalOverride },
      scope: 'Current session only · runtime-only override',
      freshness: 'runtime',
      description: 'How tool approvals are handled in the session this workspace was opened on. '
        + 'This is the official per-session approval override, applied at the next approval the session needs; '
        + 'it is not a permission preset and it never changes the default for new sessions. '
        + 'Persisted: not applicable — current session only.',
      edit: {
        field: 'approval',
        primary: 'runtime',
        options: APPROVAL_CANDIDATES.map(value => ({
          value,
          label: value,
          available: true,
          current: approvalOverride === value,
        })),
        // The primary Value IS the runtime override (or `not overridden`); the
        // SEPARATE effect fact states what the next approval consumes, so an
        // absent override never reads as a saved `ask`.
        runtime: approvalOverride === undefined ? 'ask (consumer fallback; no session override)' : approvalOverride,
        runtimeEffect: approvalOverride === undefined
          ? 'next approval uses the consumer fallback ask (no session override)'
          : `next approval uses ${approvalOverride} (session override)`,
        persisted: 'not applicable — current session only',
      },
    }]
    // The preset roster and the effective Host default are read ONCE for this
    // snapshot: the row's candidates are the raw ids in Host order, and
    // `[current]` follows the Host's EFFECTIVE default (this port exposes no
    // separate raw USER override, and none is claimed).
    const permissionNames = [...runner.config.permissions.presetNames()]
    const defaultPermission = runner.config.permissions.defaultPreset()
    const defaultPermissionRow: SettingsWorkspaceRow[] = permissionNames.length === 0 ? [] : [{
      id: 'default-permission',
      category: 'agent',
      label: 'Default permission',
      summary: defaultPermission ?? 'unknown',
      ...defaultPermission === undefined ? {} : { value: defaultPermission },
      scope: 'DSH Host profile · permission default for new sessions',
      freshness: configReadiness === 'ready' ? 'ready' : configReadiness === 'stale' ? 'last-known' : 'unavailable',
      description: 'The permission preset a NEWLY created Session starts with. '
        + 'It applies to new sessions only: the running session keeps its current preset, sandbox and approval knobs. '
        + 'Persisted: Host permission default; the raw USER override is not independently exposed by this port.',
      edit: {
        field: 'default-permission',
        primary: 'persisted',
        // A non-ready backend cannot confirm a permission default write (the
        // writer refuses before dispatch), so it offers NO confirmable
        // candidate while keeping the row and its truthful facts.
        options: configReadiness === 'ready' ? permissionNames.map(value => ({
          value,
          label: value,
          available: true,
          current: defaultPermission === value,
        })) : [],
        runtime: 'applies to new sessions, not this session',
        persisted: defaultPermission ?? 'unknown',
      },
    }]
    // DELEGATION. BOTH rows appear together, and only while the OFFICIAL
    // section AND the model catalog are available (the existing availability
    // contract): the allowlist is the setup dependency of the toggle.
    const subagentAvailable = runner.config.subagentModelSelection.available() && runner.catalog.models.available()
    // An UNREADABLE official section is not a value: the rows are withheld
    // instead of being painted from a fabricated `off`/empty default (writing
    // that back would erase the Host's stored routes).
    const subagentSelection = subagentAvailable ? readSubagentSectionOrUndefined() : undefined
    // The section's VALUES must be current for either row to claim them: a
    // stale/unavailable backend keeps readable LAST-KNOWN values, which are
    // reported as such and can never be confirmed into a write.
    const subagentFreshness: SettingsWorkspaceFreshness = configReadiness === 'ready'
      ? 'ready'
      : configReadiness === 'stale' ? 'last-known' : 'unavailable'
    const subagentWritable = subagentFreshness === 'ready'
    const subagentRows: SettingsWorkspaceRow[] = subagentSelection === undefined ? [] : [{
      // The specialist page reaches the ONE official section through the SAME
      // serialized write queue as the toggle: this row deliberately has NO
      // `edit` (a scalar candidate list would be a second writer).
      id: 'subagent-model-allowlist',
      category: 'agent',
      label: 'Subagent allowed models',
      summary: allowlistSummary(subagentSelection.allowedModels),
      scope: 'Official subagent model-selection section',
      freshness: subagentFreshness,
      description: 'The child LLM routes the official subagent tool may pick from in a NEW session. '
        + 'Manage opens the searchable official model directory in this same workspace; every toggle writes the '
        + 'official settings section. Saved routes stay removable even when the current catalog does not list them. '
        + 'A running Agent keeps its existing tool schema. Persisted: the official subagent-model-selection section.',
      specialist: 'subagent-allowlist',
      // Only a CURRENT section may open the picker: a stale mirror would let the
      // user toggle routes that can never commit.
      specialistAvailable: subagentWritable,
    }, {
      id: 'subagent-model-selection',
      category: 'agent',
      label: 'Subagent model selection',
      summary: subagentSelection.enabled ? 'on' : 'off',
      value: subagentSelection.enabled ? 'on' : 'off',
      scope: 'Official subagent model-selection section',
      freshness: subagentFreshness,
      description: 'Whether a NEW session\'s subagent tool may pick a child provider/model from the allowed routes. '
        + 'Changes new sessions only; the running session keeps its existing tool schema. '
        + 'Enabling requires at least one allowed route; disabling keeps the saved routes. '
        + 'Persisted: the official subagent-model-selection section.',
      edit: {
        field: 'subagent-model-selection',
        primary: 'persisted',
        // A non-current backend offers NO confirmable candidate: a write built
        // from last-known values would overwrite whatever the Host changed while
        // this Client was not current.
        options: subagentWritable ? SUBAGENT_SELECTION_CANDIDATES.map(value => ({
          value,
          label: value,
          available: true,
          current: (subagentSelection.enabled ? 'on' : 'off') === value,
        })) : [],
        runtime: `${subagentSelection.allowedModels.length} allowed ${subagentSelection.allowedModels.length === 1 ? 'route' : 'routes'} · applies to new sessions`,
        persisted: subagentSelection.enabled ? 'on' : 'off',
      },
    }]
    // EXECUTION POLICY. The RAW document value is the primary fact; the
    // consumer's bypass fallback is stated separately so a missing/invalid raw
    // value is never presented as an explicitly saved `bypass`.
    const storedShellSandbox = storedCandidateFactOf(doc?.localShellSandbox, doc !== undefined, LOCAL_SHELL_SANDBOX_CANDIDATES, 'unknown')
    const shellSandboxRuntime = doc === undefined
      ? 'unknown — the next ! / !! policy cannot be read without the settings document'
      : localShellSandboxPreferenceOf(doc) === 'sandbox'
        ? 'Next ! / !! uses sandbox'
        : doc.localShellSandbox === 'bypass'
          ? 'Next ! / !! uses bypass'
          : 'Next ! / !! uses bypass (default; no valid saved value)'
    // C2-R5/C2-R6/C2-R7: Footer layout, Keyboard shortcuts and the Extensions
    // rows are same-lease pages and rows of THIS workspace; no row hands the
    // user off to a second settings editor.
    return {
      configReadiness,
      capturedAt: Date.now(),
      ...(readIssue === undefined ? {} : { readIssue }),
      extensionRevision,
      extensionCount: extensionRecords.length,
      rows: [
        {
          id: 'theme',
          category: 'appearance',
          label: 'Configured theme',
          summary: doc === undefined ? unavailableNote : themeDisplayNameOf(themeRaw, runner.extensions?.themes),
          ...(doc === undefined ? {} : { value: persistedTheme }),
          scope: 'TUI settings document',
          freshness: configuredFreshness,
          description: doc === undefined
            ? 'The palette family of the configured TUI settings document. This preview only reads the configured value.'
            : 'The palette family used by the transcript, editor and panels. The value is the source-qualified configured identity; the summary is its display name.',
          edit: themeEditOf(persistedTheme, doc !== undefined),
        },
        {
          // R1: the row is EDITABLE. Its primary fact is the live runtime style
          // (what the surface paints with right now); the persisted document
          // value stays a separate, explicitly named fact and is never replaced
          // by the normalizer's fallback.
          id: 'icon-style',
          category: 'appearance',
          label: 'Icon style',
          summary: runtimeIcon,
          value: runtimeIcon,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'The glyph vocabulary for structural icons — emoji, compact symbols, or minimal structural markers (tools, subagents, disclosures). '
            + 'The live style applies immediately; the persisted preference may still differ until a write is verified.',
          edit: persistedPreferenceEditOf(
            'icon-style',
            runtimeIcon,
            ICON_STYLE_CANDIDATES,
            iconRaw,
            doc !== undefined,
          ),
        },
        {
          // C2-R5: PERSIST-FIRST. The document's raw `footer` is the authority;
          // `command` is a USER opt-in whose live surface is the persisted
          // fallback, so it is reported as `command (manual)` and is never a
          // confirmable candidate. A non-current/unreadable document offers NO
          // candidate at all.
          id: 'footer-mode',
          category: 'appearance',
          label: 'Status line mode',
          summary: storedFooterMode,
          ...doc === undefined || doc.footer === undefined ? {} : { value: doc.footer },
          scope: 'TUI settings document · Footer runtime',
          freshness: configuredFreshness,
          description: 'Which footer THIS Client paints: Default (two rows), Compact (one row), or Custom (the saved layout). '
            + 'A stored command-mode footer is reported as command (manual) and is never offered as a candidate here. '
            + 'Confirm stores the mode and its restart fallback first, then applies it to the live footer.',
          edit: {
            ...persistedOnlyEditOf(
              'footer-mode',
              FOOTER_MODE_CANDIDATES,
              doc?.footer,
              doc !== undefined,
              footerFallbackFact,
              storedFooterMode,
            ),
            ...configuredFreshness === 'ready' ? {} : { options: [] },
          },
        },
        {
          // C2-R5: the ONE full-screen Footer layout editor. It is a same-lease
          // specialist page (never a second overlay); the row carries no `edit`
          // because the page owns its own model, draft and explicit Save.
          id: 'footer-configurator',
          category: 'appearance',
          label: 'Configure footer layout…',
          summary: footerSurfaceSummary,
          scope: 'Footer runtime · TUI settings document',
          freshness: 'runtime',
          description: 'Open the full-screen footer layout editor: row selector, item/zone/style editors, custom text/command '
            + 'definitions and a live draft preview. Save writes the SAME TUI settings document first and then applies the '
            + 'layout to the running footer; a failed save keeps the draft and changes nothing. The preview never executes a draft command.',
          specialist: 'footer-configurator',
          // The runtime-only path (no settings service) is still a real editor:
          // it states `Not persisted (session only)` instead of pretending to save.
          specialistAvailable: doc !== undefined || runner.tuiSettings === undefined,
        },
        {
          id: 'display-preset',
          category: 'conversation',
          label: 'Transcript display',
          summary: runtimePreset,
          value: runtimePreset,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: `The Client's live transcript display preset. ${persistedNote}`,
          edit: displayEditOf(persistedPreset, doc !== undefined),
        },
        {
          // R1: runtime-only disclosure — the Ctrl+O master switch. There is no
          // settings-document field behind it (it only changes the TUI runtime),
          // so the Detail says so instead of implying a save.
          id: 'expand',
          category: 'conversation',
          label: 'Transcript detail',
          summary: expand,
          value: expand,
          scope: 'Current TUI display state',
          freshness: 'runtime',
          description: 'Bulk expansion for recent collapsible transcript content. '
            + `A Client-local display state shared with ${keyHint('app.transcript.toggleExpand')} — `
            + 'it is not persisted to the TUI settings document.',
          edit: disclosureEditOf('expand', expand),
        },
        {
          id: 'thinking',
          category: 'conversation',
          label: 'Thinking detail',
          summary: thinking,
          value: thinking,
          scope: 'Current TUI display state',
          freshness: 'runtime',
          description: 'Whether reasoning blocks render expanded or collapsed. '
            + `A Client runtime presentation preference shared with ${keyHint('app.transcript.toggleThinking')}; `
            + 'not a persisted Host value.',
          edit: disclosureEditOf('thinking', thinking),
        },
        {
          // R1: apply-first + persisted. The live cadence is read from the ONE
          // shared prompt-state object the Agent's prompt provider reads.
          id: 'progress-updates',
          category: 'conversation',
          label: 'Progress updates',
          summary: runtimeProgress,
          value: runtimeProgress,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'How often the agent narrates its work: Off (no progress narration), Milestones (one update per completed phase), '
            + 'or Frequent (updates as meaningful findings settle). Focus suppresses the effective narration without changing the selected cadence.',
          edit: persistedPreferenceEditOf(
            'progress-updates',
            runtimeProgress,
            PROGRESS_UPDATES_CANDIDATES,
            progressRaw,
            doc !== undefined,
          ),
        },
        {
          // R1: apply-first + persisted. Independent of progress updates: this
          // axis shapes the visible answer, not the work narration.
          id: 'response-style',
          category: 'conversation',
          label: 'Response style',
          summary: runtimeResponse,
          value: runtimeResponse,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'The density and explanation depth of visible answers: Default, Concise (result-first, no filler), '
            + 'or Explanatory (rationale, constraints and tradeoffs). Independent of Progress updates.',
          edit: persistedPreferenceEditOf(
            'response-style',
            runtimeResponse,
            RESPONSE_STYLE_CANDIDATES,
            responseRaw,
            doc !== undefined,
          ),
        },
        {
          // C2-R2: PERSIST-FIRST. The document is the authority; the consumer
          // (`SettingsRuntime.busyEnter()`) reads the SAME field at the next
          // busy Enter, so `Value` reports the stored fact and `Runtime` states
          // the policy that next read will produce.
          id: 'busy-enter',
          category: 'conversation',
          label: 'Submit while busy',
          summary: storedBusyEnter,
          ...doc === undefined || doc.busyEnter === undefined ? {} : { value: doc.busyEnter },
          scope: 'TUI settings document · input preference',
          freshness: configuredFreshness,
          description: 'What a plain Enter does while the agent is running: Queue adds the draft to the turn queue, '
            + 'Steer injects it into the running turn. The choice is stored in the TUI settings document and is used by the NEXT busy Enter; '
            + 'it never rewrites a turn that is already running.',
          edit: persistedOnlyEditOf(
            'busy-enter',
            BUSY_ENTER_CANDIDATES,
            doc?.busyEnter,
            doc !== undefined,
            busyEnterRuntime,
            storedBusyEnter,
          ),
        },
        {
          // C2-R2: APPLY-FIRST. The ONE `gitAttributionState` object the
          // registered `tui:git-attribution` SystemPrompt section reads.
          id: 'git-attribution',
          category: 'conversation',
          label: 'Git attribution',
          summary: runtimeGitAttribution,
          value: runtimeGitAttribution,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'Prompt guidance for Git commits the Agent creates: Off, Product (the official Co-Authored-By trailer), '
            + 'or Product + model (also Assisted-By provider/model). Guidance only — no Git hooks and no automatic commit edits; '
            + 'presets with a complete persona (minimal) receive no TUI prompt guidance.',
          edit: persistedPreferenceEditOf(
            'git-attribution',
            runtimeGitAttribution,
            GIT_ATTRIBUTION_CANDIDATES,
            doc?.gitAttribution,
            doc !== undefined,
          ),
        },
        {
          // C2-R2: APPLY-FIRST. The live fact is the chord the keymap really
          // resolves (`applyHomeEndKeyMode` is the ONE writer).
          id: 'home-end-keys',
          category: 'input-terminal',
          label: 'Home/End keys',
          summary: runtimeHomeEnd,
          value: runtimeHomeEnd,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'Input: Home/End move within the input; Ctrl+Home/End scroll the conversation. '
            + 'Viewport: Home/End scroll the conversation; Ctrl+Home/End move within the input.',
          edit: persistedPreferenceEditOf(
            'home-end-keys',
            runtimeHomeEnd,
            HOME_END_CANDIDATES,
            doc?.homeEndKeys,
            doc !== undefined,
          ),
        },
        {
          // C2-R2: PERSIST-FIRST. The stored preference is the authority; the
          // physical switch happens only after this workspace closes normally
          // (`Runtime` names the paused transcript mode it will leave from).
          id: 'fullscreen',
          category: 'input-terminal',
          label: 'Fullscreen',
          summary: storedFullscreen,
          ...doc === undefined || doc.fullscreen === undefined ? {} : { value: doc.fullscreen },
          scope: 'TUI settings document · Client screen mode',
          freshness: configuredFreshness,
          description: 'Save preference, then leave Settings normally to switch the transcript screen. '
            + 'The Settings workspace itself stays mounted until you leave.',
          edit: persistedOnlyEditOf(
            'fullscreen',
            FULLSCREEN_CANDIDATES,
            doc?.fullscreen,
            doc !== undefined,
            `Current transcript mode: ${app.isFullscreen() ? 'on' : 'off'} (Settings lease is separate); applied after normal Settings close`,
            storedFullscreen,
          ),
        },
        {
          // C2-R2: APPLY-FIRST to the NEXT alt-screen mount only. The mounted
          // fullscreen viewport keeps its constructor-time step.
          id: 'wheel-scroll-lines',
          category: 'input-terminal',
          label: 'Mouse wheel lines',
          summary: runtimeWheel,
          value: runtimeWheel,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'Number of transcript lines moved per mouse-wheel event in fullscreen. '
            + 'Applies on the next fullscreen entry; the existing fullscreen viewport keeps its constructor-time step.',
          edit: persistedPreferenceEditOf(
            'wheel-scroll-lines',
            String(app.currentWheelScrollLines()),
            WHEEL_SCROLL_LINE_VALUES,
            doc?.wheelScrollLines,
            doc !== undefined,
          ),
        },
        {
          // C2-R2: APPLY-FIRST. The ONE completion controller's own mode.
          id: 'notification-mode',
          category: 'input-terminal',
          label: 'Notifications',
          summary: runtimeNotificationMode,
          value: runtimeNotificationMode,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'When to notify that the main agent finished: Unfocused — only while the terminal is not focused; '
            + 'Always — whenever the main agent settles; Off — disable completion notifications.',
          edit: persistedPreferenceEditOf(
            'notification-mode',
            runtimeNotificationMode,
            NOTIFICATION_MODE_CANDIDATES,
            doc?.notificationMode,
            doc !== undefined,
          ),
        },
        {
          // C2-R2: APPLY-FIRST. Same controller, delivery axis only.
          id: 'notification-method',
          category: 'input-terminal',
          label: 'Notification method',
          summary: runtimeNotificationMethod,
          value: runtimeNotificationMethod,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'How the completion notification is delivered: Auto — OSC 9 / OSC 777 / bell by terminal; '
            + 'OSC 9; OSC 777; Bell. Changing the method never emits a notification by itself.',
          edit: persistedPreferenceEditOf(
            'notification-method',
            runtimeNotificationMethod,
            NOTIFICATION_METHOD_CANDIDATES,
            doc?.notificationMethod,
            doc !== undefined,
          ),
        },
        {
          // C2-R2: APPLY-FIRST. The terminal-native projection only; the Agent
          // narration cadence (Progress updates) is a separate field.
          id: 'terminal-progress',
          category: 'input-terminal',
          label: 'Terminal progress',
          summary: runtimeTerminalProgress,
          value: runtimeTerminalProgress,
          scope: 'Client runtime · optional TUI preference persistence',
          freshness: 'runtime',
          description: 'Native terminal status: 9;4+7501 reports both the OSC 9;4 progress bar and the OSC 7501 semantic state; '
            + '9;4 reports only the progress bar; 7501 reports only the semantic state; Off clears and suppresses both.',
          edit: persistedPreferenceEditOf(
            'terminal-progress',
            runtimeTerminalProgress,
            TERMINAL_PROGRESS_CANDIDATES,
            doc?.terminalProgress,
            doc !== undefined,
          ),
        },
        {
          // C2-R5: the ONE full-screen Keyboard shortcuts page. Its summary is
          // the SAME controller's own projection; the page is a same-lease
          // specialist, never the old 88-column overlay and never a second
          // keymap store.
          id: 'keyboard-shortcuts',
          category: 'input-terminal',
          label: 'Keyboard shortcuts…',
          summary: keybindingModel?.summary ?? 'Unavailable',
          scope: 'Client keymap · TUI settings document',
          freshness: configuredFreshness,
          description: 'Open the full-screen keyboard shortcuts editor: search every action by name, description or key, '
            + 'open an action detail, record a direct or leader-completion binding, reset one action or the leader key, '
            + 'and see conflicts or safe mode. Changes write the TUI settings document and apply to the running keymap. '
            + 'Read-only when the settings document cannot be read; writes are refused while the configuration is not current.',
          specialist: 'keybindings',
          specialistAvailable: keybindingModel !== undefined,
        },
        // ── C2-R3: the Agent category's five real rows, in their FROZEN order
        //    (the detail descriptions keep the Permissions / Delegation /
        //    Execution policy grouping without adding focusable section rows).
        //    Each row reaches EXACTLY its own authority: a session-scoped
        //    official approval override, the Host permission default, the ONE
        //    official subagent model-selection section (twice) and the raw TUI
        //    settings document field.
        ...approvalRow,
        ...defaultPermissionRow,
        ...subagentRows,
        {
          // The TUI-document field is the authority; the consumer
          // (`user-shell.ts` → `localShellSandboxPreferenceOf`) reads the SAME
          // raw value at the next `!`/`!!`. The consumer's bypass fallback is
          // stated as the runtime effect, never as a stored value.
          id: 'local-shell-sandbox',
          category: 'agent',
          label: 'User shell sandbox policy',
          summary: storedShellSandbox,
          ...doc === undefined || doc.localShellSandbox === undefined ? {} : { value: doc.localShellSandbox },
          scope: 'TUI settings document · Host user-shell execution policy',
          freshness: configuredFreshness,
          description: 'How Host-side user-shell execution runs your own ! / !! commands: '
            + 'Bypass runs them outside the dsh sandbox (the default when nothing is stored), Sandbox runs them '
            + 'under the DSH shell policy the Host really provides. This is the Host execution policy of the user '
            + 'shell, not the model\'s tool sandbox policy and not a permission preset. The next ! / !! uses it.',
          // The persist-first writer refuses on a non-ready backend or an
          // unreadable document, so the row offers NO confirmable candidate in
          // those states while still reporting the raw stored fact.
          edit: {
            ...persistedOnlyEditOf(
              'local-shell-sandbox',
              LOCAL_SHELL_SANDBOX_CANDIDATES,
              doc?.localShellSandbox,
              doc !== undefined,
              shellSandboxRuntime,
              storedShellSandbox,
            ),
            ...configuredFreshness === 'ready' ? {} : { options: [] },
          },
        },
        {
          // The ONE built-in Visual tools switch: a Host-profile setting, not a
          // TUI preference. The row stays visible when the authority is
          // unavailable (the category exists), but `edit.options` is empty in
          // that case, so no Confirm can be painted or dispatched.
          id: 'visual-tools',
          category: 'tools',
          label: 'Visual tools',
          summary: visualToolsSummaryOf(visualTools),
          scope: 'DSH Host profile · every agent on this Host',
          freshness: visualToolsFreshness,
          description: 'Enable the built-in Chart and SVG tools for this DSH profile. '
            + 'Affects every agent using this Host profile, not just the TUI.',
          edit: visualToolsEditOf(visualTools, configReadiness),
        },
        {
          // C2-R4: the ONE discoverable entry to the Web provider settings
          // page. It opens the embedded `WebSettingsPage` in THIS workspace's
          // lease/body (the same specialist mechanism the Agent allowlist row
          // uses) — never a second overlay. The row
          // deliberately carries NO `edit`: its six fields are written by the
          // page's own explicit confirms, not by a scalar workspace candidate.
          id: WEB_LAUNCHER_ROW_ID,
          category: 'tools',
          label: WEB_SETTINGS_PAGE_TITLE,
          ...webWorkspaceRowFacts(),
          scope: 'Host Web provider settings',
          specialist: 'web-settings',
        },
        // C2-R6: the registry's live directory IS the row list. Every record is
        // projected in the Registry's own global order (order ASC, id ASC); the
        // command layer never groups or re-sorts, because the plugin GROUPS are
        // a display projection the workspace derives from `extensionOwner`.
        // Without a live row there is no Extensions category at all (the panel
        // derives it from `extensionCount`), so no empty page can be painted.
        ...extensionRecords.map(record => {
          const id = `ext-setting:${record.id}` as const
          const choices = record.values
          return {
            id,
            category: 'extensions' as const,
            label: record.label,
            summary: record.currentValue,
            value: record.currentValue,
            scope: `Extension runtime · ${record.owner}`,
            // Read from this process's registry, so it never inherits the TUI
            // document's readiness: the registration is either live or absent.
            freshness: 'runtime' as const,
            description: `Registered at runtime by ${record.owner} (id ${record.id}). `
              + (choices.length === 0
                ? 'This setting registered no selectable values, so Settings shows it read-only. '
                : 'Choosing a value applies it to the running extension. ')
              + 'The value is read live from the in-process extension settings registry; it is not stored in the TUI settings document.',
            extensionOwner: record.owner,
            extensionRegistrationToken: record.registrationToken,
            // A registration with NO selectable values is READ-ONLY: the Stable
            // contribution has no freeform text field, and `onChange` existing
            // never authorizes inventing one. The token above rides the ROW only
            // (never the edit), so there is ONE registration snapshot field.
            ...choices.length === 0 ? {} : {
              edit: {
                field: id,
                primary: 'runtime' as const,
                options: choices.map(choice => ({
                  value: choice,
                  label: choice,
                  available: true,
                  current: choice === record.currentValue,
                })),
                runtime: record.currentValue,
                persisted: 'Not applicable · extension runtime',
              },
            },
          }
        }),
      ],
    }
  }

  /**
   * `/settings` — enter the readonly fullscreen Settings workspace. It is the
   * ONE settings surface: every migrated row, the Web page, the Extensions rows
   * and the specialist pages are edited in this same lease, and no retired
   * complete editor is reachable from it. `/status` is its real alias.
   */
  const registerSettings = (): void => {
    // C5: `/status` is a REAL alias of `/settings` — the same handler, same
    // workspace, same initial About focus. It is not a second command: the
    // alias registers through the shared `registerTuiCommand` seam, so the
    // Host compatibility mirror, completion catalog and busy gate all see
    // both names while this registrar remains the ONLY registration site.
    registerTuiCommand({
      name: 'settings',
      description: 'Open the TUI settings workspace',
      aliases: ['status'],
      aliasDescriptions: {
        status: 'Show the Settings About and Session status (alias of /settings)',
      },
      handler: () => {
        // The workspace paints immediately (its Web row starts at `Loading…`);
        // the Host Web read then refreshes THAT panel generation (§B3.4).
        openSettingsWorkspaceAt()
        return { kind: 'success' }
      },
    })
  }

    // `/footer` — the interactive footer configurator (plan M3): LOCAL +
    // SESSIONLESS (usable before any session exists — the preview shows
    // placeholders/unavailable items and the config stays editable). The
    // panel is a hierarchical editor; the save paths (S, the "Save changes"
    // row, "Save & Exit") validate + persist + apply through ONE awaited
    // onSave — the overlay closes only on success (PR E). Enter is a
    // navigation key, and Esc walks back page by page: a clean selector
    // closes without touching the active layout, a dirty one asks first.
    //
    // `/statusline` is a deliberate alias (approved): other agents (and
    // users coming from tools that name this surface "statusline") reach
    // the SAME configurator through it. The name is a PREFIX-neighbor of
    // `/status` — the AGENTS near-synonym rule usually forbids that, and it
    // stays forbidden for NEW independent commands — but all three are
    // EXPLICIT aliases: `/status` is the `/settings` alias (About/Session
    // status) and `/statusline` is the `/footer` alias, so the pairing is
    // unambiguous. The completion catalog marks both aliases. The alias
    // rides the same LOCAL/SESSIONLESS ownership sets, so it never steers
    // while busy.
  /**
   * C2-R5: build the ONE same-lease Footer layout page. The model/catalog/
   * composer composition is the command-owned one the old `/footer` handler
   * used; the app supplies only its live preview dependencies and mounts the
   * panel inside the already-leased Settings body. The save chain is the SAME
   * persist-first transaction: validate the draft, re-read the USER raw layer at
   * the queue head, replace the document, apply the runtime ONLY from the
   * completed write, then close through `done`.
   */
  function createFooterWorkspacePage(
    done: () => void,
    _onAuthoritativeChange: () => void,
  ): import('../panels/settings-workspace-panel.ts').EmbeddedSpecialistPage | undefined {
    const settings = runner.tuiSettings
    let doc: TuiSettingsDoc | undefined
    if (settings !== undefined) {
      try {
        doc = settings.get()
      } catch (error) {
        runner.diag.warn('footer configurator read', { error: safeErrorMessage(error) })
        return undefined
      }
    }
    const sessionOnly = settings === undefined
    // The page starts from the CURRENT EFFECTIVE layout: the persisted custom
    // layout when active, else whatever the composer renders right now —
    // getEffectiveFooterLayout() maps the active MODE (default/compact/custom).
    // Keeping the compact mode here is what stops an unchanged save from
    // silently becoming the full two-row default.
    const persisted = doc !== undefined && doc.footer === 'custom' ? parseFooterLayout(doc.footerLayout) : undefined
    const initial = persisted !== undefined && isFooterLayout(persisted)
      ? persisted
      : app.getEffectiveFooterLayout()
    // Layer the draft catalog over the live app registry. Unsaved create / edit /
    // rename / delete operations stay inside this catalog, so Esc cannot mutate
    // the active footer or its persisted definitions.
    const registry = new FooterItemRegistry(app.getFooterItemRegistry())
    const customItems = new FooterCustomItemCatalog(app.getFooterCustomItems())
    // PR D preview contract: the preview NEVER executes a command. A draft
    // command item shows the committed cache ONLY while its definition is
    // unchanged, and the dim `[command]` placeholder otherwise.
    customItems.setCommandValueSource({
      value: (id) => {
        const draft = customItems.get(id)
        if (draft === undefined || draft.kind !== 'command') return undefined
        const committed = app.getFooterCustomItems().find(item => item.id === id)
        if (committed === undefined || !sameFooterCustomItem(draft, committed)) return { kind: 'placeholder' }
        const text = app.getFooterCommandItemValue(id)
        return text === undefined ? { kind: 'placeholder' } : { kind: 'value', text }
      },
    })
    registry.setCustomSource(customItems)
    const composer = new FooterComposer(registry)
    const model = new FooterConfiguratorModel(initial, registry, customItems)
    let page: ReturnType<TuiApp['createFooterConfiguratorPanel']> | undefined
    page = app.createFooterConfiguratorPanel({
      model,
      registry,
      composer,
      sessionOnly,
      onSave: async (layout, draftCustomItems) => {
        // RESOLVE = persisted/ session-applied AND the runtime applied (the page
        // then closes); THROW = failed — the page stays open with the draft intact,
        // and THIS layer owns the user-facing notify.
        const parsed = parseFooterLayout(layout)
        if (!isFooterLayout(parsed)) {
          app.notify(`footer layout invalid: ${parsed.message}`, 'error')
          throw new Error(`footer layout invalid: ${parsed.message}`)
        }
        const customResult = parseFooterCustomItems(draftCustomItems ?? [])
        if (customResult.invalidCount > 0 || customResult.items.length !== (draftCustomItems ?? []).length) {
          app.notify('custom footer items invalid', 'error')
          throw new Error('custom footer items invalid')
        }
        const savedCustomItems = customResult.items.map(item => ({ ...item }))
        if (sessionOnly) {
          // No settings backend: the memory commit IS the save (PR E §9.3), and
          // the page states `Not persisted (session only)` rather than claiming a
          // document write.
          if (app.isDisposed()) return
          app.setFooterCustomItems(savedCustomItems)
          runner.applyFooterSettings({ footer: 'custom', footerLayout: parsed, footerCustomItems: savedCustomItems }, savedCustomItems)
          if (page === undefined || page.isDisposed()) return
          app.notify('footer layout saved for this session only', 'info')
          done()
          return
        }
        const currentSettings = runner.tuiSettings
        if (currentSettings === undefined) throw new Error('settings service unavailable')
        try {
          await serializeTuiSettingsMutation(currentSettings, async () => {
            if (app.isDisposed()) return
            // `/footer` intentionally edits the custom-definition collection,
            // but it only owns the v1 text entries this client understands.
            // Re-read the detached USER value at the commit point so queued saves
            // do not erase intervening future data.
            const raw = runner.config.footerCustomItems.rawForPersistence()
            if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
            const persistedCustomItems = mergeFooterCustomItemsForSave(raw.value, savedCustomItems)
            await currentSettings.replace({
              ...currentSettings.get(),
              footer: 'custom',
              footerFallbackMode: 'custom',
              footerLayout: parsed,
              footerCustomItems: persistedCustomItems,
            })
          })
        } catch (error) {
          // A failed write changed nothing: the notice states the failure to
          // the still-running app even when the page that started it is gone.
          if (!app.isDisposed()) {
            app.notify(`footer layout save failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          }
          throw error
        }
        if (app.isDisposed()) return
        // The DOCUMENT write succeeded, so the runtime must follow the authority
        // even when the page that started the save was torn down meanwhile
        // (forced workspace close, a question/approval takeover). The page
        // lifetime fences the page's OWN UI (notify + return), never the
        // business transaction this command owns.
        app.setFooterCustomItems(savedCustomItems)
        runner.applyFooterSettings({ footer: 'custom', footerLayout: parsed, footerCustomItems: savedCustomItems }, savedCustomItems)
        if (page === undefined || page.isDisposed()) return
        app.notify('footer layout saved', 'info')
        done()
      },
      onCancel: () => {
        // Clean Save / Discard & Exit / Esc: close WITHOUT writing. The live
        // preview never touched the active layout.
        done()
      },
    })
    return page
  }

  /** C2-R5: build the ONE same-lease Keyboard shortcuts page over the EXISTING
   *  `createKeybindingEditorPanel` (the same controller/projector/recorder). A
   *  successful mutation refreshes the row summary from the controller's own
   *  read; `done` returns to the Input & Terminal row. */
  function createKeybindingsWorkspacePage(
    done: () => void,
    onAuthoritativeChange: () => void,
  ): import('../panels/settings-workspace-panel.ts').EmbeddedSpecialistPage | undefined {
    return createKeybindingEditorPanel(done, () => { onAuthoritativeChange() })
  }

  const registerFooter = (): void => {
    registerTuiCommand({
      name: 'footer',
      description: 'Configure the footer layout interactively',
      aliases: ['statusline'],
      handler: async () => {
        // C2-R5: `/footer` (and its `/statusline` alias) is a TYPED DEEPLINK into
        // the ONE fullscreen Settings workspace — never a second overlay. A
        // present-but-unreadable document is a real command error, not a fake page.
        const settings = runner.tuiSettings
        if (settings !== undefined) {
          try {
            settings.get()
          } catch (error) {
            return { kind: 'error', text: `could not open the footer layout editor: ${safeErrorMessage(error)}` } as CommandResult
          }
        }
        let handle: import('../../tui-app.ts').SettingsWorkspaceHandle
        try {
          handle = openSettingsWorkspaceWith({
            initialRowId: 'footer-configurator',
            initialSpecialist: 'footer-configurator',
          })
        } catch (error) {
          return { kind: 'error', text: `could not open the settings workspace: ${safeErrorMessage(error)}` } as CommandResult
        }
        const settlement = await handle.whenInitialSpecialistSettled()
        if (!settlement.ok) {
          handle.close()
          return { kind: 'error', text: `could not open the footer layout editor: ${settlement.reason}` } as CommandResult
        }
        return { kind: 'success' }
      },
    })

    // `/display` is the canonical LOCAL + SESSIONLESS display control. It is
    // usable before the first session and every mutation goes through the
    // runner's canonical setter.
  }
  const registerDisplay = (): void => {
    registerOne({
      name: 'display',
      description: 'Set the transcript display preset',
      input: { hint: '[full|focus|compact|status]' },
      handler: (invocation) => {
        const verb = invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        const report = (text: string): { kind: 'success'; text: string } => {
          app.notify(text, 'info')
          return { kind: 'success', text }
        }
        if (verb === '' || verb === 'status') return report(`Display: ${displayPresetOf(runner)}.`)
        if (verb === 'full' || verb === 'focus' || verb === 'compact') {
          const result = applyDisplayPreset(runner, verb)
          if (result.kind === 'unsupported') return { kind: 'error', text: `Display preset "${verb}" is not available in this build.` }
          return report(`Display: ${verb}.`)
        }
        return { kind: 'error', text: `unknown /display verb "${verb}" (full|focus|compact|status)` }
      },
    })

    // `/focus` is the compatibility adapter over the canonical display state.
  }
  const registerFocus = (): void => {
    registerOne({
      name: 'focus',
      description: 'Toggle Focus display (intermediate activity folds into a live Thought block)',
      input: { hint: '[on|off|toggle|status]' },
      handler: (invocation) => {
        const verb = invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        const enabled = displayPresetOf(runner) === 'focus'
        // The command feedback is a transient notify (the same pattern as
        // /reload): a sessionless local command writes no command/done card,
        // so the success text must be surfaced HERE or the toggle would be
        // silent.
        const report = (text: string): { kind: 'success'; text: string } => {
          app.notify(text, 'info')
          return { kind: 'success', text }
        }
        if (verb === '' || verb === 'toggle') {
          applyDisplayPreset(runner, enabled ? 'full' : 'focus')
          return report(`Focus mode ${enabled ? 'off' : 'on'}.`)
        }
        if (verb === 'on') {
          if (enabled) return report('Focus mode is on.')
          applyDisplayPreset(runner, 'focus')
          return report('Focus mode on.')
        }
        if (verb === 'off') {
          if (displayPresetOf(runner) === 'full') return report('Focus mode is off.')
          applyDisplayPreset(runner, 'full')
          return report('Focus mode off.')
        }
        if (verb === 'status') {
          return report(`Focus mode is ${enabled ? 'on' : 'off'}.`)
        }
        return { kind: 'error', text: `unknown /focus verb "${verb}" (on|off|toggle|status)` }
      },
    })
  }
  const registerKeybindings = (): void => {
    registerOne({
      name: 'keybindings',
      description: 'Edit keyboard shortcuts (conflicts / reload / reset)',
      input: { hint: '[conflicts|reload|reset]' },
      handler: async (invocation) => {
        const verb = invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        const keybindings = app.keybindingsManager()
        if (verb === 'conflicts') {
          const conflicts = keybindings.snapshot().conflicts
          if (conflicts.length === 0) {
            app.notify('No keybinding conflicts.', 'info')
            return { kind: 'success', text: 'No keybinding conflicts.' }
          }
          const rows: SettingItem[] = conflicts.flatMap(conflict => [{
            id: `conflict-${conflict.key}`,
            label: color.warning(formatKeyId(conflict.key)),
            description: conflict.actions
              .map(entry => `${entry.action} (${entry.scope}, ${entry.source})`)
              .join('  vs  '),
            currentValue: 'conflict',
          }])
          app.openSettings(rows, () => {}, () => {})
          return { kind: 'success' }
        }
        if (verb === 'reload') {
          const settings = runner.tuiSettings
          // The reload seam needs a settings document (review round 35:
          // without the backend, "reading the defaults" would be a lie —
          // mirror /keybindings reset's explicit refusal so a degraded /
          // Remote backend cannot misrepresent an absent settings service
          // as a successful defaults read).
          if (settings === undefined) return { kind: 'error', text: 'settings service unavailable' }
          // Re-validate the settings document and rebuild the keymap
          // (fail-soft: bad entries are diagnostics, never a crash). Failures
          // are two distinct classes: a READ/PARSE failure (settings.get() or
          // parseUserKeybindings) leaves the previous keymap intact — the
          // last-known-good configuration stays active — whereas a throw
          // AFTER the rebuild (the post-rebuild UI invalidation — the
          // rebuild is keymap-first, invalidate-last) leaves the NEW keymap
          // active, so the diagnostic must not claim a rollback either.
          // Neither class may throw out of the handler
          // (review round 28: reload is now the ONLY reload seam, so its
          // fail-soft contract must match the startup application).
          return serializeTuiSettingsMutation(settings, (): CommandResult => {
            try {
              const parsed = parseUserKeybindings(settings.get().keybindings)
              for (const message of parsed.diagnostics) runner.diag.warn('keybindings', { message })
              keybindings.setUserConfiguration(parsed)
            } catch (error: unknown) {
              const message = safeErrorMessage(error)
              runner.diag.warn('keybindings', { error: message, message: 'keybindings reload failed — the error may come from the post-rebuild UI invalidation, so the keymap may already be rebuilt' })
              app.notify(`keybindings reload failed: ${message}`, 'error')
              return { kind: 'error', text: `keybindings reload failed: ${message}` }
            }
            app.notify('Keybindings reloaded.', 'info')
            return { kind: 'success', text: 'Keybindings reloaded.' }
          })
        }
        if (verb === 'reset') {
          const settings = runner.tuiSettings
          if (settings === undefined) return { kind: 'error', text: 'settings service unavailable' }
          // The whole reset is guarded — INCLUDING the initial read (review
          // round 30): a throwing first `get()` must not escape the handler;
          // it reports an error and the running keymap stays untouched.
          return serializeTuiSettingsMutation(settings, async (): Promise<CommandResult> => {
            try {
              // The outer serializeTuiSettingsMutation call owns the whole
              // transaction. Read and build the reset document only after all
              // earlier footer/focus/fullscreen writes have settled, then
              // persist it as the single next whole-document commit point.
              const doc = { ...withUserFooterCustomItems(settings.get(), runner.config) } as Record<string, unknown>
              delete doc.keybindings
              // Await the persistence write: the command result reflects the
              // ACTUAL outcome (a failed write must not report success — review
              // finding). The handler may return a Promise<CommandResult>.
              // NOTE (review round 35): after a successful write there is
              // deliberately NO second `settings.get()`. The reset doc is
              // already the canonical projection (the `keybindings` field was
              // deleted above), so the runtime is rebuilt from THAT local
              // state — `parseUserKeybindings(doc.keybindings)` — never from
              // a second Host read. A post-write read could fail (leaving the
              // disk reset but the runtime claiming "reset failed"), and a
              // Remote adapter must not be a GET → PUT → GET round trip:
              // reset is write + local projection.
              await settings.replace(doc as unknown as import('../../runtime/config-port.ts').TuiSettingsDoc)
              // Apply the cleared configuration NOW: with the automatic
              // settings watch removed (review round 28 — the reload seam is
              // explicit), a reset that only persisted would leave the
              // RUNNING keymap with the old overrides until a manual
              // /keybindings reload. The reset is a full reset: persist AND
              // rebuild from the cleared document.
              const parsed = parseUserKeybindings(doc.keybindings)
              for (const message of parsed.diagnostics) runner.diag.warn('keybindings', { message })
              keybindings.setUserConfiguration(parsed)
              app.notify('Keybindings reset to defaults.', 'info')
              return { kind: 'success', text: 'Keybindings reset to defaults.' }
            } catch (error: unknown) {
              const message = safeErrorMessage(error)
              runner.diag.warn('keybindings', { error: message })
              app.notify(`keybindings reset failed: ${message}`, 'error')
              return { kind: 'error', text: `keybindings reset failed: ${message}` }
            }
          })
        }
        // C2-R5: bare /keybindings is a TYPED DEEPLINK into the SAME full-screen
        // Settings keyboard shortcuts page. A missing/unreadable settings document
        // is a real command error — no fake page and no legacy overlay. The
        // controller is constructed ONLY by the page factory on the leased first
        // paint; this preflight only proves the document is readable NOW, and the
        // settlement below closes the workspace and reports a real error if the
        // later authoritative read refuses.
        const settings = runner.tuiSettings
        if (settings === undefined) return { kind: 'error', text: 'settings service unavailable' }
        try {
          settings.get()
        } catch (error) {
          return { kind: 'error', text: `could not open keyboard shortcuts: ${safeErrorMessage(error)}` }
        }
        let handle: import('../../tui-app.ts').SettingsWorkspaceHandle
        try {
          handle = openSettingsWorkspaceWith({
            initialRowId: 'keyboard-shortcuts',
            initialSpecialist: 'keybindings',
          })
        } catch (error) {
          return { kind: 'error', text: `could not open the settings workspace: ${safeErrorMessage(error)}` }
        }
        const settlement = await handle.whenInitialSpecialistSettled()
        if (!settlement.ok) {
          handle.close()
          return { kind: 'error', text: `could not open keyboard shortcuts: ${settlement.reason}` }
        }
        return { kind: 'success' }
      },
    })
  }
  /** The ONE `/login` / `/logout` navigation entry. It maps the shared
   *  semantic destination onto the Settings workspace; no credential write is
   *  performed here. */
  /**
   * `/plugins` deep link: the ONE Settings lease, `Plugins` selected and the
   * keyboard on the Plugin List. No About read is started here (the panel's
   * About entry hook owns the real entry when the user browses About later) and
   * no separate Plugin screen is ever leased.
   */
  const openPluginsWorkspace = (): CommandResult => {
    if ((app as unknown as import('../../tui-app.ts').TuiApp | undefined) === undefined) {
      return {
        kind: 'error',
        text: 'the Settings Plugins workspace is not available in this renderer',
      }
    }
    try {
      openSettingsWorkspaceWith({ initialCategory: 'plugins' })
    } catch (error) {
      return {
        kind: 'error',
        text: `could not open the settings workspace: ${safeErrorMessage(error)}`,
      }
    }
    return { kind: 'success' }
  }

  const openAuthWorkspace = (destination: AuthDestination): CommandResult => {
    if (destination.kind === 'error') return { kind: 'error', text: destination.message }
    if ((app as unknown as import('../../tui-app.ts').TuiApp | undefined) === undefined) {
      return {
        kind: 'error',
        text: 'the Settings Models/Account workspace is not available in this renderer',
      }
    }
    try {
      if (destination.kind === 'account') {
        openSettingsWorkspaceWith({
          initialCategory: 'account',
          initialAccountView: { view: destination.view },
        })
      } else {
        openSettingsWorkspaceWith({
          initialCategory: 'models',
          initialModelsView: modelsInitialOf(destination),
        })
      }
    } catch (error) {
      return {
        kind: 'error',
        text: `could not open the settings workspace: ${safeErrorMessage(error)}`,
      }
    }
    return { kind: 'success' }
  }

  return {
    registerSettings,
    registerFooter,
    registerDisplay,
    registerFocus,
    registerKeybindings,
    openAuthWorkspace,
    openPluginsWorkspace,
  }
}

/** Map one resolved Models destination onto the page's initial view. */
function modelsInitialOf(destination: Exclude<AuthDestination, { kind: 'account' } | { kind: 'error' }>): ModelsInitialView {
  switch (destination.view) {
    case 'list': return { view: 'list' }
    case 'provider': return { view: 'provider', route: destination.route }
    case 'reference': return {
      view: 'reference',
      ref: destination.ref,
      ...(destination.label === undefined ? {} : { label: destination.label }),
    }
    case 'add-provider': return {
      view: 'add-provider',
      ...(destination.route === undefined ? {} : { route: destination.route }),
    }
    case 'logout-list': return { view: 'logout-list' }
    case 'logout': return { view: 'logout', target: destination.target }
  }
}
