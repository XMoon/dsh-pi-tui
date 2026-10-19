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
import { SettingsList } from '@xmoon76/pi-tui'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { TuiApp } from '../../tui-app.ts'
import { applyHomeEndKeyMode, homeEndKeysModeOf } from '../keybindings/home-end-mode.ts'
import { isDisplayPreset, isDisplayPresetAvailable, type DisplayPreset, type DisplayPresetApplyResult } from '../../domain/display/preset.ts'
import { parseProgressUpdates, parseResponseStyle } from '../../domain/communication/policy.ts'
import { parseGitAttributionMode } from '../../domain/communication/git-attribution.ts'
import { parseNotificationMethod, parseNotificationMode } from '../../domain/notification/settings.ts'
import { parseTerminalProgressMode } from '../../domain/terminal-progress/settings.ts'
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
import { serializeTuiSettingsMutation, type ConfigPort, type TuiSettingsDoc, type WebProviderSettings } from '../../runtime/config-port.ts'
import { WebCredentialPanel, WebEndpointPanel, WebWriteVerdictError, type WebCredentialAction } from '../panels/web-provider-panels.ts'
import type {
  SettingsWorkspaceCommitOutcome,
  SettingsWorkspaceCommitRequest,
  SettingsWorkspaceEdit,
  SettingsWorkspaceEditOption,
  SettingsWorkspaceFreshness,
  SettingsWorkspaceRowId,
  SettingsWorkspaceSnapshot,
  SettingsWorkspaceWritableField,
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
  | 'captureLiveSessionScope'
  | 'catalog'
  | 'clientCommands'
  | 'config'
  | 'createPluginManagerPage'
  | 'currentApprovalOverride'
  | 'currentPreset'
  | 'currentSessionId'
  | 'currentSessionRouting'
  | 'diag'
  | 'displayPreset'
  | 'extensions'
  | 'focusEnabled'
  | 'gitAttributionState'
  | 'progressUpdatesState'
  | 'refreshStatus'
  | 'responseStyleState'
  | 'sessionCwd'
  | 'setDisplayPreset'
  | 'setFocusMode'
  | 'setNotificationMethod'
  | 'setNotificationMode'
  | 'setTerminalProgressMode'
  | 'setSessionApprovalPolicy'
  | 'tuiSettings'
>

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
  /** The `Other`-category launcher row id (a NAVIGATION row: it never becomes a
   *  Workspace editable field, so the `2 editable rows` count is unchanged). */
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
          ? `Current: ${current} · Messages is the official default and does not call the billed Search API. DeepSeek Search API is opt-in and separately billed (a Messages plan does not cover it); with Share Original Question on (default), up to 128 characters of the triggering question are sent as ori_question. The choice applies to the next search. Esc returns to the Workspace.`
          : `Current: ${current} · The configured search provider is a custom route: it is displayed as-is and is not selectable here. The official candidates are Messages and DeepSeek Search API.`
      case 'web-fetch-provider':
        return providerSelectable(WEB_FETCH_PROVIDER_VALUES, webSettings?.fetchProvider)
          ? `Current: ${current} · HTTP is the official anonymous default. DeepSeek Fetch API is opt-in and separately billed (a Messages plan does not cover it). The choice applies to the next fetch.`
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
        return `Current: ${current}${kept === undefined ? '' : ` · the Host keeps "${kept}"`} · The API base the DeepSeek Search and Fetch APIs call (/search and /fetch are appended); base-owned, not an Optional Bundle. Changing it sends the credential and query there; only a trusted https base is accepted.`
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
    const description = 'Host Web settings for the base profile, not an Optional Bundle. Defaults: Messages search · HTTP fetch; other bundles never change them and the defaults call no billed API. The Search/Fetch APIs are billed separately as opt-in providers (a Messages plan does not cover them) and send the request to the configured endpoint. Share Original Question is on by default: it sends up to 128 characters of the human question (never the full history or system prompt). The key stays in the official credential reference and is never shown. A value reads Verified only after the Host write and authoritative read-back agree. Enter configure.'
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

  const openSettingsWorkspaceAt = (initialRowId?: SettingsWorkspaceRowId): void => {
    const token = {}
    // The panel snapshots its source in its CONSTRUCTOR, so the pending state
    // must be in place before the lease is taken.
    if (webSettingsAvailable()) beginWebSettingsRead()
    let handle: import('../../tui-app.ts').SettingsWorkspaceHandle | undefined
    handle = app.openSettingsWorkspace(
      {
        readSnapshot: readSettingsWorkspaceSnapshot,
        onRefresh: () => { startWebSettingsRead(token) },
      },
      {
        onOpenLegacy: (targetId) => { openLegacySettings(targetId) },
        onOpenPlugins: (done) => runner.createPluginManagerPage(done),
        onCommit: commitSettingsWorkspaceField,
        ...(initialRowId === undefined ? {} : { initialRowId }),
        onClose: () => {
          if (activeSettingsWorkspace?.token === token) activeSettingsWorkspace = undefined
        },
      },
    )
    activeSettingsWorkspace = { token, refreshWebRow: () => handle?.refreshRow(WEB_LAUNCHER_ROW_ID, webWorkspaceRowFacts()) }
    startWebSettingsRead(token)
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
   * Phase 3B / B2-B: the authoritative re-read of ONE committed field. `expected`
   * is the value the authority must return for the commit to count as verified; a
   * non-`ready` backend, an unreadable document or a different value is EXPLICIT
   * (never silently reported as saved). A theme value is compared after the
   * canonical normalization (a legacy `custom:X` document still means `file:X`);
   * a display preset is compared exactly.
   */
  /** The persisted value of one writable field, or undefined when unreadable. */
  const persistedValueOf = (field: SettingsWorkspaceWritableField): string | undefined => {
    const settings = runner.tuiSettings
    if (settings === undefined) return undefined
    let doc: TuiSettingsDoc
    try {
      doc = settings.get()
    } catch {
      return undefined
    }
    return field === 'theme' ? normalizePersistedTheme(doc.theme) : doc.displayPreset
  }

  /** The structured authoritative readback of ONE committed field. */
  type CommittedReadback =
    | { readonly kind: 'agrees' }
    | { readonly kind: 'differs'; readonly actual: string | undefined }
    | { readonly kind: 'unavailable'; readonly reason: string }

  const readCommittedField = (field: SettingsWorkspaceWritableField, expected: string): CommittedReadback => {
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
    const actual = field === 'theme' ? normalizePersistedTheme(doc.theme) : doc.displayPreset
    return actual === expected ? { kind: 'agrees' } : { kind: 'differs', actual }
  }

  const verifyCommittedField = (
    field: SettingsWorkspaceWritableField,
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
    field: SettingsWorkspaceWritableField,
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
   * Phase 3B / B2-B: commit ONE writable Settings-workspace field. The runtime
   * fact applies through its EXISTING owner first (the established
   * apply-first policy), then the persistence commits through the SAME
   * whole-document serialization + USER-custom-item preservation guard every
   * other settings writer uses, and finally the value is re-read from the
   * authority: only a completed write whose re-read agrees is `verified`.
   *
   * The Display preset deliberately does NOT go through the runner's
   * `setDisplayPreset` (which would dispatch a SECOND detached best-effort
   * write): it applies the runtime fact through the same `TuiApp` DisplayState
   * owner the `/display`/`/focus` commands use and persists exactly once here.
   */
  const commitSettingsWorkspaceField = async (
    request: SettingsWorkspaceCommitRequest,
  ): Promise<SettingsWorkspaceCommitOutcome> => {
    const outcome = request.field === 'display-preset'
      ? await commitDisplayPreset(request.value)
      : await commitTheme(request.value)
    if (outcome.outcome !== 'verified') {
      // The write OWNER records the real failure/uncertainty: the workspace's
      // settlement is deliberately dropped once its screen lease is gone, and a
      // dispatched write must stay diagnosable either way (§3/§5.5 — never a
      // silently lost failure). The value is a theme/display name, never a secret.
      runner.diag.warn('settings write', {
        field: request.field,
        value: request.value,
        outcome: outcome.outcome,
        ...outcome.reason === undefined ? {} : { reason: outcome.reason },
      })
    }
    return outcome
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
   * document, the runtime display preset and the Client presentation preference —
   * and assembles the five fixed pilot rows; the two writable rows additionally
   * carry their candidate source and the runtime/persisted facts. It captures NO
   * shadow store: a missing document is `unavailable` (never a persisted
   * default), a stale backend keeps the document as `last-known`, and a throwing
   * `get()` is the row's explicit `read-error`.
   */
  const readSettingsWorkspaceSnapshot = (): SettingsWorkspaceSnapshot => {
    const configReadiness = runner.config.configReadiness()
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
    const persistedTheme = doc === undefined ? undefined : normalizePersistedTheme(themeRaw)
    const runtimePreset = displayPresetOf(runner)
    const persistedPreset = doc?.displayPreset
    const thinking = app.isThinkingExpanded() ? 'expanded' : 'collapsed'
    // The persisted fact is only a fact once the document was actually READ:
    // an absent document or a throwing read is an UNKNOWN persistence state,
    // never "read and not configured".
    const persistedNote = doc !== undefined
      ? `Persisted preference: ${persistedPreset ?? 'not set'} (last read from the TUI settings document — not the current runtime value).`
      : readIssue !== undefined
        ? `Persisted preference unknown — the TUI settings document could not be read (${readIssue}).`
        : 'Persisted preference unknown — no authoritative TUI settings document is available.'
    return {
      configReadiness,
      capturedAt: Date.now(),
      ...(readIssue === undefined ? {} : { readIssue }),
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
          id: 'icon-style',
          category: 'appearance',
          label: 'Icon style',
          summary: doc === undefined ? unavailableNote : iconStyleOf(iconRaw),
          ...(doc === undefined ? {} : { value: iconRaw }),
          scope: 'TUI settings document',
          freshness: configuredFreshness,
          description: doc === undefined
            ? 'The glyph vocabulary for structural icons. This preview only reads the configured value.'
            : 'The glyph vocabulary for structural icons (tools, subagents, disclosures). The raw configured value is preserved even when it normalizes to a built-in style.',
          action: 'inspect',
        },
        {
          id: 'display-preset',
          category: 'display',
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
          id: 'thinking',
          category: 'display',
          label: 'Thinking detail',
          summary: thinking,
          value: thinking,
          scope: 'Current TUI display state',
          freshness: 'runtime',
          description: 'Whether reasoning blocks render expanded or collapsed. A Client runtime presentation preference, not a persisted Host value.',
          action: 'inspect',
        },
        {
          id: 'legacy-settings',
          category: 'other',
          label: 'Open existing settings…',
          summary: 'Existing settings editor',
          scope: 'Existing settings editor',
          freshness: 'ready',
          description: 'Opens the existing complete settings editor; returns to the conversation when closed.',
          action: 'open-legacy',
        },
        {
          // S2/PR-B §3.3: the ONE discoverable entry to the Web provider
          // settings section. The row opens the EXISTING legacy editor focused
          // on that section's first row (the same editor as the compatibility
          // row above; no second settings framework).
          id: WEB_LAUNCHER_ROW_ID,
          category: 'other',
          label: 'Web Search / Fetch',
          ...webWorkspaceRowFacts(),
          scope: 'Host Web provider settings',
          action: 'open-legacy',
          legacyTargetId: 'web-search-provider',
        },
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
        // Serialized whole-section writes for the subagent model-selection
        // toggle: rapid toggles commit in order (a slow earlier write can
        // never land after a newer one), and every settle re-syncs the row
        // to the ACTUAL committed state (review round 2).
        let subagentModelWriteChain: Promise<void> = Promise.resolve()
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
            ...(runner.config.subagentModelSelection.available() && runner.catalog.models.available()) ? (() => {
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
                    selection: runner.config.subagentModelSelection,
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
              // The OFFICIAL section write (never a TUI-owned copy). The
              // whole current allowlist rides along; enabling with an empty
              // allowlist is refused by the official rule (the Direct
              // adapter fails fast with the official message and the Host
              // validates again at the section boundary). Writes are
              // SERIALIZED (the payload is captured at toggle time, so the
              // last toggle wins) and every settle re-syncs the row to the
              // ACTUAL committed state — a rejected write rolls back, and a
              // superseded success never leaves a stale display.
              if (value === 'on' || value === 'off') {
                const current = runner.config.subagentModelSelection.get()
                const previous = current.enabled ? 'on' : 'off'
                const desired = value === 'on'
                // EMPTY-ALLOWLIST UX GATE: enabling with no allowed routes
                // is a SETUP PRECONDITION, not a write failure. Skip the
                // official write entirely (no Host settings mutation), keep
                // the row off, and guide the user to configure the allowlist
                // first — the ConfigPort/Host validation stays as the
                // fail-closed boundary for non-UI callers (the TUI never
                // auto-fills the allowlist: it is the user's explicit grant
                // of which child routes the subagent tool may use).
                if (desired && current.allowedModels.length === 0) {
                  revert(previous)
                  app.notify('Select at least one Subagent allowed model before enabling model selection.', 'info')
                  navigate?.('subagent-model-allowlist')
                  return
                }
                subagentModelWriteChain = subagentModelWriteChain
                  .then(() => runner.config.subagentModelSelection.set({
                    enabled: desired,
                    allowedModels: current.allowedModels,
                  }))
                  .then(
                    () => {
                      // Re-sync to the committed state (a later toggle may
                      // have superseded this one).
                      revert(runner.config.subagentModelSelection.get().enabled ? 'on' : 'off')
                    },
                    (error: unknown) => {
                      revert(previous)
                      app.notify(`subagent model selection write failed: ${safeErrorMessage(error)}`, 'error')
                    },
                  )
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
   * workspace. The legacy complete editor stays reachable through the
   * workspace's `Other settings` → `Open existing settings…` row, which retires
   * the workspace FIRST and then calls {@link openLegacySettings} on the
   * restored surface.
   */
  const registerSettings = (): void => {
    registerOne({
      name: 'settings',
      description: 'Open the TUI settings workspace',
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
    // the existing `/status` command — the AGENTS near-synonym rule usually
    // forbids that, and it stays forbidden for NEW independent commands —
    // but as an EXPLICIT alias of `/footer` the pairing is unambiguous:
    // `/status` keeps priority matching (a bare `status` input always
    // resolves to the session-status command), `/statusline` resolves to
    // the footer configurator, and the completion catalog shows both with
    // the alias marked "(alias of /footer)". The alias rides the same
    // LOCAL/SESSIONLESS ownership sets, so it never steers while busy.
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
  return { registerSettings, registerFooter, registerDisplay, registerFocus, registerKeybindings }
}
