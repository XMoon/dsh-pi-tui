/**
 * M4-B2-HF contract test for the real-Host RPC qualification probe.
 *
 * The official Session and Workspace controller contributions are loaded from
 * the INSTALLED package (the same resolution path the B1 transport uses); the
 * Client Remote face is a structural fixture so the probe's mount/unmount
 * ledger and failure semantics can be driven deterministically.
 *
 * @module @xmoon76/dsh-pi-tui/host-foundation-probe.test
 */

import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { runHostFoundationProbe } from '../../src/app/remote-process/host-foundation-probe.ts'
import { PI_TUI_CLIENT_CONTRIBUTION } from '../../src/runtime/remote/pi-tui-remote-contribution.ts'
import type { PiTuiTerminalProgressFrame } from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import type { VerifiedLocalHost } from '../../src/app/remote-process/local-discovery.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const DSH_ANCHOR = realpathSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller/package.json'))

const HOST = { identity: { hostPid: 4242, instanceId: 'host-instance-probe' } } as unknown as VerifiedLocalHost

const WORKSPACE_ID = 'workspace-probe-id'

/**
 * One REAL existing directory per test: the probe canonicalizes whatever it is
 * given. Created through the shared lifecycle so the temp root has ONE owner.
 */
function workspaceRoot(t: TestContext): string {
  return testLifecycle(t).tempDir('dsh-m4-host-foundation-probe-')
}

/**
 * The structural `workspace` Remote face the probe drives: one baseline, then
 * the `upsert` an authoritative create publishes. `created` reports the FIRST
 * call as the creator and every later call as an idempotent resolve.
 */
function fakeWorkspaceFace(): unknown {
  const frames: Array<Record<string, unknown>> = []
  let wake: (() => void) | undefined
  let closed = false
  let created = false
  const projection = (path: string): Record<string, unknown> => ({
    workspaceId: WORKSPACE_ID,
    path,
    title: 'probe',
    sessionIds: [],
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  })
  return {
    create: async (request: { readonly path: string }) => {
      const path = realpathSync(request.path)
      const value = { workspace: projection(path), created: !created }
      created = true
      frames.push({ type: 'upsert', workspace: projection(path) })
      wake?.()
      return { ok: true, value }
    },
    follow: () => {
      return {
        send: () => {},
        end: () => {},
        dispose: () => { closed = true; wake?.() },
        async *[Symbol.asyncIterator]() {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }
          while (!closed) {
            const frame = frames.shift()
            if (frame !== undefined) {
              yield frame
              continue
            }
            await new Promise<void>(resolve => { wake = resolve })
            wake = undefined
          }
        },
      }
    },
  }
}

function snapshotFrame(): PiTuiTerminalProgressFrame {
  return {
    kind: 'snapshot',
    sessionId: 'm4-hf-no-live-agent',
    hostEpoch: 'host-probe',
    agentEpoch: 0,
    revision: 0,
    running: false,
    outcome: 'idle',
  }
}

interface FakeRemoteOptions {
  readonly failSecondMount?: Error
  readonly listResult?: unknown
  readonly fileResult?: unknown
  readonly failSecondDispose?: Error
  /** Override the generated `workspace` face (the generation-resume control). */
  readonly workspace?: unknown
}

function fakeRemote(options: FakeRemoteOptions = {}): {
  readonly context: Context
  readonly mounted: string[]
  readonly disposed: string[]
} {
  const mounted: string[] = []
  const disposed: string[] = []
  let mounts = 0
  const remote = {
    session: {
      list: async () => options.listResult ?? { ok: true, value: { items: [] } },
    },
    piTuiFileReferences: {
      list: async () => options.fileResult ?? { ok: true, value: { kind: 'unavailable' } },
    },
    piTuiTerminalProgress: {
      watch: (): RemoteStreamHandle<PiTuiTerminalProgressFrame, never> => {
        let delivered = false
        let disposed = false
        let wake: (() => void) | undefined
        return {
          send: () => {},
          end: () => {},
          dispose: () => {
            disposed = true
            wake?.()
          },
          async *[Symbol.asyncIterator]() {
            if (!delivered) {
              delivered = true
              yield snapshotFrame()
            }
            if (disposed) return
            await new Promise<void>(resolve => { wake = resolve })
          },
        }
      },
    },
    workspace: options.workspace ?? fakeWorkspaceFace(),
    $mount: async (contribution: { readonly package: string }) => {
      mounts += 1
      if (mounts === 2 && options.failSecondMount !== undefined) throw options.failSecondMount
      const label = `${contribution.package}#${String(mounts)}`
      mounted.push(label)
      return async () => {
        disposed.push(label)
        if (label.endsWith('#2') && options.failSecondDispose !== undefined) throw options.failSecondDispose
      }
    },
  }
  return {
    context: { remote } as unknown as Context,
    mounted,
    disposed,
  }
}

