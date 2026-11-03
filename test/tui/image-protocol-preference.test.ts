/**
 * The pure PI_IMAGE_PROTOCOL parser contract (P01–P05).
 *
 * Every case injects its own environment object: the parser must never read
 * or mutate `process.env` implicitly, and must never cache one answer across
 * calls.
 * @module @xmoon76/dsh-pi-tui/tui/image-protocol-preference.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { imageProtocolPreference } from '../../src/tui/graphics/image-protocol-preference.ts'

test('P01: unset, empty and auto all normalize to auto', () => {
  assert.equal(imageProtocolPreference({}), 'auto')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: '' }), 'auto')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: 'auto' }), 'auto')
})

test('P02: case and surrounding whitespace are normalized', () => {
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: 'KiTtY' }), 'kitty')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: ' sixel ' }), 'sixel')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: '\tITERM2\n' }), 'iterm2')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: ' Auto ' }), 'auto')
})

test('P03: none and 0 are the same hard off', () => {
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: 'none' }), 'none')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: '0' }), 'none')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: ' NONE ' }), 'none')
})

test('P04: every unknown value throws a concrete configuration error, never auto', () => {
  for (const value of ['off', 'true', '1', 'sixelx']) {
    assert.throws(
      () => imageProtocolPreference({ PI_IMAGE_PROTOCOL: value }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /^Invalid PI_IMAGE_PROTOCOL: /)
        assert.ok(error.message.includes(JSON.stringify(value)), `actual value ${value} is named`)
        assert.match(error.message, /expected auto, kitty, sixel, iterm2, none, 0$/u)
        return true
      },
      value,
    )
  }
})

test('P05: only PI_IMAGE_PROTOCOL is read; the parser is pure and uncached', () => {
  assert.equal(imageProtocolPreference({ PI_FORCE_IMAGE_PROTOCOL: 'sixel' }), 'auto')
  assert.equal(
    imageProtocolPreference({ PI_IMAGE_PROTOCOL: 'kitty', PI_FORCE_IMAGE_PROTOCOL: 'sixel' }),
    'kitty',
  )
  const environment: NodeJS.ProcessEnv = { PI_IMAGE_PROTOCOL: 'sixel' }
  assert.equal(imageProtocolPreference(environment), 'sixel')
  assert.equal(imageProtocolPreference({ PI_IMAGE_PROTOCOL: 'kitty' }), 'kitty')
  assert.equal(imageProtocolPreference(environment), 'sixel')
  assert.deepEqual(environment, { PI_IMAGE_PROTOCOL: 'sixel' }, 'the parser never mutates its input')
})
