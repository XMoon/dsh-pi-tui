/**
 * Headless tests for the `/sessions` picker support: pure row assembly and
 * the searchable picker overlay driven through the virtual terminal.
 * Session derived state (titles, presets) is Host-owned and arrives through
 * the projection port — see session-reader-port.test.ts and
 * session-picker-projections.test.ts for those contracts.
 * @module @xmoon76/dsh-pi-tui/sessions.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import {


  MAX_PICKER_SESSIONS,
  findSessionMatch,
  formatSessionAge,
  headerToPickerRow,
  sameWorkspace,
  sessionPickerItem,
  shortSessionId,
  workspaceKey,
  type SessionPickerRow,
} from '../src/sessions.ts'
/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces,
 * so a test that starts an app must not leak the slot into the next test
 * (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

test('shortSessionId strips the prefix and keeps 8 characters', () => {
  assert.equal(shortSessionId('session-0123456789abcdef'), '01234567')
  assert.equal(shortSessionId('session_0123456789'), '01234567')
  assert.equal(shortSessionId('abc'), 'abc')
})

test('workspaceKey takes the last two path segments', () => {
  assert.equal(workspaceKey('/home/user/project/me/dsh-pi-tui'), 'me/dsh-pi-tui')
  assert.equal(workspaceKey('/tmp'), '/tmp')
  assert.equal(workspaceKey(undefined), '(no workspace)')
  assert.equal(workspaceKey(''), '(no workspace)')
})

test('sameWorkspace ignores trailing separators and rejects unrooted cwds', () => {
  assert.equal(sameWorkspace('/a/b', '/a/b'), true)
  assert.equal(sameWorkspace('/a/b', '/a/b/'), true, 'a trailing slash is the same workspace')
  assert.equal(sameWorkspace('/a/b', '/a/b//'), true)
  assert.equal(sameWorkspace('/a/b', '/a/c'), false)
  assert.equal(sameWorkspace('/a', '/'), false)
  assert.equal(sameWorkspace(undefined, '/a'), false, 'an unrooted session never scopes in')
  assert.equal(sameWorkspace('/a', undefined), false)
  assert.equal(sameWorkspace('', '/a'), false)
  assert.equal(sameWorkspace(undefined, undefined), false)
})

test('sameWorkspace normalizes dot segments (round-2 review finding)', () => {
  assert.equal(sameWorkspace('/ws/project/./', '/ws/project'), true, 'a ./ segment is the same workspace')
  assert.equal(sameWorkspace('/ws/project-a/../project-a', '/ws/project-a'), true, 'a .. round-trip is the same workspace')
  assert.equal(sameWorkspace('/ws/project-a/../project-b', '/ws/project-b'), true)
  assert.equal(sameWorkspace('/ws/project/../other', '/ws/project'), false)
  assert.equal(sameWorkspace('/a/b/..', '/a'), true)
})

test('formatSessionAge is compact and bounded', () => {
  const now = 1_000_000_000_000
  assert.equal(formatSessionAge(now - 5_000, now), 'now')
  assert.equal(formatSessionAge(now - 60_000, now), '1m')
  assert.equal(formatSessionAge(now - 3_600_000, now), '1h')
  assert.equal(formatSessionAge(now - 2 * 86_400_000, now), '2d')
  assert.equal(formatSessionAge(now - 45 * 86_400_000, now), '1mo')
  assert.equal(formatSessionAge(now - 400 * 86_400_000, now), '1y')
  assert.equal(formatSessionAge(now + 60_000, now), 'now')
})

test('sessionPickerItem assembles a titled row with meta and group', () => {
  const row: SessionPickerRow = {
    id: 'session-0123456789abcdef',
    createdAt: 1_000,
    title: 'fix footer rendering',
    cwd: '/home/user/project/me/dsh-pi-tui',
    preset: 'minimal',
    live: false,
  }
  const item = sessionPickerItem(row, 'session-other')
  assert.equal(item.value, 'session-0123456789abcdef')
  assert.equal(item.label, 'fix footer rendering')
  assert.equal(item.group, 'me/dsh-pi-tui')
  assert.ok(item.description.includes('01234567'), `short id missing: ${item.description}`)
  assert.ok(item.description.includes('preset:minimal'), `preset missing: ${item.description}`)
  assert.ok(!item.description.includes('sub'), `unexpected sub marker: ${item.description}`)
  assert.ok(!item.description.includes('fork'), `unexpected fork marker: ${item.description}`)
  assert.ok(!item.description.includes('live'), `unexpected live marker: ${item.description}`)
})

test('sessionPickerItem marks the current session, subagents, forks, live', () => {
  const row: SessionPickerRow = {
    id: 'session-0123456789abcdef',
    createdAt: 1_000,
    cwd: '/home/user/project',
    origin: 'subagent',
    parentSession: 'session-fff',
    live: true,
  }
  const item = sessionPickerItem(row, 'session-0123456789abcdef')
  assert.ok(item.label.startsWith('● '), `current marker missing: ${item.label}`)
  assert.ok(item.description.includes('sub'), `sub marker missing: ${item.description}`)
  assert.ok(item.description.includes('fork'), `fork marker missing: ${item.description}`)
  assert.ok(item.description.includes('live'), `live marker missing: ${item.description}`)
  // Untitled sessions fall back to the short id as the label.
  assert.equal(item.label, '● 01234567')
})

test('headerToPickerRow maps a header onto the row shape', () => {
  const row = headerToPickerRow({
    version: SESSION_FORMAT_VERSION, isSeeded: false,
    id: SessionId('session-0123456789abcdef'),
    createdAt: 42,
    cwd: '/w',
    agentPreset: 'minimal',
    parentSession: SessionId('session-p'),
    origin: 'subagent',
  }, true)
  assert.equal(row.id, 'session-0123456789abcdef')
  assert.equal(row.createdAt, 42)
  assert.equal(row.cwd, '/w')
  assert.equal(row.preset, 'minimal')
  assert.equal(row.parentSession, 'session-p')
  assert.equal(row.origin, 'subagent')
  assert.equal(row.live, true)
})

test('headerToPickerRow preserves code until a roster-aware reader can disambiguate it', () => {
  const row = headerToPickerRow({
    version: SESSION_FORMAT_VERSION, isSeeded: false,
    id: SessionId('session-legacy'),
    createdAt: 42,
    agentPreset: 'code',
  }, false)
  assert.equal(row.preset, 'code')
})

test('MAX_PICKER_SESSIONS keeps its legacy exported value', () => {
  // The constant no longer caps the title reads (the picker loads titles
  // for every main row it can display), but it stays exported and pinned
  // as a documented legacy value.
  assert.equal(MAX_PICKER_SESSIONS, 200)
})

// ── headless picker behavior through the virtual terminal ────────────────

function startApp(): { vt: VirtualTerminal; app: TuiApp; picked: string[] } {
  const vt = new VirtualTerminal(100, 30)
  const picked: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  })
  app.start()
  startedApps.add(app)
  return { vt, app, picked }
}

test('picker searches incrementally and selects on Enter', async () => {
  const { vt, app, picked } = startApp()
  const handle = app.openPicker(
    [
      { value: 'session-a', label: 'alpha', description: '01234567 · 2m · me/dsh-pi-tui', group: 'me/dsh-pi-tui' },
      { value: 'session-b', label: 'zulu', description: '89abcdef · 3h · work/atlasx', group: 'work/atlasx' },
      { value: 'session-c', label: 'mike', description: 'fedcba98 · 1d · me/dsh-pi-tui', group: 'me/dsh-pi-tui' },
    ],
    (value) => picked.push(value),
    () => {},
    { enableSearch: true, header: 'sessions', showHint: true },
  )
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('sessions'), `header missing:\n${view}`)
  assert.ok(view.includes('me/dsh-pi-tui'), `group header missing:\n${view}`)
  assert.ok(view.includes('work/atlasx'), `second group missing:\n${view}`)

  vt.sendInput('z')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('zulu'), `filtered row missing:\n${view}`)
  assert.ok(!view.includes('alpha'), `non-matching row visible:\n${view}`)

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(picked, ['session-b'])
  handle.close()
})

test('picker setItems enriches rows and re-applies the active query', async () => {
  const { vt, app } = startApp()
  const handle = app.openPicker(
    [{ value: 'session-a', label: '01234567', description: '2m · me/dsh-pi-tui', group: 'me/dsh-pi-tui' }],
    () => {},
    () => {},
    { enableSearch: true, header: 'sessions', noMatchText: '  no matching sessions' },
  )
  await vt.waitForRender()
  vt.sendInput('footer')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('no matching sessions'), `expected no-match:\n${view}`)

  handle.setItems([
    { value: 'session-a', label: 'fix footer rendering', description: '01234567 · 2m · me/dsh-pi-tui', group: 'me/dsh-pi-tui' },
  ])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('fix footer rendering'), `enriched row missing:\n${view}`)
  handle.close()
})

test('picker prefills the search from the initial query', async () => {
  const { vt, app } = startApp()
  const handle = app.openPicker(
    [
      { value: 'session-a', label: 'alpha' },
      { value: 'session-b', label: 'zulu' },
    ],
    () => {},
    () => {},
    { enableSearch: true, initialQuery: 'z' },
  )
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('zulu'), `prefiltered row missing:\n${view}`)
  assert.ok(!view.includes('alpha'), `non-matching row visible:\n${view}`)
  handle.close()
})

test('picker Esc cancels', async () => {
  const { vt, app } = startApp()
  let cancelled = 0
  const handle = app.openPicker(
    [{ value: 'session-a', label: 'alpha' }],
    () => {},
    () => { cancelled += 1 },
    { enableSearch: true },
  )
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancelled, 1)
  handle.close()
})

test('findSessionMatch resolves full ids, session- prefixes, and short ids', () => {
  const rows: SessionPickerRow[] = [
    { id: 'session-11111111-2222-3333-4444-555555555555', createdAt: 2, live: false },
    { id: 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', createdAt: 3, live: false },
    { id: 'session-99999999-8888-7777-6666-555555555555', createdAt: 1, live: false },
  ]
  assert.equal(findSessionMatch(rows, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')?.id, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.equal(findSessionMatch(rows, 'session-aaaaaaaa-bbbb')?.id, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.equal(findSessionMatch(rows, 'aaaaaaa')?.id, 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  assert.equal(findSessionMatch(rows, 'nope'), undefined)
})

