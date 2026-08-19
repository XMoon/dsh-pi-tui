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

/** The surface host bound to one live surface. */
export class SurfaceHost {
  private readonly store: SurfaceStateStore
  private readonly ledger: ExtensionLedger
  private readonly headerBadges: HeaderBadgeOutlet
  private readonly dockItems: DockItemOutlet
  private readonly footerSegments: FooterSegmentOutlet
  private readonly requestRender: (force?: boolean) => void
  private readonly invalidateBatcher: InvalidateBatcher
  /** The TuiApp's chrome re-merge (refreshChrome), set at construction. */
  private onChromeRefresh: (() => void) | undefined
  /** The capability set reported while this surface is attached. */
  private readonly capabilities = new Set<PiTuiCapability>()
  private disposed = false
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
    // The chrome Texts are the host's own components; the outlets produce
    // TEXT (headerBadgeText/dockText/footerText) that the host merges into
    // them at render time — nothing is stored here (round-4 finding 3).
    void chrome
    this.store.set({ surface })
    this.capabilities.add('slot.chrome.header.badge')
    this.capabilities.add('slot.input.dock.item')
    this.capabilities.add('slot.chrome.footer.status')
    this.capabilities.add('surface.snapshot')
    // F-17: every ledger content change re-bakes the outlets and repaints,
    // coalesced through the host's batcher (one flush per tick).
    this.ledger.setInvalidateSink(() => {
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
   * when the ledger revision is unchanged (F-14). */
  refreshOutlets(): void {
    if (this.disposed) return
    const themeRevision = this.store.get().surface.themeRevision
    this.headerBadges.refresh(themeRevision)
    this.dockItems.refresh(themeRevision)
    this.footerSegments.refresh(this.footerSegmentsCompact, themeRevision)
    this.requestRender()
  }

  /** The footer compact flag the outlet should bake with (host sets it via
   * setFooterPreset; defaults to full). */
  private footerSegmentsCompact = false
  setFooterCompact(compact: boolean): void {
    if (this.disposed) return
    this.footerSegmentsCompact = compact
    this.footerSegments.refresh(compact, this.store.get().surface.themeRevision)
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
    // A disposed host must not receive ledger invalidations: restore the
    // ledger's sink to a no-op (a NEW host re-sinks on its own attach).
    this.ledger.setInvalidateSink(() => {})
    this.store.clearSubscribers()
    this.capabilities.clear()
  }

  /** Whether this host is detached. */
  isDisposed(): boolean {
    return this.disposed
  }

}
