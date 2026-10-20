/**
 * Phase 3C / C2-MA — the Models page and the shared credential workflow.
 *
 * The page is driven directly (its public `render`/`handleInput` seam) with a
 * detached fake source; the workflow is driven over fake ConfigPort seams. The
 * real Host path is covered by the Direct integration suite.
 *
 * @module @xmoon76/dsh-pi-tui/models-workspace.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { ModelsWorkspacePage, type ModelsInitialView, type ModelsProviderRow, type ModelsWorkspaceSource } from '../src/tui/panels/models-workspace-page.ts'
import { CredentialWorkflow } from '../src/app/command/credential-workflow.ts'
import {
  resolveLoginDestination,
  resolveLogoutDestination,
  genericAuthorizationTargets,
  ACCOUNT_AUTHORIZATION_KEY,
} from '../src/app/command/credential-workflow.ts'
import type { CredentialProviderOption, AuthorizationFlowTarget } from '../src/runtime/config-port.ts'

const PROVIDERS: readonly CredentialProviderOption[] = [
  { route: 'deepseek-official', label: 'deepseek official', ref: 'DEEPSEEK_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: false },
  { route: 'acme', label: 'Acme Gateway', ref: 'ACME_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: true },
  { route: 'anthropic', label: 'Anthropic', ref: 'ANTHROPIC_API_KEY', configured: true, declared: false, namesCredential: false, group: 'configured', canProvisionProfile: true },
]

const FLOWS: readonly AuthorizationFlowTarget[] = [
  { kind: 'authorization', key: ACCOUNT_AUTHORIZATION_KEY, label: 'DeepSeek', methods: [{ id: 'browser', label: 'DeepSeek' }], inFlight: false },
  { kind: 'authorization', route: 'anthropic', key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
]

function flush(times = 8): Promise<void> {
  return (async () => {
    for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  })()
}

function viewText(page: ModelsWorkspacePage, width = 100): string {
  return page.render(width).map(stripTerminalSequences).join('\n')
}

function makeRows(): readonly ModelsProviderRow[] {
  return [
    {
      kind: 'reference',
      identity: 'route:deepseek-official',
      route: 'deepseek-official',
      label: 'deepseek official',
      ref: 'DEEPSEEK_API_KEY',
      configured: true,
      declared: false,
      namesCredential: true,
      methods: [],
      inFlight: false,
      profile: { route: 'deepseek-official', configured: true, displayName: 'deepseek official', models: [] },
    },
    {
      kind: 'reference',
      identity: 'route:acme',
      route: 'acme',
      label: 'Acme Gateway',
      ref: 'ACME_API_KEY',
      configured: true,
      declared: false,
      namesCredential: true,
      methods: [],
      inFlight: false,
      profile: { route: 'acme', configured: true, displayName: 'Acme Gateway', api: 'openai-completions', baseURL: 'https://acme.example/v1', models: ['acme-1'] },
    },
    {
      kind: 'authorization',
      identity: 'auth:llm-pi-ai/anthropic',
      route: 'anthropic',
      label: 'Anthropic',
      key: 'llm-pi-ai/anthropic',
      configured: true,
      declared: false,
      namesCredential: false,
      methods: [{ id: 'oauth', label: 'OAuth' }],
      inFlight: false,
      profile: { route: 'anthropic', configured: true, displayName: 'Anthropic', models: [] },
    },
  ]
}

interface FakeSourceOptions {
  readonly configured?: (ref: string) => boolean
  readonly records?: readonly { key: string; kind?: string }[]
  readonly accountStatus?: 'signed-out' | 'credential-stored'
}

function fakeSource(options: FakeSourceOptions = {}) {
  const calls: string[] = []
  const configured = options.configured ?? (() => true)
  const source: ModelsWorkspaceSource = {
    available: true,
    rows: () => makeRows(),
    accountSummary: async () => ({ available: true, status: options.accountStatus ?? 'signed-out' }),
    credentialState: async ref => ({ kind: 'known', configured: configured(ref) }),
    storedCredentials: async () => ({
      rows: (options.records ?? []).map(record => ({ kind: 'record' as const, key: record.key, label: record.key, ...(record.kind === undefined ? {} : { kindHint: record.kind }) })),
      recordCleanupUnavailable: false,
      referenceReadFailures: [],
    }),
    describeReference: async ref => ({ configured: configured(ref) }),
    setReference: async (ref, secret) => { calls.push(`set:${ref}:${secret}`) },
    clearReference: async ref => { calls.push(`unset:${ref}`) },
    deleteRecord: async key => { calls.push(`delete:${key}`) },
    beginAuthorization: async () => ({ kind: 'started', attemptId: 'attempt-1' }),
    authorizationEvents: () => () => {},
    respondAuthorization: async () => {},
    cancelAuthorization: async attemptId => { calls.push(`cancel:${attemptId}`) },
    provisionKeylessProfile: async () => '',
    discoverModels: async () => [{ id: 'm1' }],
    createProvider: async draft => ({ kind: 'created', text: `created ${draft.route}` }),
    configGuide: () => ({ profilePatchPath: '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml' }),
    openUrl: url => { calls.push(`open:${url}`) },
    copy: text => { calls.push(`copy:${text}`) },
    run: (_label, task) => { void task() },
  }
  return { source, calls }
}

function open(initial: ModelsInitialView = { view: 'list' }): { page: ModelsWorkspacePage; calls: string[]; accountOpened: () => boolean } {
  const { source, calls } = fakeSource()
  const page = new ModelsWorkspacePage(source, () => {}, initial, () => { calls.push('open-account') })
  page.setBodyHeight(24)
  return { page, calls, accountOpened: () => calls.includes('open-account') }
}

function send(page: ModelsWorkspacePage, ...keys: string[]): void {
  for (const key of keys) page.handleInput(key)
}

test('login destination: bare, route, ref, novel ref, new route, account and invalid', () => {
  assert.deepEqual(resolveLoginDestination('', PROVIDERS, FLOWS), { kind: 'models', view: 'list' })
  assert.deepEqual(resolveLoginDestination('acme', PROVIDERS, FLOWS), { kind: 'models', view: 'provider', route: 'acme' })
  assert.deepEqual(resolveLoginDestination('ACME_API_KEY', PROVIDERS, FLOWS), { kind: 'models', view: 'reference', ref: 'ACME_API_KEY' })
  assert.deepEqual(resolveLoginDestination('novel_key', PROVIDERS, FLOWS), { kind: 'models', view: 'reference', ref: 'NOVEL_KEY' })
  assert.deepEqual(resolveLoginDestination('new-route', PROVIDERS, FLOWS), { kind: 'models', view: 'add-provider', route: 'new-route' })
  assert.deepEqual(resolveLoginDestination('newroute', PROVIDERS, FLOWS), { kind: 'models', view: 'add-provider', route: 'newroute' })
  assert.deepEqual(resolveLoginDestination('mykey', PROVIDERS, FLOWS), { kind: 'models', view: 'add-provider', route: 'mykey' })
  assert.deepEqual(resolveLoginDestination('my_key', PROVIDERS, FLOWS), { kind: 'models', view: 'reference', ref: 'MY_KEY' })
  assert.deepEqual(resolveLoginDestination('NOVEL_KEY', PROVIDERS, FLOWS), { kind: 'models', view: 'reference', ref: 'NOVEL_KEY' })
  const flowOnly: readonly AuthorizationFlowTarget[] = [
    { kind: 'authorization', route: 'mykey', key: 'plugin/mykey', label: 'My Key', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  ]
  assert.deepEqual(resolveLoginDestination('mykey', [], flowOnly), { kind: 'models', view: 'provider', route: 'mykey' })
  // A collision with an exact (case-insensitive) reference still resolves the
  // KNOWN lowercase route first; the uppercase form stays the ref escape hatch.
  const collisionOptions: readonly CredentialProviderOption[] = [
    { route: 'other-provider', label: 'Other', ref: 'MYKEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: true },
  ]
  assert.deepEqual(resolveLoginDestination('mykey', collisionOptions, flowOnly), { kind: 'models', view: 'provider', route: 'mykey' })
  assert.deepEqual(resolveLoginDestination('MYKEY', collisionOptions, flowOnly), { kind: 'models', view: 'reference', ref: 'MYKEY' })
  // A generic flow that shares the builtin route never overrides the builtin's
  // dedicated reference page (mergeLoginTargets also suppresses that flow).
  const builtinFlow: readonly AuthorizationFlowTarget[] = [
    { kind: 'authorization', route: 'deepseek-official', key: 'llm-pi-ai/deepseek-official', label: 'Official OAuth', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  ]
  assert.deepEqual(
    resolveLoginDestination('deepseek-official', PROVIDERS, builtinFlow),
    { kind: 'models', view: 'reference', ref: 'DEEPSEEK_API_KEY', label: 'deepseek official' },
  )
  assert.deepEqual(resolveLoginDestination('deepseek-account', PROVIDERS, FLOWS), { kind: 'account', view: 'page' })
  const invalid = resolveLoginDestination('not valid!', PROVIDERS, FLOWS)
  assert.equal(invalid.kind, 'error')
})

test('logout destination: known ref, keyless flow record and account', () => {
  assert.deepEqual(resolveLogoutDestination('ACME_API_KEY', PROVIDERS, FLOWS), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway', route: 'acme' },
  })
  assert.deepEqual(resolveLogoutDestination('anthropic', PROVIDERS, FLOWS), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  })
  assert.deepEqual(resolveLogoutDestination('deepseek-account', PROVIDERS, FLOWS), { kind: 'account', view: 'signout' })
  assert.deepEqual(resolveLogoutDestination('', PROVIDERS, FLOWS), { kind: 'models', view: 'logout-list' })
  const flowOnly: readonly AuthorizationFlowTarget[] = [
    { kind: 'authorization', route: 'mykey', key: 'plugin/mykey', label: 'My Key', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  ]
  assert.deepEqual(resolveLogoutDestination('mykey', [], flowOnly), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'record', key: 'plugin/mykey', label: 'My Key', route: 'mykey' },
  })
  assert.deepEqual(resolveLogoutDestination('MYKEY', [], flowOnly), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'reference', ref: 'MYKEY', label: 'MYKEY' },
  })
  const collisionOptions: readonly CredentialProviderOption[] = [
    { route: 'other-provider', label: 'Other', ref: 'MYKEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: true },
  ]
  assert.deepEqual(resolveLogoutDestination('mykey', collisionOptions, flowOnly), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'record', key: 'plugin/mykey', label: 'My Key', route: 'mykey' },
  })
  assert.deepEqual(resolveLogoutDestination('MYKEY', collisionOptions, flowOnly), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'reference', ref: 'MYKEY', label: 'Other', route: 'other-provider' },
  })
  const builtinFlow: readonly AuthorizationFlowTarget[] = [
    { kind: 'authorization', route: 'deepseek-official', key: 'llm-pi-ai/deepseek-official', label: 'Official OAuth', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  ]
  assert.deepEqual(resolveLogoutDestination('deepseek-official', PROVIDERS, builtinFlow), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'reference', ref: 'DEEPSEEK_API_KEY', label: 'deepseek official', route: 'deepseek-official' },
  })
})

test('the DeepSeek Account authorization flow is excluded from generic targets (MA14)', () => {
  assert.equal(genericAuthorizationTargets(FLOWS).some(target => target.key === ACCOUNT_AUTHORIZATION_KEY), false)
  assert.equal(genericAuthorizationTargets(FLOWS).length, 1)
})

test('Models list paints the account, provider states and actions', async () => {
  const { page } = open()
  await flush()
  const text = viewText(page)
  assert.match(text, /Models & Credentials/u)
  assert.match(text, /DeepSeek Account/u)
  assert.match(text, /Acme Gateway/u)
  assert.match(text, /Add Provider/u)
  assert.match(text, /Credential records/u)
})

test('provider detail shows Host facts and opens the masked key editor; a write is Verified only after re-read', async () => {
  const { page, calls } = open()
  await flush()
  viewText(page)
  send(page, '\u001b[B') // account -> deepseek official
  send(page, '\u001b[B') // -> acme
  send(page, '\r')
  const detail = viewText(page)
  assert.match(detail, /Provider · Acme Gateway/u)
  assert.match(detail, /openai-completions/u)
  assert.match(detail, /https:\/\/acme\.example\/v1/u)
  // Configure API Key is the first action for a reference row.
  send(page, '\r')
  assert.match(viewText(page), /API Key Reference · Acme Gateway/u)
  send(page, '\r')
  assert.match(viewText(page), /Enter the API key/u)
  // Type the secret; Enter commits to the review page, Enter submits.
  for (const character of 'sk-test') send(page, character)
  send(page, '\r', '\r')
  await flush()
  assert.ok(calls.includes('set:ACME_API_KEY:sk-test'), calls.join(','))
  assert.match(viewText(page), /Verified/u)
})

test('clear requires the painted confirmation action and re-reads the store', async () => {
  const configured = new Set(['ACME_API_KEY'])
  const { source, calls } = fakeSource({ configured: ref => configured.has(ref) })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'acme' }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  // Provider actions: Configure API Key, Clear stored credential, Guide, Back.
  send(page, '\u001b[B')
  send(page, '\r')
  await flush()
  assert.match(viewText(page), /Clear stored credential/u)
  assert.match(viewText(page), /This removes the locally stored credential/u)
  send(page, '\r')
  configured.delete('ACME_API_KEY')
  await flush()
  assert.ok(calls.includes('unset:ACME_API_KEY'), calls.join(','))
  assert.match(viewText(page), /API key ACME_API_KEY cleared/u)
})

test('the Models account row opens the Account page instead of a provider flow', async () => {
  const { page, accountOpened } = open()
  await flush()
  viewText(page)
  send(page, '\r')
  assert.equal(accountOpened(), true)
})

test('the config guide shows the confirmed profile patch path and never guesses one', async () => {
  const { page } = open({ view: 'guide' })
  assert.match(viewText(page), /\/home\/u\/\.dsh\/profiles\/pi-tui\/cordis\.patch\.yml/u)
  const { source } = fakeSource()
  const noPath: ModelsWorkspaceSource = { ...source, configGuide: () => ({}) }
  const other = new ModelsWorkspacePage(noPath, () => {}, { view: 'guide' }, () => {})
  other.setBodyHeight(20)
  assert.match(viewText(other), /unavailable/u)
})

test('CredentialWorkflow.createProvider reports a profile write and a separate key failure', async () => {
  const mutations: { ns: string; ops: unknown[] }[] = []
  let settings: Record<string, unknown> | undefined = {}
  const workflow = new CredentialWorkflow({
    providers: {
      available: () => true,
      listCredentialOptions: () => [],
      readProfile: route => ({ route, configured: false, models: [] }),
      configGuide: () => ({}),
      writeProfile: async (route, profile) => {
        mutations.push({ ns: route, ops: [profile] })
        settings = { providers: { [route]: profile } }
      },
      writeKeylessProfile: async () => ({ kind: 'written' }),
    },
    credentials: {
      available: () => true,
      setReference: async () => { throw new Error('shadowed read-only') },
      unsetReference: async () => {},
      recordsSupported: () => true,
      deleteRecord: async () => {},
      describeReference: async () => ({ configured: false }),
      listRecords: async () => [],
      onChanged: () => () => {},
    },
    authorization: { available: () => false, listTargets: () => [], begin: async () => ({ kind: 'unavailable' }), onEvent: () => () => {}, respond: async () => {}, cancel: async () => {} },
    account: { available: () => false, getState: async () => { throw new Error('x') }, getProfile: async () => null, getBalance: async () => null, watch: async function* () {}, getCallbackOrigin: () => undefined, startSignIn: async () => { throw new Error('x') }, cancelSignIn: async () => { throw new Error('x') }, signOut: async () => { throw new Error('x') }, hasRunningAccountTasks: () => false },
    catalog: { models: { available: () => true, discoverModels: async () => [] } },
    signal: new AbortController().signal,
    diag: { error: () => {}, warn: () => {} },
  })
  const outcome = await workflow.createProvider({
    route: 'acme',
    api: 'openai-completions',
    baseURL: 'https://acme.example/v1',
    displayName: '',
    models: ['m1'],
    apiKey: 'sk',
  })
  assert.equal(outcome.kind, 'profile-written-key-failed')
  assert.equal(mutations.length, 1)
  assert.equal(settings === undefined, false)
})

test('provider-native sign-in presents the Host notice and a masked prompt, then settles authorized', async () => {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async key => {
    calls.push(`begin:${key}`)
    emit({ kind: 'notice', attemptId: 'auth-1', notice: { message: 'Preparing sign-in' } })
    emit({ kind: 'notice', attemptId: 'auth-1', notice: { message: 'Authorize in the browser', url: 'https://provider.example/authorize' } })
    emit({
      kind: 'prompt',
      attemptId: 'auth-1',
      promptId: 'prompt-1',
      prompt: { kind: 'secret', message: 'One-time code' },
    })
    return { kind: 'started', attemptId: 'auth-1' }
  }
  source.respondAuthorization = async (attemptId, promptId, answer) => {
    calls.push(`respond:${attemptId}:${promptId}:${answer}`)
    emit({ kind: 'settled', attemptId, status: 'authorized' })
  }
  source.provisionKeylessProfile = async route => route === 'anthropic' ? ' — provider profile recorded' : ''
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(26)
  await flush()
  viewText(page)
  page.handleInput('\r') // Sign in (provider)
  await flush()
  const auth = viewText(page)
  assert.match(auth, /Authorize in the browser/u)
  assert.match(auth, /https:\/\/provider\.example\/authorize/u)
  assert.match(auth, /One-time code/u)
  for (const character of 'otp-123') page.handleInput(character)
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  assert.ok(calls.includes('begin:llm-pi-ai/anthropic'), calls.join(','))
  assert.ok(calls.includes('respond:auth-1:prompt-1:otp-123'), calls.join(','))
  assert.match(viewText(page), /signed in to Anthropic — provider profile recorded/u)
})

test('cancelling the Models page during a native attempt calls the Host cancel for that attempt', async () => {
  const { source, calls } = fakeSource()
  source.beginAuthorization = async () => ({ kind: 'started', attemptId: 'auth-9' })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  page.dispose()
  await flush()
  assert.ok(calls.includes('cancel:auth-9'), calls.join(','))
})

test('the stored-credential list excludes the DeepSeek Account grant (MA14)', async () => {
  const workflow = new CredentialWorkflow({
    providers: {
      available: () => true,
      listCredentialOptions: () => [],
      readProfile: (route: string) => ({ route, configured: false, models: [] }),
      configGuide: () => ({}),
      writeProfile: async () => {},
      writeKeylessProfile: async () => ({ kind: 'written' }),
    },
    credentials: {
      available: () => true,
      setReference: async () => {},
      unsetReference: async () => {},
      recordsSupported: () => true,
      deleteRecord: async () => {},
      describeReference: async () => ({ configured: false }),
      listRecords: async () => [
        { key: 'deepseek-account-platform/default', kind: 'grant' },
        { key: 'llm-pi-ai/anthropic', kind: 'oauth' },
      ],
      onChanged: () => () => {},
    },
    authorization: { available: () => true, listTargets: () => FLOWS, begin: async () => ({ kind: 'unavailable' }), onEvent: () => () => {}, respond: async () => {}, cancel: async () => {} },
    account: { available: () => true, getState: async () => ({ status: 'credential-stored', links: { usageUrl: '', topUpUrl: '' }, attempt: null }), getProfile: async () => null, getBalance: async () => null, watch: async function* () {}, getCallbackOrigin: () => undefined, startSignIn: async () => { throw new Error('x') }, cancelSignIn: async () => { throw new Error('x') }, signOut: async () => { throw new Error('x') }, hasRunningAccountTasks: () => false },
    catalog: { models: { available: () => false, discoverModels: async () => [] } },
    signal: new AbortController().signal,
    diag: { error: () => {}, warn: () => {} },
  })
  const stored = await workflow.storedCredentials()
  assert.equal(stored.rows.some(row => row.key === 'deepseek-account-platform/default'), false)
  assert.equal(stored.rows.some(row => row.key === 'llm-pi-ai/anthropic'), true)
})

test('Models page fits 105/80/60/40/30 columns without painting past the edge', async () => {
  const { source } = fakeSource()

  for (const [width, height] of [[105, 40], [80, 24], [60, 22], [40, 16], [30, 8]] as const) {
    for (const initial of [
      { view: 'list' },
      { view: 'provider', route: 'acme' },
      { view: 'add-provider' },
    ] as const) {
      const page = new ModelsWorkspacePage(source, () => {}, initial, () => {})
      page.setBodyHeight(height)
      const lines = page.render(width)
      assert.equal(lines.length, height)
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${width}x${height} ${initial.view} paints ${visibleWidth(line)} cells: ${JSON.stringify(stripTerminalSequences(line))}`)
      }
    }
  }

  // Below the action budget the page refuses every invisible submit and asks
  // for a resize instead of leaving a hidden confirm target.
  const tiny = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'acme' }, () => {})
  tiny.setBodyHeight(3)
  const tinyFrame = tiny.render(30).map(stripTerminalSequences).join('\n')
  assert.match(tinyFrame, /Resize the terminal/u)
})

test('Models mouse press/release follows the painted hit map and a resize revokes it', async () => {
  const { source, calls } = fakeSource()
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'acme' }, () => {})
  page.setBodyHeight(24)
  await flush()
  const line = (needle: string): { row: number; col: number } => {
    const lines = page.render(100).map(stripTerminalSequences)
    const row = lines.findIndex(candidate => candidate.includes(needle))
    assert.ok(row >= 0, `missing ${needle}:\n${lines.join('\n')}`)
    return { row, col: lines[row]!.indexOf(needle) }
  }
  const configure = line('Configure API Key')
  page.onCellPress(configure.col, configure.row)
  page.onCellClick(configure.col, configure.row)
  assert.match(page.render(100).map(stripTerminalSequences).join('\n'), /API Key Reference/u)

  // Press, repaint at a different height, then release the old cell: refused.
  const edit = line('Configure API Key')
  page.onCellPress(edit.col, edit.row)
  page.setBodyHeight(20)
  page.render(100)
  page.onCellClick(edit.col, edit.row)
  assert.match(page.render(100).map(stripTerminalSequences).join('\n'), /API Key Reference/u, 'the resize-revoked click must not open the editor')

  // The dangerous clear action is a painted control too.
  const configured = new Set(['ACME_API_KEY'])
  const second = fakeSource({ configured: ref => configured.has(ref) })
  const clearPage = new ModelsWorkspacePage(second.source, () => {}, { view: 'provider', route: 'acme' }, () => {})
  clearPage.setBodyHeight(24)
  await flush()
  clearPage.render(100)
  clearPage.handleInput('\u001b[B')
  clearPage.handleInput('\r')
  await flush()
  const clearLines = clearPage.render(100).map(stripTerminalSequences)
  const confirmRow = clearLines.findIndex(candidate => candidate.includes('Clear credential'))
  assert.ok(confirmRow >= 0)
  clearPage.onCellPress(2, confirmRow)
  configured.delete('ACME_API_KEY')
  clearPage.onCellClick(2, confirmRow)
  await flush()
  assert.ok(second.calls.includes('unset:ACME_API_KEY'), second.calls.join(','))
})

test('a stored credential RECORD is deleted through deleteRecord and never through unsetReference', async () => {
  const { source, calls } = fakeSource()
  let records: readonly { key: string; kind?: string }[] = [{ key: 'llm-pi-ai/anthropic', kind: 'oauth' }]
  source.storedCredentials = async () => ({
    rows: records.map(record => ({ kind: 'record' as const, key: record.key, label: 'Anthropic', route: 'anthropic', ...(record.kind === undefined ? {} : { kindHint: record.kind }) })),
    recordCleanupUnavailable: false,
    referenceReadFailures: [],
  })
  source.deleteRecord = async key => {
    calls.push(`delete:${key}`)
    records = records.filter(record => record.key !== key)
  }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(24)
  await flush()
  const painted = viewText(page)
  assert.match(painted, /Clear stored credential/u)
  assert.match(painted, /Clear credential/u)
  page.handleInput('\r')
  await flush()
  assert.ok(calls.includes('delete:llm-pi-ai/anthropic'), calls.join(','))
  assert.equal(calls.some(call => call.startsWith('unset:')), false)
  assert.match(viewText(page), /signed out locally — stored credential cleared/u)
})

test('Esc on a running native attempt cancels the exact attempt and returns to the list only after settlement', async () => {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async () => {
    calls.push('begin')
    return { kind: 'started', attemptId: 'auth-esc' }
  }
  source.cancelAuthorization = async id => { calls.push(`cancel:${id}`) }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(26)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /starting|running|Sign-in/u)
  page.handleInput('\u001b')
  await flush()
  assert.ok(calls.includes('cancel:auth-esc'), calls.join(','))
  assert.match(viewText(page), /Provider · Anthropic/u, 'the page waits on the Host settlement instead of leaving a prompt owner behind')
  assert.match(viewText(page), /cancellation requested/u)
  assert.match(viewText(page), /Cancellation requested/u)
  emit({ kind: 'settled', attemptId: 'auth-esc', status: 'cancelled' })
  await flush()
  assert.match(viewText(page), /Models & Credentials/u)
})

test('a painted but DISABLED action cannot be clicked into effect', async () => {
  const { source, calls } = fakeSource({ configured: () => false })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'acme' }, () => {})
  page.setBodyHeight(24)
  await flush()
  const lines = page.render(100).map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes('Nothing stored to clear'))
  assert.ok(row >= 0)
  page.onCellPress(2, row)
  page.onCellClick(2, row)
  await flush()
  assert.equal(calls.some(call => call.startsWith('unset:')), false)
  assert.match(page.render(100).map(stripTerminalSequences).join('\n'), /Provider · Acme Gateway/u, 'the disabled action stays inert')
})

test('canonical route identities win over display labels, including the builtin and named-ref routes (RFL-001)', () => {
  const options: readonly CredentialProviderOption[] = [
    { route: 'deepseek-official', label: 'deepseek official', ref: 'DEEPSEEK_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: false },
    { route: 'acme-canonical', label: 'Acme Gateway', ref: 'ACME_GATEWAY_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: true },
  ]
  const flows: readonly AuthorizationFlowTarget[] = [
    { kind: 'authorization', route: 'acme-canonical', key: 'llm-pi-ai/acme-canonical', label: 'Acme OAuth', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  ]
  assert.deepEqual(resolveLoginDestination('deepseek-official', options, flows), { kind: 'models', view: 'reference', ref: 'DEEPSEEK_API_KEY', label: 'deepseek official' })
  assert.deepEqual(resolveLoginDestination('acme-canonical', options, flows), { kind: 'models', view: 'provider', route: 'acme-canonical' })
  assert.deepEqual(resolveLoginDestination('acme', options, flows), { kind: 'models', view: 'provider', route: 'acme-canonical' }, 'the label alias still works')
  // A profile that explicitly names apiKeyEnv keeps the reference plane even
  // when a flow exists for the same canonical route.
  assert.deepEqual(resolveLogoutDestination('acme-canonical', options, flows), {
    kind: 'models',
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_GATEWAY_API_KEY', label: 'Acme Gateway', route: 'acme-canonical' },
  })
})

test('a withdrawn older prompt never closes the newer prompt UI (RFL-003)', async () => {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async () => {
    emit({ kind: 'prompt', attemptId: 'auth-2', promptId: 'p1', prompt: { kind: 'text', message: 'FIRST PROMPT' } })
    emit({ kind: 'prompt', attemptId: 'auth-2', promptId: 'p2', prompt: { kind: 'text', message: 'SECOND PROMPT' } })
    return { kind: 'started', attemptId: 'auth-2' }
  }
  source.respondAuthorization = async (attemptId, promptId, answer) => {
    calls.push(`respond:${attemptId}:${promptId}:${answer}`)
    emit({ kind: 'settled', attemptId, status: 'authorized' })
  }
  source.provisionKeylessProfile = async () => ''
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(26)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /FIRST PROMPT/u)
  emit({ kind: 'prompt-withdrawn', attemptId: 'auth-2', promptId: 'p1' })
  await flush()
  assert.match(viewText(page), /SECOND PROMPT/u)
  assert.doesNotMatch(viewText(page), /FIRST PROMPT/u)
  for (const character of 'second-answer') page.handleInput(character)
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  assert.ok(calls.includes('respond:auth-2:p2:second-answer'), calls.join(','))
  assert.equal(calls.some(call => call.startsWith('respond:auth-2:p1:')), false)
})

test('an older Models credential read cannot overwrite a newer refresh (RFL-002)', async () => {
  const { source } = fakeSource()
  let heldResolve: ((state: import('../src/tui/panels/models-workspace-page.ts').ModelsCredentialState) => void) | undefined
  let releaseFirst = true
  source.credentialState = async () => {
    if (releaseFirst) {
      releaseFirst = false
      return await new Promise(resolve => { heldResolve = resolve })
    }
    return { kind: 'known', configured: true }
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
  page.setBodyHeight(24)
  await flush()
  page.handleInput('r')
  await flush()
  assert.match(viewText(page), /Configured/u)
  heldResolve?.({ kind: 'known', configured: false })
  await flush()
  const acmeRow = page.render(100).map(stripTerminalSequences).find(line => line.includes('Acme Gateway'))
  assert.ok(acmeRow !== undefined)
  assert.match(acmeRow, /Configured/u, 'the stale read must not flip the row to Not set')
  assert.doesNotMatch(acmeRow, /Not set/u)
})

test('an empty masked key answer writes nothing (MA03)', async () => {
  const { page, calls } = open({ view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' })
  await flush()
  viewText(page)
  page.handleInput('\r') // open the masked editor
  await flush()
  viewText(page)
  page.handleInput('\r') // submit the empty draft to review
  page.handleInput('\r') // submit the review
  await flush()
  assert.equal(calls.some(call => call.startsWith('set:')), false)
  assert.match(viewText(page), /empty key; nothing set/u)
})

test('the Add Provider page drives discovery → multi-select → review → create (MA04)', async () => {
  const { source, calls } = fakeSource()
  const createdRows: ModelsProviderRow[] = []
  source.rows = () => createdRows
  source.discoverModels = async () => [{ id: 'm1' }, { id: 'm2' }]
  source.createProvider = async draft => {
    calls.push(`create:${draft.route}:${draft.api}:${draft.baseURL}:${draft.models.join(',')}:${draft.apiKey}`)
    createdRows.push({
      kind: 'reference',
      identity: `route:${draft.route}`,
      route: draft.route,
      label: draft.route,
      ref: 'NEW_ROUTE_API_KEY',
      configured: true,
      declared: true,
      namesCredential: true,
      methods: [],
      inFlight: false,
      profile: { route: draft.route, configured: true, models: [...draft.models] },
    })
    return { kind: 'created', text: `provider ${draft.route} added` }
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'add-provider', route: 'new-route' }, () => {})
  page.setBodyHeight(30)
  await flush()
  viewText(page)
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B') // base URL field
  page.handleInput('\r')
  await flush()
  viewText(page)
  for (const character of 'https://new.example/v1') page.handleInput(character)
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /https:\/\/new\.example\/v1/u)

  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B') // models field
  page.handleInput('\r')
  await flush()
  for (let index = 0; index < 50; index += 1) {
    if (/Models advertised by the endpoint/u.test(viewText(page))) break
    await new Promise<void>(resolve => setImmediate(resolve))
    page.render(100)
  }
  assert.match(viewText(page), /Models advertised by the endpoint/u)
  page.handleInput(' ')
  page.handleInput('\u001b[B')
  page.handleInput(' ')
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /m1, m2/u)

  page.handleInput('\u001b[B') // Review & create
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /Review provider/u)
  page.handleInput('\r')
  await flush()
  assert.ok(calls.some(call => call === 'create:new-route:openai-completions:https://new.example/v1:m1,m2:'), calls.join(','))
  assert.match(viewText(page), /provider new-route added/u)
  viewText(page)
  page.handleInput('\r') // ← Back to providers
  await flush()
  const newRow = page.render(100).map(stripTerminalSequences).find(line => line.includes('new-route'))
  assert.ok(newRow !== undefined)
  assert.match(newRow, /Configured/u, 'the created provider key is reflected without a manual refresh')
})

test('a withdrawn older SELECT prompt can never overwrite the newer select prompt (RFL-003)', async () => {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async () => {
    emit({ kind: 'prompt', attemptId: 'auth-3', promptId: 's1', prompt: { kind: 'select', message: 'FIRST SELECT', options: [{ id: 'a', label: 'A' }, { id: 'a2', label: 'A2' }] } })
    emit({ kind: 'prompt', attemptId: 'auth-3', promptId: 's2', prompt: { kind: 'select', message: 'SECOND SELECT', options: [{ id: 'b', label: 'B' }] } })
    return { kind: 'started', attemptId: 'auth-3' }
  }
  source.respondAuthorization = async (attemptId, promptId, answer) => {
    calls.push(`respond:${attemptId}:${promptId}:${answer}`)
    emit({ kind: 'settled', attemptId, status: 'authorized' })
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(26)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /FIRST SELECT/u)
  page.handleInput('\u001b[B') // navigate the first picker before it is withdrawn
  emit({ kind: 'prompt-withdrawn', attemptId: 'auth-3', promptId: 's1' })
  await flush()
  assert.match(viewText(page), /SECOND SELECT/u)
  assert.doesNotMatch(viewText(page), /FIRST SELECT/u)
  page.handleInput('\r')
  await flush()
  assert.ok(calls.includes('respond:auth-3:s2:b'), calls.join(','))
  assert.equal(calls.some(call => call.startsWith('respond:auth-3:s1:')), false)
})

test('a pending clear cannot be left behind by Esc, and its rejected re-read stays on the same target (RFL-002)', async () => {
  const { source, calls } = fakeSource()
  let callsToDescribe = 0
  let rejectReRead: ((error: Error) => void) | undefined
  source.describeReference = async () => {
    callsToDescribe += 1
    if (callsToDescribe <= 2) return { configured: true }
    return await new Promise((_resolve, reject) => { rejectReRead = reject })
  }
  source.clearReference = async ref => { calls.push(`unset:${ref}`) }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' },
  }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  page.handleInput('\r') // confirm the clear
  await flush()
  assert.ok(calls.includes('unset:ACME_API_KEY'), calls.join(','))
  page.handleInput('\u001b')
  await flush()
  assert.match(viewText(page), /Clear stored credential/u, 'the pending clear keeps the page')
  assert.match(viewText(page), /in flight/u)
  rejectReRead?.(new Error('store read failed'))
  await flush()
  assert.match(viewText(page), /Not cleared: the clear returned; the store could not be re-read/u)
})

test('the painted ← Providers action uses the SAME cancel-and-settle path as Esc (P1)', async () => {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async () => ({ kind: 'started', attemptId: 'auth-back' })
  source.cancelAuthorization = async id => { calls.push(`cancel:${id}`) }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(26)
  await flush()
  viewText(page)
  page.handleInput('\r') // Sign in
  await flush()
  const lines = page.render(100).map(stripTerminalSequences)
  const backRow = lines.findIndex(line => line.includes('← Providers'))
  assert.ok(backRow >= 0, lines.join('\n'))
  page.onCellPress(2, backRow)
  page.onCellClick(2, backRow)
  await flush()
  assert.ok(calls.includes('cancel:auth-back'), calls.join(','))
  assert.match(viewText(page), /Provider · Anthropic/u, 'the page waits for the Host settlement, exactly like Esc')
  emit({ kind: 'settled', attemptId: 'auth-back', status: 'cancelled' })
  await flush()
  assert.match(viewText(page), /Models & Credentials/u)
})

test('the Models HOME reads credential-record presence for native authorization rows (P2)', async () => {
  const { source } = fakeSource({ records: [{ key: 'llm-pi-ai/anthropic', kind: 'grant' }] })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
  page.setBodyHeight(24)
  await flush()
  const anthropicRow = page.render(100).map(stripTerminalSequences).find(line => line.includes('Anthropic'))
  assert.ok(anthropicRow !== undefined)
  assert.match(anthropicRow, /Configured/u, 'the home list must not show Unknown after an authoritative records read')
  assert.doesNotMatch(anthropicRow, /Unknown/u)
})

test('two route-less authorization flows keep distinct identities and each opens its own detail (P2)', async () => {
  const { source, calls } = fakeSource()
  const rows: ModelsProviderRow[] = [
    {
      kind: 'authorization', identity: 'auth:plugin-a/default', route: '', label: 'Plugin A', key: 'plugin-a/default',
      configured: false, declared: false, namesCredential: false, methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false,
      profile: { route: '', configured: false, models: [] },
    },
    {
      kind: 'authorization', identity: 'auth:plugin-b/default', route: '', label: 'Plugin B', key: 'plugin-b/default',
      configured: false, declared: false, namesCredential: false, methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false,
      profile: { route: '', configured: false, models: [] },
    },
  ]
  source.rows = () => rows
  source.beginAuthorization = async key => { calls.push(`begin:${key}`); return { kind: 'started', attemptId: key } }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  page.handleInput('\u001b[B') // first flow
  page.handleInput('\r')
  assert.match(viewText(page), /Provider · Plugin A/u)
  page.handleInput('\u001b')
  await flush()
  viewText(page)
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B') // second flow
  page.handleInput('\r')
  assert.match(viewText(page), /Provider · Plugin B/u)
  page.handleInput('\r') // sign in
  await flush()
  assert.ok(calls.includes('begin:plugin-b/default'), calls.join(','))
})

function runningAuthSource() {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async () => ({ kind: 'started', attemptId: 'auth-nav' })
  source.cancelAuthorization = async id => { calls.push(`cancel:${id}`) }
  return { source, calls, emit }
}

test('Guide navigation during a native attempt cancels, waits for settlement and then opens the guide (P1)', async () => {
  const { source, calls, emit } = runningAuthSource()
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(26)
  await flush()
  viewText(page)
  page.handleInput('\r') // sign in
  await flush()
  const lines = page.render(100).map(stripTerminalSequences)
  const guideRow = lines.findIndex(line => line.includes('View model config guide'))
  assert.ok(guideRow >= 0)
  page.onCellPress(2, guideRow)
  page.onCellClick(2, guideRow)
  await flush()
  assert.ok(calls.includes('cancel:auth-nav'), calls.join(','))
  assert.match(viewText(page), /Provider · Anthropic/u, 'Guide waits for the Host settlement')
  emit({ kind: 'settled', attemptId: 'auth-nav', status: 'cancelled' })
  await flush()
  assert.match(viewText(page), /Model configuration guide/u)
})

test('Clear navigation during a native attempt uses the same cancel-and-settle policy (P1)', async () => {
  const { source, calls, emit } = runningAuthSource()
  source.storedCredentials = async () => ({
    rows: [{ kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }],
    recordCleanupUnavailable: false,
    referenceReadFailures: [],
  })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(26)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  const lines = page.render(100).map(stripTerminalSequences)
  const clearRow = lines.findIndex(line => line.includes('Clear stored credential'))
  assert.ok(clearRow >= 0)
  page.onCellPress(2, clearRow)
  page.onCellClick(2, clearRow)
  await flush()
  assert.ok(calls.includes('cancel:auth-nav'), calls.join(','))
  assert.match(viewText(page), /Provider · Anthropic/u)
  emit({ kind: 'settled', attemptId: 'auth-nav', status: 'cancelled' })
  await flush()
  assert.match(viewText(page), /Clear stored credential/u)
})

test('a verified API-key write refreshes the list projection (P2)', async () => {
  let configured = false
  const { source } = fakeSource()
  source.credentialState = async () => ({ kind: 'known', configured })
  source.describeReference = async () => ({ configured })
  source.setReference = async () => { configured = true }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  viewText(page)
  for (const character of 'sk-cache') page.handleInput(character)
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /Verified/u)
  page.handleInput('\u001b')
  await flush()
  const acmeRow = page.render(100).map(stripTerminalSequences).find(line => line.includes('Acme Gateway'))
  assert.ok(acmeRow !== undefined)
  assert.match(acmeRow, /Configured/u)
})

test('a verified clear refreshes the list projection (P2)', async () => {
  let configured = true
  const { source } = fakeSource()
  source.credentialState = async () => ({ kind: 'known', configured })
  source.describeReference = async () => ({ configured })
  source.clearReference = async () => { configured = false }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' },
  }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /API key ACME_API_KEY cleared/u)
  // A later refresh read failure cannot regress the confirmed done state.
  source.describeReference = async () => { throw new Error('late clear read failure') }
  page.handleInput('r')
  await flush()
  assert.match(viewText(page), /API key ACME_API_KEY cleared/u)
  assert.doesNotMatch(viewText(page), /Not cleared/u)
  page.handleInput('\u001b')
  await flush()
  const acmeRow = page.render(100).map(stripTerminalSequences).find(line => line.includes('Acme Gateway'))
  assert.ok(acmeRow !== undefined)
  assert.match(acmeRow, /Not set/u)
})

test('a pending API-key write cannot be left by Esc and still verifies on settlement (P2)', async () => {
  let resolveWrite: (() => void) | undefined
  const { source } = fakeSource()
  source.setReference = () => new Promise<void>(resolve => { resolveWrite = resolve })
  source.describeReference = async () => ({ configured: true })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  viewText(page)
  for (const character of 'sk-wait') page.handleInput(character)
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  page.handleInput('\u001b')
  await flush()
  assert.match(viewText(page), /API Key Reference/u)
  assert.match(viewText(page), /in flight/u)
  resolveWrite?.()
  await flush()
  assert.match(viewText(page), /Verified/u)
})

test('the list cursor follows into view so an off-screen provider is Enter-reachable (P2)', async () => {
  const { source } = fakeSource()
  const rows: ModelsProviderRow[] = Array.from({ length: 30 }, (_, index) => ({
    kind: 'reference',
    identity: `route:p${index}`,
    route: `p${index}`,
    label: `P${index}`,
    ref: `P${index}_API_KEY`,
    configured: true,
    declared: true,
    namesCredential: true,
    methods: [],
    inFlight: false,
    profile: { route: `p${index}`, configured: true, models: [] },
  }))
  source.rows = () => rows
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
  page.setBodyHeight(10)
  await flush()
  page.render(100)
  for (let index = 0; index < 20; index += 1) {
    page.handleInput('\u001b[B')
    page.render(100)
  }
  page.handleInput('\r')
  assert.match(viewText(page), /Provider · P19/u)
})

test('the login-method picker reserves heading and action-bar rows on a short screen (P2)', async () => {
  const { source } = fakeSource()
  const methods = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, label: `Method ${index}` }))
  const rows: ModelsProviderRow[] = [{
    kind: 'authorization', identity: 'auth:plugin/many', route: 'many', label: 'Many Methods',
    key: 'plugin/many', configured: false, declared: false, namesCredential: false, methods, inFlight: false,
    profile: { route: 'many', configured: false, models: [] },
  }]
  source.rows = () => rows
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'many' }, () => {})
  page.setBodyHeight(8)
  await flush()
  page.render(100)
  page.handleInput('\r') // open the method picker
  const lines = page.render(100).map(stripTerminalSequences)
  assert.equal(lines.length, 8)
  assert.match(lines.at(-1) ?? '', /Esc cancel/u)
  assert.ok(lines.some(line => line.includes('Method 0')), lines.join('\n'))
})

test('closing the Models page while a native attempt runs cancels it and the owned task settles (MA13 no-hang)', async () => {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async () => ({ kind: 'started', attemptId: 'auth-close' })
  source.cancelAuthorization = async id => {
    calls.push(`cancel:${id}`)
    emit({ kind: 'settled', attemptId: id, status: 'cancelled' })
  }
  let signInTask: Promise<void> | undefined
  source.run = (label, task) => {
    const running = task()
    if (label === 'models provider sign-in') signInTask = running
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(24)
  await flush()
  viewText(page)
  page.handleInput('\r')
  await flush()
  page.dispose()
  await flush()
  assert.ok(calls.includes('cancel:auth-close'), calls.join(','))
  assert.ok(signInTask !== undefined)
  await signInTask
  // If the owned sign-in task is still pending this test times out; the
  // assertion above plus the await is the no-hang evidence.
  assert.ok(true)
})

test('a failed credential-record refresh invalidates the old presence instead of keeping it (P2)', async () => {
  let mode: 'ok' | 'fail' | 'empty' = 'ok'
  const { source } = fakeSource({
    records: [{ key: 'llm-pi-ai/anthropic', kind: 'grant' }],
  })
  source.storedCredentials = async () => {
    if (mode === 'fail') throw new Error('records read failed')
    return {
      rows: mode === 'ok' ? [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }] : [],
      recordCleanupUnavailable: false,
      referenceReadFailures: [],
    }
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
  page.setBodyHeight(24)
  await flush()
  const row = (): string => page.render(100).map(stripTerminalSequences).find(line => line.includes('Anthropic')) ?? ''
  assert.match(row(), /Configured/u)

  mode = 'fail'
  page.handleInput('r')
  await flush()
  assert.match(row(), /Unknown/u, 'a failed read must not keep painting the old Configured snapshot')
  assert.match(viewText(page), /could not be read/u)

  mode = 'empty'
  page.handleInput('r')
  await flush()
  assert.match(row(), /Not set/u)
  assert.doesNotMatch(viewText(page), /could not be read/u)
})

test('Enter after a resize but before the resize frame cannot submit a clipped form (RFL-007)', async () => {
  const { source, calls } = fakeSource()
  source.setReference = async ref => { calls.push(`set:${ref}`) }
  source.describeReference = async () => ({ configured: true })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, () => {})
  page.setBodyHeight(24)
  await flush()
  page.render(100)
  page.handleInput('\r')
  await flush()
  page.render(100)
  for (const character of 'sk-race') page.handleInput(character)
  page.setBodyHeight(6) // resize arrived, resize frame has NOT rendered
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  assert.equal(calls.some(call => call.startsWith('set:')), false)
})

test('a growing auth notice without a repaint disables the previously painted form budget (RFL-007)', async () => {
  const { source, calls } = fakeSource()
  source.setReference = async ref => { calls.push(`set:${ref}`) }
  source.describeReference = async () => ({ configured: true })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, () => {})
  page.setBodyHeight(11)
  await flush()
  page.render(100)
  page.handleInput('\r')
  await flush()
  page.render(100)
  for (const character of 'sk-notice') page.handleInput(character)
  // The URL/code notice grows by two lines after the last paint; the body
  // height did not change, but the form no longer fits its 8-row minimum.
  ;(page as unknown as { authNotice: { message: string; url: string; code: string } }).authNotice = {
    message: 'Continue in your browser',
    url: 'https://provider.example/authorize',
    code: 'ABCD',
  }
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  assert.equal(calls.some(call => call.startsWith('set:')), false)
})

test('an OLD credentialState read cannot overwrite a newer API-key write read-back (P2)', async () => {
  let releaseOld: (() => void) | undefined
  const { source } = fakeSource()
  source.credentialState = async () => {
    await new Promise<void>(resolve => { releaseOld = resolve })
    return { kind: 'known', configured: false }
  }
  source.setReference = async () => {}
  source.describeReference = async () => ({ configured: true })
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, () => {})
  page.setBodyHeight(24)
  await flush()
  page.render(100)
  page.handleInput('\r')
  await flush()
  page.render(100)
  for (const character of 'sk-newer') page.handleInput(character)
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /Verified/u)
  releaseOld?.()
  await flush()
  page.handleInput('\u001b')
  await flush()
  const acmeRow = page.render(100).map(stripTerminalSequences).find(line => line.includes('Acme Gateway'))
  assert.ok(acmeRow !== undefined)
  assert.match(acmeRow, /Configured/u, 'the older read must not regress the post-write projection')
  assert.doesNotMatch(acmeRow, /Not set/u)
})

test('an OLD records read cannot resurrect a deleted record after the authoritative re-read (P2)', async () => {
  let releaseOld: (() => void) | undefined
  let deleted = false
  let calls = 0
  const { source } = fakeSource()
  source.storedCredentials = async () => {
    calls += 1
    if (calls === 2) {
      await new Promise<void>(resolve => { releaseOld = resolve })
      return { rows: [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }], recordCleanupUnavailable: false, referenceReadFailures: [] }
    }
    return deleted
      ? { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }
      : { rows: [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  source.deleteRecord = async () => { deleted = true }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(26)
  await flush()
  for (let index = 0; index < 100; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
    const frame = page.render(100).map(stripTerminalSequences).join('\n')
    if (frame.includes('> Clear credential')) break
  }
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /cleared/u)
  releaseOld?.()
  await flush()
  page.handleInput('\u001b')
  await flush()
  const row = page.render(100).map(stripTerminalSequences).find(line => line.includes('Anthropic'))
  assert.ok(row !== undefined)
  assert.match(row, /Not set/u, 'the old record list must not resurrect the delete')
})

test('a failed record re-read fences the old records snapshot and leaves Unknown (P2)', async () => {
  let releaseOld: (() => void) | undefined
  let calls = 0
  const { source } = fakeSource()
  source.storedCredentials = async () => {
    calls += 1
    if (calls === 2) {
      await new Promise<void>(resolve => { releaseOld = resolve })
      return { rows: [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }], recordCleanupUnavailable: false, referenceReadFailures: [] }
    }
    if (calls === 3) throw new Error('record list re-read failed')
    return { rows: [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  source.deleteRecord = async () => {}
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(26)
  await flush()
  for (let index = 0; index < 100; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
    const frame = page.render(100).map(stripTerminalSequences).join('\n')
    if (frame.includes('> Clear credential')) break
  }
  page.handleInput('\r')
  await flush()
  assert.match(viewText(page), /could not be re-read/u)
  releaseOld?.()
  await flush()
  page.handleInput('\u001b')
  await flush()
  const row = page.render(100).map(stripTerminalSequences).find(line => line.includes('Anthropic'))
  assert.ok(row !== undefined)
  assert.match(row, /Unknown/u, 'the failed re-read must fence the pre-delete snapshot')
})

test('a refresh while a reference clear is pending cannot reset it to ready (RFL-009)', async () => {
  let releaseClear: (() => void) | undefined
  let configured = true
  const { source } = fakeSource()
  source.describeReference = async () => ({ configured })
  source.clearReference = async () => {
    await new Promise<void>(resolve => { releaseClear = resolve })
    configured = false
  }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway', route: 'acme' },
  }, () => {})
  page.setBodyHeight(26)
  await flush()
  for (let index = 0; index < 100; index += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
    const frame = page.render(100).map(stripTerminalSequences).join('\n')
    if (frame.includes('> Clear credential')) break
  }
  page.handleInput('\r') // dispatch the Host clear; it is held pending
  await flush()
  assert.equal(page.pendingMutation(), true)
  page.handleInput('r') // refresh starts readReferenceState(configured=true)
  await flush()
  assert.equal(page.pendingMutation(), true, 'a refresh must not release the clear owner')
  assert.equal(page.handleInput('\u001b'), 'handled', 'Esc cannot leave while the clear is in flight')
  releaseClear?.()
  await flush()
  assert.equal(page.pendingMutation(), false)
})

test('a failed stored-credentials read shows the failure, not a permanent Reading state (F1)', async () => {
  let fail = true
  const { source } = fakeSource()
  source.storedCredentials = async () => {
    if (fail) throw new Error('records backend unavailable')
    return { rows: [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'records' }, () => {})
  page.setBodyHeight(24)
  await flush()
  const failed = viewText(page)
  assert.match(failed, /records backend unavailable/u)
  assert.doesNotMatch(failed, /Reading the credential store/u)
  fail = false
  page.handleInput('r')
  await flush()
  assert.match(viewText(page), /Anthropic/u)
  assert.doesNotMatch(viewText(page), /could not be read/u)
})

test('an old model discovery cannot apply to an edited endpoint (F2)', async () => {
  let releaseDiscovery: (() => void) | undefined
  const { source } = fakeSource()
  source.discoverModels = async () => {
    await new Promise<void>(resolve => { releaseDiscovery = resolve })
    return [{ id: 'old-model' }]
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'add-provider', route: 'race-route' }, () => {})
  page.setBodyHeight(30)
  await flush()
  viewText(page)
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B') // Base URL
  page.handleInput('\r')
  await flush()
  page.render(100)
  for (const character of 'https://a.example/v1') page.handleInput(character)
  page.handleInput('\r')
  page.handleInput('\r')
  await flush()
  page.render(100)
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B') // Models
   page.handleInput('\r')
  await flush()
  for (let index = 0; index < 50; index += 1) {
    if (/Probing the endpoint/u.test(viewText(page))) break
    await new Promise<void>(resolve => setImmediate(resolve))
    page.render(100)
  }
  assert.match(viewText(page), /Probing the endpoint/u)
  page.handleInput('\u001b[A')
  page.handleInput('\u001b[A')
  page.handleInput('\u001b[A') // back to Base URL
  page.handleInput('\r')
  await flush()
  page.render(100)
  for (const character of 'https://b.example/v1') page.handleInput(character)
  page.handleInput('\r')
  await flush()
  releaseDiscovery?.()
  await flush()
  const painted = viewText(page)
  assert.match(painted, /https:\/\/b\.example\/v1/u)
  assert.doesNotMatch(painted, /Models advertised by the endpoint/u)
  assert.doesNotMatch(painted, /old-model/u)
})

test('a profile-written/key-failed outcome refreshes the provider list (F3)', async () => {
  const { source } = fakeSource()
  const rows: ModelsProviderRow[] = []
  source.rows = () => rows
  source.createProvider = async draft => {
    rows.push({
      kind: 'reference', identity: `route:${draft.route}`, route: draft.route, label: draft.route,
      ref: 'PARTIAL_API_KEY', configured: false, declared: false, namesCredential: true,
      methods: [], inFlight: false, profile: { route: draft.route, configured: true, models: [...draft.models] },
    })
    return { kind: 'profile-written-key-failed', text: `provider ${draft.route} profile saved; key write failed`, reason: 'write refused' }
  }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'add-provider', route: 'partial-route' }, () => {})
  page.setBodyHeight(30)
  await flush()
  ;(page as unknown as { add: Record<string, unknown>; view: { kind: string } }).add = {
    step: 'review',
    draft: { route: 'partial-route', api: 'openai-completions', baseURL: 'https://partial.example/v1', displayName: '', models: ['m1'], key: '' },
    discovering: false,
  }
  ;(page as unknown as { view: { kind: string } }).view = { kind: 'review' }
  page.render(100)
  page.handleInput('\r') // Create
  await flush()
  assert.match(viewText(page), /key write failed/u)
  page.render(100)
  page.handleInput('\r') // Back to providers
  await flush()
  assert.match(viewText(page), /partial-route/u)
})

test('a short select picker keeps its action bar visible with a 3-line notice (F4)', async () => {
  const { source } = fakeSource()
  let picked: string | undefined
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  page.setBodyHeight(4)
  ;(page as unknown as { picker: unknown }).picker = {
    token: {}, header: 'Sign in method', items: [{ value: 'a', label: 'Method A' }, { value: 'b', label: 'Method B' }],
    index: 0,
    onSelect: (value: string) => { picked = value },
    onCancel: () => {},
  }
  ;(page as unknown as { authNotice: unknown }).authNotice = { message: 'Continue in your browser', url: 'https://example.test/authorize', code: 'ABCD' }
  const lines = page.render(40).map(stripTerminalSequences)
  assert.equal(lines.length, 4)
  assert.match(lines.at(-1) ?? '', /Enter select/u)
  assert.match(lines.at(-1) ?? '', /Esc cancel/u)
  // The notice lines are not hit targets; the painted picker row is at y=2.
  page.onCellPress(2, 0)
  page.onCellClick(2, 0)
  assert.equal(picked, undefined, 'a notice line must not select a hidden picker row')
  page.onCellPress(2, 2)
  page.onCellClick(2, 2)
  assert.equal(picked, 'a')
})
