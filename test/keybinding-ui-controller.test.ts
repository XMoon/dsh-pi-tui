import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'
import {
  KeybindingEditorController,
  type KeybindingMutation,
} from '../src/keybinding-ui/controller.ts'
import { serializeTuiSettingsMutation, type TuiSettingsDoc } from '../src/runtime/config-port.ts'

function settingsFixture(initialKeybindings: unknown): {
  settings: { get(): TuiSettingsDoc; replace(doc: TuiSettingsDoc): unknown }
  getCount: () => number
  replaceCount: () => number
  latest: () => TuiSettingsDoc | undefined
} {
  let doc: TuiSettingsDoc = {
    theme: 'auto',
    iconStyle: 'symbols',
    footer: 'default',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'off',
    homeEndKeys: 'off',
    focusMode: 'off',
    footerCommand: { command: 'printf status', intervalMs: 1000 },
    unrelated: 'preserved',
    keybindings: initialKeybindings,
  } as unknown as TuiSettingsDoc
  let gets = 0
  let replaces = 0
  let latest: TuiSettingsDoc | undefined
  return {
    settings: {
      get: () => {
        gets += 1
        return doc
      },
      replace: next => {
        replaces += 1
        latest = next
        doc = next
      },
    },
    getCount: () => gets,
    replaceCount: () => replaces,
    latest: () => latest,
  }
}

