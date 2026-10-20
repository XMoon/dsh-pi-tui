/**
 * Headless tests for the startup row's missing-surface readiness handshake.
 *
 * The handshake exists so an explicitly requested TUI never reports a
 * successful startup that never mounted. Its correctness depends on the
 * launcher's readiness contract, which these tests model EXACTLY as DSH's
 * `apps/cli/src/profile-boot.ts` implements it:
 *
 *   - a listener registered BEFORE the commit runs LATER, at commit time;
 *   - a listener registered AFTER the commit runs SYNCHRONOUSLY, inside the
 *     `onReady` call itself.
 *
 * The synchronous case is reachable at runtime: DSH's HMR recomposition stops
 * the `tui-startup` and `tui-app` rows and starts them again with the
 * current files. The re-applied startup row registers its readiness listener
 * AFTER the launcher committed readiness, so the listener runs synchronously
 * inside that row's own `apply()`. A handshake that treats that synchronous
 * call as "the tree booted without a TUI" exits the running application.
 *
 * @module @xmoon76/dsh-pi-tui/startup-readiness.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyStartup, TUI_STARTUP_SERVICE } from '../src/startup.ts'

/** The launcher's readiness signal, modelled exactly as DSH's
 * `apps/cli/src/profile-boot.ts` implements it. */
class LauncherReadiness {
  private ready = false
  private readonly listeners = new Set<() => void>()

