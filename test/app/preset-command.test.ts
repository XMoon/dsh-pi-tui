/**
 * Headless tests for the /preset command surface: the sessionless Catalog
 * (no session created before one exists), the blank-session recompose path,
 * the started-session refusal, the typed verbs and the English display copy.
 * (The two-page panel itself is the subject of `preset-picker.test.ts` and the
 * real owner+UI chain of `preset-pitui-presentation.test.ts`.)
 * @module @xmoon76/dsh-pi-tui/preset-command.test
 */

import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { type TuiCommandRunner, type TuiSettingsLike } from '../../src/commands.ts'
import type { PresetCatalog } from '../../src/runtime/catalog-port.ts'
import { afterEach, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  executeHostCommandSubmission,
  type HostCommandSubmissionDeps,
} from '../../src/app/submission/runtime.ts'
import { SESSION_WRITER_HELD_GUIDANCE } from '../../src/runtime/remote/write-failure.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { KeybindingEditorController } from '../../src/tui/keybindings/ui/controller.ts'
import { parseUserKeybindings } from '../../src/tui/keybindings/config.ts'
import type { CatalogRefreshOutcome, CatalogRefreshRequest } from '../../src/app/command/catalog-refresh.ts'
import type { SurfaceCommandSummary } from '../../src/domain/catalog/surface.ts'
import { SESSIONLESS_COMMANDS } from '../../src/index.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { customThemesDir } from '../../src/client/theme/files.ts'
import { darkColors } from '../../src/domain/display/theme.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import type { PresetPickerHandle, PresetPresentation } from '../../src/app/command/preset-presentation.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { disposeHarnessApps, fakeAgent, setup, SHIPPED_ROWS } from '../support/preset-command-harness.ts'


/** The plain (ANSI-stripped) viewport of one VT frame. */
const plainViewport = (vt: VirtualTerminal): string[] => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))

/** The viewport row of the first painted occurrence of `needle`. */
function rowOfText(vt: VirtualTerminal, needle: string): number {
  const row = plainViewport(vt).findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the painted frame must contain ${JSON.stringify(needle)}:\n${plainViewport(vt).join('\n')}`)
  return row
}

/** Every TuiApp the shared harness started is disposed after each test (the
 *  process slot is exclusive; release needs the FINAL dispose, not stop()). */
afterEach(() => {
  disposeHarnessApps()
})

/** Poll an async predicate until true or the timeout elapses (the picker
 * listing runs behind a scheduler yield inside a detached task). */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, stepMs))
  }
}

// themeOptOut() skips terminal queries under NO_COLOR / FORCE_COLOR=0 /
// CI=true — clear all three so the render paths under test stay live.
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''


test('/preset is in the sessionless dispatch gate', () => {
  // The gate is exactly where /preset used to create a session before the
  // user could switch (dispatchViaSession -> ensureSession). It must keep
  // /preset out of that path.
  assert.ok(SESSIONLESS_COMMANDS.has('preset'), 'SESSIONLESS_COMMANDS must keep /preset sessionless')
})

test('/keybindings opens sessionless without creating a session', async () => {
  const tuiSettings: TuiSettingsLike = {
    get: () => ({
      theme: 'auto',
      footer: 'full',
      fullscreen: 'off',
      busyEnter: 'queue',
      localShellSandbox: 'bypass',
      homeEndKeys: 'viewport',
    wheelScrollLines: '1',
      iconStyle: 'emoji',
      notificationMode: 'unfocused',
      terminalProgress: 'on', notificationMethod: 'auto',
      keybindings: undefined,
    }),
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  try {
    const result = await t.runCommand('keybindings')
    assert.deepEqual(result, { kind: 'success' })
    assert.deepEqual(t.ensureCalls, [], '/keybindings must not create a session')
    const view = await t.view()
    assert.match(view, /Keyboard shortcuts/)
  } finally {
    t.app.stop()
  }
})

test('/preset with no session opens the Catalog and creates nothing', async () => {
  const t = setup({ rows: [...SHIPPED_ROWS, { id: 'reviewer', name: 'My reviewer', description: 'Reviews diffs before merge.' }] })
  const result = await t.run('')
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  const view = await t.view()
  // The OWNER-frozen Catalog: identity, Built-in -> Custom groups, complete
  // `name (id)` labels, the selected row's short detail and the ONE action bar.
  assert.ok(view.includes('Agent presets'), `Catalog identity missing:\n${view}`)
  assert.ok(view.includes('Built-in · 4'), `Built-in group missing:\n${view}`)
  assert.ok(view.includes('Custom · 1'), `Custom group missing:\n${view}`)
  assert.ok(view.includes('Standard mode (standard)'), `roster row missing:\n${view}`)
  assert.ok(view.includes('PTC mode (ptc)') && view.includes('Minimal mode (minimal)')
    && view.includes('Creator mode (cordis)'), `roster rows missing:\n${view}`)
  assert.ok(view.includes('My reviewer (reviewer)'), `custom roster row missing:\n${view}`)
  assert.ok(!view.includes('标准模式') && !view.includes('PTC 模式'), `Chinese preset name leaked:\n${view}`)
  assert.ok(view.includes('Full coding agent with file editing'), `selected row detail missing:\n${view}`)
  assert.ok(view.includes('[default]'), `the committed default chip missing:\n${view}`)
  assert.ok(view.includes('Use next') && view.includes('Set default') && view.includes('Close [Esc]'),
    `the ONE action bar missing:\n${view}`)
  assert.deepEqual(t.presets.selected, [], 'opening the Catalog never writes')
  t.app.stop()
})

test('/preset <id> with no session sets the pending preset, creating nothing', async () => {
  const t = setup({})
  const result = await t.run('minimal')
  assert.deepEqual(result, { kind: 'success', text: 'new sessions will start on preset minimal' })
  assert.equal(t.pending.value, 'minimal')
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  t.app.stop()
})

test('/preset <id> with no session rejects an unknown id', async () => {
  const t = setup({})
  const result = await t.run('nope') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /not found/)
  assert.equal(t.pending.value, undefined)
  assert.deepEqual(t.ensureCalls, [])
  t.app.stop()
})

test('/preset with an EMPTY roster paints the readable Catalog empty state', async () => {
  const t = setup({ roster: async () => ({ presets: [] }) })
  const result = await t.run('') as { kind: string; text?: string }
  // The UX redesign replaces the retired one-line command text with the
  // in-panel empty state; the command itself still succeeds and creates nothing.
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  const view = await t.view()
  assert.ok(view.includes('No agent presets configured.'), `the Catalog empty state missing:\n${view}`)
  assert.ok(view.includes('No preset selected'), `the disabled write reason missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `an empty roster paints no row:\n${view}`)
  t.app.stop()
})

