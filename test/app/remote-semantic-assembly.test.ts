/**
 * M3-3A partial Remote semantic assembly tests: every closed adapter
 * constructs from ONE shared runtime source (same sessions service, same
 * Remote namespaces, same Connection generation), the bundle exposes only
 * the M3-3A surfaces, and disposal drops adapter caches ahead of the Client
 * Context.
 * @module @xmoon76/dsh-pi-tui/remote-semantic-assembly.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemoteM3ASemantics, type RemoteM3ARuntimeSource } from '../../src/app/remote/m3a-semantics.ts'
import { createObservableGenerationHarness } from '../support/remote-generation.ts'
import type { RemoteModelCatalog } from '../../src/runtime/remote/model-remote.ts'
import type { RemotePresetCatalog } from '../../src/runtime/remote/preset-remote.ts'
import type { RemoteFileReceiptUploader } from '../../src/runtime/remote/file-upload-remote.ts'
import type { PreparedFile } from '../../src/runtime/prepared-prompt.ts'

function serializer(): import('../../src/runtime/remote/session-writer-remote.ts').RemotePromptSerializer {
  return {
    preflight: () => ({ kind: 'unsupported', reason: 'test serializer' }),
    serialize: async () => ({ kind: 'unsupported', reason: 'test serializer' }),
  }
}

/** The structural receipt uploader the assembly hands the command port. */
function uploader(): RemoteFileReceiptUploader {
  return {
    upload: async (_sessionId, file) => ({
      receiptId: 'receipt-1',
      file: { attachmentId: 'attachment-1', name: file.name, bytes: file.byteLength },
    }),
  }
}

/** A small structural stand-in for the narrow one-source runtime face. The
 * official-contract gate proves the REAL `RemoteClientRuntime` satisfies the
 * same face; this fake exists to observe the wiring identities. */
function runtimeSource(): {
  source: RemoteM3ARuntimeSource
  sessions: object
  remote: object
  generation: object
  directoryPickerCalls: Array<{ readonly path: string | undefined; readonly signal: AbortSignal | undefined }>
} {
  const generation = createObservableGenerationHarness()
  const sessions = {
    list: {
      getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' as const }),
      subscribe: () => () => {},
    },
    refresh: async () => {},
    search: async () => ({ ok: true as const, value: { items: [], hasMore: false } }),
    binding: () => undefined,
    scopeOf: () => undefined,
    retain: () => { throw new Error('not needed for wiring proofs') },
    create: async () => ({ ok: true as const, value: { sessionId: 's' } }),
    fork: async () => ({ ok: true as const, value: { sessionId: 'f' } }),
  }
  const directoryPickerCalls: Array<{ readonly path: string | undefined; readonly signal: AbortSignal | undefined }> = []
  const remote = {
    // The official generated `directoryPicker` namespace (Session Workspace
    // PR1): the browse port must read through this SAME source object.
    directoryPicker: {
      list: async (path: string | undefined, signal?: AbortSignal) => {
        directoryPickerCalls.push({ path, signal })
        return {
          ok: true as const,
          value: {
            path: path ?? '/home/host-user',
            home: '/home/host-user',
            crumbs: [{ name: '/', path: '/', hidden: false }],
            entries: [{ name: 'proof', path: '/home/host-user/proof', hidden: false }],
            truncated: false,
          },
        }
      },
    },
    session: {
      modelCatalog: async () => ({ ok: true as const, value: {
        default: { provider: 'p', model: 'm' },
        routableProviders: ['p'],
        groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
        failures: [],
      } }),
      selectModel: async () => ({ ok: true as const, value: { selected: { provider: 'p', model: 'm' } } }),
      create: async () => ({ ok: true as const, value: { sessionId: 's' } }),
    },
    llm: { discoverModels: async () => ({ ok: true as const, value: [] }) },
    agentPresets: {
      list: async () => ({ ok: true as const, value: { presets: [] } }),
      select: async () => ({ ok: true as const, value: 'preset' }),
    },
    skills: { list: async () => ({ ok: true as const, value: { skills: [] } }) },
    fileReferences: { list: async () => ({ ok: true as const, value: [] }) },
    commands: { execute: async () => ({ ok: true as const, value: undefined }) },
    userQuestions: {
      attachWait: () => (async function* () { /* no frames */ })(),
      answer: async () => ({ ok: true as const, value: true }),
    },
    pluginManager: { list: async () => ({ ok: true as const, value: {} }) },
    // The official generated `workspace` namespace (WS-2): the lifecycle's ONE
    // pre-selection authority is passed through this SAME source object.
    workspace: {
      create: async () => ({
        ok: true as const,
        value: { workspace: { workspaceId: 'workspace-wiring', path: '/wiring', sessionIds: [] }, created: true },
      }),
      follow: () => ({
        [Symbol.asyncIterator]: () => (async function* () { /* no frames */ })(),
        dispose: () => {},
      }),
    },
    $on: () => () => {},
    subagents: {
      prompt: async () => ({ ok: true as const, value: { messageId: 'm' } }),
      interruptByUser: async () => ({ ok: true as const, value: {} }),
    },
  }
  return {
    sessions,
    remote,
    generation: generation.source,
    directoryPickerCalls,
    source: {
      sessions: sessions as never,
      remote: remote as never,
      jobs: { state: { getSnapshot: () => ({ rows: {}, observed: {} }), subscribe: () => () => {} } } as never,
      connection: { generation: generation.source },
    },
  }
}

