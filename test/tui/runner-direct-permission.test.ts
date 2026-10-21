/**
 * PR-A L5/L6 — the REAL Direct permission-cycle path (the Shift+Tab
 * `AbortSignal` contract).
 *
 * SOURCE → DECISION → SINK: a real `ESC [ Z` (Shift+Tab) terminal input enters
 * the mounted PiTui surface → `StatusRuntime.cyclePermission` → the
 * composition's `permissionCycle.apply` → `ConfigPort.permissions.
 * applyPermissionPreset` → the OFFICIAL rc.2 `/permission` command executor
 * (which reads `signal.aborted` BEFORE it dispatches) → the pushed
 * `permissions` projection repaints the status/footer. The `/yolo` client
 * command reaches the SAME port through the CommandSurface entry, so both
 * production call sites are exercised on their real routes.
 *
 * The signal identity is recorded on the REAL official commands service with
 * a one-to-one recorder (the unbound original is saved; every call continues
 * through `original.call(...)` and the ORIGINAL outcome is returned). Before
 * this fix the status owner passed no signal, so the official executor threw
 * `Cannot read properties of undefined (reading 'aborted')` and no
 * `command/run` / `command/done` pair could land.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 *   real Cordis+DSH commands / permission-presets service;
 *   same ConfigPort + runner composition as production;
 *   live Session/Agent; real Shift+Tab keybinding dispatch;
 *   official command/run, command/done + status projection.
 * TEST STAND-INS
 *   VirtualTerminal for physical terminal; deterministic LLM, external provider,
 *   or shell sandbox fixture only where no real execution is required.
 * DELIBERATELY ABSENT
 *   real network LLM calls, real user filesystem mutations, physical GUI.
 *
 * @module @xmoon76/dsh-pi-tui/runner-direct-permission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { TuiApp } from '../../src/tui-app.ts'
import { createDirectTspFixture, waitFor } from '../support/direct-tsp-fixture.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

interface CommandEvent {
  readonly type: string
  readonly data: unknown
}

interface AppLike {
  readonly statusStore: {
    snapshot(): { readonly access?: { readonly permissionPreset?: { readonly id?: string } } }
  }
  notify(text: string, kind?: 'info' | 'error'): void
}

/** ONE-TO-ONE recorder over the REAL official commands service. The unbound
 *  original is saved (never `.bind`), every call continues through it with the
 *  true receiver, and the ORIGINAL outcome is returned unchanged. Only the
 *  official `/permission` line is recorded: a `/yolo` dispatch is ITSELF an
 *  official command whose handler then executes `/permission`, so recording
 *  every execute call would count the outer alias as a second permission
 *  write. */
function recordCommandSignals(ctx: Context): { readonly signals: AbortSignal[]; restore(): void } {
  const commands = ctx.get('commands') as {
    execute(agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<unknown>
  }
  const original = commands.execute
  const signals: AbortSignal[] = []
  commands.execute = function recordedExecute(this: unknown, agent, line, attachments, signal) {
    if (/^\/permission\b/u.test(line)) signals.push(signal)
    return original.call(commands, agent, line, attachments, signal)
  }
  return { signals, restore: () => { commands.execute = original } }
}

/** The live Session's durable event log (the official command lifecycle rows). */
function sessionEvents(ctx: Context, sessionId: string): readonly CommandEvent[] {
  const sessions = ctx.get('sessions') as {
    get(id: unknown): { snapshotEvents(): readonly CommandEvent[] }
  }
  return sessions.get(sessionId).snapshotEvents()
}

const stripAnsi = (line: string): string => line.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, '')