test('/preset roster failure paints the in-panel Error + Retry instead of a thrown command', async () => {
  const t = setup({ roster: async () => { throw new Error('catalog is unreachable') } })
  // The UX redesign owns the read failure in the panel: the SAME read owner
  // reports it to `setLoadError`, so the command settles successfully and the
  // user sees the real reason with an explicit Retry — never a silent no-UI.
  const result = await t.run('') as { kind: string }
  assert.equal(result.kind, 'success')
  const view = await t.view()
  assert.ok(view.includes('Preset catalog unavailable'), `the failure must name itself:\n${view}`)
  assert.ok(view.includes('catalog is unreachable'), `the real read reason must be visible:\n${view}`)
  assert.ok(view.includes('Retry') && view.includes('Close [Esc]'), `Retry + Close missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `no roster row after a failed read:\n${view}`)
  t.app.stop()
})

test('a standing-catalog notice never lands on a newer /preset surface', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let held = false
  const t = setup({
    refreshCatalog: async () => {
      if (held) {
        await gate
        return standingOutcome(['glab'], 'stale standing notice')
      }
      return standingOutcome(['glab'], 'owned standing notice')
    },
  })
  try {
    // POSITIVE CONTROL: while the operation still owns the surface, its notice
    // is visible — the fence cannot be a blanket silence.
    const owned = await t.run('minimal') as { kind: string; text?: string }
    assert.equal(owned.kind, 'success')
    assert.ok((await t.view()).includes('owned standing notice'),
      'the owned standing notice must be visible')

    // STALE CASE: the operation holds its standing refresh while a newer bare
    // `/preset` takes the surface; the older notice must not describe it.
    held = true
    const older = t.run('standard')
    for (let i = 0; i < 100 && t.refreshes.filter(r => r.source === 'preset').length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const newer = await t.run('') as { kind: string; text?: string }
    assert.equal(newer.kind, 'success', 'the newer invocation still settles')
    release()
    await older
    await t.view()
    const view = await t.view()
    assert.ok(!view.includes('stale standing notice'),
      `a replaced surface must not receive the older notice:\n${view}`)
  } finally {
    release()
    t.app.stop()
  }
})

test('/preset default refuses a declared-but-broken preset without writing', async () => {
  const writes: unknown[] = []
  const t = setup({
    rows: [{ id: 'broken-one', description: 'visible but unusable' }],
    roster: async () => ({
      presets: [{ id: 'broken-one', broken: 'preset failed to mount: missing plugin', isDefault: false }],
    }),
    resolve: async () => ({ id: 'broken-one', broken: 'preset failed to mount: missing plugin' }),
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default broken-one') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset failed to mount/u, 'the broken diagnostic surfaces')
  assert.deepEqual(writes, [], 'a broken preset is never persisted as the default')
  assert.deepEqual(t.refreshes, [])
  t.app.stop()
})

test('/preset <broken> sessionless never stages the broken preset', async () => {
  const t = setup({
    rows: [{ id: 'broken-one' }],
    roster: async () => ({
      presets: [{ id: 'broken-one', broken: 'preset failed to mount: missing plugin', isDefault: false }],
    }),
    resolve: async () => ({ id: 'broken-one', broken: 'preset failed to mount: missing plugin' }),
  })
  const result = await t.run('broken-one') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset failed to mount/u)
  assert.equal(t.pending.value, undefined, 'a broken preset is never staged as the pending preset')
  t.app.stop()
})

test('/preset reports an unknown id verbatim — no legacy alias hint', async () => {
  const t = setup({})
  const result = await t.run('code') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset "code" not found/)
  assert.doesNotMatch(result.text, /use preset "ptc"/, 'the retired code→ptc alias must not surface as a hint')
  assert.equal(t.pending.value, undefined)
  t.app.stop()
})

test('/preset code selects a legal custom code roster entry', async () => {
  const t = setup({ rows: [...SHIPPED_ROWS, { id: 'code', name: 'Custom code', trust: 'user' }] })
  const result = await t.run('code')
  assert.deepEqual(result, { kind: 'success', text: 'new sessions will start on preset code' })
  assert.equal(t.pending.value, 'code')
  t.app.stop()
})

test('/new refuses a registry default no declaration supplies — no guessed replacement', async () => {
  const created: { agentPreset?: string }[] = []
  const t = setup({
    defaultPresetId: 'code',
    agents: {
      resolveWorkspace: async () => ({ workspaceId: 'ws-a', path: '/ws' }),
      create: async options => {
        created.push({ agentPreset: options.agentPreset })
        return {} as never
      },
      open: async () => ({}) as never,
    },
  })
  const result = await t.runCommand('new') as { kind: string; text?: string }
  assert.equal(result.kind, 'error', 'an invalid deployment default must surface, never silently become ptc')
  assert.match(result.text ?? '', /preset "code" not found/u)
  assert.deepEqual(t.presets.resolved, ['code'], 'exactly one registry resolution — no fallback probe')
  assert.deepEqual(created, [], 'no session is created on a refused default')
  t.app.stop()
})

test('/sessions opens input-first and shows projection-pending rows before enrichment settles', async () => {
  let resolveBatch!: (value: Map<string, { title?: string; preset?: string }>) => void
  const batch = new Promise<Map<string, { title?: string; preset?: string }>>(resolve => { resolveBatch = resolve })
  const t = setup({
    sessionReader: {
      list: async () => [{ id: 'session-cold', updatedAt: 10, createdAt: 10, cwd: '/ws', live: false }],
      projectionBatch: async () => batch,
    },
  })
  const result = await t.runCommand('sessions')
  assert.deepEqual(result, { kind: 'success' })
  // The workspace owns the input immediately (loading frame); the listing is
  // behind a scheduler yield, so poll until the row lands — still without the
  // pending projection's title enrichment.
  const initial = await t.view()
  assert.ok(initial.includes('Loading sessions…') || initial.includes('cold'),
    `the first frame must be interactive (loading row or listed row):\n${initial}`)
  await waitFor(async () => (await t.view()).includes('cold'))
  const pending = await t.view()
  assert.ok(!pending.includes('cold projected title'), 'a pending projection must not show an enriched title')
  resolveBatch(new Map([['session-cold', { title: 'cold projected title' }]]))
  await waitFor(async () => (await t.view()).includes('cold projected title'))
  t.app.stop()
})

test('/new honors the launch-time effective preset', async () => {
  const created: { agentPreset?: string }[] = []
  const t = setup({
    effectivePresetId: 'minimal',
    agents: {
      resolveWorkspace: async () => ({ workspaceId: 'ws-a', path: '/ws' }),
      create: async options => {
        created.push({ agentPreset: options.agentPreset })
        return {} as never
      },
      open: async () => ({}) as never,
    },
  })
  const result = await t.runCommand('new') as { kind: string; text?: string }
  assert.deepEqual(result, { kind: 'success', text: 'started a fresh session' })
  assert.deepEqual(t.presets.resolved, ['minimal'])
  assert.deepEqual(created, [{ agentPreset: 'minimal' }])
  t.app.stop()
})

test('/preset picker: Enter opens read-only Details; the explicit Use next action writes', async () => {
  const t = setup({})
  await t.run('')
  await t.view()
  // Enter is BROWSE/READ: it opens the selected preset's Details and writes 0.
  t.vt.sendInput('\r')
  await t.view()
  assert.ok(t.vt.getViewport().join('\n').includes('Preset details · Standard mode'),
    `Enter must open Details:\n${t.vt.getViewport().join('\n')}`)
  assert.equal(t.pending.value, undefined, 'reading Details never stages a preset')
  // Back to the Catalog, then the explicit bottom action commits.
  t.vt.sendInput('\x1b')
  await t.view()
  t.vt.sendInput('\t')
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.equal(t.pending.value, 'standard')
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('new sessions will start on preset standard'), `notify missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `the panel closes after the committed action:\n${view}`)
  t.app.stop()
})

test('/preset picker: Enter reads Details, the explicit Use session action switches a blank session', async () => {
  const t = setup({ agent: fakeAgent('s1', []) })
  await t.run('')
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.ok(t.vt.getViewport().join('\n').includes('Preset details · Standard mode'), 'Enter opens Details')
  assert.deepEqual(t.presets.selected, [], 'reading Details never switches')
  t.vt.sendInput('\x1b')
  await t.view()
  t.vt.sendInput('\t')
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.deepEqual(t.presets.selected, ['standard'], 'the explicit Use session action switches once')
  assert.equal(t.pending.value, undefined)
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('session preset switched to standard'), `notify missing:\n${view}`)
  assert.ok(!view.includes('Standard mode (standard)'), `the panel closes after the committed action:\n${view}`)
  t.app.stop()
})

test('/preset <id> switches a blank session', async () => {
  const t = setup({ agent: fakeAgent('s1', []) })
  const result = await t.run('minimal')
  assert.deepEqual(result, { kind: 'success', text: 'session preset switched to minimal' })
  assert.deepEqual(t.presets.selected, ['minimal'])
  t.app.stop()
})

test('/preset with a started session refuses without offering a roster', async () => {
  const t = setup({ agent: fakeAgent('s1', [{ type: 'turn/start' }]), sessionBlank: false })
  const result = await t.run('') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /only available in a new session/)
  const view = await t.view()
  assert.ok(!view.includes('Standard mode (standard)'), `roster offered for a started session:\n${view}`)
  assert.ok(view.includes('only available in a new session'), `notify missing:\n${view}`)
  assert.deepEqual(t.presets.selected, [])
  t.app.stop()
})

test('/preset on a blank session opens the Catalog (Host blank authority, not the transcript)', async () => {
  const t = setup({ agent: fakeAgent('s1', []), sessionBlank: true })
  const result = await t.run('') as { kind: string }
  assert.equal(result.kind, 'success')
  const view = await t.view()
  assert.ok(view.includes('Standard mode (standard)'), `a blank session must offer the roster:\n${view}`)
  t.app.stop()
})

test('the Catalog paints Current and Default as TWO atomic chips and no retired prose', async () => {
  const t = setup({ agent: fakeAgent('s1', []), sessionBlank: true, currentPreset: () => 'standard' })
  const result = await t.run('') as { kind: string }
  assert.equal(result.kind, 'success')
  await t.view()
  const view = plainViewport(t.vt)
  const currentRow = rowOfText(t.vt, '[current]')
  assert.ok(view[currentRow]!.includes('[current] [default]'),
    `the current row must paint BOTH chips whole:\n${view.join('\n')}`)
  assert.ok(!view.some(line => line.includes('← current')),
    `the retired \`← current\` prose must not be painted anywhere:\n${view.join('\n')}`)
  t.app.stop()
})

test('two long same-prefix preset names stay distinguishable at 44 columns (PR #309 review)', async () => {
  // The label column at 44 columns is 25 cells for a chip-bearing row, so the
  // shared head…tail abbreviation must keep each name's own tail and the SELECTED
  // row must paint the complete `name (id)` identity in its description.
  const prefix = 'x'.repeat(30)
  const rows = [{ id: `a-${prefix}AA` }, { id: `a-${prefix}BB` }]
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    currentPreset: () => rows[0]!.id,
    rows,
    width: 44,
    height: 20,
  })
  const result = await t.run('') as { kind: string }
  assert.equal(result.kind, 'success')
  await t.view()
  const view = plainViewport(t.vt)
  const firstRow = view.find(line => line.includes('AA'))
  const secondRow = view.find(line => line.includes('BB'))
  assert.ok(firstRow !== undefined && secondRow !== undefined,
    `each preset row must keep its own tail:\n${view.join('\n')}`)
  assert.notEqual(firstRow, secondRow, `the two rows must not paint identically:\n${view.join('\n')}`)
  // Both ENDS must survive: the head identifies the id, the tail separates the pair.
  assert.ok(firstRow.includes('a-xxx') && secondRow.includes('a-xxx'),
    `each row must keep the name's head too:\n${view.join('\n')}`)
  assert.ok(view.join('\n').includes(rows[0]!.id),
    `the selected row's description must expand the complete name (id):\n${view.join('\n')}`)
  t.app.stop()
})

test('a 19-22 character preset id stays whole in the 44-column label (PR #309 review)', async () => {
  // The ` (id)` suffix must never be traded away while it fits: with only 0-3
  // cells left for the friendly name a 4-cell floor made the composed label exceed
  // the 25-cell column and the renderer clipped the ID's own tail. Each of these
  // ids is the row's own name too, so the label must still end on the whole id.
  for (const length of [19, 20, 22]) {
    const id = 'x'.repeat(length)
    const t = setup({
      agent: fakeAgent('s1', []),
      sessionBlank: true,
      currentPreset: () => id,
      rows: [{ id }],
      width: 44,
      height: 20,
    })
    const result = await t.run('') as { kind: string }
    assert.equal(result.kind, 'success')
    await t.view()
    const rows = plainViewport(t.vt)
    // The LABEL row itself must carry the whole id: the description also holds it,
    // so a view-wide search would pass even when the label clipped it.
    const labelRow = rows.find(line => line.includes('[current]'))
    assert.ok(labelRow !== undefined && labelRow.includes(id),
      `a ${length}-character id must stay whole in the LABEL:\n${rows.join('\n')}`)
    t.app.stop()
    t.app.dispose()
  }
})

