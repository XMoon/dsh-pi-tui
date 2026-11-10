/** Test-only controlled SessionReader routed through the production TSP Browser Presenter. */
import { appendFileSync } from 'node:fs'
import { connect, type Key, type Node, type ScrollTo, type TspEvent } from '@stencil-hq/tern'
import { createSessionBrowserReadOwner } from '../src/app/command/session-browser-read.ts'
import type { SessionScope } from '../src/app/session/scope.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type {
  SessionBrowserDirectorySettlement,
  SessionBrowserPanelHandle,
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
} from '../src/app/command/session-browser-presentation.ts'
import type { SessionContentSearchPage, SessionProjectionSummary, SessionReader, SessionSummary } from '../src/runtime/session-reader-port.ts'
import type {
  SessionWorkspaceFact,
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
} from '../src/runtime/session-workspace-facts-port.ts'
import { TspSessionBrowser } from '../src/tui/tsp/session-browser.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)

const longTitle = `Needle long session title ${'with readable wrapping and unicode 資料 🚀 '.repeat(14)}`
const longExcerpt = `The Host-selected excerpt starts away from the matched text. ${'Tail-bound evidence remains readable. '.repeat(75)}END-OF-DETAILS-TAIL`
const currentId = 'session-current'
const longId = 'session-long'
const contentId = 'session-content'
const migrationId = 'session-migration'
const currentWorkspaceId = 'ws-current'
const otherWorkspaceId = 'ws-other'
const padded = (index: number): string => String(index).padStart(2, '0')
const currentHistoryIds = Array.from({ length: 8 }, (_, index) => `session-row-${padded(index)}`)
const otherHistoryIds = Array.from({ length: 12 }, (_, index) => `session-other-${padded(index)}`)

// Two OFFICIAL Workspaces: the current Session lives in ws-current (so its
// folder is the Current folder and starts expanded), the other Workspace owns
// twelve ordinary history rows (so the non-current five-row watermark and the
// incremental Show more batch are both real). The Host-only content hit lives
// in ws-other but only Host content search finds it: no metadata field carries
// the literal query.
const mainRows: SessionSummary[] = [
  {
    id: currentId,
    updatedAt: 10_000,
    createdAt: 1_000,
    cwd: '/workspace/project',
    live: true,
    preset: 'reviewer',
  },
  {
    id: longId,
    updatedAt: 9_900,
    createdAt: 900,
    cwd: '/workspace/project',
    live: false,
    preset: 'reviewer',
  },
  {
    // The Host-authoritative on-disk format state the Browser renders read-only.
    id: migrationId,
    updatedAt: 9_850,
    createdAt: 650,
    cwd: '/workspace/project',
    live: false,
    formatStatus: 'migration-required',
  },
  ...currentHistoryIds.map((id, index): SessionSummary => ({
    id,
    updatedAt: 9_800 - index * 10,
    createdAt: 800 - index,
    cwd: '/workspace/project',
    live: false,
  })),
  ...otherHistoryIds.map((id, index): SessionSummary => ({
    id,
    updatedAt: 9_000 - index * 10,
    createdAt: 500 - index,
    cwd: '/workspace/other',
    live: false,
  })),
  {
    // Only Host CONTENT search finds this Session: its title, id, workspace and
    // preset carry no literal query, and it sorts below the tree watermark so the
    // Folder tree never lists it. The global Cards view still must.
    id: contentId,
    updatedAt: 7_000,
    createdAt: 700,
    cwd: '/workspace/other',
    live: false,
    preset: 'writer',
  },
]

const projections = new Map<string, SessionProjectionSummary>([
  [currentId, { title: 'Fix API timeout', preset: 'reviewer' }],
  [longId, { title: longTitle, preset: 'reviewer' }],
  [contentId, { title: 'A title without the search term', preset: 'writer' }],
  [migrationId, { title: 'Legacy record', preset: 'reviewer' }],
])

const workspaceFacts: readonly SessionWorkspaceFact[] = [
  {
    workspaceId: currentWorkspaceId,
    path: '/workspace/project',
    title: 'Project',
    sessionIds: [currentId, longId, migrationId, ...currentHistoryIds],
  },
  {
    workspaceId: otherWorkspaceId,
    path: '/workspace/other',
    title: 'Other',
    sessionIds: [...otherHistoryIds, contentId],
  },
]

