/**
 * Session Workspace PR1 L3: the Remote Host directory-browse adapter.
 *
 * The adapter maps the official generated `directoryPicker.list` namespace the
 * mounted workspace-controller Remote contribution publishes. These tests prove
 * the official listing is returned unchanged, the explicit path is never
 * rewritten, the official failure codes are classified by CODE (never message
 * text), an absent Connection generation is a truthful unavailable, abort and
 * generation replacement never deliver a late ready listing, the namespace is
 * called on its own receiver exactly once, and no Session identity or retry is
 * involved.
 *
 * @module @xmoon76/dsh-pi-tui/host-directory-browse-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import {
  REMOTE_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON,
  RemoteHostDirectoryBrowsePort,
} from '../../../src/runtime/remote/host-directory-browse-remote.ts'
import type { RemoteResultLike } from '../../../src/runtime/remote/session-writer-remote.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import { createSnapshotGenerationHarness } from '../../support/remote-generation.ts'

const LISTING: DirectoryListing = {
  path: '/srv/host/proof',
  home: '/home/host-user',
  crumbs: [
    { name: '/', path: '/', hidden: false },
    { name: 'proof', path: '/srv/host/proof', hidden: false },
  ],
  entries: [
    { name: '.hidden-project', path: '/srv/host/proof/.hidden-project', hidden: true },
    { name: 'alpha', path: '/srv/host/proof/alpha', hidden: false },
  ],
  truncated: true,
}

/** A receiver-sensitive generated-namespace fake: the implementation pushes
 *  through `this`, so a destructured/proxied call loses the recorded call. */
class FakeDirectoryPicker {
  readonly calls: Array<{ readonly path: string | undefined; readonly signal: AbortSignal | undefined }> = []
  listImpl: (path: string | undefined, signal?: AbortSignal) => Promise<RemoteResultLike<DirectoryListing>> =
    async () => ({ ok: true, value: LISTING })

  async list(path: string | undefined, signal?: AbortSignal): Promise<RemoteResultLike<DirectoryListing>> {
    this.calls.push({ path, signal })
    return this.listImpl(path, signal)
  }
}

function remoteFailure(code: string, message = `official ${code}`): { readonly code: string; readonly message: string } {
  return { code, message }
}

test('list(undefined) returns the official generated listing unchanged through one receiver-bound call', async () => {
  const directoryPicker = new FakeDirectoryPicker()
  const generation = createSnapshotGenerationHarness()
  const signal = new AbortController().signal
  const outcome = await new RemoteHostDirectoryBrowsePort(directoryPicker, generation.source)
    .list(undefined, signal)
  assert.equal(outcome.kind, 'ready')
  assert.ok(outcome.kind === 'ready')
  assert.equal(outcome.listing, LISTING, 'the official DirectoryListing must pass through unchanged')
  assert.deepEqual(directoryPicker.calls, [{ path: undefined, signal }],
    'the namespace method must run on its own receiver with exactly (path, signal)')
})

test('an explicit Host absolute path is passed through verbatim', async () => {
  const directoryPicker = new FakeDirectoryPicker()
  const port = new RemoteHostDirectoryBrowsePort(directoryPicker, createSnapshotGenerationHarness().source)
  const path = '/srv/../srv//host/proof/'
  const outcome = await port.list(path, new AbortController().signal)
  assert.equal(outcome.kind, 'ready')
  assert.equal(directoryPicker.calls[0]?.path, path,
    'the adapter must never normalize, join or realpath the requested Host path')
})

test('an empty Host level is a successful ready listing, not an unavailable outcome', async () => {
  const directoryPicker = new FakeDirectoryPicker()
  directoryPicker.listImpl = async path => ({
    ok: true,
    value: { path: path ?? '/home/host-user', home: '/home/host-user', crumbs: [], entries: [], truncated: false },
  })
  const outcome = await new RemoteHostDirectoryBrowsePort(directoryPicker, createSnapshotGenerationHarness().source)
    .list(undefined, new AbortController().signal)
  assert.equal(outcome.kind, 'ready')
  assert.ok(outcome.kind === 'ready')
  assert.deepEqual(outcome.listing.entries, [])
})

test('a Client with no current Connection generation answers unavailable without calling the namespace', async () => {
  const directoryPicker = new FakeDirectoryPicker()
  const generation = createSnapshotGenerationHarness()
  generation.set(undefined)
  const outcome = await new RemoteHostDirectoryBrowsePort(directoryPicker, generation.source)
    .list(undefined, new AbortController().signal)
  assert.equal(outcome.kind, 'unavailable')
  assert.ok(outcome.kind === 'unavailable')
  assert.equal(outcome.code, 'directory-picker/unavailable')
  assert.equal(outcome.reason, REMOTE_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON)
  assert.deepEqual(directoryPicker.calls, [])
})

