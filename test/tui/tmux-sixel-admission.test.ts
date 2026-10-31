/**
 * Image-8 / I8-4 — strict native tmux SIXEL admission.
 *
 * Evidence level: every decision here is derived from the RAW stdout of a real
 * `execFileSync('tmux', fixedArgv, …)` call (a scripted executable on PATH),
 * never from a precomputed `admitted` flag. The real isolated-server + real
 * outer-terminal positive is the separate physical smoke.
 * @module @xmoon76/dsh-pi-tui/tui/tmux-sixel-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createFakeTmuxCli, type FakeTmuxCli } from '../support/fake-tmux-cli.ts'
import {
  TmuxSixelAdmission,
  probeTmuxSixelIdentity,
  tmuxSixelFlagReportAllows,
  type TmuxSixelIdentity,
} from '../../src/tui/graphics/tmux-sixel-admission.ts'
import { createTmuxSixelGraphics, TmuxSixelTerminal } from '../../src/tui/graphics/tmux-sixel.ts'
import { TmuxGraphicsRevokedError } from '../../src/tui/graphics/kitty-terminal.ts'

const LIST_CLIENTS_ARGV = [
  'list-clients',
  '-F',
  '#{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}\t#{client_control_mode}',
]
const SHOW_MESSAGES_ARGV = ['show-messages', '-T', '-t', 'main']
const SIXEL_SUPPORT_ARGV = ['display-message', '-p', '-t', '%7', '#{sixel_support}']
const SESSION_ARGV = ['display-message', '-p', '-t', '%7', '#{session_name}']

function createSixelFakeTmuxCli(t: test.TestContext): FakeTmuxCli {
  const cli = createFakeTmuxCli(t)
  cli.setArgvReply(SIXEL_SUPPORT_ARGV, { text: '1\n' })
  cli.setReply('show-messages', { text: '  1: Sxl: (flag) true\n' })
  return cli
}

function admitted(cli: FakeTmuxCli): TmuxSixelIdentity {
  const identity = probeTmuxSixelIdentity(cli.env)
  assert.ok(identity, 'the default fake server is the one admitted topology')
  return identity
}

test('N01: the real CLI probe reads the one trusted server/client/Sxl topology', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    assert.deepEqual(probeTmuxSixelIdentity(cli.env), {
      paneId: '%7',
      sessionName: 'work',
      clientName: 'main',
      clientTty: '/dev/pts/12',
      clientTermname: 'xterm-kitty',
      clientTermtype: 'kitty(0.41.1)',
    })
    assert.deepEqual(cli.calls(), [
      'display-message -p -t %7 #{session_name}',
      'display-message -p -t %7 #{sixel_support}',
      'list-clients -F #{client_name}\t#{client_tty}\t#{client_session}\t#{client_termname}\t#{client_termtype}\t#{client_control_mode}',
      'show-messages -T -t main',
    ], 'the probe uses the fixed argv and never a shell')
  } finally {
    cli.dispose()
  }
})

test('N02: the server SIXEL compilation report must be exactly 1', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    for (const [name, reply] of [
      ['zero', { text: '0\n' }],
      ['empty', { text: '\n' }],
      ['unknown', { text: 'unknown\n' }],
      ['missing', { text: '' }],
      ['duplicate', { text: '1\n1\n' }],
      ['nonzero exit', { text: '', exitCode: 1 }],
    ] as const) {
      cli.setArgvReply(SIXEL_SUPPORT_ARGV, reply)
      assert.equal(probeTmuxSixelIdentity(cli.env), undefined, name)
    }
  } finally {
    cli.dispose()
  }
})

test('N03: only one complete Sxl (flag) true line admits; decoys and duplicates fail', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const rejected = [
      '  1: Sxl: (flag) false\n',
      'no messages\n',
      '  1: X-Sxl: (flag) true\n',
      '  1: Sxl true-ish\n',
      '  1: Sxl: (flag) true\n  2: Sxl: (flag) true\n',
      '  1: Sxl: (flag) tr',
      '  1: Sxl: (flag) true-ish\n',
    ]
    for (const report of rejected) {
      cli.setReply('show-messages', { text: report })
      assert.equal(probeTmuxSixelIdentity(cli.env), undefined, JSON.stringify(report))
    }
    assert.equal(tmuxSixelFlagReportAllows('  1: Sxl: (flag) true\n'), true)
    assert.equal(tmuxSixelFlagReportAllows('  1: Sxl: (flag) true\n  2: RGB: (flag) true\n'), true,
      'unrelated message lines do not compete with the one Sxl result')
  } finally {
    cli.dispose()
  }
})

test('N04: exactly one ordinary display client must own the pane session', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    cli.setReply('list-clients', { text: '' })
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'zero display clients')

    cli.setReply('list-clients', {
      text: 'a\t/dev/pts/1\twork\txterm-kitty\tkitty\t0\nb\t/dev/pts/2\twork\txterm-kitty\tkitty\t0\n',
    })
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'two display clients, same session')

    cli.setReply('list-clients', {
      text: 'a\t/dev/pts/1\twork\txterm-kitty\tkitty\t0\nb\t/dev/pts/2\tother\txterm-kitty\tkitty\t0\n',
    })
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'two display clients, different sessions')

    cli.setReply('list-clients', { text: 'a\t/dev/pts/1\tother\txterm-kitty\tkitty\t0\n' })
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'the one client belongs to another session')
  } finally {
    cli.dispose()
  }
})

test('N05: Control Mode clients are observed, never counted as display clients', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    cli.setReply('list-clients', {
      text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\n'
        + 'control-a\t/dev/pts/20\twork\txterm-256color\txterm\t1\n'
        + 'control-b\t/dev/pts/21\tother\txterm-256color\txterm\t1\n',
    })
    assert.deepEqual(probeTmuxSixelIdentity(cli.env), {
      paneId: '%7',
      sessionName: 'work',
      clientName: 'main',
      clientTty: '/dev/pts/12',
      clientTermname: 'xterm-kitty',
      clientTermtype: 'kitty',
    })
    const identity = admitted(cli)
    const admission = new TmuxSixelAdmission(identity, cli.env)
    assert.equal(admission.isAllowed(true), true, 'the ordinary display client is the binding')
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\n' })
    assert.equal(admission.isAllowed(true), true, 'a control client leaving does not revoke')
    cli.setReply('list-clients', {
      text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\ncontrol\t/dev/pts/30\tother\txterm\txterm\t1\n',
    })
    assert.equal(admission.isAllowed(true), true, 'a control client joining does not revoke')
  } finally {
    cli.dispose()
  }
})

test('N06: the whole list-clients report must be strict six-column records', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const rejected = [
      'main\t/dev/pts/12\twork\txterm-kitty\tkitty\n',
      'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\textra\n',
      'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t\n',
      'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t2\n',
      'main\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\n\n',
      '\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\n',
      'main\t\twork\txterm-kitty\tkitty\t0\n',
    ]
    for (const report of rejected) {
      cli.setReply('list-clients', { text: report })
      assert.equal(probeTmuxSixelIdentity(cli.env), undefined, JSON.stringify(report))
    }
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\ttmux-256color\ttmux 3.5a\t0\n' })
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'a nested tmux client is not this transport')
    // A real Windows Terminal client may have no XTVERSION termtype; Sxl is the
    // effective client evidence and the empty identity field stays part of the
    // immutable binding.
    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\t\t\t0\n' })
    assert.deepEqual(probeTmuxSixelIdentity(cli.env), {
      paneId: '%7',
      sessionName: 'work',
      clientName: 'main',
      clientTty: '/dev/pts/12',
      clientTermname: '',
      clientTermtype: '',
    }, 'empty optional terminal-description fields are valid when Sxl is proven')
  } finally {
    cli.dispose()
  }
})

test('N07: a live client identity change permanently revokes the handle', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const identity = admitted(cli)
    for (const report of [
      'other\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\n',
      'main\t/dev/pts/99\twork\txterm-kitty\tkitty\t0\n',
      'main\t/dev/pts/12\twork\txterm-256color\tkitty\t0\n',
      'main\t/dev/pts/12\twork\txterm-kitty\twezterm(1.0)\t0\n',
    ]) {
      const admission = new TmuxSixelAdmission(identity, cli.env)
      assert.equal(admission.isAllowed(true), true, 'the initial binding is live')
      cli.setReply('list-clients', { text: report })
      assert.equal(admission.isAllowed(true), false, report)
      cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-kitty\tkitty(0.41.1)\t0\n' })
      assert.equal(admission.isAllowed(true), false, 'recovering the old string never revives the handle')
    }
  } finally {
    cli.dispose()
  }
})

test('N08: lost server SIXEL support or Sxl is a one-way revoke', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const identity = admitted(cli)

    const sxlAdmission = new TmuxSixelAdmission(identity, cli.env)
    assert.equal(sxlAdmission.isAllowed(true), true)
    cli.setReply('show-messages', { text: '  1: Sxl: (flag) false\n' })
    assert.equal(sxlAdmission.isAllowed(true), false)
    cli.setReply('show-messages', { text: '  1: Sxl: (flag) true\n' })
    assert.equal(sxlAdmission.isAllowed(true), false, 'Sxl true again never revives')

    cli.setArgvReply(SIXEL_SUPPORT_ARGV, { text: '1\n' })
    const supportAdmission = new TmuxSixelAdmission(identity, cli.env)
    assert.equal(supportAdmission.isAllowed(true), true)
    cli.setArgvReply(SIXEL_SUPPORT_ARGV, { text: '0\n' })
    assert.equal(supportAdmission.isAllowed(true), false)
    cli.setArgvReply(SIXEL_SUPPORT_ARGV, { text: '1\n' })
    assert.equal(supportAdmission.isAllowed(true), false, 'server support returning never revives')
  } finally {
    cli.dispose()
  }
})

test('N09: missing binary, non-zero exit, timeout and overflow all deny', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    assert.equal(probeTmuxSixelIdentity({ ...cli.env, PATH: '/nonexistent' }), undefined, 'missing binary')

    cli.setArgvReply(SESSION_ARGV, { text: 'work\n', exitCode: 1 })
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'non-zero exit')

    cli.setArgvReply(SESSION_ARGV, { text: 'work\n', delayMs: 2_000 })
    const started = performance.now()
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'timeout')
    assert.ok(performance.now() - started >= 400, 'the 500 ms production timeout really aborts the probe')

    cli.setArgvReply(SESSION_ARGV, { text: 'x'.repeat(70 * 1024) })
    assert.equal(probeTmuxSixelIdentity(cli.env), undefined, 'output overflow')
  } finally {
    cli.dispose()
  }
})

test('N10: environment gates reject before any tmux subprocess', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const cases: ReadonlyArray<{ name: string; mutate: (env: NodeJS.ProcessEnv) => void }> = [
      { name: 'protocol none', mutate: (env) => { env.PI_IMAGE_PROTOCOL = 'none' } },
      { name: 'protocol 0', mutate: (env) => { env.PI_IMAGE_PROTOCOL = '0' } },
      { name: 'protocol kitty', mutate: (env) => { env.PI_IMAGE_PROTOCOL = 'kitty' } },
      { name: 'protocol iterm2', mutate: (env) => { env.PI_IMAGE_PROTOCOL = 'iterm2' } },
      { name: 'TMUX missing', mutate: (env) => { delete env.TMUX } },
      { name: 'TMUX empty', mutate: (env) => { env.TMUX = '' } },
      { name: 'TMUX_PANE missing', mutate: (env) => { delete env.TMUX_PANE } },
      { name: 'TMUX_PANE empty', mutate: (env) => { env.TMUX_PANE = '' } },
      { name: 'TERM not tmux', mutate: (env) => { env.TERM = 'xterm-256color' } },
      { name: 'Zellij', mutate: (env) => { env.ZELLIJ = '1' } },
      { name: 'GNU screen', mutate: (env) => { env.STY = '1' } },
      { name: 'Herdr', mutate: (env) => { env.TERM_PROGRAM = 'herdr' } },
    ]
    for (const entry of cases) {
      const env = { ...cli.env }
      entry.mutate(env)
      assert.equal(probeTmuxSixelIdentity(env), undefined, entry.name)
      assert.deepEqual(cli.calls(), [], `${entry.name}: no tmux subprocess may run`)
    }
    const emptyMarkers = { ...cli.env, ZELLIJ: '', STY: '' }
    assert.ok(probeTmuxSixelIdentity(emptyMarkers), 'empty multiplexer markers are not sessions')
  } finally {
    cli.dispose()
  }
})

test('N10b: explicit sixel admits native SIXEL without any tmux Kitty probe', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const env = { ...cli.env, PI_IMAGE_PROTOCOL: 'sixel' }
    const identity = probeTmuxSixelIdentity(env)
    assert.ok(identity, 'the live server/client/Sxl facts still decide')
    assert.equal(cli.calls().some(line => line.startsWith('show-options')), false,
      'the Kitty-specific passthrough probe never runs')
    const graphics = createTmuxSixelGraphics(new VirtualTerminal(), env)
    assert.ok(graphics)
    assert.equal(graphics.mode, 'sixel')
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})

test('N10c: explicit kitty never falls back to native SIXEL', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const graphics = createTmuxSixelGraphics(new VirtualTerminal(), {
      ...cli.env,
      PI_IMAGE_PROTOCOL: 'kitty',
    })
    assert.equal(graphics, undefined, 'SIXEL is denied by the explicit kitty choice')
    assert.equal(cli.calls().some(line => line.includes('#{sixel_support}')), false,
      'no native SIXEL eligibility query runs')
  } finally {
    cli.dispose()
  }
})

test('N10d: an invalid PI_IMAGE_PROTOCOL is a startup error before any tmux query', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    assert.throws(
      () => probeTmuxSixelIdentity({ ...cli.env, PI_IMAGE_PROTOCOL: 'sixelx' }),
      /Invalid PI_IMAGE_PROTOCOL/u,
    )
    assert.deepEqual(cli.calls(), [])
  } finally {
    cli.dispose()
  }
})

test('N11: known-U1 tmux Kitty keeps precedence; a real Sxl outranks a pending U1 probe', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const knownKitty = createTmuxSixelGraphics(new VirtualTerminal(), cli.env)
    assert.equal(knownKitty, undefined, 'a known Kitty/Ghostty U1 client keeps the tmux virtual transport')
    assert.equal(cli.calls().some((line) => line.startsWith('show-messages')), false,
      'the native SIXEL probe never runs after a trustworthy U1 positive')
    assert.equal(cli.calls().some((line) => line.includes('#{sixel_support}')), false)

    cli.setReply('list-clients', { text: 'main\t/dev/pts/12\twork\txterm-256color\txterm(1.0)\t0\n' })
    const assertedKitty = createTmuxSixelGraphics(new VirtualTerminal(), {
      ...cli.env,
      PI_TUI_TMUX_KITTY_PLACEHOLDERS: '1',
    })
    assert.equal(assertedKitty, undefined, 'the explicit U1 assertion keeps Kitty precedence')

    const sixel = createTmuxSixelGraphics(new VirtualTerminal(), cli.env)
    assert.ok(sixel, 'an unknown renderer with a real Sxl gets the native SIXEL handle')
    assert.equal(sixel.mode, 'sixel')
    sixel.dispose()
  } finally {
    cli.dispose()
  }
})

test('N12: the 250 ms render cache is bypassed by the forced DCS write probe', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const identity = admitted(cli)
    const admission = new TmuxSixelAdmission(identity, cli.env)
    let revokes = 0
    admission.observe(() => { revokes += 1 })

    assert.equal(admission.isAllowed(false), true)
    cli.setReply('list-clients', { text: 'other\t/dev/pts/12\twork\txterm-kitty\tkitty\t0\n' })
    assert.equal(admission.isAllowed(false), true, 'the short render cache may answer the old binding')
    assert.equal(admission.isAllowed(true), false, 'the forced write probe catches the changed identity')
    assert.equal(admission.isAllowed(false), false, 'revocation is latched')
    assert.equal(revokes, 1, 'one revoke callback, never a repaint loop')
  } finally {
    cli.dispose()
  }
})

test('N13: PI_TUI_TMUX_KITTY_IMAGES=0 disables only the virtual Kitty transport', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const env = { ...cli.env, PI_TUI_TMUX_KITTY_IMAGES: '0' }
    const graphics = createTmuxSixelGraphics(new VirtualTerminal(), env)
    assert.ok(graphics, 'the native SIXEL route remains eligible')
    assert.equal(graphics.mode, 'sixel')
    assert.equal(cli.calls().some((line) => line.startsWith('show-options')), false,
      'the disabled Kitty probe never runs; only the server SIXEL facts were queried')
    graphics.dispose()
  } finally {
    cli.dispose()
  }
})

test('N14: an unregistered managed-looking DCS writes zero bytes and never bypasses the write gate', (t) => {
  const cli = createSixelFakeTmuxCli(t)
  try {
    const identity = admitted(cli)
    const admittedFacade = new TmuxSixelTerminal(new VirtualTerminal(), new TmuxSixelAdmission(identity, cli.env), () => false)
    assert.throws(
      () => admittedFacade.write('\x1bP0;1;q#0;2;100;0;0#0~~\x1b\\'),
      (error) => error instanceof TmuxGraphicsRevokedError,
      'an unregistered complete DCS is a refusal, not ordinary text',
    )
    assert.deepEqual((admittedFacade as unknown as { inner: VirtualTerminal }).inner.writes, [],
      'the refused complete DCS wrote zero bytes')

    const splitFacade = new TmuxSixelTerminal(new VirtualTerminal(), new TmuxSixelAdmission(identity, cli.env), () => false)
    splitFacade.write('\x1bP0;1;q#0;')
    assert.throws(
      () => splitFacade.write('2;100;0;0#0~~\x1b\\'),
      (error) => error instanceof TmuxGraphicsRevokedError,
      'a DCS split across chunks is still refused at completion',
    )
    assert.deepEqual((splitFacade as unknown as { inner: VirtualTerminal }).inner.writes, [],
      'the split untrusted DCS wrote no prefix and no completion')

    let trusted = true
    const sink = new VirtualTerminal()
    const registryFacade = new TmuxSixelTerminal(sink, new TmuxSixelAdmission(identity, cli.env), () => trusted)
    registryFacade.write('\x1bP0;1;q#0;2;100;0;0#0~~\x1b\\')
    assert.equal(sink.writes.length, 1, 'a registered DCS reaches the sink')
    trusted = false
    assert.throws(
      () => registryFacade.write('\x1bP0;1;q#0;2;100;0;0#0~~\x1b\\'),
      (error) => error instanceof TmuxGraphicsRevokedError,
      'a registry-invalidated DCS is refused',
    )
    assert.equal(sink.writes.length, 1, 'the second DCS wrote zero bytes')

    const revokedAdmission = new TmuxSixelAdmission(identity, cli.env)
    const revokedFacade = new TmuxSixelTerminal(new VirtualTerminal(), revokedAdmission, () => true)
    cli.setReply('show-messages', { text: '  1: Sxl: (flag) false\n' })
    assert.equal(revokedAdmission.isAllowed(true), false)
    assert.throws(
      () => revokedFacade.write('\x1bP0;1;q#0;2;100;0;0#0~~\x1b\\'),
      (error) => error instanceof TmuxGraphicsRevokedError,
      'a revoked admission refuses a registered DCS',
    )
  } finally {
    cli.dispose()
  }
})
