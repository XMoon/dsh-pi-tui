/**
 * The renderer-facing display seam (PR3-A, plan §2.3 option 1).
 *
 * The audit in `docs/tern-tsp/evidence/pr3-a.md` (§A0.2) found the set of
 * `TuiApp` members the application can reach while a READ-ONLY Tern TSP
 * renderer owns the terminal: the transcript projection commit, a handful of
 * status facts and resets, notices, the welcome card and the pending-input
 * presentation. This interface is exactly that set — semantics stay computed
 * by the existing application owners; a renderer implementation only commits
 * them to its own surface.
 *
 * `TuiApp` satisfies this interface structurally (the PiTui implementation is
 * the mounted app itself); the TSP implementation lives in
 * `src/tui/tsp/**` and turns each member into official SDK nodes. Members the
 * TSP renderer cannot present are explicit capability flags consulted by the
 * owning module at its REAL entry point (a declined viewer open shows a dock
 * notice — never a silent no-op inside the seam).
 *
 * This is deliberately NOT a second presentation authority: no fold, no
 * window, no event routing, no session identity lives here.
 *
 * Debt (PR3-B): the seam still imports PiTui-shaped PRESENTATION types
 * (`TranscriptSearchPresentation`, `StatusData`, `DisplaySubjectPresentation`)
 * from `tui-app.ts`. They are type-only and the architecture gate accepts them,
 * but the search/viewport-shaped parameters belong to the PiTui adapter side, so
 * the contract should be narrowed before PR3-B extends it further.
 * @module @xmoon76/dsh-pi-tui/app/surface/display-seam
 */

import type { CompactionPhase } from './compaction-presentation.ts'
import type { PendingInputPresentation } from './pending-presentation.ts'
import type { TodoItem, TranscriptSearchPresentation } from '../../tui-app.ts'
import type { StreamingToolPreview } from './streaming-tool-preparing.ts'
import type { StatusPatch } from '../../domain/status/types.ts'
import type { TranscriptMessage, TurnActivity } from '../../domain/transcript/types.ts'
import type { TranscriptWindowState } from '../../domain/transcript/window.ts'
import type { StatusData, DisplaySubjectPresentation } from '../../tui-app.ts'

/**
 * One dock notice line (TSP-A): a short, replaceable status/notice the TSP
 * renderer pins in its `dock` region (for example the read-only banner or a
 * declined-capability notice). The PiTui branch maps it onto `notify`-style
 * chrome.
 */
export interface DisplayDockNotice {
  /** Stable slot id: a later notice with the same id replaces, not stacks. */
  readonly id: string
  readonly text: string
  readonly kind: 'info' | 'error'
}

/** The status facts the seam commits (see TuiApp's same-named setters). */
export interface DisplayStatusFacts {
  readonly busy?: boolean
  readonly working?: boolean
  readonly planMode?: boolean
  readonly sessionTitle?: string | undefined
  readonly todos?: readonly TodoItem[]
  readonly compactionPhase?: CompactionPhase
}

/** The welcome-card facts (see TuiApp.setWelcomeCard). */
export interface DisplayWelcomeFacts {
  readonly cwd: string
  readonly sessionId: string
  readonly model?: string
  readonly version: string
  readonly preset?: string
}

/**
 * The renderer-facing display surface. Every member is a COMMIT of a fact the
 * application owner already derived; none of them queries the renderer back.
 */
export interface SurfaceDisplaySeam {
  // ── The transcript projection (SurfaceRuntime.repaintTarget is the only writer) ──
  /** Commit ONE windowed transcript projection (the same arguments
   * `TuiApp.setTranscript` takes; a renderer that cannot present search
   * ignores the optional presentation parts). */
  setTranscript(
    messages: readonly TranscriptMessage[],
    activities?: ReadonlyMap<number, TurnActivity>,
    window?: TranscriptWindowState & { firstTurn?: number; lastTurn?: number; hasNewer?: boolean },
    streamingToolPreviews?: readonly StreamingToolPreview[],
    searchPresentation?: TranscriptSearchPresentation,
    /**
     * PR3-A: the OPAQUE projection-source identity (the PR2 frame's
     * `sourceIdentity`, `===` only). The SAME token keeps the renderer's
     * presentation-key scope; a NEW token (session commit, cold rehydrate,
     * viewer switch) re-scopes it. Optional: a seam implementation without
     * scope tracking may ignore it.
     */
    source?: object,
  ): void

