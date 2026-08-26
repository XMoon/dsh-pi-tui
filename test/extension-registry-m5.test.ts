/**
 * M5 registry tests (plan §10 + M5 gates): CommandBridge, ThemeRegistry,
 * SettingsRegistry, AutocompleteRegistry, KeybindingRegistry — ordering,
 * conflicts, owner unload, and the specific M5 gates:
 * - skill rawInput args regression (the bridge never rewrites rawInput);
 * - local command busy-enter regression (dynamic local commands never
 *   steer while registered);
 * - dynamic command unload;
 * - selected theme unload → built-in fallback;
 * - async autocomplete cancellation/latest-only commit.
 * @module @xmoon76/dsh-pi-tui/extension-registry-m5.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandBridge } from '../src/command-bridge.ts'
import { ThemeRegistry } from '../src/theme-registry.ts'
import { SettingsRegistry } from '../src/settings-registry.ts'
import { AutocompleteRegistry } from '../src/autocomplete-registry.ts'
import { KeybindingRegistry } from '../src/keybinding-registry.ts'
import { HOST_COMMAND_CATALOG, LOCAL_COMMANDS, SESSIONLESS_COMMANDS, shouldSteerOnEnter } from '../src/index.ts'

/** A minimal valid structural autocomplete provider for tests. */
function provider(getSuggestions: () => Promise<import('../src/extension/public-types.ts').TuiAutocompleteSuggestions | null>): import('../src/extension/public-types.ts').TuiAutocompleteProvider {
  return { getSuggestions }
}

// ── CommandBridge ──────────────────────────────────────────────────────────

test('CommandBridge: dynamic local commands join the effective-local set', () => {
  const bridge = new CommandBridge()
  const outcome = bridge.register({
    id: 'plugin-cmd',
    name: 'mycommand',
    description: 'a plugin command',
    execution: 'local',
  }, 'owner-a')
  assert.equal(outcome.kind, 'registered')
  assert.equal(bridge.isLocal('mycommand', LOCAL_COMMANDS), true)
  assert.equal(bridge.isLocal('status', LOCAL_COMMANDS), true, 'static core stays')
  assert.equal(bridge.isLocal('grilling', LOCAL_COMMANDS), false, 'unregistered is not local')
})

test('CommandBridge: a plugin command can NEVER shadow a host-owned command (P1-04)', () => {
  // The authoritative host catalog (TUI commands + ownership sets).
  const catalog = new Set(['status', 'sessions', 'help', 'exit', 'kill', 'settings'])
  const bridge = new CommandBridge(() => {}, catalog)
  // EXACT collision with a TUI-registered command: rejected loudly.
  const status = bridge.register({ id: 's1', name: 'status', description: '', execution: 'local' }, 'plugin')
  assert.equal(status.kind, 'conflict')
  assert.equal(status.existingOwner, 'host', 'the conflict is owned by the HOST, not another plugin')
  // EXACT collision with a core command the TUI dispatches locally (/kill).
  const kill = bridge.register({ id: 's2', name: 'kill', description: '', execution: 'local' }, 'plugin')
  assert.equal(kill.kind, 'conflict')
  assert.equal(kill.existingOwner, 'host')
  // NEAR-SYNONYM of a host command (/session vs /sessions): rejected too.
  const near = bridge.register({ id: 's3', name: 'session', description: '', execution: 'local' }, 'plugin')
  assert.equal(near.kind, 'conflict')
  assert.equal(near.existingOwner, 'host')
  assert.ok(near.nearSynonym !== undefined, 'the near-synonym pair is reported')
  // A genuinely NEW name still registers (the catalog never blocks growth).
  const fresh = bridge.register({ id: 's4', name: 'vimish', description: '', execution: 'local' }, 'plugin')
  assert.equal(fresh.kind, 'registered')
  assert.equal(bridge.snapshot().entries.length, 1)
  // The built-in is still local and still routes to the HOST handler.
  assert.equal(bridge.handlerFor('status'), undefined, 'no plugin handler can claim the built-in')
  assert.equal(bridge.isLocal('status', new Set(['status'])), true, 'the host ownership is untouched')

  assert.equal(HOST_COMMAND_CATALOG.has('plan'), true, 'special-cased /plan is host-owned')
  const plan = new CommandBridge(() => {}, HOST_COMMAND_CATALOG)
  assert.equal(plan.register({ id: 'plan-plugin', name: 'plan', description: '', execution: 'local' }, 'plugin').kind, 'conflict')
})

