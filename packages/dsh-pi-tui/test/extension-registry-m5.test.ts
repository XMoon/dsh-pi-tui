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
import { LOCAL_COMMANDS, SESSIONLESS_COMMANDS, shouldSteerOnEnter } from '../src/index.ts'

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

test('CommandBridge: a name conflict is reported, never silently overridden', () => {
  const bridge = new CommandBridge()
  bridge.register({ id: 'a', name: 'dup', description: '', execution: 'local' }, 'owner-a')
  const outcome = bridge.register({ id: 'b', name: 'dup', description: '', execution: 'local' }, 'owner-b')
  assert.equal(outcome.kind, 'conflict')
  assert.equal(outcome.existingOwner, 'owner-a')
  assert.equal(bridge.snapshot().entries.length, 1, 'the second registration is not stored')
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

// ── KeybindingRegistry ─────────────────────────────────────────────────────

test('KeybindingRegistry: reserved host keys are rejected', () => {
  const registry = new KeybindingRegistry()
  assert.throws(() => registry.register({
    id: 'k1',
    key: { key: 'c', ctrl: true, alt: false, shift: false, super: false },
    action: 'submit-draft',
  }, 'o'), /reserved/)
  assert.throws(() => registry.register({
    id: 'k2',
    key: { key: 'enter', ctrl: false, alt: false, shift: false, super: false },
    action: 'submit-draft',
  }, 'o'), /reserved/)
})

test('KeybindingRegistry: duplicate keys conflict; unload removes bindings', () => {
  const registry = new KeybindingRegistry()
  const handle = registry.register({
    id: 'k1',
    key: { key: 'g', ctrl: true, alt: false, shift: false, super: false },
    action: 'open-search',
  }, 'o')
  assert.throws(() => registry.register({
    id: 'k2',
    key: { key: 'g', ctrl: true, alt: false, shift: false, super: false },
    action: 'cancel-activity',
  }, 'o2'), /duplicate keybinding/)
  assert.equal(registry.actionFor({ key: 'g', ctrl: true, alt: false, shift: false, super: false }), 'open-search')
  handle.dispose()
  assert.equal(registry.actionFor({ key: 'g', ctrl: true, alt: false, shift: false, super: false }), undefined)
})
