/**
 * SettingsRuntime (A5b-2, plan §A5b-2): the ONE owner of the footer/display
 * settings behaviour and the boot display application.
 *
 * Ownership:
 *
 * - the footer warning latches (custom-item, layout-fallback and the one-shot
 *   USER-layer trust diagnostic) and the footer command runner / unsubscribe /
 *   dynamic-item runtime lifetime;
 * - `applyFooterSettings` (mode + layout + custom items + the trusted command
 *   surface, with USER-layer trust only);
 * - `setDisplayPreset` (the /display | /focus mutation + persistence path);
 * - user keybindings (parse + apply) and the boot display/theme application;
 * - the USER-layer custom-footer-items projection the save path consumes.
 *
 * The module is deliberately neutral: it imports no Host session/agent package
 * and performs no Host lookup. The Direct settings adapter, the semantic config
 * port and the extension theme registry arrive as narrow injected capabilities,
 * so the Direct adapter stays the only place that maps official semantics onto
 * the in-process implementation.
 * @module @xmoon76/dsh-pi-tui/app/surface/settings-runtime
 */

import { runDetached } from '../../runtime/process/tasks.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'
import { serializeTuiSettingsMutation } from '../../runtime/config-port.ts'
import { isDisplayPresetAvailable, resolveDisplayPreset, type DisplayPreset, type DisplayPresetApplyResult } from '../../domain/display/preset.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { isFooterLayout, parseFooterLayout, resolveCommandFooterFallback } from '../../domain/footer/layout.ts'
import { activeFooterItemIds, executableCommandItemIds, parseFooterCustomItems, type FooterCustomCommandItemSettings, type FooterCustomItemSettings } from '../../domain/footer/custom-items.ts'
import { normalizePersistedTheme } from '../../domain/display/theme-selection.ts'
import { resolveThemeSelection } from './theme-selection.ts'
import { wheelScrollLinesOf } from '../../domain/display/wheel-scroll.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { TuiApp } from '../../tui-app.ts'
import type { Backend } from '../../runtime/backend.ts'
import type { StatusSnapshot } from '../../domain/status/types.ts'

/** The Direct settings document read (the adapter stays in the composition
 *  root); the type is DERIVED from the real persistence helper so this owner
 *  can never drift from the document contract. */
export type SettingsDocLike = Parameters<typeof serializeTuiSettingsMutation>[0]

/** The footer settings document the apply path reads. */
export type FooterSettingsDoc = { readonly footer: string; readonly footerLayout?: unknown; readonly footerCustomItems?: unknown }

/** The extension theme registry the boot display reads (official registry,
 *  injected so this owner never reaches the extension service itself). The
 *  NAME-addressed lookup stays a narrow structural read — never the concrete
 *  registry class. */
export interface BootThemeExtensions {
  readonly themes: NonNullable<Parameters<typeof resolveThemeSelection>[1]> & {
    /** The source-qualified selectable value behind one plugin display NAME
     *  (the Phase-4 advanced host-state `setTheme(name)` contract). */
    selectableValueForName(name: string): string | undefined
  }
  _recordRegistryHealthRef(kind: string, id: string): unknown
  _clearRegistryError(ref: unknown): void
  _recordRegistryError(ref: unknown, error: unknown): void
}

/** The narrow surface capabilities the settings owner needs: the mounted app
 *  and the status store the footer command items subscribe/commit through. */
export interface SettingsSurface {
  readonly app: TuiApp
  readonly status: {
    snapshot(): StatusSnapshot
    subscribe(listener: () => void): () => void
  }
}

/** The narrow semantic config slice the footer settings read. */
export interface SettingsConfigPort {
  readonly config: Pick<Backend['config'], 'footerCommandTrust' | 'footerCustomItems'>
}

/** The narrow capabilities the settings owner consumes. */
export interface SettingsRuntimeDeps {
  /** The mounted app + the status store the footer command items use. */
  readonly surface: SettingsSurface
  /** The runner lifetime signal (the footer command runners share it). */
  readonly signal: AbortSignal
  readonly tuiSettings: SettingsDocLike
  /** Persistence-availability gate only (the Direct forms adapter stays in the
   *  composition root; the owner never calls it). */
  readonly settingsForms: unknown
  /** True once the runner is disposing: a detached write's notify is skipped. */
  readonly isCleanedUp: () => boolean
  /** The semantic config port slice the footer settings read. */
  readonly backend: SettingsConfigPort
  readonly diag: Diag
  readonly status: { refresh(): void }
  readonly extensions: () => BootThemeExtensions | undefined
}

