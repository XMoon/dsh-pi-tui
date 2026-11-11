/**
 * Session Workspace PR1 L2: the Direct Host directory-browse adapter.
 *
 * The adapter is a FORWARDING boundary over the official in-process
 * `ctx.directoryPickerController.list` handler — the same Host method the
 * generated `directoryPicker/list` Remote verb reaches. These tests prove the
 * official listing is passed through unchanged, the explicit path is never
 * rewritten, a missing controller is a truthful unavailable, the Host's own
 * unreadable refusal is a `failed` outcome (not an empty level), cancellation
 * never yields a ready listing, and no Workspace/Session method is touched.
 *
 * @module @xmoon76/dsh-pi-tui/host-directory-browse-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import {
  DIRECT_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON,
  DirectHostDirectoryBrowsePort,
  type DirectHostDirectoryBrowseContext,
  type HostDirectoryPickerControllerLike,
} from '../../../src/runtime/direct/host-directory-browse-direct.ts'

const LISTING: DirectoryListing = {
  path: '/srv/host/proof',
  home: '/home/host-user',
  crumbs: [
    { name: '/', path: '/', hidden: false },
    { name: 'srv', path: '/srv', hidden: false },
    { name: 'host', path: '/srv/host', hidden: false },
    { name: 'proof', path: '/srv/host/proof', hidden: false },
  ],
  entries: [
    { name: '.hidden-project', path: '/srv/host/proof/.hidden-project', hidden: true },
    { name: 'alpha', path: '/srv/host/proof/alpha', hidden: false },
  ],
  truncated: true,
}

/** The official controller fake: records only the ONE Host call the adapter may make. */
class FakeController {
  readonly calls: Array<{ readonly path: string | undefined; readonly signal: AbortSignal }> = []
  listImpl: (path: string | undefined, signal: AbortSignal) => Promise<DirectoryListing> =
    async () => LISTING

  list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListing> {
    this.calls.push({ path, signal })
    return this.listImpl(path, signal)
  }
}

/** The narrow context fake: records every service the adapter resolves. */
function contextWith(controller: unknown): DirectHostDirectoryBrowseContext & { readonly gets: string[] } {
  const gets: string[] = []
  return {
    gets,
    get(name: string): unknown {
      gets.push(name)
      return name === 'directoryPickerController' ? controller : undefined
    },
  }
}

test('list(undefined) returns the official Host listing unchanged and calls the controller once', async () => {
  const controller = new FakeController()
  const ctx = contextWith(controller)
  const port = new DirectHostDirectoryBrowsePort(ctx)
  const signal = new AbortController().signal
  const outcome = await port.list(undefined, signal)
  assert.equal(outcome.kind, 'ready')
  assert.ok(outcome.kind === 'ready')
  // The Host's own object is the result: no DTO copy, no re-sort, no re-scan.
  assert.equal(outcome.listing, LISTING)
  assert.equal(outcome.listing.home, '/home/host-user')
  assert.equal(outcome.listing.truncated, true)
  assert.equal(outcome.listing.crumbs.length, 4)
  assert.deepEqual(outcome.listing.entries.map(entry => entry.hidden), [true, false])
  assert.deepEqual(controller.calls, [{ path: undefined, signal }])
  assert.deepEqual(ctx.gets, ['directoryPickerController'])
})

test('an explicit Host absolute path is passed through verbatim', async () => {
  const controller = new FakeController()
  const port = new DirectHostDirectoryBrowsePort(contextWith(controller))
  const path = '/srv/../srv//host/proof/'
  const outcome = await port.list(path, new AbortController().signal)
  assert.equal(outcome.kind, 'ready')
  assert.equal(controller.calls[0]?.path, path,
    'the adapter must never normalize, join or realpath the requested Host path')
})

test('an empty Host level is a successful ready listing, not an unavailable outcome', async () => {
  const controller = new FakeController()
  controller.listImpl = async path => ({
    path: path ?? '/home/host-user',
    home: '/home/host-user',
    crumbs: [{ name: '/', path: '/', hidden: false }],
    entries: [],
    truncated: false,
  })
  const outcome = await new DirectHostDirectoryBrowsePort(contextWith(controller))
    .list(undefined, new AbortController().signal)
  assert.equal(outcome.kind, 'ready')
  assert.ok(outcome.kind === 'ready')
  assert.deepEqual(outcome.listing.entries, [])
})

test('a Host without the official controller answers the truthful unavailable outcome', async () => {
  const ctx = contextWith(undefined)
  const outcome = await new DirectHostDirectoryBrowsePort(ctx).list(undefined, new AbortController().signal)
  assert.equal(outcome.kind, 'unavailable')
  assert.ok(outcome.kind === 'unavailable')
  assert.equal(outcome.reason, DIRECT_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON)
  assert.equal(outcome.code, 'directory-picker/unavailable')
  assert.deepEqual(ctx.gets, ['directoryPickerController'])
})

test('the seam unreadable code and its wire projection are the Host-refused outcome', async () => {
  for (const error of [
    new DirectoryPickerError('directory-unreadable', '/srv/host/missing', 'cannot list /srv/host/missing'),
    Object.assign(new Error('not fully qualified'), { code: 'directory-picker/unreadable' }),
  ]) {
    const controller = new FakeController()
    controller.listImpl = async () => { throw error }
    const outcome = await new DirectHostDirectoryBrowsePort(contextWith(controller))
      .list('/srv/host/missing', new AbortController().signal)
    assert.equal(outcome.kind, 'failed')
    assert.ok(outcome.kind === 'failed')
    assert.equal(outcome.code, (error as { readonly code: string }).code)
    assert.match(outcome.reason, /cannot list|not fully qualified/u)
  }
})

test('an official browse-capability refusal is unavailable, not a refusal of the path', async () => {
  const controller = new FakeController()
  controller.listImpl = async () => {
    throw Object.assign(new Error('the composed picker serves "native"'), { code: 'directory-picker/unavailable' })
  }
  const outcome = await new DirectHostDirectoryBrowsePort(contextWith(controller))
    .list(undefined, new AbortController().signal)
  assert.equal(outcome.kind, 'unavailable')
  assert.ok(outcome.kind === 'unavailable')
  assert.equal(outcome.code, 'directory-picker/unavailable')
})

test('an aborted caller never receives a ready listing', async () => {
  const before = new AbortController()
  before.abort()
  const notCalled = new FakeController()
  await assert.rejects(
    new DirectHostDirectoryBrowsePort(contextWith(notCalled)).list(undefined, before.signal),
    error => error instanceof Error && error.name === 'AbortError',
  )
  assert.deepEqual(notCalled.calls, [], 'a pre-aborted read must not reach the Host')

  const during = new AbortController()
  const controller = new FakeController()
  controller.listImpl = async () => {
    during.abort()
    return LISTING
  }
  await assert.rejects(
    new DirectHostDirectoryBrowsePort(contextWith(controller)).list(undefined, during.signal),
    error => error instanceof Error && error.name === 'AbortError',
  )
})

test('an unclassified Host failure stays observable instead of becoming an outcome', async () => {
  const controller = new FakeController()
  const failure = new TypeError('the Host handler is broken')
  controller.listImpl = async () => { throw failure }
  await assert.rejects(
    new DirectHostDirectoryBrowsePort(contextWith(controller)).list(undefined, new AbortController().signal),
    error => error === failure,
  )
})

test('the adapter consumes the official controller through its one-method read surface', () => {
  const controller = new FakeController()
  const narrow: HostDirectoryPickerControllerLike = controller
  assert.equal(typeof narrow.list, 'function')
})
