/**
 * PR A §18 — the Direct `tui-app` settings facade contract: the plugin's
 * volatile Config references are the runtime authority (get reflects
 * reference commits), whole-document replaces become path-scoped
 * SettingsForms mutations that never promote inherited values into the
 * USER profile override, and every write carries the descriptor revision
 * so conflicts surface instead of silently losing updates.
 * @module @xmoon76/dsh-pi-tui/tui-settings-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { DirectTuiSettings, type SettingsFormsLike, type TuiConfigRefs, type TuiSettingsDescriptorLike, type TuiSettingsPathOp } from '../src/runtime/direct/tui-settings-direct.ts'
import type { TuiSettingsDoc } from '../src/runtime/config-port.ts'

/** A mutable volatile reference — the same surface the Loader commits into. */
function ref<T>(initial: T): { get(): T; set(value: T): void } {
  let value = initial
  return { get: () => value, set: (next: T) => { value = next } }
}

/** Build a full refs object over mutable references (schema defaults;
 * override values are wrapped as references automatically). */
function refsOf(overrides: Partial<Record<keyof TuiConfigRefs, unknown>> = {}): TuiConfigRefs & { write(field: keyof TuiConfigRefs, value: unknown): void } {
  const base: Record<string, { get(): unknown; set(value: unknown): void }> = {
    theme: ref('auto'),
    iconStyle: ref('emoji'),
    footer: ref('full'),
    footerFallbackMode: ref('default'),
    footerLayout: ref(undefined),
    footerCustomItems: ref(undefined),
    footerCommand: ref(undefined),
    fullscreen: ref('on'),
    busyEnter: ref('queue'),
    localShellSandbox: ref('bypass'),
    homeEndKeys: ref('input'),
    displayPreset: ref('full'),
    progressUpdates: ref('milestones'),
    responseStyle: ref('default'),
    notificationMode: ref('unfocused'),
    notificationMethod: ref('auto'),
    wheelScrollLines: ref('1'),
    keybindings: ref(undefined),
    legacySettingsMigrationVersion: ref(0),
  }
  for (const [field, value] of Object.entries(overrides)) base[field] = ref(value)
  const refs = base as unknown as TuiConfigRefs & Record<keyof TuiConfigRefs, { get(): unknown; set(value: unknown): void }>
  return {
    ...refs,
    write: (field, value) => { base[field as string]!.set(value) },
  }
}

/** A SettingsForms fake with a scripted user section + revision. */
function formsOf(user: Record<string, unknown> = {}, revision = 2) {
  const calls: Array<{ ns: string; ops: readonly TuiSettingsPathOp[]; revision?: number }> = []
  let conflict = false
  const forms: SettingsFormsLike = {
    describe: () => [{
      ns: 'tui-app',
      value: undefined,
      user,
      revision,
    }] satisfies TuiSettingsDescriptorLike[],
    mutate: async (ns, ops, expectedRevision) => {
      if (conflict) {
        throw Object.assign(new Error('settings namespace "tui-app" changed since it was read'), { code: 'SETTINGS_CONFLICT' })
      }
      calls.push({ ns, ops, revision: expectedRevision })
    },
  }
  return {
    forms,
    calls,
    get conflict() { return conflict },
    set conflict(value: boolean) { conflict = value },
  }
}

/** The default document a fresh deployment reads (absent whole-value
 * fields carry explicit undefined keys on the snapshot). */
function defaults(): TuiSettingsDoc {
  return {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'full',
    footerFallbackMode: 'default',
    footerLayout: undefined,
    footerCustomItems: undefined,
    footerCommand: undefined,
    fullscreen: 'on',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'input',
    displayPreset: 'full',
    progressUpdates: 'milestones',
    responseStyle: 'default',
    notificationMode: 'unfocused',
    notificationMethod: 'auto',
    wheelScrollLines: '1',
    keybindings: undefined,
  }
}

test('get reads the live references at operation time — a reference commit is visible immediately', () => {
  const refs = refsOf()
  const settings = new DirectTuiSettings(refs, formsOf().forms)
  assert.equal(settings.get().theme, 'auto')
  // §18.1: a profile write commits new reference values; the NEXT operation
  // sees them (never a boot-time snapshot).
  refs.write('theme', 'dark')
  refs.write('keybindings', { 'app.input.steer': 'ctrl+x' })
  const doc = settings.get()
  assert.equal(doc.theme, 'dark')
  assert.deepEqual(doc.keybindings, { 'app.input.steer': 'ctrl+x' })
})

