/**
 * Unit tests for the theme module: background-based dark/light detection,
 * custom theme resolution and schema validation, and live palette tracking
 * of the settings-list theme.
 * @module @xmoon76/dsh-pi-tui/theme.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentPalette,
  darkColors,
  detectThemeFromBackground,
  lightColors,
  resolveCustomTheme,
  setTheme,
  settingsListTheme,
  validateCustomTheme,
} from '../src/theme.ts'

test('detectThemeFromBackground picks light for bright backgrounds', () => {
  assert.equal(detectThemeFromBackground({ r: 255, g: 255, b: 255 }), 'light')
  assert.equal(detectThemeFromBackground({ r: 240, g: 240, b: 240 }), 'light')
  assert.equal(detectThemeFromBackground({ r: 0, g: 0, b: 0 }), 'dark')
  assert.equal(detectThemeFromBackground({ r: 30, g: 30, b: 30 }), 'dark')
  assert.equal(detectThemeFromBackground({ r: 120, g: 120, b: 120 }), 'dark')
  assert.equal(detectThemeFromBackground({ r: 140, g: 140, b: 140 }), 'light')
})

test('setTheme swaps between the built-in palettes', () => {
  setTheme('dark')
  assert.equal(currentPalette, darkColors)
  setTheme('light')
  assert.equal(currentPalette, lightColors)
  setTheme('dark')
})

test('resolveCustomTheme merges overrides onto the base palette', () => {
  const resolved = resolveCustomTheme({ name: 'test', base: 'light', colors: { primary: '#FF0000' } })
  assert.equal(resolved.primary, '#FF0000')
  assert.equal(resolved.text, lightColors.text, 'unset tokens inherit the base')
  const darkResolved = resolveCustomTheme({ name: 'test', colors: { error: '#00FF00' } })
  assert.equal(darkResolved.error, '#00FF00')
  assert.equal(darkResolved.text, darkColors.text)
})

test('validateCustomTheme accepts a well-formed file and rejects malformed ones', () => {
  assert.deepEqual(
    validateCustomTheme({ name: 'nord', base: 'light', colors: { primary: '#4FA8FF', text: '#111111' } }),
    { name: 'nord', base: 'light', colors: { primary: '#4FA8FF', text: '#111111' } },
  )
  assert.deepEqual(validateCustomTheme({ name: 'minimal' }), { name: 'minimal' })
  // Unknown token keys are rejected.
  assert.equal(validateCustomTheme({ name: 'x', colors: { primary: '#fff', bogus: '#000' } }), undefined)
  // Non-hex colour values are rejected.
  assert.equal(validateCustomTheme({ name: 'x', colors: { primary: 'red' } }), undefined)
  assert.equal(validateCustomTheme({ name: 'x', colors: { primary: 'rgb(1,2,3)' } }), undefined)
  // Bad base, missing name, and non-object shapes are rejected.
  assert.equal(validateCustomTheme({ name: 'x', base: 'solarized' }), undefined)
  assert.equal(validateCustomTheme({ colors: { primary: '#fff' } }), undefined)
  assert.equal(validateCustomTheme('nord'), undefined)
  assert.equal(validateCustomTheme(null), undefined)
  assert.equal(validateCustomTheme({ name: 'x', colors: [] }), undefined)
})

test('settingsListTheme is constructed per open and follows the live palette', () => {
  setTheme('dark')
  const darkCursor = settingsListTheme().cursor
  assert.ok(darkCursor.includes('38;2;79;168;255'), `dark cursor must use the dark primary (#4FA8FF): ${darkCursor}`)
  setTheme('light')
  const lightCursor = settingsListTheme().cursor
  assert.ok(lightCursor.includes('38;2;21;101;192'), `light cursor must use the light primary (#1565C0): ${lightCursor}`)
  assert.notEqual(darkCursor, lightCursor, 'the cursor colour must not be frozen at module load')
  setTheme('dark')
})
