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
import { CAPABILITIES, DIRECT_IMPLEMENTED_CAPABILITIES } from '../../src/runtime/capability.ts'
import { createDirectBackend } from '../../src/runtime/backend.ts'
import type { SubagentPort } from '../../src/runtime/subagent-port.ts'
import type { PendingInputReader } from '../../src/runtime/pending-input-reader-port.ts'

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
    'session-archive',
    'host-command',
    'plugin-manager',
    'job-observation',
  ])
})

test('the Direct backend is the current production surface and serves EXACTLY the implemented capabilities', () => {
  const subagent: SubagentPort = {
    prompt: async () => ({ kind: 'rejected', reason: { kind: 'unavailable' } }),
    interrupt: async () => ({ kind: 'committed' }),
  }
  const sessionReader = {
    list: async () => [],
    search: async () => ({ items: [], hasMore: false }),
    projectionBatch: async () => new Map(),
    blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
  }
  const pendingInputReader: PendingInputReader = {
    snapshot: () => ({ running: false, items: [] }),
  }
  const sessionWriter = {
    prompt: async () => ({ kind: 'committed' as const, value: undefined }),
    updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
    cancel: async () => ({ kind: 'committed' as const, value: undefined }),
    rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
    refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
  }
  const sessionLifecycle = {
    resolveWorkspace: async () => ({}) as never,
    create: async () => ({}) as never,
    open: async () => ({}) as never,
    fork: async () => ({}) as never,
  }
  const interaction = {
    questions: {
      onRequest: () => true,
      subscribe: () => undefined,
      snapshot: () => undefined,
      claimTimedWait: async () => undefined,
      answerContinued: async () => 'not-continued' as const,
    },
    onApprovalRequest: () => {},
    }
  const catalog = {
    models: {
      available: () => true,
      loadDirectory: async () => ({ default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] }),
      listProviders: () => [],
      listModels: async () => [],
      defaultSelection: () => undefined,
      saveDefaultSelection: async () => ({ kind: 'committed' as const, value: undefined }),
      sessionSelection: () => undefined,
      selectSessionModel: async () => ({ ownership: 'current' as const, outcome: { kind: 'committed' as const, value: { provider: '', model: '' } } }),
      discoverModels: async () => [],
      listConfigurableProviders: () => [],
    },
    presets: {
      available: () => false,
      roster: async () => ({ presets: [] }),
      resolve: async () => ({}),
      defaultId: () => undefined,
      selectSessionPreset: async () => ({ ownership: 'current' as const, outcome: { kind: 'committed' as const, value: { preset: '' } } }),
    },
    skills: {
      standing: async () => ({ catalog: { skills: [], complete: true } }),
      listHumanSkills: async () => undefined,
      resolveSkill: async () => ({ kind: 'unavailable' as const }),
      hostLoadsSkillBody: () => false,
      onSkillsChange: () => () => {},
    },
  }
  const config = {
    configReadiness: () => 'ready' as const,
    hasUnsettledWrites: () => false,
    tuiSettings: undefined,
    footerCommandTrust: {
      userFooterMode: undefined,
      command: undefined,
      userCommandItemActivationIds: new Set<string>(),
      userCommandItemFallbackActivationIds: new Set<string>(),
    },
    footerCustomItems: {
      get: () => ({ items: [], invalidCount: 0 }),
      rawForPersistence: () => ({ kind: 'available' as const, value: undefined }),
    },
    providers: {
      available: () => true,
      listCredentialOptions: () => [],
      readCatalog: () => ({ options: [], profiles: [] }),
      readProfile: (route: string) => ({ route, configured: false, models: [] }),
      configGuide: () => ({}),
      writeProfile: async () => {},
      writeKeylessProfile: async () => ({ kind: 'written' as const }),
    },
    account: {
      available: () => false,
      isObservationCurrent: () => false,
      getState: async () => { throw new Error('account unavailable') },
      getProfile: async () => null,
      getBalance: async () => null,
      watch: async function* () {},
      getCallbackOrigin: () => undefined,
      startSignIn: async () => { throw new Error('account unavailable') },
      cancelSignIn: async () => { throw new Error('account unavailable') },
      signOut: async () => { throw new Error('account unavailable') },
      hasRunningAccountTasks: async () => false,
    },
    credentials: {
      recordsSupported: () => true,
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
      refreshTargets: async () => {},
      targetsState: () => 'unavailable' as const,
      begin: async () => ({ kind: 'unavailable' as const }),
      onEvent: () => () => {},
      respond: async () => {},
      cancel: async () => {},
    },
    permissions: {
      approvalOverrideAvailable: () => true,
      presetNames: () => [],
      defaultPreset: () => undefined,
      setDefaultPreset: async () => {},
      approvalOverrideOf: () => undefined,
      applyPermissionPreset: async () => ({ kind: 'applied' as const }),
    },
    subagentModelSelection: {
      available: () => false,
      get: () => ({ enabled: false, allowedModels: [] }),
      set: async () => {},
    },
    presetDefault: {
      available: () => true,
      get: () => undefined,
      set: async () => {},
    },
    web: {
      available: () => false,
      read: async () => undefined,
      setSearchProvider: async () => {},
      setFetchProvider: async () => {},
      setSearchApiCount: async () => {},
      setSendOriginalQuestion: async () => {},
      setSearchBilling: async () => {},
      setFetchBilling: async () => {},
    },
    visualTools: {
      read: () => undefined,
      setEnabled: async (_enabled: boolean, _revision: number) => {},
    },
    webStartupPreference: {
      read: () => undefined,
      setAutoStart: async (_value: boolean, _revision: number) => {},
    },
    backendStartupPreference: {
      read: () => undefined,
      setBackend: async (_value: 'direct' | 'daemon', _revision: number) => {},
    },
    acpStartupPreference: {
      read: () => undefined,
      setAutoStart: async (_value: boolean, _revision: number) => {},
    },
  }
  const hostFile = {
    listReferences: async () => ({ kind: 'ok' as const, items: [] }),
    resolveReference: async () => ({ kind: 'missing' as const }),
    canonicalizeMentions: async (_scope: unknown, text: string) => text,
  }
  const sessionArchive = {
    open: async () => ({ kind: 'unavailable' as const }),
  }
  const sessionMarkdown: import('../../src/runtime/session-markdown-port.ts').SessionMarkdownPort = {
    read: async () => ({ kind: 'unavailable' as const }),
  }
  const hostCommand = {
    stageFileReceipt: async () => ({ receiptId: 'receipt-stub' }),
    execute: async () => ({ kind: 'committed' as const, matched: false as const }),
  }
  const pluginManager = {
    snapshot: async () => ({
      bundles: [],
      plugins: [],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
    inspect: async () => ({ status: 'refused' as const, problem: 'unknown', reason: 'test' }),
    setBundleEnabled: async () => ({ changed: false, application: 'applied' as const, stage: 'enable' as const, target: '' }),
    setPluginEnabled: async () => ({ changed: false, application: 'applied' as const, stage: 'enable' as const, target: '' }),
    removeBundle: async () => ({ changed: false, application: 'applied' as const, stage: 'remove' as const, target: '' }),
    startInstall: async () => ({ changed: false, application: 'applied' as const, stage: 'install' as const, target: '' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' as const }),
    subscribeInstall: () => () => {},
    listVersions: async () => ({ status: 'refused' as const, problem: 'not-updatable' as const, reason: 'the fixture has no updatable bundle', attempts: [] }),
    updateBundle: async () => { throw new Error('updateBundle is not used by this fixture') },
    subscribeUpdate: () => () => {},
    subscribeInvalidation: () => () => {},
  }
  const jobObservation = {
    open: () => () => {},
    stop: async () => ({ kind: 'requested' as const }),
  }
  const hostUserShell: import('../../src/runtime/host-user-shell-port.ts').HostUserShellPort = {
    availability: { supported: true, policies: ['bypass'] },
    execute: async () => ({ kind: 'unavailable', reason: { reason: 'policy-unavailable', message: 'stub' } }),
  }
  const deliveredFileRead: import('../../src/runtime/deliverables-port.ts').DeliveredFileReadPort = {
    stat: async () => ({ version: 'v1' }),
    read: async () => ({ stat: { version: 'v1' }, offset: 1, limit: 1, text: '', lines: 0, eof: true }),
  }
  const webAccess: import('../../src/runtime/web-access-port.ts').WebAccessPort = {
    getStatus: async () => ({ state: 'unavailable', reason: 'test' }),
    setEnabled: async () => ({ state: 'unavailable', reason: 'test' }),
    getAuthenticatedUrl: async () => { throw new Error('test') },
  }
  const acpAccess: import('../../src/runtime/acp-access-port.ts').AcpAccessPort = {
    getStatus: async () => ({ state: 'unavailable', reason: 'test' }),
    setEnabled: async () => ({ state: 'unavailable', reason: 'test' }),
    currentGeneration: () => undefined,
    subscribeGeneration: () => () => {},
  }
  const sessionWorkspaceFacts: import('../../src/runtime/session-workspace-facts-port.ts').SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    followWorkspaces: () => {
      throw new Error('the fixture never follows Workspaces')
    },
  }
  const schedule: import('../../src/runtime/schedule-port.ts').SchedulePort = {
    catalog: async () => [],
    list: async () => ({ items: [], shown: 0, total: 0, limit: 100, offset: 0 }),
    view: async request => ({ id: request.id, code: 'schedule_not_found' as const }),
    history: async request => ({ id: request.id, code: 'delivery_cursor_not_found' as const }),
    deliveryLimits: async () => ({ newSessionIntervalSeconds: 60 }),
    create: async () => { throw new Error('the fixture never creates a task') },
    edit: async () => { throw new Error('the fixture never edits a task') },
    run: async () => { throw new Error('the fixture never runs a task') },
    deleteInactive: async () => ({ deleted: 0 }),
    onChanged: () => () => {},
  }
  const hostDirectoryBrowse: import('../../src/runtime/host-directory-browse-port.ts').HostDirectoryBrowsePort = {
    list: async () => ({ kind: 'unavailable' as const, reason: 'the fixture never browses the Host', code: 'directory-picker/unavailable' }),
  }
  // M6-1 F8: the exact-Session policy port (fail-closed fixture).
  const sessionPolicy: import('../../src/runtime/session-policy-port.ts').SessionPolicyPort = {
    read: async sessionId => ({ kind: 'unavailable', sessionId, reason: 'session-not-live' }),
    setApproval: async () => ({ kind: 'refused', reason: 'session-not-live' }),
  }
  // FR1: the exact-Root Team mode port (fail-closed fixture).
  const teamMode: import('../../src/runtime/team-mode-port.ts').TeamModePort = {
    read: () => ({ kind: 'unavailable', reason: 'no live Team authority in this fixture' }),
    subscribe: () => () => {},
    setEnabled: async () => ({ kind: 'rejected', reason: 'no live Team authority in this fixture' }),
  }
  // S5-PR3, M5-U-A, S5-PR4 and Session Workspace PR1 add FOUR independent
  // required ports: the official Session Markdown read, the UI-neutral
  // read-authority facts, the Host Schedule management surface and the
  // read-only Host directory browse. All stay wired and asserted below; none
  // replaces another.
  const backend = createDirectBackend(subagent, sessionReader, pendingInputReader, sessionWriter, sessionLifecycle, interaction, catalog, config, hostFile, sessionArchive, sessionMarkdown, hostCommand, pluginManager, jobObservation, hostUserShell, { pathAuthority: 'client', complete: async () => ({ kind: 'ok', candidates: [] }) }, deliveredFileRead, webAccess, acpAccess, sessionWorkspaceFacts, schedule, hostDirectoryBrowse, sessionPolicy, teamMode)
  assert.equal(backend.kind, 'direct')
  assert.equal(backend.subagent, subagent)
  assert.equal(backend.sessionReader, sessionReader)
  assert.equal(backend.pendingInputReader, pendingInputReader)
  assert.equal(backend.sessionWriter, sessionWriter)
  assert.equal(backend.sessionLifecycle, sessionLifecycle)
  assert.equal(backend.interaction, interaction)
  assert.equal(backend.catalog, catalog)
  assert.equal(backend.config, config)
  assert.equal(backend.hostFile, hostFile)
  assert.equal(backend.sessionArchive, sessionArchive)
  assert.equal(backend.sessionMarkdown, sessionMarkdown)
  assert.equal(backend.hostCommand, hostCommand)
  assert.equal(backend.pluginManager, pluginManager)
  assert.equal(backend.jobObservation, jobObservation)
  assert.equal(backend.sessionWorkspaceFacts, sessionWorkspaceFacts)
  assert.equal(backend.schedule, schedule)
  assert.equal(backend.hostDirectoryBrowse, hostDirectoryBrowse)
  assert.equal(backend.teamMode, teamMode)
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
