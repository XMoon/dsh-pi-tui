/**
 * The private `piTuiWebAccess` Host service (M5-W PR-B) — the ONE authority
 * that enables/disables the official Web frontend on a running Split Host.
 *
 * ```text
 * service    piTuiWebAccess                       (Host Cordis service key)
 * authority  the live Loader rows + the official Web services they publish
 * methods    getStatus() / setEnabled(enabled)    (see the contract module)
 * ```
 *
 * The toggle is NOT a Browser access revocation, a logout or a security
 * boundary: it stops serving the official SPA and unloads the Web-only Browser
 * graph. An already loaded browser page is deliberately unspecified — see the
 * durable contract in `docs/architecture/host-client.md`.
 *
 * The ONE availability authority is the real Loader row plus the official
 * `webApp` / `clientModules` / `terminalController` services, read on every
 * query. There is no persisted `enabled` flag, no config file, no token table
 * and no second truth: the in-memory `inFlight` counter only distinguishes a
 * concurrent serialized mutation (`changing`) from a settled state.
 *
 * Every mutation goes through `Entry.update({ disabled })` on the rows the
 * Host-only overlay already declares — never `loader.update()`, never a
 * `ConfigEditor`/plugin-manager write, never `cordis.patch.yml`. The toggle is
 * therefore ephemeral by construction: a cold boot starts from the overlay's
 * default-off rows, and only the profile's own `pi-tui-web-preferences.autoStart`
 * preference (a separate, durable next-launch fact) can ask the boot sequence to
 * enable the same roster before Ready.
 *
 * PROFILE RECOMPOSITION: the official settings write (`SettingsForms.mutate` →
 * `ConfigEditor.edit`) reconciles the whole profile patch stack before and after
 * writing the user patch, and `recompose()` re-applies this overlay's declarative
 * `disabled: true` rows — which would otherwise silently disable a running Web
 * frontend whenever the user saves ANY setting. The service therefore keeps the
 * current Host lifetime's last SUCCESSFULLY requested enablement as a TARGET
 * INTENT (never a state authority: `getStatus()` still reads the live Loader),
 * and after the official `app-boot/config-reload` it restores the live roster
 * through the SAME `setEnabled` path when the recomposition diverged from that
 * target. This is an in-memory lifecycle repair of the existing authority: it
 * persists nothing, adds no listener-visible state and does not survive a
 * process restart. A recomposition still unloads the Web rows for a short
 * window, so a browser connection may briefly drop; the FINAL state is
 * preserved by design.
 *
 * LAYER NOTE: this row lives in `app/host/features/**` because the built-in
 * Host Runtime owns the row and its lifetime; its wire contract lives in
 * `runtime/remote/**`, the direction the architecture gate permits.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/web-access
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  PI_TUI_WEB_ACCESS_NAMESPACE,
  type PiTuiWebAccessAuthenticatedUrl,
  type PiTuiWebAccessStatus,
} from '../../../runtime/remote/pi-tui-web-access-contract.ts'
import { PI_TUI_WEB_ACCESS_ROWS } from './web-roster.ts'

/** Cordis `FiberState.ACTIVE` (the enum is a const enum with no runtime value). */
const FIBER_ACTIVE = 2

/**
 * The production Web-only Loader roster is pure data owned by
 * `./web-roster.ts`; this service verifies the LIVE Loader against it and owns
 * every enable/disable transition. The table is the composition expectation,
 * never a statement that those rows are currently mounted.
 */

/**
 * The official Web services whose live binding is what `enabled` claims:
 * `webApp` owns the SPA fallback, `clientModules` owns the `/plugins` graph and
 * `terminalController` is the Web Browser's Host-side terminal owner.
 */
const REQUIRED_WEB_SERVICES = ['webApp', 'clientModules', 'terminalController'] as const

/**
 * The ONLY row allowed to stay PENDING while the composition reports
 * `enabled`: `ui-deliverables` awaits the Host-side `workspaceChanges`
 * projection this stage does not mount. A pending OPTIONAL Browser feature is
 * recorded, never reported as a core Web failure.
 */
export const PI_TUI_WEB_ACCESS_OPTIONAL_PENDING_ROWS: ReadonlySet<string> = new Set(['ui-deliverables'])

/** The five rows that must be assembled first/last around the other 55. */
const BROWSER_GRAPH_ROWS = ['modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller'] as const
const SPA_ROW = 'web-runtime'