test('every M3-3A adapter constructs from one shared runtime source', () => {
  const { source, sessions, remote, generation } = runtimeSource()
  const semantics = createRemoteM3ASemantics(source, { promptSerializer: serializer(), fileReceiptUploader: uploader() })
  assert.ok(semantics.sessionReader)
  assert.ok(semantics.pendingInputReader)
  assert.ok(semantics.sessionWriter)
  assert.ok(semantics.sessionLifecycle)
  assert.ok(semantics.subagent)
  assert.ok(semantics.catalog.models)
  assert.ok(semantics.catalog.presets)
  assert.ok(semantics.catalog.skills)
  assert.ok(semantics.hostFile)
  assert.ok(semantics.hostCommand)
  assert.ok(semantics.presentationReader)
  assert.ok(semantics.hostDirectoryBrowse)
  void sessions
  void remote
  void generation
})

test('the Host directory-browse port reads the SAME generated namespace and generation', async () => {
  const { source, directoryPickerCalls } = runtimeSource()
  const semantics = createRemoteM3ASemantics(source, { promptSerializer: serializer(), fileReceiptUploader: uploader() })
  const signal = new AbortController().signal
  const outcome = await semantics.hostDirectoryBrowse.list(undefined, signal)
  assert.equal(outcome.kind, 'ready')
  assert.ok(outcome.kind === 'ready')
  assert.equal(outcome.listing.home, '/home/host-user')
  assert.deepEqual(directoryPickerCalls, [{ path: undefined, signal }],
    'the port must call the ONE shared generated namespace with the caller signal')
})

test('the catalog adapters serve reads through the shared source', async () => {
  const { source } = runtimeSource()
  const semantics = createRemoteM3ASemantics(source, { promptSerializer: serializer(), fileReceiptUploader: uploader() })
  const directory = await semantics.catalog.models.loadDirectory()
  assert.deepEqual(directory.groups.map(group => group.id), ['p'])
  const skills = await semantics.catalog.skills.listHumanSkills('s')
  assert.deepEqual(skills, { skills: [], complete: true })
})

test('dispose drops the adapter caches (before the Client Context disposal)', async () => {
  const { source } = runtimeSource()
  const semantics = createRemoteM3ASemantics(source, { promptSerializer: serializer(), fileReceiptUploader: uploader() })
  await semantics.catalog.models.loadDirectory()
  assert.deepEqual(semantics.catalog.models.defaultSelection(), { provider: 'p', model: 'm' })
  semantics.dispose()
  assert.equal(semantics.catalog.models.defaultSelection(), undefined,
    'the model directory cache is dropped by the assembly disposal')
  semantics.dispose()
  ;(semantics.catalog.models as RemoteModelCatalog).disposeCache()
  ;(semantics.catalog.presets as RemotePresetCatalog).disposeCache()
})

test('the host-file adapter answers through the official session scope', async () => {
  const { source } = runtimeSource()
  const semantics = createRemoteM3ASemantics(source, { promptSerializer: serializer(), fileReceiptUploader: uploader() })
  const result = await semantics.hostFile.listReferences({ kind: 'workspace', selectionRevision: 1 }, '@a')
  assert.equal(result.kind, 'unavailable')
  const resolve = await semantics.hostFile.resolveReference({ kind: 'session', sessionId: 's' }, 'a')
  assert.equal(resolve.kind, 'unavailable')
})

test('the session reader measures context through the shared generation source', () => {
  const { source } = runtimeSource()
  const semantics = createRemoteM3ASemantics(source, { promptSerializer: serializer(), fileReceiptUploader: uploader() })
  assert.equal(semantics.sessionReader.measureContext('s'), undefined,
    'no retained binding in the stand-in — unmeasured, never invented')
  assert.equal(semantics.sessionReader.turnOutline('s'), undefined)
  assert.deepEqual(semantics.sessionReader.sessionStatus('s'), undefined)
})

test('the Host command port stages command files through the injected receipt uploader', async () => {
  const { source } = runtimeSource()
  const calls: { sessionId: string; file: PreparedFile; signal: AbortSignal }[] = []
  const receiptUploader: RemoteFileReceiptUploader = {
    upload: async (sessionId, file, signal) => {
      calls.push({ sessionId, file, signal })
      return { receiptId: 'receipt-7', file: { attachmentId: 'att-7', name: file.name, bytes: file.byteLength } }
    },
  }
  const semantics = createRemoteM3ASemantics(source, {
    promptSerializer: serializer(),
    fileReceiptUploader: receiptUploader,
  })
  const signal = new AbortController().signal
  const file: PreparedFile = {
    name: 'report.pdf',
    byteLength: 4,
    source: {
      kind: 'client-stream',
      open: async function* () { yield new Uint8Array([1, 2, 3, 4]) },
    },
  }
  assert.deepEqual(
    await semantics.hostCommand.stageFileReceipt({ sessionId: 'session-a', file, signal }),
    { receiptId: 'receipt-7' },
  )
  assert.deepEqual(calls, [{ sessionId: 'session-a', file, signal }],
    'the command port stages through the ONE injected uploader, never a second transport')
})