test('the probe mounts all three contributions, proves the RPCs and the Workspace namespace, and unmounts in reverse order', async (t) => {
  const workspacePath = workspaceRoot(t)
  const fake = fakeRemote()
  const proof = await runHostFoundationProbe(fake.context, {
    dshAnchor: DSH_ANCHOR, host: HOST, workspacePath,
  })
  assert.equal(proof.m4b2hf, 'host-rpc-proof')
  assert.equal(proof.hostPid, 4242)
  assert.equal(proof.hostInstanceId, 'host-instance-probe')
  assert.equal(proof.clientPid, process.pid)
  assert.equal(proof.officialSessionList, true)
  assert.equal(proof.privateFileRpc, true)
  assert.equal(proof.terminalSnapshot, true)
  assert.equal(proof.workspaceRemote, true)
  assert.equal(proof.workspaceBaseline, true)
  assert.equal(proof.workspaceInBaseline, false, 'a Workspace created after the baseline cannot be in it')
  assert.equal(proof.workspaceCreated, true)
  assert.equal(proof.workspaceIdempotent, true)
  assert.equal(proof.workspaceUpsert, true)
  assert.equal(proof.workspaceId, WORKSPACE_ID)
  assert.equal(proof.workspacePath, realpathSync(workspacePath))
  assert.equal(proof.cleaned, true)
  assert.deepEqual(fake.mounted[0], `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`)
  assert.deepEqual(fake.mounted[1], '@deepseek-ai/dsh-api-session-controller#2')
  assert.deepEqual(fake.mounted[2], '@deepseek-ai/dsh-api-workspace-controller#3')
  assert.deepEqual(fake.disposed, [
    '@deepseek-ai/dsh-api-workspace-controller#3',
    '@deepseek-ai/dsh-api-session-controller#2',
    `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`,
  ], 'contributions must unmount in reverse mount order')
})

test('a failed second mount still unmounts the first contribution', async (t) => {
  const original = new Error('session remote mount refused')
  const fake = fakeRemote({ failSecondMount: original })
  await assert.rejects(
    runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST, workspacePath: workspaceRoot(t) }),
    /session remote mount refused/u,
  )
  assert.deepEqual(fake.disposed, [`${PI_TUI_CLIENT_CONTRIBUTION.package}#1`])
})

test('an RPC failure keeps the original error primary and still cleans every contribution', async (t) => {
  const fake = fakeRemote({ listResult: { ok: false } })
  await assert.rejects(
    runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST, workspacePath: workspaceRoot(t) }),
    /official session\/list did not return ok/u,
  )
  assert.deepEqual(fake.disposed, [
    '@deepseek-ai/dsh-api-workspace-controller#3',
    '@deepseek-ai/dsh-api-session-controller#2',
    `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`,
  ])
})

test('a cleanup failure rides the original RPC error as its cause', async (t) => {
  const cleanup = new Error('contribution disposer failed')
  const fake = fakeRemote({ fileResult: { ok: true, value: { kind: 'ok' } }, failSecondDispose: cleanup })
  await assert.rejects(
    runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST, workspacePath: workspaceRoot(t) }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /private PiFile RPC did not return ok\/unavailable/u)
      assert.equal(error.cause, cleanup, 'the cleanup failure must be attached without masking the RPC error')
      return true
    },
  )
})

