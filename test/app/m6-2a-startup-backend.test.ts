/**
 * M6-2A startup backend selection: the ONE public backend decision
 * (`DSH_PI_TUI_BACKEND` > Profile `tui-startup.backend` > `direct`) and the
 * mutually exclusive `tuiStartup` / `tuiDaemonStartup` publication, plus the
 * fail-closed paths.
 *
 * Evidence level: structural. These mount the startup row on a real Cordis
 * `Context` with a structural `cmdlineArgs`/`appExit`/`appReady` provider — the
 * same harness the existing startup tests use. They prove the ROW's decision
 * and handshake semantics, not a real `dsh` process (that is the packed smoke).
 * @module @xmoon76/dsh-pi-tui/m6-2a-startup-backend.test
 */

import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  apply as applyStartup,
  TUI_STARTUP_SERVICE,
  TUI_DAEMON_STARTUP_SERVICE,
  type Config,
} from '../../src/startup.ts'

const BACKEND_ENV = 'DSH_PI_TUI_BACKEND'

/** A structural Config carrying one backend value (the Loader would supply a
 *  schemastery volatile reference; the row only reads `.get()`). */
function configOf(backend: string): Config {
  return { backend: { get: () => backend } }
}

interface Mounted {
  ctx: Context
  exitCodes: number[]
  fireReady: () => void
  readyListenerCount: () => number
}

function mount(t: TestContext, args: string[], config?: Config): Mounted {
  const exitCodes: number[] = []
  const listeners: (() => void)[] = []
  const ctx = new Context()
  ctx.provide('cmdlineArgs', { get: () => args })
  ctx.provide('appExit', ((code: number) => { exitCodes.push(code) }) as never)
  ctx.provide('appReady', ({
    onReady: (listener: () => void) => { listeners.push(listener); return () => {} },
  }) as never)
  t.after(async () => { await ctx.fiber.dispose() })
  applyStartup(ctx, config)
  return {
    ctx,
    exitCodes,
    fireReady: () => { for (const listener of [...listeners]) listener() },
    readyListenerCount: () => listeners.length,
  }
}

/** Run `fn` with a temporary process.env backend value (undefined = unset). */
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const had = BACKEND_ENV in process.env
  const previous = process.env[BACKEND_ENV]
  if (value === undefined) delete process.env[BACKEND_ENV]
  else process.env[BACKEND_ENV] = value
  try {
    return fn()
  } finally {
    if (had) process.env[BACKEND_ENV] = previous
    else delete process.env[BACKEND_ENV]
  }
}

/** Force `process.platform` and BOTH stdin/stdout `isTTY` for the duration of `fn`. */
function withDaemonPlatform<T>(platform: NodeJS.Platform, tty: boolean, fn: () => T): T {
  return withTty(platform, tty, tty, fn)
}

/** Force `process.platform` and independent stdin/stdout TTY capabilities. */
function withTty<T>(platform: NodeJS.Platform, stdinTty: boolean, stdoutTty: boolean, fn: () => T): T {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor)
    if (stdinDescriptor !== undefined) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
    if (stdoutDescriptor !== undefined) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
}

/** Silence and capture stderr writes for the duration of `fn`. */
function captureStderr<T>(fn: () => T): { value: T; text: string } {
  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => { lines.push(chunk); return true }) as typeof process.stderr.write
  try {
    const value = fn()
    return { value, text: lines.join('') }
  } finally {
    process.stderr.write = original
  }
}

// ── precedence (plan §5) ───────────────────────────────────────────────────

test('no ENV and no Profile value defaults to Direct', (t) => {
  withEnv(undefined, () => {
    const { ctx } = mount(t, [])
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'Direct provides tuiStartup')
    assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined, 'Direct never provides the daemon service')
  })
})

test('Profile direct with no ENV resolves to Direct', (t) => {
  withEnv(undefined, () => {
    const { ctx } = mount(t, [], configOf('direct'))
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined)
    assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
  })
})

test('Profile daemon on Linux with a TTY resolves to Daemon', (t) => {
  withEnv(undefined, () => {
    withDaemonPlatform('linux', true, () => {
      const { ctx } = mount(t, [], configOf('daemon'))
      assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined, 'Daemon never provides the Direct service')
      assert.ok(ctx.get(TUI_DAEMON_STARTUP_SERVICE) !== undefined, 'Daemon provides tuiDaemonStartup')
    })
  })
})

test('ENV=direct overrides a persisted Profile daemon', (t) => {
  withEnv('direct', () => {
    const { ctx } = mount(t, [], configOf('daemon'))
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined)
    assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
  })
})

test('ENV=daemon overrides a persisted Profile direct', (t) => {
  withEnv('daemon', () => {
    withDaemonPlatform('linux', true, () => {
      const { ctx } = mount(t, [], configOf('direct'))
      assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined)
      assert.ok(ctx.get(TUI_DAEMON_STARTUP_SERVICE) !== undefined)
    })
  })
})

// ── illegal input fails closed ────────────────────────────────────────────

for (const bad of ['', 'wire-local', 'remote', 'DAEMON', ' daemon', 'true']) {
  test(`ENV ${JSON.stringify(bad)} is an illegal input, never Direct fallback`, (t) => {
    withEnv(bad, () => {
      const { value: mounted, text } = captureStderr(() => mount(t, []))
      assert.equal(mounted.ctx.get(TUI_STARTUP_SERVICE), undefined, 'no Direct fallback on an illegal ENV')
      assert.equal(mounted.ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined, 'no Daemon fallback on an illegal ENV')
      assert.deepEqual(mounted.exitCodes, [1], 'an illegal ENV exits nonzero')
      assert.match(text, /invalid-backend|DSH_PI_TUI_BACKEND/u)
    })
  })
}