test('/preset search uses the COMPLETE name/id/description of every row', async () => {
  const id = `${'k'.repeat(11)}quasar${'z'.repeat(13)}`
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    currentPreset: () => id,
    rows: [{ id }],
    width: 44,
    height: 20,
  })
  const result = await t.run('') as { kind: string }
  assert.equal(result.kind, 'success')
  await t.view()
  // The search goes through the REAL overlay input, not the row object.
  t.vt.sendInput('quasar')
  await t.view()
  const view = plainViewport(t.vt).join('\n')
  assert.ok(!view.includes('No matching presets'), `a middle keyword must still find the preset row:\n${view}`)
  assert.ok(view.includes(id), `the found row must carry the complete identity:\n${view}`)
  t.app.stop()
})

test('/preset <id> with a started session refuses with the locked text', async () => {
  // The Host outcome is scripted explicitly (agent-preset/locked); the double
  // must NOT re-implement the Host blank state machine (§0.11).
  const t = setup({ agent: fakeAgent('s1', [{ type: 'turn/start' }]), sessionBlank: false, selectLocked: true })
  const result = await t.run('minimal') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /has already started; its agent preset is fixed/)
  assert.deepEqual(t.presets.selected, [], 'the Host refusal is the final race check')
  t.app.stop()
})

/** A skills-only applied outcome shaped like the coordinator's standing
 * install (the shape /preset and /reload report). */
function standingOutcome(skills: string[], notice?: string): CatalogRefreshOutcome {
  return {
    kind: 'applied',
    snapshot: Object.freeze({
      commands: Object.freeze([]),
      scopedCommands: Object.freeze([]),
      skills: Object.freeze(skills.map(name => Object.freeze({ name, description: name }))),
      issues: Object.freeze([]),
    }),
    ...notice === undefined ? {} : { notice },
  }
}

test('/preset <id> with no session requests a STANDING refresh of the new preset, creating nothing', async () => {
  const t = setup({ refreshCatalog: async () => standingOutcome(['glab']) })
  const result = await t.run('ptc')
  assert.equal(t.pending.value, 'ptc')
  assert.equal(t.refreshes.length, 1, 'the preset choice must request one standing refresh')
  assert.equal(t.refreshes[0]?.source, 'preset')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'ptc' })
  assert.deepEqual(t.ensureCalls, [], '/preset must not create a session')
  t.app.stop()
})

test('/preset <id> with no session surfaces the standing degradation notice', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome(['global-skill'], 'skill catalog unavailable for preset "ptc": preset exploded'),
  })
  const result = await t.run('ptc') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'new sessions will start on preset ptc')
  assert.equal(t.pending.value, 'ptc')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('preset exploded'), `degradation notice missing:\n${view}`)
  t.app.stop()
})

test('/preset default <id> with no override requests a standing refresh of the new default', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }); return undefined },
    },
  })
  const result = await t.run('default ptc') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'default preset set: ptc')
  assert.equal(mutated.length, 1)
  assert.equal(t.refreshes.length, 1, 'an unmasked default change must refresh the standing catalog')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'ptc' })
  t.app.stop()
})

test('/preset default reports an unknown id verbatim — no legacy alias hint', async () => {
  const writes: unknown[] = []
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default code') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /preset "code" not found/u)
  assert.doesNotMatch(result.text, /use preset "ptc"/u, 'the retired code→ptc alias must not surface as a hint')
  assert.deepEqual(writes, [], 'an unknown code id must never be persisted')
  assert.deepEqual(t.refreshes, [])
  t.app.stop()
})

test('/preset default code writes a legal custom roster entry', async () => {
  const writes: unknown[] = []
  const t = setup({
    rows: [...SHIPPED_ROWS, { id: 'code', name: 'Custom code', trust: 'user' }],
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default code') as { kind: string; text: string }
  assert.deepEqual(result, { kind: 'success', text: 'default preset set: code' })
  assert.deepEqual(writes, [[{ op: 'set', path: ['selectedDefault'], value: 'code' }]])
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'code' })
  t.app.stop()
})

test('/preset default <id> masked by a pending preset does NOT refresh', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async () => undefined,
    },
  })
  t.pending.value = 'minimal'
  const result = await t.run('default ptc') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.equal(t.refreshes.length, 0, 'the pending override masks the new default — no refresh')
  t.app.stop()
})

test('/preset default <id> validates then persists without reading a chooser-policy roster', async () => {
  // rc.2 retires the `modeSelectionEnabled` chooser policy: the default write
  // is no longer gated by (or even reads) the roster. A roster read here would
  // throw, so the mutation proves it never consults one.
  const writes: unknown[] = []
  let rosterReads = 0
  const t = setup({
    roster: async () => { rosterReads += 1; throw new Error('roster must not be read by /preset default') },
    refreshCatalog: async () => standingOutcome(['glab']),
    settings: {
      get: () => undefined,
      mutate: async (_ns, patch) => { writes.push(patch); return undefined },
    },
  })
  const result = await t.run('default ptc') as { kind: string; text?: string }
  assert.deepEqual(result, { kind: 'success', text: 'default preset set: ptc' })
  assert.equal(rosterReads, 0, 'the retired policy roster read must be gone')
  assert.deepEqual(t.presets.resolved, ['ptc'], 'the id is validated through the official registry')
  assert.deepEqual(writes, [[{ op: 'set', path: ['selectedDefault'], value: 'ptc' }]])
  assert.equal(t.refreshes.length, 1, 'the standing catalog follows the new default')
  // Read-only queries stay available.
  assert.equal((await t.run('status') as { kind: string }).kind, 'success')
  assert.equal((await t.run('default') as { kind: string }).kind, 'success')
  t.app.stop()
})

test('/reload with no session refreshes the STANDING catalog and reports the skill count', async () => {
  const t = setup({ refreshCatalog: async () => standingOutcome(['glab', 'find-skills']) })
  const result = await t.runCommand('reload') as { kind: string; text: string }
  assert.ok(result.kind === 'success')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('reloaded'), `reload notify missing:\n${view}`)
  assert.ok(view.includes('2 human skills'), `skill count missing:\n${view}`)
  assert.equal(t.refreshes.length, 1)
  assert.equal(t.refreshes[0]?.source, 'reload')
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: undefined },
    'the effective preset id (none pending) resolves to the deployment default')
  t.app.stop()
})