function controllerFor(fixture: ReturnType<typeof settingsFixture>, manager = new HostKeybindingManager()) {
  manager.setUserConfiguration(parseUserKeybindings(fixture.settings.get().keybindings))
  return { controller: new KeybindingEditorController({ settings: fixture.settings, manager }), manager }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

test('mutation performs one get, one replace, preserves unrelated fields, then projects the same candidate', async () => {
  const fixture = settingsFixture(undefined)
  const { controller, manager } = controllerFor(fixture)
  try {
    const mutation: KeybindingMutation = {
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    }
    const result = await controller.mutate(mutation)
    assert.equal(result.kind, 'applied')
    assert.equal(fixture.getCount(), 2)
    assert.equal(fixture.replaceCount(), 1)
    assert.equal((fixture.latest() as unknown as Record<string, unknown>).unrelated, 'preserved')
    assert.deepEqual((fixture.latest() as TuiSettingsDoc).footerCommand, { command: 'printf status', intervalMs: 1000 })
    assert.equal((fixture.latest() as TuiSettingsDoc).keybindings && typeof (fixture.latest() as TuiSettingsDoc).keybindings, 'object')
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t', 'ctrl+y'])
    assert.deepEqual((fixture.latest() as TuiSettingsDoc).keybindings, {
      'app.todo.toggle': ['ctrl+t', 'ctrl+y'],
    })
    assert.equal(result.kind === 'applied' ? result.model.rows.find(row => row.id === 'app.todo.toggle')!.effective[0]!.key : '', 'ctrl+t')
  } finally {
    manager.dispose()
  }
})

test('adding to an untouched action retains every builtin shortcut', async () => {
  const fixture = settingsFixture(undefined)
  const { controller, manager } = controllerFor(fixture)
  try {
    const result = await controller.mutate({
      kind: 'add',
      action: 'app.transcript.search',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    assert.equal(result.kind, 'applied')
    assert.deepEqual(manager.keysFor('app.transcript.search'), ['ctrl+f', 'ctrl+shift+f', 'ctrl+y'])
    assert.deepEqual((fixture.latest() as TuiSettingsDoc).keybindings, {
      'app.transcript.search': ['ctrl+f', 'ctrl+shift+f', 'ctrl+y'],
    })
  } finally {
    manager.dispose()
  }
})

test('replacing one untouched builtin shortcut preserves its siblings', async () => {
  const fixture = settingsFixture(undefined)
  const { controller, manager } = controllerFor(fixture)
  try {
    const result = await controller.mutate({
      kind: 'replace',
      action: 'app.transcript.search',
      previous: { kind: 'direct', key: 'ctrl+f' },
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    assert.equal(result.kind, 'applied')
    assert.deepEqual(manager.keysFor('app.transcript.search'), ['ctrl+shift+f', 'ctrl+y'])
    assert.deepEqual((fixture.latest() as TuiSettingsDoc).keybindings, {
      'app.transcript.search': ['ctrl+shift+f', 'ctrl+y'],
    })
  } finally {
    manager.dispose()
  }
})

test('removing one untouched builtin shortcut preserves its siblings', async () => {
  const fixture = settingsFixture(undefined)
  const { controller, manager } = controllerFor(fixture)
  try {
    const result = await controller.mutate({
      kind: 'remove',
      action: 'app.transcript.search',
      binding: { kind: 'direct', key: 'ctrl+f' },
    })
    assert.equal(result.kind, 'applied')
    assert.deepEqual(manager.keysFor('app.transcript.search'), ['ctrl+shift+f'])
    assert.deepEqual((fixture.latest() as TuiSettingsDoc).keybindings, {
      'app.transcript.search': 'ctrl+shift+f',
    })
  } finally {
    manager.dispose()
  }
})

test('safe mode rejects action mutations before they reach persistence', async () => {
  const fixture = settingsFixture({ 'app.todo.toggle': 'ctrl+y' })
  const { controller, manager } = controllerFor(fixture)
  manager.setSafeMode(true)
  try {
    const result = await controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+z' },
    })
    assert.equal(result.kind, 'rejected')
    assert.match(result.message, /safe mode/i)
    assert.equal(fixture.replaceCount(), 0)
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t'])
  } finally {
    manager.dispose()
  }
})

test('interactive preflight rejects a new direct conflict without persistence or runtime mutation', async () => {
  const fixture = settingsFixture({ 'app.transcript.toggleExpand': 'ctrl+y' })
  const { controller, manager } = controllerFor(fixture)
  try {
    const result = await controller.mutate({
      kind: 'add',
      action: 'app.history.search',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    assert.equal(result.kind, 'rejected')
    assert.match(result.message, /conflicts/i)
    assert.equal(fixture.replaceCount(), 0)
    assert.deepEqual(manager.keysFor('app.history.search'), ['ctrl+r'])
  } finally {
    manager.dispose()
  }
})

test('a direct binding cannot newly shadow an already configured leader prefix', async () => {
  const fixture = settingsFixture({ leader: 'ctrl+q' })
  const { controller, manager } = controllerFor(fixture)
  try {
    const result = await controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+q' },
    })
    assert.equal(result.kind, 'rejected')
    assert.match(result.message, /leader key/i)
    assert.equal(fixture.replaceCount(), 0)
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t'])
  } finally {
    manager.dispose()
  }
})

test('shared settings mutations serialize and preserve both concurrent edits', async () => {
  let doc: TuiSettingsDoc = {
    theme: 'auto',
    iconStyle: 'symbols',
    footer: 'default',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'off',
    homeEndKeys: 'off',
    focusMode: 'off',
  }
  let gets = 0
  let replaces = 0
  const firstReplaceStarted = deferred<void>()
  const releaseFirstReplace = deferred<void>()
  const settings = {
    get: () => {
      gets += 1
      return doc
    },
    replace: async (next: TuiSettingsDoc) => {
      replaces += 1
      if (replaces === 1) {
        firstReplaceStarted.resolve(undefined)
        await releaseFirstReplace.promise
      }
      doc = next
    },
  }
  const manager1 = new HostKeybindingManager()
  const manager2 = new HostKeybindingManager()
  const controller1 = new KeybindingEditorController({ settings, manager: manager1 })
  const controller2 = new KeybindingEditorController({ settings, manager: manager2 })
  try {
    const first = controller1.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    await firstReplaceStarted.promise
    const second = controller2.mutate({
      kind: 'add',
      action: 'app.input.steer',
      binding: { kind: 'direct', key: 'ctrl+z' },
    })
    releaseFirstReplace.resolve(undefined)
    const results = await Promise.all([first, second])
    assert.equal(results[0]!.kind, 'applied')
    assert.equal(results[1]!.kind, 'applied')
    assert.equal(gets, 2)
    assert.equal(replaces, 2)
    assert.deepEqual(doc.keybindings, {
      'app.todo.toggle': ['ctrl+t', 'ctrl+y'],
      'app.input.steer': ['ctrl+s', 'ctrl+z'],
    })
  } finally {
    manager1.dispose()
    manager2.dispose()
  }
})

test('the shared queue also preserves an unrelated whole-document settings writer', async () => {
  let doc: TuiSettingsDoc = {
    theme: 'auto',
    iconStyle: 'symbols',
    footer: 'default',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'off',
    homeEndKeys: 'off',
    focusMode: 'off',
  }
  let replaces = 0
  const firstReplaceStarted = deferred<void>()
  const releaseFirstReplace = deferred<void>()
  const settings = {
    get: () => doc,
    replace: async (next: TuiSettingsDoc) => {
      replaces += 1
      if (replaces === 1) {
        firstReplaceStarted.resolve(undefined)
        await releaseFirstReplace.promise
      }
      doc = next
    },
  }
  const manager = new HostKeybindingManager()
  const controller = new KeybindingEditorController({ settings, manager })
  try {
    const keybindingWrite = controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    await firstReplaceStarted.promise
    // Use a distinct wrapper around the same backend to prove the shared
    // fallback queue is logical-port scoped, not wrapper-object scoped.
    const unrelatedSettings = { get: settings.get, replace: settings.replace }
    const unrelatedWrite = serializeTuiSettingsMutation(unrelatedSettings, async () => {
      const current = unrelatedSettings.get()
      await unrelatedSettings.replace({ ...current, theme: 'dark' })
    })
    releaseFirstReplace.resolve(undefined)
    const [keybindingResult] = await Promise.all([keybindingWrite, unrelatedWrite])
    assert.equal(keybindingResult.kind, 'applied')
    assert.equal(doc.theme, 'dark')
    assert.deepEqual(doc.keybindings, { 'app.todo.toggle': ['ctrl+t', 'ctrl+y'] })
    assert.equal(replaces, 2)
  } finally {
    manager.dispose()
  }
})

test('leader setup and completion use the same persisted candidate', async () => {
  const fixture = settingsFixture(undefined)
  const { controller, manager } = controllerFor(fixture)
  try {
    const leader = await controller.mutate({ kind: 'set-leader', key: 'ctrl+q' })
    assert.equal(leader.kind, 'applied')
    const completion = await controller.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'leader', key: 't' },
    })
    assert.equal(completion.kind, 'applied')
    assert.deepEqual(manager.leaderKeysFor('app.todo.toggle'), ['t'])
    assert.deepEqual((fixture.latest() as TuiSettingsDoc).keybindings, {
      leader: 'ctrl+q',
      'app.todo.toggle': ['ctrl+t', '<leader>t'],
    })
  } finally {
    manager.dispose()
  }
})