test('CommandBridge: a name conflict is reported, never silently overridden', () => {
  const bridge = new CommandBridge()
  bridge.register({ id: 'a', name: 'dup', description: '', execution: 'local' }, 'owner-a')
  const outcome = bridge.register({ id: 'b', name: 'dup', description: '', execution: 'local' }, 'owner-b')
  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.existingOwner, 'owner-a')
  assert.equal(bridge.snapshot().entries.length, 1, 'the second registration is not stored')
})

test('CommandBridge: near-synonym names are reported (AGENTS hard rule)', () => {
  const bridge = new CommandBridge()
  bridge.register({ id: 'a', name: 'session', description: '', execution: 'local' }, 'owner-a')
  // Exact prefix of an existing name: a confusion risk, rejected.
  const outcome = bridge.register({ id: 'b', name: 'sessions', description: '', execution: 'local' }, 'owner-b')
  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.nearSynonym, 'session ↔ sessions')
  // The bridge stores only the first.
  assert.equal(bridge.snapshot().entries.length, 1)
  // Unrelated names are fine.
  const ok = bridge.register({ id: 'c', name: 'grilling', description: '', execution: 'submission' }, 'owner-c')
  assert.equal(ok.kind, 'registered')
})

test('CommandBridge: a duplicate id is an error', () => {
  const bridge = new CommandBridge()
  bridge.register({ id: 'x', name: 'a', description: '', execution: 'local' }, 'o1')
  assert.throws(() => bridge.register({ id: 'x', name: 'b', description: '', execution: 'local' }, 'o2'), /duplicate/)
})

test('CommandBridge: owner unload removes exactly the owner contributions', () => {
  const bridge = new CommandBridge()
  bridge.register({ id: 'p1', name: 'one', description: '', execution: 'local' }, 'owner-a')
  bridge.register({ id: 'p2', name: 'two', description: '', execution: 'submission' }, 'owner-b')
  bridge.disposeOwner('owner-a')
  assert.equal(bridge.isLocal('one', LOCAL_COMMANDS), false)
  assert.equal(bridge.find('two')?.execution, 'submission')
  assert.equal(bridge.snapshot().entries.length, 1)
})

test('CommandBridge: dynamic unload makes the command submission again (busy-enter regression)', () => {
  const bridge = new CommandBridge()
  const handle = bridge.register({
    id: 'dyn', name: 'dyncmd', description: '', execution: 'local',
  }, 'owner-a')
  assert.equal(handle.kind, 'registered')
  // While registered: never steers.
  assert.equal(
    shouldSteerOnEnter({ name: 'dyncmd' }, true, 'steer', false, name => bridge.isLocal(name, LOCAL_COMMANDS)),
    false,
  )
  // After unload: submission policy applies.
  if (handle.kind === 'registered') handle.handle.dispose()
  assert.equal(
    shouldSteerOnEnter({ name: 'dyncmd' }, true, 'steer', false, name => bridge.isLocal(name, LOCAL_COMMANDS)),
    true,
  )
})

test('CommandBridge: rawInput is preserved verbatim (skill rawInput regression)', () => {
  const bridge = new CommandBridge()
  let received = ''
  bridge.register({
    id: 'arg-cmd',
    name: 'argcmd',
    description: '',
    execution: 'local',
    handler: (invocation) => {
      received = invocation.rawInput
      return { kind: 'success' as const }
    },
  }, 'owner-a')
  const raw = 'argcmd --flag "quoted arg" with   spaces'
  const handler = bridge.handlerFor('argcmd')
  assert.ok(handler !== undefined)
  void handler({ commandId: 'cmd-1', rawInput: raw, signal: new AbortController().signal })
  assert.equal(received, raw, 'the bridge must never re-parse or rewrite rawInput')
})