test('a whole-document replace writes ONLY the changed fields as path-scoped sets', async () => {
  const refs = refsOf()
  const forms = formsOf()
  const settings = new DirectTuiSettings(refs, forms.forms)
  await settings.replace({ ...settings.get(), theme: 'dark', displayPreset: 'focus' } as TuiSettingsDoc)
  assert.deepEqual(forms.calls, [{
    ns: 'tui-app',
    ops: [
      { op: 'set', path: ['theme'], value: 'dark' },
      { op: 'set', path: ['displayPreset'], value: 'focus' },
    ],
    revision: 2,
  }], 'only the two changed fields cross; unchanged fields never pin the profile')
})

test('§18.2 no effective→user promotion: a base-supplied theme stays out of the USER override', async () => {
  // The base/project layer supplies theme: dark through the reference; the
  // user changes ONLY displayPreset.
  const refs = refsOf({ theme: 'dark', displayPreset: 'compact' })
  const forms = formsOf()
  const settings = new DirectTuiSettings(refs, forms.forms)
  await settings.replace({ ...settings.get(), displayPreset: 'full' } as TuiSettingsDoc)
  assert.deepEqual(forms.calls[0]?.ops, [
    { op: 'set', path: ['displayPreset'], value: 'full' },
  ], 'the inherited theme: dark is NOT copied into the user override')
  // The same holds for the whole-value object fields.
  const forms2 = formsOf()
  const refs2 = refsOf({ footerLayout: { schemaVersion: 1, rows: [] }, keybindings: { a: 'b' } })
  const settings2 = new DirectTuiSettings(refs2, forms2.forms)
  await settings2.replace({ ...settings2.get(), footer: 'custom' } as TuiSettingsDoc)
  assert.deepEqual(forms2.calls[0]?.ops, [
    { op: 'set', path: ['footer'], value: 'custom' },
  ], 'inherited footerLayout/keybindings values are not promoted')
})

test('§18.2 an unrelated write never drops a USER-owned object field whose effective value is a merged superset', async () => {
  // Upstream mergeLayers merges nested plain objects recursively: with a
  // project/home layer contributing extra keys, the EFFECTIVE value is a
  // SUPERSET of the raw USER override. Production writers spread get() (the
  // merged view), so the restated object must be a NO-OP — an unset would
  // destroy the USER's partial override (and disarm a trusted footerCommand);
  // a set would pin the merged superset into the USER layer.
  const userKeybindings = { 'app.input.steer': 'ctrl+x' }
  const effectiveKeybindings = { 'app.input.steer': 'ctrl+x', 'app.display.focus': 'ctrl+g' }
  const userCommand = { schemaVersion: 1, command: 'status.sh', timeoutMs: 3000, refreshIntervalMs: 10000, maxRows: 2 }
  const effectiveCommand = { ...userCommand, env: { PROJECT: '1' } }
  const refs = refsOf({ keybindings: effectiveKeybindings, footerCommand: effectiveCommand })
  const forms = formsOf({ keybindings: userKeybindings, footerCommand: userCommand })
  const settings = new DirectTuiSettings(refs, forms.forms)
  await settings.replace({ ...settings.get(), theme: 'dark' } as TuiSettingsDoc)
  assert.deepEqual(forms.calls[0]?.ops, [
    { op: 'set', path: ['theme'], value: 'dark' },
  ], 'the merged-superset keybindings/footerCommand restates emit NO ops — only the changed scalar crosses')

  // The same protection holds when the whole-value object is genuinely
  // CHANGED (requested differs from both owned and effective): a set.
  const forms2 = formsOf({ keybindings: userKeybindings })
  const settings2 = new DirectTuiSettings(refsOf({ keybindings: effectiveKeybindings }), forms2.forms)
  await settings2.replace({ ...settings2.get(), keybindings: { 'app.input.steer': 'alt+s' } } as TuiSettingsDoc)
  assert.deepEqual(forms2.calls[0]?.ops, [
    { op: 'set', path: ['keybindings'], value: { 'app.input.steer': 'alt+s' } },
  ])
})

test('§18.2 writing the inherited value over a USER override resets it (unset, not pin)', async () => {
  // The USER layer owns theme: dark while the effective reference serves the
  // inherited light: the caller writes light back — the override must be
  // REMOVED (unset), never kept as a pinned value and never dropped silently.
  const refs = refsOf({ theme: 'light' })
  const forms = formsOf({ theme: 'dark' })
  const settings = new DirectTuiSettings(refs, forms.forms)
  await settings.replace({ ...settings.get(), theme: 'light' } as TuiSettingsDoc)
  assert.deepEqual(forms.calls[0]?.ops, [
    { op: 'unset', path: ['theme'] },
  ], 'a reset-to-inherited is an unset; the USER override stops shadowing')
  // A different new value over the same override is an ordinary set.
  const forms2 = formsOf({ theme: 'dark' })
  const settings2 = new DirectTuiSettings(refsOf({ theme: 'light' }), forms2.forms)
  await settings2.replace({ ...settings2.get(), theme: 'blue' } as TuiSettingsDoc)
  assert.deepEqual(forms2.calls[0]?.ops, [
    { op: 'set', path: ['theme'], value: 'blue' },
  ])
})

