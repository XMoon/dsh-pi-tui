/** The existing PiTui preset picker behind the narrow /preset presentation
 *  contract.
 *
 *  PiTui keeps its own UX unchanged: the roster overlay opens only once the
 *  rows are known (a running read shows nothing new — the original path read
 *  the roster before opening), Enter on a row applies it in ONE step, and the
 *  overlay offers neither Retry, Details nor a Set-default action. The rows and
 *  their description fields are the original ones; the current-state mark is
 *  the design language's `[current]` chip in the row value slot (§4.5/§12.2,
 *  rollout PR5b).
 * @module tui/pickers/preset-presentation-pitui
 */
import type { PresetPresentation, PresetPickerRoster } from '../../app/command/preset-presentation.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { TuiApp } from '../../tui-app.ts'
import { color } from '../theme/runtime.ts'
import { isBuiltInPresetRow, presetDisplayText } from './preset-display.ts'

export function pituiPresetPresentation(app: TuiApp): PresetPresentation {
  return {
    notify: (message, kind) => app.notify(message, kind),
    open: (request) => {
      let disposed = false
      /** The live overlay's own closer, once the rows arrived. */
      let closer: (() => void) | undefined
      return {
        isDisposed: () => disposed,
        setLoading: () => {
          // PiTui has never shown a roster LOADING overlay: its list exists only
          // once the rows are known. The command runs the same one read owner.
        },
        setLoadError: () => {
          // Unreachable by construction: the PiTui settlement keeps a roster
          // failure on the COMMAND path (the handler rethrows), so the adapter
          // never receives one — and it must not invent a Retry or a second
          // notice if it ever did.
        },
        setRoster: (input: PresetPickerRoster) => {
          if (disposed || closer !== undefined) return
          // An empty roster opened no overlay in the original path (an empty
          // SettingsList is not a picker), so it still opens none.
          if (input.roster.presets.length === 0) return
          closer = app.openSettings(
            input.roster.presets.map(preset => {
              const display = presetDisplayText(preset)
              return {
                id: preset.id,
                label: `${display.name} (${preset.id})`,
                description: [
                  display.description,
                  isBuiltInPresetRow(preset) ? 'system' : 'user',
                  preset.broken,
                ].filter(Boolean).join(' · '),
                // §4.5/§12.2: the row state is the `[current]` state chip in
                // the row's value slot — the SAME position the /settings theme
                // picker uses — never a word inside the description (which is
                // also painted only while the row is selected). The chip is
                // PRE-PAINTED `textMuted` (the `status.ts:110` precedent)
                // because `settingsListTheme().value` paints `selected ?
                // primary : textDim`; it is the slot's only span, so nothing
                // after a nested reset can lose its ink.
                // §4.5/§12.2: TWO states are TWO chips (`[current] [default]`), never
                // one joined pair — both are state, not prose, so both leave the
                // description. Each span is pre-painted (the `status.ts:110` precedent),
                // the ` · ` joiner included: a nested span's reset ends the outer ink for
                // everything after it, so an unpainted joiner would fall back to the
                // terminal's default colour between the two chips.
                currentValue: [
                  preset.id === input.currentId ? color.textMuted('[current]') : '',
                  preset.id === input.defaultId ? color.textMuted('[default]') : '',
                ].filter(chip => chip !== '').join(color.textDim(' · ')),
                // The values entry makes SettingsList.activateItem fire
                // onChange on Enter/Space (rows without values or a submenu
                // are inert) — one key confirms the switch while the selected
                // row's description still renders in full below the list.
                values: [preset.id],
              }
            }),
            (id) => {
              closer?.()
              // The picker's selection is an async result-consuming flow: the
              // outcome drives the notices — runOwned (AGENTS.md), never a bare
              // void; cancellation (a torn-down TUI) is debug-only.
              request.runOwned('preset pick', () => request.isCurrent()
                ? request.apply(id)
                : { kind: 'superseded' as const }, {
                isCancellation: () => disposed,
                onError: (error) => app.notify(`preset selection failed: ${safeErrorMessage(error)}`, 'error'),
              })
            },
            () => {},
          )
        },
        close: () => {
          if (disposed) return
          disposed = true
          closer?.()
        },
      }
    },
  }
}
