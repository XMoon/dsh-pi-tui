/**
 * The SurfaceHost (M2): the composition layer between a TuiApp instance and
 * the extension platform. One SurfaceHost attaches to one surface
 * generation; it owns:
 *
 * - the render sink (active-screen requests, coalesced);
 * - the SurfaceStateStore (immutable snapshots, selector subscriptions);
 * - the three first chrome outlets (header badge / dock item / footer
 *   segment), wired to the host's fixed Text components;
 * - the capability set the extension API reports once the surface is live.
 *
 * TuiApp still OWNS the physical screens, the root layout, and every
 * feature; the SurfaceHost only composes extension content INTO the fixed
 * chrome. `start()/stop()/fullscreen/external-editor` do not touch the host;
 * only the final surface dispose detaches it (M0 generation contract).
 * @module @xmoon76/dsh-pi-tui/extension/surface-host
 */

import type { Text } from '@xmoon76/pi-tui'
import type { PiTuiCapability, SurfaceSnapshot, SurfaceStateValues } from '../public-types.ts'
import type { ExtensionLedger } from './ledger.ts'
import { InvalidateBatcher } from './batcher.ts'
import { SurfaceStateStore } from './surface-state.ts'
import { HeaderBadgeOutlet, DockItemOutlet, FooterSegmentOutlet } from './slot-outlet.ts'
import { WidgetOutlet } from './widget-outlet.ts'

/** The surface host bound to one live surface. */
export class SurfaceHost {
  private readonly store: SurfaceStateStore
  private readonly ledger: ExtensionLedger
  private readonly headerBadges: HeaderBadgeOutlet
  private readonly dockItems: DockItemOutlet
  private readonly footerSegments: FooterSegmentOutlet
  private readonly widgetsAbove: WidgetOutlet
  private readonly widgetsBelow: WidgetOutlet
  private readonly requestRender: (force?: boolean) => void
  private readonly invalidateBatcher: InvalidateBatcher
  /** The TuiApp's chrome re-merge (refreshChrome), set at construction. */
  private onChromeRefresh: (() => void) | undefined
  /** The capability set reported while this surface is attached. */
  private readonly capabilities = new Set<PiTuiCapability>()
  private disposed = false
  /** THIS host's attachment lease token (P1): created at attach, captured
   * so dispose() can ask the LEDGER whether it is still the current owner.
   * The ledger, not the host, decides who may restore the no-op sink. */
  private ownToken: object | undefined
  /** THIS host's attachment generation (plan §6.2): assigned by the ledger
   * at attach; a final dispose freezes/removes exactly the registrations
   * of generations up to this one (never a newer host's). */
  private ownGeneration = 0
  /** Unique identity for this surface instance (P1-2: the allocator).
   * Stable for the host's lifetime; a NEW SurfaceHost gets a NEW id. */
  readonly surfaceId: string

