/**
 * Pure tests for the ONE long-message disclosure geometry shared by the user
 * bubble and the relay Context row.
 * @module @xmoon76/dsh-pi-tui/long-message-disclosure.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { longMessageDisclosureWindow } from '../src/long-message-disclosure.ts'

const geometry = { thresholdRows: 10, headRows: 4, tailRows: 3 }
const marker = (hidden: number): string => `… ${hidden} hidden`

test('a body at or below the threshold is never folded', () => {
  const body = Array.from({ length: 10 }, (_, index) => `row ${index}`)
  const window = longMessageDisclosureWindow(body, geometry, { expanded: false, marker })
  assert.equal(window.long, false)
  assert.equal(window.markerRow, undefined)
  assert.deepEqual(window.rows, body)
  assert.equal(window.hiddenRows, 0)
})

test('a long body keeps head + marker + tail with the hidden count between them', () => {
  const body = Array.from({ length: 30 }, (_, index) => `row ${index}`)
  const window = longMessageDisclosureWindow(body, geometry, { expanded: false, marker })
  assert.equal(window.long, true)
  assert.equal(window.markerRow, 4)
  assert.equal(window.hiddenRows, 30 - 4 - 3)
  assert.deepEqual(window.rows[0], 'row 0')
  assert.deepEqual(window.rows[3], 'row 3')
  assert.deepEqual(window.rows[4], '… 23 hidden')
  assert.deepEqual(window.rows[5], 'row 27')
  assert.deepEqual(window.rows[7], 'row 29')
})

test('an expanded body renders in full with no marker and no duplicated rows', () => {
  const body = Array.from({ length: 30 }, (_, index) => `row ${index}`)
  const window = longMessageDisclosureWindow(body, geometry, { expanded: true, marker })
  assert.equal(window.long, true)
  assert.equal(window.markerRow, undefined)
  assert.equal(window.hiddenRows, 0)
  assert.deepEqual(window.rows, body)
})

test('head + tail covering the whole body folds nothing', () => {
  const body = Array.from({ length: 12 }, (_, index) => `row ${index}`)
  const window = longMessageDisclosureWindow(
    body,
    { thresholdRows: 10, headRows: 8, tailRows: 8 },
    { expanded: false, marker },
  )
  assert.equal(window.long, true)
  assert.equal(window.markerRow, undefined)
  assert.deepEqual(window.rows, body)
})

test('the window slices the WRAPPED rows it is given, never logical lines', () => {
  // A single logical line wrapped into 4 visual rows is treated as 4 rows.
  const wrapped = ['very long', 'wrapped', 'line part', 'three']
  const window = longMessageDisclosureWindow(wrapped, { thresholdRows: 2, headRows: 1, tailRows: 1 }, { expanded: false, marker })
  assert.equal(window.markerRow, 1)
  assert.deepEqual(window.rows, ['very long', '… 2 hidden', 'three'])
})
