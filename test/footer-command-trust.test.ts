/**
 * Headless tests for the footer command TRUST GATE (plan §17.4/§17.13):
 * the command is read ONLY from the settings descriptor's USER layer — a
 * merged/project-supplied value is refused, and invalid configs fail
 * soft.
 * @module @xmoon76/dsh-pi-tui/footer-command-trust.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseFooterCommandConfig, resolveTrustedFooterCommand, resolveUserLayerFooterMode } from '../src/footer/command-trust.ts'

const NS = 'dsh-pi-tui'

function descriptor(user: unknown): { ns: string; user?: unknown } {
  return user === undefined ? { ns: NS } : { ns: NS, user }
}

test('a user-layer footerCommand resolves with the validated bounds', () => {
  const config = resolveTrustedFooterCommand([descriptor({
    footerCommand: { schemaVersion: 1, command: '~/.config/dsh/statusline.sh', timeoutMs: 500, refreshIntervalMs: 2000, maxRows: 2 },
  })], NS)
  assert.ok(config !== undefined)
  assert.equal(config.command, '~/.config/dsh/statusline.sh')
  assert.equal(config.timeoutMs, 500)
  assert.equal(config.refreshIntervalMs, 2000)
  assert.equal(config.maxRows, 2)
})

test('a merged-only value (no user layer) is REFUSED — the project cannot execute', () => {
  const config = resolveTrustedFooterCommand([descriptor(undefined)], NS)
  assert.equal(config, undefined)
})

test('a project-supplied footerCommand in the user layer of ANOTHER namespace is refused', () => {
  const config = resolveTrustedFooterCommand([{ ns: 'other-ns', user: { footerCommand: { schemaVersion: 1, command: 'evil' } } }], NS)
  assert.equal(config, undefined)
})

test('missing descriptors are refused', () => {
  assert.equal(resolveTrustedFooterCommand(undefined, NS), undefined)
  assert.equal(resolveTrustedFooterCommand([], NS), undefined)
})

test('invalid configs fail soft (undefined)', () => {
  const cases: unknown[] = [
    null,
    { schemaVersion: 2, command: 'x' },
    { schemaVersion: 1, command: '' },
    { schemaVersion: 1, command: '  ' },
  ]
  for (const value of cases) {
    assert.equal(parseFooterCommandConfig(value), undefined, JSON.stringify(value))
  }
  // A non-number bound falls back to the default (fail-soft), never a crash.
  const fallback = parseFooterCommandConfig({ schemaVersion: 1, command: 'x', timeoutMs: 'fast' })
  assert.ok(fallback !== undefined)
  assert.equal(fallback.timeoutMs, 300)
})

test('bounds clamp: timeout ≤ 1000, interval ≥ 1000, rows 1..2', () => {
  const config = parseFooterCommandConfig({ schemaVersion: 1, command: 'x', timeoutMs: 5000, refreshIntervalMs: 10, maxRows: 9 })
  assert.ok(config !== undefined)
  assert.equal(config.timeoutMs, 1000)
  assert.equal(config.refreshIntervalMs, 1000)
  assert.equal(config.maxRows, 2)
  const defaults = parseFooterCommandConfig({ schemaVersion: 1, command: 'x' })
  assert.ok(defaults !== undefined)
  assert.equal(defaults.timeoutMs, 300)
  assert.equal(defaults.refreshIntervalMs, 1000)
  assert.equal(defaults.maxRows, 1)
})

test('command MODE must be user-layer-owned: a project flipping footer: command never arms the user command', () => {
  // The user layer declares the COMMAND but not the MODE: the merged
  // value may say command (a project layer), but the user never opted in
  // — the mode resolver reports no user-owned command mode.
  const commandOnly = resolveUserLayerFooterMode([descriptor({ footerCommand: { schemaVersion: 1, command: 'x' } })], NS)
  assert.equal(commandOnly, undefined)
  // The user layer declares BOTH: the mode is user-owned (armed).
  const armed = resolveUserLayerFooterMode([descriptor({ footer: 'command', footerCommand: { schemaVersion: 1, command: 'x' } })], NS)
  assert.equal(armed, 'command')
  // A different user-owned mode stays visible (a project footer: command
  // cannot override it).
  const custom = resolveUserLayerFooterMode([descriptor({ footer: 'custom' })], NS)
  assert.equal(custom, 'custom')
  // Absent descriptors / user sections report undefined.
  assert.equal(resolveUserLayerFooterMode(undefined, NS), undefined)
  assert.equal(resolveUserLayerFooterMode([descriptor(undefined)], NS), undefined)
})