  constructor(
    ledger: ExtensionLedger,
    requestRender: (force?: boolean) => void,
  ) {
    this.ledger = ledger
    this.requestRender = requestRender
    this.surfaceId = `tui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.store = new SurfaceStateStore({ requestRender: () => this.requestRender() })
    // The host's own invalidation batcher: a burst of ledger changes in one
    // tick coalesces into ONE outlet re-bake + chrome merge + ONE repaint
    // (M1 contract + F-17: an invalidation must reach the screen).
    this.invalidateBatcher = new InvalidateBatcher({
      requestRender: () => {
        if (this.disposed) return
        this.refreshOutlets()
        // The TuiApp merges the re-baked outlet text into its chrome rows.
        this.onChromeRefresh?.()
        this.requestRender()
      },
    })
    this.headerBadges = new HeaderBadgeOutlet(ledger, { requestRender: () => this.requestRender() })
    this.dockItems = new DockItemOutlet(ledger, { requestRender: () => this.requestRender() })
    this.footerSegments = new FooterSegmentOutlet(ledger, { requestRender: () => this.requestRender() })
    this.widgetsAbove = new WidgetOutlet(ledger, { requestRender: () => this.requestRender() }, 'input.widget.above')
    this.widgetsBelow = new WidgetOutlet(ledger, { requestRender: () => this.requestRender() }, 'input.widget.below')
  }

  /**
   * Register the host's chrome re-merge callback (TuiApp.refreshChrome).
   * Called after an invalidation batch re-bakes the outlets, so the
   * header/dock/footer Text components pick up the new content.
   */
  setChromeRefresher(refresher: () => void): void {
    this.onChromeRefresh = refresher
  }

  /** Attach the outlets to the host's chrome components and publish the
   * surface snapshot. Called once per surface generation. The host's
   * components stay host-owned; the outlets only write their content into
   * them (the host merges its own chrome around the extension content).
   *
   * Attachment also re-sinks the ledger's invalidation so a plugin's
   * register/replace/dispose/invalidate REACHES the screen: the batcher
   * flush re-bakes the outlets and repaints (F-17). */
  attach(chrome: {
    header: Text
    dock: Text
    footer: Text
  }, surface: SurfaceSnapshot): void {
    if (this.disposed) return
    // Idempotent attach (review round-3 finding 1): a repeated attach on
    // the SAME host must not mint a new generation — that would leak the
    // old attachment's generation (a later dispose would freeze only the
    // latest one) and leave a dead sink. The first attach owns the lease
    // for this host's lifetime; repeat calls only refresh the snapshot.
    if (this.ownToken !== undefined) {
      this.store.set({ surface })
      this.refreshOutlets()
      this.onChromeRefresh?.()
      this.requestRender()
      return
    }
    // The chrome Texts are the host's own components; the outlets produce
    // TEXT (headerBadgeText/dockText/footerText) that the host merges into
    // them at render time — nothing is stored here (round-4 finding 3).
    void chrome
    // The attachment lease (P1): one host's attach CREATES a fresh token;
    // its dispose must not invalidate a LATER host attached to the same
    // ledger. The token is captured before the re-sink so the ledger's
    // sink is owned by THIS attachment from the moment it is installed.
    const token = {}
    this.ownToken = token
    // The ledger assigns each attachment a generation (plan §6.2): this
    // host records its OWN generation so a final dispose can freeze/remove
    // exactly the registrations of generations up to its own — never a
    // newer host's.
    this.ownGeneration = this.ledger.markAttachment(token)
    this.store.set({ surface })
    this.capabilities.add('slot.chrome.header.badge')
    this.capabilities.add('slot.input.dock.item')
    this.capabilities.add('slot.chrome.footer.status')
    this.capabilities.add('slot.input.widget')
    this.capabilities.add('surface.snapshot')
    // F-17: every ledger content change re-bakes the outlets and repaints,
    // coalesced through the host's batcher (one flush per tick). The sink
    // checks THIS host's own token: a stale host whose sink was replaced
    // by a newer attachment must not flush its dead batcher.
    this.ledger.setInvalidateSink(() => {
      if (this.disposed || this.ownToken !== token) return
      this.invalidateBatcher.invalidate()
    })
    this.refreshOutlets()
    // Pre-attach registrations (cold catalog) must render immediately:
    // re-merge the chrome rows after the outlets baked (F-17).
    this.onChromeRefresh?.()
    this.requestRender()
  }

  /** The current immutable state slices (outlets + host read from here). */
  state(): SurfaceStateValues {
    return this.store.get()
  }

  /** Subscribe to a state slice (see SurfaceStateStore.subscribe). */
  subscribe<T>(selector: { select(state: SurfaceStateValues): T; notify(value: T): void }): () => void {
    return this.store.subscribe(selector)
  }

  /**
   * Subscribe to the WHOLE state (listener form, for the extension service
   * bridge): fires once with the current snapshot, then on every change.
   * The store notifies only when a slice changed; a whole-state listener
   * receives every changed snapshot.
   */
  subscribeState(listener: (state: SurfaceStateValues) => void): () => void {
    return this.store.subscribe({
      select: state => state,
      notify: (state) => listener(state as SurfaceStateValues),
    })
  }

  /** The capability set this surface currently supports. */
  capabilitiesOf(): ReadonlySet<PiTuiCapability> {
    return this.capabilities
  }

  /** Re-render every outlet from the ledger + the host chrome. The host
   * calls this after any extension invalidate burst or theme switch; the
   * theme revision rides along so a palette change re-bakes the ANSI even
   * when the ledger revision is unchanged (F-14). The layout budgets are
   * host-owned (plan §19): the header/footer get the CURRENT terminal
   * width, the dock gets its row budget — so a plugin can never overflow
   * the chrome. */
  refreshOutlets(): void {
    if (this.disposed) return
    const state = this.store.get()
    const themeRevision = state.surface.themeRevision
    // The width budget only applies once the surface has REAL geometry
    // (attach publishes width/height); a pre-attach host (width 0) keeps
    // the outlet defaults so early bakes are never squeezed into 1 column.
    const width = state.surface.width > 0 ? Math.max(1, state.surface.width) : 80
    this.headerBadges.refresh(themeRevision, this.headerBudget)
    // The dock gets BOTH budgets (plan §19, follow-up P1): the row budget
    // AND the current cell width, so a long label is truncated instead of
    // wrapping into extra rows.
    this.dockItems.refresh(themeRevision, this.dockMaxRows, width)
    this.footerSegments.refresh(this.footerSegmentsCompact, themeRevision, width)
    // Widgets (M4): bounded rows in the editor zone, width + row budgets
    // host-owned. The above/below row budgets are separate so a widget can
    // never push the editor off-screen (plan §19 height priority).
    this.widgetsAbove.refresh(themeRevision, width, this.widgetRowsAbove)
    this.widgetsBelow.refresh(themeRevision, width, this.widgetRowsBelow)
    this.requestRender()
  }

  /** The dock row budget (host-owned; plan §19): how many rows the dock
   * strip may occupy before low-importance items are collapsed. */
  private dockMaxRows = 2

  /** Set the dock row budget and re-bake. */
  setDockMaxRows(rows: number): void {
    if (this.disposed) return
    this.dockMaxRows = Math.max(1, Math.floor(rows))
    const state = this.store.get().surface
    const width = state.width > 0 ? Math.max(1, state.width) : 80
    this.dockItems.refresh(state.themeRevision, this.dockMaxRows, width)
  }

  /** The header badge run budget (host-owned; plan §19): the cell width the
   * badge run may occupy after the host title. */
  private headerBudget = 80

  /** Set the header badge run budget and re-bake. */
  setHeaderBudget(width: number): void {
    if (this.disposed) return
    this.headerBudget = Math.max(1, Math.floor(width))
    this.headerBadges.refresh(this.store.get().surface.themeRevision, this.headerBudget)
  }

  /** The footer compact flag the outlet should bake with (host sets it via
   * setFooterPreset; defaults to full). */
  private footerSegmentsCompact = false
  setFooterCompact(compact: boolean): void {
    if (this.disposed) return
    this.footerSegmentsCompact = compact
    // Pass the CURRENT width too (follow-up P1 finding 5): a compact toggle
    // after a narrow resize must re-bake at the new width — the outlet's
    // stored default would otherwise keep the stale budget.
    const state = this.store.get().surface
    const width = state.width > 0 ? Math.max(1, state.width) : 80
    this.footerSegments.refresh(compact, state.themeRevision, width)
  }

  /** The host-owned row budget for the above-editor widget zone (plan §19:
   * minimum editor usability always wins — the host shrinks widgets before
   * the editor). */
  private widgetRowsAbove = 3
  setWidgetRowsAbove(rows: number): void {
    if (this.disposed) return
    this.widgetRowsAbove = Math.max(1, Math.floor(rows))
    const state = this.store.get().surface
    const width = state.width > 0 ? Math.max(1, state.width) : 80
    this.widgetsAbove.refresh(state.themeRevision, width, this.widgetRowsAbove)
  }

  /** The host-owned row budget for the below-editor widget zone. */
  private widgetRowsBelow = 3
  setWidgetRowsBelow(rows: number): void {
    if (this.disposed) return
    this.widgetRowsBelow = Math.max(1, Math.floor(rows))
    const state = this.store.get().surface
    const width = state.width > 0 ? Math.max(1, state.width) : 80
    this.widgetsBelow.refresh(state.themeRevision, width, this.widgetRowsBelow)
  }

  /** The header-badge content the host should append to its own title. */
  headerBadgeText(): string {
    return this.headerBadges.text()
  }

  /** The dock content (extension items only; the host merges its own). */
  dockText(): string {
    return this.dockItems.text()
  }

  /** The footer extension segments (host merges into its status line). */
  footerText(): string {
    return this.footerSegments.text()
  }

  /** The above-editor widget rows (host merges into its editor zone). */
  widgetsAboveText(): string {
    return this.widgetsAbove.text()
  }

  /** The below-editor widget rows (host merges into its editor zone). */
  widgetsBelowText(): string {
    return this.widgetsBelow.text()
  }

  /** Whether any widget currently renders above the editor (the host
   * inserts the row only when there is content — an emptied zone must
   * clear its painted rows, plan §19). */
  hasWidgetsAbove(): boolean {
    return this.widgetsAbove.hasContent()
  }

  /** Whether any widget currently renders below the editor. */
  hasWidgetsBelow(): boolean {
    return this.widgetsBelow.hasContent()
  }

  /** Whether any footer extension segment is registered AND baking content
   * (F3: the host's t/s fallback turns off only when a segment actually
   * PROVIDES the counters — a registered-but-empty segment, e.g. the
   * builtin before its first state delivery, must not hide them). */
  hasFooterSegments(): boolean {
    return this.ledger.hasAny('chrome.footer.status') && this.footerSegments.text() !== ''
  }

  /** Update the surface slice (resize, fullscreen, theme). */
  updateSurface(surface: Partial<SurfaceSnapshot>): void {
    if (this.disposed) return
    this.store.set({ surface: { ...this.store.get().surface, ...surface } })
  }

  /** Update the session slice (session identity/mode). */
  updateSession(session: Partial<SurfaceStateValues['session']>): void {
    if (this.disposed) return
    this.store.set({ session: { ...this.store.get().session, ...session } })
  }

  /** Update the activity slice (working/tasks/queue/todo counts). */
  updateActivity(activity: Partial<SurfaceStateValues['activity']>): void {
    if (this.disposed) return
    this.store.set({ activity: { ...this.store.get().activity, ...activity } })
  }

  /** Detach this surface host (final dispose; M0 generation bump). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // The attachment lease (P1): only dispose the LEDGER SINK when this
    // host still OWNS the current attachment — a late old-generation
    // dispose must never disable invalidation for a newer host that
    // attached to the same ledger (the review repro: attach A, attach B,
    // dispose A => B must keep receiving invalidations). The ledger
    // decides ownership, not this host.
    if (this.ownToken !== undefined) {
      this.ledger.restoreSinkIfCurrent(this.ownToken)
      this.ownToken = undefined
    }
    // Final-disposal generation lease (plan §6.2, follow-up P1): freeze
    // and remove the registrations of generations up to THIS host's. The
    // generation bound is the isolation — a late old-generation dispose
    // freezes exactly its own era's handles/records and never touches a
    // newer host's registrations (the ledger enforces this, not the host).
    // A late old-generation replace/invalidate/dispose is a benign no-op,
    // and the old records no longer render on a newer surface. Ordinary
    // stop()/fullscreen round-trips never reach here — only the final
    // surface dispose.
    this.ledger.freezeLeases(this.ownGeneration)
    // Clear every outlet's baked text (M4): a disposed surface must not
    // leave stale widget rows (or chrome text) behind — the host's zone
    // Texts would otherwise keep painting them (the fork's emptied-pane
    // quirk).
    this.widgetsAbove.dispose()
    this.widgetsBelow.dispose()
    this.store.clearSubscribers()
    this.capabilities.clear()
  }

  /** Whether this host is detached. */
  isDisposed(): boolean {
    return this.disposed
  }

}
