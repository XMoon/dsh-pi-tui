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
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import type { PresetPresentation, PresetPickerRoster } from '../../app/command/preset-presentation.ts'
import { visibleWidth, type SettingValuePart } from '@xmoon76/pi-tui'
import { abbreviateName } from './name-label.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { TuiApp } from '../../tui-app.ts'
import { color } from '../theme/runtime.ts'
import { isBuiltInPresetRow, presetDisplayText } from './preset-display.ts'

/**
 * The row LABEL for one preset: the ID is what a user types (`/preset <id>`), so it
 * stays WHOLE whenever the 25-cell label column at the 44-column floor can hold it —
 * only the friendly name is abbreviated into what is left. When even the ` (id)`
 * suffix cannot fit, the ID alone is abbreviated head…tail, so the row still ends on
 * the part that tells two ids apart. The complete `name (id)` always leads the
 * SELECTED row's description.
 */
function presetLabelOf(name: string, id: string): string {
  const limit = 25
  const suffix = ` (${id})`
  const suffixWidth = visibleWidth(suffix)
  // The ID is what the user types, so the suffix is never traded away while it
  // fits — and the name budget is the TRUE remainder: a floor of its own (the
  // 4-cell minimum this used to clamp to) made the composed label exceed the
  // column whenever 0-3 cells were left, and the renderer then clipped the ID's
  // own tail. With no cells left the suffix IS the label.
  if (suffixWidth > limit) return abbreviateName(id, limit)
  const remaining = limit - suffixWidth
  if (remaining === 0) return suffix
  return `${abbreviateName(name, remaining)}${suffix}`
}

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
              // §4.5/§12.2: the row state is a WHOLE state chip in the row's
              // value slot — the SAME position the /settings theme picker uses
              // — never a word inside the description (which is also painted
              // only while the row is selected). The chip is PRE-PAINTED
              // `textMuted` (the pre-painted-chip pattern in `src/tui/plugin-manager/workspace.ts`) because
              // `settingsListTheme().value` paints `selected ? primary :
              // textDim`; each part is its own span, so nothing after a nested
              // reset can lose its ink.
              // TWO states are TWO chips joined by a plain space (§4.5's
              // `[current] [unavailable]` shape; the ` · ` join is the grouped
              // badge's shape), never one joined pair, and neither stays in the
              // description. The joiner is a `text` part of the slot itself, so
              // a chip that yields takes its separator with it.
              // X061: the slot is handed WHOLE parts in priority order — the
              // renderer drops the lower-priority chip instead of cutting it
              // (`[default`) and reserves the first chip's cells, clipping the
              // label instead.
              const stateParts: SettingValuePart[] = []
              if (preset.id === input.currentId) stateParts.push({ kind: 'chip', text: color.textMuted('[current]') })
              if (preset.id === input.defaultId) {
                if (stateParts.length > 0) stateParts.push({ kind: 'text', text: ' ' })
                stateParts.push({ kind: 'chip', text: color.textMuted('[default]') })
              }
              return {
                id: preset.id,
                // 25 = the label column at the 44-column floor for a row that
                // reserves one 9-cell state chip (40 - 9 - 6). The selected row's
                // description leads with the COMPLETE `name (id)` identity, so a
                // pair of long same-prefix names can never be indistinguishable.
                // The preset ID is what the user types (`/preset <id>`), so it must
                // stay WHOLE in the label: only the friendly name is abbreviated,
                // into whatever the 25-cell column leaves after the ` (id)` suffix.
                label: presetLabelOf(sanitizedPhysicalLine(display.name), sanitizedPhysicalLine(preset.id)),
                // The abbreviation above is a DRAWING fact: the list's search
                // filters on this row's complete `name (id)` (fork X062), so a
                // keyword from the middle of a long friendly name still finds the
                // row. The same complete identity leads the description below.
                searchText: `${display.name} (${preset.id})`,
                description: [
                  `${sanitizedPhysicalLine(display.name)} (${sanitizedPhysicalLine(preset.id)})`,
                  display.description === undefined ? undefined : sanitizedPhysicalLine(display.description),
                  isBuiltInPresetRow(preset) ? 'system' : 'user',
                  preset.broken === undefined ? undefined : sanitizedPhysicalLine(preset.broken),
                ].filter(Boolean).join(' · '),
                // A display fact only: the slot paints `valueParts`, so the
                // fork's own `currentValue` (values cycling, updateValue) keeps
                // its exact semantics and is simply unused for these rows.
                currentValue: '',
                valueParts: stateParts,
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
