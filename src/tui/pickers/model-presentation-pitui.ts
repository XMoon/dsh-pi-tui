/** The existing PiTui picker behind the narrow /model presentation contract. */
import type { ModelPresentation } from '../../app/command/model-presentation.ts'
import type { TuiApp } from '../../tui-app.ts'
import { ModelPicker } from './model-picker.ts'

export function pituiModelPresentation(app: TuiApp): ModelPresentation {
  return {
    notify: (message, kind) => app.notify(message, kind),
    open: (request) => {
      let closer: () => void = () => {}
      const picker = new ModelPicker({
        apply: (selection) => (request.isCurrent() ? request.apply(selection) : 'superseded'),
        requestRender: () => app.requestRender(),
        close: () => {
          if (!picker.isDisposed()) closer()
        },
        runOwned: request.runOwned,
      })
      closer = app.openModelPicker(picker)
      return {
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
