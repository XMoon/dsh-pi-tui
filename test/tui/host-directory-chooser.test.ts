/**
 * The inline Host-directory chooser controller: ONE home read, ONE latest
 * prefix query generation, official-path candidate identity and per-editor
 * disposal.
 *
 * These cases own the CONTROLLER's async/lifecycle semantics. The panel suite
 * owns painting/admission; the query suite owns pure path grammar; the Host
 * port adapters own transport classification.
 * @module @xmoon76/dsh-pi-tui/host-directory-chooser.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'

import {
  HostDirectoryChooser,
  type HostDirectoryChooserSnapshot,
} from '../../src/tui/interaction/host-directory-chooser.ts'
import type { HostDirectoryBrowseOutcome } from '../../src/runtime/host-directory-browse-port.ts'

const POSIX_HOME = '/home/host'
const WINDOWS_HOME = 'C:\\Users\\host'

interface Call {
  readonly path: string | undefined
  readonly signal: AbortSignal
  readonly resolve: (outcome: HostDirectoryBrowseOutcome) => void
  readonly reject: (error: unknown) => void
}

function controllableList(): { readonly calls: Call[]; readonly list: (path: string | undefined, signal: AbortSignal) => Promise<HostDirectoryBrowseOutcome> } {
  const calls: Call[] = []
  return {
    calls,
    list: (path, signal) => new Promise<HostDirectoryBrowseOutcome>((resolve, reject) => {
      calls.push({ path, signal, resolve, reject })
    }),
  }
}

function entry(name: string, path: string, hidden = false): DirectoryEntry {
  return { name, path, hidden }
}

function listing(path: string, home: string, entries: readonly DirectoryEntry[], truncated = false): DirectoryListing {
  return { path, home, crumbs: [], entries: [...entries], truncated }
}

function ready(value: DirectoryListing): HostDirectoryBrowseOutcome {
  return { kind: 'ready', listing: value }
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

/** The debounce contract is 150ms; this bounded window waits for it plus one task. */
async function afterDebounce(): Promise<void> {
  // reason: the 150ms trailing debounce IS the contract under test.
  await new Promise<void>(resolve => { setTimeout(resolve, 200) })
}

function snapshotOf(chooser: HostDirectoryChooser): HostDirectoryChooserSnapshot {
  return chooser.snapshot()
}

test('Home prefills the Host home and reuses the SAME listing as the first level', async () => {
  const control = controllableList()
  const changes: number[] = []
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => { changes.push(1) } })
  chooser.begin()
  assert.equal(control.calls.length, 1)
  assert.equal(control.calls[0]!.path, undefined, 'the ONE Home read is list(undefined)')
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [
    entry('alpha', '/home/host/alpha'),
    entry('beta', '/home/host/beta'),
    entry('.hidden', '/home/host/.hidden', true),
  ])))
  await flush()
  assert.equal(chooser.input.getValue(), '/home/host/')
  assert.equal(control.calls.length, 1, 'the Home listing is reused; no duplicate list(home)')
  const snapshot = snapshotOf(chooser)
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.hostHome, POSIX_HOME)
  assert.deepEqual(snapshot.candidates.map(candidate => candidate.name), ['alpha', 'beta', '.hidden'])
  assert.equal(snapshot.candidates[2]!.hidden, true, 'a hidden child is still a candidate')
  assert.equal(snapshot.listingEntryCount, 3)
  assert.ok(changes.length >= 2, 'the controller asked for a repaint per committed state')
})

test('an initial/recovered path beats Home and the Home answer never rewrites the editor', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} }, '/bad/a')
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  assert.equal(chooser.input.getValue(), '/bad/a', 'the retained path keeps priority over the Home prefill')
  assert.equal(control.calls.length, 2, 'the known Host dialect starts one query for the retained path')
  assert.equal(control.calls[1]!.path, '/bad')
  control.calls[1]!.resolve(ready(listing('/bad', POSIX_HOME, [entry('a', '/bad/a')])))
  await flush()
  assert.deepEqual(snapshotOf(chooser).candidates.map(candidate => candidate.path), ['/bad/a'])
})

