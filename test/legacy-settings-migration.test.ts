/**
 * PR A §19 — the one-shot legacy persisted-data migration contract:
 * the retired $DSH_HOME/settings.yaml sections (the TUI's historical
 * `dsh-pi-tui` document and `agent-presets.default`) must reach the 0.1.7
 * profile-owned configuration through the official SettingsForms surface,
 * exactly once (marker-gated), without trust escalation, without legacy
 * preset aliases, and without ever touching the legacy files themselves.
 * @module @xmoon76/dsh-pi-tui/legacy-settings-migration.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacySettings, type LegacySettingsMigrationInput, type MigrationDiagLike } from '../src/legacy-settings-migration.ts'
import type { SettingsFormsLike, TuiSettingsDescriptorLike, TuiSettingsPathOp } from '../src/runtime/direct/tui-settings-direct.ts'

type MutateCall = { ns: string; ops: readonly TuiSettingsPathOp[]; revision?: number }

/** A mutable volatile reference (the loader commits new values into the
 * real references; tests steer the same surface directly). */
function mutableRef<T>(initial: T): { get(): T; set(value: T): void } {
  let value = initial
  return { get: () => value, set: (next: T) => { value = next } }
}

/** The recording SettingsForms fake: descriptors for named sections and a
 * mutate that can be scripted to fail. */
function formsHarness(sections: Record<string, unknown> = {}) {
  const calls: MutateCall[] = []
  let failMutates = false
  const revisions: Record<string, number> = {}
  const revisionOf = (ns: string): number => revisions[ns] ?? (revisions[ns] = 4)
  const forms: SettingsFormsLike = {
    describe: () => Object.keys({ ...sections, 'tui-app': 0, 'agent-preset-registry': 0 }).map((ns): TuiSettingsDescriptorLike => ({
      ns,
      value: sections[ns],
      user: sections[ns],
      revision: revisionOf(ns),
    })),
    mutate: async (ns, ops, expectedRevision) => {
      if (failMutates) throw new Error('profile write rejected')
      calls.push({ ns, ops, revision: expectedRevision })
      revisionOf(ns)
    },
  }
  return {
    forms,
    calls,
    get failMutates() { return failMutates },
    set failMutates(value: boolean) { failMutates = value },
  }
}

/** The diagnostics sink capturing warn/info lines for failure visibility. */
function diagHarness(): { diag: MigrationDiagLike; warnings: string[]; infos: string[] } {
  const warnings: string[] = []
  const infos: string[] = []
  return {
    warnings,
    infos,
    diag: {
      warn: (message) => { warnings.push(message) },
      info: (message) => { infos.push(message) },
    },
  }
}