test('CommandBridge: sessionless contributions join the sessionless set', () => {
  const bridge = new CommandBridge()
  bridge.register({ id: 's', name: 'nosession', description: '', execution: 'local', sessionless: true }, 'o')
  assert.equal(bridge.isSessionless('nosession', SESSIONLESS_COMMANDS), true)
  assert.equal(bridge.isSessionless('exit', SESSIONLESS_COMMANDS), true, 'static core stays')
  assert.equal(bridge.isSessionless('nosession2', SESSIONLESS_COMMANDS), false)
})

// ── ThemeRegistry ──────────────────────────────────────────────────────────

test('ThemeRegistry: selectable names are deterministic and collisions error', () => {
  const registry = new ThemeRegistry()
  const handle = registry.register({
    id: 't1',
    name: 'My Theme',
    palette: { text: '#fff' } as never,
  }, 'owner-a')
  assert.deepEqual(registry.names(), ['My Theme'])
  assert.throws(() => registry.register({
    id: 't2',
    name: 'My Theme',
    palette: { text: '#000' } as never,
  }, 'owner-b'), /duplicate theme name/)
  assert.deepEqual(registry.names(), ['My Theme'])
  assert.ok(registry.paletteFor('My Theme') !== undefined, 'the registered palette resolves')
  handle.dispose()
  assert.deepEqual(registry.names(), [], 'dispose removes the theme')
})

test('ThemeRegistry: owner unload removes the theme (selected-theme fallback gate)', () => {
  const registry = new ThemeRegistry()
  registry.register({ id: 'gone', name: 'Gone', palette: { text: '#fff' } as never }, 'owner-a')
  registry.register({ id: 'stay', name: 'Stay', palette: { text: '#000' } as never }, 'owner-b')
  registry.disposeOwner('owner-a')
  assert.deepEqual(registry.names(), ['Stay'])
  // The host's fallback: a selection whose palette is gone resolves
  // undefined → the runner applies the built-in dark palette.
  assert.equal(registry.paletteFor('Gone'), undefined)
})

// ── SettingsRegistry ───────────────────────────────────────────────────────

test('SettingsRegistry: rows order deterministically (order ASC, id ASC)', () => {
  const registry = new SettingsRegistry()
  registry.register({ id: 'z', label: 'Z', currentValue: 'z', order: 2 }, 'a')
  registry.register({ id: 'a', label: 'A', currentValue: 'a', order: 2 }, 'b')
  registry.register({ id: 'm', label: 'M', currentValue: 'm', order: 1 }, 'c')
  const rows = registry.rows()
  assert.deepEqual(rows.map(row => row.id), ['m', 'a', 'z'])
})

test('SettingsRegistry: onChange rejection keeps the old value', async () => {
  const registry = new SettingsRegistry()
  registry.register({
    id: 's1', label: 'S', currentValue: 'old',
    onChange: (value) => value === 'allowed',
  }, 'o')
  assert.equal(await registry.apply('s1', 'allowed'), true)
  assert.equal(registry.rows()[0]?.currentValue, 'allowed')
  assert.equal(await registry.apply('s1', 'denied'), false)
  assert.equal(registry.rows()[0]?.currentValue, 'allowed', 'rejected change keeps the old value')
})