function reloadSettings(theme: string, onGet?: (count: number) => void): TuiSettingsLike {
  let reads = 0
  let currentTheme = theme
  return {
    get: () => {
      reads += 1
      onGet?.(reads)
      return { theme: currentTheme, iconStyle: 'emoji', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto' }
    },
    replace: doc => { currentTheme = doc.theme as string },
  }
}

function themeExtensions(paletteForSelectable: (value: string) => typeof darkColors | undefined): NonNullable<TuiCommandRunner['extensions']> {
  return { themes: { paletteForSelectable }, settings: new SettingsRegistry() } as unknown as NonNullable<TuiCommandRunner['extensions']>
}

test('/reload theme autodetect rechecks the latest persisted choice before applying', async () => {
  let settingsReads = 0
  const t = setup({
    tuiSettings: reloadSettings('auto', count => { settingsReads = count }),
  })
  let resolveBackground!: (value: { red: number; green: number; blue: number } | undefined) => void
  const pending = new Promise<{ red: number; green: number; blue: number } | undefined>(resolve => { resolveBackground = resolve })
  t.app.autoDetectTheme = async (options) => {
    assert.equal(options?.shouldApply?.(), true)
    // Simulate the settings panel changing the choice while OSC 11 is in flight.
    t.app.applyTheme('light')
    assert.equal(options?.shouldApply?.(), false)
    await pending
  }
  const result = await t.runCommand('reload') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.ok(settingsReads >= 2, 'the late guard must read settings again')
  resolveBackground(undefined)
  t.app.stop()
})

test('/reload custom file theme applies without touching plugin health', async () => {
  const name = `reload-custom-${randomUUID()}`
  const file = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(file, JSON.stringify({ name, colors: { primary: '#123456' } }))
  const cleared: string[] = []
  const recorded: string[] = []
  try {
    const t = setup({
      tuiSettings: reloadSettings(`custom:${name}`),
      extensions: themeExtensions(() => undefined),
      clearExtensionError: (ref) => cleared.push(ref.id),
      recordExtensionError: (ref) => recorded.push(ref.id),
    })
    const result = await t.runCommand('reload') as { kind: string }
    assert.equal(result.kind, 'success')
    assert.deepEqual(cleared, [], 'custom-file success must not clear plugin health')
    assert.deepEqual(recorded, [], 'custom-file success must not record plugin health')
    t.app.stop()
  } finally {
    rmSync(file, { force: true })
  }
})

test('/reload custom file theme failure does not record plugin health', async () => {
  const name = `reload-custom-failing-${randomUUID()}`
  const file = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(file, JSON.stringify({ name, colors: { primary: '#123456' } }))
  const recorded: string[] = []
  try {
    const t = setup({
      tuiSettings: reloadSettings(`custom:${name}`),
      extensions: themeExtensions(() => undefined),
      recordExtensionError: (ref) => recorded.push(ref.id),
    })
    t.app.applyPalette = () => { throw new Error('custom palette failed') }
    const result = await t.runCommand('reload') as { kind: string }
    assert.equal(result.kind, 'success')
    assert.deepEqual(recorded, [], 'custom-file failure must not create plugin health')
    t.app.stop()
  } finally {
    rmSync(file, { force: true })
  }
})

test('/reload plugin theme failure records and later success clears its health', async () => {
  const id = `reload-plugin-${randomUUID()}`
  // The persisted value is the SOURCE-QUALIFIED identity
  // `plugin:<owner>/<id>` (the review's P2); the health ref carries the
  // CONTRIBUTION id (the part after the last slash).
  const sourceQualified = `plugin:test-owner/${id}`
  const recorded: string[] = []
  const cleared: string[] = []
  const t = setup({
    tuiSettings: reloadSettings(sourceQualified),
    extensions: themeExtensions(value => value === sourceQualified ? darkColors : undefined),
    recordExtensionError: (ref) => recorded.push(ref.id),
    clearExtensionError: (ref) => cleared.push(ref.id),
  })
  t.app.applyPalette = () => { throw new Error('plugin palette failed') }
  await t.runCommand('reload')
  assert.deepEqual(recorded, [id], 'plugin palette failure must record its contribution')
  t.app.applyPalette = () => {}
  await t.runCommand('reload')
  assert.deepEqual(cleared, [id], 'a later plugin palette success must clear its contribution')
  t.app.stop()
})

test('/reload unknown theme does not create plugin health', async () => {
  const name = `reload-missing-${randomUUID()}`
  const recorded: string[] = []
  const t = setup({
    tuiSettings: reloadSettings(`custom:${name}`),
    extensions: themeExtensions(() => undefined),
    recordExtensionError: (ref) => recorded.push(ref.id),
  })
  const result = await t.runCommand('reload') as { kind: string }
  assert.equal(result.kind, 'success')
  assert.deepEqual(recorded, [], 'unknown host theme must not create plugin health')
  t.app.stop()
})

test('/reload with a pending preset reports the standing degradation notice', async () => {
  const t = setup({
    refreshCatalog: async () => standingOutcome([], 'skill catalog unavailable for preset "ptc": preset exploded'),
  })
  t.pending.value = 'ptc'
  await t.runCommand('reload')
  await t.view()
  const view = t.vt.getViewport().join('\n')
  assert.ok(view.includes('0 human skills'), `skill count missing:\n${view}`)
  assert.ok(view.includes('preset exploded'), `degradation notice missing:\n${view}`)
  assert.deepEqual(t.refreshes[0]?.target, { kind: 'preset', presetId: 'ptc' })
  t.app.stop()
})

test('/reload with a live agent refreshes the AGENT target, never the standing path', async () => {
  const t = setup({
    agent: fakeAgent('s1', []),
    refreshCatalog: async () => ({
      kind: 'applied',
      snapshot: Object.freeze({
        commands: Object.freeze([Object.freeze({ name: 'builtin', description: 'b' })]),
        scopedCommands: Object.freeze([]),
        skills: Object.freeze([]),
        issues: Object.freeze([]),
      }),
    }),
  })
  await t.runCommand('reload')
  assert.equal(t.refreshes.length, 1)
  assert.equal(t.refreshes[0]?.target.kind, 'agent', 'a live session must refresh the agent target')
  t.app.stop()
})

test('/keybindings reload re-reads the settings document LAZILY (the explicit reload seam, no watch)', async () => {
  // Server/client migration boundary (review finding): the keybinding
  // reload is EXPLICIT — /keybindings reload calls `settings.get()` at
  // reload time and rebuilds the keymap. There is deliberately NO settings
  // `watch` callback: the TuiSettingsConfig port is get/replace only, and
  // a callback could not cross the process boundary in the future Remote
  // adapter. This test proves the command reads the CURRENT document at
  // reload time (a stale cached parse would miss a later settings edit).
  let settingsDoc = {
    theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue',
    localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1',
    iconStyle: 'emoji', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto',
    keybindings: { 'app.input.steer': 'ctrl+x' },
  }
  let reads = 0
  const tuiSettings: TuiSettingsLike = {
    // get/replace ONLY — no watch on the port (the structural type
    // enforces it: a watch method would not exist on TuiSettingsLike).
    get: () => { reads += 1; return settingsDoc },
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  // The runner applies the startup configuration ONCE at mount (this
  // command-surface harness mounts only the command layer, so apply the
  // same parse the runner's applyUserKeybindings performs).
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(tuiSettings.get().keybindings))
  const readsAfterSetup = reads
  // A later settings edit (the user changes the keybindings in the YAML);
  // the keymap must NOT change until /keybindings reload.
  settingsDoc = { ...settingsDoc, keybindings: { 'app.input.steer': 'ctrl+y' } }
  // The app's effective table still shows the startup keys (no watch).
  const before = t.app.keybindingsManager().keysFor('app.input.steer')
  assert.deepEqual(before, ['ctrl+x'], 'no watch: the keymap must keep the startup configuration until a reload')
  const result = await t.runCommand('keybindings', 'reload')
  assert.equal((result as { kind: string }).kind, 'success', 'the reload must succeed')
  assert.ok(reads > readsAfterSetup, 'the reload must re-read the settings document')
  const after = t.app.keybindingsManager().keysFor('app.input.steer')
  assert.deepEqual(after, ['ctrl+y'], 'the reload must apply the CURRENT settings document')
  t.app.stop()
})

test('/keybindings reload queues behind an editor write and applies the latest document', async () => {
  let settingsDoc: TuiSettingsLike['get'] extends () => infer T ? T : never = {
    theme: 'auto',
    footer: 'full',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    iconStyle: 'emoji',
    notificationMode: 'unfocused',
    terminalProgress: 'on', notificationMethod: 'auto',
    keybindings: { 'app.input.steer': 'ctrl+x' },
  }
  let writes = 0
  let firstWriteStarted!: () => void
  const firstStarted = new Promise<void>(resolve => { firstWriteStarted = resolve })
  let releaseFirst!: () => void
  const release = new Promise<void>(resolve => { releaseFirst = resolve })
  const tuiSettings: TuiSettingsLike = {
    get: () => settingsDoc,
    replace: async next => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted()
        await release
      }
      settingsDoc = next
    },
  }
  const t = setup({ tuiSettings })
  const manager = t.app.keybindingsManager()
  manager.setUserConfiguration(parseUserKeybindings(settingsDoc.keybindings))
  const controller = new KeybindingEditorController({ settings: tuiSettings, manager })
  try {
    const editorWrite = controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    await firstStarted
    let reloadSettled = false
    const reload = t.runCommand('keybindings', 'reload').then(result => {
      reloadSettled = true
      return result
    })
    await Promise.resolve()
    assert.equal(reloadSettled, false, 'reload must wait for the in-flight whole-document write')
    releaseFirst()
    const [editorResult, reloadResult] = await Promise.all([editorWrite, reload])
    assert.equal(editorResult.kind, 'applied')
    assert.equal((reloadResult as { kind: string }).kind, 'success')
    assert.equal(writes, 1)
    assert.deepEqual(settingsDoc.keybindings, {
      'app.input.steer': 'ctrl+x',
      'app.todo.toggle': ['ctrl+t', 'ctrl+y'],
    })
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t', 'ctrl+y'])
  } finally {
    releaseFirst()
    t.app.stop()
    manager.dispose()
  }
})

test('/keybindings reset queues behind an editor write and keeps the final reset authoritative', async () => {
  let settingsDoc: TuiSettingsLike['get'] extends () => infer T ? T : never = {
    theme: 'auto',
    footer: 'full',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'viewport',
    wheelScrollLines: '1',
    iconStyle: 'emoji',
    notificationMode: 'unfocused',
    terminalProgress: 'on', notificationMethod: 'auto',
    keybindings: undefined,
  }
  let writes = 0
  let firstWriteStarted!: () => void
  const firstStarted = new Promise<void>(resolve => { firstWriteStarted = resolve })
  let releaseFirst!: () => void
  const release = new Promise<void>(resolve => { releaseFirst = resolve })
  const tuiSettings: TuiSettingsLike = {
    get: () => settingsDoc,
    replace: async next => {
      writes += 1
      if (writes === 1) {
        firstWriteStarted()
        await release
      }
      settingsDoc = next
    },
  }
  const t = setup({ tuiSettings })
  const manager = t.app.keybindingsManager()
  manager.setUserConfiguration(parseUserKeybindings(settingsDoc.keybindings))
  const controller = new KeybindingEditorController({ settings: tuiSettings, manager })
  try {
    const editorWrite = controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    await firstStarted
    const reset = t.runCommand('keybindings', 'reset')
    releaseFirst()
    const [editorResult, resetResult] = await Promise.all([editorWrite, reset])
    assert.equal(editorResult.kind, 'applied')
    assert.equal((resetResult as { kind: string }).kind, 'success')
    assert.equal('keybindings' in settingsDoc, false)
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t'])
    assert.equal(writes, 2)
  } finally {
    releaseFirst()
    t.app.stop()
    manager.dispose()
  }
})

