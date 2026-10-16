/** Test-only controlled SessionReader routed through the production TSP Browser Presenter. */
import { appendFileSync } from 'node:fs'
import { connect, type Key, type Node, type ScrollTo, type TspEvent } from '@stencil-hq/tern'
import { createSessionBrowserReadOwner } from '../src/app/command/session-browser-read.ts'
import type { SessionScope } from '../src/app/session/scope.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import type {
  SessionBrowserPanelHandle,
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
} from '../src/app/command/session-browser-presentation.ts'
import type { SessionContentSearchPage, SessionProjectionSummary, SessionReader, SessionSummary } from '../src/runtime/session-reader-port.ts'
import { TspSessionBrowser } from '../src/tui/tsp/session-browser.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)

const longTitle = `Needle long session title ${'with readable wrapping and unicode 資料 🚀 '.repeat(14)}`
const longExcerpt = `The Host-selected excerpt starts away from the matched text. ${'Tail-bound evidence remains readable. '.repeat(75)}END-OF-DETAILS-TAIL`
const currentId = 'session-current'
const longId = 'session-long'
const contentId = 'session-content'

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
    parentSession: currentId,
    live: false,
  },
  ...Array.from({ length: 52 }, (_, index): SessionSummary => ({
    id: `session-row-${String(index).padStart(2, '0')}`,
    updatedAt: 9_800 - index,
    createdAt: 800 - index,
    cwd: '/workspace/project',
    parentSession: index === 0 ? longId : `session-row-${String(index - 1).padStart(2, '0')}`,
    live: false,
  })),
  {
    id: contentId,
    updatedAt: 8_000,
    createdAt: 700,
    cwd: '/workspace/other',
    parentSession: longId,
    live: false,
  },
]

const projections = new Map<string, SessionProjectionSummary>([
  [currentId, { title: 'Fix API timeout', preset: 'reviewer' }],
  [longId, { title: longTitle, preset: 'reviewer' }],
  [contentId, { title: 'A title without the search term', preset: 'writer' }],
])

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
    layout: props['layout'],
    size: props['size'],
    query: props['query'],
    scope: props['scope'],
    state: props['state'],
    message: props['message'],
    empty: props['empty'],
    total: props['total'],
    selected: props['selected'],
    current: props['current'],
    focus: props['focus'],
    scopes: props['scopes'],
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
})

const observedPresentation: SessionBrowserPresentation = {
  open: (request: SessionBrowserPanelRequest): SessionBrowserPanelHandle => {
    const handle = browser.presentation.open(request)
    return {
      isDisposed: () => handle.isDisposed(),
      setSnapshot: (snapshot: SessionBrowserReadSnapshot) => {
        latestSnapshot = snapshot
        handle.setSnapshot(snapshot)
      },
      close: () => handle.close(),
    }
  },
  notify: (message, kind) => browser.presentation.notify(message, kind),
}

const diag = createDiag({ stderrLevel: 'off' })
// This controlled read fixture never switches sessions; Direct L6 is covered by
// test/tern-tsp-session-browser-commands.test.ts with the real runtime scope.
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
  onResumeIntent: (intent) => note({ resumeIntent: intent }),
})

const readHandle = owner.open()
note({ ready: true })
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
  note({ closed: true })
  readHandle.close()
  owner.dispose()
  browser.retire()
  diag.dispose()
  await surface.close({ keep: false })
  await session.close()
}