test('Direct: a real Shift+Tab executes exactly ONE official /permission and the pushed projection repaints', async (t) => {
  const life = testLifecycle(t)
  // The PiTui PHYSICAL terminal: the direct fixture leaves the tty to this
  // VirtualTerminal (the same stand-in every PiTui runner suite installs).
  const vt = new VirtualTerminal(110, 32)
  life.defer(installVirtualProcessTerminal(vt))
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: TuiApp) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })

  const fixture = await createDirectTspFixture(life, {
    renderer: 'pi-tui',
    startup: { sessionId: 'pr-a-direct-permission' },
    persistedBlankSession: { id: 'pr-a-direct-permission' },
    officialServices: { permissionPresets: true },
  })
  const view = (): string => vt.getViewport().map(stripAnsi).join('\n')
  await waitFor('the PiTui runner painted', () => view().includes('dsh-pi-tui'), 30_000)

  const app = apps.at(-1) as AppLike | undefined
  assert.ok(app !== undefined, 'the real runner started a TuiApp')
  await waitFor('the projection-backed permission preset rendered', () =>
    app.statusStore.snapshot().access?.permissionPreset?.id !== undefined, 20_000)
  const before = app.statusStore.snapshot().access!.permissionPreset!.id!

  const agents = fixture.ctx.get('agents') as { list(): Iterable<{ session: { id: string } }> }
  const agent = [...agents.list()][0]
  assert.ok(agent !== undefined, 'the runner resumed ONE live Agent')
  const sessionId = String(agent.session.id)
  assert.equal(sessionId, 'pr-a-direct-permission')

  const names = [...(fixture.ctx.get('permissionPresets') as { names: readonly string[] }).names]
  const next = names[(names.indexOf(before) + 1) % names.length]!
  assert.notEqual(next, before, 'the cycle has a real catalog successor')

  // The production notice slot is observed (the pre-fix TypeError surfaced
  // here as an owned-operation failure, never as a successful switch).
  const notices: Array<{ readonly text: string; readonly kind: string }> = []
  const originalNotify = app.notify
  app.notify = (text, kind = 'info') => {
    notices.push({ text, kind })
    originalNotify.call(app, text, kind)
  }
  const recorder = recordCommandSignals(fixture.ctx)
  life.defer(recorder.restore)

  // The REAL gesture — the ESC [ Z byte sequence, not a direct callback call.
  vt.sendInput('\x1b[Z')

  await waitFor('the official /permission lifecycle and the pushed projection', () => {
    const events = sessionEvents(fixture.ctx, sessionId)
    const runs = events.filter(event => event.type === 'command/run')
    const dones = events.filter(event => event.type === 'command/done')
    return recorder.signals.length === 1
      && runs.length === 1
      && dones.length === 1
      && app.statusStore.snapshot().access?.permissionPreset?.id === next
  }, 20_000)

  // The official executor received a REAL, live signal by identical reference.
  const signal = recorder.signals[0]
  assert.ok(signal instanceof AbortSignal, 'the official commands service received a real AbortSignal')
  assert.equal(signal.aborted, false, 'the live runner lifetime signal is not aborted')

  const events = sessionEvents(fixture.ctx, sessionId)
  const runs = events.filter(event => event.type === 'command/run') as Array<{
    readonly data: { readonly commandId?: string; readonly name?: string; readonly args?: string }
  }>
  const dones = events.filter(event => event.type === 'command/done') as Array<{
    readonly data: { readonly commandId?: string; readonly kind?: string }
  }>
  assert.equal(runs.length, 1, 'EXACTLY ONE official /permission command/run (no retry, no duplicate)')
  assert.equal(dones.length, 1, 'EXACTLY ONE official /permission command/done')
  assert.equal(runs[0]!.data.name, 'permission', 'the executed official command is /permission')
  assert.equal(String(runs[0]!.data.args).trim(), next, 'the command line carries the catalog-next preset')
  assert.equal(dones[0]!.data.kind, 'success')
  assert.equal(dones[0]!.data.commandId, runs[0]!.data.commandId, 'run/done are the SAME official lifecycle pair')

  // The durable projection is the repaint authority: the pinned baseline and
  // the committed switch are the only permission facts, and the footer shows
  // the committed one.
  const presetEvents = events
    .filter(event => event.type === 'permission/preset')
    .map(event => (event.data as { readonly preset?: string }).preset)
  assert.deepEqual(presetEvents, [before, next],
    'the visible value comes from the official permission projection, not a local install')
  assert.equal(app.statusStore.snapshot().access!.permissionPreset!.id, next)

  // The pre-fix failure mode: the official executor would throw
  // `Cannot read properties of undefined (reading 'aborted')`; the healthy
  // gesture surfaces exactly its OWN product notice (switching to
  // danger-full-access is a deliberate warning, never a silent success) and
  // no failure notice.
  const expectedCycleNotice = next === 'danger-full-access'
    ? { text: `⚠ ${next} — no approvals`, kind: 'error' }
    : { text: `permission: ${next}`, kind: 'info' }
  assert.deepEqual(notices, [expectedCycleNotice],
    `the gesture emitted exactly its intentional notice: ${JSON.stringify(notices)}`)
  assert.equal(notices.some(notice => /aborted|Cannot read properties/iu.test(notice.text)), false,
    'no undefined-signal TypeError reached the production notice slot')

  // ── The symmetric production entry: the `/yolo` client command ──────────
  // It reaches the SAME ConfigPort through CommandSurface, whose caller
  // passes an explicit per-operation signal. Both entries must ride the ONE
  // runner lifetime signal (no per-action/orphan controller).
  vt.sendInput('/yolo')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  await waitFor('the /yolo official /permission dispatch', () => {
    const rows = sessionEvents(fixture.ctx, sessionId)
    return recorder.signals.length === 2
      && rows.filter(event => event.type === 'command/run'
        && (event.data as { readonly name?: string }).name === 'permission').length === 2
  }, 20_000)
  assert.equal(recorder.signals[1], recorder.signals[0],
    'both production entries forward the SAME runner lifetime signal (explicit signal wins, no fake)')
  const yoloEvents = sessionEvents(fixture.ctx, sessionId)
  const yoloRuns = yoloEvents.filter(event => event.type === 'command/run'
    && (event.data as { readonly name?: string }).name === 'permission') as Array<{
      readonly data: { readonly args?: string; readonly commandId?: string }
    }>
  const yoloDones = yoloEvents.filter(event => event.type === 'command/done') as Array<{
    readonly data: { readonly commandId?: string }
  }>
  assert.equal(String(yoloRuns[1]!.data.args).trim(), 'danger-full-access',
    '/yolo applies its preset through the OFFICIAL /permission command line')
  assert.equal(yoloDones.filter(done => yoloRuns.some(run => run.data.commandId === done.data.commandId)).length, 2,
    'each official /permission run (Shift+Tab and /yolo) has exactly ONE matching command/done')
  const failureNotices = notices.filter(notice => notice.kind === 'error'
    && notice.text !== expectedCycleNotice.text)
  assert.deepEqual(failureNotices, [],
    `neither entry surfaced a failure notice: ${JSON.stringify(notices)}`)
  assert.equal(notices.some(notice => /aborted|Cannot read properties/iu.test(notice.text)), false,
    'no undefined-signal TypeError reached the production notice slot')
})