test('removing the last custom shortcut restores the builtin instead of disabling the action', async () => {
  const fixture = settingsFixture({ 'app.todo.toggle': 'ctrl+y' })
  const { controller, manager } = controllerFor(fixture)
  try {
    const result = await controller.mutate({
      kind: 'remove',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    assert.equal(result.kind, 'applied')
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t'])
    assert.deepEqual((fixture.latest() as TuiSettingsDoc).keybindings, { 'app.todo.toggle': [] })
  } finally {
    manager.dispose()
  }
})

test('reset all removes only keybinding data and restores runtime defaults', async () => {
  const fixture = settingsFixture({ leader: 'ctrl+q', 'app.todo.toggle': 'ctrl+y' })
  const { controller, manager } = controllerFor(fixture)
  try {
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+y'])
    const result = await controller.mutate({ kind: 'reset-all' })
    assert.equal(result.kind, 'applied')
    assert.equal('keybindings' in (fixture.latest() as object), false)
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t'])
    assert.equal(fixture.replaceCount(), 1)
  } finally {
    manager.dispose()
  }
})

test('a failed settings replace leaves the last-known runtime map untouched', async () => {
  const fixture = settingsFixture(undefined)
  const { controller, manager } = controllerFor(fixture)
  const failing = {
    get: fixture.settings.get,
    replace: () => { throw new Error('disk unavailable') },
  }
  const failingController = new KeybindingEditorController({ settings: failing, manager })
  try {
    const result = await failingController.mutate({
      kind: 'add',
      action: 'app.todo.toggle',
      binding: { kind: 'direct', key: 'ctrl+y' },
    })
    assert.equal(result.kind, 'error')
    assert.match(result.message, /disk unavailable/)
    assert.deepEqual(manager.keysFor('app.todo.toggle'), ['ctrl+t'])
  } finally {
    manager.dispose()
  }
})
