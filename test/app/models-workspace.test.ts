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
import { ModelsWorkspacePage, type ModelsInitialView, type ModelsProviderRow, type ModelsWorkspaceSource } from '../../src/tui/panels/models-workspace-page.ts'
import { CredentialWorkflow } from '../../src/app/command/credential-workflow.ts'
import {
  resolveLoginDestination,
  resolveLogoutDestination,
  genericAuthorizationTargets,
  ACCOUNT_AUTHORIZATION_KEY,
} from '../../src/app/command/credential-workflow.ts'
import type { CredentialProviderOption, AuthorizationFlowTarget } from '../../src/runtime/config-port.ts'

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
      canProvisionProfile: true,
      group: 'configured',
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
      canProvisionProfile: true,
      group: 'configured',
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
      canProvisionProfile: true,
      group: 'configured',
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
    readCatalog: async () => ({ kind: 'ready', rows: makeRows() }),
    accountSummary: async () => ({ available: true, status: options.accountStatus ?? 'signed-out' }),
    credentialState: async ref => ({ kind: 'known', configured: configured(ref) }),
    recordPresence: async () => ({
      kind: 'known',
      records: (options.records ?? []).map(record => ({ key: record.key })),
    }),
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

/**
 * Construct the page and paint its FIRST frame. The catalog read starts
 * after that frame (the page never reads a provider directory in the input
 * path that mounts it), so a harness that wants the rows must paint once
 * and let the read settle.
 */
/**
 * Construct the page with a `requestRender` that behaves like the host's:
 * the requested frame is painted (the page-level tests have no TuiApp). Reads
 * the page queues behind a paint therefore run after that render's write,
 * exactly like the app; a test that only awaits timers must let that frame
 * happen instead of assuming a no-op requestRender.
 */
function openPage(
  source: ModelsWorkspaceSource,
  initial: ModelsInitialView,
  height: number,
  onOpenAccount: () => void = () => {},
): ModelsWorkspacePage {
  let page: ModelsWorkspacePage | undefined
  page = new ModelsWorkspacePage(source, () => { page?.render(100) }, initial, onOpenAccount)
  page.setBodyHeight(height)
  page.render(100)
  return page
}

/**
 * Construct the page and paint its FIRST frame. The catalog read starts
 * after that frame (the page never reads a provider directory in the input
 * path that mounts it), so a harness that wants the rows must paint once
 * and let the read settle.
 */
function openWith(source: ModelsWorkspaceSource, initial: ModelsInitialView, height: number): ModelsWorkspacePage {
  return openPage(source, initial, height)
}

function open(initial: ModelsInitialView = { view: 'list' }): { page: ModelsWorkspacePage; calls: string[]; accountOpened: () => boolean } {
  const { source, calls } = fakeSource()
  const page = openPage(source, initial, 24, () => { calls.push('open-account') })
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
  // The write action waits for the credential store's own read of the ref.
  await flush()
  viewText(page)
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
  const page = openWith(source, { view: 'provider', route: 'acme' }, 24)
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
  const other = openWith(noPath, { view: 'guide' }, 20)
  assert.match(viewText(other), /unavailable/u)
})

test('CredentialWorkflow.createProvider reports a profile write and a separate key failure', async () => {
  const mutations: { ns: string; ops: unknown[] }[] = []
  let settings: Record<string, unknown> | undefined = {}
  const workflow = new CredentialWorkflow({
    providers: {
      available: () => true,
      listCredentialOptions: () => [],
      readCatalog: () => ({ options: [], profiles: [] }),
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
  const listeners = new Set<(event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
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
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 26)
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
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 24)
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
      readCatalog: () => ({ options: [], profiles: [] }),
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
  const tiny = openWith(source, { view: 'provider', route: 'acme' }, 3)
  await flush()
  const tinyFrame = tiny.render(30).map(stripTerminalSequences).join('\n')
  assert.match(tinyFrame, /Resize the terminal/u)
})

test('Models mouse press/release follows the painted hit map and a resize revokes it', async () => {
  const { source, calls } = fakeSource()
  const page = openWith(source, { view: 'provider', route: 'acme' }, 24)
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
  clearPage.render(100)
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
  page.render(100)
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
  const listeners = new Set<(event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
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
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 26)
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
  const page = openWith(source, { view: 'provider', route: 'acme' }, 24)
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
  const listeners = new Set<(event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
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
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 26)
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
  let heldResolve: ((state: import('../../src/tui/panels/models-workspace-page.ts').ModelsCredentialState) => void) | undefined
  let releaseFirst = true
  source.credentialState = async () => {
    if (releaseFirst) {
      releaseFirst = false
      return await new Promise(resolve => { heldResolve = resolve })
    }
    return { kind: 'known', configured: true }
  }
  const page = openWith(source, { view: 'list' }, 24)
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
  source.readCatalog = async () => ({ kind: 'ready' as const, rows: createdRows })
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
      canProvisionProfile: true,
      methods: [],
      inFlight: false,
      profile: { route: draft.route, configured: true, models: [...draft.models] },
    })
    return { kind: 'created', text: `provider ${draft.route} added` }
  }
  const page = openWith(source, { view: 'add-provider', route: 'new-route' }, 30)
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
  const listeners = new Set<(event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
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
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 26)
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
  let blockReRead = false
  let rejectReRead: ((error: Error) => void) | undefined
  source.describeReference = async () => {
    // The re-read AFTER the clear blocks: the clear stays in flight. (The
    // block is a flag, not a call count: the page reads the target once.)
    if (blockReRead) return await new Promise((_resolve, reject) => { rejectReRead = reject })
    return { configured: true }
  }
  source.clearReference = async ref => { calls.push(`unset:${ref}`) }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' },
  }, () => {})
  page.setBodyHeight(24)
  page.render(100)
  await flush()
  viewText(page)
  blockReRead = true
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
  const listeners = new Set<(event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
    for (const listener of listeners) listener(event)
  }
  source.authorizationEvents = listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  source.beginAuthorization = async () => ({ kind: 'started', attemptId: 'auth-back' })
  source.cancelAuthorization = async id => { calls.push(`cancel:${id}`) }
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 26)
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
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  const anthropicRow = page.render(100).map(stripTerminalSequences).find(line => line.includes('Anthropic'))
  assert.ok(anthropicRow !== undefined)
  // A provider-native sign-in row reports the SIGN-IN state; the record
  // presence is authoritative, never "Unknown" after a real read.
  assert.match(anthropicRow, /Signed in/u, 'the home list must not show Unknown after an authoritative records read')
  assert.doesNotMatch(anthropicRow, /Unknown/u)
})

test('two route-less authorization flows keep distinct identities and each opens its own detail (P2)', async () => {
  const { source, calls } = fakeSource()
  const rows: ModelsProviderRow[] = [
    {
      kind: 'authorization', identity: 'auth:plugin-a/default', route: '', label: 'Plugin A', key: 'plugin-a/default',
      configured: false, declared: false, namesCredential: false, methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false,
      profile: { route: '', configured: false, models: [] },
      canProvisionProfile: true,
    },
    {
      kind: 'authorization', identity: 'auth:plugin-b/default', route: '', label: 'Plugin B', key: 'plugin-b/default',
      configured: false, declared: false, namesCredential: false, methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false,
      profile: { route: '', configured: false, models: [] },
      canProvisionProfile: true,
    },
  ]
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  source.beginAuthorization = async key => { calls.push(`begin:${key}`); return { kind: 'started', attemptId: key } }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  viewText(page)
  // A route-less flow is not a HOME row: the Add Provider catalog keeps its
  // sign-in path discoverable ("Other sign-ins").
  page.handleInput('\u001b[B') // the "Add Provider…" action
  page.handleInput('\r')
  assert.match(viewText(page), /Other sign-ins/u)
  page.handleInput('\r') // the first "Other sign-ins" row
  assert.match(viewText(page), /Sign-in · Plugin A/u)
  page.handleInput('\u001b')
  await flush()
  viewText(page)
  page.handleInput('\u001b[B') // the "Add Provider…" action
  page.handleInput('\r')
  viewText(page) // paint the catalog: a row is activated only when it was painted
  page.handleInput('\u001b[B') // the second "Other sign-ins" row
  page.handleInput('\r')
  assert.match(viewText(page), /Sign-in · Plugin B/u)
  page.handleInput('\r') // sign in
  await flush()
  assert.ok(calls.includes('begin:plugin-b/default'), calls.join(','))
})

