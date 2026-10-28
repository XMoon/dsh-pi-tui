/**
 * Image-7B-A / Image-7C-1 — strict tmux + Kitty admission.
 *
 * 7C-1 changed the environment gate: an UNSET opt-in and the exact value `1`
 * both attempt the same live-server probe; `0` and every other value deny
 * before any subprocess runs.
 *
 * Evidence level: every decision here is derived from the RAW stdout of a real
 * `execFileSync('tmux', fixedArgv, …)` call (a scripted executable on PATH),
 * never from a precomputed `allowed` flag. The real isolated-server + real
 * Kitty GUI positive is the separate E3 qualification.
 * @module @xmoon76/dsh-pi-tui/tui/tmux-kitty-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { StdinBuffer } from '@xmoon76/pi-tui'
import {
  TmuxKittyAdmission,
  probeTmuxKittyIdentity,
  tmuxKittyHasKnownUnicodePlaceholders,
  type TmuxKittyIdentity,
} from '../../src/tui/graphics/tmux-admission.ts'
import {
  TMUX_FEATURE_PROBE_TIMEOUT_MS,
  TmuxKittyFeatureProbe,
  tmuxFeatureQueryWire,
} from '../../src/tui/graphics/tmux-kitty-feature-probe.ts'
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
      'list-clients -F #{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}\t#{client_control_mode}',
    ], 'the probe uses the fixed argv and never a shell')
  } finally {
    cli.dispose()
  }
})

test('the live client report distinguishes known U1 evidence from an unknown renderer', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\n' })
    const bareKitty = probeTmuxKittyIdentity(cli.env)
    assert.ok(bareKitty, 'a bare Kitty termtype is still a valid server identity')
    assert.equal(tmuxKittyHasKnownUnicodePlaceholders(bareKitty), true, 'bare Kitty is known U1 evidence')

    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\tkitty(0.41.1)\t0\n' })
    const fallbackTermnameKitty = probeTmuxKittyIdentity(cli.env)
    assert.ok(fallbackTermnameKitty, 'Kitty with a generic terminfo is still a valid server identity')
    assert.equal(tmuxKittyHasKnownUnicodePlaceholders(fallbackTermnameKitty), true,
      'the live XTVERSION Kitty identity is sufficient; client_termname is not a brand condition')

    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty-direct\t0\n' })
    const derivedKitty = probeTmuxKittyIdentity(cli.env)
    assert.ok(derivedKitty, 'a derived termtype is an identity, not a server rejection')
    assert.equal(tmuxKittyHasKnownUnicodePlaceholders(derivedKitty), false, 'a kitty-derived family is not Kitty itself')

    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-ghostty\tghostty 1.4.0\t0\n' })
    const ghostty = probeTmuxKittyIdentity(cli.env)
    assert.ok(ghostty)
    assert.equal(tmuxKittyHasKnownUnicodePlaceholders(ghostty), true,
      'Ghostty XTVERSION uses a space, not a parentheses version')

    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\tghostty 1.4.0\t0\n' })
    const fallbackTermnameGhostty = probeTmuxKittyIdentity(cli.env)
    assert.ok(fallbackTermnameGhostty)
    assert.equal(tmuxKittyHasKnownUnicodePlaceholders(fallbackTermnameGhostty), true,
      'the live XTVERSION Ghostty identity is sufficient with a generic terminfo fallback')

    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\twezterm 20240203\t0\n' })
    const unknown = probeTmuxKittyIdentity(cli.env)
    assert.ok(unknown, 'an unknown renderer reaches the feature probe instead of being rejected')
    assert.equal(tmuxKittyHasKnownUnicodePlaceholders(unknown), false)
  } finally {
    cli.dispose()
  }
})

test('every environment gate rejects BEFORE any tmux command is spawned', (t) => {
  const cases: ReadonlyArray<{ name: string; mutate: (env: NodeJS.ProcessEnv) => void }> = [
    { name: 'opt-in 0', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = '0' } },
    { name: 'opt-in empty', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = '' } },
    { name: 'opt-in true', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = 'true' } },
    { name: 'opt-in auto', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = 'auto' } },
    { name: 'opt-in false', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = 'false' } },
    { name: 'opt-in trailing space', mutate: (env) => { env.PI_TUI_TMUX_KITTY_IMAGES = '1 ' } },
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

test('an unset opt-in attempts the strict admission automatically', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    delete cli.env.PI_TUI_TMUX_KITTY_IMAGES
    assert.deepEqual(probeTmuxKittyIdentity(cli.env), {
      paneId: '%7',
      sessionName: 'work',
      clientName: 'main',
      clientTty: '/dev/pts/12',
      clientTermname: 'xterm-kitty',
      clientTermtype: 'kitty(0.41.1)',
    }, 'without the variable the automatic attempt reaches the real server')
    assert.deepEqual(cli.calls(), [
      'show-options -Apqv -t %7 allow-passthrough',
      'display-message -p -t %7 #{session_name}',
      'list-clients -F #{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}\t#{client_control_mode}',
    ], 'the automatic attempt runs the same fixed argv')
  } finally {
    cli.dispose()
  }
})

test('the explicit 1 uses the identical admission flow and never forces it', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    assert.equal(cli.env.PI_TUI_TMUX_KITTY_IMAGES, '1')
    assert.deepEqual(probeTmuxKittyIdentity(cli.env), {
      paneId: '%7',
      sessionName: 'work',
      clientName: 'main',
      clientTty: '/dev/pts/12',
      clientTermname: 'xterm-kitty',
      clientTermtype: 'kitty(0.41.1)',
    }, 'the configured opt-in keeps working')
    assert.deepEqual(cli.calls(), [
      'show-options -Apqv -t %7 allow-passthrough',
      'display-message -p -t %7 #{session_name}',
      'list-clients -F #{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}\t#{client_control_mode}',
    ], '1 runs the same three fixed queries')
    cli.setReply('show-options', { text: 'on\n' })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined, '1 does not turn on into all')
    assert.equal(cli.calls().length, 4, 'the refused option stops after its own first query')
    cli.setReply('show-options', { text: 'all\n' })
    cli.setReply('list-clients', {
      text: 'a\t/dev/pts/1\twork\txterm-kitty\tkitty(0.41.1)\t0\nb\t/dev/pts/2\twork\txterm-kitty\tkitty(0.41.1)\t0\n',
    })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined, '1 does not admit a second client')
    assert.equal(cli.calls().length, 7, 'the two-client attempt ran exactly its three fixed queries')
  } finally {
    cli.dispose()
  }
})

test('an unset opt-in outside tmux spawns no probe', (t) => {
  for (const key of ['TMUX', 'TMUX_PANE'] as const) {
    const cli = createFakeTmuxCli(t)
    try {
      delete cli.env.PI_TUI_TMUX_KITTY_IMAGES
      delete cli.env[key]
      assert.equal(probeTmuxKittyIdentity(cli.env), undefined, `${key} absent`)
      assert.deepEqual(cli.calls(), [], `${key}: the automatic attempt still requires a tmux pane`)
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

test('exactly one matching, non-empty ordinary display client is required', (t) => {
  const cases: ReadonlyArray<{ name: string; text: string }> = [
    { name: 'no client', text: '' },
    {
      name: 'two ordinary display clients',
      text: 'a\t/dev/pts/1\twork\txterm-kitty\tkitty(0.41.1)\t0\nb\t/dev/pts/2\twork\txterm-kitty\tkitty(0.41.1)\t0\n',
    },
    { name: 'only a Control Mode client', text: 'client-3383511\t\twork\tunknown\t\t1\n' },
    { name: 'session mismatch', text: 'main\t/dev/pts/12\tother\txterm-kitty\tkitty(0.41.1)\t0\n' },
    { name: 'empty client name', text: '\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n' },
    { name: 'empty client tty', text: 'main\t\twork\txterm-kitty\tkitty(0.41.1)\t0\n' },
    { name: 'missing termtype and control columns', text: 'main\t/dev/pts/12\twork\txterm-kitty\n' },
    { name: 'missing control column', text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\n' },
    { name: 'empty control column', text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t\n' },
    { name: 'unknown control value', text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t2\n' },
    { name: 'malformed control record', text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\textra\n' },
    {
      name: 'one display plus a malformed control record',
      text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\nclient-1\t\t\tunknown\t\n',
    },
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

test('one ordinary display client coexists with any number of Control Mode clients', (t) => {
  const reports = [
    // The real tmux 3.5a shape: the Control Mode client reports an empty TTY
    // and an `unknown` terminal name/type, yet control=1 already excludes it.
    'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\nclient-3383511\t\twork\tunknown\t\t1\n',
    'client-3383511\t\twork\tunknown\t\t1\nmain\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n',
    'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\nclient-1\t\t\t\t\t1\nclient-2\t\t\tunknown\t\t1\n',
  ]
  for (const text of reports) {
    const cli = createFakeTmuxCli(t)
    try {
      cli.setReply('list-clients', { text })
      assert.deepEqual(probeTmuxKittyIdentity(cli.env), {
        paneId: '%7',
        sessionName: 'work',
        clientName: 'main',
        clientTty: '/dev/pts/12',
        clientTermname: 'xterm-kitty',
        clientTermtype: 'kitty(0.41.1)',
      }, text)
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
      text: `main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n${'x'.repeat(70 * 1024)}\n`,
    })
    assert.equal(probeTmuxKittyIdentity(cli.env), undefined)
  } finally {
    cli.dispose()
  }
})

test('a failing list-clients query is not an admission', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    cli.setReply('list-clients', {
      text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n',
      exitCode: 1,
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
    cli.setReply('list-clients', { text: 'main\t/dev/pts/99\twork\txterm-kitty\tkitty(0.41.1)\t0\n' })
    assert.equal(admission.isAllowed(true), false, 'a changed tty revokes the handle')
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n' })
    assert.equal(admission.isAllowed(true), false, 'the revocation is a one-way latch')
    assert.equal(admission.isAllowed(false), false)
  } finally {
    cli.dispose()
  }
})

test('Control Mode clients joining and leaving never revoke the ordinary display binding', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
    const display = 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n'
    const control = 'client-3383511\t\twork\tunknown\t\t1\n'
    const secondControl = 'client-1\t\t\t\t\t1\n'
    assert.equal(admission.isAllowed(true), true)
    cli.setReply('list-clients', { text: display + control })
    assert.equal(admission.isAllowed(true), true, 'a Control Mode client joining does not revoke')
    cli.setReply('list-clients', { text: control + display + secondControl })
    assert.equal(admission.isAllowed(true), true, 'multiple Control Mode clients do not revoke')
    cli.setReply('list-clients', { text: display })
    assert.equal(admission.isAllowed(true), true, 'Control Mode clients leaving do not revoke')
  } finally {
    cli.dispose()
  }
})

test('a second ordinary display client revokes even next to Control Mode clients', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
    assert.equal(admission.isAllowed(true), true)
    cli.setReply('list-clients', {
      text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n'
        + 'other\t/dev/pts/13\twork\txterm-kitty\tkitty(0.41.1)\t0\n'
        + 'client-3383511\t\twork\tunknown\t\t1\n',
    })
    assert.equal(admission.isAllowed(true), false, 'a second ordinary display client revokes')
    cli.setReply('list-clients', {
      text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\nclient-3383511\t\twork\tunknown\t\t1\n',
    })
    assert.equal(admission.isAllowed(true), false, 'the revocation is one-way')
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
        cli.setReply('list-clients', { text: 'main\t/dev/pts/12\trenamed\txterm-kitty\tkitty(0.41.1)\t0\n' })
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

test('a one-way latch survives an explicit opt-out and a restored opt-in', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    const admission = new TmuxKittyAdmission(admitted(cli), cli.env)
    assert.equal(admission.isAllowed(true), true)
    cli.env.PI_TUI_TMUX_KITTY_IMAGES = '0'
    assert.equal(admission.isAllowed(true), false, 'an explicit opt-out revokes the live handle')
    cli.env.PI_TUI_TMUX_KITTY_IMAGES = '1'
    assert.equal(admission.isAllowed(true), false, 'even a restored opt-in cannot re-admit the same handle')
  } finally {
    cli.dispose()
  }
})

test('a pending U1 gate still observes the live identity and keeps pixels text-only', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    const identity = admitted(cli)
    let featureReady = false
    const admission = new TmuxKittyAdmission(identity, cli.env, () => featureReady)
    const baseline = cli.calls().length
    assert.equal(admission.isAllowed(false), false, 'pending feature proof is text-only')
    assert.equal(cli.calls().length, baseline + 3, 'pending still observes the live client identity')

    featureReady = true
    assert.equal(admission.isAllowed(false), true, 'the live identity is already current when the feature gate allows')

    cli.setReply('show-options', { text: 'on\n' })
    assert.equal(admission.isAllowed(true), false, 'the identity revoke still works after the feature gate')
  } finally {
    cli.dispose()
  }
})

test('a pending feature gate revokes when the live client changes', (t) => {
  const cli = createFakeTmuxCli(t)
  try {
    const identity = admitted(cli)
    const admission = new TmuxKittyAdmission(identity, cli.env, () => false)
    assert.equal(admission.isAllowed(false), false)
    cli.setReply('list-clients', { text: 'main\t/dev/pts/99\twork\txterm-256color\twezterm 20240203\t0\n' })
    assert.equal(admission.isAllowed(false), false, 'the pending gate never reports pixels')
    assert.equal(admission.isIdentityAllowed(true), false, 'the changed live client latched the revoke')
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n' })
    assert.equal(admission.isAllowed(true), false, 'the revoke is one-way')
  } finally {
    cli.dispose()
  }
})

test('a live outer tmux/screen client is a transport boundary, not a feature-probe candidate', (t) => {
  const cases = [
    'main\t/dev/pts/12\twork\ttmux-256color\t\t0\n',
    'main\t/dev/pts/12\twork\tscreen-256color\t\t0\n',
    'main\t/dev/pts/12\twork\txterm-256color\ttmux 3.5a\t0\n',
    'main\t/dev/pts/12\twork\txterm-256color\tscreen 4.9\t0\n',
  ]
  for (const text of cases) {
    const cli = createFakeTmuxCli(t)
    try {
      cli.setReply('list-clients', { text })
      assert.equal(probeTmuxKittyIdentity(cli.env), undefined, text)
    } finally {
      cli.dispose()
    }
  }
})

const PROBE_ID = 0x90000001

function probeReply(probe: TmuxKittyFeatureProbe, controls = 'e=T,U=1', payload = 'OK'): string {
  return `\x1b_Gi=${probe.probeId}${controls === '' ? '' : `,${controls}`};${payload}\x1b\\`
}

test('the U1 probe sends one exact feature query after input starts and promotes once', () => {
  const sent: string[] = []
  let allowed = 0
  const probe = new TmuxKittyFeatureProbe(() => { allowed += 1 }, PROBE_ID)
  assert.equal(probe.allowed, false, 'a fresh probe is pending')

  probe.markInputStarted()
  probe.start(() => sent.push(probe.probeWire))
  assert.deepEqual(sent, [tmuxFeatureQueryWire(PROBE_ID)], 'the exact e=T,U=1 feature query is sent once')
  probe.start(() => sent.push('second'))
  assert.equal(sent.length, 1, 'a repeated start never sends a second query')

  assert.equal(probe.consume(probeReply(probe, 'e=T,C=1,U=1')), true)
  assert.equal(probe.allowed, true, 'the matching e=T,U=1;OK reply promotes')
  assert.equal(allowed, 1, 'onAllowed fires exactly once')
  assert.equal(probe.consume(probeReply(probe)), true, 'a duplicate reply is still consumed')
  assert.equal(allowed, 1, 'a duplicate reply never promotes twice')
  probe.dispose()
})

test('a base Kitty OK or an incomplete feature reply permanently denies the U1 probe', () => {
  const replies = [
    probeReplyWith(PROBE_ID, '', 'OK'),
    probeReplyWith(PROBE_ID, 'e=T', 'OK'),
    probeReplyWith(PROBE_ID, 'U=1', 'OK'),
    probeReplyWith(PROBE_ID, 'e=T,U=1', 'ENOTSUPPORTED:disabled'),
  ]
  for (const reply of replies) {
    let allowed = 0
    const probe = new TmuxKittyFeatureProbe(() => { allowed += 1 }, PROBE_ID)
    probe.markInputStarted()
    probe.start(() => {})
    assert.equal(probe.consume(reply), true, reply)
    assert.equal(probe.allowed, false, `denied by ${reply}`)
    assert.equal(allowed, 0)
    assert.equal(probe.consume(probeReply(probe)), true, 'a late valid reply is consumed')
    assert.equal(probe.allowed, false, 'denial is one-way')
    probe.dispose()
  }
})

function probeReplyWith(id: number, controls: string, payload: string): string {
  return `\x1b_Gi=${id}${controls === '' ? '' : `,${controls}`};${payload}\x1b\\`
}

test('a wrong-id feature reply reaches the screen while a matching reply is consumed', () => {
  const first = new TmuxKittyFeatureProbe(undefined, 0x90000002)
  const second = new TmuxKittyFeatureProbe(undefined, 0x90000003)
  first.markInputStarted()
  second.markInputStarted()
  first.start(() => {})
  second.start(() => {})
  assert.equal(second.consume(probeReply(first)), false, 'another handle’s id is not this probe’s reply')
  assert.equal(second.allowed, false)
  assert.equal(second.consume(probeReply(second)), true)
  assert.equal(second.allowed, true)
  first.dispose()
  second.dispose()
})

test('a feature reply observed under a changed client denies before promotion', () => {
  let allowed = 0
  const probe = new TmuxKittyFeatureProbe(() => { allowed += 1 }, PROBE_ID)
  probe.markInputStarted()
  probe.start(() => {})
  assert.equal(probe.consume(probeReply(probe), () => false), true)
  assert.equal(probe.allowed, false, 'the changed identity denies the feature evidence')
  assert.equal(allowed, 0)
  assert.equal(probe.consume(probeReply(probe)), true)
  assert.equal(probe.allowed, false, 'the denial is one-way')
  probe.dispose()
})

test('an unanswered U1 probe denies at the bounded window and a late OK never promotes', async () => {
  let allowed = 0
  const probe = new TmuxKittyFeatureProbe(() => { allowed += 1 }, PROBE_ID)
  probe.markInputStarted()
  probe.start(() => {})
  await new Promise(resolve => setTimeout(resolve, TMUX_FEATURE_PROBE_TIMEOUT_MS + 60))
  assert.equal(probe.allowed, false, 'no answer leaves the handle text-only')
  assert.equal(probe.consume(probeReply(probe)), true)
  assert.equal(probe.allowed, false, 'the timeout denial is permanent')
  assert.equal(allowed, 0)
  probe.dispose()
})

test('a throwing feature query denies immediately and preserves the real failure', () => {
  const probe = new TmuxKittyFeatureProbe(undefined, PROBE_ID)
  probe.markInputStarted()
  assert.throws(() => probe.start(() => { throw new Error('feature write failed') }), /feature write failed/)
  assert.equal(probe.allowed, false)
  probe.start(() => {})
  assert.equal(probe.allowed, false, 'a denied probe never retries')
  probe.dispose()
})

test('a screen stop clears inputListening but keeps the one-way U1 admission', () => {
  let sends = 0
  const probe = new TmuxKittyFeatureProbe(undefined, PROBE_ID)
  probe.markInputStarted()
  probe.start(() => { sends += 1 })
  assert.equal(probe.consume(probeReply(probe)), true)
  probe.markInputStopped()
  assert.equal(probe.allowed, true, 'the one-way feature admission survives a screen stop')
  assert.equal(probe.inputListening, false, 'the stopped screen no longer owns an input listener')
  probe.markInputStarted()
  probe.start(() => { sends += 1 })
  assert.equal(probe.allowed, true, 'restart keeps the same admission')
  assert.equal(sends, 1, 'restart never sends a second query')
  probe.dispose()
})

test('StdinBuffer rebuilds a split U1 feature reply into one consumed sequence', () => {
  const probe = new TmuxKittyFeatureProbe(undefined, PROBE_ID)
  probe.markInputStarted()
  probe.start(() => {})
  const buffer = new StdinBuffer()
  const consumed: string[] = []
  buffer.on('data', sequence => {
    if (probe.consume(sequence)) consumed.push(sequence)
  })
  for (const chunk of ['\x1b', '_G', 'i=', String(PROBE_ID), ',e=T,U=1;OK', '\x1b\\']) {
    buffer.process(chunk)
  }
  assert.deepEqual(consumed, [probeReply(probe)], 'the real stdin framing completes the feature reply')
  assert.equal(probe.allowed, true)
  buffer.process('a')
  assert.deepEqual(consumed, [probeReply(probe)], 'ordinary input still reaches the screen')
  buffer.destroy()
  probe.dispose()
})
