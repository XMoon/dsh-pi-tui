/**
 * Built-in command definitions for the skill domain (/skill, /reload).
 *
 * The dynamic skill-wrapper/catalog state machine stays in the coordinator
 * (src/commands.ts); this module owns only the two static command definitions
 * and receives the coordinator's loadSkill/delivery/catalog primitives.
 * @module @xmoon76/dsh-pi-tui/tui/commands/skills
 */

import { SettingsList } from '@xmoon76/pi-tui'
import type { ComposerSubmitGesture, TuiApp } from '../../tui-app.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import type { HumanSkillCatalog } from '../../skill-catalog.ts'
import type { CatalogRefreshOutcome } from '../../skill-catalog-refresh.ts'
import { resolveThemeSelection, normalizePersistedTheme } from '../../theme-source.ts'
import type {
  DetachTask,
  LoadSkill,
  RegisterOne,
  SubmitDelivery,
  TuiCommandRunner,
} from '../../commands.ts'

/** The runner operations the static skill commands consume. */
type SkillsCommandRunner = Pick<
  TuiCommandRunner,
  | 'applyFooterSettings'
  | 'captureLiveSessionScope'
  | 'currentSessionActivity'
  | 'effectivePresetId'
  | 'extensions'
  | 'listScopedSkills'
  | 'refreshSessionCatalog'
  | 'refreshStandingCatalog'
  | 'requireLiveSessionScope'
  | 'signal'
  | 'tuiSettings'
>

export interface SkillsCommandDeps {
  runner: SkillsCommandRunner
  app: TuiApp
  registerOne: RegisterOne
  detach: DetachTask
  recordExtensionError: TuiCommandRunner['recordExtensionError']
  clearExtensionError: TuiCommandRunner['clearExtensionError']
  captureExtensionHealthRef: TuiCommandRunner['captureExtensionHealthRef']
  loadSkill: LoadSkill
  takeDelivery: () => SubmitDelivery | undefined
  splitSkillLine: (raw: string) => [string, ...string[]]
  resolveComposerDelivery: (
    running: boolean,
    gesture: ComposerSubmitGesture,
    busyEnter: string | undefined,
  ) => SubmitDelivery
}

/** /skill — load one skill into the live session (or pick from the catalog). */
export function registerSkillCommand(deps: SkillsCommandDeps): void {
  const { runner, app, registerOne, detach, loadSkill, takeDelivery, splitSkillLine, resolveComposerDelivery } = deps
    registerOne({
      name: 'skill',
      description: 'Load a skill into the session context',
      input: { hint: '<name>' },
      handler: async (invocation) => {
        // Captured before any await: the submit boundary's resolved mode.
        const delivery = takeDelivery()
        // ONE atomic resolution step for the live scope (held across the whole
        // picker lifecycle: a switch while this picker or its catalog read is in
        // flight must refuse the selection).
        const scope = await runner.requireLiveSessionScope()
        // `/skill <name> [args...]`: the first whitespace token is the skill
        // name, the remainder its arguments (forwarded verbatim on the
        // original line, web parity — never carved out or dropped). The
        // invocation line is normalized to `/name args` so the host's pre-step
        // gesture (dsh-tool-skill) also recognizes it when visible.
        const [name, ...args] = splitSkillLine(invocation.rawInput)
        if (name !== '') return loadSkill(scope, name, args.join(' '), invocation.signal ?? runner.signal, delivery, invocation.commandId)
        // No argument: pick from the catalog — the same validated, policy-
        // filtered, sorted view the collector builds (the catalog port's
        // live read), so hostile or model-only entries never reach the
        // picker. The read is SCOPE-BOUND: it validates the captured owner
        // before the dispatch and after the await, so a switch mid-read never
        // paints another Session's picker.
        let catalog: HumanSkillCatalog | undefined
        try {
          catalog = await runner.listScopedSkills(scope, runner.signal)
        } catch (error) {
          if (error instanceof SupersededReadError) {
            return { kind: 'error', text: 'the session changed while loading skills — try again' }
          }
          throw error
        }
        if (catalog === undefined) return { kind: 'error', text: 'skill service unavailable' }
        if (catalog.skills.length === 0) return { kind: 'error', text: 'no skills available' }
        // SettingsList rows: Enter cycles the value, which fires onChange.
        app.openSettings(
          catalog.skills.map(skill => ({
            id: skill.name,
            label: skill.name,
            description: skill.description,
            currentValue: '',
            values: ['✓'],
          })),
          (id) => {
            // The SELECTION is the delivery boundary (choosing a row submits
            // the skill like a plain Enter on the completed `/<name>` line), so
            // the mode is resolved HERE — the picker may have been open while
            // the agent went idle (or busy) and while the preference was
            // edited; a mode frozen at picker-open time would be stale. The
            // resolved mode is handed to the delivery, which never re-derives
            // it.
            // The activity read is SCOPE-BOUND: a stale picker refuses the
            // selection with a notice instead of throwing out of the overlay
            // callback (or dispatching to the replacement owner).
            let running: boolean
            try {
              running = runner.currentSessionActivity(scope).running
            } catch (error) {
              if (error instanceof SupersededReadError) {
                app.notify('the session changed while loading skills — try again', 'error')
                return
              }
              throw error
            }
            const delivery = resolveComposerDelivery(
              running,
              'enter',
              runner.tuiSettings?.get().busyEnter,
            )
            detach('skill load', () => loadSkill(scope, id, '', runner.signal, delivery).then(result => {
              if (result.kind === 'error') app.notify(result.text)
            }), { notify: true })
          },
          () => {},
        )
        return { kind: 'success' }
      },
    })
}