function runningAuthSource() {
  const { source, calls } = fakeSource()
  const listeners = new Set<(event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
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
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 26)
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
  // The HOME's record PRESENCE is the fact the clear action reads.
  source.recordPresence = async () => ({ kind: 'known', records: [{ key: 'llm-pi-ai/anthropic' }] })
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 26)
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
  const page = openWith(source, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, 24)
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
  page.render(100)
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
  assert.match(acmeRow, /Key missing/u)
})

test('a pending API-key write cannot be left by Esc and still verifies on settlement (P2)', async () => {
  let resolveWrite: (() => void) | undefined
  const { source } = fakeSource()
  source.setReference = () => new Promise<void>(resolve => { resolveWrite = resolve })
  source.describeReference = async () => ({ configured: true })
  const page = openWith(source, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, 24)
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

test('the reference page waits for the store read before it offers the write', async () => {
  const { source } = fakeSource()
  const releases: (() => void)[] = []
  let reads = 0
  source.describeReference = async () => {
    reads += 1
    if (reads === 1) await new Promise<void>(resolve => { releases.push(resolve) })
    return { configured: false }
  }
  const page = openWith(source, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, 24)
  await flush()
  const reading = viewText(page)
  assert.match(reading, /reading…/u)
  assert.match(reading, /credential store has not answered/u)
  assert.match(reading, /Configure API Key…/u)
  // The action is painted but DISABLED: Enter must not open the editor while
  // the store has not answered for this reference.
  page.handleInput('\r')
  assert.doesNotMatch(viewText(page), /Enter the API key/u)
  for (const release of releases) release()
  await flush()
  assert.match(viewText(page), /Not set/u)
  page.handleInput('\r')
  assert.match(viewText(page), /Enter the API key/u)
})

test('a failed reference read keeps the write disabled until a retry answers', async () => {
  const { source } = fakeSource()
  let fail = true
  source.describeReference = async () => {
    if (fail) throw new Error('store offline')
    return { configured: true }
  }
  const page = openWith(source, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, 24)
  await flush()
  assert.match(viewText(page), /the credential store could not be read: store offline/u)
  page.handleInput('\r')
  assert.doesNotMatch(viewText(page), /Enter the API key/u)
  fail = false
  page.handleInput('r')
  await flush()
  assert.match(viewText(page), /Configured/u)
  page.handleInput('\r')
  assert.match(viewText(page), /Enter the API key/u)
})

test('a refresh re-reads the clear target before the confirmation can be dispatched', async () => {
  const { source, calls } = fakeSource()
  let configured = true
  let reads = 0
  const releases: (() => void)[] = []
  source.describeReference = async () => {
    reads += 1
    if (reads === 2) await new Promise<void>(resolve => { releases.push(resolve) })
    return { configured }
  }
  source.clearReference = async (ref: string) => { calls.push(`unset:${ref}`); configured = false }
  const page = openWith(source, {
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' },
  }, 24)
  await flush()
  assert.match(viewText(page), /Clear credential/u)
  page.handleInput('r')
  // The re-read drops the previous `ready` answer to `reading` immediately:
  // the stale confirmation action is GONE, so there is nothing that can
  // dispatch a delete while the store is being re-checked.
  const reading = viewText(page)
  assert.match(reading, /Reading the credential store…/u)
  assert.doesNotMatch(reading, /Clear credential/u)
  assert.equal(calls.some(call => call.startsWith('unset:')), false)
  for (const release of releases) release()
  await flush()
  assert.match(viewText(page), /Clear credential/u)
  page.handleInput('\r')
  await flush()
  assert.equal(calls.includes('unset:ACME_API_KEY'), true)
})

test('opening the records view and pressing R start no stored-credential read in the input path', async () => {
  const { source } = fakeSource()
  let reads = 0
  source.storedCredentials = async () => {
    reads += 1
    return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  // (1) The R key in the records view is an input-path refresh.
  const recordsPage = openWith(source, { view: 'logout-list' }, 24)
  await flush()
  assert.equal(reads, 1, 'the deferred first read ran')
  recordsPage.handleInput('r')
  assert.equal(reads, 1, 'the input handler starts no stored-credential read')
  await flush()
  assert.equal(reads, 2)
  // (2) Opening the records view from the list is also an input-path start.
  const listPage = openWith(source, { view: 'list' }, 24)
  await flush()
  viewText(listPage)
  const before = reads
  listPage.handleInput('\u001b[F') // End: the last action (model config guide)
  listPage.handleInput('\u001b[A') // Up: Credential records
  listPage.handleInput('\r')
  assert.match(viewText(listPage), /Stored credentials/u)
  assert.equal(reads, before, 'opening the view starts no read inside the input handler')
  await flush()
  assert.equal(reads, before + 1)
})

test('leaving the records view before its deferred read starts cancels the scan', async () => {
  const { source } = fakeSource()
  let reads = 0
  source.storedCredentials = async () => {
    reads += 1
    return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  page.render(100)
  // End is the last action (model config guide), Up is Credential records.
  page.handleInput('\u001b[F')
  page.handleInput('\u001b[A')
  page.handleInput('\r') // opens the view: the read is SCHEDULED, not started
  page.handleInput('\u001b') // leave in the same batch, before the timer
  await flush()
  assert.equal(reads, 0, 'a view the user left before the timer pays no scan')
})

test('leaving the clear confirmation before its deferred read starts cancels the scan', async () => {
  // The authorization row must have a stored record: only then is the clear
  // action offered (a "Not signed in" row paints nothing to clear).
  const { source } = fakeSource({ records: [{ key: 'llm-pi-ai/anthropic' }] })
  let reads = 0
  source.storedCredentials = async () => {
    reads += 1
    return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 24)
  await flush()
  page.render(100)
  // The authorization row's actions: Sign in (provider), Clear stored
  // credential, Guide, Back.
  page.handleInput('\u001b[B') // -> Clear stored credential
  page.handleInput('\r') // opens the confirmation: the read is SCHEDULED, not started
  assert.match(viewText(page), /Reading the credential store…/u)
  page.handleInput('\u001b') // leave in the same batch, before the timer
  await flush()
  assert.equal(reads, 0, 'a confirmation the user left before the timer pays no scan')
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
    canProvisionProfile: true,
    methods: [],
    inFlight: false,
    profile: { route: `p${index}`, configured: true, models: [] },
  }))
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  const page = openWith(source, { view: 'list' }, 10)
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
    canProvisionProfile: true,
  }]
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  const page = openWith(source, { view: 'provider', route: 'many' }, 8)
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
  const listeners = new Set<(event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent) => void>()
  const emit = (event: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent): void => {
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
  const page = openWith(source, { view: 'provider', route: 'anthropic' }, 24)
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
  // The HOME reads the record PRESENCE (one enumeration); the stored
  // credential LIST is read only in its own view.
  source.recordPresence = async () => {
    if (mode === 'fail') return { kind: 'failed' as const, reason: 'records read failed' }
    return {
      kind: 'known' as const,
      records: mode === 'ok' ? [{ key: 'llm-pi-ai/anthropic' }] : [],
    }
  }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  const row = (): string => page.render(100).map(stripTerminalSequences).find(line => line.includes('Anthropic')) ?? ''
  assert.match(row(), /Signed in/u)

  mode = 'fail'
  page.handleInput('r')
  await flush()
  assert.match(row(), /Outcome unknown/u, 'a failed read must not keep painting the old confirmed snapshot')
  assert.match(viewText(page), /could not be read/u)

  mode = 'empty'
  page.handleInput('r')
  await flush()
  assert.match(row(), /Not signed in/u)
  assert.doesNotMatch(viewText(page), /could not be read/u)
})

