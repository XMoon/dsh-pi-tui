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
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { FooterDynamicItemRuntime, activeFooterItemIds, executableCommandItemIds } from '../src/footer/dynamic-item-runtime.ts'
import { customCommandConfigOf, DEFAULT_CUSTOM_COMMAND_REFRESH_MS, effectiveCustomCommandRefreshMs, effectiveCustomCommandTimeoutMs, type FooterCustomCommandItemSettings } from '../src/footer/custom-items.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import type { FooterLayoutV1 } from '../src/footer/types.ts'
import { emptyStatusSnapshot } from '../src/status/types.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

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

/** Bounded wall-clock spin (setImmediate turns, never a fixed setTimeout):
 * used to wait PAST a child's deadline or a settle window before an
 * assertion that must hold AFTER it. */
async function spin(ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
}

test('activeFooterItemIds collects every referenced id (left and right zones)', () => {
  const layout: FooterLayoutV1 = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'a' }, { id: 'b' }], right: [{ id: 'a' }] }],
  }
  assert.deepEqual([...activeFooterItemIds(layout)].sort(), ['a', 'b'])
})

test('an ABSENT refreshIntervalMs runs at the custom 5s default (same cadence as an explicit 5s)', () => {
  const absent = customCommandConfigOf({ schemaVersion: 1, id: 'user:clock', kind: 'command', command: 'date' })
  const explicit = customCommandConfigOf({ schemaVersion: 1, id: 'user:clock', kind: 'command', command: 'date', refreshIntervalMs: 5000 })
  assert.equal(absent?.refreshIntervalMs, DEFAULT_CUSTOM_COMMAND_REFRESH_MS)
  assert.equal(explicit?.refreshIntervalMs, DEFAULT_CUSTOM_COMMAND_REFRESH_MS)
  // The timeout default stays the whole-footer 300ms.
  assert.equal(absent?.timeoutMs, 300)
  assert.equal(absent?.maxRows, 1)
})

