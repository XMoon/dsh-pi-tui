/**
 * The PiTui adapter over the Client-local Exit Choice surface (M6 UX PR1).
 *
 * The mounted `TuiApp` owns the overlay lifetime and the seat component; this
 * adapter is the narrow, renderer-neutral seam the exit-intent coordinator
 * presents through. It adds no decision of its own.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/exit-choice-pitui
 */

import type { ExitChoiceModel, SurfaceExitChoiceSeam } from './exit-choice.ts'
import type { TuiApp } from '../../tui-app.ts'

/**
 * Wrap the mounted PiTui application as the ONE exit-choice seam.
 * @param app - the mounted application (the structural overlay owner).
 * @returns the open/update/close seam.
 */
export function pituiExitChoiceSeam(app: TuiApp): SurfaceExitChoiceSeam {
  return {
    open: (model: ExitChoiceModel) => { app.openExitChoice(model) },
    update: (model: ExitChoiceModel) => { app.updateExitChoice(model) },
    close: () => { app.closeExitChoice() },
  }
}