test('Enter after a resize but before the resize frame cannot submit a clipped form (RFL-007)', async () => {
  const { source, calls } = fakeSource()
  source.setReference = async ref => { calls.push(`set:${ref}`) }
  source.describeReference = async () => ({ configured: true })
  const page = openWith(source, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, 24)
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
  const page = openWith(source, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, 11)
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
  const page = openWith(source, { view: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' }, 24)
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
  source.storedCredentials = async () => ({
    rows: deleted
      ? []
      : [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }],
    recordCleanupUnavailable: false,
    referenceReadFailures: [],
  })
  // The HOME's record PRESENCE: the FIRST read is held (the old answer),
  // and the delete's re-read is the authoritative one.
  source.recordPresence = async () => {
    calls += 1
    if (calls === 1) {
      await new Promise<void>(resolve => { releaseOld = resolve })
      return { kind: 'known' as const, records: [{ key: 'llm-pi-ai/anthropic' }] }
    }
    return { kind: 'known' as const, records: deleted ? [] : [{ key: 'llm-pi-ai/anthropic' }] }
  }
  source.deleteRecord = async () => { deleted = true }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(26)
  page.render(100)
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
  assert.match(row, /Not signed in/u, 'the old record presence must not resurrect the delete')
})

test('a failed record re-read fences the old records snapshot and leaves Unknown (P2)', async () => {
  let releaseOld: (() => void) | undefined
  let calls = 0
  const { source } = fakeSource()
  source.storedCredentials = async () => {
    calls += 1
    if (calls === 3) throw new Error('record list re-read failed')
    return { rows: [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic', kindHint: 'grant' }], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  // The HOME's record PRESENCE: the first read is held (the old answer) and
  // the re-read after the clear FAILS — the state must be unknown, never the
  // pre-delete snapshot.
  source.recordPresence = async () => {
    calls += 1
    if (calls === 1) {
      await new Promise<void>(resolve => { releaseOld = resolve })
      return { kind: 'known' as const, records: [{ key: 'llm-pi-ai/anthropic' }] }
    }
    return { kind: 'failed' as const, reason: 'record presence re-read failed' }
  }
  source.deleteRecord = async () => {}
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(26)
  page.render(100)
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
  assert.match(row, /Outcome unknown/u, 'the failed re-read must fence the pre-delete snapshot')
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
  page.render(100)
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
  const page = openWith(source, { view: 'records' }, 24)
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
  const page = openWith(source, { view: 'add-provider', route: 'race-route' }, 30)
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
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  source.createProvider = async draft => {
    rows.push({
      kind: 'reference', identity: `route:${draft.route}`, route: draft.route, label: draft.route,
      ref: 'PARTIAL_API_KEY', configured: false, declared: false, namesCredential: true,
      canProvisionProfile: true,
      methods: [], inFlight: false, profile: { route: draft.route, configured: true, models: [...draft.models] },
    })
    return { kind: 'profile-written-key-failed', text: `provider ${draft.route} profile saved; key write failed`, reason: 'write refused' }
  }
  const page = openWith(source, { view: 'add-provider', route: 'partial-route' }, 30)
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

function shortPickerPage(): { page: ModelsWorkspacePage; picked: () => string | undefined; cancelled: () => boolean } {
  const { source } = fakeSource()
  let picked: string | undefined
  let cancelled = false
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'provider', route: 'anthropic' }, () => {})
  ;(page as unknown as { picker: unknown }).picker = {
    token: {}, header: 'Sign in method', items: [{ value: 'a', label: 'Method A' }, { value: 'b', label: 'Method B' }],
    index: 0,
    onSelect: (value: string) => { picked = value },
    onCancel: () => { cancelled = true },
  }
  ;(page as unknown as { authNotice: unknown }).authNotice = { message: 'Continue in your browser', url: 'https://example.test/authorize', code: 'ABCD' }
  return { page, picked: () => picked, cancelled: () => cancelled }
}

test('a 4-row picker with a 3-line notice refuses to hide auth details or submit (F4/F7)', async () => {
  const { page, picked, cancelled } = shortPickerPage()
  page.setBodyHeight(4)
  const lines = page.render(40).map(stripTerminalSequences)
  assert.match(lines.join('\n'), /Resize the terminal/u)
  assert.doesNotMatch(lines.join('\n'), /Method A/u)
  page.handleInput('\r')
  assert.equal(picked(), undefined)
  page.handleInput('\u001b')
  assert.equal(cancelled(), true, 'Esc must settle the prompt through onCancel, not orphan it')
})

test('a 5-row picker shows the full notice, action bar and correct mouse row (F4/F5)', async () => {
  const { page, picked } = shortPickerPage()
  page.setBodyHeight(5)
  const lines = page.render(40).map(stripTerminalSequences)
  assert.equal(lines.length, 5)
  assert.match(lines.join('\n'), /ABCD/u)
  assert.match(lines.at(-1) ?? '', /Enter select/u)
  // Notice occupies y=0..2, the picker row is y=3, action y=4.
  page.onCellPress(2, 0)
  page.onCellClick(2, 0)
  assert.equal(picked(), undefined, 'a notice line must not select a picker row')
  page.onCellPress(2, 3)
  page.onCellClick(2, 3)
  assert.equal(picked(), 'a')
})

test('a resize before frame invalidates picker mouse targets too (F7)', async () => {
  const { page, picked } = shortPickerPage()
  page.setBodyHeight(5)
  page.render(40) // painted while the picker fit
  page.setBodyHeight(4) // resize arrived, frame not painted
  page.onCellPress(2, 3)
  page.onCellClick(2, 3)
  assert.equal(picked(), undefined, 'the live fit check must block the stale painted target')
})

// ── Phase 3C / C2-A: the Left the Settings root may claim ─────────────────
//
// The Settings root may take a bare Left from the page ROOT back to the
// category rail. The page answers ONE question — "may the root claim this
// Left?" — and never reads the Host or changes business state to answer it.

test('the page reads NO provider catalog before its first painted frame', async () => {
  const { source } = fakeSource()
  let reads = 0
  source.readCatalog = async () => { reads += 1; return { kind: 'ready' as const, rows: makeRows() } }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
  page.setBodyHeight(24)
  // The constructor and the first frame are the INPUT path: a provider
  // directory read there would freeze the whole TUI.
  assert.equal(reads, 0, 'the constructor must not read the catalog')
  page.render(100)
  assert.equal(reads, 0, 'the first frame must be painted before the read')
  assert.match(viewText(page), /Loading provider configuration/u)
  await flush()
  assert.equal(reads, 1, 'the read runs once the frame is out')
  assert.match(viewText(page), /Acme Gateway/u)
})

test('the HOME lists only the configured providers and the Add catalog holds the rest', async () => {
  const rows: ModelsProviderRow[] = [
    {
      kind: 'reference', identity: 'route:acme', route: 'acme', label: 'Acme Gateway', ref: 'ACME_API_KEY',
      configured: true, declared: false, namesCredential: true, canProvisionProfile: true,
      methods: [], inFlight: false,
      profile: { route: 'acme', configured: true, displayName: 'Acme Gateway', models: ['acme-1'] },
    },
    {
      // An UNCONFIGURED directory route: an Add-catalog entry, never a HOME row.
      kind: 'reference', identity: 'route:openrouter', route: 'openrouter', label: 'OpenRouter', ref: 'OPENROUTER_API_KEY',
      configured: false, declared: false, namesCredential: false, canProvisionProfile: true, group: 'available',
      methods: [], inFlight: false,
      profile: { route: 'openrouter', configured: false, displayName: 'OpenRouter', models: [] },
    },
  ]
  const { source, calls } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  const home = viewText(page)
  assert.match(home, /Acme Gateway/u)
  assert.doesNotMatch(home, /OpenRouter/u, 'an unconfigured route is not a HOME row')
  // The catalog leads to the unconfigured route and offers the custom wizard.
  page.handleInput('\u001b[B') // the account row
  page.handleInput('\u001b[B') // the "Add Provider…" action
  page.handleInput('\r')
  const catalog = viewText(page)
  assert.match(catalog, /Available providers/u)
  assert.match(catalog, /OpenRouter/u)
  assert.match(catalog, /Custom provider/u)
  // Browsing wrote nothing: the source recorded no write call.
  assert.deepEqual(calls, [])
})

test('a shared credential reference is read ONCE per generation and every row shows it', async () => {
  const rows: ModelsProviderRow[] = [
    {
      kind: 'reference', identity: 'route:alpha', route: 'alpha', label: 'Alpha', ref: 'SHARED_API_KEY',
      configured: true, declared: false, namesCredential: true, canProvisionProfile: true,
      methods: [], inFlight: false,
      profile: { route: 'alpha', configured: true, displayName: 'Alpha', models: [] },
    },
    {
      kind: 'reference', identity: 'route:beta', route: 'beta', label: 'Beta', ref: 'SHARED_API_KEY',
      configured: true, declared: false, namesCredential: true, canProvisionProfile: true,
      methods: [], inFlight: false,
      profile: { route: 'beta', configured: true, displayName: 'Beta', models: [] },
    },
  ]
  const { source } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  const reads: string[] = []
  source.credentialState = async ref => { reads.push(ref); return { kind: 'known' as const, configured: true } }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  const home = viewText(page)
  assert.match(home, /Alpha/u)
  assert.match(home, /Beta/u, 'both providers of a shared reference stay visible')
  assert.deepEqual(reads, ['SHARED_API_KEY'], 'the shared reference is read once')
})

test('a failed catalog read shows the failure, never an empty provider list', async () => {
  const { source } = fakeSource()
  source.readCatalog = async () => ({ kind: 'failed' as const, reason: 'the provider directory is unreadable' })
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  const home = viewText(page)
  assert.match(home, /Could not read provider configuration/u)
  assert.match(home, /the provider directory is unreadable/u)
  assert.doesNotMatch(home, /No providers configured/u)
})

test('a refresh marks the credential facts stale until the fresh read confirms them', async () => {
  const { source } = fakeSource()
  let release: (() => void) | undefined
  let reads = 0
  source.readCatalog = async () => {
    reads += 1
    if (reads > 1) await new Promise<void>(resolve => { release = resolve })
    return { kind: 'ready' as const, rows: makeRows() }
  }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  assert.match(viewText(page), /Configured/u)
  page.handleInput('r')
  await flush()
  // The refresh is in flight: the previous answer is stale, never a fresh
  // confirmation.
  assert.match(viewText(page), /Refreshing/u)
  assert.match(viewText(page), /Stale/u)
  release?.()
  await flush()
  assert.match(viewText(page), /Configured/u)
  assert.doesNotMatch(viewText(page), /Stale/u)
})

test('the R key does not read the provider catalog in the input path', async () => {
  const { source } = fakeSource()
  let reads = 0
  source.readCatalog = async () => { reads += 1; return { kind: 'ready' as const, rows: makeRows() } }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  assert.equal(reads, 1)
  page.handleInput('r')
  // The Host read is synchronous: running it inside the key handler would
  // stall every keypress for the length of the snapshot read.
  assert.equal(reads, 1, 'the R key must not read the catalog in the input handler')
  await flush()
  assert.equal(reads, 2)
})

test('a stale snapshot disables the authority-dependent writes', async () => {
  const { source } = fakeSource()
  // The backend's last known values, explicitly not current.
  source.readCatalog = async () => ({ kind: 'stale' as const, rows: makeRows() })
  const page = openWith(source, { view: 'provider', route: 'acme' }, 24)
  await flush()
  const frame = viewText(page)
  assert.match(frame, /Provider · Acme Gateway/u)
  assert.match(frame, /Stale/u, 'the page states that the snapshot is not current')
  // The first action of a reference detail is the API-key write: it waits
  // for the fresh read.
  page.handleInput('\r')
  await flush()
  assert.doesNotMatch(viewText(page), /API Key Reference/u, 'a stale snapshot must not open the key editor')
})

test('a sign-in flow for a route the catalog does not offer stays discoverable', async () => {
  // The merge appends a flow whose route no provider option covers as a
  // standalone target: it is a sign-in, never a configured provider, and it
  // must stay reachable.
  const rows: ModelsProviderRow[] = [{
    kind: 'authorization', identity: 'auth:llm-pi-ai/orphan', route: 'orphan', label: 'Orphan Sign-in',
    key: 'llm-pi-ai/orphan', configured: false, declared: false, namesCredential: false, canProvisionProfile: false,
    methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false,
    profile: { route: 'orphan', configured: false, models: [] },
  }]
  const { source } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  assert.doesNotMatch(viewText(page), /Orphan Sign-in/u, 'an unconfigured flow is not a HOME row')
  page.handleInput('\u001b[B') // the "Add Provider…" action
  page.handleInput('\r')
  const catalog = viewText(page)
  assert.match(catalog, /Other sign-ins/u)
  assert.match(catalog, /Orphan Sign-in/u, 'the standalone sign-in stays discoverable')
})

test('a stale snapshot blocks the Add Provider create', async () => {
  const { source, calls } = fakeSource()
  source.readCatalog = async () => ({ kind: 'stale' as const, rows: makeRows() })
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  page.handleInput('\u001b[B') // the "Add Provider…" action
  page.handleInput('\r')
  viewText(page) // paint the catalog
  page.handleInput('\u001b[B') // the "Custom provider…" action
  page.handleInput('\r')
  viewText(page) // paint the wizard
  // The draft is filled through the page's own state (the shortcut the other
  // wizard tests use) and the review is opened.
  ;(page as unknown as { add: Record<string, unknown>; view: { kind: string } }).add = {
    step: 'review',
    draft: { route: 'new-route', api: 'openai-completions', baseURL: 'https://x.example/v1', displayName: '', key: '', models: ['m1'] },
    discovering: false,
  }
  ;(page as unknown as { view: { kind: string } }).view = { kind: 'review' }
  viewText(page)
  page.handleInput('\r') // the Create action
  await flush()
  assert.equal(calls.some(call => call.startsWith('create:')), false, 'a stale snapshot must not create a provider')
})

test('a standalone sign-in detail shows the sign-in, not a provider profile', async () => {
  const rows: ModelsProviderRow[] = [{
    kind: 'authorization', identity: 'auth:llm-pi-ai/orphan', route: 'orphan', label: 'Orphan Sign-in',
    key: 'llm-pi-ai/orphan', configured: false, declared: false, namesCredential: false, canProvisionProfile: false,
    methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false,
    profile: { route: 'orphan', configured: false, models: [] },
  }]
  const { source } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  const page = openWith(source, { view: 'provider', route: 'orphan' }, 24)
  await flush()
  const detail = viewText(page)
  assert.match(detail, /Sign-in · Orphan Sign-in/u)
  assert.match(detail, /Sign-in key/u)
  assert.doesNotMatch(detail, /API protocol/u, 'a sign-in has no provider profile facts')
  assert.doesNotMatch(detail, /Endpoint/u)
  assert.doesNotMatch(detail, /Provider · /u)
})

test('the Add catalog filters by typed text, and Esc clears the filter before it leaves', async () => {
  const available = (route: string, label: string): ModelsProviderRow => ({
    kind: 'reference', identity: `route:${route}`, route, label, ref: `${route.toUpperCase()}_API_KEY`,
    configured: false, declared: false, namesCredential: false, canProvisionProfile: true, group: 'available',
    methods: [], inFlight: false,
    profile: { route, configured: false, displayName: label, models: [] },
  })
  const rows: ModelsProviderRow[] = [
    available('anthropic', 'Anthropic'),
    available('azure', 'Azure'),
    available('baseten', 'Baseten'),
  ]
  const { source } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows })
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  page.handleInput('\u001b[B') // the "Add Provider…" action
  page.handleInput('\r')
  viewText(page)
  assert.match(viewText(page), /Anthropic/u)
  assert.match(viewText(page), /Baseten/u)
  // Typing narrows the list to the matching provider.
  page.handleInput('z')
  const narrowed = viewText(page)
  assert.match(narrowed, /Azure/u)
  assert.doesNotMatch(narrowed, /Anthropic/u)
  assert.doesNotMatch(narrowed, /Baseten/u)
  assert.match(narrowed, /Filter: z/u)
  // A filter with no match states it.
  page.handleInput('z')
  assert.match(viewText(page), /No provider matches/u)
  // Backspace widens the filter again.
  page.handleInput('\u007f')
  page.handleInput('\u007f')
  const widened = viewText(page)
  assert.match(widened, /Anthropic/u)
  assert.match(widened, /Baseten/u)
  // Esc clears the filter FIRST, and only then leaves the catalog.
  page.handleInput('z')
  page.handleInput('\u001b')
  const cleared = viewText(page)
  assert.match(cleared, /Available providers/u, 'the catalog stays open and the filter is cleared')
  assert.match(cleared, /Anthropic/u)
  assert.doesNotMatch(cleared, /Filter: z/u)
  page.handleInput('\u001b')
  assert.doesNotMatch(viewText(page), /Available providers/u, 'the second Esc leaves the catalog')
})

test('the catalog filter never paints a terminal control character', async () => {
  const available = (route: string, label: string): ModelsProviderRow => ({
    kind: 'reference', identity: `route:${route}`, route, label, ref: `${route.toUpperCase()}_API_KEY`,
    configured: false, declared: false, namesCredential: false, canProvisionProfile: true, group: 'available',
    methods: [], inFlight: false,
    profile: { route, configured: false, displayName: label, models: [] },
  })
  const { source } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows: [available('anthropic', 'Anthropic')] })
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  page.handleInput('\u001b[B') // the "Add Provider…" action
  page.handleInput('\r')
  viewText(page)
  // A C1 control and an ESC-led sequence are refused as filter text: they
  // must never reach the painted frame (docs/architecture/terminal-output.md).
  page.handleInput('\u009b31m')
  page.handleInput('\u001b]0;injected\u0007')
  page.handleInput('\u009b')
  const raw = page.render(100).join('\n')
  assert.doesNotMatch(raw, /\u009b/u, 'no C1 control may reach the frame')
  assert.doesNotMatch(raw, /\u001b\]0;/u, 'no OSC sequence may reach the frame')
  assert.match(raw, /Type to narrow the list\./u, 'the refused keys left the filter untouched')
  // Ordinary text — including CJK — is still filter text.
  page.handleInput('文')
  assert.match(viewText(page), /Filter: 文/u)
})