test('/keybindings reset awaits the settings write, applies the cleared config, and reports its real outcome', async () => {
  // Review finding: the reset must not report success before the async
  // persistence write resolves — a failed write is an error result.
  // Review round 28: with the automatic settings watch removed (the reload
  // seam is explicit), a reset that only persisted would leave the RUNNING
  // keymap with the old overrides — the reset must also REBUILD from the
  // now-keybindings-less document.
  let replaced = 0
  const failing: TuiSettingsLike = {
    get: () => ({ theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', iconStyle: 'emoji', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto', keybindings: { 'app.input.steer': 'ctrl+x' } }),
    replace: async () => { replaced += 1; throw new Error('write refused') },
  }
  let t = setup({ tuiSettings: failing })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(failing.get().keybindings))
  const failed = await t.runCommand('keybindings', 'reset')
  assert.equal((failed as { kind: string }).kind, 'error', 'a failed write must report an error result')
  assert.ok((failed as { text: string }).text.includes('failed'), `error text missing: ${JSON.stringify(failed)}`)
  assert.equal(replaced, 1, 'the write must be attempted')
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'a failed reset must keep the running keymap')
  t.app.dispose()

  let okReplaced = 0
  // Round 35: the success fixture is the reviewer's regression shape — the
  // storage may NOT be re-read after a successful write (a post-write read
  // could fail: disk reset + runtime "reset failed" fork). `get()` throws
  // on ANY read after the FIRST, so a post-write second read would fail
  // the test; the reset must project the cleared state locally from the
  // doc it already holds (`keybindings` deleted above) — write + local
  // projection, never GET → PUT → GET (the future Remote adapter
  // contract too). The counter is armed right before the command so the
  // harness's own setup reads do not trip it.
  let okReads = 0
  const ok: TuiSettingsLike = {
    get: () => {
      okReads += 1
      if (okReads > 1) throw new Error('no second read allowed')
      return { theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', iconStyle: 'emoji', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto', keybindings: { 'app.input.steer': 'ctrl+x' } }
    },
    replace: async () => { okReplaced += 1 },
  }
  t = setup({ tuiSettings: ok })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(ok.get().keybindings))
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'the pre-reset keymap must carry the override')
  okReads = 0
  const succeeded = await t.runCommand('keybindings', 'reset')
  assert.equal((succeeded as { kind: string }).kind, 'success', 'a resolved write must report success')
  assert.equal(okReplaced, 1)
  assert.equal(okReads, 1, 'the reset must read the settings document exactly ONCE (no post-write read)')
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+s'], 'the reset must REBUILD the running keymap from the cleared document (defaults)')
  t.app.dispose()

  // Round 30: a throwing FIRST read must not escape the handler either —
  // the reset reports an error and the running keymap stays untouched.
  let readsFailing = 0
  const throwingRead: TuiSettingsLike = {
    get: () => { readsFailing += 1; throw new Error('settings read exploded') },
    replace: async () => {},
  }
  t = setup({ tuiSettings: throwingRead })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings({ 'app.input.steer': 'ctrl+x' }))
  const readFailed = await t.runCommand('keybindings', 'reset')
  assert.equal((readFailed as { kind: string }).kind, 'error', 'a throwing first read must report an error result')
  assert.ok((readFailed as { text: string }).text.includes('failed'), `error text missing: ${JSON.stringify(readFailed)}`)
  assert.equal(readsFailing, 1, 'the initial read must be attempted once')
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'a failed reset must keep the running keymap')
  t.app.stop()
})

test('/keybindings reports the real unreadable-settings failure and never leaves a dead Settings lease', async () => {
  let reads = 0
  const tuiSettings: TuiSettingsLike = {
    get: () => {
      reads += 1
      throw new Error('settings read exploded')
    },
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  try {
    // The TYPED deeplink preflights the document: an unreadable one is a real
    // command error (no fake page, no legacy overlay), and no lease is taken.
    const result = await t.runCommand('keybindings')
    assert.equal((result as { kind: string }).kind, 'error')
    assert.match((result as { text: string }).text, /could not open keyboard shortcuts: settings read exploded/u)
    await t.vt.waitForRender()
    const view = await t.view()
    assert.doesNotMatch(view, /Settings ·/u, 'no Settings chrome is left behind on a refused deeplink')
    assert.match(view, /❯/u, 'the editor seat still owns the surface')
    assert.ok(reads >= 1, 'the guarded preflight read really happened')
  } finally {
    t.app.stop()
  }
})

test('/keybindings reload is fail-soft: a throwing settings read keeps the last-known-good keymap', async () => {
  // Review round 28: reload is now the ONLY reload seam, so its fail-soft
  // contract must match the startup application — a transient `get()`
  // failure must not throw out of the handler; the keymap keeps its
  // last-known-good configuration and the command reports an error.
  let failing = false
  const tuiSettings: TuiSettingsLike = {
    get: () => {
      if (failing) throw new Error('settings read exploded')
      return { theme: 'auto', footer: 'full', fullscreen: 'off', busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'viewport', wheelScrollLines: '1', iconStyle: 'emoji', notificationMode: 'unfocused', terminalProgress: 'on', notificationMethod: 'auto', keybindings: { 'app.input.steer': 'ctrl+x' } }
    },
    replace: async () => {},
  }
  const t = setup({ tuiSettings })
  t.app.keybindingsManager().setUserConfiguration(parseUserKeybindings(tuiSettings.get().keybindings))
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'startup configuration')
  failing = true
  const result = await t.runCommand('keybindings', 'reload')
  assert.equal((result as { kind: string }).kind, 'error', 'a throwing settings read must report an error result')
  assert.ok((result as { text: string }).text.includes('failed'), `error text missing: ${JSON.stringify(result)}`)
  assert.deepEqual(t.app.keybindingsManager().keysFor('app.input.steer'), ['ctrl+x'], 'the keymap must keep the last-known-good configuration')
  t.app.stop()
})

test('/keybindings reload refuses an absent settings service (no false "reloaded" success)', async () => {
  // Review round 35 P3: without the settings backend, reload must NOT
  // misrepresent "reading the defaults" as a success — it mirrors
  // /keybindings reset's explicit refusal, so a degraded / Remote
  // backend cannot claim a successful defaults read.
  const t = setup({ tuiSettings: undefined })
  const result = await t.runCommand('keybindings', 'reload')
  assert.equal((result as { kind: string }).kind, 'error', 'an absent settings service must report an error result')
  assert.ok((result as { text: string }).text.includes('unavailable'), `error text missing: ${JSON.stringify(result)}`)
  t.app.stop()
})

test('/preset <id> surfaces an indeterminate switch without retrying', async () => {
  const t = setup({ agent: fakeAgent('s1', []), selectFailure: new Error('append exploded after recompose') })
  const result = await t.run('minimal') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /append exploded after recompose/)
  assert.match(result.text, /do not retry/)
  assert.deepEqual(t.presets.selected, [], 'an ambiguous switch is never retried')
  t.app.stop()
})

/* ── PR5 Slice B: /preset <id> through the OUTER command-settlement owner ──
 * The two cases below are ONE semantic family. The handler's draft disposition
 * is what the outer owner reads; a future "always suppress preset failures"
 * regression must break the known-rejection case, and a future "always
 * restore" regression must break the indeterminate case. */

/** Drive the REAL `/preset` handler through the REAL outer command-settlement
 *  owner (`executeHostCommandSubmission`) with a scripted preset port. */
async function settlePresetThroughOuterOwner(
  outcome: Awaited<ReturnType<PresetCatalog['selectSessionPreset']>>['outcome'],
): Promise<{
  readonly restored: readonly string[]
  readonly fallbacks: number
  readonly draft: string
  readonly handlerText: string
  readonly selects: number
  readonly statusText: string
  readonly view: string
  /** The runner's run-local pending preset AFTER the settlement. */
  readonly pendingPreset: string | undefined
}> {
  const commandId = 'cmd-preset-exec'
  const selects: unknown[] = []
  // The authoritative displayed/current preset baseline the command reads
  // (`/preset status`, the picker's "[current]" state chip). It must never become the
  // requested alternate on a refused or indeterminate switch.
  const displayed = { preset: 'standard' as string | undefined }
  const t = setup({
    agent: fakeAgent('s1', []),
    width: 200,
    currentPreset: () => displayed.preset,
    presetsPort: {
      available: () => true,
      roster: async () => ({ presets: [{ id: 'standard' }, { id: 'alternate' }], defaultId: 'standard' }),
      resolve: async (id?: string) => ({ id: id ?? 'standard' }),
      defaultId: () => 'standard',
      selectSessionPreset: async (sessionId, presetId) => {
        selects.push({ sessionId, presetId })
        return { ownership: 'current', outcome }
      },
    },
  })
  const restored: string[] = []
  const acks: string[] = []
  let fallbacks = 0
  let handlerText = ''
  let settled!: () => void
  const done = new Promise<void>(resolve => { settled = resolve })
  const deps = {
    isDisposed: () => false,
    notify: () => {},
    loggerError: () => {},
    readDraft: () => t.app.getDraft(),
    mergeDraftIntoEditor: (value: string) => {
      const merged = mergeDraft(t.app.getDraft(), value)
      t.app.setEditorText(merged)
      return merged === value
    },
    restoreSubmissionDraft: (value: string) => {
      restored.push(value)
      t.app.setEditorText(mergeDraft(t.app.getDraft(), value))
    },
    consumeDraftAttachments: () => {},
    draftHasAttachments: () => false,
    pinDraftAttachments: () => () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: (reason: string) => { acks.push(reason); settled() },
    notifySubmissionFailure: () => {},
    isScopeCurrent: () => true,
    refuseByTransitionFence: () => {},
    lateAttachmentRefusal: () => undefined,
    isTuiOwnedCommand: () => false,
    commandPlaneOwnsLine: () => false,
    beginNavigationIntent: () => undefined,
    submittedHostClaim: () => undefined,
    commandSignal: () => new AbortController().signal,
    invokeCommandPlane: async () => {
      const handlerResult = await t.invokeCommand('preset', commandId, 'alternate') as { kind: string; text?: string }
      handlerText = handlerResult.text ?? ''
      return {
        kind: 'committed' as const,
        matched: true,
        execution: { commandId, result: { kind: handlerResult.kind, text: handlerResult.text } },
      }
    },
    beginCommandSettlement: () => {},
    abortCommandSettlement: () => {},
    settleCommandSettlement: () => {},
    trackSettlementWork: () => {},
    captureCommandHealthRef: () => undefined,
    clearCommandHealthError: () => {},
    recordCommandHealthError: () => {},
    readCommandDraftDisposition: (id?: string) => t.surface.takeCommandDraftDisposition(id),
    shouldConsumeAdvertisedMiss: () => false,
    isIndeterminateSkillWrite: () => false,
    startArtifactSave: () => {},
    submitPrompt: async () => { fallbacks += 1 },
    commandSessionId: () => 's1',
    markTurnTransferred: () => {},
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }
  // The submit gesture cleared the editor before the command was dispatched.
  t.app.setEditorText('')
  executeHostCommandSubmission(deps as unknown as HostCommandSubmissionDeps, {
    text: '/preset alternate',
    toggled: '/preset alternate',
    scope: { sessionId: 's1' } as never,
    submitRequestId: 'req-preset',
    submitAckToken: 3,
    generation: 0,
    localEchoInstalled: true,
    wasAdvertisedAtSubmit: false,
    parsedName: 'preset',
    submitTurn: { wait: Promise.resolve(), release: () => {} },
    preparedCommandAttachments: { segments: [] },
  })
  await done
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(acks.length, 1, 'the gesture settled exactly once')
  // Read the displayed/current preset through the REAL `/preset status`
  // handler (the production consumer of `runner.currentPreset()`), NOT by
  // echoing the fixture's own baseline back: an optimistic local preset write
  // would show up in this result text.
  const status = await t.runCommand('preset', 'status') as { readonly kind: string; readonly text?: string }
  assert.equal(status.kind, 'success', 'the /preset status read must succeed')
  return {
    restored,
    fallbacks,
    draft: t.app.getDraft(),
    handlerText,
    selects: selects.length,
    statusText: status.text ?? '',
    view: await t.view(),
    pendingPreset: t.pending.value,
  }
}

