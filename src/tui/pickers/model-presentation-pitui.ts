/** The existing PiTui picker behind the narrow /model presentation contract.
 *  PiTui keeps its own UX: no visible Retry (Esc + reopen reports a fresh read
 *  through the same command-owned `retry`), and the picker itself renders the
 *  loading state the read owner asks for. */
import type { ModelPresentation } from '../../app/command/model-presentation.ts'
import type { TuiApp } from '../../tui-app.ts'
import { ModelPicker } from './model-picker.ts'

export function pituiModelPresentation(app: TuiApp): ModelPresentation {
  return {
    notify: (message, kind) => app.notify(message, kind),
    open: (request) => {
      let closer: () => void = () => {}
      const picker = new ModelPicker({
        subject: request.subject,
        apply: (selection) => (request.isCurrent() ? request.apply(selection) : 'superseded'),
        requestRender: () => app.requestRender(),
        close: () => {
          if (!picker.isDisposed()) closer()
        },
        runOwned: request.runOwned,
      })
      closer = app.openModelPicker(picker)
      return {
        setLoading: () => picker.setLoading(),
        setDirectory: (input) => picker.setDirectory(input),
        setLoadError: (message) => picker.setLoadError(message),
        isDisposed: () => picker.isDisposed(),
        close: () => {
          if (!picker.isDisposed()) closer()
        },
      }
    },
  }
}
