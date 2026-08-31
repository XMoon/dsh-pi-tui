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

test('the Direct config-port trust read resolves the same USER-layer facts', async () => {
  // The runner's gate goes through the CONFIG PORT: the Direct adapter
  // reads the settings descriptor's user layer — same refusal semantics,
  // no raw ctx access in the runner.
  const { DirectConfigPort } = await import('../src/runtime/direct/config-direct.ts')
  const ctx = {
    get: () => ({
      describe: () => [{
        ns: 'dsh-pi-tui',
        user: { footer: 'command', footerCommand: { schemaVersion: 1, command: '~/.config/dsh/statusline.sh' } },
      }],
    }),
  }
  const port = new DirectConfigPort(ctx as never, undefined, () => undefined)
  assert.equal(port.footerCommandTrust.userFooterMode, 'command')
  assert.equal(port.footerCommandTrust.command?.command, '~/.config/dsh/statusline.sh')
  // No user layer: refused.
  const empty = new DirectConfigPort({ get: () => ({ describe: () => [{ ns: 'dsh-pi-tui' }] }) } as never, undefined, () => undefined)
  assert.equal(empty.footerCommandTrust.userFooterMode, undefined)
  assert.equal(empty.footerCommandTrust.command, undefined)
})

test('the Direct custom-item read separates USER raw storage from the safe runtime projection', async () => {
  const userRaw: unknown[] = [
    { schemaVersion: 1, id: 'user:user-owned', kind: 'text', text: 'USER' },
    { schemaVersion: 1, id: 'user:future-command', kind: 'future-kind', command: 'date', payload: { nested: ['preserve'] } },
  ]
  const projectRaw: unknown[] = [{ schemaVersion: 1, id: 'user:project-owned', kind: 'text', text: 'PROJECT' }]
  const port = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => [{ ns: 'dsh-pi-tui', value: { footerCustomItems: projectRaw }, user: { footerCustomItems: userRaw } }] }),
  } as never, {
    get: () => ({ footerCustomItems: projectRaw }),
    replace: () => {},
  } as never, () => undefined)
  assert.deepEqual(port.footerCustomItems.get().items, [userRaw[0]])
  assert.equal(port.footerCustomItems.get().invalidCount, 1)
  const raw = port.footerCustomItems.rawForPersistence()
  assert.equal(raw.kind, 'available')
  if (raw.kind === 'available') {
    assert.deepEqual(raw.value, userRaw)
    assert.notEqual(raw.value, userRaw, 'raw persistence must not expose descriptor-owned references')
    assert.notEqual(
      (raw.value as Array<Record<string, unknown>>)[1]?.payload,
      (userRaw[1] as Record<string, unknown>).payload,
      'raw persistence must deep-clone unknown/future fields too',
    )
  }

  const revoked = Proxy.revocable([], {})
  revoked.revoke()
  const unsafe = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => [{ ns: 'dsh-pi-tui', user: { footerCustomItems: revoked.proxy } }] }),
  } as never, undefined, () => undefined)
  assert.deepEqual(unsafe.footerCustomItems.rawForPersistence(), { kind: 'unavailable' })

  const noUser = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => [{ ns: 'dsh-pi-tui', value: { footerCustomItems: projectRaw } }] }),
  } as never, {
    get: () => ({ footerCustomItems: projectRaw }),
    replace: () => {},
  } as never, () => undefined)
  assert.deepEqual(noUser.footerCustomItems.get().items, [])
  assert.deepEqual(noUser.footerCustomItems.rawForPersistence(), { kind: 'available', value: undefined })

  const unavailable = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => { throw new Error('settings read failed') } }),
  } as never, undefined, () => undefined)
  assert.deepEqual(unavailable.footerCustomItems.get(), { items: [], invalidCount: 1 })
  assert.deepEqual(unavailable.footerCustomItems.rawForPersistence(), { kind: 'unavailable' })

  const absentService = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => undefined,
  } as never, undefined, () => undefined)
  assert.deepEqual(absentService.footerCustomItems.get(), { items: [], invalidCount: 1 })
  assert.deepEqual(absentService.footerCustomItems.rawForPersistence(), { kind: 'unavailable' })

  const absentDescriptor = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => [] }),
  } as never, undefined, () => undefined)
  assert.deepEqual(absentDescriptor.footerCustomItems.get(), { items: [], invalidCount: 1 })
  assert.deepEqual(absentDescriptor.footerCustomItems.rawForPersistence(), { kind: 'unavailable' })
})

