/**
 * The custom command item runtime (PR D): the ASYNC, client-local executor
 * for USER-layer trusted `kind:'command'` custom footer definitions. It
 * arms ONE FooterCommandRunner per command item the ACTIVE layout
 * references, caches the first non-empty sanitized output line per item,
 * and never touches the render path — FooterItemDefinition.render() reads
 * the cache synchronously through the catalog's value source.
 *
 * Trust contract: the runtime receives ONLY definitions that already
 * passed the USER-layer semantic read (ConfigPort.footerCustomItems.get()
 * or a validated /footer save). It never reads merged/project settings
 * itself, so a project-layer command definition can never reach a spawn.
 *
 * Lifecycle contract (plan §7.2): a definition that appears and is
 * referenced arms a runner with an immediate first run; an unchanged
 * definition keeps its runner, cache and cadence (no restart per
 * repaint); a changed definition invalidates the old generation, kills the
 * old child and clears the old cache immediately; a definition removed
 * from the layout (or deleted / kind-changed) disposes the runner, its
 * timer and its cache; whole-footer command mode suspends every per-item
 * runner (the command surface covers the native items); dispose() leaves
 * no child, timer or listener behind.
 * @module @xmoon76/dsh-pi-tui/footer/dynamic-item-runtime
 */

import { FooterCommandRunner, type FooterCommandConfig } from './command-runner.ts'
import { parseFooterCommandConfig } from './command-trust.ts'
import { DEFAULT_CUSTOM_COMMAND_REFRESH_MS, type FooterCustomCommandItemSettings } from './custom-items.ts'
import type { FooterLayoutV1 } from './types.ts'
import type { StatusSnapshot } from '../status/types.ts'

/** The runtime's options. */
export interface FooterDynamicItemRuntimeOptions {
  /** The live snapshot getter (read at SPAWN time — the latest wins). */
  readonly snapshot: () => StatusSnapshot
  readonly width: () => number
  readonly height: () => number
  readonly signal: AbortSignal
  /** The cache commit: value = the first non-empty sanitized output line,
   * undefined = unavailable (cleared). The sink repaints the footer. */
  readonly onValue: (id: string, value: string | undefined) => void
  /** One-shot diagnostics (the first failure of an error generation). */
  readonly onNotifyOnce?: (message: string) => void
}

/** One armed command item: its validated config and its runner. */
interface ActiveCommandItem {
  readonly id: string
  readonly config: FooterCommandConfig
  readonly runner: FooterCommandRunner
}

/** Every item id the layout references (the runtime's active set). */
export function activeFooterItemIds(layout: FooterLayoutV1): Set<string> {
  const ids = new Set<string>()
  for (const row of layout.rows) {
    for (const ref of row.left) ids.add(ref.id)
    for (const ref of row.right) ids.add(ref.id)
  }
  return ids
}

function sameConfig(a: FooterCommandConfig, b: FooterCommandConfig): boolean {
  return a.command === b.command
    && a.timeoutMs === b.timeoutMs
    && a.refreshIntervalMs === b.refreshIntervalMs
    && a.maxRows === b.maxRows
}

/** The validated runner config for one command definition (maxRows is
 * always 1 — a custom command item is exactly one line; the composer owns
 * width/truncation). The custom-item DEFAULT refresh is 5s (several items
 * can coexist — the whole-footer 1s default would spawn a process per
 * item per second), so an ABSENT refreshIntervalMs is projected to the
 * custom default BEFORE the shared parser runs: an absent default and an
 * explicit 5s must produce the SAME cadence (the dirty comparator already
 * treats them as the same fact). The parser already validated the
 * definition, so this is defensive. */
export function customCommandConfigOf(item: FooterCustomCommandItemSettings): FooterCommandConfig | undefined {
  return parseFooterCommandConfig({
    schemaVersion: 1,
    command: item.command,
    timeoutMs: item.timeoutMs,
    refreshIntervalMs: item.refreshIntervalMs ?? DEFAULT_CUSTOM_COMMAND_REFRESH_MS,
    maxRows: 1,
  })
}

/** The custom command item runtime. */
export class FooterDynamicItemRuntime {
  private readonly options: FooterDynamicItemRuntimeOptions
  private readonly active = new Map<string, ActiveCommandItem>()
  private disposed = false

  constructor(options: FooterDynamicItemRuntimeOptions) {
    this.options = options
  }

  /** Reconcile the armed runners with the trusted definitions and the
   * active layout's semantic ids (plan §7.1 — the layout interpretation
   * stays in the Footer layer; the runtime only eats active ids).
   *
   * - wanted = trusted command definitions referenced by the layout;
   * - a runner whose id is no longer wanted is disposed (child killed,
   *   timer cleared) and its cache cleared;
   * - a NEW wanted id arms a runner and requests an immediate first run;
   * - an EXISTING id with an unchanged config keeps its runner, cache and
   *   cadence (never a restart per repaint);
   * - an EXISTING id with a changed config is invalidated through
   *   runner.setConfig (old child killed, old cache cleared, new run).
   *
   * Passing an empty trusted set (whole-footer command mode) disposes every
   * runner: the command surface covers the native items, so per-item
   * commands must not keep spawning in the background. The next native
   * apply re-arms from the layout. */
  sync(
    trustedCommands: readonly FooterCustomCommandItemSettings[],
    activeIds: ReadonlySet<string>,
  ): void {
    if (this.disposed) return
    const wanted = new Map<string, FooterCustomCommandItemSettings>()
    for (const item of trustedCommands) {
      // FIRST-wins, matching the catalog's parseFooterCustomItems contract:
      // a duplicate id reaching the runtime must never execute a different
      // command than the catalog projection.
      if (item.kind === 'command' && activeIds.has(item.id) && !wanted.has(item.id)) wanted.set(item.id, item)
    }
    for (const [id, entry] of this.active) {
      if (wanted.has(id)) continue
      this.active.delete(id)
      entry.runner.dispose()
      this.options.onValue(id, undefined)
    }
    for (const [id, item] of wanted) {
      const config = customCommandConfigOf(item)
      if (config === undefined) continue
      const existing = this.active.get(id)
      if (existing === undefined) {
        const runner = new FooterCommandRunner({
          config,
          snapshot: this.options.snapshot,
          width: this.options.width,
          height: this.options.height,
          onOutput: (rows) => this.options.onValue(id, rows?.[0]),
          onNotifyOnce: this.options.onNotifyOnce,
          // The whole-footer failure wording names the native fallback; a
          // per-item failure only makes THIS item unavailable.
          failureMessage: `custom command item "${id}" failed — item unavailable`,
          signal: this.options.signal,
        })
        this.active.set(id, { id, config, runner })
        runner.requestRefresh()
      } else if (!sameConfig(existing.config, config)) {
        existing.runner.setConfig(config)
        this.active.set(id, { id, config, runner: existing.runner })
      }
    }
  }

  /** Dispose every runner and release every cache. The app is going away:
   * no child, timer or abort listener may survive (plan §7.2 — app
   * dispose / HMR remount). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [id, entry] of this.active) {
      this.active.delete(id)
      entry.runner.dispose()
    }
  }
}
