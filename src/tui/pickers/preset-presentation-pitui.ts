/** The existing PiTui preset picker behind the narrow /preset presentation
 *  contract.
 *
 *  PiTui keeps its own UX unchanged: the roster overlay opens only once the
 *  rows are known (a running read shows nothing new — the original path read
 *  the roster before opening), Enter on a row applies it in ONE step, and the
 *  overlay offers neither Retry, Details nor a Set-default action. The rows,
 *  their description fields and their wording are the original ones.
 * @module tui/pickers/preset-presentation-pitui
 */
import type { PresetPresentation, PresetPickerRoster } from '../../app/command/preset-presentation.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { TuiApp } from '../../tui-app.ts'
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
                  preset.id === input.defaultId ? 'default' : undefined,
                  preset.id === input.currentId ? '← current' : undefined,
                  preset.broken,
                ].filter(Boolean).join(' · '),
                currentValue: '',
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
