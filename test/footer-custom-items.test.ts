/**
 * PR C tests for user-owned Custom Text footer definitions: parsing and
 * compilation, the hierarchical create/edit/rename/delete flow, searchable
 * picker integration, and the settings-safe separation from FooterLayoutV1.
 * @module @xmoon76/dsh-pi-tui/footer-custom-items.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import { FooterComposer } from '../src/footer/composer.ts'
import {
  DEFAULT_CUSTOM_COMMAND_REFRESH_MS,
  FooterCustomItemCatalog,
  effectiveCustomCommandRefreshMs,
  effectiveCustomCommandTimeoutMs,
  parseFooterCustomItem,
  parseFooterCustomItems,
} from '../src/footer/custom-items.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { FooterItemRegistry } from '../src/footer/item-registry.ts'
import { FooterConfiguratorModel, itemMenuFor } from '../src/footer/configurator-model.ts'
import type { FooterItemDefinition } from '../src/footer/types.ts'
import { emptyStatusSnapshot } from '../src/status/types.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const VALID_ENVIRONMENT = {
  schemaVersion: 1 as const,
  id: 'user:environment',
  kind: 'text' as const,
  text: 'PROD',
  tone: 'warning' as const,
}

const VALID_CLOCK = {
  schemaVersion: 1 as const,
  id: 'user:clock',
  kind: 'command' as const,
  command: 'date +%H:%M',
  tone: 'accent' as const,
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function emptyModel(catalog = new FooterCustomItemCatalog()): FooterConfiguratorModel {
  const registry = new FooterItemRegistry()
  return new FooterConfiguratorModel({ schemaVersion: 1, rows: [{ left: [], right: [] }] }, registry, catalog)
}

function createText(m: FooterConfiguratorModel, name: string, text: string): void {
  m.activate() // rows -> row
  m.startAdd()
  m.text('no-match')
  m.activate() // add -> create-name
  m.text(name)
  m.activate() // create-name -> create-text
  m.text(text)
  m.activate() // create-text -> create-tone
  m.activate() // default Auto -> row
}

test('custom definitions use stable user:* ids and reject namespace collisions or controls', () => {
  assert.equal(parseFooterCustomItem(VALID_ENVIRONMENT)?.id, 'user:environment')
  assert.equal(parseFooterCustomItem({ ...VALID_ENVIRONMENT, tone: 'auto' })?.tone, 'auto')
  assert.equal(parseFooterCustomItem({ ...VALID_ENVIRONMENT, id: 'model' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_ENVIRONMENT, id: 'ext:plugin/item' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_ENVIRONMENT, id: 'user:' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_ENVIRONMENT, text: 'PROD\u001b[2J' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_ENVIRONMENT, tone: '#fff' }), undefined)
})

test('invalid and duplicate custom definitions fail soft while valid definitions survive', () => {
  const catalog = new FooterCustomItemCatalog([VALID_ENVIRONMENT])
  assert.match(catalog.create('environment', 'SECOND', 'auto').error ?? '', /already exists/)
  const hostile = {}
  Object.defineProperty(hostile, 'schemaVersion', { get: () => { throw new Error('hostile getter') } })
  const result = parseFooterCustomItems([
    VALID_ENVIRONMENT,
    { ...VALID_ENVIRONMENT, text: 'SECOND' },
    { ...VALID_ENVIRONMENT, id: 'user:region', kind: 'command' },
    { ...VALID_ENVIRONMENT, id: 'user:empty', text: '' },
    hostile,
    { ...VALID_ENVIRONMENT, id: 'user:stage', text: 'STAGE', tone: 'accent' },
  ])
  assert.deepEqual(result.items, [VALID_ENVIRONMENT, { ...VALID_ENVIRONMENT, id: 'user:stage', text: 'STAGE', tone: 'accent' }])
  assert.equal(result.invalidCount, 4)
  assert.equal(parseFooterCustomItems(undefined).invalidCount, 0)
})

test('hostile custom-item collections fail soft without escaping startup', () => {
  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  assert.deepEqual(parseFooterCustomItems(revoked.proxy), { items: [], invalidCount: 1 })

  const throwingIterator: unknown[] = [VALID_ENVIRONMENT]
  Object.defineProperty(throwingIterator, Symbol.iterator, {
    get: () => { throw new Error('hostile iterator getter') },
  })
  assert.deepEqual(parseFooterCustomItems(throwingIterator), { items: [], invalidCount: 1 })
})

test('the reserved user namespace cannot be shadowed by builtin or extension items', () => {
  const definition: FooterItemDefinition = {
    id: 'user:extension',
    label: 'Extension collision',
    defaultZone: 'left',
    defaultImportance: 1,
    formats: ['plain'],
    defaultFormat: 'plain',
    render: () => ({ spans: [{ text: 'EXT' }] }),
  }
  assert.throws(
    () => new FooterItemRegistry().register({ ...definition, id: 'user:builtin' }),
    /reserved for custom items/,
  )

  const registry = new FooterItemRegistry()
  registry.setExternalSource({
    ids: () => [definition.id],
    definition: id => id === definition.id ? definition : undefined,
  })
  registry.setCustomSource(new FooterCustomItemCatalog([{
    schemaVersion: 1,
    id: definition.id,
    kind: 'text',
    text: 'CUSTOM',
  }]))
  assert.equal(registry.get(definition.id), definition, 'the external item must win the namespace collision')
  assert.deepEqual(registry.ids(), [definition.id], 'the collision must not duplicate the picker entry')
})

test('a layered draft catalog can delete without falling back to the active catalog', () => {
  const active = new FooterCustomItemCatalog([VALID_ENVIRONMENT])
  const base = new FooterItemRegistry()
  base.setCustomSource(active)
  const draft = new FooterCustomItemCatalog(active.snapshot())
  const layered = new FooterItemRegistry(base)
  layered.setCustomSource(draft)
  assert.ok(layered.get('user:environment'))
  assert.equal(draft.remove('user:environment'), true)
  assert.equal(layered.get('user:environment'), undefined)
  assert.equal(layered.ids().includes('user:environment'), false)
  assert.ok(base.get('user:environment'), 'the active catalog must remain unchanged')
})

test('compiled custom text is an ordinary synchronous footer item', () => {
  const catalog = new FooterCustomItemCatalog([VALID_ENVIRONMENT])
  const registry = new FooterItemRegistry()
  registry.setCustomSource(catalog)
  const definition = registry.get('user:environment')
  assert.ok(definition)
  const segment = definition.render(emptyStatusSnapshot(), { id: 'user:environment' }, 'preferred', {
    taskBrowserAvailable: false,
    extensionFooterText: '',
  })
  assert.deepEqual(segment?.spans[0], { text: 'PROD', tone: 'warning' })

  const composer = new FooterComposer(registry)
  const rendered = composer.render({
    snapshot: emptyStatusSnapshot(),
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'user:environment' }], right: [] }] },
    width: 80,
    context: { taskBrowserAvailable: false, extensionFooterText: '' },
  })
  assert.ok(plain(rendered).includes('PROD'))
})

test('the Add picker searches custom definitions and creates multiple items automatically', () => {
  const m = emptyModel(new FooterCustomItemCatalog([
    VALID_ENVIRONMENT,
    { schemaVersion: 1, id: 'user:region', kind: 'text', text: 'EU' },
  ]))
  m.activate()
  m.startAdd()
  m.text('environment')
  assert.deepEqual(m.addMatches(), ['user:environment'])
  for (let i = 0; i < 'environment'.length; i += 1) m.backspace()
  m.text('prod')
  assert.deepEqual(m.addMatches(), ['user:environment'])
  m.cancel() // clear query
  m.startAdd()
  m.text('no-match')
  m.activate() // create Environment
  m.text('Environment')
  m.activate()
  m.text('PROD')
  m.activate()
  m.activate()
  assert.equal(m.state().mode, 'row')
  assert.ok(m.state().layout.rows[0]!.left.some(ref => ref.id === 'user:Environment'))

  // A second pass proves the catalog is a collection, not a singleton.
  m.startAdd()
  m.text('another-no-match')
  m.activate()
  m.text('Region')
  m.activate()
  m.text('EU')
  m.activate()
  m.activate()
  assert.ok(m.state().layout.rows[0]!.left.some(ref => ref.id === 'user:Region'))
  assert.equal(m.customItemSettings().length, 4)
})

test('custom item editing separates default and placement tone entries', () => {
  assert.deepEqual(itemMenuFor(['plain'], 'text').map(entry => entry.kind), [
    'custom-text', 'custom-tone', 'tone', 'advanced', 'custom-name', 'custom-delete',
  ])
  assert.deepEqual(itemMenuFor(['plain'], 'command').map(entry => entry.kind), [
    'custom-command', 'custom-refresh', 'custom-timeout', 'custom-tone', 'tone', 'advanced', 'custom-name', 'custom-delete',
  ])
})

test('custom names cannot collide with an extension-owned user namespace id', () => {
  const catalog = new FooterCustomItemCatalog([VALID_ENVIRONMENT])
  const registry = new FooterItemRegistry()
  registry.setExternalSource({
    ids: () => ['user:occupied'],
    definition: id => id === 'user:occupied' ? {
      id,
      label: 'Occupied',
      description: 'Extension item.',
      defaultZone: 'left',
      defaultImportance: 50,
      formats: ['plain'],
      defaultFormat: 'plain',
      render: () => ({ spans: [{ text: 'EXT' }] }),
    } : undefined,
  })
  const m = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'user:environment' }], right: [] }],
  }, registry, catalog)
  m.activate() // row
  m.activate() // item
  for (let i = 0; i < 4; i += 1) m.moveDown() // Rename definition
  m.activate()
  for (let i = 0; i < 'environment'.length; i += 1) m.backspace()
  m.text('occupied')
  m.activate()
  assert.match(m.state().customError, /already exists/)
  assert.ok(m.customItem('user:environment') !== undefined)
})

test('custom Text supports text/tone editing, rename, and referenced delete cleanup', () => {
  const catalog = new FooterCustomItemCatalog([VALID_ENVIRONMENT])
  const registry = new FooterItemRegistry()
  const m = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'user:environment' }, { id: 'user:environment' }], right: [] }],
  }, registry, catalog)
  m.activate() // row
  m.activate() // item

  // Text: replace PROD with STAGE.
  m.activate()
  for (let i = 0; i < 'PROD'.length; i += 1) m.backspace()
  m.text('STAGE')
  m.activate()
  const stage = m.customItem('user:environment')
  assert.equal(stage?.kind === 'text' ? stage.text : undefined, 'STAGE')

  // Default tone: choose Primary in the definition picker.
  m.moveDown()
  m.activate()
  for (let i = 0; i < 5; i += 1) m.moveUp()
  m.activate()
  assert.equal(m.customItem('user:environment')?.tone, 'primary')

  // Placement tone is a separate FooterItemRef override. It wins over the
  // definition tone until the placement is explicitly returned to Auto.
  m.moveDown()
  m.activate()
  for (let i = 0; i < 7; i += 1) m.moveDown()
  m.activate()
  assert.equal(m.state().layout.rows[0]!.left[0]!.tone, 'error')
  assert.equal(m.customItem('user:environment')?.tone, 'primary')
  m.activate()
  for (let i = 0; i < 7; i += 1) m.moveUp()
  m.activate()
  assert.equal(m.state().layout.rows[0]!.left[0]!.tone, undefined)
  assert.equal(m.customItem('user:environment')?.tone, 'primary')

  // Rename: all references receive the new canonical id.
  m.moveDown()
  m.moveDown()
  m.activate()
  for (let i = 0; i < 'environment'.length; i += 1) m.backspace()
  m.text('stage')
  m.activate()
  const renamed = m.customItem('user:stage')
  assert.equal(renamed?.kind === 'text' ? renamed.text : undefined, 'STAGE')
  assert.equal(m.state().layout.rows[0]!.left.every(ref => ref.id === 'user:stage'), true)

  // Delete: Enter opens confirmation, a second Enter removes both refs and
  // the definition from the draft catalog.
  m.moveDown()
  m.activate()
  assert.equal(m.state().mode, 'custom-delete')
  m.activate()
  assert.equal(m.state().mode, 'row')
  assert.deepEqual(m.state().layout.rows[0]!.left, [])
  assert.equal(m.customItem('user:stage'), undefined)
})

test('Custom Text creation is visible in the real configurator UI and saves both parts', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const catalog = new FooterCustomItemCatalog()
  const registry = new FooterItemRegistry(app.getFooterItemRegistry())
  registry.setCustomSource(catalog)
  const model = new FooterConfiguratorModel({ schemaVersion: 1, rows: [{ left: [], right: [] }] }, registry, catalog)
  let saved: { layout: unknown; items: readonly unknown[] } | undefined
  app.openFooterConfigurator({
    model,
    registry,
    composer: new FooterComposer(registry),
    onSave: (layout, items) => { saved = { layout, items: items ?? [] } },
    onCancel: () => {},
  })
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Configure Footer'))

  vt.sendInput('\r') // row
  vt.sendInput('a') // add picker
  vt.sendInput('no-match') // make the create action the only option
  await vt.waitForRender()
  const addView = vt.getViewport().join('\n')
  assert.ok(addView.includes('+ Create Custom Text'))
  assert.ok(addView.includes('Create a user-defined static footer item.'), `create action must describe itself:\n${addView}`)
  vt.sendInput('\r') // create name
  vt.sendInput('Environment')
  vt.sendInput('\r') // create text
  vt.sendInput('PROD')
  vt.sendInput('\r') // create tone
  vt.sendInput('\r') // create with Auto
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('PROD'))
  vt.sendInput('\r') // item editor
  await vt.waitForRender()
  const itemView = vt.getViewport().join('\n')
  assert.ok(itemView.includes('Text'), `custom item editor must expose Text:\n${itemView}`)
  assert.ok(itemView.includes('Default tone'), `custom item editor must expose definition tone:\n${itemView}`)
  assert.ok(itemView.includes('Tone'), `custom item editor must expose placement tone:\n${itemView}`)
  assert.ok(itemView.includes('Rename definition'), `custom item editor must expose rename:\n${itemView}`)
  assert.ok(itemView.includes('Delete definition'), `custom item editor must expose delete:\n${itemView}`)
  vt.sendInput('\x1b') // item -> row
  vt.sendInput('\x1b') // row -> selector
  vt.sendInput('s') // save
  await vt.waitForRender()
  assert.ok(saved)
  assert.deepEqual(saved.items, [{ schemaVersion: 1, id: 'user:Environment', kind: 'text', text: 'PROD', tone: 'auto' }])
  assert.deepEqual(saved.layout, {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'user:Environment' }], right: [] }],
  })
  app.stop()
})

test('custom definitions do not change the existing FooterLayoutV1 shape or builtin output', () => {
  const builtin = createBuiltinFooterRegistry()
  const withCustom = new FooterItemRegistry(builtin)
  withCustom.setCustomSource(new FooterCustomItemCatalog([VALID_ENVIRONMENT]))
  const composer = new FooterComposer(withCustom)
  const layout = { schemaVersion: 1 as const, rows: [{ left: [{ id: 'model' }], right: [] }] }
  const snapshot = emptyStatusSnapshot()
  assert.equal(
    plain(composer.render({ snapshot, layout, width: 80, context: { taskBrowserAvailable: false, extensionFooterText: '' } })),
    plain(new FooterComposer(builtin).render({ snapshot, layout, width: 80, context: { taskBrowserAvailable: false, extensionFooterText: '' } })),
  )
  assert.equal(layout.schemaVersion, 1)
  assert.deepEqual(Object.keys(layout.rows[0]!), ['left', 'right'])
})

// ── PR D: custom command item schema / parser / catalog ──────────────────

test('PR D: a valid command definition parses with the user:* id contract', () => {
  const parsed = parseFooterCustomItem(VALID_CLOCK)
  assert.deepEqual(parsed, VALID_CLOCK)
  assert.equal(parsed?.kind, 'command')
  // The effective defaults: 5s refresh, 300ms timeout (the whole-footer
  // default) — absent and explicit defaults are the same fact.
  assert.equal(effectiveCustomCommandRefreshMs(parsed!), DEFAULT_CUSTOM_COMMAND_REFRESH_MS)
  assert.equal(effectiveCustomCommandRefreshMs({ ...VALID_CLOCK, refreshIntervalMs: 5000 }), 5000)
  assert.equal(effectiveCustomCommandTimeoutMs(parsed!), 300)
  assert.equal(effectiveCustomCommandTimeoutMs({ ...VALID_CLOCK, timeoutMs: 300 }), 300)
  // Explicit values round-trip.
  const explicit = parseFooterCustomItem({ ...VALID_CLOCK, refreshIntervalMs: 10000, timeoutMs: 500 })
  assert.deepEqual(explicit, { ...VALID_CLOCK, refreshIntervalMs: 10000, timeoutMs: 500 })
})

test('PR D: command validation rejects empty/control-char commands and bad ids/tones', () => {
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, command: '' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, command: '   ' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, command: 'date\u0000' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, command: 'date\u001b[2J' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, id: 'clock' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, id: 'ext:clock' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, tone: '#fff' }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, schemaVersion: 2 }), undefined)
  assert.equal(parseFooterCustomItem({ ...VALID_CLOCK, kind: 'script' }), undefined)
})

test('PR D: refresh/timeout bounds follow the whole-footer rule set (clamp, never reject finite junk)', () => {
  // A hand-edited refresh below the 1s floor is accepted and clamped by the
  // runtime — the SAME contract as parseFooterCommandConfig (one rule set,
  // never two drifting copies).
  const low = parseFooterCustomItem({ ...VALID_CLOCK, refreshIntervalMs: 100 })
  assert.ok(low)
  assert.equal(low!.kind === 'command' ? low!.refreshIntervalMs : undefined, 100, 'the raw value round-trips; the runtime clamps')
  // Non-finite numeric fields are DROPPED (treated as absent — the
  // persisted item must never carry NaN/Infinity).
  const nan = parseFooterCustomItem({ ...VALID_CLOCK, refreshIntervalMs: Number.NaN, timeoutMs: Number.POSITIVE_INFINITY })
  assert.deepEqual(nan, VALID_CLOCK)
  const junk = parseFooterCustomItem({ ...VALID_CLOCK, refreshIntervalMs: '5s', timeoutMs: 'fast' })
  assert.deepEqual(junk, VALID_CLOCK)
  // Out-of-range timeouts are accepted and clamped by the runtime.
  const big = parseFooterCustomItem({ ...VALID_CLOCK, timeoutMs: 5000 })
  assert.ok(big)
  assert.equal(big!.kind === 'command' ? big!.timeoutMs : undefined, 5000)
})

test('PR D: mixed text + command collections parse with first-wins duplicates', () => {
  const result = parseFooterCustomItems([
    VALID_ENVIRONMENT,
    VALID_CLOCK,
    { ...VALID_CLOCK, id: 'user:clock', command: 'SECOND' },
    { ...VALID_CLOCK, id: 'user:empty', command: '' },
    { schemaVersion: 1, id: 'user:future', kind: 'future-kind', command: 'date' },
  ])
  assert.deepEqual(result.items, [VALID_ENVIRONMENT, VALID_CLOCK])
  assert.equal(result.invalidCount, 3)
})

test('PR D: the catalog creates/edits/renames/removes command definitions', () => {
  const catalog = new FooterCustomItemCatalog()
  const created = catalog.createCommand('Clock', 'date +%H:%M', 5000, 300, 'auto')
  assert.ok(created.item)
  assert.equal(created.item!.kind, 'command')
  assert.equal(catalog.get('user:Clock')?.kind, 'command')
  assert.match(catalog.createCommand('Clock', 'date', 5000, 300, 'auto').error ?? '', /already exists/)
  assert.match(catalog.createCommand('Bad', '', 5000, 300, 'auto').error ?? '', /non-empty/)

  assert.equal(catalog.updateCommand('user:Clock', 'date +%H:%M:%S').ok, true)
  const edited = catalog.get('user:Clock')
  assert.equal(edited?.kind === 'command' ? edited.command : undefined, 'date +%H:%M:%S')
  assert.match(catalog.updateCommand('user:Clock', '\u0000').error ?? '', /non-empty/)
  assert.equal(catalog.updateRefresh('user:Clock', 10000).ok, true)
  const refreshed = catalog.get('user:Clock')
  assert.equal(refreshed?.kind === 'command' ? refreshed.refreshIntervalMs : undefined, 10000)
  assert.equal(catalog.updateTimeout('user:Clock', 500).ok, true)
  const timed = catalog.get('user:Clock')
  assert.equal(timed?.kind === 'command' ? timed.timeoutMs : undefined, 500)
  // A text-only update must not touch a command definition.
  assert.match(catalog.updateText('user:Clock', 'x').error ?? '', /not a text item/)

  const renamed = catalog.rename('user:Clock', 'Time')
  assert.equal(renamed.newId, 'user:Time')
  assert.equal(catalog.get('user:Clock'), undefined)
  assert.equal(catalog.get('user:Time')?.kind, 'command')
  assert.equal(catalog.remove('user:Time'), true)
  assert.equal(catalog.get('user:Time'), undefined)
})

test('PR D: known-kind objects with unknown/future fields are forward-compatible raw data (never normalized)', () => {
  // A future client's field on a KNOWN kind must never be silently
  // normalized away: the object classifies as unknown (preserved raw by
  // the /footer merge, excluded from the runtime projection).
  assert.equal(parseFooterCustomItem({ schemaVersion: 1, id: 'user:clock', kind: 'command', command: 'date', futureField: { version: 2 } }), undefined)
  assert.equal(parseFooterCustomItem({ schemaVersion: 1, id: 'user:env', kind: 'text', text: 'PROD', futureField: 1 }), undefined)
  // The exact v1 key sets still parse.
  assert.ok(parseFooterCustomItem(VALID_CLOCK))
  assert.ok(parseFooterCustomItem(VALID_ENVIRONMENT))
  assert.ok(parseFooterCustomItem({ ...VALID_CLOCK, refreshIntervalMs: 5000, timeoutMs: 300, tone: 'auto' }))
})

test('PR D: a command definition render reads the cache ONLY (no cache → null, placeholder → dim marker)', () => {
  const catalog = new FooterCustomItemCatalog([VALID_CLOCK])
  const registry = new FooterItemRegistry()
  registry.setCustomSource(catalog)
  const render = (): ReturnType<FooterItemDefinition['render']> => registry.get('user:clock')!.render(
    emptyStatusSnapshot(),
    { id: 'user:clock' },
    'preferred',
    { taskBrowserAvailable: false, extensionFooterText: '' },
  )
  // No value source: unavailable (null) — the render path never spawns.
  assert.equal(render(), null)

  // A value source commits the cached first line (the definition is
  // recompiled against the source).
  catalog.setCommandValueSource({ value: () => ({ kind: 'value', text: '14:30' }) })
  assert.deepEqual(render()?.spans[0], { text: '14:30', tone: 'accent' })
  // An empty cached value is unavailable too.
  catalog.setCommandValueSource({ value: () => ({ kind: 'value', text: '' }) })
  assert.equal(render(), null)
  // The configurator's draft source substitutes the dim placeholder.
  catalog.setCommandValueSource({ value: () => ({ kind: 'placeholder' }) })
  assert.deepEqual(render()?.spans[0], { text: '[command]', tone: 'textDim' })

  // The composer renders the cached value as an ordinary item (no
  // command special-case in the composer).
  catalog.setCommandValueSource({ value: () => ({ kind: 'value', text: '14:30' }) })
  const composed = new FooterComposer(registry).render({
    snapshot: emptyStatusSnapshot(),
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'user:clock' }], right: [] }] },
    width: 80,
    context: { taskBrowserAvailable: false, extensionFooterText: '' },
  })
  assert.ok(plain(composed).includes('14:30'))
  assert.ok(!plain(composed).includes('[command]'))
})

test('PR D: a command definition with no cache renders unavailable in the live footer (never a placeholder)', () => {
  const catalog = new FooterCustomItemCatalog([VALID_CLOCK])
  const registry = new FooterItemRegistry()
  registry.setCustomSource(catalog)
  const composed = new FooterComposer(registry).render({
    snapshot: emptyStatusSnapshot(),
    layout: { schemaVersion: 1, rows: [{ left: [{ id: 'user:clock' }], right: [] }] },
    width: 80,
    context: { taskBrowserAvailable: false, extensionFooterText: '' },
  })
  assert.ok(!plain(composed).includes('[command]'), 'the live footer must not show the draft placeholder')
  assert.ok(!plain(composed).includes('date'), 'the live footer must not show the command string')
})

test('PR D: command items participate in the ordinary composer layout (rows, budget, host instruction)', () => {
  const catalog = new FooterCustomItemCatalog([
    VALID_CLOCK,
    { schemaVersion: 1, id: 'user:environment', kind: 'text', text: 'PROD' },
  ])
  catalog.setCommandValueSource({ value: () => ({ kind: 'value', text: '14:30' }) })
  const registry = new FooterItemRegistry(createBuiltinFooterRegistry())
  registry.setCustomSource(catalog)
  const composer = new FooterComposer(registry)
  const layout = {
    schemaVersion: 1 as const,
    rows: [
      { left: [{ id: 'model' }, { id: 'user:clock' }], right: [] },
      { left: [{ id: 'user:environment' }, { id: 'user:clock' }], right: [] },
    ],
  }
  const rendered = composer.render({
    snapshot: emptyStatusSnapshot(),
    layout,
    width: 80,
    context: { taskBrowserAvailable: false, extensionFooterText: '' },
    instruction: { id: 'exit', text: [{ text: 'Ctrl+C exit' }], priority: 100 },
  })
  const lines = rendered.split('\n').filter(line => line !== '')
  assert.ok(plain(rendered).includes('14:30'), 'the command value must render like any item')
  assert.ok(plain(rendered).includes('PROD'), 'the custom text item must render alongside')
  assert.ok(lines.length <= 4, `the whole footer must stay within the 4-line budget (got ${lines.length})`)
  assert.ok(lines.every(line => visibleWidth(line) <= 80), 'no line may overflow the width')
  // Beyond the composer's own SGR and the \n line separators, no control
  // character may leak (a command value is sanitized by the runner).
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(plain(rendered)), 'no control characters may leak')
})
