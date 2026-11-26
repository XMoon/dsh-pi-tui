import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { createProgramResumeReporter } from '../../src/client/program-resume/reporter.ts'
import type { ProgramResumeCapability } from '../../src/client/program-resume/target.ts'

const TOKEN = 'dummy-token-replace-me'
const OWNER = 4242
const SESSION_A = `session-${'a'.repeat(32)}`
const SESSION_B = `session-${'b'.repeat(32)}`

const diag = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Diag

function capability(overrides: Partial<ProgramResumeCapability['facts']> = {}): ProgramResumeCapability {
  return {
    token: TOKEN,
    facts: {
      version: 1,
      ownerPid: OWNER,
      home: '/home/user/.dsh',
      profile: 'custom-profile',
      backend: 'direct',
      cwd: '/home/user/project',
      nodePath: '/usr/local/bin/node',
      cliPath: '/opt/dsh/lib/bin.js',
      ...overrides,
    },
  }
}

function harness(initialSession: string | undefined, options: {
  readonly canWrite?: () => boolean
  readonly write?: (frame: string) => void
} = {}) {
  let current = initialSession
  const frames: string[] = []
  const reporter = createProgramResumeReporter({
    capability: capability(),
    currentSessionId: () => current,
    canWrite: options.canWrite ?? (() => true),
    write: options.write ?? (frame => { frames.push(frame) }),
    diag,
  })
  return {
    reporter,
    frames,
    setSession: (id: string | undefined) => { current = id },
  }
}

function bodyOf(frame: string): { body: string; mac: string } {
  const match = /^\u001B\]7577;(.*):mac=([0-9a-f]{64})\u001B\\$/u.exec(frame)
  assert.ok(match, 'the reporter must write complete OSC 7577 frames')
  return { body: match[1] as string, mac: match[2] as string }
}

function assertMac(frame: string): void {
  const { body, mac } = bodyOf(frame)
  assert.equal(mac, createHash('sha256').update(`${body}:${TOKEN}`).digest('hex'))
}

function decodedArgv(body: string): string[] {
  const argv = body.split(':').find(pair => pair.startsWith('argv='))
  assert.ok(argv, 'a report must carry argv')
  return argv.slice('argv='.length).split(',').map(value => Buffer.from(value, 'base64').toString('utf8'))
}

test('the initial committed Session offers one exact report and duplicate observations are silent', () => {
  const h = harness(SESSION_A)
  h.reporter.install()
  assert.equal(h.frames.length, 1)
  assertMac(h.frames[0] as string)
  const { body } = bodyOf(h.frames[0] as string)
  assert.match(body, new RegExp(`pid=${String(OWNER)}:time=\\d+:argv=`, 'u'))
  assert.deepEqual(decodedArgv(body), [
    '/usr/bin/env',
    'DSH_HOME=/home/user/.dsh',
    'DSH_PI_TUI_BACKEND=direct',
    '/usr/local/bin/node',
    '/opt/dsh/lib/bin.js',
    '--profile',
    'custom-profile',
    '--session',
    SESSION_A,
  ])
  assert.match(body, /cwd=L2hvbWUvdXNlci9wcm9qZWN0$/u)
  h.reporter.observe()
  h.reporter.observe()
  assert.equal(h.frames.length, 1, 'a generation-only notification or repaint never duplicates the target')
})

test('an A -> B commit reports B and never replays A', () => {
  const h = harness(SESSION_A)
  h.reporter.install()
  h.setSession(SESSION_B)
  h.reporter.observe()
  assert.equal(h.frames.length, 2)
  const { body } = bodyOf(h.frames[1] as string)
  assert.deepEqual(decodedArgv(body).slice(-1), [SESSION_B])
})

test('a sessionless install sends exactly one clear; a later Session re-offers', () => {
  const h = harness(undefined)
  h.reporter.install()
  assert.equal(h.frames.length, 1)
  assertMac(h.frames[0] as string)
  assert.match(bodyOf(h.frames[0] as string).body, /clear=1$/u)
  h.reporter.observe()
  assert.equal(h.frames.length, 1)
  h.setSession(SESSION_A)
  h.reporter.observe()
  assert.equal(h.frames.length, 2)
  assert.match(bodyOf(h.frames[1] as string).body, /argv=/u)
})