/** /reload — refresh the catalog/skill surface and reapply the settings. */
export function registerReloadCommand(deps: SkillsCommandDeps): void {
  const {
    runner,
    app,
    registerOne,
    detach,
    recordExtensionError,
    clearExtensionError,
    captureExtensionHealthRef,
  } = deps
    registerOne({
      name: 'reload',
      description: 'Reload TUI settings and refresh the live command/skill catalog',
      handler: async () => {
        // 1. Refresh the surface catalog through the coordinator: a LIVE agent
        // refreshes its authoritative surface; the sessionless state refreshes
        // the STANDING skill catalog of the effective preset (no Agent, no
        // session — the standing scope replaces the composition probe, which
        // emits durable events in this deployment, see docs/surface-catalog.md).
        // The handler awaits the attempt and reports the outcome (counts,
        // degradation notice, partial issues, supersession); provider or
        // composition failures never prevent the settings portion below.
        let catalogText = ''
        const scope = runner.captureLiveSessionScope()
        if (scope !== undefined) {
          let outcome: CatalogRefreshOutcome
          try {
            outcome = await runner.refreshSessionCatalog(scope, 'reload')
          } catch (error) {
            // The captured owner was replaced during the read: a stale refresh
            // owns nothing, so it reports exactly like the coordinator's own
            // supersession outcome.
            if (!(error instanceof SupersededReadError)) throw error
            outcome = { kind: 'superseded' }
          }
          if (outcome.kind === 'applied') {
            catalogText = `${outcome.snapshot.commands.length} commands \u00b7 ${outcome.snapshot.skills.length} skills`
            if (outcome.snapshot.issues.length > 0) {
              catalogText += ` \u00b7 partial: ${outcome.snapshot.issues.map(issue => issue.provider).join(', ')} unavailable`
            }
          } else if (outcome.kind === 'failed') {
            catalogText = `catalog refresh failed: ${outcome.error}`
          } else {
            catalogText = 'catalog refresh superseded'
          }
        } else {
          const outcome = await runner.refreshStandingCatalog(runner.effectivePresetId, 'reload')
          if (outcome.kind === 'applied') {
            catalogText = `${outcome.snapshot.skills.length} human skills`
            if (outcome.notice !== undefined) catalogText += ` \u00b7 ${outcome.notice}`
          } else if (outcome.kind === 'failed') {
            catalogText = `catalog refresh failed: ${outcome.error}`
          } else {
            catalogText = 'catalog refresh superseded'
          }
        }
        // 2. Re-apply the persisted TUI settings (theme, footer, fullscreen),
        // the same policy the runner applies at boot.
        const settings = runner.tuiSettings
        if (settings !== undefined) {
          const doc = settings.get()
          // The autodetect guard reads this synchronous snapshot of the
          // reload-time theme, never a re-read of the doc: a settings write
          // from the panel may still be in flight when the reply lands.
          const reloadTheme = doc.theme
          if (reloadTheme === 'auto') {
            app.clearActivePluginTheme()
            detach('theme autodetect', () => app.autoDetectTheme({
              // A settings panel write may complete while OSC 11 is in flight;
              // only apply the late result if auto is still the latest choice.
              shouldApply: () => settings.get().theme === 'auto',
            }))
            app.trackTerminalTheme(true)
          } else if (reloadTheme === 'dark' || reloadTheme === 'light') {
            app.clearActivePluginTheme()
            app.applyTheme(reloadTheme)
            app.trackTerminalTheme(false)
          } else if (reloadTheme !== 'auto') {
            // Any non-builtin persisted theme: SOURCE-QUALIFIED resolution
            // (the review's P2). The persisted value is the identity —
            // `file:<name>` resolves the file, `plugin:<owner>/<id>`
            // resolves the registry, and the legacy `custom:<name>` /
            // bare-name forms normalize to `file:<name>` (existing
            // documents keep working). A selection whose source is gone
            // (an unloaded plugin, a deleted file) falls back to the
            // builtin dark palette.
            const qualified = normalizePersistedTheme(reloadTheme)
            const themes = runner.extensions?.themes
            const selection = resolveThemeSelection(qualified, themes)
            // VALUE-addressed (the unified theme protocol).
            const themeRef = captureExtensionHealthRef?.('theme', qualified)
            if (selection !== undefined) {
              try {
                // A PLUGIN palette records the selection (the unload
                // fallback restores builtin dark when it disappears); a
                // custom FILE clears it.
                if (selection.kind === 'plugin') app.applyPluginPalette(selection.value, selection.palette)
                else {
                  app.clearActivePluginTheme()
                  app.applyPalette(selection.palette)
                }
                if (themeRef !== undefined) clearExtensionError?.(themeRef)
              } catch (error) {
                if (themeRef !== undefined) recordExtensionError?.(themeRef, error)
                else app.notify(`theme ${reloadTheme} failed: ${safeErrorMessage(error)}`, 'error')
              }
            } else {
              // A missing selection is a host settings problem, not a
              // plugin contribution failure. Do not create a theme health
              // row. The plugin selection is cleared (same rationale as
              // startup).
              app.clearActivePluginTheme()
              app.notify(`theme ${reloadTheme} not found`, 'error')
            }
            app.trackTerminalTheme(false)
          }
          runner.applyFooterSettings(doc)
          app.setFullscreen(doc.fullscreen === 'on')
        }
        app.notify(`reloaded — ${catalogText} \u00b7 settings reapplied`, 'info')
        return { kind: 'success' }
      },
    })
}