test('without workspacePath the probe proves only the Session/private RPCs and mounts no Workspace descriptor', async () => {
  // The M4 cross-build lane runs a NEW Client against a Host that predates the
  // `workspace` namespace. That shape must ask for the Session/private proof
  // alone: it mounts two contributions and reports NO Workspace fields at all
  // (never a degraded "false" claim that could read as a failed proof).
  const fake = fakeRemote()
  const proof = await runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST })
  assert.deepEqual(fake.mounted, [
    `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`,
    '@deepseek-ai/dsh-api-session-controller#2',
  ], 'the Workspace descriptor must not be mounted when its proof is not requested')
  for (const field of ['workspaceRemote', 'workspaceBaseline', 'workspaceIdempotent', 'workspaceUpsert', 'workspaceCreated', 'workspaceInBaseline', 'workspaceId', 'workspacePath']) {
    assert.equal(field in proof, false, `the unrequested Workspace field ${field} must be absent, not false`)
  }
  assert.equal(proof.cleaned, true)
})

test('the generation-resume control requires the Workspace proof', async () => {
  // A partial request must fail before any mount: a silently skipped resume
  // proof would turn WS1-05 into an unproven claim.
  const fake = fakeRemote()
  await assert.rejects(
    runHostFoundationProbe(fake.context, {
      dshAnchor: DSH_ANCHOR, host: HOST, dropCarrier: () => {},
    }),
    /requires BOTH dropCarrier and readGeneration/u,
  )
  await assert.rejects(
    runHostFoundationProbe(fake.context, {
      dshAnchor: DSH_ANCHOR, host: HOST, dropCarrier: () => {}, readGeneration: () => 1,
    }),
    /requires the Workspace proof/u,
  )
  assert.deepEqual(fake.mounted, [], 'a rejected control must not mount any contribution')
})

/**
 * A Workspace face whose HELD stream delivers a frame AFTER the carrier drop.
 * The probe must reject that as stale delivery instead of accepting the stream
 * as merely "closed".
 */
function staleWorkspaceFace(workspacePath: string): {
  readonly face: unknown
  readonly drop: () => void
  readonly generation: () => number
} {
  const projection = (): Record<string, unknown> => ({
    workspaceId: WORKSPACE_ID,
    path: realpathSync(workspacePath),
    title: 'probe',
    sessionIds: [],
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  })
  const queue: Array<Record<string, unknown>> = []
  let wake: (() => void) | undefined
  let generation = 1
  let created = false
  const push = (frame: Record<string, unknown>): void => {
    queue.push(frame)
    wake?.()
  }
  return {
    generation: () => generation,
    drop: () => {
      generation += 1
      // The regression this control names: the obsolete generation keeps
      // writing a state increment into the same Client.
      push({ type: 'upsert', workspace: projection() })
    },
    face: {
      create: async () => {
        const value = { workspace: projection(), created: !created }
        created = true
        push({ type: 'upsert', workspace: projection() })
        return { ok: true, value }
      },
      follow: () => ({
        send: () => {},
        end: () => {},
        dispose: () => {},
        async *[Symbol.asyncIterator]() {
          yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }
          while (true) {
            const frame = queue.shift()
            if (frame !== undefined) {
              yield frame
              continue
            }
            await new Promise<void>(resolve => { wake = resolve })
            wake = undefined
          }
        },
      }),
    },
  }
}

test('a frame delivered by the HELD stream after the carrier drop fails the probe', async (t) => {
  const workspacePath = workspaceRoot(t)
  const stale = staleWorkspaceFace(workspacePath)
  const fake = fakeRemote({ workspace: stale.face })
  await assert.rejects(
    runHostFoundationProbe(fake.context, {
      dshAnchor: DSH_ANCHOR,
      host: HOST,
      workspacePath,
      dropCarrier: () => { stale.drop() },
      readGeneration: () => stale.generation(),
    }),
    /delivered a "upsert" frame after its Connection generation was replaced/u,
  )
  assert.deepEqual(fake.disposed, [
    '@deepseek-ai/dsh-api-workspace-controller#3',
    '@deepseek-ai/dsh-api-session-controller#2',
    `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`,
  ], 'the failed probe must still unmount every contribution in reverse order')
})