test('SettingsRegistry: a slow EARLIER apply never overwrites a newer completed one (P2-01)', async () => {
  const registry = new SettingsRegistry()
  let release1!: (accepted: boolean) => void
  const gate1 = new Promise<boolean>(resolve => { release1 = resolve })
  let release2!: (accepted: boolean) => void
  const gate2 = new Promise<boolean>(resolve => { release2 = resolve })
  registry.register({
    id: 'race', label: 'R', currentValue: '0',
    onChange: (value) => value === '1' ? gate1 : value === '2' ? gate2 : true,
  }, 'o')
  // apply('1') STARTS first but settles LAST; apply('2') starts second and
  // settles FIRST. The review repro ended with currentValue '1' (the slow
  // first change overwrote the newer second) — the epoch commit must end
  // with '2'.
  const p1 = registry.apply('race', '1')
  const p2 = registry.apply('race', '2')
  release2(true) // the NEWER change completes first
  assert.equal(await p2, true)
  assert.equal(registry.rows()[0]?.currentValue, '2', 'the newer change wins')
  release1(true) // the OLDER change completes LATE
  assert.equal(await p1, false, 'a stale apply reports not-committed')
  assert.equal(registry.rows()[0]?.currentValue, '2', 'the stale change must NOT overwrite the newer one')
})

test('SettingsRegistry: in-flight apply after disposal does not commit (P2-R3)', async () => {
  const invalidations: number[] = []
  const registry = new SettingsRegistry(() => { invalidations.push(1) })
  let release!: (accepted: boolean) => void
  const gate = new Promise<boolean>(resolve => { release = resolve })
  const handle = registry.register({
    id: 'dispose-race', label: 'R', currentValue: 'old', onChange: () => gate,
  }, 'owner')
  const before = registry.snapshot().revision
  const pending = registry.apply('dispose-race', 'new')
  handle.dispose()
  release(true)
  assert.equal(await pending, false)
  assert.equal(registry.snapshot().revision, before + 1, 'only disposal changes the revision')
  assert.equal(invalidations.length, 2, 'register and dispose only; apply does not invalidate')
})

test('SettingsRegistry: owner unload removes rows; setValue is idempotent', () => {
  const registry = new SettingsRegistry()
  const handle = registry.register({ id: 's', label: 'S', currentValue: 'v' }, 'o')
  handle.setValue('v2')
  assert.equal(registry.rows()[0]?.currentValue, 'v2')
  registry.disposeOwner('o')
  assert.equal(registry.rows().length, 0)
  handle.setValue('v3') // inert after dispose
  assert.equal(registry.rows().length, 0)
})

// ── AutocompleteRegistry ───────────────────────────────────────────────────

test('AutocompleteRegistry: provider recovery callback follows successful results', async () => {
  const registry = new AutocompleteRegistry()
  const events: string[] = []
  registry.register({ id: 'ok', provider: provider(async () => ({ items: [], prefix: '' })) }, 'owner')
  await registry.suggest({ lines: [''], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal }, undefined, id => events.push(id))
  assert.deepEqual(events, ['ok'])
})

test('AutocompleteRegistry: null is a successful provider result for recovery', async () => {
  const registry = new AutocompleteRegistry()
  const events: string[] = []
  registry.register({ id: 'abdicate', provider: provider(async () => null) }, 'owner')
  const result = await registry.suggest({ lines: [''], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal }, undefined, id => events.push(id))
  assert.equal(result, null)
  assert.deepEqual(events, ['abdicate'])
})

test('AutocompleteRegistry: first non-null provider wins, in registration order', async () => {
  const registry = new AutocompleteRegistry()
  registry.register({
    id: 'first',
    provider: provider(async () => ({ items: [{ value: 'first', label: 'first' }], prefix: 'x' })),
  }, 'a')
  registry.register({
    id: 'second',
    provider: provider(async () => ({ items: [{ value: 'second', label: 'second' }], prefix: 'y' })),
  }, 'b')
  const result = await registry.suggest({ lines: [], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal })
  assert.equal(result?.items[0]?.value, 'first')
})