/** A fresh temp home carrying an optional legacy document. */
function legacyHome(document?: string): string {
  const home = join(tmpdir(), `dsh-pi-tui-legacy-migration-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(home, { recursive: true })
  if (document !== undefined) writeFileSync(join(home, 'settings.yaml'), document, 'utf8')
  return home
}

function input(home: string, forms: SettingsFormsLike | undefined, markerValue: number, resolvePreset: (id: string) => Promise<void>, diag: MigrationDiagLike): LegacySettingsMigrationInput & { marker: { get(): number; set(value: number): void } } {
  const marker = mutableRef(markerValue)
  return {
    home,
    forms,
    resolvePreset,
    migrationMarker: marker,
    diag,
    marker,
  } as LegacySettingsMigrationInput & { marker: { get(): number; set(value: number): void } }
}

const alwaysResolves: (id: string) => Promise<void> = async () => {}
const neverResolves: (id: string) => Promise<void> = async (id) => {
  throw Object.assign(new Error(`Unknown agent preset: ${id}`), { code: 'agent-preset/not-found' })
}

function opsOf(calls: readonly MutateCall[], ns: string): readonly TuiSettingsPathOp[] {
  return calls.filter(call => call.ns === ns).flatMap(call => call.ops)
}

// ── §19.1 the TUI document ────────────────────────────────────────────────

test('an old dsh-pi-tui document migrates into tui-app as path-scoped sets', async () => {
  const home = legacyHome(`dsh-pi-tui:
  theme: dark
  iconStyle: symbols
  footer: custom
  displayPreset: compact
  notificationMode: always
  wheelScrollLines: "5"
  progressUpdates: frequent
  responseStyle: concise
agent-presets:
  default: minimal
`)
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    const report = await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    assert.equal(report.status, 'migrated')
    const ops = opsOf(harness.calls, 'tui-app')
    const set = (field: string) => ops.find(op => op.op === 'set' && op.path[0] === field)
    assert.deepEqual(set('theme'), { op: 'set', path: ['theme'], value: 'dark' })
    assert.deepEqual(set('iconStyle'), { op: 'set', path: ['iconStyle'], value: 'symbols' })
    assert.deepEqual(set('footer'), { op: 'set', path: ['footer'], value: 'custom' })
    assert.deepEqual(set('displayPreset'), { op: 'set', path: ['displayPreset'], value: 'compact' })
    assert.deepEqual(set('notificationMode'), { op: 'set', path: ['notificationMode'], value: 'always' })
    assert.deepEqual(set('wheelScrollLines'), { op: 'set', path: ['wheelScrollLines'], value: '5' })
    assert.deepEqual(set('progressUpdates'), { op: 'set', path: ['progressUpdates'], value: 'frequent' })
    assert.deepEqual(set('responseStyle'), { op: 'set', path: ['responseStyle'], value: 'concise' })
    // The completing marker rides the same batch.
    assert.deepEqual(ops.find(op => op.path[0] === 'legacySettingsMigrationVersion'),
      { op: 'set', path: ['legacySettingsMigrationVersion'], value: 1 })
    // focusMode and history never cross into the canonical fields.
    assert.equal(ops.some(op => op.path[0] === 'focusMode' || op.path[0] === 'history'), false)
    // §19.7 the legacy preset default lands on the registry preference.
    assert.deepEqual(opsOf(harness.calls, 'agent-preset-registry'), [
      { op: 'set', path: ['selectedDefault'], value: 'minimal' },
    ])
    if (report.status === 'migrated') assert.equal(report.presetDefault, 'minimal')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('legacy focusMode converges into displayPreset and is never carried as a field', async () => {
  const { diag } = diagHarness()
  const focusOnly = legacyHome('dsh-pi-tui:\n  focusMode: "on"\n')
  try {
    await migrateLegacySettings(input(focusOnly, formsHarness().forms, 0, alwaysResolves, diag))
    // §19.2 — asserted below through the shared helper; see the focused cases.
  } finally {
    rmSync(focusOnly, { recursive: true, force: true })
  }

  const cases: readonly { document: string; expected: string }[] = [
    { document: 'dsh-pi-tui:\n  focusMode: "on"\n', expected: 'focus' },
    { document: 'dsh-pi-tui:\n  focusMode: "off"\n', expected: 'full' },
    { document: 'dsh-pi-tui:\n  focusMode: "on"\n  displayPreset: compact\n', expected: 'compact' },
    { document: 'dsh-pi-tui:\n  displayPreset: garbage\n', expected: 'full' },
  ]
  for (const { document, expected } of cases) {
    const home = legacyHome(document)
    const harness = formsHarness()
    try {
      await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
      const ops = opsOf(harness.calls, 'tui-app')
      assert.deepEqual(ops.find(op => op.path[0] === 'displayPreset'),
        { op: 'set', path: ['displayPreset'], value: expected },
        `${document.trim().replace(/\n\s*/g, ' ')} must converge to ${expected}`)
      assert.equal(ops.some(op => op.path[0] === 'focusMode'), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
})

test('a section with no display opinion leaves the schema default unpinned', async () => {
  const home = legacyHome('dsh-pi-tui:\n  theme: dark\n')
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    const ops = opsOf(harness.calls, 'tui-app')
    assert.equal(ops.some(op => op.path[0] === 'displayPreset'), false,
      'no legacy display input → no displayPreset op (the schema default already says full)')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── §19.5/§19.6 raw fields ────────────────────────────────────────────────

test('the legacy footerCommand and keybindings ride verbatim; absent fields emit no ops', async () => {
  const home = legacyHome(`dsh-pi-tui:
  theme: dark
  footer: command
  footerCommand:
    schemaVersion: 1
    command: status.sh
    timeoutMs: 3000
    refreshIntervalMs: 10000
    maxRows: 2
  keybindings:
    app.input.steer: ctrl+x
    app.display.focus: ctrl+g
`)
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    const ops = opsOf(harness.calls, 'tui-app')
    assert.deepEqual(ops.find(op => op.path[0] === 'footerCommand'), {
      op: 'set',
      path: ['footerCommand'],
      value: {
        schemaVersion: 1,
        command: 'status.sh',
        timeoutMs: 3000,
        refreshIntervalMs: 10000,
        maxRows: 2,
      },
    }, 'the legacy USER command migrates as a whole-value set (USER provenance preserved)')
    assert.deepEqual(ops.find(op => op.path[0] === 'keybindings'), {
      op: 'set',
      path: ['keybindings'],
      value: { 'app.input.steer': 'ctrl+x', 'app.display.focus': 'ctrl+g' },
    }, 'the raw keybinding object is preserved verbatim')
    assert.equal(ops.some(op => op.path[0] === 'footerCustomItems' || op.path[0] === 'footerLayout'), false,
      'absent legacy fields emit no ops (nothing inherited gets pinned)')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the legacy per-cwd history moves to user-history JSONL files, never into Config', async () => {
  const home = legacyHome(`dsh-pi-tui:
  theme: dark
  history:
    /ws/one:
      - second
      - first
    /ws/empty: []
`)
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    // The file name is derived from the cwd hash; locate it by content.
    const dir = join(home, 'user-history')
    assert.ok(existsSync(dir), 'the user-history directory exists')
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(dir)
    const lines = files.flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean))
    assert.deepEqual(lines, ['{"content":"first"}', '{"content":"second"}'],
      'the legacy entries land in a JSONL file (file order is oldest-first)')
    assert.equal((opsOf(harness.calls, 'tui-app')).some(op => op.path[0] === 'history'), false,
      'history never becomes a Config field')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── §19.8 legacy preset identity ──────────────────────────────────────────

test('a legacy default the current registry does not declare is invalid — no alias, no write, official default stays', async () => {
  const home = legacyHome('agent-presets:\n  default: code\n')
  const harness = formsHarness()
  const { diag, warnings } = diagHarness()
  try {
    const report = await migrateLegacySettings(input(home, harness.forms, 0, neverResolves, diag))
    assert.equal(report.status, 'migrated', 'the TUI section (absent) still completes with the marker')
    assert.equal(opsOf(harness.calls, 'agent-preset-registry').length, 0,
      'NO selectedDefault write — no code → ptc alias, no guessed replacement')
    assert.ok(warnings.some(message => message.includes('legacy agent preset default is invalid or unavailable')),
      'the invalid preference is visible in diagnostics')
    // An ordinary obsolete id follows the SAME branch — code is not special.
    const home2 = legacyHome('agent-presets:\n  default: removed-preset\n')
    const harness2 = formsHarness()
    const diag2 = diagHarness()
    try {
      await migrateLegacySettings(input(home2, harness2.forms, 0, neverResolves, diag2.diag))
      assert.equal(opsOf(harness2.calls, 'agent-preset-registry').length, 0)
      assert.ok(diag2.warnings.some(message => message.includes('legacy agent preset default is invalid or unavailable')),
        'an ordinary obsolete id reports the same diagnostic (no special branch)')
    } finally {
      rmSync(home2, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a real declarative code id migrates as itself — never rewritten to ptc', async () => {
  const home = legacyHome('agent-presets:\n  default: code\n')
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    const report = await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    assert.deepEqual(opsOf(harness.calls, 'agent-preset-registry'), [
      { op: 'set', path: ['selectedDefault'], value: 'code' },
    ])
    if (report.status === 'migrated') assert.equal(report.presetDefault, 'code')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── §19.9 idempotence ─────────────────────────────────────────────────────

test('a completed marker short-circuits the migration without reading the legacy file', async () => {
  const home = legacyHome('dsh-pi-tui:\n  theme: dark\n')
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    const report = await migrateLegacySettings(input(home, harness.forms, 1, alwaysResolves, diag))
    assert.equal(report.status, 'current')
    assert.equal(harness.calls.length, 0, 'no reads, no writes after the marker completed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('no legacy document anywhere completes the marker so a later file cannot re-apply', async () => {
  const home = legacyHome()
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    const report = await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    assert.equal(report.status, 'absent')
    assert.deepEqual(opsOf(harness.calls, 'tui-app'), [
      { op: 'set', path: ['legacySettingsMigrationVersion'], value: 1 },
    ], 'the marker alone advances')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the renamed settings.yaml.imported is read after the upstream import race', async () => {
  const home = legacyHome()
  writeFileSync(join(home, 'settings.yaml.imported'), 'dsh-pi-tui:\n  theme: dark\n', 'utf8')
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    assert.deepEqual(opsOf(harness.calls, 'tui-app').find(op => op.path[0] === 'theme'),
      { op: 'set', path: ['theme'], value: 'dark' })
    assert.equal(existsSync(join(home, 'settings.yaml.imported')), true, 'the backup file is never modified')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── §19.10 failures ───────────────────────────────────────────────────────

test('a malformed legacy document fails visibly and retries on the next start', async () => {
  const home = legacyHome('dsh-pi-tui:\n  theme: [unbalanced\n')
  const harness = formsHarness()
  const { diag, warnings } = diagHarness()
  try {
    const report = await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    assert.equal(report.status, 'failed')
    assert.match(report.reason, /malformed legacy settings document/u)
    assert.equal(harness.calls.length, 0, 'nothing was written')
    assert.ok(warnings.some(message => message.includes('malformed')), 'the failure is visible')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a refused profile write fails visibly and does not advance the marker', async () => {
  const home = legacyHome('dsh-pi-tui:\n  theme: dark\n')
  const harness = formsHarness()
  harness.failMutates = true
  const { diag, warnings } = diagHarness()
  try {
    const probe = input(home, harness.forms, 0, alwaysResolves, diag)
    // A successful marker write commits the volatile reference (the Loader
    // owns that commit in production; the fake emulates it).
    const originalMutate = harness.forms.mutate.bind(harness.forms)
    harness.forms.mutate = async (ns, ops, revision) => {
      await originalMutate(ns, ops, revision)
      if (ns === 'tui-app' && ops.some(op => op.path[0] === 'legacySettingsMigrationVersion')) {
        probe.marker.set(1)
      }
    }
    const report = await migrateLegacySettings(probe)
    assert.equal(report.status, 'failed')
    assert.equal(probe.marker.get(), 0, 'the marker does not falsely advance')
    assert.ok(warnings.some(message => message.includes('migration failed')), 'the refusal is visible')
    // A retry on the next boot re-applies the same values and completes.
    harness.failMutates = false
    const second = await migrateLegacySettings(probe)
    assert.equal(second.status, 'migrated')
    assert.equal(probe.marker.get(), 1, 'the completed write advances the marker (loader commit emulated)')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a refused marker write on the absent-document path fails visibly and retries', async () => {
  const home = legacyHome()
  const harness = formsHarness()
  harness.failMutates = true
  const { diag, warnings } = diagHarness()
  try {
    const probe = input(home, harness.forms, 0, alwaysResolves, diag)
    const report = await migrateLegacySettings(probe)
    assert.equal(report.status, 'failed')
    assert.match(report.reason, /marker write failed/u)
    assert.equal(probe.marker.get(), 0, 'the marker does not advance on a refused write')
    assert.ok(warnings.some(message => message.includes('marker write failed; will retry on next start')),
      'the refused marker write is visible in diagnostics')
    // The next boot (write healthy again) completes the marker.
    harness.failMutates = false
    const second = await migrateLegacySettings(probe)
    assert.equal(second.status, 'absent')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('without the Settings surface nothing migrates and the marker stays put', async () => {
  const home = legacyHome('dsh-pi-tui:\n  theme: dark\n')
  const { diag, warnings } = diagHarness()
  try {
    const probe = input(home, undefined, 0, alwaysResolves, diag)
    const report = await migrateLegacySettings(probe)
    assert.equal(report.status, 'failed')
    assert.equal(probe.marker.get(), 0)
    assert.ok(warnings.some(message => message.includes('settings service missing')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('mutations carry the descriptor revision read immediately before the write', async () => {
  const home = legacyHome('dsh-pi-tui:\n  theme: dark\n')
  const harness = formsHarness()
  const { diag } = diagHarness()
  try {
    await migrateLegacySettings(input(home, harness.forms, 0, alwaysResolves, diag))
    for (const call of harness.calls) {
      assert.equal(call.revision, 4, 'each write carries the current revision (conflicts surface)')
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
