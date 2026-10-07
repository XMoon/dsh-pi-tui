/**
 * TS8-HF1 real-wire test: one in-process Remote carrier, the shared private
 * `piTuiFileReferences` Typert descriptor, the Host Cordis service and the
 * Client contribution the composition mounts — proving the ROUTING, not a
 * mock:
 *
 * ```text
 * bare query          Client -> private Remote -> Host service -> official fileReferences
 * explicit scope      Client -> private Remote -> Host service -> Host scanner
 * explicit excluded   the typed `dist/` scope is searched while a bare query for the
 *                     same entry is an authoritative empty (the discriminating pair)
 * home shorthand      Host HOME drives discovery; the returned value is absolute
 * official []         stays empty, with zero Host-scanner entries
 * Client fs           the Client-local discovery capability is never entered
 * Direct/Remote       the Direct port and the wire port answer IDENTICALLY for the
 *                     same Host context and inputs (L4 parity, one router)
 * ```
 *
 * The Host `@`-file reference provider is the REAL
 * `@deepseek-ai/dsh-file-reference-local` service the production Host mounts
 * (the fixture's opt-in `fileReferences: 'local'`).
 *
 * @module @xmoon76/dsh-pi-tui/remote-host-file-augmentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../src/app/remote/host-runtime.ts'
import { RemoteHostFilePort } from '../src/runtime/remote/host-file-remote.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'
import { DirectHostDiscoveryDriver } from '../src/runtime/direct/file-completion/host-discovery.ts'
import { ClientLocalDiscoveryDriver } from '../src/client/file-completion/local-discovery.ts'
import type { LocalDirectoryEntry } from '../src/domain/file-completion/discovery-policy.ts'
import type { PathCandidate } from '../src/domain/file-completion/types.ts'
import { createRemoteApplicationHostFixture } from './support/remote-application-fixture.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

const abort = new AbortController().signal

/** Record every entry the PRODUCTION discovery driver is asked for, through the
 * class prototype the real consumer resolves its instances from. */
function spyDriver(
  target: {
    find(baseDir: string, term: string, signal: AbortSignal): Promise<readonly PathCandidate[] | null>
    listDirectory(baseDir: string, relativeDir: string, signal: AbortSignal): Promise<readonly LocalDirectoryEntry[] | null>
  },
  calls: string[],
): () => void {
  const originalFind = target.find
  const originalList = target.listDirectory
  target.find = function (baseDir, term, signal) {
    calls.push(`find:${baseDir}:${term}`)
    return originalFind.call(this, baseDir, term, signal)
  }
  target.listDirectory = function (baseDir, relativeDir, signal) {
    calls.push(`list:${baseDir}:${relativeDir}`)
    return originalList.call(this, baseDir, relativeDir, signal)
  }
  return () => {
    target.find = originalFind
    target.listDirectory = originalList
  }
}