test('AutocompleteRegistry: null providers fall through; a throwing provider is isolated', async () => {
  const registry = new AutocompleteRegistry()
  const errors: string[] = []
  registry.register({
    id: 'nuller',
    provider: provider(async () => null),
  }, 'a')
  registry.register({
    id: 'thrower',
    provider: provider(async () => { throw new Error('provider boom') }),
  }, 'b')
  registry.register({
    id: 'worker',
    provider: provider(async () => ({ items: [{ value: 'work', label: 'work' }], prefix: 'w' })),
  }, 'c')
  const result = await registry.suggest({ lines: [], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal }, (id, error) => {
    errors.push(`${id}:${error instanceof Error ? error.message : String(error)}`)
  })
  assert.equal(result?.items[0]?.value, 'work', 'the chain continues past null + throw')
  assert.equal(errors.length, 1)
  assert.match(errors[0] ?? '', /thrower:provider boom/)
})

test('AutocompleteRegistry: latest-only commit drops stale results', async () => {
  const registry = new AutocompleteRegistry()
  // A provider whose getSuggestions resolve LATER (after a newer request
  // bumped the epoch) must not commit its result. Each request gets its
  // own pending promise; both resolve on demand.
  const resolvers: ((value: unknown) => void)[] = []
  registry.register({
    id: 'slow',
    provider: provider(() => new Promise(resolve => {
      resolvers.push(resolve as (value: unknown) => void)
    })),
  }, 'a')
  const first = registry.suggest({ lines: [], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal })
  // A newer request bumps the epoch before the first resolves.
  const second = registry.suggest({ lines: [], cursorLine: 0, cursorCol: 1, signal: new AbortController().signal })
  assert.equal(resolvers.length, 2, 'both requests reached the provider')
  // Resolve the FIRST request now (stale — its cursor is behind), then
  // the second (current) request with no suggestions.
  resolvers[0]?.({ items: [{ value: 'stale', label: 'stale' }], prefix: 's' })
  resolvers[1]?.(null)
  const [firstResult, secondResult] = await Promise.all([first, second])
  // The stale result is dropped (a newer epoch owns the cursor).
  assert.equal(firstResult, null)
  // The second (current) request's own result is returned.
  assert.equal(secondResult, null)
})

