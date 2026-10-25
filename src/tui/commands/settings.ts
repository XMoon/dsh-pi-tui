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

import type { SettingItem, SettingValuePart } from '@xmoon76/pi-tui'
import { getKeybindings, SettingsList } from '@xmoon76/pi-tui'
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
import type { KeybindingEditorModel } from '../keybindings/ui/model.ts'
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
import { ThemeSubmenu, themeDisplayName as themeDisplayNameOf } from '../pickers/theme-menu.ts'
import { SubagentModelAllowlistPicker, allowlistSummary } from '../pickers/subagent-model-menu.ts'
import { resolveThemeSelection, themePickerRows } from '../../app/surface/theme-selection.ts'
import { normalizePersistedTheme } from '../../domain/display/theme-selection.ts'
import { serializeTuiSettingsMutation, type ConfigPort, type TuiSettingsDoc, type VisualToolsState, type WebProviderSettings } from '../../runtime/config-port.ts'
import { WebCredentialPanel, WebEndpointPanel, WebWriteVerdictError, type WebCredentialAction } from '../panels/web-provider-panels.ts'
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
} from '../panels/settings-workspace-panel.ts'
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

  /** The exact credential reference the official DeepSeek web providers
   *  resolve (`apiKeyEnv`'s shipped default). The value never reaches the TUI. */
  const WEB_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
  const WEB_CREDENTIAL_ROW_ID = 'web-credential'
  /** The `Tools`-category launcher row id (a NAVIGATION row: it never becomes a
   *  Workspace editable field, so the editable-row count is unchanged). */
  const WEB_LAUNCHER_ROW_ID = 'web-settings'
  /** The legacy row the launcher focuses AND the identity that makes Esc
   *  restore the Workspace instead of returning to the conversation. */
  const WEB_LAUNCHER_TARGET_ROW = 'web-search-provider'
  const WEB_SEARCH_PROVIDER_VALUES = [
    { id: 'deepseek-official', label: 'Messages', default: true },
    { id: 'deepseek-search-api', label: 'DeepSeek Search API', default: false },
  ] as const
  const WEB_FETCH_PROVIDER_VALUES = [
    { id: 'http', label: 'HTTP', default: true },
    { id: 'deepseek-fetch-api', label: 'DeepSeek Fetch API', default: false },
  ] as const
  const WEB_SEARCH_COUNT_VALUES = ['5', '10', '20', '50'] as const
  const WEB_ORIGINAL_QUESTION_VALUES = ['on', 'off'] as const
  type WebSettingRowId =
    | 'web-search-provider'
    | 'web-fetch-provider'
    | 'web-search-count'
    | 'web-send-original-question'
    | 'web-search-endpoint'
  const WEB_SETTING_ROW_IDS: ReadonlySet<string> = new Set([
    'web-search-provider',
    'web-fetch-provider',
    'web-search-count',
    'web-send-original-question',
    'web-search-endpoint',
  ])
  /** One row's transient write state (PRESENTATION only; never a shadow value). */
  type WebRowPhase = 'saving' | 'not-saved' | 'outcome-unknown'
  const webRowPhases = new Map<WebSettingRowId, { readonly kind: WebRowPhase; readonly reason?: string }>()
  /** The mounted legacy editor's lifetime facts: the Web section's asynchronous
   *  settles must never repaint a closed editor or delegate through it. */
  let legacyEditorOpen = false
  let closeLegacyEditor: (() => void) | undefined
  /** Recompute the mounted Web rows' display units after a settle. */
  let repaintWebItems: (() => void) | undefined
  /** Release for the live palette observer of the MOUNTED Web section (§4A.2:
   *  the theme is read at render time, so cached chip ANSI is rebuilt on a
   *  skin switch instead of keeping the palette it was created with). */
  let releaseWebThemeListener: (() => void) | undefined

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
   * generation that currently owns the surface — so a suspended legacy read or
   * a Workspace reopened mid-write can never leave the surface permanently on
   * a pre-write snapshot.
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

  /** A provider's official display name, or the configured custom id verbatim
   *  (a custom route is reported as-is and never silently replaced). */
  const providerLabel = (
    values: readonly { readonly id: string; readonly label: string }[],
    id: string | undefined,
  ): string | undefined => id === undefined ? undefined : (values.find(entry => entry.id === id)?.label ?? id)

  /** Whether the configured id is one of the two official candidates this UI
   *  may select. A custom id keeps its configured value and is NOT selectable
   *  here. */
  const providerSelectable = (
    values: readonly { readonly id: string }[],
    id: string | undefined,
  ): boolean => id === undefined || values.some(entry => entry.id === id)

  /** The cycle list a provider row may offer: the official candidate LABELS
   *  (the fork's contract) only while the verified value is one of them; a
   *  custom route — or an authority that has not answered yet — offers no
   *  cycle at all. */
  const providerRowValues = (rowId: 'web-search-provider' | 'web-fetch-provider'): string[] | undefined => {
    if (webSettings === undefined) return undefined
    const values = rowId === 'web-search-provider' ? WEB_SEARCH_PROVIDER_VALUES : WEB_FETCH_PROVIDER_VALUES
    const id = rowId === 'web-search-provider' ? webSettings.searchProvider : webSettings.fetchProvider
    return providerSelectable(values, id) ? values.map(entry => entry.label) : undefined
  }

  const providerDefault = (
    values: readonly { readonly id: string; readonly default: boolean }[],
    id: string | undefined,
  ): boolean => id !== undefined && values.find(entry => entry.id === id)?.default === true

  /** The provider row's WHOLE display units (§4.5 atomic chips): value, then
   *  `[current]`, then `[default]`, then a problem chip / state word. Ordering
   *  is the drop priority — the tail yields first. */
  const providerValueParts = (
    rowId: 'web-search-provider' | 'web-fetch-provider',
    values: readonly { readonly id: string; readonly label: string; readonly default: boolean }[],
  ): SettingValuePart[] => {
    const phase = webRowPhases.get(rowId)
    const phaseParts = webPhaseParts(phase)
    if (phaseParts.length > 0) return phaseParts
    if (webReadPending()) return [{ kind: 'chip', text: color.textMuted('[Loading…]') }]
    const id = rowId === 'web-search-provider' ? webSettings?.searchProvider : webSettings?.fetchProvider
    const label = providerLabel(values, id)
    // X061 drops a trailing TEXT part unconditionally, so the unavailable /
    // pending facts ride a WHOLE chip (an unreadable provider must never paint
    // an empty slot).
    if (label === undefined) return [{ kind: 'chip', text: color.warning('[unavailable]') }]
    // X061's slot contract: the renderer keeps the longest WHOLE prefix and
    // ALWAYS drops a trailing `text` part, so a value slot that must show both
    // a state chip and a name can never rely on a text tail. The state chips
    // are therefore the row's value slot (the theme/preset picker precedent),
    // and the row's description states `Current: <value>` in full.
    const parts: SettingValuePart[] = []
    if (webSettings !== undefined) {
      const selectable = providerSelectable(values, id)
      // A custom (not selectable) route leads with its PROBLEM chip: the slot's
      // reserved first chip is the fact a narrow width must keep.
      if (!selectable) parts.push({ kind: 'chip', text: color.warning('[unavailable]') }, { kind: 'text', text: ' ' })
      parts.push({ kind: 'chip', text: color.textMuted('[current]') })
      if (providerDefault(values, id)) {
        parts.push({ kind: 'text', text: ' ' }, { kind: 'chip', text: color.textMuted('[default]') })
      }
    } else {
      parts.push({ kind: 'chip', text: color.warning('[unavailable]') })
    }
    return parts
  }

  /** The transient write state as a WHOLE state chip (§4.5's chip vocabulary
   *  keeps the words; a problem state takes its semantic token). Undefined when
   *  no write is in flight, so the verified chips render instead. */
  const webPhaseParts = (
    phase: { readonly kind: WebRowPhase; readonly reason?: string } | undefined,
  ): SettingValuePart[] => {
    if (phase === undefined) return []
    if (phase.kind === 'saving') return [{ kind: 'chip', text: color.textMuted('[Saving…]') }]
    if (phase.kind === 'not-saved') return [{ kind: 'chip', text: color.error('[Not saved]') }]
    return [{ kind: 'chip', text: color.warning('[Outcome unknown]') }]
  }

  /** A non-provider row's value units: the value plus the same chip/state
   *  vocabulary (count / question / endpoint). */
  /** TRUE while the facts are NOT settled: a read is in flight, or one is
   *  about to start (the entry/refresh prologue). The rows then state
   *  `Loading…` instead of presenting a last-known value as current. */
  const webReadPending = (): boolean => !webReadSettled

  const plainValueParts = (
    rowId: WebSettingRowId,
    value: string,
    options: { readonly current: boolean; readonly isDefault: boolean },
  ): SettingValuePart[] => {
    const phase = webRowPhases.get(rowId)
    const phaseParts = webPhaseParts(phase)
    if (phaseParts.length > 0) return phaseParts
    if (webReadPending()) return [{ kind: 'chip', text: color.textMuted('[Loading…]') }]
    if (!options.current) return [{ kind: 'chip', text: color.warning('[unavailable]') }]
    const parts: SettingValuePart[] = [{ kind: 'chip', text: color.textMuted('[current]') }]
    if (options.isDefault) parts.push({ kind: 'text', text: ' ' }, { kind: 'chip', text: color.textMuted('[default]') })
    return parts
  }

  /** The ENDPOINT row's value slot. Its fact is a long URL, so while the
   *  authority is readable the PLAIN slot paints the URL itself (truncated to
   *  the cells it has — the submenu shows it in full) and claims no state chip:
   *  `[unavailable]` is reserved for a value that really could not be read. A
   *  pending read or a transient write verdict keeps the chip vocabulary. */
  const endpointValueParts = (): SettingValuePart[] | undefined => {
    const phaseParts = webPhaseParts(webRowPhases.get('web-search-endpoint'))
    if (phaseParts.length > 0) return phaseParts
    if (webReadPending()) return [{ kind: 'chip', text: color.textMuted('[Loading…]') }]
    if (webSettings === undefined) return [{ kind: 'chip', text: color.warning('[unavailable]') }]
    return undefined
  }

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

  /** The DISPLAYED fact: a pending/failed phase states itself, and an
   *  unreadable authority is Unavailable — never a last-known value. */
  const webRowValue = (id: WebSettingRowId): string => {
    const phase = webRowPhases.get(id)
    if (phase?.kind === 'saving') return 'Saving…'
    if (phase?.kind === 'not-saved') return 'Not saved'
    if (phase?.kind === 'outcome-unknown') return 'Outcome unknown'
    if (webReadPending()) return 'Loading…'
    return webSettledValue(id) ?? 'Unavailable'
  }

  /** A row's value units: `undefined` means the row keeps its PLAIN slot (the
   *  endpoint row's URL); every other row states whole chips. */
  const webRowValueParts = (id: WebSettingRowId): SettingValuePart[] | undefined => {
    switch (id) {
      case 'web-search-provider':
        return providerValueParts(id, WEB_SEARCH_PROVIDER_VALUES)
      case 'web-fetch-provider':
        return providerValueParts(id, WEB_FETCH_PROVIDER_VALUES)
      case 'web-search-count':
        return plainValueParts(id, webRowValue(id), {
          current: webSettings !== undefined,
          isDefault: webSettings !== undefined && String(webSettings.api.count) === '10',
        })
      case 'web-send-original-question':
        return plainValueParts(id, webRowValue(id), {
          current: webSettings !== undefined,
          isDefault: webSettings !== undefined && webSettings.api.sendOriginalQuestion,
        })
      case 'web-search-endpoint':
        return endpointValueParts()
    }
  }

  /** The full description of one Web state row: the `Current:` fact leads (the
   *  row's value slot carries only the whole state chips), then the static
   *  explanation. */
  const webRowDescription = (id: WebSettingRowId): string => {
    const current = webRowValue(id)
    switch (id) {
      case 'web-search-provider':
        return providerSelectable(WEB_SEARCH_PROVIDER_VALUES, webSettings?.searchProvider)
          ? `Current: ${current} · Messages is the official default and does not call the billed Search API. DeepSeek Search API is opt-in and separately billed (a Messages plan does not guarantee coverage); with Share Original Question on (default), up to 128 characters of the triggering question are sent as ori_question. The choice applies to the next search. Esc returns to the Workspace.`
          : `Current: ${current} · The configured search provider is a custom route: it is displayed as-is and is not selectable here. The official candidates are Messages and DeepSeek Search API.`
      case 'web-fetch-provider':
        return providerSelectable(WEB_FETCH_PROVIDER_VALUES, webSettings?.fetchProvider)
          ? `Current: ${current} · HTTP is the official anonymous default. DeepSeek Fetch API is opt-in and separately billed (a Messages plan does not guarantee coverage). The choice applies to the next fetch.`
          : `Current: ${current} · The configured fetch provider is a custom route: it is displayed as-is and is not selectable here. The official candidates are HTTP and DeepSeek Fetch API.`
      case 'web-search-count':
        return `Current: ${current} · Results requested per DeepSeek Search API call; the official limit is 1 through 50, and a smaller per-request bound still wins.`
      case 'web-send-original-question':
        return `Current: ${current} · On (packed default for the DeepSeek Search API): each call also sends up to 128 characters of the triggering human question (ori_question), never the full history or system prompt. Off: never. A running operation is unchanged.`
      case 'web-search-endpoint': {
        // A refused endpoint write must still say what the Host KEEPS: the
        // panel's own message dies with the panel (a superseded verdict lands
        // after the panel was cancelled), so the row's Detail carries the newest
        // authority value whenever the verdict is `Not saved` and that value is
        // readable. An unreadable authority claims nothing extra here.
        const kept = webRowPhases.get('web-search-endpoint')?.kind === 'not-saved'
          ? webSettledValue('web-search-endpoint')
          : undefined
        return `Current: ${current}${kept === undefined ? '' : ` · the Host keeps "${kept}"`} · The API base the DeepSeek Search and Fetch APIs call (/search and /fetch are appended); base-owned, not an Optional Bundle. Changing it sends the credential and query there; confirm only a trusted HTTPS base — the URL shape is checked, not the host's trust.`
      }
    }
  }

  /** The credential row's displayed state: the official store's OWN answer
   *  (presence and source layer), never the value. */
  const webCredentialValue = (): string => {
    if (!runner.config.credentials.available()) return 'Unavailable'
    if (webSettings === undefined) return 'Unavailable'
    if (!webSettings.credential.configured) return 'Not configured'
    return webSettings.credential.source === undefined
      ? 'Configured'
      : `Configured · source: ${webSettings.credential.source}`
  }

  const webCredentialParts = (): SettingValuePart[] => {
    if (webReadPending()) return [{ kind: 'chip', text: color.textMuted('[Loading…]') }]
    return webSettings?.credential.configured
      ? [{ kind: 'chip', text: color.textMuted('[current]') }]
      : [{ kind: 'chip', text: color.warning('[unavailable]') }]
  }

  /** The launcher row's facts. The Settings workspace snapshot is SYNCHRONOUS
   *  and the command reads the Host BEFORE the workspace leases the screen, so
   *  the first frame already carries authoritative values; a missing or failed
   *  read is stated, never defaulted. */
  const webWorkspaceRowFacts = (): { summary: string; freshness: SettingsWorkspaceFreshness; description: string } => {
    const description = 'Host Web settings for the base profile, not an Optional Bundle. Defaults: Messages search · HTTP fetch; other bundles never change them and the defaults call no billed API. The Search/Fetch APIs are billed separately as opt-in providers (a Messages plan does not guarantee coverage) and send the request to the configured endpoint. Share Original Question is on by default: it sends up to 128 characters of the human question (never the full history or system prompt). The key stays in the official credential reference and is never shown. A value reads Verified only after the Host write and authoritative read-back agree. Enter configure.'
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

  /** One Web section write, serialized behind every other Web write: a slow
   *  earlier mutation can never land after a newer one. The row is reconciled
   *  from the authoritative read-back on settle — never from the request. */
  let webWriteChain: Promise<void> = Promise.resolve()

  /** The verdict of ONE write intent against the NEWEST committed authority.
   *  Verified means the Host really HOLDS the requested value: a resolved
   *  mutation is not a save. A readable difference (a competing writer, a
   *  canonical form, an official bound) is `Not saved` — the row reports it and
   *  goes back to the value the Host kept — while an unreadable authority stays
   *  `Outcome unknown`, because the mutation may or may not have applied. */
  const settleWebWrite = (
    id: WebSettingRowId,
    requested: string,
    revert: (value: string) => void,
    previous: string,
  ): void => {
    if (webSettings === undefined) {
      webRowPhases.set(id, { kind: 'outcome-unknown' })
    } else {
      const committed = webSettledValue(id)
      if (committed === requested) {
        webRowPhases.delete(id)
      } else {
        webRowPhases.set(id, { kind: 'not-saved' })
        revert(committed ?? previous)
      }
    }
    repaintWebItems?.()
  }

  const queueWebSettingWrite = (
    id: WebSettingRowId,
    requested: string,
    write: () => Promise<void>,
    revert: (previousValue: string) => void,
  ): void => {
    if (webSettings === undefined) {
      // No verified authority read: the write is refused with the reason
      // instead of mutating a state the UI cannot verify (§B3.4).
      webRowPhases.set(id, { kind: 'not-saved', reason: 'the current Web settings could not be read' })
      repaintWebItems?.()
      if (legacyEditorOpen) app.notify('Web settings · Not saved: the current Web settings could not be read', 'error')
      return
    }
    const previous = webRowValue(id)
    webRowPhases.set(id, { kind: 'saving' })
    repaintWebItems?.()
    webWriteChain = webWriteChain.then(async () => {
      try {
        await write()
      } catch (error) {
        webRowPhases.set(id, { kind: 'not-saved', reason: safeErrorMessage(error) })
        revert(previous)
        repaintWebItems?.()
        if (legacyEditorOpen) {
          app.notify(`Web settings · Not saved: ${safeErrorMessage(error)}`, 'error')
        }
        return
      }
      const verified = await rereadWebSettings()
      if (!verified.fresh) {
        // A NEWER read owns the facts: this snapshot is superseded. WAIT for the
        // newest settlement (§B3.4 currentness) and judge by what it committed —
        // never a verdict from the superseded snapshot, and never a stale phase.
        await awaitWebSettled()
        settleWebWrite(id, requested, revert, previous)
        return
      }
      if (verified.settings === undefined) {
        // The mutation may have applied: never report success, and never
        // pretend a rollback either — the next read owns the display.
        webRowPhases.set(id, { kind: 'outcome-unknown' })
        repaintWebItems?.()
        if (legacyEditorOpen) {
          app.notify('Web settings · Outcome unknown: the Host write could not be verified', 'info')
        }
        return
      }
      settleWebWrite(id, requested, revert, previous)
    })
  }

  /** Queue one Web-section operation on the ONE owner FIFO (the endpoint
   *  editor uses it too: a text write never races a selection). */
  const queueWebOperation = <T>(task: () => Promise<T>): Promise<T> => {
    const run = webWriteChain.then(task)
    webWriteChain = run.then(() => undefined, () => undefined)
    return run
  }

  /** The exact ConfigPort operation one choice row means (undefined = the value
   *  is not one this UI writes, so the row is restored unchanged). */
  const webWriteFor = (id: WebSettingRowId, value: string): (() => Promise<void>) | undefined => {
    switch (id) {
      case 'web-search-provider': {
        const candidate = WEB_SEARCH_PROVIDER_VALUES.find(entry => entry.label === value)
        return candidate === undefined ? undefined : () => runner.config.web.setSearchProvider(candidate.id)
      }
      case 'web-fetch-provider': {
        const candidate = WEB_FETCH_PROVIDER_VALUES.find(entry => entry.label === value)
        return candidate === undefined ? undefined : () => runner.config.web.setFetchProvider(candidate.id)
      }
      case 'web-search-count': {
        const count = Number(value)
        return Number.isInteger(count) ? () => runner.config.web.setSearchApiCount(count) : undefined
      }
      case 'web-send-original-question':
        return value !== 'on' && value !== 'off'
          ? undefined
          : () => runner.config.web.setSendOriginalQuestion(value === 'on')
      case 'web-search-endpoint':
        // Owned by the exclusive endpoint submenu (it validates, writes and
        // verifies before closing), so the row's commit carries no second write.
        return undefined
    }
  }

  /** Close the settings surface FIRST, then delegate to the EXISTING command
   *  path: one seat owner at a time, never a masked Question stacked under the
   *  settings overlay. The Esc-return path is deliberately NOT used here: the
   *  credential command owns the surface next. */
  const runWebCredentialCommand = (line: string): void => {
    webReturnToWorkspace = false
    closeLegacyEditor?.()
    detach(`web credential ${line}`, () => runner.clientCommands.execute({
      line,
      signal: new AbortController().signal,
    }), { notify: true })
  }

  const webCredentialActions = (): readonly WebCredentialAction[] => [
    {
      label: 'Configure…',
      description: `run the existing masked /login ${WEB_CREDENTIAL_REF} prompt`,
      enabled: true,
      run: () => runWebCredentialCommand(`/login ${WEB_CREDENTIAL_REF}`),
    },
    {
      label: 'Clear…',
      description: `run the existing /logout ${WEB_CREDENTIAL_REF} path`,
      enabled: true,
      run: () => runWebCredentialCommand(`/logout ${WEB_CREDENTIAL_REF}`),
    },
  ]

  /** Whether Esc from the legacy editor must RESTORE the Settings workspace on
   *  the Web launcher row (the Web-entry return path). The original
   *  `Open existing settings…` entry keeps its conversation return. */
  let webReturnToWorkspace = false

  /** The ONE Settings workspace open path: the lease is taken SYNCHRONOUSLY
   *  (the first frame is immediate), then the Host Web facts are read for THIS
   *  panel generation and the SAME generation repaints its OWN row when the read
   *  settles. A newer/closed generation never receives the result. The repaint is
   *  ROW-scoped: the Web authority changed, so the TUI settings document is never
   *  read a second time (one guarded document read per surface). */
  let activeSettingsWorkspace: { readonly token: object; readonly refreshWebRow: () => void } | undefined

  interface WorkspaceOpenSpec {
    readonly initialRowId?: SettingsWorkspaceRowId
    readonly initialCategory?: import('../panels/settings-workspace-panel.ts').SettingsWorkspaceCategoryId
    readonly initialModelsView?: ModelsInitialView
    readonly initialAccountView?: AccountInitialView
  }

  /**
   * C2-R3: the ONE official-section write queue of this command owner.
   *
   * The official `subagent-model-selection` section is ONE stored value with TWO
   * halves, and every surface (the embedded allowlist picker, the workspace
   * toggle and the still-supported legacy editor rows) edits only ONE half per
   * user action. A queue that merely serialized whole-section payloads captured
   * BEFORE their turn would let an earlier intent be erased by a later payload
   * built from a stale snapshot — the exact "a slow earlier write lands after a
   * newer one" failure. Each queued item is therefore an INTENT over ONE half,
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
   * Queue ONE half-scoped section edit. `rebase` runs INSIDE the queue against
   * the FRESH official section, so it must change only the half this intent owns
   * and must copy the other half verbatim from `fresh`. Returning `undefined`
   * refuses the edit with ZERO writes (a setup precondition, not a failure).
   * `settle` maps what really happened to the caller's own outcome type.
   */
  const queueSubagentSectionEdit = <T>(
    rebase: (fresh: OfficialSectionState) => OfficialSectionState | undefined,
    settle: (written: OfficialSectionState | undefined) => T,
  ): Promise<T> => enqueueSubagentSectionWrite(async () => {
    if (!subagentSectionWritable()) return settle(undefined)
    const section = runner.config.subagentModelSelection
    // The FRESH read inside the queue is the rebase point: everything this
    // intent does not own comes from HERE, never from a snapshot captured
    // before the previous queued write settled.
    const latest = section.get()
    const payload = rebase({
      enabled: latest.enabled,
      allowedModels: latest.allowedModels.map(route => ({ ...route })),
    })
    if (payload === undefined) return settle(undefined)
    await section.set(payload)
    return settle(payload)
  })
  /** The narrow queue-backed section adapter the existing picker consumes. Its
   *  `set` carries the caller's whole payload, but ONLY the route list is that
   *  surface's intent: the `enabled` half is re-read inside the queue. */
  const queuedSubagentSelection = (): import('../../runtime/config-port.ts').SubagentModelSelectionConfig => ({
    available: () => subagentSectionWritable(),
    get: () => runner.config.subagentModelSelection.get(),
    set: value => queueSubagentSectionEdit<void>(
      fresh => ({ enabled: fresh.enabled, allowedModels: value.allowedModels.map(route => ({ ...route })) }),
      () => undefined,
    ),
  })

  const openSettingsWorkspaceWith = (spec: WorkspaceOpenSpec): void => {
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
        onRefresh: () => { startWebSettingsRead(token) },
      },
      {
        onOpenLegacy: (targetId) => { openLegacySettings(targetId) },
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
        // section queue as the workspace toggle and the legacy editor.
        createSubagentAllowlistPicker: (done, onAuthoritativeChange) => {
          // The section must be AVAILABLE *and* CURRENT: opening a picker over a
          // stale mirror would let the user toggle routes that can never commit.
          if (!subagentSectionWritable() || !runner.catalog.models.available()) return undefined
          return new SubagentModelAllowlistPicker({
            selection: queuedSubagentSelection(),
            catalog: runner.catalog.models,
            notify: (message, kind) => app.notify(message, kind),
            requestRender: () => app.requestRender(),
            done: () => { done() },
            // The picker's post-close convergence seam is already its own
            // `done`; while it is MOUNTED the row summary follows the fresh
            // snapshot instead.
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
          // The controller dies with the workspace: the subscription and any
          // in-flight read are released exactly once.
          aboutController?.dispose()
          aboutController = undefined
          // C2-R2: apply the last VERIFIED Fullscreen choice only on a real user
          // exit of the workspace that owned it, and only when the stored
          // preference still reads exactly that target. Everything else
          // (legacy hand-off, a forced teardown, a question/approval takeover)
          // keeps the stored preference for the next mount and swaps NOTHING.
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
    startWebSettingsRead(token)
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

  /** Start ONE authority read for the panel generation `token`: the pending
   *  state is applied and the launcher row repainted BEFORE the async read, and
   *  the SAME generation repaints its own row when the read settles. */
  const startWebSettingsRead = (_token: object): void => {
    beginWebSettingsRead()
    activeSettingsWorkspace?.refreshWebRow()
    detach('web provider settings read', async () => {
      // The read's own commit refreshes the generation that currently owns the
      // surface (never a superseded one).
      await readWebSettings()
    }, { notify: false })
  }

  /** Restore the Settings workspace on the Web launcher row. The workspace is
   *  always restored (its own readiness row states a non-ready backend); a
   *  newer owner of the surface refuses the lease and the failure is reported. */
  const reopenSettingsWorkspaceAtWebRow = (): void => {
    if (app.isDisposed()) return
    try {
      openSettingsWorkspaceAt(WEB_LAUNCHER_ROW_ID)
    } catch (error) {
      app.notify(`could not restore the settings workspace: ${safeErrorMessage(error)}`, 'error')
    }
  }

  /** The Web section rows, in the frozen order. An unavailable section renders
   *  its state and OFFERS NO WRITE ENTRY at all. */
  const webSettingItems = (): SettingItem[] => {
    // Structural admission: the section's own rows render whenever the
    // authority exists. Whether a WRITE is acceptable is decided at write time
    // by the READABLE facts (`queueWebSettingWrite`), so a pending read shows
    // `Loading…` rows instead of pretending the section is unavailable, and a
    // settled-unreadable one states Unavailable with no accepted write.
    const available = webSettingsAvailable() && (!webReadSettled || webSettings !== undefined)
    const credentialsAvailable = runner.config.credentials.available()
    const section: SettingItem = {
      id: 'web-separator',
      label: color.border('─'.repeat(24)),
      currentValue: '',
    }
    const unavailableRow = (id: WebSettingRowId, label: string): SettingItem => ({
      id,
      label,
      description: 'The Host Web provider settings are not available on this backend; no value can be read or changed here.',
      currentValue: 'Unavailable',
      valueParts: [{ kind: 'chip', text: color.warning('[unavailable]') }],
    })
    // A provider row offers its cycle ONLY from a VERIFIED authority: an
    // unknown (pending/failed) value must never be cycled, because the fork's
    // cycle would silently replace a custom route with the first candidate.
    // The list is reconciled on every settle too (`repaintWebItems`), since the
    // row is created before the authority has answered.
    const customSearch = providerRowValues('web-search-provider') === undefined
    const customFetch = providerRowValues('web-fetch-provider') === undefined
    const rows: SettingItem[] = available
      ? [
          {
            id: 'web-search-provider',
            label: 'Web Search Provider',
            description: webRowDescription('web-search-provider'),
            currentValue: webSettledValue('web-search-provider') ?? '',
            valueParts: webRowValueParts('web-search-provider'),
            ...customSearch ? {} : { values: providerRowValues('web-search-provider') },
          },
          {
            id: 'web-fetch-provider',
            label: 'Web Fetch Provider',
            description: webRowDescription('web-fetch-provider'),
            currentValue: webSettledValue('web-fetch-provider') ?? '',
            valueParts: webRowValueParts('web-fetch-provider'),
            ...customFetch ? {} : { values: providerRowValues('web-fetch-provider') },
          },
          {
            id: 'web-search-count',
            label: 'Search API Result Count',
            description: webRowDescription('web-search-count'),
            currentValue: webSettledValue('web-search-count') ?? '',
            valueParts: webRowValueParts('web-search-count'),
            values: [...WEB_SEARCH_COUNT_VALUES],
          },
          {
            id: 'web-send-original-question',
            label: 'Share Original Question',
            description: webRowDescription('web-send-original-question'),
            currentValue: webSettledValue('web-send-original-question') ?? '',
            valueParts: webRowValueParts('web-send-original-question'),
            values: [...WEB_ORIGINAL_QUESTION_VALUES],
          },
          {
            id: 'web-search-endpoint',
            label: 'Search / Fetch API Endpoint',
            description: webRowDescription('web-search-endpoint'),
            // The URL is this row's fact: the plain slot carries it (truncated to
            // the cells it has; the submenu shows it in full), and the state
            // chips take the slot only while the fact is pending, transient or
            // unreadable (see `endpointValueParts`).
            currentValue: webSettledValue('web-search-endpoint') ?? '',
            valueParts: webRowValueParts('web-search-endpoint'),
            submenu: (_currentValue: string, done: (selected?: string) => void) => new WebEndpointPanel(done, {
              current: webSettings?.api.baseURL ?? '',
              // The endpoint text write is a Web-section write like any other:
              // it joins the ONE owner FIFO so a selection and a text edit can
              // never race the official revision-checked mutation.
              save: (url: string) => queueWebOperation(async () => {
                if (webSettings === undefined) {
                  throw new WebWriteVerdictError('not-saved', 'the current Web settings could not be read')
                }
                webRowPhases.set('web-search-endpoint', { kind: 'saving' })
                repaintWebItems?.()
                try {
                  await runner.config.web.setSearchApiBaseURL(url)
                } catch (error) {
                  webRowPhases.set('web-search-endpoint', { kind: 'not-saved' })
                  repaintWebItems?.()
                  throw error
                }
                const verified = await rereadWebSettings()
                if (!verified.fresh) {
                  // The PANEL owns a modal verdict, so it must never be told a
                  // superseded result: WAIT for the newest read, then judge by
                  // the facts it committed (success closes the panel, a
                  // mismatch reports the NEWEST value, an unreadable authority
                  // stays honestly unknown).
                  await awaitWebSettled()
                  const committed = webSettledValue('web-search-endpoint')
                  if (committed === url) {
                    webRowPhases.delete('web-search-endpoint')
                    repaintWebItems?.()
                    return
                  }
                  if (committed === undefined) {
                    webRowPhases.set('web-search-endpoint', { kind: 'outcome-unknown' })
                    repaintWebItems?.()
                    throw new WebWriteVerdictError('outcome-unknown', 'the current Web settings could not be read — reopen the section to read the current value')
                  }
                  webRowPhases.set('web-search-endpoint', { kind: 'not-saved' })
                  repaintWebItems?.()
                  throw new WebWriteVerdictError('not-saved', `the Host keeps "${committed}" instead of the submitted endpoint`)
                }
                const settings = verified.settings
                if (settings === undefined) {
                  webRowPhases.set('web-search-endpoint', { kind: 'outcome-unknown' })
                  repaintWebItems?.()
                  throw new WebWriteVerdictError('outcome-unknown', 'the endpoint write could not be verified against the Host — reopen the section to read the current value')
                }
                webRowPhases.delete('web-search-endpoint')
                repaintWebItems?.()
                if (settings.api.baseURL !== url) {
                  throw new WebWriteVerdictError('not-saved', `the Host keeps "${settings.api.baseURL}" instead of the submitted endpoint`)
                }
              }),
              requestRender: () => app.requestRender(),
              run: (label, task) => detach(label, task, { notify: false }),
            }),
          },
        ]
      : [
          unavailableRow('web-search-provider', 'Web Search Provider'),
          unavailableRow('web-fetch-provider', 'Web Fetch Provider'),
          unavailableRow('web-search-count', 'Search API Result Count'),
          unavailableRow('web-send-original-question', 'Share Original Question'),
          unavailableRow('web-search-endpoint', 'Search / Fetch API Endpoint'),
        ]
    const credentialRow: SettingItem = {
      id: WEB_CREDENTIAL_ROW_ID,
      label: 'DeepSeek API Key',
      description: `Current: ${webCredentialValue()} · The credential reference the DeepSeek Search / Fetch APIs resolve (${WEB_CREDENTIAL_REF}); the value is never shown and is stored by the official credential store. Configure… runs the existing masked /login ${WEB_CREDENTIAL_REF}; Clear… runs /logout ${WEB_CREDENTIAL_REF}. The editor closes before either command runs.`,
      currentValue: webCredentialValue(),
      valueParts: webCredentialParts(),
      ...credentialsAvailable
        ? {
            submenu: (_currentValue: string, done: (selected?: string) => void) => new WebCredentialPanel(done, {
              reference: WEB_CREDENTIAL_REF,
              read: () => runner.config.credentials.describeReference(WEB_CREDENTIAL_REF),
              actions: webCredentialActions(),
              requestRender: () => app.requestRender(),
              run: (label, task) => detach(label, task, { notify: false }),
            }),
          }
        : {},
    }
    return [section, ...rows, credentialRow]
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
    field: 'busy-enter' | 'fullscreen' | 'local-shell-sandbox',
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
      switch (request.field) {
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
        default: {
          // Exhaustiveness fence: a new writable field must name its writer
          // here instead of falling into another field's branch.
          const unreachable: never = request.field
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
  /** Whether two official allowlists carry the SAME ordered (provider,model)
   *  pairs. The pair is the only route identity: a display name never compares. */
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
      // app notice — the same wording the legacy editor used for a switch.
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
        // the BASE value refutes THIS request.
        const readback = section.get()
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
      const readback = section.get()
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
    // choice is still in flight (a late OSC answer may never colour over it), and a
    // FAILED candidate must never steal the intent of a still-pending `auto` (the
    // legacy path keeps its own choice at the previous value on a failed apply).
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
    // ONE registry read per snapshot: the conditional `Extensions` category and
    // its transition launcher are derived from the SAME live directory, so a
    // registration between two reads can never produce a category without the
    // row that makes it reachable.
    const extensionRegistry = runner.extensions?.settings.snapshot()
    const extensionRows = extensionRegistry?.rows ?? []
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
    const extensionContributors = new Set(extensionRows.map(row => row.owner)).size
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
      action: 'inspect',
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
      action: 'inspect',
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
    const subagentSelection = subagentAvailable ? runner.config.subagentModelSelection.get() : undefined
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
      action: 'inspect',
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
      action: 'inspect',
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
    // The R0 transition rows: each one only NAMES the existing-editor row it
    // focuses. They run no write of their own and never stand in for the real
    // editor, which stays reachable behind them until R1–R6 migrate the field.
    const transitionRow = (
      id: SettingsWorkspaceRowId,
      category: SettingsWorkspaceCategoryId,
      label: string,
      description: string,
      legacyTargetId: string,
    ): SettingsWorkspaceRow => ({
      id,
      category,
      label,
      summary: 'Existing settings editor',
      scope: 'Existing settings editor',
      freshness: 'ready',
      description,
      action: 'open-legacy',
      legacyTargetId,
    })
    return {
      configReadiness,
      capturedAt: Date.now(),
      ...(readIssue === undefined ? {} : { readIssue }),
      extensionRevision: extensionRegistry?.revision ?? 0,
      extensionCount: extensionRows.length,
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
          action: 'inspect',
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
          action: 'inspect',
          edit: persistedPreferenceEditOf(
            'icon-style',
            runtimeIcon,
            ICON_STYLE_CANDIDATES,
            iconRaw,
            doc !== undefined,
          ),
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
          action: 'inspect',
          edit: displayEditOf(persistedPreset, doc !== undefined),
        },
        {
          // R1: runtime-only disclosure — the Ctrl+O master switch. There is no
          // settings-document field behind it (the legacy editor only changed
          // the TUI runtime), so the Detail says so instead of implying a save.
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
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
          action: 'inspect',
          edit: persistedPreferenceEditOf(
            'terminal-progress',
            runtimeTerminalProgress,
            TERMINAL_PROGRESS_CANDIDATES,
            doc?.terminalProgress,
            doc !== undefined,
          ),
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
          action: 'inspect',
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
          action: 'inspect',
          edit: visualToolsEditOf(visualTools, configReadiness),
        },
        transitionRow(
          'footer-settings-legacy',
          'appearance',
          'Footer & status line…',
          'The footer layout is configured by the existing settings editor. This row only opens that editor on its own row.',
          'footer',
        ),
        transitionRow(
          'input-terminal-settings-legacy',
          'input-terminal',
          'Input & terminal settings…',
          'Keyboard shortcuts are still configured by the existing settings editor. This row only opens that editor on that row.',
          'keyboard-shortcuts',
        ),
        {
          // S2/PR-B §3.3: the ONE discoverable entry to the Web provider
          // settings section. The row opens the EXISTING legacy editor focused
          // on that section's first row (no second settings framework). R4
          // replaces this launcher with an in-place section.
          id: WEB_LAUNCHER_ROW_ID,
          category: 'tools',
          label: 'Web Search / Fetch',
          ...webWorkspaceRowFacts(),
          scope: 'Host Web provider settings',
          action: 'open-legacy',
          legacyTargetId: 'web-search-provider',
        },
        // The registry's live directory, newest snapshot only. Without a live
        // row there is no Extensions category at all (the panel derives the
        // category from `extensionCount`), so no empty page can be painted.
        ...extensionRows.length === 0 ? [] : [{
          // R0 is the transition ENTRY only: the row opens the existing editor
          // on the registry's first (order ASC, id ASC) row. R6 replaces it
          // with the per-owner extension settings list.
          id: 'extension-settings-legacy' as const,
          category: 'extensions' as const,
          label: 'Configure extension settings…',
          summary: `${extensionRows.length} ${extensionRows.length === 1 ? 'setting' : 'settings'} · ${extensionContributors} ${extensionContributors === 1 ? 'contributor' : 'contributors'}`,
          scope: 'Existing settings editor',
          freshness: 'ready' as const,
          description: 'Extension registrations are edited by the existing settings editor. This row only opens that editor on the first registered setting; the per-owner list arrives with the extension settings migration.',
          action: 'open-legacy' as const,
          // The deeplink target is read from the LIVE registry on every open:
          // it is never a stored id that could outlive the registration it
          // names.
          legacyTargetId: `ext-setting:${extensionRows[0]!.id}`,
        }],
      ],
    }
  }

  /**
   * The pre-B2-A complete settings editor, preserved VERBATIM: the original
   * `registerSettings` handler body is the ONE owner of the legacy rows, the
   * Theme picker, the first-level Plugin page, the permission/session rows, the
   * HMR/plugin callbacks and every write path. It is called by the compatibility
   * entry of the new Settings workspace (and only there), so it re-reads the live
   * session scope and settings document at the moment of the handoff.
   */
  const openLegacySettings = (targetId?: string): CommandResult => {
        // The session-scoped rows and their writes belong to the exact owner
        // that was live when the panel opened; the captured scope never
        // retargets to a replacement session. Never creates a Session.
        const liveScope = runner.captureLiveSessionScope()
        const tuiSettings = runner.tuiSettings
        // §9.1 currentness: a backend whose config reads are not current must
        // say so. The rows below show LAST KNOWN values, so the panel announces
        // the staleness explicitly (and every write is refused with an explicit
        // reconnecting reason by the port itself) instead of presenting
        // last-known values as authoritative.
        const configReadiness = runner.config.configReadiness()
        if (configReadiness !== 'ready') {
          // The wording must match what the rows actually show: without a
          // settings document the rows fall back to the panel's BUILT-IN
          // defaults, which are not Host values at all — calling them
          // "last known" would fabricate authority the backend never had
          // (§9.1). With a document they are the last-known Host values.
          const hasHostValues = tuiSettings !== undefined
          app.notify(
            configReadiness === 'unavailable'
              ? hasHostValues
                ? 'the configuration backend is unavailable — the values shown are the last known ones and changes cannot be saved'
                : 'the configuration backend is unavailable — the settings below show built-in defaults, not Host values, and changes cannot be saved'
              : 'the configuration is not current (reconnecting) — the values shown are the last known ones; changes will be refused until it reconnects',
            'error',
          )
        }
        let settingsDoc: TuiSettingsDoc | undefined
        if (tuiSettings !== undefined) {
          try {
            settingsDoc = tuiSettings.get()
          } catch (error) {
            // A present but temporarily unreadable settings service must degrade
            // to the same unavailable keyboard-shortcuts fallback as absence.
            runner.diag.warn('settings read failed', { error: safeErrorMessage(error) })
          }
        }
        const theme = settingsDoc?.theme ?? 'auto'
        // The DISPLAYED current theme: the friendly name (the persisted
        // value may still be the legacy `custom:<name>` / bare-name form —
        // the display derives from it, the /settings handler reads and
        // writes SOURCE-QUALIFIED values).
        const themeDisplayName = themeDisplayNameOf(theme, runner.extensions?.themes)
        // The autodetect guard reads THIS synchronous "latest choice", never
        // the persisted doc: the settings write is asynchronous, so at the
        // moment an OSC 11 reply lands the doc may still hold the PREVIOUS
        // theme — a doc-based guard would wrongly refuse a just-selected
        // `auto` (and wrongly apply over a just-selected explicit theme).
        // The choice is the SOURCE-QUALIFIED IDENTITY (normalized — a legacy
        // `custom:X` doc value becomes `file:X`), never a display label: the
        // submenu's `[current]` state chip compares this identity against the
        // live row values (the review's P3 — the current-state identity must
        // not be a display string a dynamic same-named source can mimic).
        let lastThemeChoice = normalizePersistedTheme(theme)
        // The permission-presets service owns the composed preset table and the
        // persisted default for new sessions (settings namespace 'permission').
        // Both panel rows degrade gracefully when the service is absent.
        const permissions = runner.config.permissions
        const permissionNames: string[] = [...permissions.presetNames()]
        // C2-R3: the subagent model-selection toggle and the allowlist picker
        // below share the command owner's ONE section queue
        // (`enqueueSubagentSectionWrite`), so rapid toggles commit in order and a
        // slow earlier write can never land after a newer one — including across
        // the workspace surface and this editor. Every settle re-syncs the row
        // to the ACTUAL committed state.
        const defaultPermission = permissions.defaultPreset()
        // Before the first session (deferred start) the session-scoped rows —
        // approval policy and the read-only session facts — do not exist yet;
        // everything process-wide stays available.
        const keyboardShortcutsRow: SettingItem = {
          id: 'keyboard-shortcuts',
          label: 'Keyboard shortcuts',
          description: 'Browse and customize action shortcuts, leader keys, and conflict-safe bindings',
          currentValue: 'Unavailable',
        }
        if (runner.tuiSettings !== undefined && settingsDoc !== undefined) {
          try {
            const model = new KeybindingEditorController({
              settings: runner.tuiSettings,
              manager: app.keybindingsManager(),
            }).readModel()
            keyboardShortcutsRow.currentValue = model.summary
          } catch {
            keyboardShortcutsRow.currentValue = 'Unavailable'
          }
        }
        keyboardShortcutsRow.submenu = (_currentValue, done) => createKeybindingEditorPanel(
          done,
          model => {
            keyboardShortcutsRow.currentValue = model.summary
          },
        ) ?? new KeybindingEditorUnavailablePanel(done)
        // The live allowlist submenu instance (created lazily when the row
        // opens): the panel teardown disposes it so a write pending when the
        // whole /settings overlay closes can never repaint or toast after
        // the panel is gone (review round 6).
        let allowlistMenu: SubagentModelAllowlistPicker | undefined
        // Whether the /settings overlay is still mounted: a late allowlist
        // settle after the WHOLE panel closed must still update the (detached)
        // row for bookkeeping, but must not schedule a repaint of a surface
        // that no longer exists.
        let settingsOpen = true
        legacyEditorOpen = true
        // A live palette switch must re-bake the Web rows' cached chips.
        releaseWebThemeListener?.()
        releaseWebThemeListener = app.onThemeChanged(() => {
          if (!legacyEditorOpen) return
          repaintWebItems?.()
          app.requestRender()
        })
        // The return path belongs to THIS open: the Web launcher restores the
        // Workspace on its own row, while the compatibility entry keeps the
        // original conversation return.
        webReturnToWorkspace = targetId === WEB_LAUNCHER_TARGET_ROW
        // The section snapshots its items BEFORE the mounted read settles:
        // entering it starts from `Loading…`, never from the last-known value.
        if (webSettingsAvailable()) beginWebSettingsRead()
        const webItems = webSettingItems()
        const closeSettings = app.openSettings(
          [
            // The independent session approval override exists only where the
            // backend can actually read AND write it. On a backend without the
            // capability the row is OMITTED: rendering the consumer's own `ask`
            // default would present an unavailable policy as a real one
            // (§9.2/§10).
            ...liveScope === undefined || !runner.config.permissions.approvalOverrideAvailable() ? [] : [{
              id: 'approval',
              label: 'Approval policy (this session)',
              description: 'How tool approvals are handled in this session',
              currentValue: runner.currentApprovalOverride(liveScope) ?? 'ask',
              values: ['ask', 'never'],
            }],
            ...permissionNames.length > 0 ? [{
              id: 'default-permission',
              label: 'Default permission',
              description: `Preset new sessions start with (persisted; ${keyHint('app.permission.cycle')} cycles this session)`,  // keysLabel? no — keyHint
              currentValue: defaultPermission ?? permissionNames[0] ?? '',
              values: permissionNames,
            }] : [],
            // The OFFICIAL subagent model-selection preference (DSH's
            // `subagent-model-selection` section): when enabled, a NEW
            // session's `subagent` tool may pick a child provider/model from
            // the allowlist below. Sampled at session composition — turning
            // it on never rewrites an already-running session's tools. The
            // ALLOWLIST row comes FIRST: the UI order expresses the setup
            // dependency (configure allowed routes, then enable selection).
            ...(subagentSectionWritable() && runner.catalog.models.available()) ? (() => {
              const subagentSelection = runner.config.subagentModelSelection.get()
              // The allowlist row's value is owned by the SUBMENU: a write
              // settling after the submenu closed must converge the displayed
              // summary through `summarize` (the fork rejects a `done` callback
              // once the submenu generation advanced), without re-opening it.
              const allowlistRow = {
                id: 'subagent-model-allowlist',
                label: 'Subagent allowed models',
                description: 'The child LLM routes the official subagent tool may pick from',
                currentValue: allowlistSummary(subagentSelection.allowedModels),
                submenu: (_currentValue: string, done: (selected?: string) => void) => {
                  const menu = new SubagentModelAllowlistPicker({
                    // C2-R3: the OLD editor's allowlist picker writes through the
                    // SAME command-owner FIFO as the workspace picker and toggle —
                    // no second concurrent section queue, no bare `set()` bypass.
                    selection: queuedSubagentSelection(),
                    catalog: runner.catalog.models,
                    notify: (message, kind) => app.notify(message, kind),
                    requestRender: () => app.requestRender(),
                    done,
                    summarize: (value) => {
                      allowlistRow.currentValue = value
                      // Suppress the repaint once the WHOLE panel closed: the
                      // row update above is inert bookkeeping, but a scheduled
                      // render would repaint a surface the user already left.
                      if (settingsOpen) app.requestRender()
                    },
                    runOwned: (label, task, options) => {
                      runOwned(label, task, {
                        diag: runner.diag,
                        sessionId: () => runner.currentSessionId,
                        ...options,
                      })
                    },
                  })
                  allowlistMenu = menu
                  return menu
                },
              }
              return [allowlistRow, {
                id: 'subagent-model-selection',
                label: 'Subagent model selection',
                description: 'Let new sessions pick a child provider/model in the subagent tool (official DSH setting; needs at least one allowed route)',
                currentValue: subagentSelection.enabled ? 'on' : 'off',
                values: ['off', 'on'],
              }]
            })() : [],
            {
              id: 'theme',
              label: 'Theme',
              description: 'Palette: auto follows the terminal; custom from ~/.dsh-pi-tui/themes',
              // M5: plugin-registered themes (ThemeRegistry) join the
              // picker's built-in auto/dark/light + custom list. The theme
              // row DISPLAYS the friendly name; the picker is an in-place
              // submenu (the fork's SettingItem.submenu slot — the /model
              // pattern) whose row ids ARE the SOURCE-QUALIFIED selectable
              // values (`auto|dark|light`, `file:<name>`,
              // `plugin:<owner>/<id>` — the review's P2: a plugin theme must
              // never share the value namespace of a custom FILE of the same
              // name, and the identity is carried end-to-end, never
              // round-tripped through the display label). The submenu
              // receives the runner's own synchronous `lastThemeChoice`
              // IDENTITY (never the fork's outer currentValue — that string
              // is the FRIENDLY DISPLAY, purely presentational after the
              // updateValue rewrite, and a display-label comparison would
              // let a same-named row from ANOTHER source steal the
              // `[current]` state chip — the review's P3). A re-open after a
              // successful pick sees the committed identity; a FAILED pick
              // keeps the previous one.
              currentValue: themeDisplayName,
              submenu: (_currentValue, done) => new ThemeSubmenu(lastThemeChoice, runner.extensions?.themes, (picked) => {
                if (picked !== undefined) done(picked)
                else done()
              }),
            },
            {
              id: 'icon-style',
              label: 'Icon style',
              description: 'Choose between emoji, compact symbols, or minimal structural markers',
              // The fallback applies HERE too: an invalid/missing persisted
              // value must never render as a row outside the values list.
              currentValue: iconStyleOf(settingsDoc?.iconStyle),
              values: ['emoji', 'symbols', 'minimal'],
            },
            {
              id: 'expand',
              label: 'Transcript detail',
              description: 'Bulk expansion for recent collapsible transcript content',
              currentValue: app.isTranscriptDetailExpanded() ? 'expanded' : 'collapsed',
              values: ['collapsed', 'expanded'],
            },
            {
              id: 'thinking',
              label: 'Thinking detail',
              description: 'Default detail level for reasoning blocks; blocks stay visible',
              currentValue: app.isThinkingExpanded() ? 'expanded' : 'collapsed',
              values: ['collapsed', 'expanded'],
            },
            {
              id: 'footer',
              label: 'Status line',
              description: 'Footer layout: default (full), compact (stats line hidden), or custom (see /footer)',
              currentValue: app.getFooterMode(),
              values: ['default', 'compact', 'custom'],
            },
            {
              id: 'busy-enter',
              label: 'Submit while busy',
              description: `Steer injects the draft into the running turn; ${keyHint('app.input.submitAccelerated')} uses the other behavior`,
              currentValue: settingsDoc?.busyEnter ?? 'queue',
              values: ['queue', 'steer'],
            },
            {
              id: 'local-shell-sandbox',
              label: 'User shell sandbox policy',
              description: 'When Host user-shell execution is available, ! / !! run outside the dsh sandbox (bypass, default) or under the sandbox policy',
              currentValue: settingsDoc?.localShellSandbox ?? 'bypass',
              values: ['bypass', 'sandbox'],
            },
            {
              id: 'home-end-keys',
              label: 'Home/End keys',
              description: 'Input: Home/End move within the input; Ctrl+Home/End scroll the conversation. Viewport: Home/End scroll the conversation; Ctrl+Home/End move within the input',
              // The fallback applies HERE too: an invalid persisted value
              // must never render as a row outside the values list (round-1
              // finding).
              currentValue: homeEndKeysModeOf(settingsDoc?.homeEndKeys),
              values: ['input', 'viewport'],
            },
            {
              id: 'display-preset',
              label: 'Display',
              description: 'Transcript disclosure preset; Focus collapses intermediate activity into a live Thought block, Compact folds contiguous process into Activity spans',
              currentValue: displayPresetOf(runner),
              values: ['full', 'compact', 'focus'],
            },
            {
              id: 'progress-updates',
              label: 'Progress updates',
              description: 'Off: no progress narration; Milestones: update only at substantial phase boundaries (default); Frequent: keep me informed during longer work. Focus suppresses progress-only intermediate messages without changing this saved preference.',
              currentValue: runner.progressUpdatesState.mode,
              values: ['off', 'milestones', 'frequent'],
            },
            {
              id: 'response-style',
              label: 'Response style',
              description: 'Default: no extra answer-style guidance; Concise: compact and result-first; Explanatory: more rationale, architecture, and tradeoffs',
              currentValue: runner.responseStyleState.style,
              values: ['default', 'concise', 'explanatory'],
            },
            {
              id: 'notification-mode',
              label: 'Notifications',
              description: 'When to notify that the main agent finished: Unfocused (default) — only while the terminal is not focused; Always — whenever the main agent settles; Off — disable completion notifications',
              currentValue: parseNotificationMode(settingsDoc?.notificationMode),
              values: ['unfocused', 'always', 'off'],
            },
            {
              id: 'notification-method',
              label: 'Notification method',
              description: 'How the completion notification is delivered: Auto (default) — OSC 9 / OSC 777 / bell by terminal; OSC 9; OSC 777; Bell',
              currentValue: parseNotificationMethod(settingsDoc?.notificationMethod),
              values: ['auto', 'osc9', 'osc777', 'bell'],
            },
            {
              id: 'terminal-progress',
              label: 'Terminal progress',
              description: 'Native terminal status: 9;4+7501 (default) reports both the OSC 9;4 progress bar and the OSC 7501 semantic state (working, waiting for input, done, error); 9;4 reports only the progress-bar compatibility protocol; 7501 reports only the semantic state; Off clears and suppresses both.',
              // An invalid persisted value must never render as a row outside
              // the values list: the parser resolves it to the default (a
              // retired `on` value resolves to the dual-protocol default too).
              currentValue: parseTerminalProgressMode(settingsDoc?.terminalProgress),
              values: ['9;4+7501', '9;4', '7501', 'off'],
            },
            {
              id: 'fullscreen',
              label: 'Fullscreen',
              description: 'Alt-screen mode: on keeps the terminal clean (default); off keeps the scrollback',
              currentValue: app.isFullscreen() ? 'on' : 'off',
              values: ['off', 'on'],
            },
            {
              id: 'wheel-scroll-lines',
              label: 'Mouse wheel lines',
              description: 'Number of transcript lines moved per mouse-wheel event in fullscreen; applies on the next fullscreen entry',
              // The fallback applies HERE too: an invalid/missing persisted
              // value must never render as a row outside the values list.
              currentValue: String(wheelScrollLinesOf(settingsDoc?.wheelScrollLines)),
              values: [...WHEEL_SCROLL_LINE_VALUES],
            },
            {
              id: 'git-attribution',
              label: 'Git attribution',
              description: 'Off (default): no guidance; Product: instruct the Agent to add the official Co-Authored-By trailer; Product+model: also add Assisted-By provider/model. Prompt guidance only — no Git hooks, and presets with a complete persona (minimal) receive no TUI prompt guidance',
              currentValue: runner.gitAttributionState.mode,
              values: ['off', 'product', 'product-model'],
            },
            // ── read-only session facts ─────────────────────────────
            {
              id: 'separator',
              label: color.border('─'.repeat(24)),
              currentValue: '',
            },
            ...liveScope === undefined ? [] : (() => {
              // The routing facts come from the exact owner the scope pins
              // (the facade refuses a stale scope).
              const routing = runner.currentSessionRouting(liveScope)
              return [
                {
                  id: 'session',
                  label: color.textDim('Session'),
                  description: color.textDim(liveScope.sessionId),
                  currentValue: color.textDim(displaySessionId(liveScope.sessionId)),
                },
                {
                  id: 'model',
                  label: color.textDim('Model'),
                  description: color.textDim('Provider and model routing this session'),
                  // `provider`/`model` are optional in the DSH AgentOptions
                  // contract: an unconfigured owner renders as such instead of
                  // failing the whole panel.
                  currentValue: color.textDim(
                    routing.provider === undefined || routing.model === undefined
                      ? 'unconfigured'
                      : `${routing.provider}/${routing.model}`,
                  ),
                },
                {
                  id: 'preset',
                  label: color.textDim('Agent preset'),
                  description: color.textDim('Composition this session runs on (see /preset)'),
                  currentValue: color.textDim(runner.currentPreset() ?? 'none'),
                },
              ]
            })(),
            {
              id: 'cwd',
              label: color.textDim('Working directory'),
              description: color.textDim('The live session workspace (follows session switches)'),
              currentValue: color.textDim(runner.sessionCwd()),
            },
            // ── S2/PR-B §3.3: Web Search / Fetch ──────────────────────
            ...webItems,
            keyboardShortcutsRow,
            // ── M5: plugin-registered settings rows ───────────────────
            ...(runner.extensions?.settings.rows() ?? []).map(row => ({
              id: `ext-setting:${row.id}`,
              label: row.label,
              description: row.description,
              currentValue: row.currentValue,
              ...(row.values.length > 0 ? { values: [...row.values] } : {}),
            })),
          ],
          (id, value, revert, navigate) => {
            if (id === 'approval') {
              if ((value === 'ask' || value === 'never') && liveScope !== undefined) {
                // The write is REFUSED when the panel's captured owner no longer
                // owns the surface: close the stale panel and tell the user,
                // instead of dispatching the old scope to the replacement owner.
                if (runner.setSessionApprovalPolicy(liveScope, value) === 'superseded') {
                  closeSettings()
                  app.notify('the session changed — the approval policy was not applied', 'error')
                  return
                }
                // The footer's permission badge derives from the knob folds;
                // reflect the change immediately.
                runner.refreshStatus()
              }
            } else if (id === 'default-permission') {
              if (permissionNames.includes(value)) {
                detach('permission default write', () => runner.config.permissions.setDefaultPreset(value) as Promise<unknown>, { notify: true })
              }
            } else if (id === 'subagent-model-selection') {
              // The OFFICIAL section write (never a TUI-owned copy). This row
              // owns the `enabled` half ONLY: the route list is re-read from the
              // FRESH section INSIDE the shared command-owner queue, so a picker
              // write that lands while this toggle waits is preserved.
              // Enabling with an empty allowlist stays a SETUP PRECONDITION:
              // zero official writes, the row rolls back and the cursor moves to
              // the allowlist row.
              if (value === 'on' || value === 'off') {
                const current = runner.config.subagentModelSelection.get()
                const previous = current.enabled ? 'on' : 'off'
                const desired = value === 'on'
                // The empty-allowlist decision is made ONLY inside the queue
                // (below), against the FRESH section. An early read would race
                // every pending section intent in BOTH directions: it would miss
                // a route a queued write is about to remove, and it would refuse
                // an enable whose route a queued write is about to add — dropping
                // the user's intent instead of ordering it behind that write.
                // C2-R3: the ONE command-owner section queue (shared with the
                // workspace toggle and BOTH pickers). The chained settlement runs
                // as ONE owned task and re-syncs the row to the committed state.
                detach('subagent model selection write', async () => {
                  let refusedEmpty = false
                  try {
                    await queueSubagentSectionEdit<void>(
                      (fresh) => {
                        if (desired && fresh.allowedModels.length === 0) {
                          // SETUP PRECONDITION against the FRESH section: zero
                          // official writes, the row rolls back and the cursor
                          // moves to the allowlist row — never a generic write
                          // failure for a precondition the UI can explain.
                          refusedEmpty = true
                          return undefined
                        }
                        return { enabled: desired, allowedModels: fresh.allowedModels.map(route => ({ ...route })) }
                      },
                      () => undefined,
                    )
                    if (refusedEmpty) {
                      // SETUP PRECONDITION, not a write failure: zero official
                      // writes happened, the row rolls back and the cursor moves
                      // to the row that grants the missing route.
                      revert(runner.config.subagentModelSelection.get().enabled ? 'on' : 'off')
                      app.notify('Select at least one Subagent allowed model before enabling model selection.', 'info')
                      navigate?.('subagent-model-allowlist')
                      return
                    }
                    // Re-sync to the committed state (a later toggle may have
                    // superseded this one).
                    revert(runner.config.subagentModelSelection.get().enabled ? 'on' : 'off')
                  } catch (error) {
                    revert(previous)
                    app.notify(`subagent model selection write failed: ${safeErrorMessage(error)}`, 'error')
                  }
                }, { notify: false })
              }
            } else if (id === 'theme') {
              // The submenu fires onChange with the SOURCE-QUALIFIED selectable
              // value DIRECTLY (the row id IS the identity — the review's P2:
              // no display-label round-trip, so an HMR unload between open
              // and confirm can never redirect the selection to a same-named
              // new contribution). The value is applied and persisted as-is.
              //
              // TRANSACTIONAL CHOICE COMMIT (the review's P2): the fork's
              // SettingsList already wrote the RAW selected value into the
              // outer row BEFORE this callback runs, so a FAILED selection
              // (the contribution unloaded between open and confirm — the
              // HMR window — or an apply error) must roll the visible row
              // AND `lastThemeChoice` back to the previous choice. A failed
              // pick can never fake a current selection (the next re-open
              // would mark a row that was never applied) and can never steal
              // an in-flight `auto` detection whose guard reads
              // `lastThemeChoice`.
              const qualified = value
              if (qualified !== undefined) {
                const previousChoice = lastThemeChoice
                // SUCCESS only: persist the choice, commit it, and rewrite
                // the fork's raw write back to the FRIENDLY label (the
                // openSettings updateValue seam — the row must never show a
                // raw `plugin:owner/id`, and a re-open must mark the right
                // row). EVERY branch persists through here — builtins
                // included (the review's P1: moving the write inside the
                // file/plugin branch would silently stop persisting
                // auto/dark/light and the next start would restore the old
                // theme).
                const commit = (): void => {
                  const settings = tuiSettings
                  if (settings !== undefined) {
                    // Spread the current doc: a replace is wholesale, so the
                    // other preference keys must ride along. The persisted
                    // value IS the source-qualified identity.
                    detach('settings theme write', () => serializeTuiSettingsMutation(
                      settings,
                      () => settings.replace(withUserFooterCustomItems({ ...settings.get(), theme: qualified }, runner.config)),
                    ), { notify: true })
                  }
                  lastThemeChoice = qualified
                  // The runtime owner's shared intent: a boot/reload detection or a live
                  // scheme report must not colour over this choice either.
                  app.noteThemeSelection(qualified)
                  revert(themeDisplayNameOf(qualified, runner.extensions?.themes))
                }
                // FAILURE only: restore the PREVIOUS choice's friendly
                // display; `lastThemeChoice` stays untouched.
                const rollback = (): void => {
                  revert(themeDisplayNameOf(previousChoice, runner.extensions?.themes))
                }
                if (qualified === 'auto') {
                  // The settled detection applies only while the preference is
                  // STILL auto — a late result must never override a theme the
                  // user picked while the query was in flight (rapid cycling).
                  // The guard reads the synchronous lastThemeChoice, NOT the
                  // persisted doc (whose write is asynchronous and may lag the
                  // query settlement by hundreds of ms). `auto` has no
                  // fallible apply step (starting the detection IS the
                  // apply): the choice commits BEFORE the query starts, so
                  // the guard already sees the new choice if a reply raced
                  // in synchronously.
                  app.clearActivePluginTheme()
                  commit()
                  detach('theme autodetect', () => app.autoDetectTheme({
                    shouldApply: () => lastThemeChoice === 'auto',
                  }))
                  app.trackTerminalTheme(true)
                } else if (qualified === 'dark' || qualified === 'light') {
                  try {
                    app.clearActivePluginTheme()
                    app.applyTheme(qualified)
                    app.trackTerminalTheme(false)
                  } catch (error) {
                    app.notify(`theme ${value} failed: ${safeErrorMessage(error)}`, 'error')
                    rollback()
                    return
                  }
                  commit()
                } else {
                  // M5: a plugin-registered theme applies through the host's
                  // applyPalette (the ONLY application path — the registry
                  // never applies itself). Custom files resolve as before.
                  // SOURCE-QUALIFIED resolution (the review's P2): a `file:`
                  // value resolves the FILE, a `plugin:` value resolves the
                  // registry — a bare name can never be a selection identity.
                  const selection = resolveThemeSelection(qualified, runner.extensions?.themes)
                  // VALUE-addressed (the unified theme protocol — the health
                  // bridge resolves the selectable value only).
                  const themeRef = captureExtensionHealthRef?.('theme', qualified)
                  if (selection === undefined) {
                    // A stale selection (the source unloaded between open and
                    // confirm): notify, record health, roll the row AND the
                    // choice back — never commit.
                    if (themeRef !== undefined) recordExtensionError?.(themeRef, new Error('theme not found'))
                    app.notify(`theme ${value} not found`, 'error')
                    rollback()
                    return
                  }
                  try {
                    // A PLUGIN palette records the selection (the unload
                    // fallback restores builtin dark when it disappears);
                    // a custom FILE clears it.
                    if (selection.kind === 'plugin') app.applyPluginPalette(selection.value, selection.palette)
                    else {
                      app.clearActivePluginTheme()
                      app.applyPalette(selection.palette)
                    }
                    if (themeRef !== undefined) clearExtensionError?.(themeRef)
                    app.trackTerminalTheme(false)
                  } catch (error) {
                    if (themeRef !== undefined) recordExtensionError?.(themeRef, error)
                    app.notify(`theme ${value} failed: ${safeErrorMessage(error)}`, 'error')
                    rollback()
                    return
                  }
                  commit()
                }
              }
            } else if (id.startsWith('ext-setting:')) {
              // M5: a plugin-registered settings row change. The row's own
              // onChange decides acceptance; the panel value follows the
              // accepted value. Detached (AGENTS.md — never a bare void).
              // The fork optimistically mutated the row BEFORE this callback:
              // on rejection, revert() restores the previous DISPLAYED value
              // so the open panel never shows a value the registry rejected.
              const extSettings = runner.extensions?.settings
              const settingId = id.slice('ext-setting:'.length)
              const previous = extSettings?.rows().find(row => row.id === settingId)?.currentValue
              if (extSettings !== undefined) {
                // Captured BEFORE the async apply starts: an HMR reload may
                // replace this id with a new owner while onChange is in
                // flight — the settlement must report against the INVOKING
                // owner, never the reloaded one (the review's P2 fence).
                const settingRef = captureExtensionHealthRef?.('setting', settingId)
                detach('extension setting apply', () => extSettings.applyDetailed(settingId, value).then(outcome => {
                  if (outcome === 'rejected') {
                    // ONLY a real plugin rejection is a failure: record
                    // health, revert the optimistic row and notify. A
                    // 'stale' outcome (a newer apply superseded this one)
                    // or 'gone' (the row was disposed mid-apply) is NOT a
                    // plugin refusal — recording/reverting/notifying would
                    // be a false alarm that rolls the panel back from the
                    // value the user actually sees (the review's P2).
                    if (settingRef !== undefined) recordExtensionError?.(settingRef, new Error('setting rejected'))
                    if (previous !== undefined) revert(previous)
                    app.notify('setting rejected', 'error')
                  } else if (outcome === 'accepted') {
                    if (settingRef !== undefined) clearExtensionError?.(settingRef)
                  }
                }).catch(error => {
                  if (settingRef !== undefined) recordExtensionError?.(settingRef, error)
                  throw error
                }))
              }
            } else if (id === 'expand') {
              app.setTranscriptDetailExpanded(value === 'expanded')
            } else if (id === 'thinking') {
              // The declarative surface sets the SHARED bulk preference —
              // `/settings` and Alt+T are the same state (plan §10.4).
              app.setThinkingExpanded(value === 'expanded')
            } else if (id === 'footer') {
              if (value === 'default' || value === 'compact' || value === 'custom') {
                const settings = tuiSettings
                if (settings !== undefined) {
                  // footerFallbackMode records the LAST NATIVE mode (M5):
                  // `footer` is overwritten by 'command' when the command
                  // surface arms, so the command failure fallback must be
                  // able to recover THIS choice (a compact user's fallback
                  // survives a restart). Read and replace inside the shared
                  // transaction so a concurrent whole-document writer cannot
                  // be overwritten by this stale panel snapshot.
                  // PERSIST FIRST (the configurator's discipline): the app
                  // applies only from the successful write — a failed
                  // settings write must not leave the live layout ahead of
                  // the document (the next reload would silently revert).
                  detach('settings footer write', async () => {
                    if (app.isDisposed()) return
                    const next = await serializeTuiSettingsMutation(settings, async () => {
                      if (app.isDisposed()) return undefined
                      const doc = settings.get()
                      // Selecting custom with no (valid) layout initializes an
                      // editable copy of the default layout (plan §14.8).
                      const layout = value === 'custom'
                        ? !isFooterLayout(parseFooterLayout(doc.footerLayout))
                          ? DEFAULT_FOOTER_LAYOUT
                          : doc.footerLayout
                        : doc.footerLayout
                      // Preserve the detached USER value, not a merged/project
                      // projection, while the whole-document write is queued.
                      const raw = runner.config.footerCustomItems.rawForPersistence()
                      if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
                      await settings.replace({ ...doc, footer: value, footerLayout: layout, footerFallbackMode: value, footerCustomItems: raw.value })
                      return { layout, customItems: raw.value }
                    })
                    if (app.isDisposed() || next === undefined) return
                    runner.applyFooterSettings({ footer: value, footerLayout: next.layout, footerCustomItems: next.customItems })
                  }, { notify: true })
                } else {
                  runner.applyFooterSettings({ footer: value })
                }
              }
            } else if (id === 'busy-enter') {
              if (value === 'queue' || value === 'steer') {
                const settings = tuiSettings
                if (settings !== undefined) {
                  detach('settings busy enter write', () => serializeTuiSettingsMutation(
                     settings,
                     () => settings.replace(withUserFooterCustomItems({ ...settings.get(), busyEnter: value }, runner.config)),
                   ), { notify: true })
                }
              }
            } else if (id === 'icon-style') {
              if (value === 'emoji' || value === 'symbols' || value === 'minimal') {
                // The visual preference applies FIRST — the UI must not wait
                // for disk persistence (same policy as theme/focus). A
                // persistence failure keeps this session's preference and
                // notifies through the shared error policy; the next start
                // restores the persisted value.
                app.setIconStyle(value)
                const settings = tuiSettings
                if (settings !== undefined) {
                  detach('settings icon style write', () => serializeTuiSettingsMutation(
                     settings,
                     () => settings.replace(withUserFooterCustomItems({ ...settings.get(), iconStyle: value }, runner.config)),
                   ), { notify: true })
                }
              }
            } else if (id === 'local-shell-sandbox') {
              if (value === 'bypass' || value === 'sandbox') {
                const settings = tuiSettings
                if (settings !== undefined) {
                  detach('settings user-shell sandbox policy write', () => serializeTuiSettingsMutation(
                     settings,
                     () => settings.replace(withUserFooterCustomItems({ ...settings.get(), localShellSandbox: value }, runner.config)),
                   ), { notify: true })
                }
              }
            } else if (id === 'home-end-keys') {
              if (value === 'input' || value === 'viewport') {
                // Issue #9: apply immediately (no restart, no fullscreen
                // round-trip) and persist.
                applyHomeEndKeyMode(value)
                const settings = tuiSettings
                if (settings !== undefined) {
                  detach('settings home end keys write', () => serializeTuiSettingsMutation(
                     settings,
                     () => settings.replace(withUserFooterCustomItems({ ...settings.get(), homeEndKeys: value }, runner.config)),
                   ), { notify: true })
                }
              }
            } else if (id === 'display-preset') {
              if (value === 'full' || value === 'compact' || value === 'focus') {
                applyDisplayPreset(runner, value)
              }
            } else if (id === 'progress-updates') {
              const mode = parseProgressUpdates(value)
              runner.progressUpdatesState.mode = mode
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings progress updates write', () => serializeTuiSettingsMutation(
                  settings,
                  () => settings.replace(withUserFooterCustomItems({ ...settings.get(), progressUpdates: mode }, runner.config)),
                ), { notify: true })
              }
            } else if (id === 'response-style') {
              const style = parseResponseStyle(value)
              runner.responseStyleState.style = style
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings response style write', () => serializeTuiSettingsMutation(
                  settings,
                  () => settings.replace(withUserFooterCustomItems({ ...settings.get(), responseStyle: style }, runner.config)),
                ), { notify: true })
              }
            } else if (id === 'git-attribution') {
              const mode = parseGitAttributionMode(value)
              runner.gitAttributionState.mode = mode
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings git attribution write', () => serializeTuiSettingsMutation(
                  settings,
                  () => settings.replace(withUserFooterCustomItems({ ...settings.get(), gitAttribution: mode }, runner.config)),
                ), { notify: true })
              }
            } else if (id === 'notification-mode') {
              if (value === 'unfocused' || value === 'always' || value === 'off') {
                // Apply to the runtime controller FIRST (the next settle
                // already uses the new policy), then persist best-effort
                // through the shared whole-document transaction.
                runner.setNotificationMode(value)
                const settings = tuiSettings
                if (settings !== undefined) {
                  detach('settings notification mode write', () => serializeTuiSettingsMutation(
                    settings,
                    () => settings.replace(withUserFooterCustomItems({ ...settings.get(), notificationMode: value }, runner.config)),
                  ), { notify: true })
                }
              }
            } else if (id === 'notification-method') {
              if (value === 'auto' || value === 'osc9' || value === 'osc777' || value === 'bell') {
                runner.setNotificationMethod(value)
                const settings = tuiSettings
                if (settings !== undefined) {
                  detach('settings notification method write', () => serializeTuiSettingsMutation(
                    settings,
                    () => settings.replace(withUserFooterCustomItems({ ...settings.get(), notificationMethod: value }, runner.config)),
                  ), { notify: true })
                }
              }
            } else if (id === 'terminal-progress') {
              const mode = parseTerminalProgressMode(value)
              // Apply to the runtime surface FIRST (the physical projection
              // changes now), then persist best-effort through the shared
              // whole-document transaction — the existing settings contract.
              runner.setTerminalProgressMode(mode)
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings terminal progress write', () => serializeTuiSettingsMutation(
                  settings,
                  () => settings.replace(withUserFooterCustomItems({ ...settings.get(), terminalProgress: mode }, runner.config)),
                ), { notify: true })
              }
            } else if (WEB_SETTING_ROW_IDS.has(id)) {
              // The Web provider rows: ONE serialized write entry per section,
              // reconciled from the authoritative read-back (see
              // queueWebSettingWrite). The endpoint row is owned by its
              // exclusive submenu, which already wrote and verified before it
              // closed, so its commit carries no second write.
              const write = webWriteFor(id as WebSettingRowId, value)
              if (write === undefined) {
                if (id === 'web-search-endpoint') return
                revert(webRowValue(id as WebSettingRowId))
                return
              }
              queueWebSettingWrite(id as WebSettingRowId, value, write, revert)
            } else if (id === 'fullscreen') {
              if (value === 'off' || value === 'on') {
                app.setFullscreen(value === 'on')
                // setFullscreen reports through onFullscreenChange, which
                // persists the same field (this branch is the panel write).
              }
            } else if (id === 'wheel-scroll-lines') {
              // v1 semantics: the fork's wheelScrollLines is a
              // constructor-time alt-screen option, so the preference
              // applies on the NEXT fullscreen mount (a change while
              // fullscreen is active takes effect on re-entry — never a
              // private-field hack on the live alt screen). Persist through
              // the shared whole-document transaction.
              const lines = wheelScrollLinesOf(value)
              app.setWheelScrollLines(lines)
              const settings = tuiSettings
              if (settings !== undefined) {
                detach('settings wheel scroll lines write', () => serializeTuiSettingsMutation(
                  settings,
                  () => settings.replace(withUserFooterCustomItems({ ...settings.get(), wheelScrollLines: String(lines) }, runner.config)),
                ), { notify: true })
              }
            }
          },
          () => {
            // Esc: close without writing. The allowlist submenu is disposed
            // with the panel — a write pending when the whole /settings
            // overlay closes must not repaint or toast after teardown
            // (review round 6). `settingsOpen` gates the summarize repaint.
            settingsOpen = false
            legacyEditorOpen = false
            allowlistMenu?.dispose()
            // S2/PR-B §B3.4: leaving the Web section restores the Settings
            // Workspace on the Web launcher row; the compatibility entry keeps
            // its original conversation return. Reopening is SYNCHRONOUS — a
            // late async settle never revives a closed surface.
            if (webReturnToWorkspace) {
              webReturnToWorkspace = false
              reopenSettingsWorkspaceAtWebRow()
            }
          },
          // Teardown-aware: a fullscreen screen swap (or any other hide path)
          // removes the panel WITHOUT the Esc cancel, so the mounted state must
          // also flip there — otherwise a late allowlist settle would schedule
          // a repaint of a surface that no longer exists.
          () => {
            settingsOpen = false
            legacyEditorOpen = false
            releaseWebThemeListener?.()
            releaseWebThemeListener = undefined
          },
          {
            // S2/PR-B §3.3: the Web section deeplink + the authoritative
            // read-back for rows whose facts settle asynchronously.
            ...targetId === undefined ? {} : { initialItemId: targetId },
            onMounted: (rows) => {
              if (!webSettingsAvailable()) return
              detach('web provider settings refresh', async () => {
                await rereadWebSettings()
                if (!legacyEditorOpen) return
                for (const rowId of WEB_SETTING_ROW_IDS) {
                  rows.setValue(rowId, webRowValue(rowId as WebSettingRowId))
                }
                rows.setValue(WEB_CREDENTIAL_ROW_ID, webCredentialValue())
                repaintWebItems?.()
                app.requestRender()
              }, { notify: false })
            },
          },
        )
        closeLegacyEditor = closeSettings
        // Every Web row is reconciled from the live authority state on each
        // settle: the state chips and the `Current:` fact never come from the
        // request, only from the read-back.
        repaintWebItems = () => {
          if (!settingsOpen) return
          for (const item of webItems) {
            if (item.id === WEB_CREDENTIAL_ROW_ID) {
              item.currentValue = webCredentialValue()
              item.valueParts = webCredentialParts()
              item.description = `Current: ${webCredentialValue()} · The credential reference the DeepSeek Search / Fetch APIs resolve (${WEB_CREDENTIAL_REF}); the value is never shown and is stored by the official credential store. Configure… runs the existing masked /login ${WEB_CREDENTIAL_REF}; Clear… runs /logout ${WEB_CREDENTIAL_REF}. The editor closes before either command runs.`
              continue
            }
            if (item.id === 'web-separator') continue
            const rowId = item.id as WebSettingRowId
            // The row's VISIBLE state comes from `valueParts`; `currentValue`
            // stays the row's CYCLE cursor — the value the Host holds, never a
            // transient verdict word (the fork positions a cycle on this field).
            item.currentValue = webSettledValue(rowId) ?? ''
            item.valueParts = webRowValueParts(rowId)
            item.description = webRowDescription(rowId)
            if (rowId === 'web-search-provider' || rowId === 'web-fetch-provider') {
              // The cycle list follows the SETTLED authority: it appears once a
              // verified value is selectable and disappears for a custom route.
              item.values = providerRowValues(rowId)
            }
          }
          app.requestRender()
        }
        app.requestRender()
        return { kind: 'success' }
  }

  /**
   * `/settings` — Phase 3B / B2-A: enter the readonly fullscreen Settings
   * workspace. The legacy complete editor stays reachable through each
   * configuration category's transition launcher row, which retires the
   * workspace FIRST and then calls {@link openLegacySettings} on the restored
   * surface.
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
  const registerFooter = (): void => {
    registerTuiCommand({
      name: 'footer',
      description: 'Configure the footer layout interactively',
      aliases: ['statusline'],
      handler: () => {
        const settings = runner.tuiSettings
        const doc = settings?.get()
        // The configurator starts from the CURRENT EFFECTIVE layout: the
        // persisted custom layout when active, else whatever the composer
        // renders right now — getEffectiveFooterLayout() maps the active
        // MODE (default/compact/custom). The old `getFooterLayout() ??
        // DEFAULT` fallback lost the compact mode: a compact user opening
        // /footer and pressing Enter unchanged would have saved the full
        // two-row default as their custom layout (the review's P2).
        const persisted = doc !== undefined && doc.footer === 'custom' ? parseFooterLayout(doc.footerLayout) : undefined
        const initial = persisted !== undefined && isFooterLayout(persisted)
          ? persisted
          : app.getEffectiveFooterLayout()
        // Layer the draft catalog over the live app registry. Unsaved create /
        // edit / rename / delete operations stay inside this catalog, so Esc
        // cannot mutate the active footer or its persisted definitions.
        const registry = new FooterItemRegistry(app.getFooterItemRegistry())
        const customItems = new FooterCustomItemCatalog(app.getFooterCustomItems())
        // PR D preview contract (§14): the preview NEVER executes a command.
        // A draft command item shows the committed cache ONLY while its
        // definition is unchanged (same command/refresh/timeout/tone) — a
        // modified draft must not pretend the old cache is the new command's
        // result — and the dim `[command]` placeholder otherwise.
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
        app.openFooterConfigurator({
          model,
          registry,
          composer,
          onSave: async (layout, draftCustomItems) => {
            // PR E contract: RESOLVE = persisted + applied (the overlay then
            // closes); THROW = failed — the configurator stays open with the
            // draft intact, and THIS layer owns the user-facing notify.
            //
            // Validate the draft (the model's operations keep it well-formed,
            // but the persisted value is never trusted).
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
            if (settings !== undefined) {
              // Persist FIRST; the memory commit happens only after the
              // settings write succeeds (plan §15.7 — a failed write keeps
              // the old layout and definitions). footerFallbackMode rides
              // ALONG: the /settings path records the last native mode, and
              // saving a custom layout IS a native-mode change — the command
              // surface's restart fallback must resolve to THIS custom layout.
              try {
                await serializeTuiSettingsMutation(settings, async () => {
                  if (app.isDisposed()) return
                  // `/footer` intentionally edits the custom-definition
                  // collection, but it only owns the v1 text entries this client
                  // understands. Re-read the detached USER value at the commit
                  // point so queued saves do not erase intervening future data.
                  const raw = runner.config.footerCustomItems.rawForPersistence()
                  if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
                  const persistedCustomItems = mergeFooterCustomItemsForSave(raw.value, savedCustomItems)
                  await settings.replace({
                    ...settings.get(),
                    footer: 'custom',
                    footerFallbackMode: 'custom',
                    footerLayout: parsed,
                    footerCustomItems: persistedCustomItems,
                  })
                })
              } catch (error) {
                if (!app.isDisposed()) {
                  app.notify(`footer layout save failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
                }
                throw error
              }
              if (app.isDisposed()) return
              app.setFooterCustomItems(savedCustomItems)
              runner.applyFooterSettings({ footer: 'custom', footerLayout: parsed, footerCustomItems: savedCustomItems }, savedCustomItems)
              app.notify('footer layout saved', 'info')
            } else {
              // No settings backend: the memory commit IS the save (PR E
              // §9.3) — resolve into an immediate close.
              app.setFooterCustomItems(savedCustomItems)
              runner.applyFooterSettings({ footer: 'custom', footerLayout: parsed, footerCustomItems: savedCustomItems }, savedCustomItems)
              app.notify('footer layout saved', 'info')
            }
          },
          onCancel: () => {
            // Esc: close without writing (the configurator's live preview
            // never touched the active layout).
          },
        })
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
      handler: (invocation) => {
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
        // Bare /keybindings opens the action-first editor. The historical
        // conflicts/reload/reset verbs above remain explicit diagnostics seams.
        let closeEditor: () => void = () => {}
        const panel = createKeybindingEditorPanel(() => closeEditor())
        if (panel === undefined) return { kind: 'error', text: 'settings service unavailable' }
        closeEditor = app.openKeybindingEditor(panel)
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