test('a TRUE indeterminate /preset <id> does not restore the typed command at the outer settlement owner', async () => {
  const result = await settlePresetThroughOuterOwner({
    kind: 'indeterminate',
    error: { code: 'agent-preset/select-indeterminate', message: 'recompose ran but the durable append failed' },
  })
  assert.deepEqual(result.restored, [], 'an indeterminate switch must never restore a retry-ready command')
  assert.equal(result.draft, '', 'the editor does not regain /preset <id>')
  assert.equal(result.fallbacks, 0, 'no agent-facing fallback prompt is launched')
  assert.equal(result.selects, 1, 'the switch dispatched exactly once (no implicit retry)')
  assert.match(result.view, /do not retry/)
  // AC4: the displayed/current preset the REAL `/preset status` handler reports
  // (the production consumer of the runner's current-preset read) is still the
  // authoritative Session value, and no run-local retry-ready preset intent is
  // staged.
  assert.match(result.statusText, /preset: standard/u,
    'an indeterminate switch must leave the handler-reported current preset unchanged')
  assert.ok(!result.statusText.includes('alternate'),
    'the requested alternate preset must never become the reported current preset')
  assert.equal(result.pendingPreset, undefined,
    'an indeterminate switch must not stage a run-local pending preset')
})

test('a KNOWN writer-held /preset <id> rejection restores the typed command at the outer settlement owner', async () => {
  const result = await settlePresetThroughOuterOwner({
    kind: 'rejected',
    error: { code: 'session/writer-held', message: SESSION_WRITER_HELD_GUIDANCE, details: { sessionId: 's1' } },
  })
  assert.deepEqual(result.restored, ['/preset alternate'], 'a known rejection restores the complete typed command')
  assert.equal(result.draft, '/preset alternate', 'the editor regains the command for manual recovery')
  assert.equal(result.fallbacks, 0, 'a restored command is never additionally submitted as a prompt')
  assert.equal(result.selects, 1, 'the refused switch is not retried')
  assert.match(result.view, /already in use/, 'the centralized writer-held guidance is rendered')
  // AC4 negative control: the same family also proves a KNOWN rejection leaves
  // the handler-reported current preset exactly where it was.
  assert.match(result.statusText, /preset: standard/u,
    'a refused switch must leave the handler-reported current preset unchanged')
  assert.ok(!result.statusText.includes('alternate'),
    'the requested alternate preset must never become the reported current preset')
  assert.equal(result.pendingPreset, undefined,
    'a refused switch must not stage a run-local pending preset')
})

test('/preset commits a Host-blank selection even when the transcript has a turn', async () => {
  // The fake Host select is authoritative (selectLocked: false) while the fake
  // transcript still has a turn/start: the command must open the roster AND
  // commit the switch, proving it never folds the transcript itself.
  const t = setup({ agent: fakeAgent('s1', [{ type: 'turn/start' }]), sessionBlank: true, selectLocked: false })
  const opened = await t.run('') as { kind: string }
  assert.equal(opened.kind, 'success')
  const view = await t.view()
  assert.ok(view.includes('Standard mode (standard)'), 'the Host turn-boundary authority wins over the transcript')
  t.vt.sendInput('\r') // Enter opens the read-only Details
  await t.view()
  assert.deepEqual(t.presets.selected, [], 'reading Details never writes')
  t.vt.sendInput('\x1b') // back to the Catalog
  await t.view()
  t.vt.sendInput('\t') // the explicit Use session action
  await t.view()
  t.vt.sendInput('\r')
  await t.view()
  assert.deepEqual(t.presets.selected, ['standard'],
    'the Host blank selection commits despite the transcript turn')
  t.app.stop()
})

test('/preset supersedes (never error-notifies) a switch whose Session was replaced during the catalog refresh', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  const t = setup({
    state,
    sessionBlank: true,
    selectLocked: false,
    refreshCatalog: async () => {
      // A transition lands while the refresh is in flight.
      state.generation = 2
      state.agent = fakeAgent('s2', [])
      return { kind: 'failed', error: 'superseded by a switch' }
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  // v2 §0.2.1/§0.3.3: the committed switch lost local ownership — the surface
  // moved, so superseded is SILENT (no notice, no success text).
  assert.equal(result.kind, 'success')
  assert.equal(result.text, undefined)
  assert.deepEqual(t.presets.selected, ['minimal'],
    'the Host switch itself committed before the surface moved')
  t.app.stop()
})

test('/preset refuses an EMPTY transcript when the Host turn boundary says started', async () => {
  const t = setup({ agent: fakeAgent('s1', []), sessionBlank: false })
  const result = await t.run('') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /only available in a new session/)
  const view = await t.view()
  assert.ok(!view.includes('Standard mode (standard)'), 'no roster is offered for a Host-started Session')
  t.app.stop()
})

test('a newer preset pick supersedes an older pick on the same Session generation', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  let secondStarted = false
  const holder: { run?: (rawInput: string) => Promise<unknown> } = {}
  const t = setup({
    state,
    sessionBlank: true,
    selectLocked: false,
    refreshCatalog: async () => {
      if (!secondStarted) {
        secondStarted = true
        // A newer pick starts while the older refresh is in flight.
        await holder.run!('minimal')
      }
      return { kind: 'superseded', error: 'a newer refresh started' }
    },
  })
  holder.run = t.run
  const first = await t.run('standard') as { kind: string; text?: string }
  assert.equal(first.kind, 'success')
  assert.equal(first.text, undefined, 'a superseded pick is silent (no success text)')
  t.app.stop()
})

test('a newer sessionless preset pick supersedes an older one', async () => {
  let secondStarted = false
  const holder: { run?: (rawInput: string) => Promise<unknown> } = {}
  const t = setup({
    refreshCatalog: async () => {
      if (!secondStarted) {
        secondStarted = true
        // A newer sessionless pick starts while the older refresh is in flight.
        await holder.run!('minimal')
      }
      return { kind: 'applied', snapshot: {} as never }
    },
  })
  holder.run = t.run
  const first = await t.run('standard') as { kind: string; text?: string }
  assert.equal(first.kind, 'success')
  assert.equal(first.text, undefined, 'a superseded sessionless pick is silent')
  assert.equal(t.pending.value, 'minimal', 'the newest sessionless pick is the effective pending preset')
  t.app.stop()
})

test('an older /preset superseded during its registry resolve is silent', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const t = setup({
    resolve: async (id?: string) => {
      calls += 1
      if (calls === 1) await gate
      return { id: id ?? 'standard' }
    },
  })
  const first = t.run('minimal') as Promise<{ kind: string; text?: string }>
  await new Promise(resolve => setImmediate(resolve))
  const second = t.run('standard') as Promise<{ kind: string; text?: string }>
  const newer = await second
  release()
  const older = await first
  // The older op lost ownership while its resolve was in flight: it must be
  // UI-silent and must not stage its preset (§0.2.5/§0.3.3).
  assert.equal(older.kind, 'success')
  assert.equal(older.text, undefined, 'a superseded op must not emit a stale notice')
  assert.equal(newer.kind, 'success')
  assert.equal(t.pending.value, 'standard', 'only the newest op stages its preset')
  t.app.stop()
})

test('a superseded picker roster read keeps the picker silent while the typed verb never reads the roster', async () => {
  const { SupersededReadError } = await import('../../src/runtime/read-error.ts')
  let rosterReads = 0
  const t = setup({ roster: async () => { rosterReads += 1; throw new SupersededReadError('connection changed') } })
  // rc.2: the typed verb resolves through the official registry, never the
  // chooser roster, so a superseded roster cannot affect it.
  const verbResult = await t.run('minimal') as { kind: string; text?: string }
  assert.deepEqual(verbResult, { kind: 'success', text: 'new sessions will start on preset minimal' })
  assert.equal(rosterReads, 0, 'the typed verb path must not read the policy roster')
  // The picker does read the roster; a superseded read must stay silent.
  const pickerResult = await t.run('') as { kind: string; text?: string }
  assert.equal(pickerResult.kind, 'success')
  const view = await t.view()
  assert.ok(!view.includes('connection changed'), `no stale roster notice:\n${view}`)
  t.app.stop()
})

