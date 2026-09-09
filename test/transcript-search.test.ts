/**
 * Host transcript-search overlay mouse parity (the cap audit's last Host
 * private Input): the query row click-positions the private Input; the
 * title and hint rows are inert. Mirrors vendor X049 for the alt-screen
 * search component.
 * @module @xmoon76/dsh-pi-tui/transcript-search.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TranscriptSearchComponent } from '../src/search.ts'
import type { TuiMouseEvent } from '@xmoon76/pi-tui'

function mouse(type: 'press' | 'click', x: number, y: number, width = 40, height = 3): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

test('transcript search: clicking the query row positions the private Input cursor', () => {
  const queries: string[] = []
  const component = new TranscriptSearchComponent(query => queries.push(query))
  component.handleInput('a')
  component.handleInput('b')
  component.handleInput('c') // query 'abc'
  const rendered = component.render(40)
  // Row 0 = title, row 1 = the Input's own render, row 2 = hint.
  assert.ok(rendered[1]!.includes('>'), `input row missing:\n${rendered.join('\n')}`)
  // The Input renders its '> ' prompt then the value: 'a' is at col 2,
  // 'b' at col 3 — clicking col 3 places the cursor after 'a'.
  const result = component.handleMouse(mouse('press', 3, 1))
  assert.ok(result?.handled, 'the query row press must be handled')
  component.handleInput('X')
  const last = queries[queries.length - 1]
  assert.equal(last, 'aXbc', 'the click must position the Input cursor')
})

test('transcript search: title and hint rows are inert', () => {
  const queries: string[] = []
  const component = new TranscriptSearchComponent(query => queries.push(query))
  const rendered = component.render(40)
  assert.equal(component.handleMouse(mouse('press', 5, 0)), undefined, 'the title row must be inert')
  assert.equal(component.handleMouse(mouse('press', 5, 2)), undefined, 'the hint row must be inert')
})
