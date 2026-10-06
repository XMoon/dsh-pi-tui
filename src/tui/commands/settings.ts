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
import { SettingsList } from '@xmoon76/pi-tui'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { TuiApp } from '../../tui-app.ts'
import { applyHomeEndKeyMode, homeEndKeysModeOf } from '../../home-end-keys.ts'
import { isDisplayPresetAvailable, type DisplayPreset, type DisplayPresetApplyResult } from '../../display-preset.ts'
import { parseProgressUpdates, parseResponseStyle } from '../../communication-policy.ts'
import { parseGitAttributionMode } from '../../git-attribution.ts'
import { parseNotificationMethod, parseNotificationMode } from '../../notification/settings.ts'
import { WHEEL_SCROLL_LINE_VALUES, wheelScrollLinesOf } from '../../wheel-scroll.ts'
import { iconStyleOf } from '../../icons.ts'
import { parseUserKeybindings } from '../../keybindings/config.ts'
import { formatKeyId } from '../../keybindings/hints.ts'
import type { AppKeybindingId } from '../../keybindings/types.ts'
import { KeybindingEditorController } from '../../keybinding-ui/controller.ts'
import { KeybindingEditorPanel, KeybindingEditorUnavailablePanel } from '../../keybinding-ui/list.ts'
import type { KeybindingEditorModel } from '../../keybinding-ui/model.ts'
import { parseFooterLayout, isFooterLayout } from '../../footer/layout.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../../footer/presets.ts'
import { FooterComposer } from '../../footer/composer.ts'
import {
  FooterCustomItemCatalog,
  parseFooterCustomItem,
  parseFooterCustomItems,
  type FooterCustomItemSettings,
} from '../../footer/custom-items.ts'
import { FooterItemRegistry } from '../../footer/item-registry.ts'
import { FooterConfiguratorModel, sameFooterCustomItem } from '../../footer/configurator-model.ts'
import { runOwned } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { color } from '../../theme.ts'
import { ThemeSubmenu, themeDisplayName as themeDisplayNameOf } from '../pickers/theme-menu.ts'
import { SubagentModelAllowlistPicker, allowlistSummary } from '../pickers/subagent-model-menu.ts'
import { resolveThemeSelection, normalizePersistedTheme } from '../../theme-source.ts'
import { serializeTuiSettingsMutation, type ConfigPort, type TuiSettingsDoc } from '../../runtime/config-port.ts'
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
  | 'config'
  | 'createPluginManagerSubmenu'
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

  const registerSettings = (): void => {
    registerOne({
      name: 'settings',
      description: 'Open the TUI settings panel',
      handler: () => {
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
        // submenu's `← current` marker compares this identity against the
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
              // `← current` marker — the review's P3). A re-open after a
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
              label: color.border('─'.repeat(34)),
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
            keyboardShortcutsRow,
            // ── M5: plugin-registered settings rows ───────────────────
            ...(runner.extensions?.settings.rows() ?? []).map(row => ({
              id: `ext-setting:${row.id}`,
              label: row.label,
              description: row.description,
              currentValue: row.currentValue,
              ...(row.values.length > 0 ? { values: [...row.values] } : {}),
            })),
            // P1: lazy discovery entry into the SAME Plugin Manager surface.
            // Opening /settings never reads plugin inventory/registries — the
            // submenu factory runs only when the row is activated, and the
            // outer value is static (no eager counts in P1). Placed LAST so the
            // existing settings row order/index contract is unchanged.
            {
              id: 'plugins',
              label: 'Plugins',
              description: 'Manage DSH plugins and TUI extensions',
              currentValue: 'Manage…',
              submenu: (_currentValue: string, done: (selected?: string) => void) =>
                runner.createPluginManagerSubmenu(done),
            },
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
            allowlistMenu?.dispose()
          },
          // Teardown-aware: a fullscreen screen swap (or any other hide path)
          // removes the panel WITHOUT the Esc cancel, so the mounted state must
          // also flip there — otherwise a late allowlist settle would schedule
          // a repaint of a surface that no longer exists.
          () => { settingsOpen = false },
        )
        return { kind: 'success' }
      },
    })

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
  }
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