test('a Home answer arriving after real edits keeps the raw value and queries the latest prefix', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  chooser.handleInput('/srv/pr')
  assert.equal(control.calls.length, 1, 'no guessed parent list before the Host dialect is known')
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  assert.equal(chooser.input.getValue(), '/srv/pr')
  assert.equal(control.calls.length, 2)
  assert.equal(control.calls[1]!.path, '/srv')
  control.calls[1]!.resolve(ready(listing('/srv', POSIX_HOME, [
    entry('pr-one', '/srv/pr-one'),
    entry('other', '/srv/other'),
  ])))
  await flush()
  const snapshot = snapshotOf(chooser)
  assert.equal(snapshot.status, 'ready')
  assert.deepEqual(snapshot.candidates.map(candidate => candidate.path), ['/srv/pr-one'])
})

test('deleting to blank stays blank, sends no list and never restores Home', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  chooser.handleInput('\u0015') // Ctrl+U kills the whole line
  assert.equal(chooser.input.getValue(), '')
  assert.equal(snapshotOf(chooser).status, 'idle')
  assert.equal(control.calls.length, 1, 'an empty value never reaches list()')
  await afterDebounce()
  assert.equal(chooser.input.getValue(), '', 'no late Home initialization overwrites the cleared editor')
  assert.equal(control.calls.length, 1)
})

test('Tab accepts the official entry.path and opens the next level with one query', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [
    entry('project-a', '/home/host/project-a'),
    entry('project-b', '/home/host/project-b'),
  ])))
  await flush()
  const first = chooser.visibleSuggestions(8)
  chooser.acceptPaintedCandidate(first[1]!.path)
  assert.equal(chooser.input.getValue(), '/home/host/project-b/')
  assert.equal(control.calls.length, 2)
  assert.equal(control.calls[1]!.path, '/home/host/project-b/', 'the accepted value keeps its Host separator verbatim')
  assert.equal(control.calls[1]!.signal.aborted, false)
})

test('an unlisted/stale candidate identity is rejected without touching the editor', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  chooser.acceptPaintedCandidate('/home/host/not-listed')
  assert.equal(chooser.input.getValue(), '/home/host/')
  assert.equal(control.calls.length, 1)
})

test('arrow navigation is bounded by the rows the frame really painted', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [
    entry('a', '/home/host/a'),
    entry('b', '/home/host/b'),
    entry('c', '/home/host/c'),
  ])))
  await flush()
  assert.equal(chooser.visibleSuggestions(2).length, 2)
  chooser.handleInput('\u001b[B')
  chooser.handleInput('\u001b[B')
  chooser.handleInput('\u001b[B')
  assert.equal(snapshotOf(chooser).selectedIndex, 1, 'selection cycles only across painted rows')
  chooser.handleInput('\u001b[A')
  assert.equal(snapshotOf(chooser).selectedIndex, 0)
})

test('a superseded query generation can never settle the newer one', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} }, '/srv/a')
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  assert.equal(control.calls[1]!.path, '/srv')
  chooser.handleInput('b')
  assert.equal(control.calls[1]!.signal.aborted, true, 'the older query is aborted as soon as the value changes')
  await afterDebounce()
  assert.equal(control.calls.length, 3)
  control.calls[2]!.resolve(ready(listing('/srv', POSIX_HOME, [entry('ab', '/srv/ab')])))
  await flush()
  control.calls[1]!.resolve(ready(listing('/srv', POSIX_HOME, [entry('a', '/srv/a')])))
  await flush()
  const snapshot = snapshotOf(chooser)
  assert.deepEqual(snapshot.candidates.map(candidate => candidate.path), ['/srv/ab'])
  assert.equal(snapshot.status, 'ready')
})

