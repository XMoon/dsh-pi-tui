/**
 * S4-D2 B13/B14 — on-demand Claude Code / Codex provider boundaries over the
 * real rc.2 Optional packages (implementation plan §5 D2-6).
 *
 * The default path is OFFLINE and truthfully EXTERNAL_UNVERIFIED: the real
 * published package is installed into the profile, the official one-shot tool
 * row mounts, and the real native start either produces a genuine failure
 * (missing auth / unsupported platform) or a genuine success. A scripted or
 * mocked native success is never accepted.
 * @module @xmoon76/dsh-pi-tui/s4-d2-native-subagents.test
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  skippedInstallationReason,
  startS4D2Host,
  type S4D2BundleId,
} from './support/s4-d2-optional-bundle-fixture.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

const B13 = '@deepseek-ai/dsh-subagent-claude-code' satisfies S4D2BundleId
const B14 = '@deepseek-ai/dsh-subagent-codex' satisfies S4D2BundleId
const skip = skippedInstallationReason([B13, B14])
/** Native process starts are opt-in: the default suite NEVER launches a native
 *  provider (so `pnpm test` cannot read a real credential tree or run a paid
 *  external task). The fixture still isolates HOME/DSH_HOME/XDG when admitted.
 *
 * Two further opt-ins make the real provider paths reproducible WITHOUT
 * committing any credential:
 *  - B13: `S5_B13_DEEPSEEK_API_KEY` is the caller-supplied key for the official
 *    DeepSeek Anthropic-compatible endpoint (`real-deepseek.e2e.ts` shape);
 *    it is injected only through the provider `env` overlay.
 *  - B14: `S5_CODEX_AUTH_FILE` names the caller's native `~/.codex/auth.json`
 *    (ChatGPT OAuth); its bytes are copied into the isolated HOME (0600) and
 *    never printed or committed.
 * BOTH sources are read ONLY after `DSH_PI_TUI_S4_D2_NATIVE=1` admits the
 * native run; a credential path alone never triggers a file read or copy.
 * Each provider ALSO requires its OWN explicit source: with the global gate on
 * but one source absent, that provider is skipped before any native start (it
 * never inherits the other provider's or the ambient auth). Ambient
 * Anthropic/OpenAI/Codex env and `CODEX_HOME` are scrubbed for an admitted run.
 * When a credential is absent, that provider stays on the truthful
 * `EXTERNAL_UNVERIFIED` path and no network call is attempted. */
const NATIVE_ADMITTED = process.env.DSH_PI_TUI_S4_D2_NATIVE === '1'
const B13_DEEPSEEK_KEY = NATIVE_ADMITTED ? process.env.S5_B13_DEEPSEEK_API_KEY : undefined
const CODEX_AUTH_FILE = NATIVE_ADMITTED ? process.env.S5_CODEX_AUTH_FILE : undefined

/** The global gate is necessary but NOT sufficient: each provider needs its
 *  own explicit source before any native start. */
function providerAdmitted(
  admitted: boolean,
  provider: 'claude-code' | 'codex',
  b13Key: string | undefined,
  codexAuthFile: string | undefined,
): boolean {
  if (!admitted) return false
  return provider === 'claude-code' ? b13Key !== undefined : codexAuthFile !== undefined
}

/** The native gate is the ONLY credential admission: the path/key is ignored
 *  (and its file never read) unless the gate is on. */
function b13EnvOverlay(admitted: boolean, key: string | undefined): Record<string, string> | undefined {
  if (!admitted || key === undefined) return undefined
  return {
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
}

const NATIVE_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'CODEX_API_KEY', 'CODEX_HOME', 'DEEPSEEK_API_KEY',
  'S5_B13_DEEPSEEK_API_KEY', 'S5_CODEX_AUTH_FILE',
] as const

/** An admitted run may use ONLY its explicit source: remove ambient provider
 *  credentials for its duration (the explicit provider config still supplies
 *  its own overlay) and restore them afterwards. */
