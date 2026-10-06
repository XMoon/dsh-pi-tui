/**
 * The TUI-local footer command runtime (TS5 §13.4): the ONE owner of the
 * terminal footer's async command resources — the whole-footer
 * `FooterCommandRunner`, the per-item `FooterDynamicItemRuntime`, the status
 * subscription used only to refresh the armed command, the command output →
 * footer presentation sinks and their disposal.
 *
 * The application settings owner still decides WHEN a footer configuration
 * applies and WHAT the USER layer authorizes (trust, diagnostics, ordering);
 * this runtime owns the concrete TUI resources and never reads settings,
 * persistence or the merged/project layer.
 * @module @xmoon76/dsh-pi-tui/tui/footer/runtime
 */

import { runSyncDisposalSteps } from '../../disposal.ts'
import type { StatusSnapshot } from '../../domain/status/types.ts'
import type { FooterCommandConfig } from '../../domain/footer/command-config.ts'
import type { FooterLayoutV1 } from '../../domain/footer/layout.ts'
import {
  executableCommandItemIds,
  type FooterCustomCommandItemSettings,
} from '../../domain/footer/custom-items.ts'
import { FooterCommandRunner } from './command-runner.ts'
import { FooterDynamicItemRuntime } from './dynamic-item-runtime.ts'

/** The mounted-surface primitives the runtime consumes. */
export interface FooterRuntimeHost {
  /** The live status snapshot a spawn serializes. */
  readonly snapshot: () => StatusSnapshot
  readonly width: () => number
  readonly height: () => number
  /** Subscribe to status changes (the whole-footer command refresh cadence). */
  readonly subscribeStatus: (listener: () => void) => () => void
  /** Commit the sanitized whole-footer command rows (undefined = native). */
  readonly onCommandOutput: (rows: string[] | undefined) => void
  /** Commit one per-item command cache value (undefined clears it). */
  readonly onCommandItemValue: (id: string, value: string | undefined) => void
  /** One-shot diagnostics (the first failure of an error generation). */
  readonly onNotifyOnce: (message: string) => void
  /** The CURRENT EFFECTIVE layout the composer renders (the activation fence). */
  readonly effectiveLayout: () => FooterLayoutV1
}

/**
 * The footer command runtime as the application settings owner consumes it:
 * every method maps 1:1 onto an existing footer-command operation, so no
 * mirrored state is introduced.
 */
export interface FooterRuntime {
  /** Arm (or re-arm) the whole-footer command surface with the USER-layer
   *  trusted config and suspend the per-item runners it covers. `signal` is
   *  the application surface lifetime: the runner self-disposes on abort. */
  armCommand(config: FooterCommandConfig, signal: AbortSignal): void
  /** Disable the whole-footer command surface (native fallback) and restore
   *  the native presentation. */
  disableCommand(): void
  /** Reconcile the per-item command runners with the trusted definitions and
   *  the authorized activation ids for the CURRENT effective layout. */
  syncCommandItems(
    trustedCommands: readonly FooterCustomCommandItemSettings[],
    authorizedIds: ReadonlySet<string>,
    signal: AbortSignal,
  ): void
  /** Suspend every per-item command runner (the whole-footer surface covers
   *  the native items; the next native apply re-arms from the layout). */
  suspendCommandItems(): void
  /** Refresh the armed whole-footer command runner (terminal resize). */
  requestRefresh(): void
  /** Release every footer-command resource (idempotent). */
  dispose(): void
}

/** Create the footer command runtime for one mounted surface. */
export function createFooterRuntime(host: FooterRuntimeHost): FooterRuntime {
  let commandRunner: FooterCommandRunner | undefined
  let commandUnsubscribe: (() => void) | undefined
  let dynamicItemRuntime: FooterDynamicItemRuntime | undefined

  const disableCommand = (): void => {
    // Retire each one-shot slot BEFORE running its callback (a throwing
    // unsubscribe/dispose must not leave a live callback behind), preserving
    // the pre-TS5 release order exactly.
    const unsubscribe = commandUnsubscribe
    commandUnsubscribe = undefined
    unsubscribe?.()
    const runner = commandRunner
    commandRunner = undefined
    runner?.dispose()
    host.onCommandOutput(undefined)
  }

  return {
    armCommand(config, signal) {
      if (commandRunner === undefined) {
        commandRunner = new FooterCommandRunner({
          config,
          snapshot: host.snapshot,
          width: host.width,
          height: host.height,
          onOutput: host.onCommandOutput,
          onNotifyOnce: host.onNotifyOnce,
          signal,
        })
        // Status changes refresh the command (coalesced to its interval).
        commandUnsubscribe = host.subscribeStatus(() => commandRunner?.requestRefresh())
      } else {
        commandRunner.setConfig(config)
      }
      commandRunner.requestRefresh()
      // The whole-footer command surface covers the native items: per-item
      // runners must not keep spawning in the background.
      dynamicItemRuntime?.sync([], new Set<string>())
    },
    disableCommand,
    syncCommandItems(trustedCommands, authorizedIds, signal) {
      if (dynamicItemRuntime === undefined) {
        dynamicItemRuntime = new FooterDynamicItemRuntime({
          snapshot: host.snapshot,
          width: host.width,
          height: host.height,
          signal,
          onValue: host.onCommandItemValue,
          onNotifyOnce: host.onNotifyOnce,
        })
      }
      const executableIds = executableCommandItemIds(
        trustedCommands,
        authorizedIds,
        host.effectiveLayout(),
      )
      dynamicItemRuntime.sync(trustedCommands, executableIds)
    },
    suspendCommandItems() {
      dynamicItemRuntime?.sync([], new Set<string>())
    },
    requestRefresh() {
      commandRunner?.requestRefresh()
    },
    dispose() {
      // Retire every owner slot before its callback runs, so a throwing
      // unsubscribe/runner disposal cannot strand its siblings (M3-6 PR3):
      // the release is ONE non-truncating batch in the same order.
      const unsubscribe = commandUnsubscribe
      const runner = commandRunner
      const dynamic = dynamicItemRuntime
      commandUnsubscribe = undefined
      commandRunner = undefined
      dynamicItemRuntime = undefined
      runSyncDisposalSteps('footer command disposal', [
        () => unsubscribe?.(),
        () => runner?.dispose(),
        // PR D: release every per-item command runner (children, timers,
        // abort listeners) before the app dies.
        () => dynamic?.dispose(),
      ])
    },
  }
}