test('the credential presence is marked pending until the new generation confirms it', async () => {
  const { source } = fakeSource()
  const releases: (() => void)[] = []
  let credentialReads = 0
  source.readCatalog = async () => ({ kind: 'ready' as const, rows: makeRows() })
  source.credentialState = async ref => {
    credentialReads += 1
    if (credentialReads > 1) await new Promise<void>(resolve => { releases.push(resolve) })
    return { kind: 'known' as const, configured: true }
  }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  assert.match(viewText(page), /Configured/u)
  // The refresh settles the catalog, but the credential read of the new
  // generation is still in flight: the previous answer must NOT be painted
  // as a fresh confirmation.
  const row = (label: string): string => page.render(100).map(stripTerminalSequences).find(line => line.includes(label)) ?? ''
  page.handleInput('r')
  await flush()
  assert.doesNotMatch(row('deepseek official'), /Configured/u, 'the stale credential answer must not look confirmed')
  assert.match(row('deepseek official'), /Checking/u)
  for (const release of releases) release()
  await flush()
  assert.match(row('deepseek official'), /Configured/u)
})

test('consecutive refreshes start ONE catalog read', async () => {
  const { source } = fakeSource()
  let reads = 0
  source.readCatalog = async () => { reads += 1; return { kind: 'ready' as const, rows: makeRows() } }
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  assert.equal(reads, 1)
  // Three presses before the scheduled read starts: the superseded refreshes
  // must not run their Host scan at all.
  page.handleInput('r')
  page.handleInput('r')
  page.handleInput('r')
  await flush()
  assert.equal(reads, 2, 'only the newest refresh may read the catalog')
})