function scrubNativeAuthEnv(): () => void {
  const previous = new Map<string, string | undefined>()
  for (const key of NATIVE_AUTH_ENV_KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

interface CodexAuthCopy {
  readonly path: string
  /** Remove the credential copy WITHOUT consulting DSH_TEST_KEEP_TMP. */
  cleanup(): void
}

/** Copy the native Codex OAuth bytes into the isolated HOME with 0600. The
 *  credential is read only after the native gate admitted the run. */
function installCodexAuth(admitted: boolean, source: string | undefined, root: string): CodexAuthCopy | undefined {
  if (!admitted || source === undefined) return undefined
  const codexHome = join(root, 'home', '.codex')
  mkdirSync(codexHome, { recursive: true })
  const target = join(codexHome, 'auth.json')
  writeFileSync(target, readFileSync(source), { mode: 0o600 })
  chmodSync(target, 0o600)
  return {
    path: target,
    cleanup: () => {
      // The credential copy is deleted even when DSH_TEST_KEEP_TMP keeps the
      // ordinary disposable root for debugging.
      rmSync(codexHome, { recursive: true, force: true })
    },
  }
}

const nativeEvidence: Array<{ provider: string; status: string }> = []

/** Observe the parent's real settle/failure notice for one external child. */
async function observeSettle(agent: { session: { snapshotEvents(): readonly unknown[] } }, childId: string, timeoutMs: number): Promise<{ kind: 'success' | 'failure' } | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = agent.session.snapshotEvents() as readonly { type: string; data?: Record<string, unknown> }[]
    const settle = events.find(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes('subagent-settled')
      && JSON.stringify(event.data).includes(childId))
    if (settle !== undefined) {
      const text = JSON.stringify(settle.data)
      return { kind: /PONG|closing message|completed|finished/u.test(text) && !/failed|error|unavailable/u.test(text) ? 'success' : 'failure' }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return undefined
}

const NATIVE_TASKS = [
  { bundle: B13, packageName: B13, tool: 'subagent_claude_code', provider: 'claude-code' },
  { bundle: B14, packageName: B14, tool: 'subagent_codex', provider: 'codex' },
] as const

test('B13/B14: official missing catalog, exact installTarget and local profile install', { skip }, async t => {
  // Catalog truth before any install: both on-demand packages are discoverable
  // as missing official entries with an exact rc.2 install target.
  const catalogHost = await startS4D2Host(t, { bundles: [] })
  const pluginManager = catalogHost.ctx.get('pluginManager') as {
    listBundles(): Promise<readonly {
      name: string
      official: boolean
      availability: string
      installTarget?: { spec: string; version: string }
    }[]>
  }
  const catalog = await pluginManager.listBundles()
  for (const task of NATIVE_TASKS) {
    const entry = catalog.find(candidate => candidate.name === task.packageName)
    assert.ok(entry !== undefined, `${task.packageName} must be discoverable`)
    assert.equal(entry.official, true)
    assert.equal(entry.availability, 'missing')
    assert.equal(entry.installTarget?.version, '0.2.1-rc.2')
    assert.equal(entry.installTarget?.spec, `${task.packageName}@0.2.1-rc.2`)
  }
  await catalogHost.dispose()

  for (const task of NATIVE_TASKS) {
    const b13Env = b13EnvOverlay(NATIVE_ADMITTED, B13_DEEPSEEK_KEY)
    const admittedProvider = providerAdmitted(NATIVE_ADMITTED, task.provider, B13_DEEPSEEK_KEY, CODEX_AUTH_FILE)
    // Scrub BEFORE booting the Host so no provider mount can capture ambient
    // auth; the explicit source (B13 provider overlay / B14 copied auth.json)
    // is the only credential an admitted run can see.
    const restoreAuthEnv = admittedProvider ? scrubNativeAuthEnv() : undefined
    let host: Awaited<ReturnType<typeof startS4D2Host>>
    try {
      host = await startS4D2Host(t, {
        bundles: [task.bundle],
        profileDependencies: { [task.packageName]: `file:${join(catalogHost.installation.nodeModules, task.packageName)}` },
        ...(task.provider === 'claude-code' && b13Env !== undefined
          ? { patches: [{ id: 'subagent-claude-code', config: { env: b13Env } }] as never }
          : {}),
      })
    } catch (error) {
      restoreAuthEnv?.()
      throw error
    }
    let restoreCodexHome: (() => void) | undefined
    let codexAuth: CodexAuthCopy | undefined
    try {
      // The pinned package-local Codex app-server keeps native auth authoritative
      // through HOME/CODEX_HOME; copy the caller's native auth into the isolated
      // HOME (0600) just before delegation and restore the process variable after.
      codexAuth = admittedProvider && task.provider === 'codex'
        ? installCodexAuth(true, CODEX_AUTH_FILE, host.root)
        : undefined
      if (codexAuth !== undefined) {
        const previous = process.env.CODEX_HOME
        process.env.CODEX_HOME = dirname(codexAuth.path)
        restoreCodexHome = () => {
          if (previous === undefined) delete process.env.CODEX_HOME
          else process.env.CODEX_HOME = previous
        }
      }
      // The fixture really isolates the credential/agent roots for this Host.
      assert.equal(process.env.HOME, join(host.root, 'home'))
      assert.equal(process.env.DSH_HOME, join(host.root, 'home'))
      assert.equal(process.env.DSH_AGENTS_HOME, join(host.root, 'home', '.agents'))
      const tool = host.ctx.tools.get(task.tool) as { description?: string; parameters?: Record<string, unknown> } | undefined
      assert.ok(tool !== undefined, `${task.packageName} must install the official ${task.tool} one-shot tool`)
      assert.match(tool.description ?? '', /does not accept follow-up messages/i,
        `${task.tool} is a one-shot provider with no Continue/Resume affordance`)
      const parameters = tool.parameters ?? {}
      assert.equal(Object.hasOwn(parameters, 'resume'), false)
      assert.equal(Object.hasOwn(parameters, 'session_id'), false)
      assert.equal(Object.hasOwn(parameters, 'followup'), false)

      const agent = await host.createAgent(SessionId(`s4-d2-native-${task.provider}`), { cwd: join(host.root, 'work') })
      if (!admittedProvider) {
        // The default offline run AND a partially supplied opt-in both launch
        // no native provider at all: the gate on its own never admits one.
        assert.deepEqual(host.ctx.agents.list().map(candidate => String(candidate.id)), [String(agent.session.id)])
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
        continue
      }

      // REAL Host start under the isolated HOME. A synchronous provider failure
      // is recorded as a truthful failure; a start that returns an external
      // child is observed to its settle/failure, never assumed successful.
      const started = await host.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`s4-d2-${task.provider}-start`),
        name: task.tool,
        arguments: { description: 'read-only ping', prompt: 'Reply with exactly PONG and nothing else.' },
        agent,
      }) as { isError?: boolean; content?: readonly { type?: string; text?: string }[] }
      const startedText = (started.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
      if (started.isError === true) {
        assert.equal(startedText.includes('PONG'), false, 'a failed native start never fabricates the answer')
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
        continue
      }
      const childId = /started subagent (\S+)/u.exec(startedText)?.[1]
      assert.ok(childId !== undefined, startedText)
      const catalogEvent = (agent.session.snapshotEvents() as readonly {
        type: string
        data?: { mode?: string; childId?: string }
      }[]).find(event => event.type === 'subagent/catalog' && event.data?.childId === childId)
      assert.equal(catalogEvent?.data?.mode, 'external', 'the native child is an external one-shot')

      const settled = await observeSettle(agent, childId, 180_000)
      const events = agent.session.snapshotEvents() as readonly { type: string; data?: Record<string, unknown> }[]
      const settleText = JSON.stringify(events.filter(event => event.type === 'agent/inbox/spliced'
        && JSON.stringify(event.data).includes('subagent-settled')
        && JSON.stringify(event.data).includes(childId)))
      if (settled === undefined) {
        // There is no settle event yet; the only assertable negative is that
        // no fabricated PONG settlement exists in the parent log.
        assert.equal(settleText.includes('PONG'), false, 'no fabricated native success may appear in the parent log')
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
      } else if (settled.kind === 'success') {
        assert.match(settleText, /PONG/, 'a real native success must carry the genuine native answer')
        nativeEvidence.push({ provider: task.provider, status: 'PASS' })
      } else {
        assert.equal(settleText.includes('PONG'), false, 'a failed native start never fabricates the answer')
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
      }
      const subagents = host.ctx.subagents as {
        interrupt(id: string, authority: { kind: 'ancestor'; agent: unknown }): void
        drainDescendants(parents: readonly unknown[]): Promise<void>
      }
      try {
        subagents.interrupt(childId, { kind: 'ancestor', agent })
        await Promise.race([
          subagents.drainDescendants([agent]),
          new Promise<void>(resolve => setTimeout(resolve, 15_000)),
        ])
      } catch {
        // The provider already settled or has nothing to drain; the parent Host
        // still disposes below.
      }
      // Teardown/cleanup: an external child never turns into an in-process
      // orphan Agent in this Host composition.
      const remaining = host.ctx.agents.list().map(candidate => String(candidate.id)).filter(id => id !== String(agent.session.id))
      assert.deepEqual(remaining, [], 'no orphan in-process child remains after the native start settles')
    } finally {
      try {
        restoreCodexHome?.()
        codexAuth?.cleanup()
        await host.dispose()
      } finally {
        restoreAuthEnv?.()
      }
    }
  }
  assert.deepEqual(nativeEvidence.map(entry => entry.provider), ['claude-code', 'codex'])
  if (!NATIVE_ADMITTED) {
    assert.deepEqual(nativeEvidence.map(entry => entry.status), ['EXTERNAL_UNVERIFIED', 'EXTERNAL_UNVERIFIED'],
      'the default suite records the native gate as unverified without starting a provider')
  } else {
    const evidenceFor = (provider: string) => nativeEvidence.find(entry => entry.provider === provider)?.status
    if (B13_DEEPSEEK_KEY !== undefined) {
      assert.equal(evidenceFor('claude-code'), 'PASS',
        'the caller-supplied DeepSeek key must produce a genuine B13 native success')
    } else {
      assert.equal(evidenceFor('claude-code'), 'EXTERNAL_UNVERIFIED',
        'without an explicit B13 key no B13 native start may pass')
    }
    if (CODEX_AUTH_FILE !== undefined) {
      assert.equal(evidenceFor('codex'), 'PASS',
        'the caller-supplied native Codex auth must produce a genuine B14 native success')
    } else {
      assert.equal(evidenceFor('codex'), 'EXTERNAL_UNVERIFIED',
        'without an explicit Codex auth file no B14 native start may pass')
    }
  }
})