test('an illegal Profile value with no ENV fails closed (never Direct)', (t) => {
  withEnv(undefined, () => {
    const { ctx, exitCodes } = mount(t, [], configOf('wire-local'))
    assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined)
    assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
    assert.deepEqual(exitCodes, [1])
  })
})

test('an illegal Profile value is still overridden by a valid ENV', (t) => {
  withEnv('direct', () => {
    const { ctx, exitCodes } = mount(t, [], configOf('wire-local'))
    assert.ok(ctx.get(TUI_STARTUP_SERVICE) !== undefined, 'the explicit ENV launch is honored')
    assert.deepEqual(exitCodes, [], 'a valid ENV override does not fail')
  })
})

test('daemon on a non-Linux platform fails closed with the platform reason', (t) => {
  withEnv('daemon', () => {
    withDaemonPlatform('darwin', true, () => {
      const { ctx, exitCodes } = mount(t, [])
      assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
      assert.deepEqual(exitCodes, [1])
    })
  })
})

test('daemon without an interactive TTY fails closed', (t) => {
  withEnv('daemon', () => {
    withDaemonPlatform('linux', false, () => {
      const { ctx, exitCodes } = mount(t, [])
      assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
      assert.deepEqual(exitCodes, [1])
    })
  })
})

test('daemon with a TTY stdin but a redirected stdout fails closed (output capability checked)', (t) => {
  withEnv('daemon', () => {
    withTty('linux', true, false, () => {
      const { ctx, exitCodes } = mount(t, [])
      assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
      assert.deepEqual(exitCodes, [1])
    })
  })
})

test('daemon with a redirected stdin but a TTY stdout fails closed (input capability checked)', (t) => {
  withEnv('daemon', () => {
    withTty('linux', false, true, () => {
      const { ctx, exitCodes } = mount(t, [])
      assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
      assert.deepEqual(exitCodes, [1])
    })
  })
})

// ── --help mounts neither ─────────────────────────────────────────────────

test('--help provides neither startup service', (t) => {
  withEnv('daemon', () => {
    withDaemonPlatform('linux', true, () => {
      const { ctx, exitCodes } = mount(t, ['--help'])
      assert.equal(ctx.get(TUI_STARTUP_SERVICE), undefined)
      assert.equal(ctx.get(TUI_DAEMON_STARTUP_SERVICE), undefined)
      // commander's own help exit is requested; no backend verdict.
      assert.deepEqual(exitCodes, [0])
    })
  })
})

// ── the daemon cold-ready handshake ───────────────────────────────────────

test('daemon readiness without a mounted Coordinator exits nonzero with an actionable error', (t) => {
  withEnv('daemon', () => {
    withDaemonPlatform('linux', true, () => {
      const { ctx, fireReady, exitCodes } = mount(t, [])
      assert.ok(ctx.get(TUI_DAEMON_STARTUP_SERVICE) !== undefined)
      const { text } = captureStderr(() => { fireReady() })
      assert.deepEqual(exitCodes, [1], 'a missing launcher row must exit nonzero')
      assert.match(text, /daemon launcher row did not mount/u)
      assert.match(text, /tuiDaemonStartup/u)
    })
  })
})

test('daemon readiness with a mounted Coordinator does not exit', (t) => {
  withEnv('daemon', () => {
    withDaemonPlatform('linux', true, () => {
      const { ctx, fireReady, exitCodes } = mount(t, [])
      const startup = ctx.get(TUI_DAEMON_STARTUP_SERVICE) as { markCoordinatorMounted?: () => void }
      startup.markCoordinatorMounted?.()
      const { text } = captureStderr(() => { fireReady() })
      assert.deepEqual(exitCodes, [], 'a mounted launcher must not exit')
      assert.equal(text, '')
    })
  })
})

test('an HMR re-apply after readiness committed delivers no daemon verdict', (t) => {
  withEnv('daemon', () => {
    withDaemonPlatform('linux', true, () => {
      const listeners: (() => void)[] = []
      const exitCodes: number[] = []
      const ctx = new Context()
      ctx.provide('cmdlineArgs', { get: () => [] as string[] })
      ctx.provide('appExit', ((code: number) => { exitCodes.push(code) }) as never)
      // A listener set that ALREADY COMMITTED: an onReady registered after the
      // commit runs synchronously inside onReady itself.
      ctx.provide('appReady', ({
        onReady: (listener: () => void) => { listener(); return () => {} },
      }) as never)
      t.after(async () => { await ctx.fiber.dispose() })
      const { text } = captureStderr(() => { applyStartup(ctx, configOf('daemon')) })
      assert.deepEqual(exitCodes, [], 'a re-applied row that witnessed no startup delivers no verdict')
      assert.equal(text, '')
      void listeners
    })
  })
})

// ── the fail-closed path has zero side effects ────────────────────────────

test('a fail-closed backend decision installs no interception and arms no handshake', (t) => {
  withEnv('wire-local', () => {
    const consoleErrorBefore = console.error
    const { value: mounted, text } = captureStderr(() => mount(t, []))
    assert.equal(console.error, consoleErrorBefore, 'the model-listing interception was never installed')
    assert.equal(mounted.readyListenerCount(), 0, 'no readiness handshake was armed')
    assert.equal(mounted.ctx.get(TUI_STARTUP_SERVICE), undefined)
    assert.deepEqual(mounted.exitCodes, [1])
    assert.match(text, /invalid-backend|wire-local/u)
  })
})
