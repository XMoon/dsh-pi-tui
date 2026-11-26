import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runFirstSessionCommit,
  runForkCommit,
  runOrdinaryCommit,
  runResumeCommit,
} from '../../src/app/session/commit-order.ts'
import { createSessionOwnershipCore, type SessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import type { SessionOwnerRef } from '../../src/app/session/subject.ts'
import { createProgramResumeReporter, type ProgramResumeReporter } from '../../src/client/program-resume/reporter.ts'
import type { ProgramResumeCapability } from '../../src/client/program-resume/target.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'

const TOKEN = 'dummy-token-replace-me'
const SESSION_R = `session-${'1'.repeat(32)}`
const SESSION_A = `session-${'a'.repeat(32)}`
const SESSION_B = `session-${'b'.repeat(32)}`
const SESSION_C = `session-${'c'.repeat(32)}`

const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Diag

function owner(label: string): SessionOwnerRef {
  return { label } as unknown as SessionOwnerRef
}

function capability(): ProgramResumeCapability {
  return {
    token: TOKEN,
    facts: {
      version: 1,
      ownerPid: 4242,
      home: '/home/user/.dsh',
      profile: 'custom-profile',
      backend: 'direct',
      cwd: '/home/user/project',
      nodePath: '/usr/local/bin/node',
      cliPath: '/opt/dsh/lib/bin.js',
    },
  }
}

interface Harness {
  readonly ownership: SessionOwnershipCore
  readonly reporter: ProgramResumeReporter
  readonly frames: string[]
  stop(): void
}

function harness(initialSession?: string): Harness {
  const ownership = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  if (initialSession !== undefined) ownership.setCurrentOwner(owner('initial'), initialSession)
  const frames: string[] = []
  const reporter = createProgramResumeReporter({
    capability: capability(),
    currentSessionId: () => ownership.currentSessionId(),
    canWrite: () => true,
    write: frame => { frames.push(frame) },
    diag,
  })
  const unsubscribe = ownership.subscribeScopeInvalidation(() => { reporter.observe() })
  reporter.install()
  return {
    ownership,
    reporter,
    frames,
    stop: () => { unsubscribe(); reporter.dispose() },
  }
}

function ordinary(ownership: SessionOwnershipCore, sessionId: string, publish = true): void {
  runOrdinaryCommit({
    isSurfaceDisposed: () => false,
    settlePendingQueueRecalls: () => {},
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {},
    bumpGeneration: () => ownership.bumpGeneration(),
    publishOwner: (next) => {
      if (publish) ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
  }, owner(sessionId))
}

function fork(ownership: SessionOwnershipCore, sessionId: string): void {
  runForkCommit({
    settlePendingQueueRecalls: () => {},
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {},
    bumpGeneration: () => ownership.bumpGeneration(),
    publishOwner: (next) => {
      ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
  }, owner(sessionId))
}

function resume(ownership: SessionOwnershipCore, sessionId: string): void {
  runResumeCommit({
    publishOwner: (next) => {
      ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
  }, owner(sessionId))
}

async function first(ownership: SessionOwnershipCore, sessionId: string): Promise<void> {
  await runFirstSessionCommit({
    bumpGeneration: () => ownership.bumpGeneration(),
    publishOwner: (next) => {
      ownership.setCurrentOwner(next as SessionOwnerRef, sessionId)
      return sessionId
    },
    setCompletionOwner: () => {},
    quiesceChild: async () => false,
    initChild: async () => {},
  }, owner(sessionId))
}

async function scopeSettled(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function sessionOf(frame: string): string | undefined {
  const match = /argv=([^:]+)/u.exec(frame)
  if (match === null) return undefined
  const parts = (match[1] as string).split(',').map(value => Buffer.from(value, 'base64').toString('utf8'))
  const index = parts.indexOf('--session')
  return index < 0 ? undefined : parts[index + 1]
}

test('all four production commit shapes reach the reporter with the committed owner', async () => {
  const ownership = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  // The startup-resume shape committed before install is covered by the ONE
  // initial sample.
  resume(ownership, SESSION_R)
  await scopeSettled()
  const frames: string[] = []
  const reporter = createProgramResumeReporter({
    capability: capability(),
    currentSessionId: () => ownership.currentSessionId(),
    canWrite: () => true,
    write: frame => { frames.push(frame) },
    diag,
  })
  ownership.subscribeScopeInvalidation(() => { reporter.observe() })
  reporter.install()
  assert.deepEqual(frames.map(sessionOf), [SESSION_R], 'the install sample covers a pre-install startup resume')

  ordinary(ownership, SESSION_A)
  await scopeSettled()
  fork(ownership, SESSION_B)
  await scopeSettled()
  await first(ownership, SESSION_C)
  await scopeSettled()
  assert.deepEqual(frames.map(sessionOf), [SESSION_R, SESSION_A, SESSION_B, SESSION_C])

  // Same-id/generation-only notifications re-read the committed id and stay silent.
  ownership.bumpGeneration()
  await scopeSettled()
  assert.equal(frames.length, 4)

  // A failed navigation that never published leaves the last committed target.
  ordinary(ownership, SESSION_A, false)
  await scopeSettled()
  assert.equal(frames.length, 4)

  reporter.dispose()
})

test('coalesced notifications publish only the final committed id', async () => {
  const h = harness(SESSION_A)
  assert.equal(h.frames.length, 1)
  h.ownership.setCurrentOwner(owner('a'), SESSION_A)
  h.ownership.setCurrentOwner(owner('b'), SESSION_B)
  await scopeSettled()
  assert.deepEqual(h.frames.slice(1).map(sessionOf), [SESSION_B])
  h.stop()
})

test('a sessionless commit withdraws the target once and does not duplicate', async () => {
  const h = harness(SESSION_A)
  ordinary(h.ownership, SESSION_A)
  await scopeSettled()
  assert.deepEqual(h.frames.map(sessionOf), [SESSION_A])
  h.ownership.setCurrentOwner(undefined, undefined)
  await scopeSettled()
  assert.equal(h.frames.length, 2)
  assert.match(h.frames[1] as string, /clear=1/u)
  h.ownership.bumpGeneration()
  await scopeSettled()
  assert.equal(h.frames.length, 2)
  h.stop()
})