test('fixture restores the process environment after multiple concurrent hosts', { skip }, async t => {
  const originalHome = process.env.HOME
  const originalDsh = process.env.DSH_HOME
  const originalAgents = process.env.DSH_AGENTS_HOME
  const first = await startS4D2Host(t, { bundles: [] })
  const firstHome = process.env.HOME
  const second = await startS4D2Host(t, { bundles: [] })
  assert.notEqual(process.env.HOME, firstHome, 'the second host points the process at its own root')
  await first.dispose()
  assert.notEqual(process.env.HOME, originalHome, 'the remaining host keeps the isolated environment')
  await second.dispose()
  assert.equal(process.env.HOME, originalHome, 'the last release restores the original HOME')
  assert.equal(process.env.DSH_HOME, originalDsh, 'the last release restores the original DSH_HOME')
  assert.equal(process.env.DSH_AGENTS_HOME, originalAgents, 'the last release restores the original agents root')
})

test('fixture re-applies its own environment on restart while another host is live', { skip }, async t => {
  const originalHome = process.env.HOME
  const first = await startS4D2Host(t, { bundles: [] })
  const second = await startS4D2Host(t, { bundles: [] })
  const restarted = await first.restart()
  assert.equal(process.env.HOME, join(restarted.root, 'home'),
    'the restarted host re-applies its OWN disposable HOME')
  assert.equal(process.env.DSH_HOME, join(restarted.root, 'home'))
  await second.dispose()
  assert.equal(process.env.HOME, join(restarted.root, 'home'),
    'the live restarted host keeps its isolated environment')
  await restarted.dispose()
  assert.equal(process.env.HOME, originalHome, 'the last release restores the original HOME')
})

