/**
 * Unit tests for the theme module: background-based dark/light detection
 * and custom theme resolution.
 * @module @xmoon76/tui-app/theme.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { currentPalette, darkColors, detectThemeFromBackground, lightColors, resolveCustomTheme, setTheme } from '../src/theme.ts'

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