test('suspend writes nothing; regain samples the current target exactly once', () => {
  const h = harness(SESSION_A)
  h.reporter.install()
  h.reporter.suspend()
  h.setSession(SESSION_B)
  h.reporter.observe()
  assert.equal(h.frames.length, 1)
  h.reporter.resume()
  assert.equal(h.frames.length, 2)
  const { body } = bodyOf(h.frames[1] as string)
  assert.deepEqual(decodedArgv(body).slice(-1), [SESSION_B])
  h.reporter.resume()
  assert.equal(h.frames.length, 3, 'each real regain is one fresh offer')
})

test('human exit clears once; generic dispose never clears', () => {
  const human = harness(SESSION_A)
  human.reporter.install()
  human.reporter.humanExit()
  assert.equal(human.frames.length, 2)
  assert.match(bodyOf(human.frames[1] as string).body, /clear=1$/u)
  human.reporter.observe()
  human.reporter.dispose()
  assert.equal(human.frames.length, 2)

  const signal = harness(SESSION_A)
  signal.reporter.install()
  signal.reporter.dispose()
  assert.equal(signal.frames.length, 1)
  signal.reporter.observe()
  assert.equal(signal.frames.length, 1)
})

test('a human exit before the first install still withdraws any earlier record', () => {
  const h = harness(SESSION_A)
  h.reporter.humanExit()
  assert.equal(h.frames.length, 1)
  assert.match(bodyOf(h.frames[0] as string).body, /clear=1$/u)
  h.reporter.install()
  assert.equal(h.frames.length, 1, 'a closed reporter never installs')
})

test('a human exit never writes while the terminal is not owned', () => {
  const h = harness(SESSION_A, { canWrite: () => false })
  h.reporter.install()
  h.reporter.humanExit()
  assert.equal(h.frames.length, 0)
})

test('an accepted unsupported reload clears once and stops publication', () => {
  const h = harness(SESSION_A)
  h.reporter.install()
  h.reporter.unsupportedReloadAccepted()
  assert.equal(h.frames.length, 2)
  assert.match(bodyOf(h.frames[1] as string).body, /clear=1$/u)
  h.setSession(SESSION_B)
  h.reporter.observe()
  assert.equal(h.frames.length, 2)
})

test('canWrite=false emits nothing and the next real commit succeeds', () => {
  let writable = false
  const h = harness(SESSION_A, { canWrite: () => writable })
  h.reporter.install()
  assert.equal(h.frames.length, 0)
  writable = true
  h.reporter.observe()
  assert.equal(h.frames.length, 1)
})

test('a failed write is not recorded as offered and the next observation retries', () => {
  let fail = true
  const frames: string[] = []
  const h = harness(SESSION_A, {
    write: frame => {
      if (fail) throw new Error('terminal write failed')
      frames.push(frame)
    },
  })
  h.reporter.install()
  assert.equal(frames.length, 0)
  fail = false
  h.reporter.observe()
  assert.equal(frames.length, 1)
  assertMac(frames[0] as string)
})

test('an unencodable report falls back to a legal clear on each target transition', () => {
  let current = SESSION_A
  const frames: string[] = []
  const reporter = createProgramResumeReporter({
    capability: capability({ profile: 'p'.repeat(3000) }),
    currentSessionId: () => current,
    canWrite: () => true,
    write: frame => { frames.push(frame) },
    diag,
  })
  reporter.install()
  assert.equal(frames.length, 1)
  assert.match(bodyOf(frames[0] as string).body, /clear=1$/u)
  assertMac(frames[0] as string)
  current = SESSION_B
  reporter.observe()
  assert.equal(frames.length, 2)
  assert.match(bodyOf(frames[1] as string).body, /clear=1$/u)
})