test('the stored-credential deeplink reads nothing in the constructor', async () => {
  const { source } = fakeSource()
  let catalogReads = 0
  let recordsReads = 0
  source.readCatalog = async () => { catalogReads += 1; return { kind: 'ready' as const, rows: makeRows() } }
  source.storedCredentials = async () => { recordsReads += 1; return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] } }
  const page = new ModelsWorkspacePage(source, () => {}, { view: 'logout-list' }, () => {})
  page.setBodyHeight(24)
  // The constructor is the input path: the deeplink's read reaches the
  // provider configuration, so it must wait for the first frame.
  assert.equal(catalogReads, 0)
  assert.equal(recordsReads, 0)
  page.render(100)
  await flush()
  assert.equal(recordsReads, 1, 'the records read runs after the first frame')
  assert.equal(catalogReads, 1)
})

test('a failed authoritative read cannot authorize a write', async () => {
  // The fail-soft option list reports every route as unconfigured; a WRITE
  // decision must not be taken from it.
  const writes: string[] = []
  const workflow = new CredentialWorkflow({
    providers: {
      available: () => true,
      listCredentialOptions: () => [
        { route: 'acme', label: 'Acme', ref: 'ACME_API_KEY', configured: false, declared: false, namesCredential: true, group: 'available' as const, canProvisionProfile: true },
      ],
      readCatalog: () => ({ options: [], profiles: [], failure: 'the settings read failed' }),
      readProfile: (route: string) => ({ route, configured: false, models: [] }),
      configGuide: () => ({}),
      writeProfile: async (route: string) => { writes.push(`profile:${route}`) },
      writeKeylessProfile: async (route: string) => { writes.push(`keyless:${route}`); return { kind: 'written' as const } },
    },
    credentials: {
      available: () => true,
      recordsSupported: () => true,
      describeReference: async () => ({ configured: false }),
      setReference: async () => {},
      unsetReference: async () => {},
      deleteRecord: async () => {},
      listRecords: async () => [],
      onChanged: () => () => {},
    },
    authorization: { available: () => true, listTargets: () => [], begin: async () => ({ kind: 'unavailable' as const }), onEvent: () => () => {}, respond: async () => {}, cancel: async () => {} },
    account: {
      available: () => false,
      getState: async () => ({ status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }),
      getProfile: async () => null,
      getBalance: async () => null,
      watch: async function* () {},
      getCallbackOrigin: () => undefined,
      startSignIn: async () => { throw new Error('unused') },
      cancelSignIn: async () => { throw new Error('unused') },
      signOut: async () => { throw new Error('unused') },
      hasRunningAccountTasks: () => false,
    },
    catalog: { models: { available: () => false, discoverModels: async () => [] } },
    signal: new AbortController().signal,
    diag: { error: () => {}, warn: () => {} },
  })
  // The keyless profile write (after a native sign-in) must not run on a
  // failed read.
  assert.equal(await workflow.provisionKeylessProfile('acme'), '')
  assert.deepEqual(writes, [])
  // The create is the same: a failed read cannot prove the route is free, so
  // the write is refused instead of guessed.
  const outcome = await workflow.createProvider({ route: 'acme', api: 'openai-completions', baseURL: 'https://acme.example/v1', displayName: '', models: ['m1'], apiKey: '' })
  assert.equal(outcome.kind, 'rejected')
  assert.deepEqual(writes, [], 'a failed read must not write')
})