test('fixture rejects restart after dispose', { skip }, async t => {
  const host = await startS4D2Host(t, { bundles: [] })
  await host.dispose()
  await assert.rejects(() => host.restart(), /cannot restart a disposed host/u)
})

test('the native gate is necessary: a path/key is never read when the gate is off', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s4-d2-credential-gate-')
  const source = join(root, 'caller-auth.json')
  writeFileSync(source, '{"auth_mode":"sentinel"}')
  assert.equal(b13EnvOverlay(false, 'sentinel-key'), undefined,
    'the gate off never builds a provider env overlay')
  assert.equal(installCodexAuth(false, source, root), undefined,
    'the gate off never copies the caller credential')
  // A nonexistent path proves the gate-off branch returns BEFORE any read: a
  // read would throw ENOENT instead of returning undefined.
  const missing = join(root, 'absent-auth.json')
  assert.equal(existsSync(missing), false)
  assert.equal(installCodexAuth(false, missing, root), undefined,
    'the gate off returns before reading even a missing credential path')
  assert.equal(existsSync(join(root, 'home', '.codex', 'auth.json')), false,
    'the gate off never creates a credential copy')
  assert.equal(readFileSync(source, 'utf8'), '{"auth_mode":"sentinel"}', 'the caller file is untouched')
})