/** The 55 Browser presentation rows, in the overlay's canonical order. */
const PRESENTATION_ROWS = PI_TUI_WEB_ACCESS_ROWS
  .map(row => row.id)
  .filter(id => id !== SPA_ROW && !(BROWSER_GRAPH_ROWS as readonly string[]).includes(id))

/**
 * FROZEN enable order: assemble the browser graph first, then its presentation
 * rows, and withdraw nothing — the SPA fallback is mounted LAST so the official
 * index is never served before the graph it advertises exists.
 *
 * Exported because the order is a product decision, not an implementation
 * detail: the source test asserts THIS sequence.
 */
export const PI_TUI_WEB_ACCESS_ENABLE_ORDER: readonly string[] = [
  ...BROWSER_GRAPH_ROWS,
  ...PRESENTATION_ROWS,
  SPA_ROW,
]

/**
 * FROZEN disable order: withdraw the SPA fallback FIRST, then the presentation
 * rows in reverse canonical order, then the browser graph rows last so
 * `clientModules` keeps owning `/plugins` until nothing can request it.
 *
 * Exported for the same reason as the enable order.
 */
export const PI_TUI_WEB_ACCESS_DISABLE_ORDER: readonly string[] = [
  SPA_ROW,
  ...[...PRESENTATION_ROWS].reverse(),
  ...[...BROWSER_GRAPH_ROWS].reverse(),
]

/** The package each roster id must load, keyed by id. */
const ROSTER_PACKAGES = new Map(PI_TUI_WEB_ACCESS_ROWS.map(row => [row.id, row.name]))

/** Every official package exactly one roster row owns. */
const ROSTER_PACKAGE_NAMES: ReadonlySet<string> = new Set(PI_TUI_WEB_ACCESS_ROWS.map(row => row.name))

/** Minimal structural view of one Loader entry (the live row object). */
interface LoaderEntryLike {
  readonly options: { readonly id: string; readonly name: string; readonly disabled?: boolean | null }
  /** Effective disabled state, including an owning disabled group. */
  readonly disabled: boolean
  readonly fiber?: LoaderFiberLike
  update(options: { readonly disabled?: boolean }): Promise<void>
}

/** Minimal structural view of one Loader fiber. */
interface LoaderFiberLike {
  readonly uid: number | null
  readonly state: number
  readonly inertia?: Promise<void>
  await(): Promise<unknown>
}

/** Minimal structural view of the Host's own Loader. */
interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
  await(): Promise<unknown>
}

/** The exact row set this Host's Loader currently owns for the roster. */
type WebRoster = ReadonlyMap<string, LoaderEntryLike>

/** Append the best-effort cleanup failures to one redacted diagnostic. */
function withCleanup(reason: string, cleanup: readonly unknown[]): string {
  if (cleanup.length === 0) return reason
  return `${reason} (cleanup: ${cleanup.map(reasonOf).join('; ')})`
}

/** One fixed diagnostic for the status vocabulary (never a token/URL/path). */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

/**
 * The private Web access authority. One instance per built-in Host Runtime; the
 * service leaves with the owning fiber.
 */
export class PiTuiWebAccessHostService extends TypertRemoteService {
  /**
   * The Typert registry owns the descriptors. The Host's Loader is read PER CALL
   * (`loader()` below) instead of declared here: this service is mounted by a
   * Loader row, so the Loader is guaranteed in every real composition, and a
   * Host that somehow lacks one must report `unavailable` rather than hold the
   * mounting row pending forever.
   */
  static readonly inject = ['typert']
  /** The serialized mutation chain: one toggle runs at a time, failures do not poison it. */
  private tail: Promise<unknown> = Promise.resolve()
  /** The number of serialized mutations currently running (the `changing` state). */
  private inFlight = 0
  /**
   * The current Host lifetime's last SUCCESSFULLY requested enablement, or
   * `undefined` before any toggle. It is a TARGET INTENT for the recomposition
   * repair only — NEVER a state authority: `getStatus()`/`describe()` keep
   * reading the live Loader rows and official Web services on every call.
   */
  private target: 'enabled' | 'disabled' | undefined

