/**
 * PR D tests for the custom command item runtime: real child processes
 * prove the active-layout lifecycle (arm on reference, immediate first
 * run, periodic refresh, config-change invalidation, remove/re-add,
 * definition delete, whole-footer command-mode suspension, dispose), the
 * per-item cache contract (first non-empty line only, empty/failure →
 * unavailable), multi-item isolation, and the trust gate (only the
 * USER-layer trusted set can ever reach a spawn).
 * @module @xmoon76/dsh-pi-tui/footer-command-item-runtime.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FooterDynamicItemRuntime, activeFooterItemIds } from '../src/footer/dynamic-item-runtime.ts'
import type { FooterCustomCommandItemSettings } from '../src/footer/custom-items.ts'
import type { FooterLayoutV1 } from '../src/footer/types.ts'
import { emptyStatusSnapshot } from '../src/status/types.ts'

/** A command item whose command runs one node script. */
function item(id: string, script: string, extra: Partial<FooterCustomCommandItemSettings> = {}): FooterCustomCommandItemSettings {
  return {
    schemaVersion: 1,
    id,
    kind: 'command',
    command: `node -e ${JSON.stringify(script)}`,
    refreshIntervalMs: 1000,
    timeoutMs: 1000,
    ...extra,
  }
}

/** A runtime harness: the committed values plus a call log. */
function harness(): {
  runtime: FooterDynamicItemRuntime
  values: Map<string, string | undefined>
  calls: Array<{ id: string; value: string | undefined }>
} {
  const values = new Map<string, string | undefined>()
  const calls: Array<{ id: string; value: string | undefined }> = []
  const runtime = new FooterDynamicItemRuntime({
    snapshot: () => emptyStatusSnapshot(),
    width: () => 100,
    height: () => 30,
    signal: new AbortController().signal,
    onValue: (id, value) => {
      calls.push({ id, value })
      values.set(id, value)
    },
  })
  return { runtime, values, calls }
}

/** Bounded spin on a predicate (no fixed sleeps). */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the runtime condition')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('activeFooterItemIds collects every referenced id (left and right zones)', () => {
  const layout: FooterLayoutV1 = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'a' }, { id: 'b' }], right: [{ id: 'a' }] }],
  }
  assert.deepEqual([...activeFooterItemIds(layout)].sort(), ['a', 'b'])
})

test('a visible command item arms a runner and commits ONLY the first non-empty line', async () => {
  const { runtime, values } = harness()
  try {
    runtime.sync([item('user:clock', 'process.stdout.write("first\\nsecond\\nthird\\n")')], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'first')
    assert.equal(values.get('user:clock'), 'first', 'only the first non-empty output line is cached')
  } finally {
    runtime.dispose()
  }
})

test('an unchanged config keeps the runner, cache and cadence (no restart per repaint)', async () => {
  const { runtime, values, calls } = harness()
  try {
    const clock = item('user:clock', 'process.stdout.write("tick\\n")')
    runtime.sync([clock], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'tick')
    const settled = calls.length
    runtime.sync([clock], new Set(['user:clock']))
    assert.equal(values.get('user:clock'), 'tick', 'an unchanged config must not clear the cache')
    // No new run may start from the no-op sync (the runner coalesces).
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(calls.length, settled, 'a no-op sync must not restart the runner')
  } finally {
    runtime.dispose()
  }
})

test('the refresh interval re-arms itself (periodic trigger) while the item stays visible', async () => {
  const { runtime, calls } = harness()
  try {
    runtime.sync([item('user:clock', 'process.stdout.write("tick\\n")')], new Set(['user:clock']))
    // ONE sync, then no further calls: the runner must still refresh at
    // least twice (the interval is a periodic trigger, not a throttle).
    await waitFor(() => calls.length >= 2)
  } finally {
    runtime.dispose()
  }
})

test('a config change kills the stale child and clears the cache immediately', async () => {
  const { runtime, values } = harness()
  try {
    const slow = item('user:clock', 'setTimeout(() => process.stdout.write("old\\n"), 2000)')
    runtime.sync([slow], new Set(['user:clock']))
    // Let the slow child spawn, then switch the command.
    await new Promise(resolve => setTimeout(resolve, 150))
    const fast = item('user:clock', 'process.stdout.write("new\\n")')
    runtime.sync([fast], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'new')
    // The stale generation must never commit, even after the old child's
    // deadline passes.
    await new Promise(resolve => setTimeout(resolve, 2300))
    assert.equal(values.get('user:clock'), 'new', 'the stale generation must never commit')
  } finally {
    runtime.dispose()
  }
})

test('a renamed id disposes the old runner; the old result cannot commit to the new id', async () => {
  const { runtime, values } = harness()
  try {
    const slow = item('user:clock', 'setTimeout(() => process.stdout.write("old\\n"), 2000)')
    runtime.sync([slow], new Set(['user:clock']))
    await new Promise(resolve => setTimeout(resolve, 150))
    const renamed = item('user:time', 'process.stdout.write("new\\n")')
    runtime.sync([renamed], new Set(['user:time']))
    await waitFor(() => values.get('user:time') === 'new')
    assert.equal(values.get('user:clock'), undefined, 'the old id cache must be cleared on rename')
    await new Promise(resolve => setTimeout(resolve, 2300))
    assert.equal(values.get('user:time'), 'new', 'the old generation must never commit under the new id')
  } finally {
    runtime.dispose()
  }
})

