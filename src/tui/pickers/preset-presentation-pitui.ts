/** The PiTui `/preset` presentation adapter behind the narrow presentation
 *  contract.
 *
 *  It owns NO business authority: the command keeps every roster read, apply
 *  write, default write, scope and token. This adapter only mounts ONE
 *  `PresetPickerPanel` through the app's dedicated root-overlay slot and
 *  forwards the command's loading/roster/error settlements into it.
 *
 *  The returned handle is identity-safe: closing it retires only THIS panel
 *  (the app slot checks the component identity), never a newer one, and never
 *  an already admitted write.
 * @module tui/pickers/preset-presentation-pitui
 */
import type { PresetPresentation, PresetPickerRoster } from '../../app/command/preset-presentation.ts'
import type { TuiApp } from '../../tui-app.ts'
import { PresetPickerPanel } from './preset-picker.ts'

export function pituiPresetPresentation(app: TuiApp): PresetPresentation {
  return {
    notify: (message, kind) => app.notify(message, kind),
    open: (request) => {
      /** The app's identity-safe closer, assigned once the mount returns. */
      let closer: (() => void) | undefined
      /** A close requested during the synchronous mount window (before the
       *  overlay slot returned its closer). */
      let closeRequested = false
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        if (closer === undefined) {
          closeRequested = true
          return
        }
        closer()
      }
      const panel = new PresetPickerPanel({
        request,
        requestRender: () => app.requestRender(),
        close,
      })
      try {
        closer = app.openPresetPicker(panel)
      } catch (error) {
        // The app slot already unwound its physical mount and disposed the
        // component; make THIS handle inert and surface the real failure to
        // the command (never a silent success without an overlay).
        closed = true
        panel.dispose()
        throw error
      }
      // A close that raced the mount (a synchronous callback inside it) must
      // not leave a visible ghost after the slot was published.
      if (closeRequested) closer()
      return {
        isDisposed: () => closed || panel.isDisposed(),
        setLoading: () => panel.setLoading(),
        setRoster: (input: PresetPickerRoster) => panel.setRoster(input),
        setLoadError: (message: string) => panel.setLoadError(message),
        close,
      }
    },
  }
}