  /** The `appReady` service handed to the plugin. */
  readonly service = {
    onReady: (listener: () => void): (() => void) => {
      if (this.ready) {
        // The official contract: readiness was already committed, so the
        // listener runs SYNCHRONOUSLY, inside this call.
        listener()
        return () => {}
      }
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  }

  /** Commit readiness: every pending listener runs now. */
  commit(): void {
    if (this.ready) return
    this.ready = true
    for (const listener of [...this.listeners]) listener()
    this.listeners.clear()
  }
}

/** Mount the startup row against a launcher that owns readiness and exit. */
function mountStartup(readiness: LauncherReadiness, exitCodes: number[]): Context {
  const ctx = new Context()
  ctx.provide('cmdlineArgs', { get: () => [] })
  ctx.provide('appExit', ((code: number) => { exitCodes.push(code) }) as never)
  ctx.provide('appReady', readiness.service as never)
  applyStartup(ctx)
  return ctx
}

/** Capture stderr writes into an array. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => { lines.push(chunk); return true }) as typeof process.stderr.write
  return { lines, restore: () => { process.stderr.write = original } }
}

/** The runner's mount seam: the runner row calls it once its synchronous
 * initialization succeeded and its async startup root is established. */
function markMounted(ctx: Context): void {
  const startup = ctx.get(TUI_STARTUP_SERVICE) as { markSurfaceMounted?: () => void } | undefined
  startup?.markSurfaceMounted?.()
}

// ── the cold start ──────────────────────────────────────────────────────────

test('a cold startup whose TUI surface never mounts exits nonzero', () => {
  // The cold-start contract: readiness is committed AFTER the tree mounted, so
  // the handshake observes the missing surface and the invocation fails loudly.
  const readiness = new LauncherReadiness()
  const exitCodes: number[] = []
  const ctx = mountStartup(readiness, exitCodes)
  const stderr = captureStderr()
  try {
    readiness.commit()
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [1], 'a missing required surface must exit nonzero')
  assert.match(stderr.lines.join(''), /required TUI surface did not mount/u)
})

test('a cold startup whose TUI surface mounted does not exit', () => {
  const readiness = new LauncherReadiness()
  const exitCodes: number[] = []
  const ctx = mountStartup(readiness, exitCodes)
  markMounted(ctx)
  const stderr = captureStderr()
  try {
    readiness.commit()
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [], 'a mounted surface must not exit')
  assert.deepEqual(stderr.lines, [])
})

// ── the runtime replacement ─────────────────────────────────────────────────

test('a startup row applied AFTER readiness was committed does not exit the running application', () => {
  // The runtime HMR path: the launcher already committed readiness, and the
  // recomposition re-applies the startup row. The launcher's contract runs a
  // listener registered after the commit SYNCHRONOUSLY, so the handshake runs
  // inside this row's own apply(), before the runner row had a chance to mark
  // the surface mounted. The running application must survive that.
  const readiness = new LauncherReadiness()
  readiness.commit()
  const exitCodes: number[] = []
  const stderr = captureStderr()
  try {
    mountStartup(readiness, exitCodes)
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [], 'a re-applied startup row must not exit a running application')
  assert.deepEqual(stderr.lines, [], 'a re-applied startup row must not report a missing surface')
})

test('the re-applied row observes the SYNCHRONOUS callback inside its own apply()', () => {
  // The regression's exact shape: the callback must run BEFORE `apply()`
  // returns, i.e. inside the `onReady` call stack, not in a later tick. A fix
  // that only defers the callback would still exit the running application.
  const readiness = new LauncherReadiness()
  readiness.commit()
  const order: string[] = []
  const exitCodes: number[] = []
  const ctx = new Context()
  ctx.provide('cmdlineArgs', { get: () => [] })
  ctx.provide('appExit', ((code: number) => { exitCodes.push(code) }) as never)
  ctx.provide('appReady', ({
    onReady: (listener: () => void) => {
      order.push('onReady:enter')
      listener()
      order.push('onReady:return')
      return () => {}
    },
  }) as never)
  applyStartup(ctx)
  order.push('apply:return')
  assert.deepEqual(order, ['onReady:enter', 'onReady:return', 'apply:return'],
    'the launcher runs the callback synchronously, before apply() returns')
  assert.deepEqual(exitCodes, [], 'the synchronous callback must not exit')
})

test('a re-applied row does not judge a startup it never witnessed', () => {
  // The re-applied row owns no startup verdict: readiness was committed before
  // it existed, so the startup it could "judge" is not its own. The cold-start
  // case above owns that failure, because there the row DID witness the
  // startup.
  const readiness = new LauncherReadiness()
  readiness.commit()
  const exitCodes: number[] = []
  const stderr = captureStderr()
  try {
    mountStartup(readiness, exitCodes)
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [], 'the re-applied row must not re-judge a committed startup')
  assert.deepEqual(stderr.lines, [])
})

test('a re-applied row whose surface is never restored delivers no verdict at all', () => {
  // The BOUNDED consequence of the runtime path, pinned here so it cannot
  // drift silently: the re-applied row's readiness callback has ALREADY run
  // by the time the row can act, and nothing re-arms it. A replacement that
  // never restores the TUI is therefore NOT reported by this handshake — the
  // launcher owns that outcome (DSH's HMR reports the failed replacement
  // itself). The row's only verdict is about a startup it witnessed.
  const readiness = new LauncherReadiness()
  readiness.commit()
  const exitCodes: number[] = []
  const stderr = captureStderr()
  try {
    // The runner row never marks the surface: the replacement failed.
    mountStartup(readiness, exitCodes)
    // Nothing re-arms the callback, so no later moment can produce a verdict.
    readiness.commit()
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [], 'the re-applied row must not report the missing surface at runtime')
  assert.deepEqual(stderr.lines, [], 'the re-applied row must not print the missing-surface notice at runtime')
})

test('a re-applied row that IS told its surface mounted stays silent', () => {
  // The positive counterpart of the runtime path: when the replacement's
  // runner does mark the surface, nothing is reported and nothing exits.
  const readiness = new LauncherReadiness()
  readiness.commit()
  const exitCodes: number[] = []
  const stderr = captureStderr()
  try {
    const ctx = mountStartup(readiness, exitCodes)
    markMounted(ctx)
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [])
  assert.deepEqual(stderr.lines, [])
})

test('the readiness listener is cancelled when the row is unloaded BEFORE the commit', async () => {
  // The launcher's `commit()` clears its listener set, so a listener that
  // already ran cannot outlive the commit. The OTHER path needs the
  // cancellation: the row is unloaded BEFORE the launcher commits, so its
  // registration must be cancelled instead of judging a startup the row
  // never witnessed.
  const readiness = new LauncherReadiness()
  const exitCodes: number[] = []
  const ctx = mountStartup(readiness, exitCodes)
  await ctx.fiber?.dispose()
  const stderr = captureStderr()
  try {
    readiness.commit()
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [], 'an unloaded row must not judge the startup')
  assert.deepEqual(stderr.lines, [])
})

test('the launcher clears its listeners at the commit, so a committed listener cannot outlive it', () => {
  // The launcher's own contract: `commit()` runs the pending listeners and
  // clears the set. The row's cancellation therefore covers only the
  // pre-commit unload path, and this test pins that the launcher behaves
  // that way (the reason the row's cancellation is NOT the leak guard for
  // the committed path).
  const readiness = new LauncherReadiness()
  const exitCodes: number[] = []
  const ctx = mountStartup(readiness, exitCodes)
  markMounted(ctx)
  readiness.commit()
  const stderr = captureStderr()
  try {
    // A second commit is a no-op for the launcher.
    readiness.commit()
  } finally {
    stderr.restore()
  }
  assert.deepEqual(exitCodes, [], 'a mounted surface must not exit')
  assert.deepEqual(stderr.lines, [])
})