test('AutocompleteRegistry: a newer request aborts the superseded provider', async () => {
  const registry = new AutocompleteRegistry()
  const sawAbort: boolean[] = []
  registry.register({
    id: 'spy',
    provider: {
      getSuggestions(query) {
        return new Promise((resolve, reject) => {
          // The provider OBSERVES the signal: the registry must abort the
          // superseded request through its internal controller. A request
          // that is NOT superseded resolves with nothing (the chain then
          // returns null — the current request settles normally).
          if (query.signal.aborted) {
            sawAbort.push(true)
            reject(new DOMException('aborted', 'AbortError'))
            return
          }
          query.signal.addEventListener('abort', () => {
            sawAbort.push(true)
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
          // No suggestions: resolve null so the chain continues and the
          // current request settles.
          queueMicrotask(() => resolve(null))
        })
      },
    },
  }, 'a')
  const p1 = registry.suggest({ lines: [], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal })
  const p2 = registry.suggest({ lines: [], cursorLine: 0, cursorCol: 1, signal: new AbortController().signal })
  await Promise.allSettled([p1, p2])
  assert.ok(sawAbort.length >= 1, 'the superseded request must observe an abort')
})

test('AutocompleteRegistry: an already-aborted caller signal reaches providers (round-2 P1)', async () => {
  const registry = new AutocompleteRegistry()
  let observedAborted: boolean | undefined
  registry.register({
    id: 'observer',
    provider: {
      getSuggestions(query) {
        observedAborted = query.signal.aborted
        return Promise.resolve(null)
      },
    },
  }, 'a')
  // The caller's signal is ALREADY aborted before the request starts: the
  // combined signal must preserve that state (never a fresh live signal).
  const caller = new AbortController()
  caller.abort()
  const result = await registry.suggest({ lines: [], cursorLine: 0, cursorCol: 0, signal: caller.signal })
  assert.equal(result, null, 'the request settles normally')
  assert.equal(observedAborted, true, 'the provider must observe the aborted caller signal')
})

test('AutocompleteRegistry: the active controller is released after the request settles (round-2 P2)', async () => {
  const registry = new AutocompleteRegistry()
  // Capture the FIRST request's combined signal directly: after it settles,
  // a LATER request must not abort it (the controller was released).
  let firstSignal: AbortSignal | undefined
  registry.register({
    id: 'quick',
    provider: {
      getSuggestions(query) {
        firstSignal = query.signal
        return Promise.resolve(null)
      },
    },
  }, 'a')
  await registry.suggest({ lines: [], cursorLine: 0, cursorCol: 0, signal: new AbortController().signal })
  assert.ok(firstSignal !== undefined, 'the first request reached the provider')
  let firstWasAborted = false
  firstSignal.addEventListener('abort', () => { firstWasAborted = true }, { once: true })
  // A second request runs; the FIRST request's controller was released in
  // the first request's finally, so the second request's supersede-abort
  // has nothing to abort.
  await registry.suggest({ lines: [], cursorLine: 0, cursorCol: 1, signal: new AbortController().signal })
  assert.equal(firstWasAborted, false, 'a settled request must not be aborted by later requests')
})

test('AutocompleteRegistry: a provider that IGNORES the abort signal never commits stale results after the caller aborts (P1-03)', async () => {
  const registry = new AutocompleteRegistry()
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const errors: string[] = []
  registry.register({
    id: 'stubborn',
    provider: {
      // The provider NEVER observes the signal — it resolves from its own
      // timing, exactly the hostile/provider-bug shape P1-03 targets.
      getSuggestions() {
        return gate.then(() => ({ items: [{ value: 'stale', label: 'stale' }], prefix: '' }))
      },
    },
  }, 'a')
  const caller = new AbortController()
  const pending = registry.suggest(
    { lines: [], cursorLine: 0, cursorCol: 0, signal: caller.signal },
    (id, error) => errors.push(`${id}:${String(error)}`),
  )
  // The caller aborts BEFORE the provider resolves; the provider resolves
  // LATER anyway. The stale result must be dropped AND the abort must not
  // be reported as a provider failure.
  caller.abort()
  release!()
  const result = await pending
  assert.equal(result, null, 'a stale result after a caller abort must be dropped')
  assert.deepEqual(errors, [], 'an expected abort is cancellation, never a provider error')
})

test('AutocompleteRegistry: a provider THROWING after a caller abort also stops quietly (P1-03)', async () => {
  const registry = new AutocompleteRegistry()
  const errors: string[] = []
  registry.register({
    id: 'thrower',
    provider: {
      getSuggestions() {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('late boom')), 5)
        })
      },
    },
  }, 'a')
  const caller = new AbortController()
  const pending = registry.suggest(
    { lines: [], cursorLine: 0, cursorCol: 0, signal: caller.signal },
    (id, error) => errors.push(`${id}:${String(error)}`),
  )
  caller.abort()
  const result = await pending
  assert.equal(result, null)
  assert.deepEqual(errors, [], 'a post-abort rejection is cancellation, not a provider failure')
})

// ── KeybindingRegistry ─────────────────────────────────────────────────────