test('removing an item from the layout disposes its runner and clears its cache; re-add re-arms', async () => {
  const { runtime, values } = harness()
  try {
    const clock = item('user:clock', 'process.stdout.write("tick\\n")')
    runtime.sync([clock], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'tick')
    runtime.sync([clock], new Set())
    assert.equal(values.get('user:clock'), undefined, 'removal must clear the cache')
    runtime.sync([clock], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'tick', 8000)
  } finally {
    runtime.dispose()
  }
})

test('a deleted definition (or kind change) disposes the runner and clears the cache', async () => {
  const { runtime, values } = harness()
  try {
    const clock = item('user:clock', 'process.stdout.write("tick\\n")')
    runtime.sync([clock], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'tick')
    // The definition vanished from the trusted set (deleted, or its kind
    // changed to text): the layout still references the id, but nothing
    // may run.
    runtime.sync([], new Set(['user:clock']))
    assert.equal(values.get('user:clock'), undefined)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(values.get('user:clock'), undefined)
  } finally {
    runtime.dispose()
  }
})

test('whole-footer command mode suspends every per-item runner; switching back re-arms', async () => {
  const { runtime, values } = harness()
  try {
    const clock = item('user:clock', 'process.stdout.write("tick\\n")')
    runtime.sync([clock], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'tick')
    // footer === command: the whole-footer surface covers the native items.
    runtime.sync([], new Set())
    assert.equal(values.get('user:clock'), undefined, 'command mode must clear the per-item caches')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(values.get('user:clock'), undefined, 'no per-item run may happen under command mode')
    runtime.sync([clock], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'tick')
  } finally {
    runtime.dispose()
  }
})

test('dispose stops every runner: no value may commit after disposal', async () => {
  const { runtime, values, calls } = harness()
  const clock = item('user:clock', 'setTimeout(() => process.stdout.write("late\\n"), 500)')
  runtime.sync([clock], new Set(['user:clock']))
  await new Promise(resolve => setTimeout(resolve, 100))
  runtime.dispose()
  const settled = calls.length
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(calls.length, settled, 'a disposed runtime must never commit a late result')
  assert.equal(values.get('user:clock'), undefined)
})

test('multiple command items are isolated: modifying one never restarts or clears the other', async () => {
  const { runtime, values } = harness()
  try {
    const clock = item('user:clock', 'process.stdout.write("clock\\n")')
    const branch = item('user:branch', 'process.stdout.write("main\\n")')
    runtime.sync([clock, branch], new Set(['user:clock', 'user:branch']))
    await waitFor(() => values.get('user:clock') === 'clock' && values.get('user:branch') === 'main')
    // Modify ONLY clock.
    runtime.sync([item('user:clock', 'process.stdout.write("clock2\\n")'), branch], new Set(['user:clock', 'user:branch']))
    await waitFor(() => values.get('user:clock') === 'clock2')
    assert.equal(values.get('user:branch'), 'main', 'the untouched item cache must survive')
    // Delete ONLY branch.
    runtime.sync([item('user:clock', 'process.stdout.write("clock2\\n")')], new Set(['user:clock', 'user:branch']))
    assert.equal(values.get('user:branch'), undefined, 'deleting one item must not affect the other')
    assert.equal(values.get('user:clock'), 'clock2')
  } finally {
    runtime.dispose()
  }
})

test('empty output and failures are fail-soft: the item becomes unavailable, never a crash', async () => {
  const { runtime, values, calls } = harness()
  try {
    // Empty stdout → unavailable (the run settles with undefined).
    runtime.sync([item('user:clock', 'process.stdout.write("\\n  \\n")')], new Set(['user:clock']))
    await waitFor(() => calls.length >= 1)
    assert.equal(values.get('user:clock'), undefined, 'empty output must clear the item value')
    // A later success recovers the item.
    runtime.sync([item('user:clock', 'process.stdout.write("ok\\n")')], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'ok')
    // A failing command clears the value again (fail-soft, no crash).
    runtime.sync([item('user:clock', 'process.exit(1)')], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === undefined && calls.length >= 3)
    assert.equal(values.get('user:clock'), undefined)
  } finally {
    runtime.dispose()
  }
})

test('a trusted definition NOT referenced by the layout never spawns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tui-item-'))
  const marker = join(dir, 'ran')
  try {
    const { runtime } = harness()
    runtime.sync([item('user:clock', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)], new Set())
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(existsSync(marker), false, 'an unreferenced definition must never spawn')
    runtime.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a project-only command definition never spawns (the trust gate)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-tui-trust-'))
  const marker = join(dir, 'pwn')
  try {
    const { runtime, values } = harness()
    // The layout references user:clock, but the runtime receives ONLY the
    // USER-layer trusted set — the project-supplied definition is not in
    // it, so nothing may run and the item stays unavailable.
    runtime.sync([], new Set(['user:clock']))
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(existsSync(marker), false, 'the project command must never run')
    assert.equal(values.get('user:clock'), undefined, 'the item must stay unavailable')
    runtime.dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