const read: SessionReader = {
  list: async (sessionId) => {
    note({ read: { method: 'list', sessionId, rows: mainRows.length } })
    return mainRows.map((row) => ({ ...row }))
  },
  projectionBatch: async (rows, signal) => {
    signal?.throwIfAborted()
    note({ read: { method: 'projectionBatch', ids: rows.map((row) => row.id) } })
    return new Map(rows.flatMap((row) => {
      const value = projections.get(row.id)
      return value === undefined ? [] : [[row.id, value] as const]
    }))
  },
  search: async (query, signal) => {
    signal?.throwIfAborted()
    note({ read: { method: 'search', query } })
    if (query !== 'needle') return { items: [], hasMore: false }
    const page: SessionContentSearchPage = {
      items: [
        { sessionId: contentId, snippet: 'Truncated Host excerpt with no literal query token; this is still an authorized content hit.' },
        { sessionId: longId, snippet: longExcerpt },
      ],
      hasMore: true,
    }
    return page
  },
  blank: () => undefined,
  measureContext: () => undefined,
  turnOutline: () => undefined,
  sessionStatus: () => undefined,
}

const sessionWorkspaceFacts: SessionWorkspaceFactsPort = {
  readActivity: async () => [],
  followWorkspaces: (signal): WorkspaceFactsHandle => ({
    dispose() {},
    async *[Symbol.asyncIterator]() {
      const baseline: WorkspaceFactsFrame = { type: 'baseline', items: workspaceFacts }
      note({ workspace: { baseline: workspaceFacts } })
      yield baseline
      if (signal?.aborted === true) return
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
    },
  }),
}

function findNode(root: Node | undefined, predicate: (node: Node) => boolean): Node | undefined {
  if (root === undefined) return undefined
  if (predicate(root)) return root
  for (const child of root.children) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

function nodeKey(node: Node | undefined): string | undefined {
  const key = node?.props?.['key']
  return typeof key === 'string' ? key : undefined
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => typeof part === 'string'
    ? part
    : typeof part === 'object' && part !== null && 't' in part && typeof part.t === 'string'
      ? part.t
      : '').join('')
}

function describe(layer: Node | undefined, snapshot: SessionBrowserReadSnapshot | undefined, frame: number) {
  const picker = findNode(layer, (node) => node.kind === 'picker')
  const overlay = findNode(layer, (node) => node.kind === 'overlay')
  const body = findNode(layer, (node) => {
    const key = node.props?.['key']
    return typeof key === 'string' && key.startsWith('session-browser-details-body-')
  })
  const props = (picker?.props ?? {}) as Record<string, unknown>
  return {
    n: frame,
    page: overlay === undefined ? picker === undefined ? 'closed' : 'browse' : 'details',
    pickerKey: nodeKey(picker),
    readerBodyKey: nodeKey(body),
    title: props['title'],
    subtitle: props['subtitle'],
    placeholder: props['placeholder'],
    layout: props['layout'],
    size: props['size'],
    query: props['query'],
    cursor: props['cursor'],
    state: props['state'],
    message: props['message'],
    empty: props['empty'],
    total: props['total'],
    selected: props['selected'],
    current: props['current'],
    focus: props['focus'],
    actions: props['actions'],
    items: props['items'],
    texts: (() => {
      const entries: Array<{ key: string | undefined; text: string }> = []
      const visit = (node: Node | undefined): void => {
        if (node === undefined) return
        if (node.kind === 'text') {
          entries.push({
            key: nodeKey(node),
            text: textContent(node.props?.['text'] ?? node.props?.['spans']),
          })
        }
        // A negotiated Reader paints a group's facts as KV PAIRS, not text nodes, so
        // the observer reads them from the PROPS of the same node the client drew:
        // each pair becomes one record addressed by its own grid node and its `k`.
        // This is an observation change only — the component still carries every fact
        // exactly once, and no hidden text node is added to satisfy an old extractor.
        if (node.kind === 'kv') {
          const items = node.props?.['items']
          if (Array.isArray(items)) {
            for (const item of items as readonly Record<string, unknown>[]) {
              entries.push({
                key: `${nodeKey(node)}:${textContent(item['k'])}`,
                text: textContent(item['v']),
              })
            }
          }
        }
        for (const child of node.children) visit(child)
      }
      visit(layer)
      return entries
    })(),
    read: snapshot === undefined ? undefined : {
      listState: snapshot.listState,
      searchState: snapshot.searchState,
      hasMore: snapshot.hasMore,
      rows: snapshot.rows.length,
    },
  }
}

const session = await connect({ app: 'tern-pane-session-browser-read', timeout: 2_000 })
if (session === null) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'session-browser-read' })
note({ caps: session.caps, surfaceId: surface.id })