test('KeybindingRegistry: reserved host keys are rejected (full lifecycle inventory)', () => {
  const registry = new KeybindingRegistry()
  const reserved: { key: string; ctrl: boolean; shift: boolean }[] = [
    { key: 'c', ctrl: true, shift: false },
    { key: 'd', ctrl: true, shift: false },
    { key: 's', ctrl: true, shift: false },
    { key: 'f', ctrl: true, shift: false },
    { key: 'f', ctrl: true, shift: true },
    { key: 'o', ctrl: true, shift: false },
    { key: 't', ctrl: true, shift: false },
    { key: 'g', ctrl: true, shift: false },
    { key: 'r', ctrl: true, shift: false },   // Ctrl+R input-history search
    { key: 'v', ctrl: true, shift: false },   // Ctrl+V clipboard image intake
    // Ctrl+J is NOT in the reserved inventory (the host no longer binds
    // it — legacy LF ambiguity), but the SHARED legacy-collision policy
    // rejects a plugin registration on it anyway (round-13 finding): on a
    // legacy terminal the byte IS Enter, so the binding could never fire.
    { key: 'enter', ctrl: true, shift: false },
  ]
  for (let index = 0; index < reserved.length; index++) {
    const binding = reserved[index]!
    assert.throws(() => registry.register({
      id: `k${index}`,
      key: { key: binding.key, ctrl: binding.ctrl, alt: false, shift: binding.shift, super: false },
      action: 'submit-draft',
    }, 'o'), /reserved/, `${binding.ctrl ? 'Ctrl+' : ''}${binding.key} must be reserved`)
  }
  assert.throws(() => registry.register({
    id: 'k-enter',
    key: { key: 'enter', ctrl: false, alt: false, shift: false, super: false },
    action: 'submit-draft',
  }, 'o'), /reserved/, 'Enter must be reserved')
  assert.throws(() => registry.register({
    id: 'k-esc',
    key: { key: 'escape', ctrl: false, alt: false, shift: false, super: false },
    action: 'submit-draft',
  }, 'o'), /reserved/, 'Esc must be reserved')
  // P1-05: the host consumes Shift+Tab (permission cycle), Alt+Up
  // (dequeue) and Alt+T (thinking toggle) unconditionally in tui-app.ts —
  // all three must be in the SINGLE authoritative reserved inventory.
  const altKeys: { key: string; alt: boolean; shift: boolean }[] = [
    { key: 'tab', alt: false, shift: true },   // Shift+Tab
    { key: 'up', alt: true, shift: false },    // Alt+Up
    { key: 't', alt: true, shift: false },     // Alt+T
  ]
  for (let index = 0; index < altKeys.length; index++) {
    const binding = altKeys[index]!
    assert.throws(() => registry.register({
      id: `k-alt-${index}`,
      key: { key: binding.key, ctrl: false, alt: binding.alt, shift: binding.shift, super: false },
      action: 'open-search',
    }, 'o'), /reserved/, `${binding.alt ? 'Alt+' : 'Shift+'}${binding.key} must be reserved`)
  }
  // Ctrl+J is NOT free for plugins either (round-13 finding): on legacy
  // terminals it IS the LF/Enter byte — the registry shares the config
  // parser's legacy-collision policy, so the registration is rejected
  // (the router's normalized lookup could never match the raw byte, and
  // the editor would consume it first).
  assert.throws(() => registry.register({
    id: 'k-ctrl-j',
    key: { key: 'j', ctrl: true, alt: false, shift: false, super: false },
    action: 'open-search',
  }, 'o'), /legacy terminal/, 'Ctrl+J must be rejected as a legacy collision, not claimable')
})

test('KeybindingRegistry: duplicate keys conflict; unload removes bindings', () => {
  const registry = new KeybindingRegistry()
  const handle = registry.register({
    id: 'k1',
    // Ctrl+Alt+Y: not editor-owned (yank is Alt+Y / Ctrl+Y — round-19
    // finding), so it is a bindable plugin chord.
    key: { key: 'y', ctrl: true, alt: true, shift: false, super: false },
    action: 'open-search',
  }, 'o')
  assert.throws(() => registry.register({
    id: 'k2',
    key: { key: 'y', ctrl: true, alt: true, shift: false, super: false },
    action: 'cancel-activity',
  }, 'o2'), /duplicate keybinding/)
  assert.equal(registry.actionFor({ key: 'y', ctrl: true, alt: true, shift: false, super: false }), 'open-search')
  handle.dispose()
  assert.equal(registry.actionFor({ key: 'y', ctrl: false, alt: true, shift: false, super: false }), undefined)
})