test('Host refused, unavailable and unclassified failures stay distinct and observable', async () => {
  const refusedControl = controllableList()
  const refused = new HostDirectoryChooser({ list: refusedControl.list, onChange: () => {} }, '/srv/missing')
  refused.begin()
  refusedControl.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [])))
  await flush()
  refusedControl.calls[1]!.resolve({ kind: 'failed', reason: 'not fully qualified', code: 'directory-picker/unreadable' })
  await flush()
  assert.equal(snapshotOf(refused).status, 'failed')
  assert.match(snapshotOf(refused).message ?? '', /Directory unreadable: not fully qualified/u)

  const unavailableControl = controllableList()
  const unavailable = new HostDirectoryChooser({ list: unavailableControl.list, onChange: () => {} })
  unavailable.begin()
  unavailableControl.calls[0]!.resolve({ kind: 'unavailable', reason: 'transport disconnected', code: 'gateway/peer-disposed' })
  await flush()
  assert.equal(snapshotOf(unavailable).status, 'unavailable')
  assert.match(snapshotOf(unavailable).message ?? '', /Directory suggestions unavailable: transport disconnected/u)
  assert.equal(snapshotOf(unavailable).hostHome, undefined, 'an unavailable Host answer never synthesizes a home')

  const errorControl = controllableList()
  const failed = new HostDirectoryChooser({ list: errorControl.list, onChange: () => {} }, '/srv/a')
  failed.begin()
  errorControl.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [])))
  await flush()
  errorControl.calls[1]!.reject(new Error('protocol fault'))
  await flush()
  assert.equal(snapshotOf(failed).status, 'error')
  assert.match(snapshotOf(failed).message ?? '', /Directory suggestions failed: protocol fault/u)
})

test('a Remote supersession rejects silently instead of becoming a fake empty level', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} }, '/srv/a')
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [])))
  await flush()
  const superseded = new Error('the connection generation changed')
  superseded.name = 'SupersededReadError'
  control.calls[1]!.reject(superseded)
  await flush()
  const snapshot = snapshotOf(chooser)
  assert.equal(snapshot.status, 'loading')
  assert.equal(snapshot.message, undefined)
  assert.deepEqual(snapshot.candidates, [])
})

test('truncation and hidden entries keep their official facts', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [
    entry('.hidden', '/home/host/.hidden', true),
    entry('visible', '/home/host/visible'),
  ], true)))
  await flush()
  const snapshot = snapshotOf(chooser)
  assert.equal(snapshot.truncated, true)
  assert.deepEqual(snapshot.candidates.map(candidate => candidate.hidden), [true, false])
})

test('hidden suggestions stay hidden until a real edit, which queries again', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  chooser.hideSuggestions()
  assert.equal(snapshotOf(chooser).hidden, true)
  assert.deepEqual(snapshotOf(chooser).candidates, [])
  chooser.handleInput('a')
  await afterDebounce()
  assert.equal(snapshotOf(chooser).hidden, false)
  assert.equal(control.calls.length, 2)
  control.calls[1]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  assert.deepEqual(snapshotOf(chooser).candidates.map(candidate => candidate.path), ['/home/host/alpha'])
})

test('Windows home is case-insensitive, uses the Host separator and keeps official paths verbatim', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  control.calls[0]!.resolve(ready(listing(WINDOWS_HOME, WINDOWS_HOME, [
    entry('Project', 'C:\\Users\\host\\Project'),
  ])))
  await flush()
  assert.equal(chooser.input.getValue(), 'C:\\Users\\host\\')
  chooser.handleInput('pr')
  await afterDebounce()
  assert.equal(control.calls.length, 2)
  assert.equal(control.calls[1]!.path, 'C:\\Users\\host')
  control.calls[1]!.resolve(ready(listing('C:\\Users\\host', WINDOWS_HOME, [
    entry('Project', 'C:\\Users\\host\\Project'),
  ])))
  await flush()
  const snapshot = snapshotOf(chooser)
  assert.equal(snapshot.separator, '\\')
  assert.deepEqual(snapshot.candidates.map(candidate => candidate.name), ['Project'])
  chooser.acceptPaintedCandidate('C:\\Users\\host\\Project')
  assert.equal(chooser.input.getValue(), 'C:\\Users\\host\\Project\\')
})

test('dispose aborts both generations and fences every late reaction', async () => {
  const control = controllableList()
  const chooser = new HostDirectoryChooser({ list: control.list, onChange: () => {} })
  chooser.begin()
  const homeSignal = control.calls[0]!.signal
  chooser.dispose()
  assert.equal(homeSignal.aborted, true)
  control.calls[0]!.resolve(ready(listing(POSIX_HOME, POSIX_HOME, [entry('alpha', '/home/host/alpha')])))
  await flush()
  assert.equal(chooser.input.getValue(), '', 'a disposed editor never receives the Home prefill')
  assert.equal(snapshotOf(chooser).hostHome, undefined)
})