test('a stale catalog authorizes neither the keyless profile write nor the create', async () => {
  const writes: string[] = []
  const workflow = new CredentialWorkflow({
    providers: {
      available: () => true,
      listCredentialOptions: () => [],
      // The last known values, explicitly not current.
      readCatalog: () => ({ options: [{ route: 'acme', label: 'Acme', ref: 'ACME_API_KEY', configured: false, declared: false, namesCredential: true, group: 'available' as const, canProvisionProfile: true }], profiles: [], stale: true }),
      readProfile: (route: string) => ({ route, configured: false, models: [] }),
      configGuide: () => ({}),
      writeProfile: async (route: string) => { writes.push(`profile:${route}`) },
      writeKeylessProfile: async (route: string) => { writes.push(`keyless:${route}`); return { kind: 'written' as const } },
    },
    credentials: {
      available: () => true,
      recordsSupported: () => true,
      describeReference: async () => ({ configured: false }),
      setReference: async () => {},
      unsetReference: async () => {},
      deleteRecord: async () => {},
      listRecords: async () => [],
      onChanged: () => () => {},
    },
    authorization: { available: () => true, listTargets: () => [], begin: async () => ({ kind: 'unavailable' as const }), onEvent: () => () => {}, respond: async () => {}, cancel: async () => {} },
    account: {
      available: () => false,
      getState: async () => ({ status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt: null }),
      getProfile: async () => null,
      getBalance: async () => null,
      watch: async function* () {},
      getCallbackOrigin: () => undefined,
      startSignIn: async () => { throw new Error('unused') },
      cancelSignIn: async () => { throw new Error('unused') },
      signOut: async () => { throw new Error('unused') },
      hasRunningAccountTasks: () => false,
    },
    catalog: { models: { available: () => false, discoverModels: async () => [] } },
    signal: new AbortController().signal,
    diag: { error: () => {}, warn: () => {} },
  })
  // A stale snapshot may belong to another Host: it authorizes no write.
  assert.equal(await workflow.provisionKeylessProfile('acme'), '')
  const outcome = await workflow.createProvider({ route: 'acme', api: 'openai-completions', baseURL: 'https://acme.example/v1', displayName: '', models: ['m1'], apiKey: '' })
  assert.equal(outcome.kind, 'rejected')
  assert.deepEqual(writes, [], 'a stale catalog must not write')
})

test('the single-target clear deeplink reads nothing in the constructor', async () => {
  const { source } = fakeSource()
  let catalogReads = 0
  let recordsReads = 0
  source.readCatalog = async () => { catalogReads += 1; return { kind: 'ready' as const, rows: makeRows() } }
  source.storedCredentials = async () => { recordsReads += 1; return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] } }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(24)
  // The clear target's read reaches the provider configuration: it must wait
  // for the first frame.
  assert.equal(catalogReads, 0)
  assert.equal(recordsReads, 0)
  page.render(100)
  await flush()
  assert.equal(recordsReads, 1, 'the clear read runs after the first frame')
})

test('the clear confirmation stays disabled until the authoritative read confirms the target', async () => {
  const { source } = fakeSource()
  const releases: (() => void)[] = []
  source.storedCredentials = async () => {
    await new Promise<void>(resolve => { releases.push(resolve) })
    return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(24)
  // The FIRST frame is the window: the store was not read yet, so the
  // confirmation must not be armed.
  page.render(100)
  const frame = viewText(page)
  assert.match(frame, /Reading the credential store/u)
  assert.doesNotMatch(frame, /> Clear credential/u, 'the delete must not be confirmable before the read')
  await flush()
  for (const release of releases) release()
  await flush()
  // The read answered: the state is the authority's answer, not a guess.
  assert.match(viewText(page), /Nothing stored for this target/u)
})

test('the pending clear target cannot dispatch a delete before its read', async () => {
  const { source, calls } = fakeSource()
  const releases: (() => void)[] = []
  source.storedCredentials = async () => {
    await new Promise<void>(resolve => { releases.push(resolve) })
    return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }
  }
  const page = new ModelsWorkspacePage(source, () => {}, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, () => {})
  page.setBodyHeight(24)
  page.render(100)
  // The Enter lands in the window before the deferred read started.
  page.handleInput('\r')
  await flush()
  assert.equal(calls.some(call => call.startsWith('delete:')), false, 'no delete may be dispatched before the read')
})

test('an explicit refresh does not swallow the deferred deep-link read', async () => {
  const { source } = fakeSource()
  let recordsReads = 0
  source.storedCredentials = async () => { recordsReads += 1; return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] } }
  const page = openPage(source, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, 24)
  // The refresh starts the catalog read before the deferred read's timer runs:
  // the deferred read must still happen exactly once.
  page.handleInput('r')
  await flush()
  assert.equal(recordsReads, 1, 'the deferred clear read must still run')
})

test('the deferred reads run once, are consumed by a manual refresh, and stop when the page left', async () => {
  // (1) A reference clear target: the catalog refresh reads the target's
  // authority ONCE — the deferred intent must not start a second read.
  const referenceReads: string[] = []
  const referenceSource = fakeSource()
  referenceSource.source.describeReference = async ref => { referenceReads.push(ref); return { configured: true } }
  const referencePage = openPage(referenceSource.source, {
    view: 'logout',
    target: { kind: 'reference', ref: 'ACME_API_KEY', label: 'Acme Gateway' },
  }, 24)
  await flush()
  assert.deepEqual(referenceReads, ['ACME_API_KEY'], 'the target is read exactly once')

  // (2) A manual refresh consumes the deferred stored-credential read.
  let recordsReads = 0
  const listSource = fakeSource()
  listSource.source.storedCredentials = async () => { recordsReads += 1; return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] } }
  const listPage = openPage(listSource.source, { view: 'logout-list' }, 24)
  listPage.handleInput('r')
  await flush()
  assert.equal(recordsReads, 1, 'the manual refresh consumes the deferred read instead of racing it')

  // (3) A user who left the view pays no stored-credential scan.
  let leftReads = 0
  const leftSource = fakeSource()
  leftSource.source.storedCredentials = async () => { leftReads += 1; return { rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] } }
  const leftPage = openPage(leftSource.source, { view: 'logout-list' }, 24)
  leftPage.handleInput('\u001b') // Esc leaves the list
  await flush()
  assert.equal(leftReads, 0, 'a view the user left must not run the stored-credential scan')
})