test('the EFFECTIVE helpers report the SAME normalized values the runner executes (no UI/runtime drift)', () => {
  // A hand-edited out-of-range raw value is preserved in storage, but the
  // effective value (UI display + dirty comparator) must equal the
  // runner's clamped config — the UI never lies about the real cadence.
  const clamped = { schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date', refreshIntervalMs: 100, timeoutMs: 5000 }
  assert.equal(effectiveCustomCommandRefreshMs(clamped), 1000, 'refresh < 1s clamps to 1s')
  assert.equal(effectiveCustomCommandTimeoutMs(clamped), 1000, 'timeout > 1s clamps to 1s')
  assert.equal(customCommandConfigOf(clamped)?.refreshIntervalMs, 1000)
  assert.equal(customCommandConfigOf(clamped)?.timeoutMs, 1000)
  const lowTimeout = { schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date', timeoutMs: 0 }
  assert.equal(effectiveCustomCommandTimeoutMs(lowTimeout), 1, 'timeout < 1ms clamps to 1ms')
  // In-range values pass through unchanged.
  const inRange = { schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date', refreshIntervalMs: 10000, timeoutMs: 500 }
  assert.equal(effectiveCustomCommandRefreshMs(inRange), 10000)
  assert.equal(effectiveCustomCommandTimeoutMs(inRange), 500)
})

test('a config change re-arms IMMEDIATELY even with a long refresh cadence (no 60s wait)', async () => {
  const { runtime, values } = harness()
  try {
    const old = item('user:clock', 'process.stdout.write("old\\n")', { refreshIntervalMs: 60000 })
    runtime.sync([old], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'old')
    // Change the command: the new value must arrive PROMPTLY — the 60s
    // cadence of the old config must not delay the first run of the new
    // command (the item would otherwise be unavailable for ~a minute).
    runtime.sync([item('user:clock', 'process.stdout.write("new\\n")', { refreshIntervalMs: 60000 })], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'new', 5000)
  } finally {
    runtime.dispose()
  }
})

test('duplicate trusted definitions are FIRST-wins (the catalog projection wins)', async () => {
  const { runtime, values } = harness()
  try {
    const first = item('user:clock', 'process.stdout.write("first\\n")')
    const second = item('user:clock', 'process.stdout.write("second\\n")')
    runtime.sync([first, second], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'first')
    assert.equal(values.get('user:clock'), 'first', 'the first definition must win, never the last')
  } finally {
    runtime.dispose()
  }
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
    await spin(150)
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
    await spin(150)
    const fast = item('user:clock', 'process.stdout.write("new\\n")')
    runtime.sync([fast], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'new')
    // The stale generation must never commit, even after the old child's
    // deadline passes.
    await spin(2300)
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
    await spin(150)
    const renamed = item('user:time', 'process.stdout.write("new\\n")')
    runtime.sync([renamed], new Set(['user:time']))
    await waitFor(() => values.get('user:time') === 'new')
    assert.equal(values.get('user:clock'), undefined, 'the old id cache must be cleared on rename')
    await spin(2300)
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
    await spin(200)
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
    await spin(200)
    assert.equal(values.get('user:clock'), undefined, 'no per-item run may happen under command mode')
    runtime.sync([clock], new Set(['user:clock']))
    await waitFor(() => values.get('user:clock') === 'tick')
  } finally {
    runtime.dispose()
  }
})

test('dispose stops every runner and clears the cached values', async () => {
  const { runtime, values, calls } = harness()
  const clock = item('user:clock', 'setTimeout(() => process.stdout.write("late\\n"), 500)')
  runtime.sync([clock], new Set(['user:clock']))
  await spin(100)
  runtime.dispose()
  assert.equal(values.get('user:clock'), undefined, 'dispose must clear the cached value (the onValue sink)')
  const settled = calls.length
  await spin(800)
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

test('a trusted definition NOT referenced by the layout never spawns', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-item-')
  const marker = join(dir, 'ran')
  const { runtime } = harness()
  life.defer(() => runtime.dispose())
  runtime.sync([item('user:clock', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)], new Set())
  await spin(300)
  assert.equal(existsSync(marker), false, 'an unreferenced definition must never spawn')
})

test('a project-only command definition never spawns (the trust gate, plan §11.2 attack shape)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-trust-')
  const marker = join(dir, 'pwn')
  // The ATTACK SHAPE: the USER layer has no user:clock command; the
  // PROJECT layer supplies one; the merged layout references user:clock.
  const projectCommand = item('user:clock', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  const port = new DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footerCustomItems: [projectCommand] },
      user: { footerCustomItems: [] },
    }] }),
  } as never, undefined, () => undefined)
  // The runtime receives ONLY the USER-layer trusted projection — the
  // project command can never reach a spawn, and the item stays
  // unavailable even though the layout references the id.
  const trusted = port.footerCustomItems.get().items
  assert.equal(trusted.length, 0, 'the USER-layer projection must exclude the project command')
  const { runtime, values } = harness()
  life.defer(() => runtime.dispose())
  runtime.sync(trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'), new Set(['user:clock']))
  await spin(300)
  assert.equal(existsSync(marker), false, 'the project command must never run')
  assert.equal(values.get('user:clock'), undefined, 'the item must stay unavailable')
})

test('P1 regression: a PROJECT merged layout can never activate a dormant USER command', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-activation-')
  const marker = join(dir, 'pwn')
  // The ATTACK SHAPE: the USER layer defines user:deploy (a real,
  // trusted command) but its own layout does NOT reference it — the
  // command is DORMANT. The PROJECT layer supplies footer: custom +
  // a merged layout that references user:deploy.
  const userCommand = item('user:deploy', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  const projectLayout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'user:deploy' }], right: [] }] }
  const port = new DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footer: 'custom', footerLayout: projectLayout, footerCustomItems: [userCommand] },
      user: { footer: 'default', footerCustomItems: [userCommand] },
    }] }),
  } as never, undefined, () => undefined)
  const trusted = port.footerCustomItems.get().items
  assert.equal(trusted.length, 1, 'the USER command definition itself is trusted')
  // The USER layer declares footer: default → the mode-gated
  // authorization is EMPTY — the PROJECT merged layout's user:deploy
  // ref can never arm the dormant command.
  const authorized = port.footerCommandTrust.userCommandItemActivationIds
  assert.equal(authorized.size, 0, 'footer: default authorizes no command items')
  const { runtime, values } = harness()
  life.defer(() => runtime.dispose())
  const executable = executableCommandItemIds(
    trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'),
    authorized,
    projectLayout,
  )
  runtime.sync(trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'), executable)
  await spin(300)
  assert.equal(existsSync(marker), false, 'a PROJECT layout must never activate a dormant USER command')
  assert.equal(values.get('user:deploy'), undefined, 'the runner must not arm')
})