test('TuiSettingsDoc round-trip: a whole-document replace never wipes the trusted footerCommand (review P2 migration contract)', async () => {
  // The settings port is get/replace WHOLE-DOCUMENT: a future Remote
  // adapter serializes the DECLARED DTO, so every semantic field must be
  // part of it. The old document type omitted footerCommand — a
  // Remote-shaped get→change-theme→replace cycle would silently delete
  // the trusted command config (the same migration contract the raw
  // `keybindings` pass-through carries). The Direct adapter rides the
  // real schemastery object through, so this test pins the DECLARED
  // shape: the field is part of TuiSettingsDoc and a get/replace cycle
  // preserves it.
  const { DirectConfigPort } = await import('../src/runtime/direct/config-direct.ts')
  const footerCommand = {
    schemaVersion: 1 as const,
    command: '~/.config/dsh/statusline.sh',
    timeoutMs: 1000,
    refreshIntervalMs: 2000,
    maxRows: 2,
  }
  const footerCustomItems = [{
    schemaVersion: 1 as const,
    id: 'user:environment',
    kind: 'text' as const,
    text: 'PROD',
    tone: 'warning' as const,
  }]
  let backing: Record<string, unknown> = {
    theme: 'dark',
    iconStyle: 'emoji',
    footer: 'command',
    footerFallbackMode: 'default',
    footerCommand,
    footerCustomItems,
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'input',
    focusMode: 'off',
    keybindings: { version: 1, bindings: {} },
  }
  const port = new DirectConfigPort({ get: () => ({ describe: () => [{ ns: 'dsh-pi-tui', user: { footerCommand } }] }) } as never, {
    get: () => backing as never,
    replace: (next: unknown) => { backing = { ...(next as Record<string, unknown>) } },
  }, () => undefined)
  assert.ok(port.tuiSettings !== undefined, 'the surface is wired')
  // The trust read resolves the SAME field the DTO round-trips.
  assert.equal(port.footerCommandTrust.command?.command, footerCommand.command)
  // Change an UNRELATED key and replace the whole document.
  port.tuiSettings.replace({ ...port.tuiSettings.get(), theme: 'light' })
  // The replace round-trips footerCommand verbatim.
  const reread = port.tuiSettings.get()
  assert.deepEqual(reread.footerCommand, footerCommand,
    'footerCommand must survive a whole-document replace')
  assert.deepEqual(reread.footerCustomItems, footerCustomItems,
    'footerCustomItems must survive a whole-document replace')
})

test('the USER-layer layout projection is the ONLY activation source (PR D activation trust)', async () => {
  const userLayout = { schemaVersion: 1, rows: [{ left: [{ id: 'user:clock' }], right: [] }] }
  const port = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      // The PROJECT (merged) layer supplies a custom layout referencing
      // user:clock; the USER layer declares footer: default and no layout.
      value: { footer: 'custom', footerLayout: userLayout },
      user: { footer: 'default' },
    }] }),
  } as never, undefined, () => undefined)
  assert.equal(port.footerCommandTrust.userFooterLayout, undefined,
    'a project merged layout must never surface as the USER-layer activation layout')

  // The USER layer declaring custom + a valid layout IS the activation.
  const userPort = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      value: { footer: 'custom', footerLayout: userLayout },
      user: { footer: 'custom', footerLayout: userLayout },
    }] }),
  } as never, undefined, () => undefined)
  assert.deepEqual(userPort.footerCommandTrust.userFooterLayout, userLayout)

  // An INVALID user layout activates nothing (fail-safe).
  const invalidPort = new (await import('../src/runtime/direct/config-direct.ts')).DirectConfigPort({
    get: () => ({ describe: () => [{
      ns: 'dsh-pi-tui',
      user: { footer: 'custom', footerLayout: { schemaVersion: 1, rows: 'junk' } },
    }] }),
  } as never, undefined, () => undefined)
  assert.equal(invalidPort.footerCommandTrust.userFooterLayout, undefined)
})
