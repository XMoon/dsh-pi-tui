/**
 * Tern terminal integration (plan §5): the pure Tern facts (identity, OSC 7
 * encoding) and the TuiApp terminal-ownership lifecycle for the OSC 7 cwd
 * projection. The low-level OSC 9;4 protocol stays owned by
 * `@xmoon76/pi-tui`; the Tern progress refinement is asserted in the fork and
 * terminal-progress suites.
 * @module @xmoon76/dsh-pi-tui/tern-terminal.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TuiApp } from '../src/tui-app.ts'
import { isTernTerminal, ternCwdSequence, ternProgressState } from '../src/tui/terminal/tern.ts'
import { terminalTitleOf } from '../src/tui/terminal/title.ts'
import { createStatusRuntime, type StatusRuntimeDeps } from '../src/app/surface/status-runtime.ts'
import { displaySeamStub } from './support/display-seam-stub.ts'
import { emptyStatusSnapshot } from '../src/domain/status/types.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

// ── Pure Tern facts ─────────────────────────────────────────────────────────

test('Tern identity is TERM_PROGRAM=tern, matched case-insensitively', () => {
  assert.equal(isTernTerminal({ TERM_PROGRAM: 'tern' }), true)
  assert.equal(isTernTerminal({ TERM_PROGRAM: 'TERN' }), true)
  assert.equal(isTernTerminal({ TERM_PROGRAM: 'Tern' }), true)
  assert.equal(isTernTerminal({ TERM_PROGRAM: 'iTerm.app' }), false)
  assert.equal(isTernTerminal({ TERM_PROGRAM: 'xterm-tern' }), false)
  assert.equal(isTernTerminal({}), false)
})

test('the OSC 7 payload is a percent-encoded file URL, never raw cwd text', () => {
  assert.equal(ternCwdSequence('/path/a b'), '\x1b]7;file:///path/a%20b\x07')
  assert.equal(ternCwdSequence('/path/#x'), '\x1b]7;file:///path/%23x\x07')
  assert.equal(ternCwdSequence('/path/%x'), '\x1b]7;file:///path/%25x\x07')
  assert.equal(ternCwdSequence('/path/日本語'), '\x1b]7;file:///path/%E6%97%A5%E6%9C%AC%E8%AA%9E\x07')
  // A control character can never terminate or escape the sequence: it is
  // percent-encoded, so the ONLY ESC is the introducer and the ONLY BEL is the
  // terminator.
  assert.equal(ternCwdSequence('/path/a\x1bb'), '\x1b]7;file:///path/a%1Bb\x07')
  assert.equal(ternCwdSequence('/path/a\x07b'), '\x1b]7;file:///path/a%07b\x07')
})

test('a usable OSC 7 cwd round-trips back to the original absolute path', () => {
  for (const cwd of ['/work/A', '/work/a b', '/work/#hash', '/work/日本語']) {
    const sequence = ternCwdSequence(cwd)
    assert.notEqual(sequence, undefined)
    const href = sequence!.slice('\x1b]7;'.length, -'\x07'.length)
    assert.equal(fileURLToPath(href), cwd)
  }
})

test('an unusable cwd yields no sequence (no Client-cwd / root substitute)', () => {
  assert.equal(ternCwdSequence(''), undefined)
  assert.equal(ternCwdSequence('relative/path'), undefined)
  assert.equal(ternCwdSequence('./here'), undefined)
  assert.equal(ternCwdSequence('/bad\0path'), undefined)
})

test('the Tern progress state needs BOTH a wait phase and a proven Agent-blocking wait (plan §6.2)', () => {
  const waitPhases = ['waiting-approval', 'waiting-question'] as const
  const busyPhases = ['idle', 'working', 'compacting', 'applying-compaction'] as const
  // Idle wins over EVERY (phase, agentInputWait) pair: a stale phase can never
  // keep a retired owner busy on the pane.
  for (const phase of [...waitPhases, ...busyPhases] as const) {
    for (const agentInputWait of [true, false]) {
      assert.equal(ternProgressState(false, phase, agentInputWait), 'clear',
        `idle + ${phase} (agent=${agentInputWait}) is clear`)
    }
  }
  // A wait phase pauses ONLY when the caller proved the main Agent is BLOCKED on
  // it: `waiting-question` alone also covers a Client-local question (the
  // `/login` authorization prompt) and a CONTINUED late-answer form whose Agent
  // already continued, and both must keep the pane working.
  for (const phase of waitPhases) {
    assert.equal(ternProgressState(true, phase, true), 'paused', `an Agent-blocking ${phase} pauses`)
    assert.equal(ternProgressState(true, phase, false), 'indeterminate',
      `an unproven/local/continued ${phase} is NOT Agent waiting_input`)
  }
  // Every other busy phase keeps Tern's working state, whatever the flag says.
  for (const phase of busyPhases) {
    assert.equal(ternProgressState(true, phase, true), 'indeterminate')
    assert.equal(ternProgressState(true, phase, false), 'indeterminate')
  }
})

// ── TuiApp cwd presentation lifecycle ──────────────────────────────────────

/** The process TUI slot is global: every constructed TuiApp is disposed after
 *  each test (only dispose releases the slot, never stop()). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A started Tern app whose injected VirtualTerminal records every OSC 7. */
