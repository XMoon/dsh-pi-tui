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
 * therefore ephemeral by construction: the next cold boot is default-off.
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
  type PiTuiWebAccessStatus,
} from '../../../runtime/remote/pi-tui-web-access-contract.ts'

/** Cordis `FiberState.ACTIVE` (the enum is a const enum with no runtime value). */
const FIBER_ACTIVE = 2

/**
 * The 59 official Web-only Loader rows the Host-only overlay declares, in the
 * overlay's canonical order, with the exact official package each row loads.
 *
 * FROZEN on purpose: `test/app/remote-process-host-foundation.test.ts` compares
 * this table against the real `HOST_ONLY_PATCH` roster (ids, order, packages),
 * so a dropped, renamed, reordered or duplicated row fails there instead of
 * being mirrored by a generated list.
 */
export const PI_TUI_WEB_ACCESS_ROWS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
  { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app' },
  { id: 'modules', name: '@deepseek-ai/dsh-client-modules' },
  { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
  { id: 'cordis-client-runner', name: '@deepseek-ai/dsh-cordis-client-runner' },
  { id: 'ui-open-in-app', name: '@deepseek-ai/dsh-client-ui-open-in-app' },
  { id: 'ui-settings-account', name: '@deepseek-ai/dsh-client-ui-settings-account' },
  { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme' },
  { id: 'locale', name: '@deepseek-ai/dsh-client-locale' },
  { id: 'shortcuts', name: '@deepseek-ai/dsh-client-shortcuts' },
  { id: 'ui-shortcuts', name: '@deepseek-ai/dsh-client-ui-shortcuts' },
  { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout' },
  { id: 'ui-renderer', name: '@deepseek-ai/dsh-client-ui-renderer' },
  { id: 'ui-session', name: '@deepseek-ai/dsh-client-ui-session' },
  { id: 'resources', name: '@deepseek-ai/dsh-client-resources' },
  { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
  { id: 'ui-sidebar-right', name: '@deepseek-ai/dsh-client-ui-sidebar-right' },
  { id: 'ui-sidebar-documentpreview', name: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' },
  { id: 'ui-sidebar-terminal', name: '@deepseek-ai/dsh-client-ui-sidebar-terminal' },
  { id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files' },
  { id: 'ui-settings', name: '@deepseek-ai/dsh-client-ui-settings' },
  { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general' },
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models' },
  { id: 'ui-plugin-manager', name: '@deepseek-ai/dsh-client-ui-plugin-manager' },
  { id: 'ui-settings-plugin-inventory', name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory' },
  { id: 'ui-conversation', name: '@deepseek-ai/dsh-client-ui-conversation' },
  { id: 'ui-approval', name: '@deepseek-ai/dsh-client-ui-approval' },
  { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
  { id: 'ui-brand-official', name: '@deepseek-ai/dsh-client-ui-brand-official' },
  { id: 'ui-attachment', name: '@deepseek-ai/dsh-client-ui-attachment' },
  { id: 'ui-tool', name: '@deepseek-ai/dsh-client-ui-tool' },
  { id: 'ui-cordis', name: '@deepseek-ai/dsh-client-ui-cordis' },
  { id: 'ui-deliverables', name: '@deepseek-ai/dsh-client-ui-deliverables' },
  { id: 'ui-workspace', name: '@deepseek-ai/dsh-client-ui-workspace' },
  { id: 'ui-workflow-run', name: '@deepseek-ai/dsh-client-ui-workflow-run' },
  { id: 'ui-input-trigger', name: '@deepseek-ai/dsh-client-ui-input-trigger' },
  { id: 'ui-commands', name: '@deepseek-ai/dsh-client-ui-commands' },
  { id: 'ui-skill', name: '@deepseek-ai/dsh-client-ui-skill' },
  { id: 'ui-subagent', name: '@deepseek-ai/dsh-client-ui-subagent' },
  { id: 'ui-reference', name: '@deepseek-ai/dsh-client-ui-reference' },
  { id: 'ui-secret-mask', name: '@deepseek-ai/dsh-client-ui-secret-mask' },
  { id: 'ui-jobs', name: '@deepseek-ai/dsh-client-ui-jobs' },
  { id: 'ui-schedule', name: '@deepseek-ai/dsh-client-ui-schedule' },
  { id: 'ui-goal', name: '@deepseek-ai/dsh-client-ui-goal' },
  { id: 'ui-message-feedback', name: '@deepseek-ai/dsh-client-ui-message-feedback' },
  { id: 'ui-model-selection', name: '@deepseek-ai/dsh-client-ui-model-selection' },
  { id: 'ui-deepseek-model-label-1017', name: '@deepseek-ai/dsh-client-ui-deepseek-model-label-1017' },
  { id: 'ui-permission', name: '@deepseek-ai/dsh-client-ui-permission-presets' },
  { id: 'ui-agent-preset', name: '@deepseek-ai/dsh-client-ui-agent-preset' },
  { id: 'entry-customization', name: '@deepseek-ai/dsh-client-ui-entry-customization' },
  { id: 'ui-settings-session-log', name: '@deepseek-ai/dsh-client-ui-settings-session-log' },
  { id: 'ui-settings-plugins', name: '@deepseek-ai/dsh-client-ui-settings-plugins' },
  { id: 'ui-settings-shell', name: '@deepseek-ai/dsh-client-ui-settings-shell' },
  { id: 'ui-settings-agent-loop', name: '@deepseek-ai/dsh-client-ui-settings-agent-loop' },
  { id: 'ui-settings-subagent', name: '@deepseek-ai/dsh-client-ui-settings-subagent' },
  { id: 'ui-settings-web-search', name: '@deepseek-ai/dsh-client-ui-settings-web-search' },
  { id: 'ui-plan', name: '@deepseek-ai/dsh-client-ui-plan' },
  { id: 'ui-user-questions', name: '@deepseek-ai/dsh-client-ui-user-questions' },
  { id: 'ui-trajectory', name: '@deepseek-ai/dsh-client-ui-trajectory' },
  { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' },
]

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

/** The five rows that must be assembled first/last around the other 54. */
const BROWSER_GRAPH_ROWS = ['modules', 'client-hmr', 'cordis-client-runner', 'terminal-controller'] as const
const SPA_ROW = 'web-runtime'

/** The 54 Browser presentation rows, in the overlay's canonical order. */
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
  /** The Typert registry owns the descriptors; the Loader owns the rows. */
  static readonly inject = ['typert', 'loader']
  /** The serialized mutation chain: one toggle runs at a time, failures do not poison it. */
  private tail: Promise<unknown> = Promise.resolve()
  /** The number of serialized mutations currently running (the `changing` state). */
  private inFlight = 0

  /**
   * @param ctx - the Host context this row is mounted in.
   */
  constructor(ctx: Context) {
    super(ctx, PI_TUI_WEB_ACCESS_NAMESPACE)
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
   * The private mutation method (`piTuiWebAccess/setEnabled`). Idempotent: a
   * request for the already-settled state touches no row. Concurrent requests
   * are serialized in ONE Host-owned promise queue, and a failed mutation never
   * poisons the following entries.
   *
   * @param enabled - whether the official Web frontend must be serving.
   * @returns the status the Host actually reached, never the requested boolean.
   */
  setEnabled(enabled: boolean): Promise<PiTuiWebAccessStatus> {
    const run = this.tail.then(() => this.apply(enabled))
    // Keep the chain alive on failure: the next request must still run.
    this.tail = run.then(() => undefined, () => undefined)
    return run
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
