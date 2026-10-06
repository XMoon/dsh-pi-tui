/**
 * Pure tests for the extracted search-reveal resolution
 * (`tui/transcript/reveal.ts`): which canonical Work/Context containers could
 * hide one row, and which of them hide it RIGHT NOW. The TuiApp-level
 * grant/revoke/promotion behaviour stays covered by
 * `disclosure-search-path.test.ts`; this file proves the rule itself and keeps
 * every positive control anchored by a negative one.
 * @module @xmoon76/dsh-pi-tui/transcript-reveal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { TranscriptMessage } from '../src/transcript.ts'
import type { ContextCluster } from '../src/tui/transcript/context-structure.ts'
import {
  transcriptRevealAncestryFor,
  transcriptRevealPathFor,
  type TranscriptRevealOpenness,
} from '../src/tui/transcript/reveal.ts'
import type { TranscriptWorkSpan } from '../src/tui/transcript/structure.ts'

const thinking = (turn: number, text = 'reasoning'): TranscriptMessage => ({ kind: 'thinking', turn, text, running: true })
const workSpan = (owner: TranscriptMessage, members: readonly TranscriptMessage[] = [owner]): TranscriptWorkSpan =>
  ({ kind: 'work', turn: 1, members, owner })
const clusterOf = (owner: TranscriptMessage, members: readonly TranscriptMessage[] = [owner]): ContextCluster =>
  ({ kind: 'context-cluster', turn: 1, members, owner })

/** Neither container is open: every resolved ancestor hides its row. */
const allClosed: TranscriptRevealOpenness = { workOpen: () => false, clusterOpen: () => false }

// --- stable ancestry -------------------------------------------------------

test('a Work member resolves to its canonical span only where Work is a real container', () => {
  const member = thinking(1)
  const span = workSpan(member)
  const inputs = {
    workByMember: new Map([[member, span]]),
    clusterByMember: new Map<TranscriptMessage, ContextCluster>(),
    workIsContainer: true,
    clusterIsContainer: false,
  }
  assert.deepEqual(transcriptRevealAncestryFor(member, inputs), { work: span })
  // The FLAT fail-open Work presentation hides nothing, so it must not resolve
  // an owner that a promotion would then strand.
  assert.deepEqual(transcriptRevealAncestryFor(member, { ...inputs, workIsContainer: false }), {})
  // A row outside the canonical Work membership never gains a Work ancestor.
  assert.deepEqual(transcriptRevealAncestryFor(thinking(2), inputs), {})
})

test('a Context member resolves to its canonical cluster independently of the Work capability', () => {
  const member = thinking(1)
  const cluster = clusterOf(member)
  const inputs = {
    workByMember: new Map<TranscriptMessage, TranscriptWorkSpan>(),
    clusterByMember: new Map([[member, cluster]]),
    workIsContainer: false,
    clusterIsContainer: true,
  }
  assert.deepEqual(transcriptRevealAncestryFor(member, inputs), { cluster })
  // A FLAT cluster has no header hiding its members: resolving or promoting it
  // would create a manual owner that unexpectedly reopens the cluster later.
  assert.deepEqual(transcriptRevealAncestryFor(member, { ...inputs, clusterIsContainer: false }), {})
  assert.deepEqual(transcriptRevealAncestryFor(thinking(2), inputs), {})
})

// --- current reveal path ---------------------------------------------------

test('the reveal path contains exactly the containers that hide the row now, outer-to-inner', () => {
  const member = thinking(1)
  const span = workSpan(member)
  const cluster = clusterOf(member)
  const both = { work: span, cluster }

  assert.deepEqual(transcriptRevealPathFor(both, allClosed), [
    { kind: 'work', owner: member },
    { kind: 'context-cluster', owner: member },
  ])
  // An already-open Work hides nothing: no Work node.
  assert.deepEqual(
    transcriptRevealPathFor(both, { workOpen: () => true, clusterOpen: () => false }),
    [{ kind: 'context-cluster', owner: member }],
  )
  // An already-open cluster hides nothing either.
  assert.deepEqual(
    transcriptRevealPathFor(both, { workOpen: () => false, clusterOpen: () => true }),
    [{ kind: 'work', owner: member }],
  )
  // Nothing hidden -> no reveal path at all (never an empty array).
  assert.equal(transcriptRevealPathFor(both, { workOpen: () => true, clusterOpen: () => true }), undefined)
  assert.equal(transcriptRevealPathFor({}, allClosed), undefined)
})

test('a manual or bulk-open owner mints no search-only reveal node', () => {
  const member = thinking(1)
  const span = workSpan(member)
  const cluster = clusterOf(member)
  // The openness predicates are the caller's mutable authority: a manual
  // disclosure set and the regular bulk master both answer "open" through the
  // SAME seam, so neither can be promoted again as a search-only node.
  const manuallyOpen: TranscriptRevealOpenness = {
    workOpen: candidate => candidate.owner === member,
    clusterOpen: candidate => candidate.owner === member,
  }
  assert.equal(transcriptRevealPathFor({ work: span, cluster }, manuallyOpen), undefined)
  // A DIFFERENT owner stays closed: the predicate is read per owner, not once.
  const other = thinking(2)
  assert.deepEqual(transcriptRevealPathFor({ work: span, cluster }, {
    workOpen: candidate => candidate.owner === other,
    clusterOpen: candidate => candidate.owner === other,
  }), [
    { kind: 'work', owner: member },
    { kind: 'context-cluster', owner: member },
  ])
})

test('a flat fail-open container mints no node even while the membership maps know the row', () => {
  const member = thinking(1)
  const span = workSpan(member)
  const cluster = clusterOf(member)
  const flat = transcriptRevealAncestryFor(member, {
    workByMember: new Map([[member, span]]),
    clusterByMember: new Map([[member, cluster]]),
    workIsContainer: false,
    clusterIsContainer: false,
  })
  assert.deepEqual(flat, {})
  assert.equal(transcriptRevealPathFor(flat, allClosed), undefined)
})
