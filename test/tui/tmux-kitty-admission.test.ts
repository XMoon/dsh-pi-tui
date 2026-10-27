/**
 * Image-7B-A — strict tmux + Kitty admission.
 *
 * Evidence level: every decision here is derived from the RAW stdout of a real
 * `execFileSync('tmux', fixedArgv, …)` call (a scripted executable on PATH),
 * never from a precomputed `allowed` flag. The real isolated-server + real
 * Kitty GUI positive is the separate E3 qualification.
 * @module @xmoon76/dsh-pi-tui/tui/tmux-kitty-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TmuxKittyAdmission,
  probeTmuxKittyIdentity,
  type TmuxKittyIdentity,
} from '../../src/tui/graphics/tmux-admission.ts'
import { createFakeTmuxCli, type FakeTmuxCli } from '../support/fake-tmux-cli.ts'

function admitted(cli: FakeTmuxCli): TmuxKittyIdentity {
  const identity = probeTmuxKittyIdentity(cli.env)
  assert.ok(identity, 'the default fake server is the one admitted topology')
  return identity
}

test('the real CLI probe reads the one trusted topology from raw server output', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    assert.deepEqual(probeTmuxKittyIdentity(cli.env), {
      paneId: '%7',
      sessionName: 'work',
      clientName: 'main',
      clientTty: '/dev/pts/12',
      clientTermname: 'xterm-kitty',
      clientTermtype: 'kitty(0.41.1)',
    })
    assert.deepEqual(cli.calls(), [
      'show-options -Apqv -t %7 allow-passthrough',
      'display-message -p -t %7 #{session_name}',
      'list-clients -F #{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}',
    ], 'the probe uses the fixed argv and never a shell')
  } finally {
    cli.dispose()
  }
})

test('a bare kitty termtype is accepted; a derived family is not', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty\n' })
    assert.ok(probeTmuxKittyIdentity(cli.env), 'kitty without a version suffix is Kitty itself')
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty-direct\n' })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined, 'a kitty-derived termtype is not Kitty')
  } finally {
    cli.dispose()
  }
})

test('every environment gate rejects BEFORE any tmux command is spawned', (t) => {
  const cases: ReadonlyArray<{ name: string; mutate: (env: NodeJS.ProcessEnv) => void }> = [
    { name: 'opt-in unset', mutate: (env) => { delete env.PI_TUI_TMUX_KITTY_IMAGES } },
    { name: 'opt-in 0', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = '0' } },
    { name: 'opt-in true', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = 'true' } },
    { name: 'TMUX missing', mutate: (env) => { delete env.TMUX } },
    { name: 'TMUX empty', mutate: (env) => { env.TMUX = '' } },
    { name: 'TMUX_PANE missing', mutate: (env) => { delete env.TMUX_PANE } },
    { name: 'TMUX_PANE empty', mutate: (env) => { env.TMUX_PANE = '' } },
    { name: 'Zellij', mutate: (env) => { env.ZELLIJ = '1' } },
    { name: 'GNU screen', mutate: (env) => { env.STY = '1' } },
    { name: 'TERM not tmux', mutate: (env) => { env.TERM = 'xterm-kitty' } },
    { name: 'TERM missing', mutate: (env) => { delete env.TERM } },
    { name: 'Herdr', mutate: (env) => { env.TERM_PROGRAM = 'herdr' } },
    { name: 'protocol none', mutate: (env) => { env.PI_IMAGE_PROTOCOL = 'none' } },
    { name: 'protocol 0', mutate: (env) => { env.PI_IMAGE_PROTOCOL = '0' } },
    { name: 'protocol iterm2', mutate: (env) => { env.PI_IMAGE_PROTOCOL = 'iterm2' } },
  ]
  for (const entry of cases) {
    const cli = createFakeTmuxCli(t)
    try {
      entry.mutate(cli.env)
      assert.equal(probeTmuxKittyIdentity(cli.env), undefined, entry.name)
      assert.deepEqual(cli.calls(), [], `${entry.name}: no tmux subprocess may run`)
    } finally {
      cli.dispose()
    }
  }
})

test('the pane option must read exactly all', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    for (const value of ['on\n', 'off\n', '', 'all \n off\n']) {
      cli.setReply('show-options', { text: value })
      assert.equal(probeTmuxKittyIdentity(cli.env), undefined, JSON.stringify(value))
    }
    cli.setReply('show-options', { text: 'all\n', exitCode: 1 })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined, 'a failing show-options is not an answer')
    cli.setReply('show-options', { text: 'all\n', delayMs: 2_000 })
    const started = performance.now()
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined, 'a hung server fails closed')
    assert.ok(performance.now() - started >= 400, 'the 500 ms production timeout really aborts the probe')
  } finally {
    cli.dispose()
  }
})

test('an empty session name is not an identity', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    cli.setReply('display-message', { text: '\n' })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined)
  } finally {
    cli.dispose()
  }
})

test('the whole server must have exactly one matching, non-empty Kitty client', (t) => {
  const cases: ReadonlyArray<{ name: string; text: string }> = [
    { name: 'no client', text: '' },
    { name: 'mixed clients', text: 'a\t/dev/pts/1\twork\txterm-kitty\tkitty(0.41.1)\nb\t/dev/pts/2\twork\txterm-kitty\tkitty(0.41.1)\n' },
    { name: 'session mismatch', text: 'main\t/dev/pts/12\tother\txterm-kitty\tkitty(0.41.1)\n' },
    { name: 'non-Kitty termname', text: 'main\t/dev/pts/12\twork\ttmux-256color\tkitty(0.41.1)\n' },
    { name: 'empty client name', text: '\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\n' },
    { name: 'empty client tty', text: 'main\t\twork\txterm-kitty\tkitty(0.41.1)\n' },
    { name: 'missing termtype field', text: 'main\t/dev/pts/12\twork\txterm-kitty\n' },
    { name: 'empty termtype', text: 'main\t/dev/pts/12\twork\txterm-kitty\t\n' },
  ]
  for (const entry of cases) {
    const cli = createFakeTmuxCli(t)
    try {
      cli.setReply('list-clients', { text: entry.text })
      assert.equal(probeTmuxKittyIdentity(cli.env), undefined, entry.name)
    } finally {
      cli.dispose()
    }
  }
})

test('an inherited KITTY_WINDOW_ID cannot manufacture the live client binding', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    cli.env.KITTY_WINDOW_ID = '7'
    cli.env.TERM_PROGRAM = 'kitty'
    cli.env.PI_IMAGE_PROTOCOL = 'kitty'
    cli.setReply('list-clients', { text: '' })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined,
      'the outer Kitty variables are inherited pane environment, not the attached client')
  } finally {
    cli.dispose()
  }
})

test('an overflowing CLI reply fails closed instead of being truncated into a client', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    cli.setReply('list-clients', {
      text: `main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\n${'x'.repeat(70 * 1024)}\n`,
    })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined)
  } finally {
    cli.dispose()
  }
})

test('admission re-probes the real server and latches on a client change', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
    assert.equal(admission.isAllowed(false), true)
    cli.setReply('list-clients', { text: 'main\t/dev/pts/99\twork\txterm-kitty\tkitty(0.41.1)\n' })
    assert.equal(admission.isAllowed(true), false, 'a changed tty revokes the handle')
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\n' })
    assert.equal(admission.isAllowed(true), false, 'the revocation is a one-way latch')
    assert.equal(admission.isAllowed(false), false)
  } finally {
    cli.dispose()
  }
})

test('a client disappearing, the option changing or the session renaming all revoke', (t) => {
  const changes: ReadonlyArray<{ name: string; apply: (cli: FakeTmuxCli) => void }> = [
    { name: 'client detached', apply: (cli) => cli.setReply('list-clients', { text: '' }) },
    { name: 'option no longer all', apply: (cli) => cli.setReply('show-options', { text: 'on\n' }) },
    {
      name: 'session renamed',
      apply: (cli) => {
        cli.setReply('display-message', { text: 'renamed\n' })
        cli.setReply('list-clients', { text: 'main\t/dev/pts/12\trenamed\txterm-kitty\tkitty(0.41.1)\n' })
      },
    },
  ]
  for (const change of changes) {
    const cli = createFakeTmuxCli(t)
    try {
      const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
      assert.equal(admission.isAllowed(true), true, change.name)
      change.apply(cli)
      assert.equal(admission.isAllowed(true), false, change.name)
    } finally {
      cli.dispose()
    }
  }
})

test('the component TTL answers from one real probe, and the forced write probe bypasses it', (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const cli = createFakeTmuxCli(t)
  try {
    const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
    const baseline = cli.calls().length
    assert.equal(admission.isAllowed(false), true)
    assert.equal(cli.calls().length, baseline + 3, 'one probe is three queries')
    assert.equal(admission.isAllowed(false), true)
    assert.equal(cli.calls().length, baseline + 3, 'a second render inside the TTL spawns nothing')

    t.mock.timers.tick(251)
    assert.equal(admission.isAllowed(false), true)
    assert.equal(cli.calls().length, baseline + 6, 'the expired TTL re-checks the real server')

    assert.equal(admission.isAllowed(true), true)
    assert.equal(cli.calls().length, baseline + 9, 'force always bypasses the cache')
  } finally {
    cli.dispose()
  }
})

test('a change inside the short TTL is invisible to render but fatal to the next managed write', (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const cli = createFakeTmuxCli(t)
  try {
    const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
    assert.equal(admission.isAllowed(false), true)
    cli.setReply('show-options', { text: 'off\n' })
    assert.equal(admission.isAllowed(false), true, 'the 250 ms window is the documented non-atomic boundary')
    assert.equal(admission.isAllowed(true), false, 'the physical-write probe sees the real server')
    assert.equal(admission.isAllowed(false), false, 'and the latch holds for every later render')
  } finally {
    cli.dispose()
  }
})

test('admission never grants after the opt-in itself disappears', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
    assert.equal(admission.isAllowed(true), true)
    delete cli.env.PI_TUI_TMUX_KITTY_IMAGES
    assert.equal(admission.isAllowed(true), false)
    cli.env.PI_TUI_TMUX_KITTY_IMAGES = '1'
    assert.equal(admission.isAllowed(true), false, 'even a restored opt-in cannot re-admit the same handle')
  } finally {
    cli.dispose()
  }
})