test('an older /preset whose Session generation moved during its resolve is silent', async () => {
  const state = { agent: undefined as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({
    state,
    resolve: async (id?: string) => {
      // A /new/switch lands while the registry resolve is in flight, and a new
      // blank Agent appears: the old sessionless operation must NOT apply to it.
      state.generation = 2
      state.agent = fakeAgent('s2', [])
      return { id: id ?? 'standard' }
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, undefined, 'a generation-moved op is silent')
  assert.deepEqual(t.presets.selected, [], 'the stale op must not apply its preset to the new Session')
  assert.equal(t.pending.value, undefined, 'no sessionless intent is staged onto the moved surface')
  t.app.stop()
})

test('a /preset picker opened on S1 cannot switch S2 after a session switch (subject fence)', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  const t = setup({ state, sessionBlank: true })
  await t.run('') // open the picker on S1
  await t.vt.waitForRender()
  // Prove the overlay actually opened (not a vacuous early return).
  assert.match(t.vt.getViewport().join('\n'), /standard/i, 'the preset picker must open before the switch')
  // A Session switch lands AFTER the overlay opened.
  state.agent = fakeAgent('s2', [])
  state.generation = 2
  t.vt.sendInput('\t') // reach the actions zone on the STALE overlay
  t.vt.sendInput('\r') // the explicit Use session action
  await t.vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(t.presets.selected, [], 'a stale preset picker must not switch the new Session')
  assert.ok(!t.vt.getViewport().join('\n').includes('Standard mode (standard)'),
    `the superseded panel must retire:\n${t.vt.getViewport().join('\n')}`)
  t.app.stop()
})

test('a sessionless /preset picker cannot switch a Session that appeared in the same generation', async () => {
  const state = { agent: undefined as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({ state })
  await t.run('') // sessionless picker (owner sessionId === undefined)
  await t.vt.waitForRender()
  assert.match(t.vt.getViewport().join('\n'), /standard/i, 'the sessionless preset picker must open before the create')
  // A first create publishes a live Agent BEFORE the generation bump.
  state.agent = fakeAgent('s1', [])
  t.vt.sendInput('\t')
  t.vt.sendInput('\r')
  await t.vt.waitForRender()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(t.presets.selected, [], 'a stale sessionless picker must not switch the new live Session')
  t.app.stop()
})

test('typed /preset whose subject drifts during resolve() is superseded', async () => {
  const state = { agent: undefined as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({
    state,
    resolve: async (id?: string) => {
      state.agent = fakeAgent('s2', [])
      return { id: id ?? 'standard', trust: 'system', path: `/presets/${id ?? 'standard'}` }
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'success')
  assert.equal(result.text, undefined)
  assert.deepEqual(t.presets.selected, [], 'a subject that drifts during resolve must not stage or switch')
  assert.equal(t.pending.value, undefined)
  t.app.stop()
})

test('a /preset whose subject moves during the Host switch stays silent (transition-await fence)', async () => {
  const state = { agent: fakeAgent('s1', []), generation: 1 }
  const t = setup({
    state,
    selectLocked: true,
    selectHook: () => {
      // The subject moves to another Session in the SAME generation while the
      // official Host switch is in flight; the switch then refuses (locked).
      state.agent = fakeAgent('s2', [])
    },
  })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'success', 'a drifted subject must not surface the stale lock rejection')
  assert.equal(result.text, undefined, 'a drifted subject is silent')
  assert.deepEqual(t.presets.selected, [], 'the Host refusal never committed')
  assert.ok(!t.vt.getViewport().join('\n').includes('locked'), 'no stale lock notice is rendered')
  t.app.stop()
})

test('a /preset picker whose Session identity drifts during the roster read never opens', async () => {
  const state = { agent: fakeAgent('s1', []) as ReturnType<typeof fakeAgent> | undefined, generation: 1 }
  const t = setup({
    state,
    sessionBlank: true,
    roster: async () => {
      // The subject moves to another Session in the SAME generation while the
      // roster read is in flight.
      state.agent = fakeAgent('s2', [])
      return {
        presets: SHIPPED_ROWS.map(row => ({ id: row.id, isDefault: row.id === 'standard' })),
      }
    },
  })
  await t.run('')
  await t.vt.waitForRender()
  assert.ok(!t.vt.getViewport().join('\n').includes('standard'),
    'the stale picker must never open on the newly appeared Session')
  t.app.stop()
})

// ── preset-selection presentation (rc.2 roster shape) ──
//
// rc.2 retired the `modeSelectionEnabled` chooser policy: `/preset` is a
// normal TUI command, advertised whenever the command catalog is healthy and
// refused only by the official registry at execution time. These regressions
// pin that the presentation no longer depends on a deployment policy flag.

/**
 * Wait for the command-completion projection to carry `name`.
 *
 * `installSnapshot` commits the catalog, but the COMPLETION projection onto the
 * composer is a separate asynchronous install; waiting for the candidate itself
 * is the fact every caller below asserts.
 */
async function waitForCompletion(app: { commandCompletionsForTest(): readonly { name: string }[] }, name: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (app.commandCompletionsForTest().some(command => command.name === name)) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`the completion projection never carried /${name}`)
}

const EMPTY_SURFACE_SNAPSHOT = Object.freeze({
  commands: Object.freeze([]),
  scopedCommands: Object.freeze([]),
  skills: Object.freeze([]),
  issues: Object.freeze([]),
}) as never

test('/preset stays advertised when the command catalog is healthy (no chooser policy)', async () => {
  const t = setup({ commandsListRegistered: true, height: 80 })
  t.surface.installSnapshot(EMPTY_SURFACE_SNAPSHOT)
  // The completion projection is installed asynchronously after the snapshot
  // commits: wait for the CANDIDATE itself (the fact the assertion is about),
  // not for a 20ms window in which it may or may not have landed.
  await waitForCompletion(t.app, 'preset')
  assert.ok(t.app.commandCompletionsForTest().some(command => command.name === 'preset'),
    '/preset must be a normal candidate without any roster policy')
  t.app.stop()
})

test('a rosterless deployment keeps /preset visible and refuses at execution', async () => {
  const t = setup({ commandsListRegistered: true, noPresets: true })
  t.surface.installSnapshot(EMPTY_SURFACE_SNAPSHOT)
  await waitForCompletion(t.app, 'preset')
  assert.ok(t.app.commandCompletionsForTest().some(command => command.name === 'preset'),
    'an unavailable roster must not hide the command')
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /agent presets unavailable/)
  t.app.stop()
})

test('a sessionless /preset stages the next preset without reading a policy roster', async () => {
  let rosterReads = 0
  const t = setup({ roster: async () => { rosterReads += 1; throw new Error('no policy roster read') } })
  const result = await t.run('minimal') as { kind: string; text?: string }
  assert.deepEqual(result, { kind: 'success', text: 'new sessions will start on preset minimal' })
  assert.equal(t.pending.value, 'minimal')
  assert.equal(rosterReads, 0, 'the sessionless selection must not read a chooser-policy roster')
  t.app.stop()
})

test('the navigation intent starts only for the final TUI-owned route and never on an early refusal', async () => {
  // A genuine Host-owned `/new` must not register a TUI navigation intent, and
  // the late attachment refusal (a post-admission refusal before the executor
  // runs) must return without ever registering one: a leaked intent would keep
  // `SessionTransitionGate.pending` true forever.
  const run = async (options: {
    lateRefusal?: string
    commandPlaneLine: boolean
    tuiOwnedCommand: boolean
  }): Promise<string[]> => {
    const events: string[] = []
    let acked!: () => void
    const ack = new Promise<void>(resolve => { acked = resolve })
    const deps = {
      isDisposed: () => false,
      notify: () => {},
      loggerError: () => {},
      readDraft: () => '',
      mergeDraftIntoEditor: () => true,
      restoreSubmissionDraft: () => {},
      consumeDraftAttachments: () => {},
      draftHasAttachments: () => options.lateRefusal !== undefined,
      pinDraftAttachments: () => () => {},
      settleLocalSubmission: () => {},
      settleSubmitAck: () => { acked() },
      notifySubmissionFailure: () => {},
      isScopeCurrent: () => true,
      refuseByTransitionFence: () => {},
      lateAttachmentRefusal: () => options.lateRefusal,
        commandPlaneOwnsLine: () => options.commandPlaneLine,
      isTuiOwnedCommand: () => options.tuiOwnedCommand,
      beginNavigationIntent: (name: string | undefined) => {
        events.push(`begin:${String(name)}`)
        return () => { events.push(`finish:${String(name)}`) }
      },
      submittedHostClaim: () => undefined,
      commandSignal: () => new AbortController().signal,
      invokeCommandPlane: async () => {
        events.push('invoke')
        return {
          kind: 'committed' as const,
          matched: true,
          execution: { commandId: 'cmd-navigation-intent', result: { kind: 'success' } },
        }
      },
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
      captureCommandHealthRef: () => undefined,
      clearCommandHealthError: () => {},
      recordCommandHealthError: () => {},
      readCommandDraftDisposition: () => undefined,
      shouldConsumeAdvertisedMiss: () => false,
      isIndeterminateSkillWrite: () => false,
      startArtifactSave: () => {},
      submitPrompt: async () => {},
      commandSessionId: () => 's1',
      markTurnTransferred: () => {},
      diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    }
    executeHostCommandSubmission(deps as unknown as HostCommandSubmissionDeps, {
      text: '/new',
      toggled: '/new',
      scope: { sessionId: 's1' } as never,
      submitRequestId: 'req-navigation-intent',
      submitAckToken: 1,
      generation: 0,
      localEchoInstalled: false,
      wasAdvertisedAtSubmit: false,
      parsedName: 'new',
      submitTurn: { wait: Promise.resolve(), release: () => {} },
      preparedCommandAttachments: { segments: [] },
    })
    await ack
    await new Promise(resolve => setImmediate(resolve))
    return events
  }

  assert.deepEqual(
    await run({ lateRefusal: 'commands do not accept attachments', commandPlaneLine: true, tuiOwnedCommand: true }),
    [],
    'the late attachment refusal must return without registering an intent or invoking the plane',
  )
  assert.deepEqual(
    await run({ commandPlaneLine: true, tuiOwnedCommand: false }),
    ['invoke'],
    'a genuine Host-owned /new must execute without a TUI navigation intent',
  )
  assert.deepEqual(
    await run({ commandPlaneLine: true, tuiOwnedCommand: true }),
    ['begin:new', 'invoke', 'finish:new'],
    'the TUI-owned /new route registers one intent and finishes it at the terminal sink',
  )
})


test('a newer /preset started inside the mount window owns the command slot', async () => {
  let secondRun: Promise<unknown> | undefined
  let invokeSecond: (() => void) | undefined
  const opened: Array<{
    loading: number
    rosters: number
    closed: number
    request: import('../../src/app/command/preset-presentation.ts').PresetPickerRequest
    handle: PresetPickerHandle
  }> = []
  let calls = 0
  const presentation: PresetPresentation = {
    notify: () => {},
    open: (request) => {
      calls += 1
      if (calls === 1) invokeSecond!()
      const record = { loading: 0, rosters: 0, closed: 0, request, handle: undefined as unknown as PresetPickerHandle }
      const handle: PresetPickerHandle = {
        setLoading: () => { record.loading += 1 },
        setRoster: () => { record.rosters += 1 },
        setLoadError: () => {},
        isDisposed: () => record.closed > 0,
        close: () => { record.closed += 1 },
      }
      record.handle = handle
      opened.push(record)
      return handle
    },
  }
  const t = await setup({ presetPresentation: presentation })
  invokeSecond = () => { secondRun = t.run('') }
  const first = await t.run('')
  await secondRun
  await waitFor(async () => opened.some(o => o.rosters === 1))

  assert.equal(opened.length, 2, 'both invocations reached their own presentation')
  assert.deepEqual(first, { kind: 'success' })
  const live = opened.filter(o => o.request.isCurrent())
  assert.equal(live.length, 1, 'exactly ONE invocation owns the command surface')
  const stale = opened.find(o => !o.request.isCurrent())!
  assert.ok(stale !== undefined)
  assert.equal(stale.loading, 0, 'the superseded invocation never starts its read')
  assert.equal(stale.rosters, 0)
  assert.equal(stale.closed, 1, 'the stale mount is released exactly once')
  assert.equal(live[0]!.loading, 1, 'the newer invocation enters Loading through its own owner')
  assert.equal(live[0]!.rosters, 1, 'the newer invocation hydrates the surface')
  assert.equal(live[0]!.closed, 0, 'the newer mount stays the live owner')
  t.app.dispose()
})

/* ------------------------------- shared Set default: Config + blank sync */

test('typed /preset default saves Config and switches the captured blank session once', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }) },
    },
  })
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }])
  assert.deepEqual(t.presets.selected, ['minimal'], 'the exact captured blank session switched once')
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'default preset set: minimal; current blank session switched to minimal')
  assert.equal(t.pending.value, undefined, 'a live session default never stages the sessionless pending')
  t.app.dispose()
})

