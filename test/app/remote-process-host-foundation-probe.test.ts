/**
 * M4-B2-HF contract test for the real-Host RPC qualification probe.
 *
 * The official Session controller contribution is loaded from the INSTALLED
 * rc.4 package (the same resolution path the B1 transport uses); the Client
 * Remote face is a structural fixture so the probe's mount/unmount ledger and
 * failure semantics can be driven deterministically.
 *
 * @module @xmoon76/dsh-pi-tui/host-foundation-probe.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import { runHostFoundationProbe } from '../../src/app/remote-process/host-foundation-probe.ts'
import { PI_TUI_CLIENT_CONTRIBUTION } from '../../src/runtime/remote/pi-tui-remote-contribution.ts'
import type { PiTuiTerminalProgressFrame } from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import type { VerifiedLocalHost } from '../../src/app/remote-process/local-discovery.ts'

const DSH_ANCHOR = realpathSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller/package.json'))

const HOST = { identity: { hostPid: 4242, instanceId: 'host-instance-probe' } } as unknown as VerifiedLocalHost

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

test('the probe mounts both contributions, proves the three RPCs and unmounts in reverse order', async () => {
  const fake = fakeRemote()
  const proof = await runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST })
  assert.equal(proof.m4b2hf, 'host-rpc-proof')
  assert.equal(proof.hostPid, 4242)
  assert.equal(proof.hostInstanceId, 'host-instance-probe')
  assert.equal(proof.clientPid, process.pid)
  assert.equal(proof.officialSessionList, true)
  assert.equal(proof.privateFileRpc, true)
  assert.equal(proof.terminalSnapshot, true)
  assert.equal(proof.cleaned, true)
  assert.deepEqual(fake.mounted[0], `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`)
  assert.deepEqual(fake.mounted[1], '@deepseek-ai/dsh-api-session-controller#2')
  assert.deepEqual(fake.disposed, ['@deepseek-ai/dsh-api-session-controller#2', `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`],
    'contributions must unmount in reverse mount order')
})

test('a failed second mount still unmounts the first contribution', async () => {
  const original = new Error('session remote mount refused')
  const fake = fakeRemote({ failSecondMount: original })
  await assert.rejects(
    runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST }),
    /session remote mount refused/u,
  )
  assert.deepEqual(fake.disposed, [`${PI_TUI_CLIENT_CONTRIBUTION.package}#1`])
})

test('an RPC failure keeps the original error primary and still cleans both contributions', async () => {
  const fake = fakeRemote({ listResult: { ok: false } })
  await assert.rejects(
    runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST }),
    /official session\/list did not return ok/u,
  )
  assert.deepEqual(fake.disposed, ['@deepseek-ai/dsh-api-session-controller#2', `${PI_TUI_CLIENT_CONTRIBUTION.package}#1`])
})

test('a cleanup failure rides the original RPC error as its cause', async () => {
  const cleanup = new Error('contribution disposer failed')
  const fake = fakeRemote({ fileResult: { ok: true, value: { kind: 'ok' } }, failSecondDispose: cleanup })
  await assert.rejects(
    runHostFoundationProbe(fake.context, { dshAnchor: DSH_ANCHOR, host: HOST }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /private PiFile RPC did not return ok\/unavailable/u)
      assert.equal(error.cause, cleanup, 'the cleanup failure must be attached without masking the RPC error')
      return true
    },
  )
})
