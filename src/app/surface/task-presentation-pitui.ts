/**
 * The PiTui Task Center presentation adapter (PR4 B3-A1).
 *
 * A pure DELEGATION over the mounted `TuiApp`: the app remains the owner of
 * the overlay, its physical lease and the Task Browser panel state. The
 * adapter keeps no business state and no cached row arrays — every call
 * reaches the live app (or the live handle) with its original receiver, so a
 * test/embedder that patches an app sink still observes the real commit.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/task-presentation-pitui
 */

import type { TuiApp } from '../../tui-app.ts'
import type {
  TaskBrowserPresentationHandle,
  TaskCenterPresentationPort,
} from './task-presentation-port.ts'

/** The ONE PiTui implementation of the Task Center presentation port. */
export function pituiTaskCenterPresentation(app: TuiApp): TaskCenterPresentationPort {
  return {
    openBrowser: (items, onSelect, onClose, options) => {
      // The app's `onCancel` carries its captured view state; the port's
      // owner only needs the close event. A zero-argument callback is a
      // structurally valid `onCancel` and is passed BY IDENTITY, so no
      // wrapper changes the call count or the receiver.
      const handle = app.openTaskBrowser(items, onSelect, onClose, options)
      const presentation: TaskBrowserPresentationHandle = {
        close: () => handle.close(),
        setItems: (next, preferredValue) => handle.setItems(next, preferredValue),
        // The app's handle keeps `setRefreshState` optional; the port mirrors
        // that exact optional call instead of inventing a failure default.
        setRefreshState: (state, error) => handle.setRefreshState?.(state, error),
      }
      return presentation
    },
    setQuickTaskItems: items => app.setQuickTaskItems(items),
    setAgents: agents => app.setAgents(agents),
    setTasks: jobs => app.setTasks(jobs),
    setQuestionAttention: count => app.setQuestionAttention(count),
    setTaskSummary: summary => app.setTaskSummary(summary),
  }
}