let browser!: TspSessionBrowser
let latestSnapshot: SessionBrowserReadSnapshot | undefined
let frame = 0

const draw = (): void => {
  const layer = browser.renderLayer()
  // Match the production TSP session composition: the presenter's layer is the region root.
  surface.render({ layer })
  frame += 1
  note({ frame: describe(layer, latestSnapshot, frame) })
}

browser = new TspSessionBrowser({
  surfaceId: surface.id,
  render: draw,
  canInteract: () => true,
  notify: (message, kind) => note({ notice: { message, kind } }),
  nativeScroll: (id: string, to: ScrollTo) => {
    note({ nativeScroll: { id, to } })
    surface.scroll(id, to)
  },
  scrollSupported: session.caps.features.includes('scroll'),
  // The REAL negotiated kind set of THIS pane (never a forced `true`): the
  // recorded frames show the exact Reader this client's handshake earns.
  nativeKv: session.caps.kinds.includes('kv'),
})

const observedPresentation: SessionBrowserPresentation = {
  open: (request: SessionBrowserPanelRequest): SessionBrowserPanelHandle => {
    const handle = browser.presentation.open(request)
    return {
      isDisposed: () => handle.isDisposed(),
      setSnapshot: (snapshot: SessionBrowserReadSnapshot, options) => {
        latestSnapshot = snapshot
        handle.setSnapshot(snapshot, options)
      },
      close: () => handle.close(),
    }
  },
  notify: (message, kind) => browser.presentation.notify(message, kind),
}

// The controlled Host directory-resolution owner: the FIRST submission is
// refused after a settle delay (so the lane can prove single-flight fencing),
// the retry succeeds with a canonical Host path. Every submitted path and every
// settlement is recorded, so the lane reads the real wire, not a re-creation.
const submittedPaths: string[] = []
let addAttempt = 0
const addDirectory = (path: string, settle: (outcome: SessionBrowserDirectorySettlement) => void): void => {
  addAttempt += 1
  const attempt = addAttempt
  submittedPaths.push(path)
  note({ addDirectory: { path, attempt } })
  const outcome: SessionBrowserDirectorySettlement = attempt === 1
    ? { kind: 'failed', message: 'Host refused the directory: no workspace at this path.' }
    : { kind: 'registered', workspaceId: 'ws-added', path: '/host/canonical' }
  setTimeout(() => {
    note({ addDirectorySettlement: { path, attempt, outcome } })
    settle(outcome)
  }, 1_200)
}

const diag = createDiag({ stderrLevel: 'off' })
// This controlled read fixture never switches sessions; Direct L6 is covered by
// test/runtime/direct/tern-tsp-session-browser-commands.test.ts with the real runtime scope.
const readOnlyScope = { sessionId: currentId } as unknown as SessionScope
const owner = createSessionBrowserReadOwner({
  reader: read,
  presentation: observedPresentation,
  captureSubject: () => ({
    scope: readOnlyScope,
    subject: {
      currentSessionId: currentId,
      currentCwd: '/workspace/project',
      isCurrent: () => true,
    },
  }),
  diag,
  sessionId: () => currentId,
  sessionWorkspaceFacts,
  onAddDirectory: addDirectory,
  onResumeIntent: (intent) => note({ resumeIntent: intent }),
})

const readHandle = owner.open()
note({ ready: true, submittedPaths })
console.error('session-browser read subject ready')

try {
  for await (const input of session) {
    if (input.type === 'key') {
      const key: Key = input.key
      if (key.name === 'f10') break
      note({ key: key.name ?? key.text ?? '?' })
      browser.handleKey(key)
      continue
    }
    const event = input.event as TspEvent
    note({ event: {
      ev: event.ev,
      sf: 'sf' in event ? event.sf : undefined,
      id: 'id' in event ? event.id : undefined,
      item: 'item' in event ? event.item : undefined,
      act: 'act' in event ? event.act : undefined,
      value: 'value' in event ? event.value : undefined,
      message: 'msg' in event ? event.msg : undefined,
    } })
    if (event.ev === 'resize') draw()
    else {
      const handled = browser.handleEvent(event)
      note({ eventAdmission: {
        ev: event.ev,
        sf: 'sf' in event ? event.sf : undefined,
        surfaceId: surface.id,
        id: 'id' in event ? event.id : undefined,
        handled,
        message: 'msg' in event ? event.msg : undefined,
      } })
    }
  }
} finally {
  note({ closed: true, submittedPaths })
  readHandle.close()
  owner.dispose()
  browser.retire()
  diag.dispose()
  await surface.close({ keep: false })
  await session.close()
}
