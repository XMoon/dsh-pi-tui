/**
 * The fork's viewport-key capture policy (`Component.capturesViewportInput`)
 * answers "may the transcript preempt this focused component's page keys?".
 * The Host wraps overlay children in private-field frames, so the mounted frame
 * must re-expose the child's capability or the dispatcher cannot see it — and a
 * user's PageDown silently scrolls the transcript behind the visible list.
 * @module @xmoon76/dsh-pi-tui/tui/frame-capture.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Component } from '@xmoon76/pi-tui'
import { FocusForwardingFrame, Frame, ResponsiveOverlayFrame } from '../../src/tui/components/frame.ts'

function capturingChild(): Component & { capturesViewportInput: boolean | undefined } {
  return {
    capturesViewportInput: true,
    render: () => ['row'],
    invalidate: () => {},
  }
}

test('a frame re-exposes the wrapped child viewport capture dynamically', () => {
  const child = capturingChild()
  const frame = new Frame(child)
  assert.equal(frame.capturesViewportInput, true)

  child.capturesViewportInput = false
  assert.equal(frame.capturesViewportInput, false, 'the getter derives the CURRENT child state, never a cached flag')

  delete child.capturesViewportInput
  assert.equal(frame.capturesViewportInput, undefined, 'an ordinary child keeps the absence')
})

test('the focus and responsive overlay frames inherit the capture forwarding', () => {
  const child = capturingChild()
  const focusFrame = new FocusForwardingFrame(child)
  assert.equal(focusFrame.capturesViewportInput, true)
  child.capturesViewportInput = false
  assert.equal(focusFrame.capturesViewportInput, false)

  const responsiveChild = capturingChild()
  const responsive = new ResponsiveOverlayFrame(responsiveChild, () => ({ width: 20, maxHeight: 10, key: 'k' }))
  assert.equal(responsive.capturesViewportInput, true)
})