test('the private wire routes bare, scoped and home Session @ queries without Client filesystem discovery', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'hf1-wire-preset', { fileReferences: 'local' })
  let hostRuntime: RemoteHostRuntime | undefined
  let client: RemoteClientRuntime | undefined
  const hostCalls: string[] = []
  const clientCalls: string[] = []
  const restoreHost = spyDriver(DirectHostDiscoveryDriver.prototype, hostCalls)
  const restoreClient = spyDriver(ClientLocalDiscoveryDriver.prototype, clientCalls)
  try {
    const workspace = life.tempDir('dsh-hf1-ws-')
    writeFileSync(join(workspace, 'notes.md'), 'notes')
    mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'deep', 'utility.ts'), 'x')
    mkdirSync(join(workspace, 'dist'))
    writeFileSync(join(workspace, 'dist', 'zzz-official-excluded.js'), 'x')
    const sessionId = 'hf1-wire-session'
    await host.harness.create(SessionId(sessionId), undefined, { cwd: workspace })

    hostRuntime = await createRemoteHostRuntime(host.ctx)
    client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
    const port = new RemoteHostFilePort(client.remote.piTuiFileReferences, client.connection.generation)

    // 1. BARE: the OFFICIAL Host provider answers and the Host scanner is never
    //    entered (the query has no separator).
    const bare = await port.listReferences({ kind: 'session', sessionId }, 'notes')
    assert.ok(bare.kind === 'ok' && bare.items.some(item => item.path === 'notes.md'),
      `the official provider answers a bare query: ${JSON.stringify(bare)}`)
    assert.equal(hostCalls.length, 0, 'a bare query never enters the Host scanner')

    // 2. EXPLICIT: the Host scanner answers inside the typed scope. The
    //    private wire carries the official query form (no `@`, no quotes).
    const scoped = await port.listReferences({ kind: 'session', sessionId }, 'src/dee')
    assert.ok(scoped.kind === 'ok' && scoped.items.some(item => item.path === 'src/deep/utility.ts'),
      `the Host scanner answers an explicit scope: ${JSON.stringify(scoped)}`)
    assert.ok(hostCalls.some(entry => entry.startsWith('list:') || entry.startsWith('find:')),
      `the explicit route enters the Host scanner: ${JSON.stringify(hostCalls)}`)

    // 2b. EXPLICIT EXCLUDED DIRECTORY: `dist` is an official workspace exclusion,
    //     so a BARE query cannot see the entry (the witness below) while the
    //     explicitly typed scope can — the discriminating pair for the scoped route.
    const bareExcluded = await port.listReferences({ kind: 'session', sessionId }, 'zzz-official-excluded')
    assert.deepEqual(bareExcluded, { kind: 'ok', items: [] },
      'a bare query cannot see an officially excluded directory')
    const excluded = await port.listReferences({ kind: 'session', sessionId }, 'dist/zzz')
    assert.ok(excluded.kind === 'ok'
      && excluded.items.some(item => item.path === 'dist/zzz-official-excluded.js'),
      `the explicitly typed excluded scope is searched: ${JSON.stringify(excluded)}`)

    // 3. OFFICIAL EMPTY: a bare query whose only match lives in an officially
    //    excluded directory stays authoritative empty — the scanner is never a
    //    fallback (the entry would otherwise be discoverable).
    const beforeEmpty = hostCalls.length
    const empty = await port.listReferences({ kind: 'session', sessionId }, 'zzz-official-excluded')
    assert.deepEqual(empty, { kind: 'ok', items: [] },
      'an authoritative official empty stays empty')
    assert.equal(hostCalls.length, beforeEmpty, 'no scanner fallback for an official empty')

    // 4. HOST HOME SHORTHAND: discovery runs on the Host HOME and every
    //    returned value is an absolute Host path (never `~/...`).
    const beforeHome = hostCalls.length
    const home = await port.listReferences({ kind: 'session', sessionId }, '~/')
    assert.equal(home.kind, 'ok')
    if (home.kind === 'ok') {
      assert.ok(home.items.length > 0, 'the Host HOME directory lists')
      assert.ok(home.items.every(item => isAbsolute(item.path) && !item.path.startsWith('~')),
        `every home-shorthand value is an absolute Host path: ${JSON.stringify(home.items.map(item => item.path))}`)
      assert.ok(home.items.every(item => item.path.startsWith(homedir())),
        'the Host HOME scope (not a Client guess) drives discovery')
    }
    assert.ok(hostCalls.length > beforeHome, 'the home shorthand runs on the Host scanner')

    // 5. CLIENT FILESYSTEM: the Client-local discovery capability never ran for
    //    any of the above. Positive control below keeps the witness non-vacuous.
    assert.equal(clientCalls.length, 0, 'no Client filesystem discovery on any Session @ route')
    const clientDriver = new ClientLocalDiscoveryDriver(null)
    await clientDriver.listDirectory(workspace, '', abort)
    assert.ok(clientCalls.some(entry => entry.startsWith('list:')),
      `the Client witness fires on its own chain: ${JSON.stringify(clientCalls)}`)

    // 6. DIRECT <-> REMOTE PARITY (L4): the SAME Host context, the SAME inputs,
    //    the SAME router — only the transport differs. Bare, scoped, explicitly
    //    excluded and home queries must return identical detached candidates in
    //    the identical Host order through both ports.
    const directPort = new DirectHostFilePort(
      id => (host.ctx.reflect.get('agents') as { get(session: string): unknown } | undefined)?.get(id),
      null,
      { get: (name: string) => name === 'fileReferences' ? host.ctx.reflect.get('fileReferences') : undefined },
    )
    const scope = { kind: 'session', sessionId } as const
    // Positive control: the parity set is not a union of empty answers.
    const directBare = await directPort.listReferences(scope, 'notes')
    assert.ok(directBare.kind === 'ok' && directBare.items.some(item => item.path === 'notes.md'),
      `the Direct port answers the bare query too: ${JSON.stringify(directBare)}`)
    for (const query of ['notes', 'src/dee', 'dist/zzz', '~/']) {
      assert.deepEqual(await port.listReferences(scope, query), await directPort.listReferences(scope, query),
        `Direct/Remote parity for query ${JSON.stringify(query)}`)
    }
  } finally {
    restoreClient()
    restoreHost()
    await client?.dispose()
    await hostRuntime?.dispose()
    await host.dispose()
  }
})