/** The settings owner as the rest of the application consumes it. */
export interface SettingsRuntime {
  /** Apply the RESTORED display preferences before the first frame. */
  applyBootDisplay(): void
  /** The persisted busy-Enter preference (a TUI input preference the settings
   *  document owns; consumers read it here rather than through a lifecycle bag). */
  busyEnter(): string | undefined
  /** Apply the persisted footer settings (mode/layout/custom items/commands);
   *  `doc` defaults to the CURRENT settings document. */
  applyFooterSettings(doc?: FooterSettingsDoc, savedCustomItems?: readonly FooterCustomItemSettings[]): void
  /** Apply one user keybinding configuration read. */
  applyUserKeybindings(): void
  /** Switch the display preset (the /display | /focus mutation + persistence). */
  setDisplayPreset(preset: DisplayPreset): DisplayPresetApplyResult
  /** Persist one fullscreen toggle (the `onFullscreenChange` write path; the
   *  live UI transition itself is the app's). */
  setFullscreen(fullscreen: boolean): void
  /** Apply one advanced (plugin) theme by NAME: map the name to its
   *  source-qualified selectable value, apply the palette and track the theme
   *  health slot (Phase 4 host-state contract). */
  applyAdvancedTheme(name: string): void
  /** Record one extension callback health transition (editor/keybinding slots). */
  recordExtensionError(slot: string, id: string, error: unknown): void
  /** Clear one extension callback health transition. */
  clearExtensionError(slot: string, id: string): void
  /** The USER-layer custom footer items the save path persists (the raw
   *  persistence projection of the config port). */
  userFooterItemsForSave(): unknown
  /** The env-driven safe-keybindings mode (boot). */
  applySafeKeybindingsMode(): void
  /** The terminal-resize hook: refresh the armed footer command runner. */
  requestFooterCommandRefresh(): void
  /** Release the footer command runner + dynamic-item runtime (disposal). */
  disposeFooterCommand(): void
}