  /**
   * @param ctx - the Host context this row is mounted in.
   */
  constructor(ctx: Context) {
    super(ctx, PI_TUI_WEB_ACCESS_NAMESPACE)
    // The official profile recomposition re-applies this overlay's declarative
    // `disabled: true` rows. Restore THIS Host's live target after it settled,
    // through the one serialized mutation queue. The event is the official
    // post-settlement signal; there is no earlier hook.
    //
    // STRUCTURAL by contract (same rule as the retired `dsh-session-query`
    // peer): the event NAME is the official one, but this is a one-line
    // subscription, not a runtime API import — importing `dsh-app-boot` (even
    // type-only) would add a package peer for a Cordis event string. The cast
    // stays ON `ctx.on` so the Host-subscription inventory still sees it.
    ;(ctx.on as (event: 'app-boot/config-reload', listener: () => void) => unknown)(
      'app-boot/config-reload',
      () => { this.reconcileAfterRecompose() },
    )
  }

  /**
   * The private status method (`piTuiWebAccess/getStatus`, see
   * `pi-tui-web-access-contract.ts`). Reads the live Loader rows and the
   * official Web services on every call; never a cached flag.
   */
  async getStatus(): Promise<PiTuiWebAccessStatus> {
    return this.inFlight > 0 ? { state: 'changing' } : this.describe()
  }