function mountTernApp(tern = true): { vt: VirtualTerminal; app: TuiApp; cwdWrites: string[] } {
  const vt = new VirtualTerminal(80, 24)
  const cwdWrites: string[] = []
  const write = vt.write.bind(vt)
  vt.write = (data: string) => {
    if (data.startsWith('\x1b]7;')) cwdWrites.push(data)
    write(data)
  }
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { ternTerminal: tern })
  app.start()
  startedApps.add(app)
  return { vt, app, cwdWrites }
}

test('a repeated terminal cwd is written exactly once', () => {
  const { app, cwdWrites } = mountTernApp()
  try {
    app.setTerminalCwd('/work/A')
    app.setTerminalCwd('/work/A')
    app.setTerminalCwd('/work/A')
    assert.deepEqual(cwdWrites, ['\x1b]7;file:///work/A\x07'], 'an equal cwd never churns the pane metadata')
  } finally {
    app.dispose()
  }
})

test('a stopped TuiApp folds the cwd and a restart re-asserts the latest value once', () => {
  const { app, cwdWrites } = mountTernApp()
  try {
    app.stop()
    app.setTerminalCwd('/work/A')
    app.setTerminalCwd('/work/B')
    assert.deepEqual(cwdWrites, [], 'a stopped surface never writes terminal metadata')
    app.start()
    assert.deepEqual(cwdWrites, ['\x1b]7;file:///work/B\x07'],
      'the restart projects the LATEST folded cwd exactly once')
  } finally {
    app.dispose()
  }
})

test('an unknown cwd writes nothing and a later re-appearance is re-asserted', () => {
  const { app, cwdWrites } = mountTernApp()
  try {
    app.setTerminalCwd('/work/A')
    app.setTerminalCwd(undefined)
    assert.deepEqual(cwdWrites, ['\x1b]7;file:///work/A\x07'], 'there is no OSC 7 "clear" to invent')
    app.setTerminalCwd('/work/A')
    assert.deepEqual(cwdWrites, ['\x1b]7;file:///work/A\x07', '\x1b]7;file:///work/A\x07'],
      'after an unknown interlude the same cwd is re-asserted (the cache assumption was invalidated)')
  } finally {
    app.dispose()
  }
})

test('an unusable cwd never reaches the terminal', () => {
  const { app, cwdWrites } = mountTernApp()
  try {
    app.setTerminalCwd('relative/path')
    assert.deepEqual(cwdWrites, [])
  } finally {
    app.dispose()
  }
})

test('every TuiApp-owned screen restart re-asserts the cwd on the new screen', () => {
  const { app, cwdWrites } = mountTernApp()
  try {
    app.setTerminalCwd('/work/B')
    app.setFullscreen(true)
    app.setFullscreen(false)
    assert.deepEqual(cwdWrites, [
      '\x1b]7;file:///work/B\x07',
      '\x1b]7;file:///work/B\x07',
      '\x1b]7;file:///work/B\x07',
    ], 'regular -> alt -> regular re-asserts the pane cwd per new screen')
  } finally {
    app.dispose()
  }
})

test('a $EDITOR-suspended TuiApp folds cwd changes and projects once on resume', async () => {
  const vt = new VirtualTerminal(80, 24)
  const cwdWrites: string[] = []
  const write = vt.write.bind(vt)
  vt.write = (data: string) => {
    if (data.startsWith('\x1b]7;')) cwdWrites.push(data)
    write(data)
  }
  let release!: (text: string) => void
  const gate = new Promise<string>(resolve => { release = resolve })
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    openExternalEditor: () => gate,
    runOwned: () => {},
  }, { ternTerminal: true })
  app.start()
  startedApps.add(app)
  try {
    app.setTerminalCwd('/work/A')
    const pending = app.launchExternalEditor()
    app.setTerminalCwd('/work/B')
    assert.deepEqual(cwdWrites, ['\x1b]7;file:///work/A\x07'],
      'a suspended terminal never receives cwd bytes (the editor owns the PTY)')
    release('edited')
    await pending
    assert.deepEqual(cwdWrites, ['\x1b]7;file:///work/A\x07', '\x1b]7;file:///work/B\x07'],
      'the resume projects the latest folded cwd exactly once')
  } finally {
    app.dispose()
  }
})