test('each native provider needs its own explicit source even with the gate on', () => {
  assert.equal(providerAdmitted(true, 'claude-code', 'explicit-key', undefined), true)
  assert.equal(providerAdmitted(true, 'codex', 'explicit-key', undefined), false,
    'the B13 key never admits the B14 native start')
  assert.equal(providerAdmitted(true, 'claude-code', undefined, '/caller/auth.json'), false,
    'the B14 auth file never admits the B13 native start')
  assert.equal(providerAdmitted(true, 'codex', undefined, '/caller/auth.json'), true)
  assert.equal(providerAdmitted(false, 'claude-code', 'explicit-key', '/caller/auth.json'), false,
    'the global gate is still required')
})

test('an admitted run scrubs ambient native auth env and restores it', (t) => {
  const values = {
    ANTHROPIC_API_KEY: 'ambient-anthropic',
    CODEX_HOME: '/ambient/codex',
    OPENAI_API_KEY: 'ambient-openai',
  } as const
  const before = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    before.set(key, process.env[key])
    process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const restore = scrubNativeAuthEnv()
  try {
    for (const key of Object.keys(values)) {
      assert.equal(process.env[key], undefined, `${key} is scrubbed for an admitted run`)
    }
  } finally {
    restore()
  }
  for (const [key, value] of Object.entries(values)) {
    assert.equal(process.env[key], value, `${key} is restored after the admitted run`)
  }
})

test('the Codex credential copy is 0600 and is removed even when temp roots are kept', (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-s4-d2-credential-copy-')
  const source = join(root, 'caller-auth.json')
  writeFileSync(source, '{"auth_mode":"sentinel"}')
  const previousKeep = process.env.DSH_TEST_KEEP_TMP
  process.env.DSH_TEST_KEEP_TMP = '1'
  t.after(() => {
    if (previousKeep === undefined) delete process.env.DSH_TEST_KEEP_TMP
    else process.env.DSH_TEST_KEEP_TMP = previousKeep
  })
  let copy: CodexAuthCopy | undefined
  try {
    copy = installCodexAuth(true, source, root)
    assert.ok(copy !== undefined)
    assert.equal(statSync(copy.path).mode & 0o777, 0o600, 'the credential copy is owner-only')
  } finally {
    // The abnormal-exit path: cleanup removes the credential even though
    // DSH_TEST_KEEP_TMP keeps the ordinary disposable root.
    copy?.cleanup()
  }
  assert.equal(existsSync(join(root, 'home', '.codex')), false,
    'the credential copy never survives a kept temp root')
})