test('a restated USER-owned raw value emits no op (no self-pinning)', async () => {
  const userRaw = [{ id: 'user-item', kind: 'text', text: 'keep me' }]
  const refs = refsOf({ footerCustomItems: [{ id: 'project-item' }] })
  const forms = formsOf({ footerCustomItems: userRaw })
  const settings = new DirectTuiSettings(refs, forms.forms)
  // withUserFooterCustomItems-style doc: the USER raw is restated over a
  // project-layer effective value.
  await settings.replace({ ...settings.get(), footerCustomItems: userRaw } as TuiSettingsDoc)
  assert.equal(forms.calls.length, 0, 'the user layer already stores the value — no write, no pin')
})

test('a dropped field the USER layer owns unsets; an inherited one stays inherited', async () => {
  const refs = refsOf({ keybindings: { 'app.input.steer': 'ctrl+x' }, footerCustomItems: [{ id: 'x' }] })
  const forms = formsOf({ keybindings: { 'app.input.steer': 'ctrl+x' } })
  const settings = new DirectTuiSettings(refs, forms.forms)
  const doc = { ...settings.get() } as Record<string, unknown>
  delete doc.keybindings
  delete doc.footerCustomItems
  await settings.replace(doc as unknown as TuiSettingsDoc)
  assert.deepEqual(forms.calls[0]?.ops, [
    { op: 'unset', path: ['keybindings'] },
  ], 'the user-owned keybinding override is removed; the project-layer custom items stay untouched')
})

test('an unchanged document emits no mutation at all', async () => {
  const refs = refsOf({ theme: 'dark' })
  const forms = formsOf()
  const settings = new DirectTuiSettings(refs, forms.forms)
  await settings.replace({ ...settings.get() } as TuiSettingsDoc)
  assert.equal(forms.calls.length, 0)
})

test('§18.3 the write carries the descriptor revision and surfaces conflicts', async () => {
  const refs = refsOf()
  const forms = formsOf({}, 11)
  const settings = new DirectTuiSettings(refs, forms.forms)
  await settings.replace({ ...settings.get(), theme: 'dark' } as TuiSettingsDoc)
  assert.equal(forms.calls[0]?.revision, 11)
  forms.conflict = true
  await assert.rejects(
    settings.replace({ ...settings.get(), theme: 'light' } as TuiSettingsDoc),
    (error: unknown) => (error as { code?: unknown }).code === 'SETTINGS_CONFLICT',
    'a stale revision surfaces as the official conflict, never a silent last-write-wins',
  )
})

test('unknown keys in a replacement document are ignored (the schema is the authority)', async () => {
  const refs = refsOf()
  const forms = formsOf()
  const settings = new DirectTuiSettings(refs, forms.forms)
  const doc = { ...settings.get(), focusMode: 'on', history: { '/ws': ['x'] } } as unknown as TuiSettingsDoc
  await settings.replace(doc)
  assert.equal(forms.calls.length, 0, 'retired/unknown keys never reach the profile')
})

test('a replace without the Settings surface fails explicitly', async () => {
  const settings = new DirectTuiSettings(refsOf(), undefined)
  await assert.rejects(settings.replace({ ...settings.get(), theme: 'dark' } as TuiSettingsDoc), /settings service unavailable/u)
})

test('the production schema defaults mount fullscreen ON (§5.5)', () => {
  // The test harness intentionally mounts suites with fullscreen 'off' (the
  // historical degraded baseline); the PRODUCTION default itself is pinned
  // here through the exported schema — the same resolution a Loader-mounted
  // row performs.
  const resolved = TuiConfigSchema({} as never) as unknown as TuiConfigRefs
  assert.equal(resolved.fullscreen.get(), 'on', 'a fresh profile mounts fullscreen on')
  assert.equal(resolved.displayPreset.get(), 'full')
  assert.equal(resolved.busyEnter.get(), 'queue')
  assert.equal(resolved.notificationMode.get(), 'unfocused')
  assert.equal(resolved.legacySettingsMigrationVersion.get(), 0)
})

test('a fresh deployment document carries the product defaults', () => {
  const settings = new DirectTuiSettings(refsOf(), formsOf().forms)
  assert.deepEqual(settings.get(), defaults())
})