test('the official failure codes are classified by code, never by message text', async () => {
  const cases: ReadonlyArray<{
    readonly code: string
    readonly message: string
    readonly kind: 'failed' | 'unavailable'
  }> = [
    { code: 'directory-picker/unreadable', message: 'permission denied', kind: 'failed' },
    { code: 'directory-picker/unavailable', message: 'not fully qualified', kind: 'unavailable' },
    { code: 'gateway/cancelled', message: 'the Host cancelled', kind: 'unavailable' },
    { code: 'gateway/service-unavailable', message: 'Host service down', kind: 'unavailable' },
    { code: 'gateway/method-unavailable', message: 'endpoint retired', kind: 'unavailable' },
    { code: 'gateway/peer-disposed', message: 'peer gone', kind: 'unavailable' },
  ]
  for (const entry of cases) {
    const directoryPicker = new FakeDirectoryPicker()
    directoryPicker.listImpl = async () => ({ ok: false, error: remoteFailure(entry.code, entry.message) })
    const outcome = await new RemoteHostDirectoryBrowsePort(directoryPicker, createSnapshotGenerationHarness().source)
      .list(undefined, new AbortController().signal)
    assert.equal(outcome.kind, entry.kind, `${entry.code} must classify as ${entry.kind}`)
    assert.equal(outcome.code, entry.code)
    assert.equal(outcome.reason, entry.message)
  }
})

test('an unclassified protocol failure stays observable instead of becoming an outcome', async () => {
  const directoryPicker = new FakeDirectoryPicker()
  const failure = remoteFailure('gateway/protocol', 'malformed frame')
  directoryPicker.listImpl = async () => ({ ok: false, error: failure })
  await assert.rejects(
    new RemoteHostDirectoryBrowsePort(directoryPicker, createSnapshotGenerationHarness().source)
      .list(undefined, new AbortController().signal),
    error => error === failure,
  )
})

test('the generic gateway/internal failure stays observable, never a fabricated unavailable', async () => {
  // The official controller folds ANY unexpected handler failure into
  // `gateway/internal`, and the Client carrier folds a dropped transport into
  // the SAME code. It is therefore not an authoritative "directory read is
  // unavailable" fact: the caller must see the failure instead of an empty
  // availability outcome that hides a Host bug.
  const directoryPicker = new FakeDirectoryPicker()
  const failure = remoteFailure('gateway/internal', 'directory listing failed: EACCES')
  directoryPicker.listImpl = async () => ({ ok: false, error: failure })
  await assert.rejects(
    new RemoteHostDirectoryBrowsePort(directoryPicker, createSnapshotGenerationHarness().source)
      .list(undefined, new AbortController().signal),
    error => error === failure,
  )
})

test('a caller abort wins and never delivers a late ready listing', async () => {
  const before = new AbortController()
  before.abort()
  const notCalled = new FakeDirectoryPicker()
  await assert.rejects(
    new RemoteHostDirectoryBrowsePort(notCalled, createSnapshotGenerationHarness().source)
      .list(undefined, before.signal),
    error => error instanceof Error && error.name === 'AbortError',
  )
  assert.deepEqual(notCalled.calls, [], 'a pre-aborted read must not dispatch to the Host')

  const during = new AbortController()
  const directoryPicker = new FakeDirectoryPicker()
  directoryPicker.listImpl = async () => {
    during.abort()
    return { ok: true, value: LISTING }
  }
  await assert.rejects(
    new RemoteHostDirectoryBrowsePort(directoryPicker, createSnapshotGenerationHarness().source)
      .list(undefined, during.signal),
    error => error instanceof Error && error.name === 'AbortError',
  )
})

test('a listing or refusal from a superseded generation is never the current Host state', async () => {
  const lateSuccess = new FakeDirectoryPicker()
  const successGeneration = createSnapshotGenerationHarness()
  lateSuccess.listImpl = async () => {
    successGeneration.set({ id: 2 })
    return { ok: true, value: LISTING }
  }
  await assert.rejects(
    new RemoteHostDirectoryBrowsePort(lateSuccess, successGeneration.source)
      .list(undefined, new AbortController().signal),
    error => error instanceof SupersededReadError,
  )

  const lateFailure = new FakeDirectoryPicker()
  const failureGeneration = createSnapshotGenerationHarness()
  lateFailure.listImpl = async () => {
    failureGeneration.set({ id: 2 })
    return { ok: false, error: remoteFailure('directory-picker/unreadable') }
  }
  await assert.rejects(
    new RemoteHostDirectoryBrowsePort(lateFailure, failureGeneration.source)
      .list(undefined, new AbortController().signal),
    error => error instanceof SupersededReadError,
  )
})

test('the adapter never retries and never consumes a Session identity', async () => {
  const directoryPicker = new FakeDirectoryPicker()
  let failures = 0
  directoryPicker.listImpl = async () => {
    failures += 1
    return { ok: false, error: remoteFailure('gateway/service-unavailable', 'offline') }
  }
  const outcome = await new RemoteHostDirectoryBrowsePort(directoryPicker, createSnapshotGenerationHarness().source)
    .list(undefined, new AbortController().signal)
  assert.equal(outcome.kind, 'unavailable')
  assert.equal(failures, 1, 'one read is one dispatch: no automatic retry')
  assert.equal(directoryPicker.calls.length, 1)
  assert.equal(directoryPicker.calls[0]?.path, undefined)
  assert.equal('sessionId' in (directoryPicker.calls[0] ?? {}), false,
    'the official directory read takes no Session identity')
})
