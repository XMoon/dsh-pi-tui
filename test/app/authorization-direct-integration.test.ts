/**
 * Phase 3C / C2-MA — the REAL provider-authorization seam behind the Models
 * page. The official `AuthorizationService` owns the attempt lifecycle; a
 * registered flow emits a notice and select/secret prompts and commits its
 * credential record. The TUI's `DirectAuthorizationConfig` bridges those
 * callback interactions into detached events, and the REAL
 * `createAuthorizationFlow` drives the page-style surface.
 *
 * The flow itself is a stand-in for a provider protocol (the protocol is the
 * provider's business); every lifecycle/commit path is the official service.
 *
 * @module @xmoon76/dsh-pi-tui/authorization-direct-integration.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { DirectAuthorizationConfig } from '../../src/runtime/direct/config-direct.ts'
import { createAuthorizationFlow, type AuthorizationSurface } from '../../src/app/command/authorization.ts'
import { ModelsWorkspacePage, type ModelsWorkspaceSource } from '../../src/tui/panels/models-workspace-page.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const KEY = credentialKey('llm-pi-ai', 'acme-oauth')

test('REAL AuthorizationService → Direct bridge → authorization flow: notice, select/secret prompts, committed record', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Acme OAuth',
      methods: [{ id: 'oauth', label: 'Sign in with Acme' }],
      run: async session => {
        session.notify({ message: 'Continue in your browser', url: 'https://acme.example/authorize', code: 'ABCD' })
        const method = await session.prompt({
          kind: 'select',
          message: 'Choose a method',
          options: [{ id: 'oauth', label: 'OAuth' }, { id: 'device', label: 'Device code' }],
        })
        const code = await session.prompt({ kind: 'secret', message: 'Paste the code' })
        await session.commit({ kind: 'grant', payload: { method, code } })
      },
    })

    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    const targets = port.listTargets()
    assert.equal(targets.length, 1)
    assert.equal(targets[0]!.key, KEY)
    assert.equal(targets[0]!.route, 'acme-oauth')
    assert.deepEqual(targets[0]!.methods, [{ id: 'oauth', label: 'Sign in with Acme' }])

    const notices: string[] = []
    const asked: string[] = []
    const surface: AuthorizationSurface = {
      openOutputViewer: options => {
        notices.push(options.initial)
        return () => {}
      },
      askQuestions: async questions => {
        asked.push(questions[0]!.question)
        return [{ id: questions[0]!.id, selected: [], custom: questions[0]!.masked === true ? 'code-123' : 'text-answer' }]
      },
      openPicker: (items, onSelect) => {
        asked.push('picker')
        onSelect(items[0]!.value)
        return { close: () => {} }
      },
    }

    const flow = createAuthorizationFlow(surface, port)
    const off = port.onEvent(flow.onEvent)
    try {
      const started = await port.begin({ key: KEY, method: 'oauth' })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') return
      flow.bind(started.attemptId)
      const outcome = await flow.outcome
      assert.equal(outcome.status, 'authorized')
      assert.ok(notices.some(notice => notice.includes('Continue in your browser') && notice.includes('ABCD')), notices.join('\n'))
      assert.deepEqual(asked, ['picker', 'Paste the code'])

      const credentials = ctx.get('credentials') as { listRecords(): Promise<readonly { key: string; kind?: string }[]> }
      const records = await credentials.listRecords()
      assert.ok(records.some(record => record.key === KEY && record.kind === 'grant'))
    } finally {
      off()
      flow.close()
    }
  }
})

test('REAL Direct cancel settles a provider that ignores abort exactly once', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-cancel-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'slow-oauth')
  let releaseUpstream: (() => void) | undefined
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key,
      label: 'Slow OAuth',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      // Deliberately ignores the abort signal and settles only when the test
      // releases it: the adapter must still terminate the consumer exactly once.
      run: async () => {
        await new Promise<void>(resolve => { releaseUpstream = resolve })
      },
    })

    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    const surface: AuthorizationSurface = {
      openOutputViewer: () => () => {},
      askQuestions: async () => [],
      openPicker: () => ({ close: () => {} }),
    }
    const flow = createAuthorizationFlow(surface, port)
    let settled = 0
    const off = port.onEvent(event => {
      if (event.kind === 'settled') settled += 1
      flow.onEvent(event)
    })
    try {
      const started = await port.begin({ key, method: 'oauth' })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') return
      flow.bind(started.attemptId)
      await port.cancel(started.attemptId)
      const outcome = await Promise.race([
        flow.outcome,
        new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 1_000)),
      ])
      assert.equal(outcome.status, 'cancelled')
      assert.equal(settled, 1)
      // A late upstream settlement after local finalization must be invisible.
      releaseUpstream?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, 1)
    } finally {
      off()
      flow.close()
    }
  }
})

test('REAL Direct attempt → Models page Esc: cancel settles and the page returns only after it (MA13 direct path)', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-page-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'page-slow-oauth')
  let releaseUpstream: (() => void) | undefined
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key,
      label: 'Page Slow OAuth',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async () => { await new Promise<void>(resolve => { releaseUpstream = resolve }) },
    })
    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    let settled = 0
    const runTasks: Promise<void>[] = []
    const row: import('../../src/tui/panels/models-workspace-page.ts').ModelsProviderRow = {
      kind: 'authorization',
      identity: `auth:${key}`,
      route: 'page-slow-oauth',
      label: 'Page Slow OAuth',
      key,
      configured: false,
      declared: false,
      namesCredential: false,
      canProvisionProfile: true,
      methods: [{ id: 'oauth', label: 'Sign in' }],
      inFlight: false,
      profile: { route: 'page-slow-oauth', configured: false, models: [] },
    }
    const source: ModelsWorkspaceSource = {
      available: true,
      readCatalog: async () => ({ kind: 'ready' as const, rows: [row] }),
      recordPresence: async () => ({ kind: 'known' as const, records: [] }),
      accountSummary: async () => ({ available: false }),
      credentialState: async () => ({ kind: 'known', configured: false }),
      storedCredentials: async () => ({ rows: [], recordCleanupUnavailable: false, referenceReadFailures: [] }),
      describeReference: async () => ({ configured: false }),
      setReference: async () => {},
      clearReference: async () => {},
      deleteRecord: async () => {},
      beginAuthorization: async (targetKey, method, signal) => port.begin({ key: targetKey, method, signal }),
      authorizationEvents: listener => port.onEvent(event => {
        if (event.kind === 'settled') settled += 1
        listener(event)
      }),
      respondAuthorization: (attemptId, promptId, answer) => port.respond(attemptId, promptId, answer),
      cancelAuthorization: attemptId => port.cancel(attemptId),
      provisionKeylessProfile: async () => '',
      discoverModels: async () => [],
      createProvider: async () => ({ kind: 'rejected', text: 'not used' }),
      configGuide: () => ({}),
      openUrl: () => {},
      copy: () => {},
      run: (_label, task) => { runTasks.push(task()) },
    }
    const page = new ModelsWorkspacePage(source, () => {}, { view: 'list' }, () => {})
    page.setBodyHeight(24)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      page.render(100)
      // The catalog read starts after the first painted frame: let it settle
      // before the page is driven.
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      page.render(100)
      // The flow is not a configured provider: its sign-in path lives in the
      // Add Provider catalog ("Other sign-ins").
      page.handleInput('\u001b[B') // the "Add Provider…" action
      page.handleInput('\r')
      page.render(100)
      page.handleInput('\r') // the "Other sign-ins" row
      page.render(100)
      page.handleInput('\r') // Sign in
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.match(page.render(100).join('\n'), /Page Slow OAuth/u)
      page.handleInput('\u001b') // Esc/back while running
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.match(page.render(100).join('\n'), /Models & Credentials/u)
      assert.equal(settled, 1)
      releaseUpstream?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(settled, 1)
      await Promise.all(runTasks)
    } finally {
      page.dispose()
    }
  }
})

test('Direct cancel waits for the authoritative upstream outcome (commit window)', async () => {
  const key = credentialKey('llm-pi-ai', 'commit-window')
  let releaseUpstream: ((outcome: { status: 'authorized' | 'cancelled' }) => void) | undefined
  const entry = {
    key,
    label: 'Commit Window',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
  }
  const service = {
    list: () => [entry],
    describe: () => entry,
    begin: () => new Promise<{ status: 'authorized' | 'cancelled' }>(resolve => { releaseUpstream = resolve }),
    cancel: () => {},
  }
  const port = new DirectAuthorizationConfig({ get: name => name === 'authorization' ? service : undefined })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  const off = port.onEvent(event => {
    if (event.kind === 'settled') settled += 1
    flow.onEvent(event)
  })
  try {
    const started = await port.begin({ key })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await port.cancel(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, 0, 'cancel must not preempt a commit that may still resolve authorized')
    releaseUpstream?.({ status: 'authorized' })
    const outcome = await flow.outcome
    assert.equal(outcome.status, 'authorized')
    assert.equal(settled, 1)
  } finally {
    off()
    flow.close()
  }
})

test('Direct cancel with an outstanding prompt still waits for an authorized Host commit', async () => {
  const key = credentialKey('llm-pi-ai', 'prompt-commit-window')
  let releaseUpstream: ((outcome: { status: 'authorized' | 'cancelled' }) => void) | undefined
  let promptSeen = false
  const entry = {
    key,
    label: 'Prompt Commit Window',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
  }
  const service = {
    list: () => [entry],
    describe: () => entry,
    begin: async (request: {
      interaction: {
        prompt: (prompt: { kind: 'text'; message: string }) => Promise<string>
      }
    }) => {
      // Start a prompt but do not await its answer; the flow may still call
      // commit while this bridge remains outstanding.
      void request.interaction.prompt({ kind: 'text', message: 'held prompt' }).catch(() => {})
      promptSeen = true
      return await new Promise<{ status: 'authorized' | 'cancelled' }>(resolve => { releaseUpstream = resolve })
    },
    cancel: () => {},
  }
  const port = new DirectAuthorizationConfig({ get: name => name === 'authorization' ? service : undefined })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    // Keep the prompt OPEN so the cancellation actually has a pending bridge.
    askQuestions: () => new Promise(() => {}),
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  let withdrawn = 0
  const off = port.onEvent(event => {
    if (event.kind === 'settled') settled += 1
    if (event.kind === 'prompt-withdrawn') withdrawn += 1
    flow.onEvent(event)
  })
  try {
    const started = await port.begin({ key })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(promptSeen, true)
    await port.cancel(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(withdrawn, 0, 'the prompt stays answerable until the authoritative Host outcome')
    assert.equal(settled, 0, 'a pending prompt does NOT prove the Host has not entered commit')
    releaseUpstream?.({ status: 'authorized' })
    const outcome = await flow.outcome
    assert.equal(outcome.status, 'authorized')
    assert.equal(settled, 1)
  } finally {
    off()
    flow.close()
  }
})

test('cancel keeps a pending prompt answerable so a flow that awaits it can settle authorized', async () => {
  const key = credentialKey('llm-pi-ai', 'answer-after-cancel')
  const entry = {
    key,
    label: 'Answer After Cancel',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    inFlight: false,
  }
  const service = {
    list: () => [entry],
    describe: () => entry,
    begin: async (request: {
      interaction: { prompt: (prompt: { kind: 'text'; message: string }) => Promise<string> }
    }) => {
      await request.interaction.prompt({ kind: 'text', message: 'answer after cancel' })
      return { status: 'authorized' as const }
    },
    cancel: () => {},
  }
  const port = new DirectAuthorizationConfig({ get: name => name === 'authorization' ? service : undefined })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: () => new Promise(() => {}),
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  let withdrawn = 0
  let promptId: string | undefined
  const off = port.onEvent(event => {
    if (event.kind === 'settled') settled += 1
    if (event.kind === 'prompt-withdrawn') withdrawn += 1
    if (event.kind === 'prompt') promptId = event.promptId
    flow.onEvent(event)
  })
  try {
    const started = await port.begin({ key })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(promptId !== undefined)
    await port.cancel(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(withdrawn, 0, 'the prompt stays answerable')
    assert.equal(settled, 0, 'no terminal is forged while the flow may still finish')
    await port.respond(started.attemptId, promptId, 'answer')
    const outcome = await flow.outcome
    assert.equal(outcome.status, 'authorized')
    assert.equal(settled, 1)
  } finally {
    off()
    flow.close()
  }
})

test('REAL Host caller teardown during a held commit with a pending prompt cannot deadlock', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-forced-commit-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'forced-commit')
  let releaseCommit: (() => void) | undefined
  life.defer(() => releaseCommit?.())
  const store = new Map<string, unknown>()
  ctx.provide('credentials', {
    modifyRecord: async (recordKey: string, update: () => Promise<unknown>) => {
      await new Promise<void>(resolve => { releaseCommit = resolve })
      const record = await update()
      store.set(recordKey, record)
      ctx.emit('credentials/record-updated', recordKey as never)
      return record
    },
    describeRecord: async (recordKey: string) => ({ configured: store.has(recordKey) }),
  } as never)
  await ctx.plugin(AuthorizationService)
  ctx.authorization.registerFlow({
    key,
    label: 'Forced Commit',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    run: async session => {
      const prompt = session.prompt({ kind: 'text', message: 'held prompt' })
      prompt.catch(() => {})
      await new Promise<void>(resolve => setImmediate(resolve))
      await session.commit({ kind: 'grant', payload: { token: 'secret' } })
      await prompt
    },
  })
  const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: () => new Promise(() => {}),
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  let withdrawn = 0
  const off = port.onEvent(event => {
    if (event.kind === 'settled') settled += 1
    if (event.kind === 'prompt-withdrawn') withdrawn += 1
    flow.onEvent(event)
  })
  try {
    const controller = new AbortController()
    const started = await port.begin({ key, signal: controller.signal })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort() // pageController teardown: forced caller abort
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(withdrawn, 1, 'the destroyed prompt bridge is withdrawn/rejected')
    assert.equal(settled, 0, 'no local terminal is synthesized before the Host outcome')
    releaseCommit?.()
    const outcome = await Promise.race([
      flow.outcome,
      new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 1_000)),
    ])
    assert.notEqual(outcome.status, 'timeout', 'the authoritative Host outcome still settles')
    assert.equal(settled, 1)
    assert.equal(store.has(key), true, 'the held commit did persist despite the UI teardown')
  } finally {
    off()
    flow.close()
  }
})

test('REAL Host caller teardown while waiting on a prompt settles cancelled without a record', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-forced-wait-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'forced-wait')
  const store = new Map<string, unknown>()
  ctx.provide('credentials', {
    modifyRecord: async (recordKey: string, update: () => Promise<unknown>) => {
      const record = await update()
      store.set(recordKey, record)
      ctx.emit('credentials/record-updated', recordKey as never)
      return record
    },
    describeRecord: async (recordKey: string) => ({ configured: store.has(recordKey) }),
  } as never)
  await ctx.plugin(AuthorizationService)
  ctx.authorization.registerFlow({
    key,
    label: 'Forced Wait',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    run: async session => {
      await session.prompt({ kind: 'text', message: 'waiting prompt' })
      await session.commit({ kind: 'grant', payload: { token: 'secret' } })
    },
  })
  const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: () => new Promise(() => {}),
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  const events: import('../../src/runtime/config-port.ts').AuthorizationFlowEvent[] = []
  const off = port.onEvent(event => {
    events.push(event)
    if (event.kind === 'settled') settled += 1
    flow.onEvent(event)
  })
  try {
    const controller = new AbortController()
    const started = await port.begin({ key, signal: controller.signal })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort()
    const outcome = await Promise.race([
      flow.outcome,
      new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 1_000)),
    ])
    assert.equal(outcome.status, 'cancelled')
    assert.equal(settled, 1)
    assert.equal(store.size, 0)
    assert.ok(events.some(event => event.kind === 'prompt-withdrawn'))
  } finally {
    off()
    flow.close()
  }
})

test('REAL Host prompt created AFTER forced teardown is rejected as surface disposed, never surfaced/declined', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-late-prompt-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'late-prompt')
  let releaseFlow: (() => void) | undefined
  life.defer(() => releaseFlow?.())
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key,
      label: 'Late Prompt',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async session => {
        await new Promise<void>(resolve => { releaseFlow = resolve })
        await session.prompt({ kind: 'text', message: 'must never reach the dead page' })
        await session.commit({ kind: 'grant', payload: { token: 'secret' } })
      },
    })
    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    const surface: AuthorizationSurface = {
      openOutputViewer: () => () => {},
      askQuestions: () => new Promise(() => {}),
      openPicker: () => ({ close: () => {} }),
    }
    const flow = createAuthorizationFlow(surface, port)
    let prompts = 0
    let settled = 0
    const off = port.onEvent(event => {
      if (event.kind === 'prompt') prompts += 1
      if (event.kind === 'settled') settled += 1
      flow.onEvent(event)
    })
    try {
      const controller = new AbortController()
      const started = await port.begin({ key, signal: controller.signal })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') return
      flow.bind(started.attemptId)
      controller.abort() // page teardown happened before the provider asked
      releaseFlow?.()
      const outcome = await Promise.race([
        flow.outcome,
        new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 1_000)),
      ])
      assert.equal(outcome.status, 'cancelled')
      assert.equal(prompts, 0, 'a dead page never receives a late prompt')
      assert.equal(settled, 1)
    } finally {
      off()
      flow.close()
    }
  }
})

test('REAL Host synchronous prompt from an abort listener never reaches the dead surface', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-reentrant-prompt-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'reentrant-prompt')
  {
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)
    ctx.authorization.registerFlow({
      key,
      label: 'Reentrant Prompt',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: async session => {
        await new Promise<void>(resolve => {
          session.signal.addEventListener('abort', () => {
            // The Host forwards abort synchronously; a provider may prompt
            // from inside that dispatch before Direct's force flag was set.
            void session.prompt({ kind: 'text', message: 'abort-time prompt' }).catch(() => {})
            resolve()
          }, { once: true })
        })
      },
    })
    const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
    const surface: AuthorizationSurface = {
      openOutputViewer: () => () => {},
      askQuestions: () => new Promise(() => {}),
      openPicker: () => ({ close: () => {} }),
    }
    const flow = createAuthorizationFlow(surface, port)
    let prompts = 0
    let settled = 0
    const off = port.onEvent(event => {
      if (event.kind === 'prompt') prompts += 1
      if (event.kind === 'settled') settled += 1
      flow.onEvent(event)
    })
    try {
      const controller = new AbortController()
      const started = await port.begin({ key, signal: controller.signal })
      assert.equal(started.kind, 'started')
      if (started.kind !== 'started') return
      flow.bind(started.attemptId)
      controller.abort()
      const outcome = await Promise.race([
        flow.outcome,
        new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 1_000)),
      ])
      assert.notEqual(outcome.status, 'timeout')
      assert.equal(prompts, 0, 'no prompt event may reach the dead surface')
      assert.equal(settled, 1)
    } finally {
      off()
      flow.close()
    }
  }
})

test('REAL Host ordinary cancel then forced teardown still releases a committing prompt', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-auth-cancel-then-teardown-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const key = credentialKey('llm-pi-ai', 'cancel-then-teardown')
  let releaseCommit: (() => void) | undefined
  life.defer(() => releaseCommit?.())
  const store = new Map<string, unknown>()
  ctx.provide('credentials', {
    modifyRecord: async (recordKey: string, update: () => Promise<unknown>) => {
      await new Promise<void>(resolve => { releaseCommit = resolve })
      const record = await update()
      store.set(recordKey, record)
      ctx.emit('credentials/record-updated', recordKey as never)
      return record
    },
    describeRecord: async (recordKey: string) => ({ configured: store.has(recordKey) }),
  } as never)
  await ctx.plugin(AuthorizationService)
  ctx.authorization.registerFlow({
    key,
    label: 'Cancel Then Teardown',
    methods: [{ id: 'oauth', label: 'Sign in' }],
    run: async session => {
      const prompt = session.prompt({ kind: 'text', message: 'held prompt' })
      prompt.catch(() => {})
      await new Promise<void>(resolve => setImmediate(resolve))
      await session.commit({ kind: 'grant', payload: { token: 'secret' } })
      await prompt
    },
  })
  const port = new DirectAuthorizationConfig({ get: name => ctx.get(name) })
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: () => new Promise(() => {}),
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, port)
  let settled = 0
  let withdrawn = 0
  const off = port.onEvent(event => {
    if (event.kind === 'settled') settled += 1
    if (event.kind === 'prompt-withdrawn') withdrawn += 1
    flow.onEvent(event)
  })
  try {
    const controller = new AbortController()
    const started = await port.begin({ key, signal: controller.signal })
    assert.equal(started.kind, 'started')
    if (started.kind !== 'started') return
    flow.bind(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    // Ordinary cancel while the Host is already committing: it cannot withdraw.
    await port.cancel(started.attemptId)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(settled, 0, 'ordinary cancel does not forge a terminal')
    // Forced page teardown must still be observed by the retained caller listener.
    controller.abort()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(withdrawn, 1, 'forced teardown releases the still-pending prompt')
    releaseCommit?.()
    const outcome = await Promise.race([
      flow.outcome,
      new Promise<{ status: string }>(resolve => setTimeout(() => resolve({ status: 'timeout' }), 1_000)),
    ])
    assert.notEqual(outcome.status, 'timeout', 'no deadlock after cancel -> forced teardown')
    assert.equal(settled, 1)
    assert.equal(store.has(key), true, 'the committed record remains the store authority')
  } finally {
    off()
    flow.close()
  }
})
