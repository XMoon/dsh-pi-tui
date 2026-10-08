/**
 * The PiTui adapter over `SurfaceDisplaySeam` (PR3-A).
 *
 * The mounted `TuiApp` already implements most of the seam verbatim; this
 * adapter composes the few aggregated members (`commitStatusFacts`,
 * `resetSessionFacts`, `setDockNotice`) from the app's existing primitive
 * setters. It adds NO state of its own beyond the dock-notice slot mapping,
 * and it never re-derives anything the application owners computed.
 *
 * The adapter exists only while the PiTui renderer is mounted; the TSP
 * implementation lives in `src/tui/tsp/**`.
 * @module @xmoon76/dsh-pi-tui/app/surface/display-seam-pitui
 */

import type { TuiApp } from '../../tui-app.ts'
import type {
  DisplayDockNotice,
  DisplayStatusFacts,
  SurfaceDisplaySeam,
} from './display-seam.ts'

/** Adapt one mounted TuiApp onto the renderer-facing display seam. */
export function pituiDisplaySeam(app: TuiApp): SurfaceDisplaySeam {
  let lastNotice: DisplayDockNotice | undefined
  return {
    setTranscript: (messages, activities, window, streamingToolPreviews, searchPresentation) =>
      app.setTranscript(messages, activities, window, streamingToolPreviews, searchPresentation),
    commitDisplaySubject: (patch, legacyFacts, presentation) =>
      app.commitDisplaySubject(patch, legacyFacts, presentation),
    commitStatusFacts(facts: DisplayStatusFacts) {
      if (facts.busy !== undefined) app.setBusy(facts.busy)
      if (facts.working !== undefined) app.setWorking(facts.working)
      if (facts.planMode !== undefined) app.setPlanMode(facts.planMode)
      // `sessionTitle` may be EXPLICITLY undefined (the Remote current-facts
      // path clears an absent title); distinguish presence from value.
      if ('sessionTitle' in facts) app.setSessionTitle(facts.sessionTitle)
      if (facts.todos !== undefined) app.setTodoSummary(facts.todos)
      if (facts.compactionPhase !== undefined) app.setCompactionPhase(facts.compactionPhase)
    },
    resetSessionFacts() {
      // The ORIGINAL hydrate-tail clear set: local cards, stale notices and
      // the transient exit latch. Title/todo/compaction are NOT cleared —
      // the hydrate that is calling this just committed them (the pre-seam
      // code cleared exactly these three).
      app.clearLocalMessages()
      app.clearNotify()
      app.clearExitConfirmation()
    },
    beginSessionHydration() {
      // The ORIGINAL generation-bump reset set (resetForGeneration): the
      // hydrate-tail trio PLUS the session overrides and the search
      // readout. PiTui has no separate Loading state — the retained rows
      // stay until the new fold's repaint replaces them.
      app.clearLocalMessages()
      app.clearNotify()
      app.clearExitConfirmation()
      app.clearSessionOverrides()
    },
    resetInputHistory: entries => app.resetInputHistory(entries),
    setSearchResult: (index, count) => app.setSearchResult(index, count),
    notify: (text, kind) => app.notify(text, kind),
    setDockNotice(notice) {
      // PiTui has no pinned dock slot; a replacing notice re-uses the toast
      // channel (the previous toast ages out on its own).
      if (notice === undefined) return
      if (lastNotice !== undefined && lastNotice.id === notice.id && lastNotice.text === notice.text) return
      lastNotice = notice
      app.notify(notice.text, notice.kind)
    },
    setWelcomeCard: facts => app.setWelcomeCard(facts),
    setWelcomeIdle: idle => app.setWelcomeIdle(idle),
    setTerminalCwd: cwd => app.setTerminalCwd(cwd),
    setPendingInputPresentation: presentation => app.setPendingInputPresentation(presentation),
    getSessionTitle: () => app.getSessionTitle(),
    getViewerGeneration: () => app.getViewerGeneration(),
    supportsTaskCenter: true,
    supportsViewer: true,
    supportsModals: true,
  }
}