  /**
   * The private authenticated-URL method (`piTuiWebAccess/getAuthenticatedUrl`):
   * the official launch URL of THIS Host's Web frontend, built by the official
   * `connection.authenticatedUrl(webServer.getOrigin() + '/')`.
   *
   * It answers ONLY while the live roster/status is `enabled`. The value carries
   * the official launch token, so this method never stores it, never adds it to
   * a status object and never writes it to a diagnostic: the caller (one
   * explicit user action) is the only owner.
   *
   * @returns the official authenticated URL of the running Web frontend.
   */
  async getAuthenticatedUrl(): Promise<PiTuiWebAccessAuthenticatedUrl> {
    const status = await this.getStatus()
    if (status.state !== 'enabled') {
      throw new Error(status.state === 'unavailable'
        ? `web access: the official Web frontend is unavailable (${status.reason})`
        : 'web access: the official Web frontend is not enabled')
    }
    const connection = this.ctx.get('connection') as { authenticatedUrl?(baseUrl: string): string } | undefined
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') {
      throw new Error('web access: the Host has no official Connection service')
    }
    const webServer = this.ctx.get('webServer') as { getOrigin?(): string } | undefined
    if (webServer === undefined || typeof webServer.getOrigin !== 'function') {
      throw new Error('web access: the Host has no official WebServer service')
    }
    return { url: connection.authenticatedUrl(`${webServer.getOrigin()}/`) }
  }

  /**
   * The private mutation method (`piTuiWebAccess/setEnabled`). Idempotent: a
   * request for the already-settled state touches no row. Concurrent requests
   * are serialized in ONE Host-owned promise queue, and a failed mutation never
   * poisons the following entries.
   *
   * @param enabled - whether the official Web frontend must be serving.
   * @returns the status the Host actually reached, never the requested boolean.
   */
  setEnabled(enabled: boolean): Promise<PiTuiWebAccessStatus> {
    const run = this.tail.then(() => this.applyAndTrack(enabled))
    // Keep the chain alive on failure: the next request must still run.
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * One serialized mutation that updates the target intent ONLY when the Host
   * really reached the requested state. A failed/partial mutation leaves the
   * previous successful intent in place and reports its reached state.
   */
  private async applyAndTrack(enabled: boolean): Promise<PiTuiWebAccessStatus> {
    const status = await this.apply(enabled)
    if (status.state === (enabled ? 'enabled' : 'disabled')) this.target = enabled ? 'enabled' : 'disabled'
    return status
  }

  /**
   * Repair the live roster after the official profile recomposition.
   *
   * The listener runs synchronously and only ENQUEUES the repair on the same
   * serialized chain (the official emit does not await promises, and a settings
   * write also reconciles before and after its own write). The LATEST target is
   * re-read when the repair actually runs, so a user toggle admitted later wins
   * in FIFO order. No repair runs before the first successful toggle, and a
   * failed repair is reported by the live status (never a fabricated success).
   */
  private reconcileAfterRecompose(): void {
    const run = this.tail.then(() => {
      const target = this.target
      if (target === undefined) return this.describe()
      const status = this.describe()
      if (status.state === target) return status
      return this.applyAndTrack(target === 'enabled')
    })
    // Keep the chain alive; a repair failure is observed by the next status read.
    this.tail = run.then(() => undefined, () => undefined)
    // The repair is a serialized mutation whose BOTH settlements are observed:
    // a non-enabled result is the (already truthful) live status and a rejected
    // chain is logged here; no caller awaits it.
    void run.then((status) => { // allowlist: both settlements handled below
      if (status.state === 'unavailable') {
        this.logger().warn('profile recomposition repair did not reach the live target', { state: status.state })
      }
    }, (error: unknown) => {
      this.logger().warn('profile recomposition repair failed', { reason: reasonOf(error) })
    })
  }

  /** The row's own Cordis logger (diagnostics only; never a state channel). */
  private logger(): { warn(message: string, fields?: Record<string, unknown>): void } {
    return this.ctx.logger('pi-tui-web-access')
  }

  /** Run one serialized mutation and always report the reached state. */
  private async apply(enabled: boolean): Promise<PiTuiWebAccessStatus> {
    this.inFlight += 1
    try {
      let roster: WebRoster
      try {
        roster = this.resolveRoster()
      } catch (error) {
        // An unrecognized roster must never be toggled partially.
        return { state: 'unavailable', reason: reasonOf(error) }
      }
      // Idempotency: a request for the state every row already reports touches
      // no row at all, so nothing can remount.
      const targetDisabled = !enabled
      const unsettled = PI_TUI_WEB_ACCESS_ROWS
        .filter(row => (roster.get(row.id) as LoaderEntryLike).disabled !== targetDisabled)
      if (unsettled.length === 0) return this.describe()
      try {
        if (enabled) {
          await this.enableRows(roster)
        } else {
          await this.disableRows(roster)
        }
      } catch (error) {
        const cleanup = await this.disableRemaining(roster)
        return {
          state: 'unavailable',
          reason: withCleanup(reasonOf(error), cleanup),
        }
      }
      const settled = this.describe()
      if (enabled && settled.state !== 'enabled') {
        // The rows mounted but the Web graph is not actually serving: withdraw
        // it instead of leaving a partial SPA reachable behind a failed claim.
        const cleanup = await this.disableRemaining(roster)
        return {
          state: 'unavailable',
          reason: withCleanup(settled.state === 'unavailable' ? settled.reason : 'web access: the Web graph did not settle', cleanup),
        }
      }
      return settled
    } finally {
      this.inFlight -= 1
    }
  }

  /**
   * Bring the whole Web roster up in the frozen enable order. Every row is
   * awaited through its own fiber (so a rejected plugin apply is a real
   * failure) and through Loader settlement.
   */
  private async enableRows(roster: WebRoster): Promise<void> {
    for (const id of PI_TUI_WEB_ACCESS_ENABLE_ORDER) {
      const entry = roster.get(id) as LoaderEntryLike
      if (entry.disabled) await entry.update({ disabled: false })
      await this.settleEnabled(entry)
    }
  }

  /** Tear the whole Web roster down in the frozen disable order. */
  private async disableRows(roster: WebRoster): Promise<void> {
    for (const id of PI_TUI_WEB_ACCESS_DISABLE_ORDER) {
      await this.disableEntry(roster.get(id) as LoaderEntryLike)
    }
  }

  /** Dispose ONE Web row and await its fiber release plus Loader settlement. */
  private async disableEntry(entry: LoaderEntryLike): Promise<void> {
    if (entry.disabled) return
    const released = entry.fiber
    await entry.update({ disabled: true })
    // `Entry.update` disposes the row's fiber without awaiting it; the old
    // fiber's own unload promise is the release fact.
    await released?.inertia
    await this.loader().await()
  }

  /** Await one enabled row's fiber AND its Loader settlement. */
  private async settleEnabled(entry: LoaderEntryLike): Promise<void> {
    const fiber = entry.fiber
    if (fiber === undefined) throw new Error(`web access: the "${entry.options.id}" row did not mount a fiber`)
    await fiber.await()
    await this.loader().await()
  }

  /**
   * Best-effort recovery after a failed mutation: return the WHOLE Web roster
   * to disabled, reporting every cleanup failure instead of swallowing it. A
   * failed disable keeps closing; a failed enable withdraws what it mounted so
   * no partial Web surface stays served. Shared Host owners are never touched.
   */
  private async disableRemaining(roster: WebRoster): Promise<unknown[]> {
    const failures: unknown[] = []
    for (const id of PI_TUI_WEB_ACCESS_DISABLE_ORDER) {
      try {
        await this.disableEntry(roster.get(id) as LoaderEntryLike)
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
  }

  /**
   * Read the availability the live Loader and the official Web services prove.
   * A settled roster is `disabled` (everything off) or `enabled` (everything on
   * and the Web services live); anything in between is `unavailable`, because
   * neither claim would be true.
   */
  private describe(): PiTuiWebAccessStatus {
    let roster: WebRoster
    try {
      roster = this.resolveRoster()
    } catch (error) {
      return { state: 'unavailable', reason: reasonOf(error) }
    }
    const disabled = PI_TUI_WEB_ACCESS_ROWS.filter(row => (roster.get(row.id) as LoaderEntryLike).disabled)
    if (disabled.length === PI_TUI_WEB_ACCESS_ROWS.length) {
      const published = REQUIRED_WEB_SERVICES.filter(service => this.ctx.reflect.get(service) !== undefined)
      if (published.length > 0) {
        return {
          state: 'unavailable',
          reason: `web access: the Web rows are disabled but the official Web services are still published: ${published.join(', ')}`,
        }
      }
      return { state: 'disabled' }
    }
    if (disabled.length > 0) {
      const named = disabled.slice(0, 8).map(row => row.id).join(', ')
      const more = disabled.length > 8 ? ', ...' : ''
      return {
        state: 'unavailable',
        reason: `web access: ${String(disabled.length)} of the ${String(PI_TUI_WEB_ACCESS_ROWS.length)} Web rows are disabled (${named}${more}) and the rest are enabled`,
      }
    }
    for (const row of PI_TUI_WEB_ACCESS_ROWS) {
      const entry = roster.get(row.id) as LoaderEntryLike
      const state = entry.fiber?.state
      if (state === FIBER_ACTIVE) continue
      if (PI_TUI_WEB_ACCESS_OPTIONAL_PENDING_ROWS.has(row.id)) continue
      return {
        state: 'unavailable',
        reason: `web access: the "${row.id}" row is ${state === undefined ? 'not started' : `state-${String(state)}`}, not active`,
      }
    }
    const missing = REQUIRED_WEB_SERVICES.filter(service => this.ctx.reflect.get(service) === undefined)
    if (missing.length > 0) {
      return {
        state: 'unavailable',
        reason: `web access: the official Web services are missing: ${missing.join(', ')}`,
      }
    }
    return { state: 'enabled' }
  }

  /**
   * Resolve EXACTLY one live row per roster id from this Host's own Loader.
   * A missing, duplicated or re-pointed row is refused instead of toggling a
   * partial graph.
   */
  private resolveRoster(): WebRoster {
    const resolved = new Map<string, LoaderEntryLike>()
    for (const entry of this.loader().entries()) {
      const id = entry.options.id
      const expected = ROSTER_PACKAGES.get(id)
      if (expected === undefined) {
        // A second row loading a roster package under another id would own the
        // same official service twice; the toggle refuses the whole roster
        // instead of driving a graph with a duplicate owner.
        if (ROSTER_PACKAGE_NAMES.has(entry.options.name)) {
          throw new Error(`web access: the Loader owns a second ${JSON.stringify(entry.options.name)} row outside the roster ("${id}")`)
        }
        continue
      }
      if (entry.options.name !== expected) {
        throw new Error(`web access: the "${id}" row loads ${JSON.stringify(entry.options.name)}, not ${JSON.stringify(expected)}`)
      }
      if (resolved.has(id)) throw new Error(`web access: the Loader owns more than one "${id}" row`)
      resolved.set(id, entry)
    }
    const missing = PI_TUI_WEB_ACCESS_ROWS.map(row => row.id).filter(id => !resolved.has(id))
    if (missing.length > 0) {
      throw new Error(`web access: the Host Loader does not own the Web rows: ${missing.join(', ')}`)
    }
    return resolved
  }

  /** Read the Host's own Loader service per call, never a composition snapshot. */
  private loader(): LoaderLike {
    const loader = this.ctx.get('loader') as LoaderLike | undefined
    if (loader === undefined) throw new Error('web access: the Host has no Loader service')
    return loader
  }
}