  // ── Status facts and resets (session-presentation / event-routing owners) ──
  /**
   * Commit one or more status facts atomically (a superset write of the
   * same-named TuiApp setters). Field PRESENCE is the write authority: an
   * explicitly-present `sessionTitle: undefined` CLEARS the title (the
   * Remote current-facts path relies on this); an absent field is left
   * unchanged.
   */
  commitStatusFacts(facts: DisplayStatusFacts): void
  /** The ONE atomic display-subject commit: the StatusStore sections, the
   * legacy display fields and the display-subject presentation together
   * (TuiApp.commitDisplaySubject / SurfaceRuntime.commitStatus). */
  commitDisplaySubject(
    patch: StatusPatch,
    legacyFacts: Partial<StatusData>,
    presentation: DisplaySubjectPresentation | undefined,
  ): void
  /**
   * Clear the HYDRATION-TAIL transient state only: local cards, stale
   * notices and the keyboard exit latch. Title/todo/compaction/working
   * facts are NOT cleared — the hydrate that is calling this just committed
   * them (the PiTui adapter has always kept that set).
   */
  resetSessionFacts(): void
  /**
   * PR3-A: the generation-bump hydration window. The new owner has been
   * published but its fold has not committed yet: drop the retained
   * transcript to the explicit Loading state and FENCE the old projection
   * source — a late repaint still reading the OLD fold must never lift the
   * Loading state nor relabel old rows as the new subject. The fence lifts
   * at the first commit carrying a DIFFERENT (new) source token.
   */
  beginSessionHydration(): void
  /**
   * PR3-B §7.3 (the B2 external-review F1): drop the ACTIVE editor's
   * unsubmitted draft at the generation boundary of a genuine session
   * switch — the old session's text must never be submittable into the new
   * one once the hydration fence lifts. Called ONLY from the committed
   * cross-owner publication sites (the session runtime's post-commit
   * phases), so an ordinary same-session rehydrate, a first-session
   * creation and a failed/pre-publication switch NEVER reach it. The PiTui
   * adapter is a deliberate no-op: its long-standing cross-session draft
   * retention is the PiTui contract; the plan's clear-on-switch rule scopes
   * the TSP active draft only.
   */
  clearActiveDraft(): void
  /**
   * PR3-B §7.3 (the B2 external-review F2): whether this renderer RETAINS
   * a stale submission's draft restore across a session switch. PiTui
   * retains (its editor is the draft owner — a stale send's text always
   * comes back to the user); a renderer whose active draft was dropped at
   * the committed switch (TSP) must NOT receive that restore — the old
   * session's text was discarded by the switch authority, and a late stale
   * restore would reseed the NEW session's composer with it. Stale-settle
   * sites consult this before merging.
   */
  retainsStaleDraftRestore(): boolean
  /** Replace the editor input-history recall rows (editor-only; a read-only
   * renderer ignores the rows but still records the reset). */
  resetInputHistory(entries: readonly string[]): void
  /** Clear the search result readout (chrome-only; harmless on TSP). */
  setSearchResult(index: number, count: number): void

  // ── Notices / welcome ──
  /** One transient notice (errors, completions, switch outcomes). */
  notify(text: string, kind?: 'error' | 'info'): void
  /** One pinned dock notice slot (TSP-A read-only banner, declined features). */
  setDockNotice(notice: DisplayDockNotice | undefined): void
  /** The welcome card facts (sessionless startup / Remote facts). */
  setWelcomeCard(facts: DisplayWelcomeFacts): void
  /** The welcome card's idle form (deferred start, no session yet). */
  setWelcomeIdle(idle: boolean): void
  /** The terminal-local cwd fact the renderer may publish (OSC 7 on PiTui;
   * the TSP pane owns its own cwd presentation). */
  setTerminalCwd(cwd: string | undefined): void

  // ── Pending input (background queue/steer IS visible in read-only A) ──
  /** The pending-input presentation (semantic read + local echoes join). */
  setPendingInputPresentation(presentation: PendingInputPresentation): void

  // ── Reads the composition needs ──
  /** The session title the renderer last committed (status owner's read). */
  getSessionTitle(): string
  /** The viewer-generation counter (the image-scope key authority; the
   * surface owns the counter, both renderers read it). */
  getViewerGeneration(): number

  // ── Capability flags (owners decline PiTui-only features at their real entry) ──
  /** Whether the Task Center roster/summary chrome is presented. */
  readonly supportsTaskCenter: boolean
  /** Whether the subagent viewer can mount on this renderer. */
  readonly supportsViewer: boolean
  /** Whether interactive modals (Question/Approval) are answerable here. */
  readonly supportsModals: boolean
}