test('a pending delete keeps the confirmation locked while a refresh happens', async () => {
  const { source, calls } = fakeSource()
  const releases: (() => void)[] = []
  let deleted = false
  source.deleteRecord = async (key: string) => {
    calls.push(`delete:${key}`)
    await new Promise<void>(resolve => { releases.push(resolve) })
    deleted = true
  }
  // The store really REMOVES the record: the final success assertion below
  // can only pass on the authoritative absence, because the failure text
  // ("Not cleared: …") also contains the word "cleared".
  source.storedCredentials = async () => ({
    rows: deleted
      ? []
      : [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' }],
    recordCleanupUnavailable: false,
    referenceReadFailures: [],
  })
  const page = openWith(source, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, 24)
  await flush()
  // The read confirmed the record: the delete can be confirmed.
  assert.match(viewText(page), /Clear stored credential/u)
  page.handleInput('\r') // confirm the delete
  await flush()
  assert.deepEqual(calls, ['delete:llm-pi-ai/anthropic'])
  assert.match(viewText(page), /Clearing — the Host has not confirmed yet/u)
  // A refresh while the delete runs must not re-arm the confirmation.
  page.handleInput('r')
  await flush()
  assert.match(viewText(page), /Clearing — the Host has not confirmed yet/u, 'the pending delete keeps the page locked')
  // Esc cannot leave while the Host write is in flight.
  page.handleInput('\u001b')
  await flush()
  assert.match(viewText(page), /Clearing — the Host has not confirmed yet/u, 'the page stays locked while the delete runs')
  assert.match(viewText(page), /Clear stored credential/u, 'the confirmation view is still shown')
  // The Host write finishes: the outcome is reported.
  for (const release of releases) release()
  await flush()
  assert.match(viewText(page), /Anthropic signed out locally — stored credential cleared/u)
  assert.doesNotMatch(viewText(page), /Not cleared/u)
  assert.deepEqual(calls, ['delete:llm-pi-ai/anthropic'], 'the delete must not be dispatched twice')
})

test('a delete that returns but leaves the record present is NOT reported as cleared', async () => {
  const { source, calls } = fakeSource()
  source.deleteRecord = async (key: string) => { calls.push(`delete:${key}`) }
  // The delete call settles, but the authoritative re-read still sees the
  // record: the page must report the failed verification, never a success.
  source.storedCredentials = async () => ({
    rows: [{ kind: 'record' as const, key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' }],
    recordCleanupUnavailable: false,
    referenceReadFailures: [],
  })
  const page = openWith(source, {
    view: 'logout',
    target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' },
  }, 24)
  await flush()
  assert.match(viewText(page), /Clear stored credential/u)
  page.handleInput('\r')
  await flush()
  assert.deepEqual(calls, ['delete:llm-pi-ai/anthropic'])
  assert.match(viewText(page), /Not cleared: the stored record is still present after the clear/u)
  assert.doesNotMatch(viewText(page), /stored credential cleared/u)
})

test('the Models list may yield the focus to the Settings category rail', () => {
  const { page } = open()
  assert.equal(page.canYieldFocusToNavigation(), true,
    'the Models list root yields a bare Left to the root')
})

test('a provider detail keeps the Left inside the Models page', () => {
  const { page } = open({ view: 'provider', route: 'acme' })
  assert.equal(page.canYieldFocusToNavigation(), false,
    'a provider detail keeps the Left: the root must not skip a level')
})

test('the Add Provider draft keeps the Left inside the Models page', () => {
  const { page } = open({ view: 'add-provider' })
  assert.equal(page.canYieldFocusToNavigation(), false,
    'the draft wizard keeps the Left')
})

test('a pending API-key write keeps the Left inside the Models page', async () => {
  const { page, calls } = open({ view: 'reference', ref: 'ACME_API_KEY' })
  // The reference action is offered only after the store's own read answers;
  // once the editor is open it is a Question form, and the page must not let
  // the root claim the Left out of it.
  await flush()
  viewText(page)
  send(page, '\r')
  assert.match(viewText(page), /Enter the API key/u)
  assert.equal(page.canYieldFocusToNavigation(), false,
    'the masked editor keeps the Left inside the page')
  assert.equal(calls.some(call => call.startsWith('setReference')), false,
    'the Left never wrote anything')
})

// ── Tab / Shift+Tab region navigation (settings-tab-section-navigation) ────

/** One unconfigured directory route: an Add-catalog body row, never a HOME row. */
function catalogRow(route: string, label: string): ModelsProviderRow {
  return {
    kind: 'reference', identity: `route:${route}`, route, label, ref: `${route.toUpperCase()}_API_KEY`,
    configured: false, declared: false, namesCredential: false, canProvisionProfile: true, group: 'available',
    methods: [], inFlight: false,
    profile: { route, configured: false, displayName: label, models: [] },
  }
}

/** A large real Add catalog: forty unconfigured directory routes. */
function largeCatalog(count: number): ModelsProviderRow[] {
  return Array.from(
    { length: count },
    (_, index) => catalogRow(`provider-${index}`, index === 0 ? 'Anthropic' : `Provider ${String(index).padStart(2, '0')}`),
  )
}

/** Drive the real HOME -> Add Provider… action -> catalog path. */
async function openAddCatalog(page: ModelsWorkspacePage): Promise<void> {
  await flush()
  viewText(page)
  page.handleInput('\u001b[B') // the account row -> the Add Provider… action
  page.handleInput('\r')
}

test('Tab jumps a 40+ provider Add catalog to Custom provider… and Shift+Tab returns to the first row', async () => {
  const { source, calls } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows: largeCatalog(40) })
  const page = openWith(source, { view: 'list' }, 24)
  await openAddCatalog(page)
  const catalog = viewText(page)
  assert.match(catalog, /Available providers/u)
  assert.match(catalog, /^> Anthropic/m, 'the first provider row owns the cursor')
  assert.doesNotMatch(catalog, /Draft only/u, 'the catalog itself is not the draft form')
  assert.deepEqual(calls, [], 'browsing the catalog writes nothing')

  page.handleInput('\t')
  const jumped = viewText(page)
  assert.match(jumped, /^> Custom provider…/m, 'one Tab selects the first enabled action')
  assert.doesNotMatch(jumped, /Draft only/u, 'Tab never opens the draft')
  assert.deepEqual(calls, [], 'the jump performed no business action')

  page.handleInput('\u001b[Z')
  assert.match(viewText(page), /^> Anthropic/m, 'Shift+Tab returns to the first body row')

  page.handleInput('\t')
  page.handleInput('\r')
  assert.match(viewText(page), /Draft only — nothing is persisted/u, 'Enter (not Tab) opens the draft')
  assert.deepEqual(calls, [], 'opening the empty draft performed no write')
})

test('Tab keeps the Add catalog filter and scroll reveal; a zero-match filter ignores it', async () => {
  const { source } = fakeSource()
  source.readCatalog = async () => ({ kind: 'ready' as const, rows: largeCatalog(40) })
  const page = openWith(source, { view: 'list' }, 24)
  await openAddCatalog(page)
  // A filter that narrows the catalog to one row: the visible query and the
  // single match must survive the region jumps.
  page.handleInput('a')
  page.handleInput('n')
  page.handleInput('t')
  page.handleInput('h')
  page.handleInput('r')
  page.handleInput('o')
  const filtered = viewText(page)
  assert.match(filtered, /Filter: anthro · 1 match/u)
  assert.match(filtered, /^> Anthropic/m)
  assert.doesNotMatch(filtered, /Provider 01/u, 'the filter really narrowed the body')
  page.handleInput('\t')
  assert.match(viewText(page), /^> Custom provider…/m)
  page.handleInput('\u001b[Z')
  const back = viewText(page)
  assert.match(back, /Filter: anthro/u, 'the filter survives the region jump')
  assert.match(back, /^> Anthropic/m, 'the first filtered body row is selected again')
  page.handleInput('\u001b[B')
  assert.match(viewText(page), /^> Custom provider…/m, 'Up/Down still walks the filtered catalog into its actions')

  // Clear the filter, then shrink the viewport and scroll the BODY away from
  // the first provider with the page's real PageDown path. This makes the
  // follow-cursor reveal discriminating: a jump back to the body that forgot
  // `followCursor` leaves the page scrolled and Anthropic invisible.
  page.handleInput('\u001b') // clears the filter
  page.setBodyHeight(10)
  viewText(page)
  page.handleInput('\u001b[6~') // PageDown scrolls the body, not the cursor
  const scrolled = viewText(page)
  assert.doesNotMatch(scrolled, /Anthropic/u, 'the first provider left the body viewport')
  page.handleInput('\t') // body -> actions
  const actions = viewText(page)
  assert.match(actions, /^> Custom provider…/m)
  assert.doesNotMatch(actions, /Anthropic/u, 'jumping to the actions does not scroll the body')
  page.handleInput('\u001b[Z')
  assert.match(viewText(page), /^> Anthropic/m, 'returning to the body reveals the first row again')

  // Zero matches: the catalog has no body region, so Tab/Shift+Tab are no-ops.
  page.handleInput('z')
  page.handleInput('z')
  page.handleInput('z')
  const zero = viewText(page)
  assert.match(zero, /No provider matches/u)
  page.handleInput('\t')
  page.handleInput('\u001b[Z')
  assert.equal(viewText(page), zero, 'a zero-match catalog never fakes a body region')
})

test('Tab moves the cursor between body rows and actions on the HOME and stored-record pages', async () => {
  const { source, calls } = fakeSource()
  const page = openWith(source, { view: 'list' }, 24)
  await flush()
  viewText(page)
  page.handleInput('\t')
  assert.match(viewText(page), /^> Add Provider…/m, 'the HOME cursor moves to the first enabled action')
  assert.deepEqual(calls, [], 'the jump ran no action')
  page.handleInput('\u001b[Z')
  assert.match(viewText(page), /^> DeepSeek Account/m, 'Shift+Tab returns to the first body row')

  // A facts-only provider detail has no body row: the key is inert.
  const detail = openWith(source, { view: 'provider', route: 'acme' }, 24)
  await flush()
  const detailFrame = viewText(detail)
  detail.handleInput('\t')
  detail.handleInput('\u001b[Z')
  assert.equal(viewText(detail), detailFrame, 'a facts-only detail has no second region')

  // The stored-credential list has real rows plus a pinned Back action.
  const recordsSource = fakeSource({ records: [{ key: 'llm-pi-ai/acme', kind: 'grant' }] }).source
  const records = openWith(recordsSource, { view: 'records' }, 24)
  await flush()
  assert.match(viewText(records), /Stored credentials/u)
  records.handleInput('\t')
  assert.match(viewText(records), /^> ← Back/m, 'Tab selects the pinned Back action')
  records.handleInput('\u001b[Z')
  const firstRow = viewText(records).split('\n').find(line => line.includes('llm-pi-ai/acme'))
  assert.ok(firstRow?.startsWith('> '), 'Shift+Tab returns to the first stored row')
})

test('Tab lands on the first ENABLED action when an earlier action is disabled', async () => {
  let release: (() => void) | undefined
  const { source } = fakeSource()
  source.discoverModels = async () => {
    await new Promise<void>(resolve => { release = resolve })
    return [{ id: 'm1' }]
  }
  const page = openWith(source, { view: 'add-provider', route: 'race-route' }, 30)
  await flush()
  viewText(page)
  page.handleInput('\u001b[B')
  page.handleInput('\u001b[B') // Base URL
  page.handleInput('\r')
  await flush()
  page.render(100)
  for (const character of 'https://race.example/v1') page.handleInput(character)
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
  // The first action (Review & create) is disabled while discovery is in
  // flight, so the jump must land on the second, enabled action.
  page.handleInput('\t')
  const jumped = viewText(page)
  assert.match(jumped, /^> Cancel/m, 'Tab selects the first ENABLED action')
  assert.doesNotMatch(jumped, /^> Review & create/m, 'the disabled action never gains the cursor')
  release?.()
  await flush()
})

test('Tab works exactly when the body and action regions fit, on every Tab encoding', async () => {
  const { source } = fakeSource()
  const page = openWith(source, { view: 'list' }, 5)
  await flush()
  assert.match(viewText(page), /Tab sections/u, 'the hint is painted when both regions fit')
  page.handleInput('\t')
  assert.match(viewText(page), /^> Add Provider…/m)
  page.handleInput('\u001b[9;2u') // Kitty shift+tab
  assert.match(viewText(page), /^> DeepSeek Account/m, 'the Kitty shift+tab encoding toggles back')
  page.handleInput('\u001b[27;2;9~') // modifyOtherKeys shift+tab
  assert.match(viewText(page), /^> Add Provider…/m)
  page.handleInput('\u001b[9u') // Kitty plain tab
  assert.match(viewText(page), /^> DeepSeek Account/m)

  // No body row: the page's own resize floor drops the body region.
  page.setBodyHeight(4)
  const noBody = viewText(page)
  assert.doesNotMatch(noBody, /Tab sections/u, 'the hint needs a visible body region')
  page.handleInput('\t')
  assert.equal(viewText(page), noBody, 'no jump without a body row')
  page.setBodyHeight(5)
  page.handleInput('\t')
  assert.match(viewText(page), /^> Add Provider…/m, 'the restored layout jumps again')

  // The action group no longer fits at all: the page paints its resize
  // warning and must not grant an invisible cursor.
  page.setBodyHeight(3)
  const warning = viewText(page)
  assert.match(warning, /Resize the terminal to show the page actions/u)
  page.handleInput('\t')
  assert.equal(viewText(page), warning, 'the resize warning never grants an invisible selection')
})

test('an active picker, QuestionFlow or model picker keeps its own Tab', async () => {
  const { source } = fakeSource()
  const page = openWith(source, { view: 'add-provider', route: 'pick-route' }, 30)
  await flush()
  viewText(page)
  // The native wire-protocol picker.
  page.handleInput('\u001b[B') // API protocol
  page.handleInput('\r')
  const picker = viewText(page)
  assert.match(picker, /Wire protocol/u)
  page.handleInput('\t')
  assert.equal(viewText(page), picker, 'Tab does not move the page cursor under a picker')
  assert.match(picker, /Esc cancel/u, 'the picker keeps its own action bar')
  page.handleInput('\u001b')
  assert.doesNotMatch(viewText(page), /Esc cancel/u, 'Esc closes the picker')
  assert.match(viewText(page), /Tab sections/u, 'the form action bar is back')

  // The embedded QuestionFlow (Route field).
  page.handleInput('\u001b[A')
  page.handleInput('\r')
  assert.match(viewText(page), /Add provider · Route/u)
  page.handleInput('\t')
  assert.match(viewText(page), /Add provider · Route/u, 'Tab stays inside the QuestionFlow')
  page.handleInput('\u001b')
  page.handleInput('\u001b')
  assert.match(viewText(page), /Draft only/u, 'Esc cancels the field back to the draft form')

  // The model multi-select picker: discovery answers with models.
  const discovery = fakeSource()
  discovery.source.discoverModels = async () => [{ id: 'm1' }, { id: 'm2' }]
  const pickerPage = openWith(discovery.source, { view: 'add-provider', route: 'model-route' }, 30)
  await flush()
  viewText(pickerPage)
  pickerPage.handleInput('\u001b[B')
  pickerPage.handleInput('\u001b[B') // Base URL
  pickerPage.handleInput('\r')
  await flush()
  pickerPage.render(100)
  for (const character of 'https://models.example/v1') pickerPage.handleInput(character)
  pickerPage.handleInput('\r')
  pickerPage.handleInput('\r')
  await flush()
  pickerPage.render(100)
  pickerPage.handleInput('\u001b[B')
  pickerPage.handleInput('\u001b[B')
  pickerPage.handleInput('\u001b[B') // Models
  pickerPage.handleInput('\r')
  await flush()
  for (let index = 0; index < 50; index += 1) {
    if (/Models advertised by the endpoint/u.test(viewText(pickerPage))) break
    await new Promise<void>(resolve => setImmediate(resolve))
    pickerPage.render(100)
  }
  const modelPicker = viewText(pickerPage)
  assert.match(modelPicker, /Models advertised by the endpoint/u)
  pickerPage.handleInput('\t')
  assert.equal(viewText(pickerPage), modelPicker, 'Tab never leaks into the model picker')
  pickerPage.handleInput('\u001b')
  assert.doesNotMatch(viewText(pickerPage), /Models advertised by the endpoint/u)
})

test('Tab revokes a straddling Models row press and the action bar advertises it only while droppable', async () => {
  const { source, calls } = fakeSource()
  let accountOpened = 0
  const page = openPage(source, { view: 'list' }, 24, () => { accountOpened += 1 })
  await flush()
  const lines = viewText(page).split('\n')
  const y = lines.findIndex(line => line.includes('DeepSeek Account'))
  assert.ok(y >= 0, `the account row must be painted:\n${lines.join('\n')}`)
  page.onCellPress(0, y)
  page.handleInput('\t')
  page.onCellClick(0, y)
  assert.equal(accountOpened, 0, 'the straddling release never runs the old row action')
  assert.deepEqual(calls, [])

  // The hint is a whole, droppable segment: visible with room, gone at a
  // narrow width while Esc keeps the last physical row.
  assert.match(viewText(page), /Tab sections/u)
  const narrow = viewText(page, 40)
  assert.doesNotMatch(narrow, /Tab sections/u)
  assert.match(narrow, /Esc back/u)
})