test('typed /preset default never claims a host-thrown blank-session sync did not switch', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    selectFailure: new Error('host refused the blank-session sync'),
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }) },
    },
  })
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }])
  assert.deepEqual(t.presets.selected, [], 'the sync rejection never switches the session')
  assert.equal(result.kind, 'success', 'the Config save remains confirmed')
  assert.match(result.text, /the current blank session switch is uncertain \(it may have committed\): host refused the blank-session sync — do not retry/u)
  assert.ok(!/was not switched/iu.test(result.text), 'an ambiguous Host failure must not be reported as proven no-switch')
  t.app.dispose()
})

test('sessionless Set default keeps the run-local pending override and never creates a Session', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }) },
    },
  })
  await t.run('ptc')
  assert.equal(t.pending.value, 'ptc')
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.equal(t.pending.value, 'ptc', 'the default save never rewrites the run-local pending preset')
  assert.deepEqual(t.presets.selected, [], 'sessionless default sync writes no Host session')
  assert.deepEqual(t.ensureCalls, [], 'no Session is created for the sync')
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }])
  assert.equal(result.text, 'default preset set: minimal')
  t.app.dispose()
})

test('a started Session saves the default without attempting a sync', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    agent: fakeAgent('s1', [{ type: 'turn/start' }]),
    sessionBlank: false,
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }) },
    },
  })
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.deepEqual(t.presets.selected, [], 'a started Session is never switched')
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }])
  assert.equal(result.text, 'default preset set: minimal')
  t.app.dispose()
})

test('a newer explicit Use wins over a Set default sync that settles later', async () => {
  let releaseSettings!: () => void
  const settingsGate = new Promise<void>((resolve) => { releaseSettings = resolve })
  let mutateStarted = false
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    settings: {
      get: () => undefined,
      mutate: async () => {
        mutateStarted = true
        await settingsGate
      },
    },
  })
  const defaultRun = t.runCommand('preset', 'default minimal') as Promise<{ kind: string; text: string }>
  await waitFor(async () => mutateStarted)
  await t.run('ptc')
  assert.deepEqual(t.presets.selected, ['ptc'], 'the newer Use switches the session first')
  releaseSettings()
  const result = await defaultRun
  assert.deepEqual(t.presets.selected, ['ptc'], 'the older default sync never overwrites the newer Use')
  assert.match(result.text, /default preset set: minimal; current session was not switched/u)
  t.app.dispose()
})

test('a confirmed default stays saved when the optional standing refresh throws', async () => {
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }) },
    },
    refreshCatalog: async (request) => {
      if (request.target.kind === 'preset') throw new Error('standing refresh exploded')
      return { kind: 'applied', snapshot: {} as never }
    },
  })
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }])
  assert.deepEqual(t.presets.selected, ['minimal'], 'the blank session sync still ran')
  assert.equal(result.kind, 'success', 'the Config save is not reclassified as unconfirmed')
  assert.match(result.text, /default preset set: minimal; current blank session switched to minimal/u)
  assert.ok(!/unconfirmed|rolled back/iu.test(result.text))
  t.app.dispose()
})

test('default sync re-reads the Host-effective default instead of projecting a stale requested id', async () => {
  const selected: string[] = []
  const port: PresetCatalog = {
    available: () => true,
    roster: async () => ({
      presets: [{ id: 'standard', isDefault: true }, { id: 'minimal' }],
      defaultId: 'standard',
    }) as never,
    resolve: async (id?: string) => ({ id: id ?? 'standard' }),
    defaultId: () => 'standard',
    selectSessionPreset: async (_sessionId, id) => {
      selected.push(id)
      return { ownership: 'current', outcome: { kind: 'committed', value: { preset: id } } } as never
    },
  }
  const mutated: { ns: string; patch: unknown[] }[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    presetsPort: port,
    settings: {
      get: () => undefined,
      mutate: async (ns, patch) => { mutated.push({ ns, patch }) },
    },
  })
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.deepEqual(mutated[0]?.patch, [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }])
  assert.deepEqual(selected, [], 'the stale requested id never reaches the Host session sink')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /default preset set: minimal; the effective default is now standard, so this session was not switched/u)
  t.app.dispose()
})

test('default sync keeps a committed switch when the post-commit catalog refresh throws', async () => {
  const selected: string[] = []
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    presetsPort: {
      available: () => true,
      roster: async () => ({ presets: [{ id: 'standard' }, { id: 'minimal', isDefault: true }], defaultId: 'minimal' }) as never,
      resolve: async (id?: string) => ({ id: id ?? 'minimal' }),
      defaultId: () => 'minimal',
      selectSessionPreset: async (_sessionId, id) => {
        selected.push(id)
        return { ownership: 'current', outcome: { kind: 'committed', value: { preset: id } } } as never
      },
    },
    settings: {
      get: () => undefined,
      mutate: async () => {},
    },
    refreshCatalog: async (request) => {
      if (request.target.kind === 'agent') throw new Error('catalog refresh exploded after commit')
      return { kind: 'applied', snapshot: {} as never }
    },
  })
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.deepEqual(selected, ['minimal'], 'the Host switch committed exactly once')
  assert.equal(result.kind, 'success', 'the confirmed Config save is not reclassified')
  assert.match(result.text, /current blank session switched to minimal, but the catalog refresh failed: catalog refresh exploded after commit/u)
  assert.ok(!/was not switched/iu.test(result.text), 'a committed post-refresh failure is not a no-switch claim')
  t.app.dispose()
})

test('explicit Use keeps the committed switch beside a post-commit catalog refresh failure', async () => {
  const t = setup({
    agent: fakeAgent('s1', []),
    presetsPort: {
      available: () => true,
      roster: async () => ({ presets: [{ id: 'standard' }, { id: 'minimal' }], defaultId: 'standard' }) as never,
      resolve: async (id?: string) => ({ id: id ?? 'standard' }),
      defaultId: () => 'standard',
      selectSessionPreset: async (_sessionId, id) => ({
        ownership: 'current',
        outcome: { kind: 'committed', value: { preset: id } },
      }) as never,
    },
    refreshCatalog: async (request) => {
      if (request.target.kind === 'agent') throw new Error('catalog refresh exploded after commit')
      return { kind: 'applied', snapshot: {} as never }
    },
  })
  const result = await t.runCommand('preset', 'minimal') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.match(result.text, /session preset switched to minimal; catalog refresh failed: catalog refresh exploded after commit/u)
  t.app.dispose()
})

test('a proven Host rejection remains a distinct not-switched sync outcome', async () => {
  const t = setup({
    agent: fakeAgent('s1', []),
    sessionBlank: true,
    presetsPort: {
      available: () => true,
      roster: async () => ({ presets: [{ id: 'standard' }, { id: 'minimal', isDefault: true }], defaultId: 'minimal' }) as never,
      resolve: async (id?: string) => ({ id: id ?? 'minimal' }),
      defaultId: () => 'minimal',
      selectSessionPreset: async () => ({
        ownership: 'current',
        outcome: { kind: 'rejected', error: { code: 'agent-preset/select-refused', message: 'the Host refused plainly' } },
      }) as never,
    },
    settings: { get: () => undefined, mutate: async () => {} },
  })
  const result = await t.runCommand('preset', 'default minimal') as { kind: string; text: string }
  assert.equal(result.kind, 'success')
  assert.match(result.text, /current blank session was not switched: the Host refused plainly/u)
  assert.ok(!/uncertain|may have committed/iu.test(result.text), 'a proven rejection must not be worded as uncertain')
  t.app.dispose()
})