test('a non-Tern terminal never receives OSC 7', () => {
  const { app, cwdWrites } = mountTernApp(false)
  try {
    app.setTerminalCwd('/work/A')
    app.stop()
    app.start()
    assert.deepEqual(cwdWrites, [])
  } finally {
    app.dispose()
  }
})

// ── Status layer: the cwd locality authority ────────────────────────────────

interface CwdHarness {
  readonly forwarded: (string | undefined)[]
  /** The semantic identity facts the composition's title seam received. */
  readonly titles: { sessionTitle?: string; cwd?: string }[]
  refresh(): void
  refreshTitle(): void
}

function cwdHarness(options: {
  remote?: boolean
  /** `undefined` = no live agent (sessionless Direct); `{}` = a live agent
   *  whose official header carries no cwd. */
  live?: { cwd?: string }
  clientCwd?: string
  sessionTitle?: string
  /** The OFFICIAL session projection's cwd the Remote branch reads. */
  projectedCwd?: string
  /** The current owner session id; `undefined` is the REAL sessionless state
   *  (the Remote branch reads the Client launch cwd there). Defaults to
   *  `'main'` for the session-bearing cases. */
  currentSessionId?: string
}): CwdHarness {
  const forwarded: (string | undefined)[] = []
  const titles: { sessionTitle?: string; cwd?: string }[] = []
  const runtime = createStatusRuntime({
    surface: {
      // Only the display seam's cwd/title commits are exercised here.
      display: displaySeamStub({
        setTerminalCwd: cwd => { forwarded.push(cwd) },
        getSessionTitle: () => options.sessionTitle ?? '',
      }),
      status: { snapshot: () => emptyStatusSnapshot() },
      commitStatus: () => {},
    },
    updateTerminalTitle: (context: { sessionTitle?: string; cwd?: string }) => { titles.push(context) },
    isCleanedUp: () => false,
    liveAgent: () => options.live === undefined ? undefined : {
      session: {
        id: 'main',
        header: options.live.cwd === undefined ? {} : { cwd: options.live.cwd },
      },
      options: {},
    },
    generation: () => 1,
    currentSessionId: () => ('currentSessionId' in options ? options.currentSessionId : 'main'),
    measureContext: () => undefined,
    sessionStatus: () => options.projectedCwd === undefined ? undefined : { cwd: options.projectedCwd },
    model: {
      selection: () => undefined,
      currentOf: () => undefined,
      defaultSelection: () => undefined,
      marker: () => undefined,
      preset: () => undefined,
    },
    host: () => ({
      permissionPresets: undefined,
      sandboxPolicy: undefined,
      approval: undefined,
      planMode: undefined,
      sessionProjections: undefined,
    }),
    ...options.remote === true ? { remote: { plan: () => undefined } } : {},
    presentation: { mainStats: () => ({}) as never },
    viewer: { read: () => undefined },
    diag: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} },
    clientCwd: options.clientCwd ?? '/client/launch',
  } as unknown as StatusRuntimeDeps)
  return { forwarded, titles, refresh: () => runtime.refreshTerminalCwd(), refreshTitle: () => runtime.refreshTerminalTitle() }
}

test('a Direct live Session publishes its header cwd', () => {
  const h = cwdHarness({ live: { cwd: '/work/A' } })
  h.refresh()
  assert.deepEqual(h.forwarded, ['/work/A'])
})

test('a Direct live Session without an official cwd falls back to the launch cwd', () => {
  const h = cwdHarness({ live: {}, clientCwd: '/client/launch' })
  h.refresh()
  assert.deepEqual(h.forwarded, ['/client/launch'])
})

test('a sessionless Direct surface publishes the launch cwd', () => {
  const h = cwdHarness({ clientCwd: '/client/launch' })
  h.refresh()
  assert.deepEqual(h.forwarded, ['/client/launch'])
})

test('a DSH Remote backend never publishes a Host cwd into the Client terminal', () => {
  const h = cwdHarness({ remote: true, live: { cwd: '/host/remote' }, clientCwd: '/client/launch' })
  h.refresh()
  assert.deepEqual(h.forwarded, [undefined],
    'the Remote Host workspace fails closed: the pane belongs to the Client machine')
})

