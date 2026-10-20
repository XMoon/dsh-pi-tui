/**
 * Unit tests for `scripts/tern-pane-geometry.mjs` — the traps that make a
 * "visible" claim wrong in a real Tern pane, covered without a Tern binary:
 *
 *   - a node's own rect is not a visibility proof (its clip ancestor decides);
 *   - a line can fit the horizontal clip and still fall past its region's bottom;
 *   - the click point must sit on the fragment the client shows on BOTH axes,
 *     never on the node's own centre, which can be covered by whatever clips it
 *     — or be off screen entirely;
 *   - a zero-sized ancestor cannot clip.
 *
 * Every case nests the measured node INSIDE the box that clips it, which is the
 * only shape the client produces: overflow clipping comes from ancestors.
 *
 * Run with `node --test test/tooling/tern-pane-geometry.test.mjs` from the repo root
 * (`pnpm test:tooling`).
 * @module test/tern-pane-geometry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ancestorsOf, containedX, containedXY, index, rect, visiblePoint, visibleSpan,
} from '../../scripts/tern-pane-geometry.mjs'

/** A node as the real tree reports it: a box plus optional children. */
const node = (box, children) => ({ tag: 'div', rect: box, ...(children === undefined ? {} : { children }) })

/** Nest each box inside the previous one, outermost first. */
const chain = (boxes) => boxes.reduceRight((child, box) => node(box, child === undefined ? undefined : [child]), undefined)

test('index records each node and its own ancestor chain', () => {
  const { nodes, chains } = index([chain([[0, 0, 40, 40], [2, 2, 20, 20], [4, 4, 10, 10]])])
  assert.equal(nodes.length, 3)
  assert.deepEqual(ancestorsOf(chains, nodes[2]), [nodes[0], nodes[1]], 'the chain excludes the node itself')
  assert.deepEqual(ancestorsOf(chains, nodes[0]), [])
})

test('a node the tree reports without a rect has no box', () => {
  assert.deepEqual(rect({ tag: 'div' }), [0, 0, 0, 0], 'an absent rect must not read as a visible box')
})

test('visibleSpan intersects every clipping ancestor, and skips zero-width ones', () => {
  const { chains, nodes } = index([chain([[0, 0, 400, 400], [0, 0, 300, 400], [50, 0, 100, 400], [40, 0, 200, 10]])])
  assert.equal(visibleSpan(chains, nodes[3], 'x'), 100, '50..150 survives all three ancestors, not the own 40..240')

  const zeroed = index([chain([[100, 0, 0, 400], [100, 0, 50, 10]])])
  assert.equal(visibleSpan(zeroed.chains, zeroed.nodes[1], 'x'), 50, 'a zero-width ancestor cannot clip')
})

test('containedX rejects a box wider than its clip ancestor', () => {
  const wide = node([50, 10, 300, 20])
  const fits = node([110, 10, 180, 20])
  const clip = node([100, 0, 200, 400], [wide, fits])
  const { chains } = index([node([0, 0, 400, 400], [clip])])
  assert.equal(containedX(chains, wide), false)
  assert.equal(containedX(chains, fits), true)
})

test('containedXY catches the line that fits horizontally but overflows its region bottom', () => {
  const line = node([10, 150, 200, 16])
  const region = node([0, 100, 400, 60], [line])
  const { chains } = index([node([0, 0, 400, 400], [region])])
  assert.equal(containedX(chains, line), true, 'the horizontal clip is satisfied')
  assert.equal(visibleSpan(chains, line, 'y'), 10, 'only 150..160 of the 16px line survives')
  assert.equal(containedXY(chains, line), false, 'a clipped line is present but not readable')
})

test('visiblePoint clicks the shown fragment, not the own-rect centre', () => {
  const button = node([50, 10, 100, 20])
  const clip = node([100, 0, 200, 400], [button])
  const { chains } = index([node([0, 0, 400, 400], [clip])])
  assert.deepEqual(visiblePoint(chains, button), { x: 125, y: 20 }, 'the own centre (100) sits on the clip edge')
})

test('visiblePoint clips the VERTICAL axis too, and never aims below the region', () => {
  const line = node([10, 150, 200, 50])
  const region = node([0, 100, 400, 60], [line])
  const { chains } = index([node([0, 0, 400, 400], [region])])
  // 150..160 survives; the own centre (y=175) is inside the clipped-away part and
  // would click whatever sits under the region.
  assert.deepEqual(visiblePoint(chains, line), { x: 110, y: 155 }, 'not the own centre y=175')
})

test('visiblePoint refuses a node that survives nothing vertically', () => {
  const scrolledOut = node([10, 200, 20, 16])
  const region = node([0, 100, 400, 60], [scrolledOut])
  const { chains } = index([node([0, 0, 400, 400], [region])])
  assert.equal(visibleSpan(chains, scrolledOut, 'x'), 20, 'it still has width')
  assert.equal(visiblePoint(chains, scrolledOut), undefined, 'but no part of it is on screen')
})

test('visiblePoint refuses a fragment too small to hit', () => {
  const covered = node([60, 5, 20, 20])
  const clip = node([0, 0, 50, 400], [covered])
  const { chains } = index([node([0, 0, 400, 400], [clip])])
  assert.equal(visiblePoint(chains, covered), undefined, 'nothing of it survives')
})