test('P1 regression: a STALE USER layout under footer: default authorizes nothing (mode gate)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-stale-')
  const marker = join(dir, 'pwn')
  // The REALISTIC attack shape: the USER previously used a custom
  // layout referencing user:deploy, then switched to footer: default —
  // the /settings switch deliberately KEEPS the old footerLayout. The
  // stale layout remains in the USER layer. The PROJECT layer flips
  // the MERGED mode to custom with a layout referencing user:deploy.
  const userCommand = item('user:deploy', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  const staleLayout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'user:deploy' }], right: [] }] }
  const port = new DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footer: 'custom', footerLayout: staleLayout, footerCustomItems: [userCommand] },
      user: { footer: 'default', footerLayout: staleLayout, footerCustomItems: [userCommand] },
    }] }),
  } as never, undefined, () => undefined)
  const trusted = port.footerCustomItems.get().items
  assert.equal(trusted.length, 1, 'the USER command definition itself is trusted')
  // The USER layer declares footer: default — the stale leftover layout
  // must NOT authorize anything, even though it is present and valid.
  const authorized = port.footerCommandTrust.userCommandItemActivationIds
  assert.equal(authorized.size, 0, 'a stale layout under footer: default must authorize nothing')
  const { runtime, values } = harness()
  life.defer(() => runtime.dispose())
  const executable = executableCommandItemIds(
    trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'),
    authorized,
    staleLayout,
  )
  runtime.sync(trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'), executable)
  await spin(300)
  assert.equal(existsSync(marker), false, 'a stale USER layout must never resurrect a dormant command')
  assert.equal(values.get('user:deploy'), undefined, 'the runner must not arm')
})

test('P1 regression: a command hidden by the rendered layout does not keep running in the background', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-hidden-')
  const marker = join(dir, 'pwn')
  // The USER authorizes user:deploy (footer: custom + its layout), but
  // the PROJECT merged layout HIDES it (does not reference it). The
  // rendered intersection must stop the command: executable = trusted ∩
  // authorized ∩ rendered = ∅.
  const userCommand = item('user:deploy', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  const userLayout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'user:deploy' }], right: [] }] }
  const hidingLayout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'model' }], right: [] }] }
  const port = new DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footer: 'custom', footerLayout: hidingLayout, footerCustomItems: [userCommand] },
      user: { footer: 'custom', footerLayout: userLayout, footerCustomItems: [userCommand] },
    }] }),
  } as never, undefined, () => undefined)
  const trusted = port.footerCustomItems.get().items
  const authorized = port.footerCommandTrust.userCommandItemActivationIds
  assert.ok(authorized.has('user:deploy'), 'the USER authorizes user:deploy')
  const executable = executableCommandItemIds(
    trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'),
    authorized,
    hidingLayout,
  )
  assert.equal(executable.has('user:deploy'), false, 'a hidden command must not be executable')
  const { runtime, values } = harness()
  life.defer(() => runtime.dispose())
  runtime.sync(trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'), executable)
  await spin(300)
  assert.equal(existsSync(marker), false, 'a command hidden by the rendered layout must not run in the background')
  assert.equal(values.get('user:deploy'), undefined)
})

test('P1 positive: a USER-declared custom layout DOES activate its command items', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-activation-ok-')
  const marker = join(dir, 'pwn')
  const userCommand = item('user:deploy', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  const userLayout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'user:deploy' }], right: [] }] }
  const port = new DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footer: 'custom', footerLayout: userLayout, footerCustomItems: [userCommand] },
      user: { footer: 'custom', footerLayout: userLayout, footerCustomItems: [userCommand] },
    }] }),
  } as never, undefined, () => undefined)
  const trusted = port.footerCustomItems.get().items
  const authorized = port.footerCommandTrust.userCommandItemActivationIds
  assert.ok(authorized.has('user:deploy'), 'the USER layer authorizes user:deploy')
  const { runtime } = harness()
  life.defer(() => runtime.dispose())
  const executable = executableCommandItemIds(
    trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'),
    authorized,
    userLayout,
  )
  runtime.sync(trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'), executable)
  const deadline = Date.now() + 8000
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.equal(existsSync(marker), true, 'a USER-declared layout must activate its command items')
})