/** Create the settings owner (plan §A5b-2). */
export function createSettingsRuntime(deps: SettingsRuntimeDeps): SettingsRuntime {
  // Whole-document settings writes must not copy a project-layer
  // footerCustomItems value into the USER section. The config port is the
  // only source allowed to supply definitions for a non-/footer write.
  // Declare this before mounting the TUI: fullscreen initialization can
  // synchronously invoke its persistence callback. Use the raw USER value so
  // unknown/future definitions survive unrelated writes unchanged.
  
  const userFooterCustomItemsForSave = (): unknown => {
    const raw = deps.backend.config.footerCustomItems.rawForPersistence()
    if (raw.kind === 'unavailable') throw new Error('custom footer definitions unavailable; settings write aborted')
    return raw.value
  }

  // The Task Browser handle/token, the Job-viewer closer and the jobs-event
  // subscription are A4-6 surface-owned (`surface.attachTasks` +
  // `surface.disposeJobEvents` / `disposeJobObservation` / `disposeTaskBrowser`);
  // the runner no longer holds their slots.
  // M5/TS5: the footer command RESOURCES (the whole-footer runner, its status
  // subscription and the per-item runners) are owned by the TUI footer runtime
  // (`tui/footer/runtime.ts`); this owner drives them through the narrow
  // mounted-surface capabilities. The TuiApp field exists from construction, so
  // the startup-eager `onTerminalResize` read can never hit a temporal dead
  // zone (the former reason these slots were hoisted here).

  // M3: the user-orchestrable keybinding manager (the app built it with
  // the builtin defaults). Apply safe mode, the persisted user
  // overrides, and the plugin contributions — all fail-soft (a bad entry
  // is a diagnostic, never a startup failure; plan §16/§17).
  
  const applyUserKeybindings = (): void => {
    // Fail-soft reload (review finding): a transient settings read
    // error must never abort the startup application — the failure is
    // a diagnostic. The catch is also the net for errors thrown AFTER
    // the rebuild succeeded: HostKeybindingManager.rebuild() is ordered
    // keymap-first, invalidate-last, so a throwing UI invalidation (a
    // startup-eager callback — the footer-command slot TDZ was exactly
    // this) leaves the NEW keymap active. The diagnostic must not claim
    // a last-known-good rollback that did not happen; /keybindings
    // reload re-applies from the document either way. The TUI owns the
    // parse/apply semantics (TS5 §12); the diagnostics ride the same sink
    // order as before the move.
    try {
      deps.surface.app.applyUserKeybindings(
        deps.tuiSettings?.get().keybindings,
        (message) => deps.diag.warn('keybindings', { message }),
      )
    } catch (error: unknown) {
      deps.diag.warn('keybindings', { error: String(error), message: 'keybindings startup apply failed — the error may come from the post-rebuild UI invalidation, so the keymap may already be rebuilt; /keybindings reload re-applies it' })
    }
  }

  // M2: apply the persisted footer mode + layout to the app. `full` and
  // `default` map to the builtin default layout, `compact` to the
  // compact layout, `custom` parses footerLayout (fail-soft: an invalid
  // config warns ONCE and falls back to the default — the TUI always
  // starts). Never writes the document back on a read-only migration.
  // M5: `command` arms the trusted command surface (the trust gate reads
  // the USER layer only — a project-supplied config is refused).
  
  let footerWarningShown = false

  let customFooterWarningShown = false

  // PR D: the one-shot trust diagnostic latch — a layout reference to a
  // command definition that only exists in a non-USER layer is reported
  // ONCE (bounded), never per repaint.
  
  let footerCommandItemWarningShown = false
  /**
   * Whether THIS runtime has handed the per-item command runners to a mounted
   * `TuiApp` (the `footer: command` boot). Only the runtime arms them, so an
   * unarmed runtime — the TSP renderer branch, or a teardown before the boot
   * applied the stored document — has NO Pi footer resource to release, and the
   * teardown must not read an app that does not exist there.
   */
  let footerCommandArmed = false

  const disableFooterCommand = (): void => {
    deps.surface.app.disableFooterCommand()
    footerCommandArmed = false
  }

  const busyEnter = (): string | undefined => deps.tuiSettings?.get().busyEnter
  const applyFooterSettings = (
    doc: { footer: string; footerLayout?: unknown; footerCustomItems?: unknown } | undefined,
    savedCustomItems?: readonly FooterCustomItemSettings[],
  ): void => {
    if (doc === undefined) return
    // The merged document's footerCustomItems field is pass-through storage
    // only. Normal startup/reload/settings reads use the ConfigPort's
    // USER-layer semantic resolver; the optional second argument is supplied
    // only by the validated /footer save after its write succeeds, so the
    // just-committed draft is applied without trusting merged project data.
    const customResult = savedCustomItems === undefined
      ? deps.backend.config.footerCustomItems.get()
      : { items: savedCustomItems, invalidCount: 0 }
    deps.surface.app.setFooterCustomItems(customResult.items)
    if (customResult.invalidCount > 0 && !customFooterWarningShown) {
      customFooterWarningShown = true
      deps.surface.app.notify(`${customResult.invalidCount} custom footer item${customResult.invalidCount === 1 ? '' : 's'} invalid — skipped`, 'error')
    }
    // The USER-layer footer trust read (mode + command + layout): the
    // adapter owns the settings descriptor access — a Remote adapter
    // replays the same facts from the wire.
    const trust = deps.backend.config.footerCommandTrust
    // PR D: arm the per-item command runners for the EXECUTABLE ids —
    // USER trusted definitions ∩ USER-authorized activation ids ∩
    // currently rendered layout ids. The runtime receives ONLY the
    // USER-layer trusted definitions (never the merged/project value);
    // the authorized ids come from the ConfigPort's mode-gated
    // projection (a stale leftover USER layout under footer:
    // default/compact authorizes nothing); the rendered intersection
    // stops a command hidden by the merged layout from running in the
    // background. The one-shot diagnostic covers the §11.2 attack
    // shape: a RENDERED layout reference to a command definition that
    // only exists in a non-USER layer renders unavailable, with ONE
    // bounded notice.
    const syncDynamicCommandItems = (authorizedIds: ReadonlySet<string>): void => {
      const trustedCommands = customResult.items
        .filter((item): item is FooterCustomCommandItemSettings => item.kind === 'command')
      // The TUI runtime reconciles the per-item runners against the trusted
      // definitions, the USER-authorized ids and the CURRENT effective layout.
      deps.surface.app.syncFooterCommandItems(trustedCommands, authorizedIds, deps.signal)
      footerCommandArmed = true
      if (!footerCommandItemWarningShown) {
        const mergedCommands = parseFooterCustomItems(doc.footerCustomItems).items
          .filter((item): item is FooterCustomCommandItemSettings => item.kind === 'command')
        const trustedIds = new Set(trustedCommands.map(item => item.id))
        // The diagnostic watches the RENDERED layout (what the user
        // sees), not the executable set: a rendered ref to a command
        // definition that only exists in a non-USER layer is
        // unavailable and reported once.
        const renderedIds = activeFooterItemIds(deps.surface.app.getEffectiveFooterLayout())
        const untrustedReferenced = mergedCommands.some(item => renderedIds.has(item.id) && !trustedIds.has(item.id))
        if (untrustedReferenced) {
          footerCommandItemWarningShown = true
          deps.surface.app.notify('a custom command item is not user-configured — not running it', 'error')
        }
      }
    }
    if (doc.footer === 'command') {
      // The native FALLBACK layout must be established from the
      // PERSISTED document, never from whatever the memory happens to
      // hold: at STARTUP the memory is still the builtin default. The
      // fallback MODE comes from footerFallbackMode — the `footer`
      // field itself is overwritten by 'command', so the user's last
      // native mode is persisted separately (a compact user's fallback
      // must survive a restart as compact, never silently become the
      // full default — the review's P2). The switch is COMPLETE:
      // 'default' and an invalid custom layout explicitly restore the
      // builtin default, so a runtime reload with a changed document
      // never falls back to whatever the memory happened to hold.
      const fallback = resolveCommandFooterFallback(doc)
      if (fallback.mode === 'compact') {
        deps.surface.app.setFooterPreset('compact')
        deps.surface.app.setFooterLayout(undefined)
      } else {
        deps.surface.app.setFooterPreset('full')
        deps.surface.app.setFooterLayout(fallback.mode === 'custom' ? fallback.layout : undefined)
      }
      // The trust gate: the COMMAND must live in the USER layer of the
      // settings descriptor (never the merged/project value), AND the
      // command MODE must be user-layer-owned — a project flipping the
      // merged `footer: command` must never silently trigger the user's
      // command (plan §17.4). The trust read goes through the CONFIG
      // PORT (the adapter owns the settings descriptor access — a
      // Remote adapter replays the same facts from the wire).
      const config = trust.command
      const userMode = trust.userFooterMode
      if (config === undefined || userMode !== 'command') {
        disableFooterCommand()
        if (!footerWarningShown) {
          footerWarningShown = true
          deps.surface.app.notify('footer command is not user-configured — using the native layout', 'error')
        }
        // The native layout is the user's own (default/compact/custom):
        // never reset it — the command surface overrides the composer
        // only while commandRows is set, and the M5 fallback contract
        // restores the LAST native layout on failure. The fallback
        // layout IS visible, but the authorization follows the USER's
        // CURRENT mode: only a USER who opted into command mode
        // (userMode === 'command') may fall back per their own
        // footerFallbackMode (the fallback property itself is fully
        // gated — empty for any other mode); a USER whose current mode
        // is custom authorizes per their current layout, and a
        // default/compact USER authorizes NOTHING — a PROJECT forcing
        // the merged command mode can never turn stale fallback
        // metadata into execution authorization.
        const authorizedIds = userMode === 'command'
          ? trust.userCommandItemFallbackActivationIds
          : trust.userCommandItemActivationIds
        syncDynamicCommandItems(authorizedIds)
        return
      }
      // The TUI runtime arms (or re-arms) the whole-footer runner, wires its
      // status subscription and suspends the per-item runners it covers. The
      // native layout stays untouched while command mode is armed: a failed
      // command (undefined rows) falls back to the user's OWN
      // default/compact/custom layout, never the builtin default.
      deps.surface.app.applyFooterCommandConfig(config, deps.signal)
      footerCommandArmed = true
      return
    }
    disableFooterCommand()
    if (doc.footer === 'compact') {
      deps.surface.app.setFooterPreset('compact')
      deps.surface.app.setFooterLayout(undefined)
      syncDynamicCommandItems(trust.userCommandItemActivationIds)
      return
    }
    if (doc.footer === 'custom') {
      const parsed = parseFooterLayout(doc.footerLayout)
      if (!isFooterLayout(parsed)) {
        if (!footerWarningShown) {
          footerWarningShown = true
          deps.surface.app.notify(`footer layout invalid (${parsed.message}) — using the default layout`, 'error')
        }
        deps.surface.app.setFooterPreset('full')
        deps.surface.app.setFooterLayout(undefined)
        // The merged custom layout is invalid: the rendered footer is
        // the builtin default, and only the USER layer's own
        // current-mode authorization may activate custom command items.
        syncDynamicCommandItems(trust.userCommandItemActivationIds)
        return
      }
      deps.surface.app.setFooterPreset('full')
      deps.surface.app.setFooterLayout(parsed)
      // PR D activation trust: a /footer save's validated layout is the
      // trusted activation; every other path uses the USER layer's
      // declared layout — a PROJECT merged layout can render user:*
      // ids, but it can never activate a dormant USER command.
      syncDynamicCommandItems(savedCustomItems !== undefined
        ? activeFooterItemIds(parsed)
        : trust.userCommandItemActivationIds)
      return
    }
    // 'full' | 'default' | unknown → the builtin default layout.
    deps.surface.app.setFooterPreset('full')
    deps.surface.app.setFooterLayout(undefined)
    syncDynamicCommandItems(trust.userCommandItemActivationIds)
  }

  /** The unified DisplayPreset setter (plan §7): the runtime state and the TUI
   * surface mutate IMMEDIATELY (a persistence failure must never leave
   * the UI on the old state); the settings write is detached and
   * best-effort — a failure notifies and the next boot may restore the
   * old value. Every mutation path (`/display`, `/focus`, `/settings`)
   * goes through this — there is exactly one authoritative state (plan §5). */
  
  const setDisplayPreset = (preset: DisplayPreset): DisplayPresetApplyResult => {
    if (!isDisplayPresetAvailable(preset)) return { kind: 'unsupported', preset }
    const result = deps.surface.app.setDisplayPreset(preset)
    if (result.kind === 'unsupported') return result
    // The footer reads the store: repaint it right away after a live UI
    // transition (no session event is guaranteed to follow an idle toggle).
    // `unchanged` still means the canonical preset was accepted; it must
    // continue through persistence so a failed migration write can be
    // retried while the runtime is already on that preset.
    if (result.kind === 'applied') deps.status.refresh()
    const settings = deps.tuiSettings
    if (deps.settingsForms !== undefined) {
      runDetached('settings display preset write', () => serializeTuiSettingsMutation(
         settings,
         () => settings.replace({ ...settings.get(), footerCustomItems: userFooterCustomItemsForSave(), displayPreset: preset }),
       ), {
        diag: deps.diag,
        notify: (message) => deps.surface.app.notify(`display preset persistence failed: ${message}`, 'error'),
        recoverable: () => true,
      })
    }
    return result
  }

  /**
   * Persist one fullscreen toggle (the `onFullscreenChange` event seam). The
   * live UI transition already happened in the app; this is the best-effort
   * durable write, detached with the runner diag and the same custom-item
   * projection the display-preset write uses.
   */
  const setFullscreen = (fullscreen: boolean): void => {
    const settings = deps.tuiSettings
    if (deps.settingsForms !== undefined) {
      runDetached('settings fullscreen write', () => serializeTuiSettingsMutation(
        settings,
        () => settings.replace({ ...settings.get(), footerCustomItems: userFooterCustomItemsForSave(), fullscreen: fullscreen ? 'on' : 'off' }),
      ), {
        diag: deps.diag,
        notify: (message) => {
          if (deps.isCleanedUp()) return
          deps.surface.app.notify(message, 'error')
        },
        recoverable: () => true,
      })
    }
  }

  /**
   * Phase 4: apply one advanced host-state setTheme for a NON-built-in name
   * (a registered plugin theme). The path is NAME-addressed (the documented
   * Phase-4 contract), so the NAME maps to its SOURCE-QUALIFIED selectable
   * value FIRST (the value is what gets applied and health-tracked — a bare
   * name can never be a selection identity). Unknown names are a no-op.
   */
  const applyAdvancedTheme = (name: string): void => {
    const registry = deps.extensions()?.themes
    const selectable = registry?.selectableValueForName(name)
    if (selectable === undefined) return
    const palette = registry?.paletteForSelectable(selectable)
    if (palette === undefined) return
    // VALUE-addressed (the unified theme protocol).
    const themeRef = deps.extensions()?._recordRegistryHealthRef('theme', selectable)
    try {
      deps.surface.app.applyPluginPalette(selectable, palette)
      if (themeRef !== undefined) deps.extensions()?._clearRegistryError(themeRef)
    } catch (error) {
      if (themeRef !== undefined) deps.extensions()?._recordRegistryError(themeRef, error)
      deps.surface.app.notify(`theme ${name} failed: ${safeErrorMessage(error)}`, 'error')
    }
  }

  /** Record one extension callback health transition (M11 editor/keybinding slots). */
  const recordExtensionError = (slot: string, id: string, error: unknown): void => {
    try {
      const ref = deps.extensions()?._recordRegistryHealthRef(slot, id)
      if (ref !== undefined) deps.extensions()?._recordRegistryError(ref, error)
    } catch {}
  }

  /** Clear one extension callback health transition. */
  const clearExtensionError = (slot: string, id: string): void => {
    try {
      const ref = deps.extensions()?._recordRegistryHealthRef(slot, id)
      if (ref !== undefined) deps.extensions()?._clearRegistryError(ref)
    } catch {}
  }

  /**
   * Apply the RESTORED display preferences before the first frame: the
   * Home/End navigation preset, the wheel step, the fullscreen state and the
   * persisted theme (including the auto-detect/track policy). This runs at its
   * ORIGINAL startup position — after the mount, before any later boot step —
   * because the theme query must target the active alt screen and the wheel
   * step must precede the first fullscreen entry.
   */
  const applyBootDisplay = (): void => {
  // The Home/End preset is TUI-owned (TS5 §12): the application owner hands
  // the persisted raw value to the mounted surface.
  deps.surface.app.setHomeEndMode(deps.tuiSettings?.get().homeEndKeys)
  // The wheel step is a constructor-time alt-screen option: hand the
  // preference to the app BEFORE the first fullscreen entry, or the
  // first alt screen would still scroll 1 line per wheel event (the
  // order matters — never apply after setFullscreen).
  deps.surface.app.setWheelScrollLines(wheelScrollLinesOf(deps.tuiSettings?.get().wheelScrollLines))
  if (deps.tuiSettings?.get().fullscreen === 'on') deps.surface.app.setFullscreen(true)
  const storedTheme = deps.tuiSettings?.get().theme
  if (storedTheme === 'auto') {
    // Follow the terminal: query once at boot, then track scheme reports.
    // The boot query is detached: a terminal that never answers (or a
    // failure) must not crash the runner. The settled result applies only
    // while the preference is STILL auto — a boot-time detection must
    // never override a theme the user chose while the query was in flight.
    runDetached('theme autodetect', () => deps.surface.app.autoDetectTheme({
      shouldApply: () => deps.tuiSettings?.get().theme === 'auto',
    }), { diag: deps.diag })
    deps.surface.app.onTerminalThemeChange((theme) => {
      if (deps.tuiSettings?.get().theme === 'auto') deps.surface.app.applyTheme(theme)
    })
    // Ask for DSR 996 once: xterm-class terminals only start reporting
    // scheme changes after being queried.
    deps.surface.app.trackTerminalTheme(true)
  } else if (storedTheme === 'dark' || storedTheme === 'light') {
    deps.surface.app.applyTheme(storedTheme)
    deps.surface.app.trackTerminalTheme(false)
  } else if (storedTheme !== undefined && storedTheme !== '') {
    // Any non-builtin persisted theme. SOURCE-QUALIFIED resolution (the
    // review's P2): the persisted value is the identity — `file:<name>`
    // resolves the file, `plugin:<owner>/<id>` resolves the registry,
    // and the legacy `custom:<name>` / bare-name forms normalize to
    // `file:<name>` (existing documents keep working). A selection
    // whose source is gone (an unloaded plugin / deleted file) resolves
    // undefined and falls back to the built-in dark palette — never
    // silently to a same-named file (the M5 gate: selected theme unload
    // → built-in fallback).
    const qualified = normalizePersistedTheme(storedTheme)
    const selection = resolveThemeSelection(qualified, deps.extensions()?.themes)
    // VALUE-addressed (the unified theme protocol).
    const themeRef = deps.extensions()?._recordRegistryHealthRef('theme', qualified)
    if (selection !== undefined) {
      try {
        // A PLUGIN palette records the selection (the unload fallback
        // restores builtin dark when it disappears); a custom FILE
        // clears it.
        if (selection.kind === 'plugin') deps.surface.app.applyPluginPalette(selection.value, selection.palette)
        else {
          deps.surface.app.clearActivePluginTheme()
          deps.surface.app.applyPalette(selection.palette)
        }
        if (selection.kind === 'plugin' && themeRef !== undefined) deps.extensions()?._clearRegistryError(themeRef)
      } catch (error) {
        if (themeRef !== undefined) deps.extensions()?._recordRegistryError(themeRef, error)
        deps.surface.app.notify(`theme ${storedTheme} failed: ${safeErrorMessage(error)}`, 'error')
      }
    } else {
      // Neither a plugin theme nor a custom file: the selection is gone
      // (unloaded plugin) — fall back to the built-in dark palette. The
      // plugin selection is cleared TOO: a stale record must never
      // trigger a fallback when some unrelated theme unloads later
      // (the review's P2).
      deps.surface.app.clearActivePluginTheme()
      deps.surface.app.applyTheme('dark')
    }
    deps.surface.app.trackTerminalTheme(false)
  }
  }


  const userFooterItemsForSave = (): unknown => userFooterCustomItemsForSave()
  /** The env-driven safe-keybindings mode (the policy lives with the settings). */
  const applySafeKeybindingsMode = (): void => {
    if (process.env.DSH_PI_TUI_SAFE_KEYBINDINGS !== '1') return
    deps.surface.app.setSafeKeybindingsMode(true)
    deps.diag.info('keybindings', { safeMode: true })
  }
  const requestFooterCommandRefresh = (): void => { deps.surface.app.requestFooterCommandRefresh() }
  /**
   * Release the footer command runner + per-item runtime. The lifecycle abort
   * already disposes an armed runner through its own abort listener; the
   * explicit unsubscribe + dispose keeps the release symmetric with the arm
   * path. Every owner slot is retired before its callback runs, so a throwing
   * unsubscribe/runner disposal cannot strand its siblings (M3-6 PR3).
   */
  const disposeFooterCommand = (): void => {
    // Release only what this runtime actually ARMED: the runners live in the
    // mounted `TuiApp`, and a renderer branch without one (the TSP renderer) or
    // a teardown before the boot applied the document has no Pi footer resource
    // — reading the app there throws `the surface is not mounted` and turns a
    // legal exit into a recorded cleanup failure.
    if (!footerCommandArmed) return
    // The TUI footer runtime retires its own slots before their callbacks run
    // (the whole-footer runner, its status subscription and every per-item
    // runner), so no child/timer/abort listener survives.
    runSyncDisposalSteps('footer command disposal', [
      () => deps.surface.app.disposeFooterCommand(),
    ])
  }

  return {
    applyBootDisplay,
    busyEnter,
    applyFooterSettings: (doc, savedCustomItems) => applyFooterSettings(doc ?? deps.tuiSettings?.get(), savedCustomItems),
    applyUserKeybindings,
    setDisplayPreset,
    setFullscreen,
    applyAdvancedTheme,
    recordExtensionError,
    clearExtensionError,
    userFooterItemsForSave,
    applySafeKeybindingsMode,
    requestFooterCommandRefresh,
    disposeFooterCommand,
  }
}