// ── Status layer: the OSC 0 terminal TITLE contract (the composition applies
//    the OSC policy; this owner supplies semantic facts only) ───────────────
//
// The F6 plan-owner ruling (2026-10-08) settled §10.12: OSC 0 is IDENTITY
// (session title first, else the OFFICIAL session workspace cwd on BOTH
// branches), while OSC 7 is the terminal-LOCAL cwd and keeps its own
// Remote fail-closed rule. The frozen line "Remote Host cwd never becomes
// Client terminal title cwd" was the plan's own conflation of the two
// authorities and is corrected here, NOT implemented as a behavior change.

/** The observable title the composition policy derives from one seam call. */
function composedTitle(h: CwdHarness): string {
  return terminalTitleOf(h.titles.at(-1)!)
}

test('a session title leads on both branches, with the session cwd as the fallback fact', () => {
  const direct = cwdHarness({ live: { cwd: '/work/A' }, sessionTitle: 'Fix queue bug' })
  direct.refreshTitle()
  assert.deepEqual(direct.titles, [{ sessionTitle: 'Fix queue bug', cwd: '/work/A' }])
  assert.equal(composedTitle(direct), 'dsh · Fix queue bug')

  const remote = cwdHarness({ remote: true, projectedCwd: '/host/alpha', sessionTitle: 'Fix bug' })
  remote.refreshTitle()
  assert.deepEqual(remote.titles, [{ sessionTitle: 'Fix bug', cwd: '/host/alpha' }])
  assert.equal(composedTitle(remote), 'dsh · Fix bug')
})

test('a Direct session without a title uses the official session cwd (last two path segments)', () => {
  const h = cwdHarness({ live: { cwd: '/repo/work' } })
  h.refreshTitle()
  assert.deepEqual(h.titles, [{ sessionTitle: '', cwd: '/repo/work' }])
  assert.equal(composedTitle(h), 'dsh · repo/work')
})

test('a sessionless Direct surface supplies the launch cwd to the title seam', () => {
  const h = cwdHarness({ clientCwd: '/client/launch' })
  h.refreshTitle()
  assert.deepEqual(h.titles, [{ sessionTitle: '', cwd: '/client/launch' }])
  assert.equal(composedTitle(h), 'dsh · client/launch')
})

test('a Remote session with a projected Host cwd uses it as OSC 0 identity (plan-owner ruling A)', () => {
  // OSC 0 names the session, so the official session workspace is the
  // identity fallback and on Remote that fact IS the projected Host cwd. It
  // is display identity only: the OSC 7 terminal-local cwd never forwards it.
  const h = cwdHarness({ remote: true, projectedCwd: '/host/alpha', clientCwd: '/client/beta' })
  h.refreshTitle()
  assert.deepEqual(h.titles, [{ sessionTitle: '', cwd: '/host/alpha' }])
  assert.equal(composedTitle(h), 'dsh · host/alpha')
})

test('a Remote session without a projected cwd falls back to the bare brand, never the Client launch cwd', () => {
  // A session IDENTITY exists but its official cwd is unavailable: the fact
  // is undefined, so the title falls back to the bare brand instead of
  // impersonating a Host workspace with the Client machine's launch
  // directory. (The REAL sessionless Remote case is the next test.)
  const h = cwdHarness({ remote: true, clientCwd: '/client/launch' })
  h.refreshTitle()
  assert.deepEqual(h.titles, [{ sessionTitle: '', cwd: undefined }])
  assert.equal(composedTitle(h), 'dsh')
})

test('a Direct live session whose official header carries no cwd falls back to the bare brand, not the launch cwd', () => {
  // The negative control that separates OSC 0 identity from the OSC 7
  // terminal-local fallback: OSC 7 may use the Client launch cwd, the title
  // must not (there IS a session identity; it simply has no official cwd).
  const h = cwdHarness({ live: {}, clientCwd: '/client/launch' })
  h.refreshTitle()
  assert.deepEqual(h.titles, [{ sessionTitle: '', cwd: undefined }])
  assert.equal(composedTitle(h), 'dsh')
})

test('a truly sessionless Remote surface uses the Client launch cwd as local identity', () => {
  // `currentSessionId()` undefined is a legal state (`status-runtime` names
  // "the sessionless Remote surface"): with NO session identity there is no
  // Host workspace to impersonate, so the local launch directory is
  // legitimate OSC 0 identity — exactly as for a sessionless Direct surface.
  // OSC 7 still publishes no Remote Host cwd.
  const h = cwdHarness({ remote: true, currentSessionId: undefined, clientCwd: '/client/beta' })
  h.refreshTitle()
  assert.deepEqual(h.titles, [{ sessionTitle: '', cwd: '/client/beta' }])
  assert.equal(composedTitle(h), 'dsh · client/beta')
})
