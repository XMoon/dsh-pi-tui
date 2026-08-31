/**
 * Vocabulary tests for the runtime backend (M1.1/M1.2): the capability list
 * is the migration's domain vocabulary, and the Direct backend is the
 * current production surface. These pin the vocabulary so a later
 * milestone cannot silently drop or rename a capability the ports depend
 * on.
 * @module @xmoon76/dsh-pi-tui/runtime-backend.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITIES, DIRECT_IMPLEMENTED_CAPABILITIES } from '../src/runtime/capability.ts'
import { createDirectBackend } from '../src/runtime/backend.ts'
import type { SubagentPort } from '../src/runtime/subagent-port.ts'

test('the capability vocabulary covers the migration domains', () => {
  assert.deepEqual(CAPABILITIES, [
    'session-read',
    'session-write',
    'session-lifecycle',
    'subagent',
    'interaction',
    'catalog',
    'config',
    'host-file',
  ])
})

test('the Direct backend is the current production surface and serves EXACTLY the implemented capabilities', () => {
  const subagent: SubagentPort = {
    followup: async () => ({ kind: 'rejected', reason: { kind: 'unavailable' } }),
  }
  const sessionReader = {
    list: async () => [],
    search: async () => [],
    titles: async () => new Map(),
    measureContext: () => undefined,
    readExportData: async () => ({ kind: 'none' as const }),
  }
  const sessionWriter = {
    followup: () => {},
    steer: async () => 'ok' as const,
    dequeue: () => {},
    cancel: () => {},
    rename: () => true,
    refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
  }
  const sessionLifecycle = {
    create: async () => ({}) as never,
    resume: async () => ({}) as never,
  }
  const interaction = {
    registerQuestionProvider: () => true,
    onApprovalRequest: () => {},
    setApprovalPolicy: () => true,
  }
  const catalog = {
    models: {
      available: () => true,
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      currentSelection: () => undefined,
      saveSelection: async () => {},
      discoverModels: async () => [],
      listConfigurableProviders: () => [],
    },
    presets: {
      available: () => false,
      list: async () => [],
      resolve: async () => ({}),
      defaultId: () => undefined,
    },
    skills: {
      standing: async () => ({ catalog: { skills: [], complete: true } }),
      listHumanSkills: async () => undefined,
      resolveSkill: async () => ({ kind: 'unavailable' as const }),
      hostLoadsSkillBody: () => false,
      onSkillsChange: () => {},
    },
  }
  const config = {
    tuiSettings: undefined,
    footerCommandTrust: {
      userFooterMode: undefined,
      command: undefined,
      userFooterLayout: undefined,
    },
    footerCustomItems: {
      get: () => ({ items: [], invalidCount: 0 }),
      rawForPersistence: () => ({ kind: 'available' as const, value: undefined }),
    },
    providers: {
      available: () => true,
      listCredentialOptions: () => [],
      writeProfile: async () => {},
      writeKeylessProfile: async () => ({ kind: 'written' as const }),
    },
    credentials: {
      available: () => true,
      setReference: async () => {},
      unsetReference: async () => {},
      deleteRecord: async () => {},
      describeReference: async () => ({ configured: false }),
      listRecords: async () => [],
      onChanged: () => () => {},
    },
    authorization: {
      available: () => false,
      listTargets: () => [],
      begin: async () => ({ kind: 'unavailable' as const }),
      onEvent: () => () => {},
      respond: async () => {},
      cancel: async () => {},
    },
    permissions: {
      presetNames: () => [],
      defaultPreset: () => undefined,
      setDefaultPreset: async () => {},
      applyPermissionPreset: async () => ({ kind: 'applied' as const }),
    },
    presetDefault: {
      available: () => true,
      get: () => undefined,
      set: async () => {},
    },
  }
  const hostFile = {
    listReferences: async () => [],
    resolveReference: async () => ({ kind: 'missing' as const }),
    canonicalizeMentions: async (_scope: unknown, text: string) => text,
  }
  const backend = createDirectBackend(subagent, sessionReader, sessionWriter, sessionLifecycle, interaction, catalog, config, hostFile)
  assert.equal(backend.kind, 'direct')
  assert.equal(backend.subagent, subagent)
  assert.equal(backend.sessionReader, sessionReader)
  assert.equal(backend.sessionWriter, sessionWriter)
  assert.equal(backend.sessionLifecycle, sessionLifecycle)
  assert.equal(backend.interaction, interaction)
  assert.equal(backend.catalog, catalog)
  assert.equal(backend.config, config)
  assert.equal(backend.hostFile, hostFile)
  // Truthful advertisement: the backend serves EXACTLY the implemented
  // ports — nothing is advertised without a port.
  for (const capability of DIRECT_IMPLEMENTED_CAPABILITIES) {
    assert.ok(backend.capabilities.has(capability), `direct serves ${capability}`)
  }
  for (const capability of CAPABILITIES) {
    if (DIRECT_IMPLEMENTED_CAPABILITIES.includes(capability)) continue
    assert.ok(!backend.capabilities.has(capability), `direct does NOT advertise ${capability} (no port yet)`)
  }
})