test('P1 regression: a PROJECT-forced command mode cannot turn stale fallback metadata into execution authorization', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-fallback-')
  const marker = join(dir, 'pwn')
  // The ATTACK SHAPE: the USER never opted into command mode
  // (footer: default) but a STALE footerFallbackMode: custom and a
  // stale custom layout referencing user:deploy remain in the USER
  // layer. The PROJECT forces the merged footer: command with a custom
  // fallback referencing user:deploy.
  const userCommand = item('user:deploy', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  const staleLayout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'user:deploy' }], right: [] }] }
  const port = new DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footer: 'command', footerFallbackMode: 'custom', footerLayout: staleLayout, footerCustomItems: [userCommand] },
      user: { footer: 'default', footerFallbackMode: 'custom', footerLayout: staleLayout, footerCustomItems: [userCommand] },
    }] }),
  } as never, undefined, () => undefined)
  const trusted = port.footerCustomItems.get().items
  assert.equal(trusted.length, 1, 'the USER command definition itself is trusted')
  // The untrusted whole-footer branch selects the authorization by the
  // USER's CURRENT mode: footer: default → the current-mode set
  // (empty), NEVER the fallback set — stale fallback metadata must not
  // become execution authorization.
  const userMode = port.footerCommandTrust.userFooterMode
  const authorized = userMode === 'command'
    ? port.footerCommandTrust.userCommandItemFallbackActivationIds
    : port.footerCommandTrust.userCommandItemActivationIds
  assert.equal(userMode, 'default')
  assert.equal(authorized.size, 0, 'a default-mode USER must not authorize via stale fallback metadata')
  const { runtime, values } = harness()
  life.defer(() => runtime.dispose())
  const executable = executableCommandItemIds(
    trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'),
    authorized,
    staleLayout, // the rendered fallback layout
  )
  runtime.sync(trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'), executable)
  await spin(300)
  assert.equal(existsSync(marker), false, 'a PROJECT-forced command mode must never execute a default-mode USER command')
  assert.equal(values.get('user:deploy'), undefined, 'the runner must not arm')
})

test('P1 positive: a command-mode USER with a custom fallback DOES run its fallback per-item commands', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pi-tui-fallback-ok-')
  const marker = join(dir, 'pwn')
  // The USER opted into command mode (footer: command) with a custom
  // fallback; the whole-footer command itself is untrusted (no USER
  // footerCommand), so the native fallback applies — the USER's own
  // fallback declaration authorizes the per-item command.
  const userCommand = item('user:deploy', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  const fallbackLayout: FooterLayoutV1 = { schemaVersion: 1, rows: [{ left: [{ id: 'user:deploy' }], right: [] }] }
  const port = new DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footer: 'command', footerFallbackMode: 'custom', footerLayout: fallbackLayout, footerCustomItems: [userCommand] },
      user: { footer: 'command', footerFallbackMode: 'custom', footerLayout: fallbackLayout, footerCustomItems: [userCommand] },
    }] }),
  } as never, undefined, () => undefined)
  const trusted = port.footerCustomItems.get().items
  const userMode = port.footerCommandTrust.userFooterMode
  const authorized = userMode === 'command'
    ? port.footerCommandTrust.userCommandItemFallbackActivationIds
    : port.footerCommandTrust.userCommandItemActivationIds
  assert.equal(userMode, 'command')
  assert.ok(authorized.has('user:deploy'), 'a command-mode USER with a custom fallback authorizes its fallback layout')
  const { runtime } = harness()
  life.defer(() => runtime.dispose())
  const executable = executableCommandItemIds(
    trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'),
    authorized,
    fallbackLayout,
  )
  runtime.sync(trusted.filter((entry): entry is FooterCustomCommandItemSettings => entry.kind === 'command'), executable)
  const deadline = Date.now() + 8000
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  assert.equal(existsSync(marker), true, 'the fallback per-item command must run for a command-mode USER')
})
