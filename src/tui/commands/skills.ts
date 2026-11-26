/**
 * Built-in command definitions for the skill domain (/skill, /reload).
 *
 * The dynamic skill-wrapper/catalog state machine stays in the coordinator
 * (src/commands.ts); this module owns only the two static command definitions
 * and receives the coordinator's loadSkill/delivery/catalog primitives.
 * @module @xmoon76/dsh-pi-tui/tui/commands/skills
 */

import type { TuiApp } from '../../tui-app.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import type { CatalogRefreshOutcome } from '../../app/command/catalog-refresh.ts'
import { resolveThemeSelection } from '../../app/surface/theme-selection.ts'
import { normalizePersistedTheme } from '../../domain/display/theme-selection.ts'
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
  | 'effectivePresetId'
  | 'extensions'
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
}

/** /skill — load one explicit skill into the live session. */
export function registerSkillCommand(deps: SkillsCommandDeps): void {
  const { runner, registerOne, loadSkill, takeDelivery, splitSkillLine } = deps
    registerOne({
      name: 'skill',
      description: 'Load a skill into the session context',
      input: { hint: '<name>' },
      handler: async (invocation) => {
        // Captured before any await: the submit boundary's resolved mode.
        const delivery = takeDelivery()
        // `/skill <name> [args...]`: the first whitespace token is the skill
        // name, the remainder its arguments (forwarded verbatim on the
        // original line, web parity — never carved out or dropped). The
        // invocation line is normalized to `/name args` so the host's pre-step
        // gesture (dsh-tool-skill) also recognizes it when visible.
        const [name, ...args] = splitSkillLine(invocation.rawInput)
        // The bare command is a usage-only local command: it never reads the
        // skill catalog, opens a picker or starts a Skill write.
        if (name === '') {
          return {
            kind: 'error',
            text: 'Usage: /skill <name> [args]. Type / to discover available skills.',
          }
        }
        // ONE atomic resolution step for the live scope.
        const scope = await runner.requireLiveSessionScope()
        return loadSkill(scope, name, args.join(' '), invocation.signal ?? runner.signal, delivery, invocation.commandId)
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
        // emits durable events in this deployment, see docs/architecture/surface-catalog.md).
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
          // The reload re-applies this synchronous snapshot of the persisted
          // theme, never a re-read of the document: a settings write from the
          // panel may still be in flight when the reply lands. Only an ADMITTED
          // choice updates the runtime intent; a missing custom source keeps the
          // previous intent (a legal Auto tenure is never broken by a bad
          // candidate).
          const reloadTheme = doc.theme
          if (reloadTheme === 'auto') {
            app.noteThemeSelection(reloadTheme)
            app.clearActivePluginTheme()
            detach('theme autodetect', () => app.autoDetectTheme())
            app.trackTerminalTheme(true)
          } else if (reloadTheme === 'dark' || reloadTheme === 'light') {
            // The palette install commits the deliberate selection (intent, Auto
            // invalidation, tracking and plugin record) after a successful apply.
            app.applyTheme(reloadTheme, { value: reloadTheme })
          } else if (reloadTheme !== undefined && reloadTheme !== '') {
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
                // The palette install commits the deliberate selection (intent,
                // Auto invalidation, tracking and plugin record) before the
                // theme observers run.
                if (selection.kind === 'plugin') app.applyPluginPalette(selection.value, selection.palette, { value: reloadTheme })
                else app.applyPalette(selection.palette, { value: reloadTheme })
                if (themeRef !== undefined) clearExtensionError?.(themeRef)
              } catch (error) {
                if (themeRef !== undefined) recordExtensionError?.(themeRef, error)
                else app.notify(`theme ${reloadTheme} failed: ${safeErrorMessage(error)}`, 'error')
              }
            } else {
              // A missing selection is a host settings problem, not a
              // plugin contribution failure. Do not create a theme health
              // row. The plugin record is cleared, but the current runtime
              // intent/tracking stay untouched: an invalid candidate must not
              // disconnect a legal Auto tenure.
              app.clearActivePluginTheme()
              app.notify(`theme ${reloadTheme} not found`, 'error')
            }
          }
          runner.applyFooterSettings(doc)
          app.setFullscreen(doc.fullscreen === 'on')
        }
        app.notify(`reloaded — ${catalogText} \u00b7 settings reapplied`, 'info')
        return { kind: 'success' }
      },
    })
}
