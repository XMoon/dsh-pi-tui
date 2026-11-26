/**
 * Remote Ctrl+R panel composition: the REAL `createRemoteHistorySeat` owner is
 * driven through a structural `HistorySearchReadPort` and a structural
 * `RemoteHistoryOpenScope`, and the real `HistoryPanel` maps its committed
 * views into the editor-seat presentation. These cases pin the Remote page/body
 * chain (first page plus More append, exact-body readiness, action admission,
 * Retry, Directory availability and async repaint); the PiTui-only pointer
 * contract is the same one the Direct panel suite pins.
 *
 * Evidence level: L3 Remote panel composition over the real seat owner, not a
 * real Host/Gateway wire (that stays with the Host and packed lanes).
 * @module @xmoon76/dsh-pi-tui/history-panel-remote.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  createRemoteHistorySeat,
  type RemoteHistorySeat,
} from '../../src/runtime/history-search-seat.ts'
import type { RemoteHistoryDirectoryState, RemoteHistoryOpenScope } from '../../src/client/history/remote-scope.ts'
import type { HistorySearchReadPort } from '../../src/runtime/history-search-read-port.ts'
import { RemoteHistorySearchFailedError } from '../../src/runtime/remote/history-search-remote.ts'
import type {
  HistoryReadTextRequest,
  HistoryReadTextResponse,
  HistorySearchItem,
  HistorySearchRequest,
  HistorySearchResponse,
} from '../../src/runtime/remote/pi-tui-history-search-contract.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import {
  HistoryPanel,
  type HistorySeatGeometry,
} from '../../src/tui/panels/history-panel.ts'

const QUIET_DIAG: Diag = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  dispose: () => {},
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function item(id: string, preview: string, text: string, acceptedAt = 1, hasNonText = false): HistorySearchItem {
  return {
    sessionId: 'ses_a',
    messageId: id,
    firstEventSeq: 1,
    acceptedAt,
    effectiveCwd: '/srv/game',
    preview,
    contentLength: text.length,
    contentSha256: sha256(text),
    hasNonText,
  }
}

function geometry(columns: number, rows: number, chromeRows = 2): HistorySeatGeometry {
  return { columns: () => columns, rows: () => rows, chromeRows: () => chromeRows }
}

/** A structural Remote read port with controllable paging, exact text, failure
 *  injection and a hold gate for one async request. */
class FakeReadPort implements HistorySearchReadPort {
  readonly searchCalls: HistorySearchRequest[] = []
  readonly readCalls: HistoryReadTextRequest[] = []
  items: HistorySearchItem[] = []
  pageSize = 2
  generation = 'gen-1'
  /** The next N search calls reject like a typed Host failure. */
  failures = 0
  /** Hold the next search call until `releaseSearch()` is called. */
  holdSearch = false
  /** Hold the next exact-text read until `releaseRead()` is called. */
  holdRead = false
  /** The next N exact-text reads reject like a typed Host failure. */
  failReads = 0
  /** The next N searches answer Host `loading`. */
  loadingSearches = 0
  private pendingSearch: (() => void) | undefined
  private pendingRead: (() => void) | undefined
  private readonly texts = new Map<string, string>()

  seed(items: readonly HistorySearchItem[], texts: ReadonlyMap<string, string>): void {
    this.items = [...items]
    for (const [key, value] of texts) this.texts.set(key, value)
  }

  async search(request: HistorySearchRequest, signal: AbortSignal): Promise<HistorySearchResponse> {
    this.searchCalls.push(request)
    if (this.holdSearch) {
      this.holdSearch = false
      await new Promise<void>((resolve) => { this.pendingSearch = resolve })
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (this.loadingSearches > 0) {
      this.loadingSearches -= 1
      return { kind: 'loading' }
    }
    if (this.failures > 0) {
      this.failures -= 1
      throw new RemoteHistorySearchFailedError(undefined, 'host search unavailable')
    }
    const offset = request.cursor === undefined ? 0 : Number(request.cursor.slice('cursor-'.length))
    const next = offset + this.pageSize
    return {
      kind: 'ready',
      generation: this.generation,
      items: this.items.slice(offset, next),
      nextCursor: next < this.items.length ? `cursor-${String(next)}` : null,
    }
  }

  async readText(request: HistoryReadTextRequest, signal: AbortSignal): Promise<HistoryReadTextResponse> {
    this.readCalls.push(request)
    if (this.holdRead) {
      this.holdRead = false
      await new Promise<void>((resolve) => { this.pendingRead = resolve })
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (this.failReads > 0) {
      this.failReads -= 1
      throw new RemoteHistorySearchFailedError(undefined, 'host text unavailable')
    }
    const text = this.texts.get(`${request.sessionId}\u0000${request.messageId}`)
    if (text === undefined) return { kind: 'unavailable', reason: 'not-found' }
    const chunk = text.slice(request.offset, request.offset + request.limit)
    const nextOffset = request.offset + chunk.length < text.length ? request.offset + chunk.length : null
    return { kind: 'ready', chunk, nextOffset, contentLength: text.length }
  }

  releaseSearch(): void {
    const release = this.pendingSearch
    this.pendingSearch = undefined
    release?.()
  }

  releaseRead(): void {
    const release = this.pendingRead
    this.pendingRead = undefined
    release?.()
  }
}

/** A structural per-open Host scope: availability and currentness are
 *  controllable, and the seat observes the same subscription the host wires. */
class FakeOpenScope implements RemoteHistoryOpenScope {
  readonly initialScope: 'session' | 'all'
  private directoryState: RemoteHistoryDirectoryState
  private disposed = false
  private current = true
  private readonly listeners = new Set<() => void>()

  constructor(initialScope: 'session' | 'all', directory: RemoteHistoryDirectoryState) {
    this.initialScope = initialScope
    this.directoryState = directory
  }

  directory(): RemoteHistoryDirectoryState {
    return this.directoryState
  }

  isCurrent(): boolean {
    return !this.disposed && this.current
  }

  setCurrent(current: boolean): void {
    this.current = current
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

interface Harness {
  panel: HistoryPanel
  seat: RemoteHistorySeat
  port: FakeReadPort
  scope: FakeOpenScope
  copied: string[]
  accepted: Array<{ id: string; content: string }>
  closed: number
  resultsChanged: number
}

interface HarnessOptions {
  items: Array<{
    id: string
    preview: string
    text: string
    acceptedAt?: number
    hasNonText?: boolean
    cwd?: string | null
  }>
  defaultScope: 'session' | 'all'
  sessionId?: string
  directory?: RemoteHistoryDirectoryState
  pointerEnabled?: () => boolean
  tenantIsCurrent?: () => boolean
  columns?: number
  rows?: number
  initialQuery?: string
}

function makeHarness(options: HarnessOptions): Harness {
  const port = new FakeReadPort()
  const items = options.items.map((entry) => {
    const base = item(entry.id, entry.preview, entry.text, entry.acceptedAt ?? 1, entry.hasNonText === true)
    return entry.cwd === undefined ? base : { ...base, effectiveCwd: entry.cwd }
  })
  port.seed(items, new Map(options.items.map(entry => [`ses_a\u0000${entry.id}`, entry.text])))
  const scope = new FakeOpenScope(options.defaultScope, options.directory ?? { available: false, reason: 'directory-unavailable' })
  const seat = createRemoteHistorySeat({
    read: port,
    diag: QUIET_DIAG,
    sessionId: options.sessionId,
    scope,
    onRetire: () => {},
    debounceMs: 1,
  })
  const copied: string[] = []
  const accepted: Array<{ id: string; content: string }> = []
  const harness: Harness = {
    panel: undefined as unknown as HistoryPanel,
    seat,
    port,
    scope,
    copied,
    accepted,
    closed: 0,
    resultsChanged: 0,
  }
  harness.panel = new HistoryPanel({
    remote: seat,
    defaultScope: options.defaultScope,
    cwd: '/client/cwd',
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    geometry: geometry(options.columns ?? 120, options.rows ?? 40),
    pointerEnabled: options.pointerEnabled ?? (() => false),
    tenantIsCurrent: options.tenantIsCurrent ?? (() => scope.isCurrent()),
    ...(options.initialQuery === undefined ? {} : { initialQuery: options.initialQuery }),
    onAccept: (selection) => { accepted.push(selection) },
    onCopy: (text) => { copied.push(text) },
    onClose: () => { harness.closed += 1 },
    onResultsChanged: () => { harness.resultsChanged += 1 },
  })
  return harness
}

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
const plain = (lines: readonly string[]): string[] => lines.map(stripAnsi)

/** The Results/Preview divider row (the D15 seat boundary rules are the first
 *  and last rows). */
const internalDividerRow = (lines: readonly string[]): number =>
  lines.findIndex((line, index) => index > 0 && index < lines.length - 1 && /^─+$/u.test(line.trim()))

/** Wait for a PAINTED frame (never a raw sleep), bounded by a failure deadline. */
async function renderUntil(
  panel: HistoryPanel,
  width: number,
  predicate: (lines: string[]) => boolean,
  label: string,
  timeoutMs = 3_000,
): Promise<string[]> {
  const start = Date.now()
  for (;;) {
    const lines = plain(panel.render(width))
    if (predicate(lines)) return lines
    if (Date.now() - start > timeoutMs) {
      assert.fail(`${label}: the Remote panel never reached its committed frame:\n${lines.join('\n')}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
}

function pointer(
  type: 'press' | 'click',
  x: number,
  y: number,
  width: number,
  height: number,
): import('@xmoon76/pi-tui').TuiMouseEvent {
  return {
    type, button: 'left', x, y, screenX: x, screenY: y, width, height,
    shift: false, alt: false, ctrl: false,
  }
}

/** The result labels painted in the LIST region (above the divider). */
function paintedListLabels(lines: readonly string[]): string[] {
  const divider = internalDividerRow(lines)
  const region = divider < 0 ? lines : lines.slice(0, divider)
  return region
    .filter(line => line.startsWith('> ') || line.startsWith('  '))
    .map(line => line.replace(/^ {0,2}/u, '').trim())
}

// ── first page + More append ────────────────────────────────────────────────

test('first page then More appends every older row once and keeps the selected identity', async () => {
  const harness = makeHarness({
    items: [
      { id: 'a', preview: 'alpha prompt', text: 'alpha prompt' },
      { id: 'b', preview: 'beta prompt', text: 'beta prompt' },
      { id: 'c', preview: 'gamma prompt', text: 'gamma prompt' },
      { id: 'd', preview: 'delta prompt', text: 'delta prompt' },
    ],
    defaultScope: 'all',
  })
  const { panel, port, seat } = harness
  panel.start()
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 2 shown')), 'the first page')

  // The panel asked the seat for the default scope/query once; the seat owns
  // the exact request (limit 25) and the page.
  assert.equal(port.searchCalls.length, 1)
  assert.deepEqual(port.searchCalls[0], { scope: 'all', query: '', limit: 25 })

  // Down moves to the last LOADED row; a second Down asks for the next page
  // instead of wrapping.
  panel.handleInput('\x1b[B')
  assert.equal(panel.selected()?.id, 'ses_a\u0000b')
  // Down still WRAPS on the loaded tail; only PgDn asks for More.
  panel.handleInput('\x1b[B')
  assert.equal(panel.selected()?.id, 'ses_a\u0000a', 'Down wraps to the first row')
  panel.handleInput('\x1b[B')
  assert.equal(panel.selected()?.id, 'ses_a\u0000b')
  // Wait for the selected row's exact body to become the CURRENT painted frame:
  // the More admission re-checks the last-painted generation.
  await renderUntil(
    panel,
    120,
    lines => lines.some(line => line.includes('Preview') && line.includes('Alt+C copy')),
    'the exact body for the selected row',
  )
  panel.handleInput('\x1b[6~')
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 4 shown')), 'the appended page')

  assert.equal(port.searchCalls.length, 2)
  assert.equal(port.searchCalls[1]?.cursor, 'cursor-2')
  assert.equal(panel.selected()?.id, 'ses_a\u0000b', 'More keeps the selected identity')
  const labels = paintedListLabels(plain(panel.render(120)))
  for (const label of ['alpha prompt', 'beta prompt', 'gamma prompt', 'delta prompt']) {
    assert.equal(labels.filter(entry => entry.includes(label)).length, 1, `${label} appears exactly once: ${labels.join(' | ')}`)
  }
  assert.ok(plain(panel.render(120)).some(line => line.startsWith('> ') && line.includes('beta prompt')),
    'the selected row stays painted')
  assert.equal(seat.view().hasMore, false, 'the exhausted page paints no More')
  assert.ok(!plain(panel.render(120)).some(line => line.includes('More · PgDn')),
    'More disappears on the last page')
})

test('the painted More button loads the next page through the same seat action', async () => {
  const harness = makeHarness({
    items: [
      { id: 'a', preview: 'alpha prompt', text: 'alpha prompt' },
      { id: 'b', preview: 'beta prompt', text: 'beta prompt' },
      { id: 'c', preview: 'gamma prompt', text: 'gamma prompt' },
    ],
    defaultScope: 'all',
    pointerEnabled: () => true,
    columns: 120,
    rows: 40,
  })
  const { panel, port } = harness
  panel.start()
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 2 shown')), 'the first page')
  // Wait for the selected row's body/settle so the pressed frame is current.
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Copy All [Alt+C]')), 'the exact body')
  const frame = plain(panel.render(120))
  const height = panel.render(120).length
  const footerRow = frame.findLastIndex(line => line.includes('Cancel [Esc]'))
  const moreCol = frame[footerRow]?.indexOf('More · PgDn') ?? -1
  assert.ok(footerRow >= 0 && moreCol >= 0, `the More footer span must paint:\n${frame.join('\n')}`)
  assert.ok(panel.handleMouse(pointer('press', moreCol, footerRow, 120, height)) !== undefined)
  assert.ok(panel.handleMouse(pointer('click', moreCol, footerRow, 120, height)) !== undefined)
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 3 shown')), 'the appended page')
  assert.equal(port.searchCalls.length, 2, 'the pointer More started exactly one page request')
  assert.equal(port.searchCalls[1]?.cursor, 'cursor-2')
})

test('a narrow Remote footer keeps More visible', async () => {
  const harness = makeHarness({
    items: [
      { id: 'a', preview: 'alpha prompt', text: 'alpha prompt' },
      { id: 'b', preview: 'beta prompt', text: 'beta prompt' },
      { id: 'c', preview: 'gamma prompt', text: 'gamma prompt' },
    ],
    defaultScope: 'all',
    columns: 44,
    rows: 20,
  })
  harness.panel.start()
  const lines = await renderUntil(harness.panel, 44,
    frame => frame.some(line => line.includes('Results · 2 shown')) && frame.some(line => line.includes('More · PgDn')),
    'the narrow footer with More')
  assert.ok(lines.some(line => line.includes('More · PgDn')), lines.join('\n'))
  assert.ok(lines.some(line => line.includes('Esc cancel')), 'Cancel stays painted with More')
})

// ── preview -> exact body ───────────────────────────────────────────────────

test('a bounded preview becomes the hash-verified exact body; Copy/Restore refuse until then', async () => {
  const exactText = '  Exact full text\nsecond line 中文 with trailing spaces  '
  const harness = makeHarness({
    items: [{ id: 'm1', preview: '  Exact full text…', text: exactText, acceptedAt: 1, hasNonText: true }],
    defaultScope: 'session',
    sessionId: 'ses_a',
    pointerEnabled: () => true,
    columns: 120,
    rows: 40,
  })
  const { panel, port, copied } = harness
  port.holdRead = true
  panel.start()
  const loading = await renderUntil(
    panel,
    120,
    lines => lines.some(line => line.includes('Loading full text…')),
    'the bounded preview while the exact body is in flight',
  )
  assert.ok(loading.some(line => line.includes('  Exact full text…')), 'the bounded preview is readable')
  assert.ok(!loading.some(line => line.includes('Copy All [Alt+C]')), 'Copy is not advertised before the exact body')
  assert.ok(!loading.some(line => line.includes('Use Selected [Enter]')), 'Restore is not advertised before the exact body')
  assert.equal(panel.canAccept(), false, 'Enter/Restore is refused before the exact body')
  panel.handleInput('\x1bc') // Alt+C
  panel.handleInput('\r') // Enter
  assert.deepEqual(copied, [], 'Copy never sends the bounded preview')
  assert.deepEqual(harness.accepted, [], 'Restore never sends the bounded preview')
  // The bounded preview is readable but not a drag-copy target.
  const loadingPreviewRow = loading.findIndex(line => line.includes('Preview')) + 1
  assert.equal(
    panel.handleMouse(pointer('press', 0, loadingPreviewRow, 120, panel.render(120).length)),
    undefined,
    'a Preview drag is refused before the exact body',
  )

  port.releaseRead()
  const ready = await renderUntil(
    panel,
    120,
    lines => lines.some(line => line.includes('Copy All [Alt+C]') && line.includes('Use Selected [Enter]')),
    'the verified exact body',
  )
  assert.ok(!ready.some(line => line.includes('Loading full text…')), 'the loading marker is gone once exact')
  assert.ok(ready.some(line => line.includes('Text only')), 'a hasNonText body states the text-only restore contract')
  assert.equal(panel.selected()?.content, exactText, 'the Preview source IS the exact verified text')

  panel.handleInput('\x1bc') // Alt+C
  assert.deepEqual(copied, [exactText], 'Copy All sends exactly body.text, never the preview')
  panel.handleInput('\r') // Enter
  assert.deepEqual(harness.accepted, [{ id: 'ses_a\u0000m1', content: exactText }],
    'Restore sends exactly body.text with the row identity')
  assert.equal(harness.closed, 0, 'copy/restore admission keeps its own seat lifecycle')
})

test('a same-open transport loss refuses a painted Copy and Restore', async () => {
  const exactText = 'exact body that must not be restored after loss'
  const harness = makeHarness({
    items: [{ id: 'a', preview: 'exact body…', text: exactText }],
    defaultScope: 'all',
    pointerEnabled: () => true,
  })
  const { panel, scope, copied, accepted } = harness
  panel.start()
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Copy All [Alt+C]')),
    'the verified exact body')
  assert.equal(panel.canAccept(), true)
  scope.setCurrent(false)
  assert.equal(panel.canAccept(), false, 'the painted Restore refuses after the transport token changed')
  panel.handleInput('\x1bc')
  panel.handleInput('\r')
  assert.deepEqual(copied, [], 'the painted Copy sends nothing')
  assert.deepEqual(accepted, [], 'the painted Restore sends nothing')
})

test('a ready empty body offers no action and states why', async () => {
  const harness = makeHarness({
    items: [{ id: 'empty', preview: 'preview only', text: '', cwd: null }],
    defaultScope: 'all',
  })
  harness.panel.start()
  const lines = await renderUntil(
    harness.panel,
    120,
    frame => frame.some(line => line.includes('No text to restore')),
    'the empty exact body',
  )
  assert.ok(!lines.some(line => line.includes('Copy All [Alt+C]')), 'an empty body paints no Copy action')
  assert.ok(lines.some(line => line.includes('Directory: Unknown')), 'an unproven event-time cwd is stated, never guessed')
  harness.panel.handleInput('\x1bc')
  assert.deepEqual(harness.copied, [], 'an empty body copies nothing')
})

// ── failure + Retry ─────────────────────────────────────────────────────────

test('a failed Host search offers Retry from the pointer and from PageDown', async () => {
  const harness = makeHarness({
    items: [
      { id: 'a', preview: 'alpha prompt', text: 'alpha prompt' },
      { id: 'b', preview: 'beta prompt', text: 'beta prompt' },
    ],
    defaultScope: 'all',
    pointerEnabled: () => true,
    columns: 120,
    rows: 40,
  })
  const { panel, port } = harness
  port.failures = 2
  panel.start()
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('History request failed')),
    'the first failed page')
  assert.ok(plain(panel.render(120)).some(line => line.includes('Retry · PgDn')), 'the failure paints the Retry action')
  assert.equal(panel.canAccept(), false, 'a failed page accepts nothing')

  // Pointer Retry: press and click the SAME painted action. The second search
  // also fails, so the failure state is still the committed state.
  const frame = plain(panel.render(120))
  const height = panel.render(120).length
  const footerRow = frame.findLastIndex(line => line.includes('Cancel [Esc]'))
  const retryCol = frame[footerRow]?.indexOf('Retry · PgDn') ?? -1
  assert.ok(footerRow >= 0 && retryCol >= 0, `the Retry footer span must paint:\n${frame.join('\n')}`)
  assert.ok(panel.handleMouse(pointer('press', retryCol, footerRow, 120, height)) !== undefined)
  assert.ok(panel.handleMouse(pointer('click', retryCol, footerRow, 120, height)) !== undefined)
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('History request failed')),
    'the second failed page')
  assert.equal(port.searchCalls.length, 2, 'the pointer Retry started exactly one new search')

  // Keyboard Retry: Down on a rowless failure page.
  const failed = plain(panel.render(120))
  assert.ok(failed.some(line => line.includes('History request failed')))
  panel.handleInput('\x1b[6~')
  const recovered = await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 2 shown')),
    'the recovered first page')
  assert.equal(port.searchCalls.length, 3, 'PageDown Retry started exactly one new search')
  assert.ok(!recovered.some(line => line.includes('History request failed')), 'the recovered page clears the failure message')
  assert.ok(recovered.some(line => line.startsWith('> ') && line.includes('alpha prompt')))
})

test('a Host-loading page offers PageDown Retry', async () => {
  const harness = makeHarness({ items: [{ id: 'a', preview: 'alpha', text: 'alpha' }], defaultScope: 'all' })
  const { panel, port } = harness
  port.loadingSearches = 1
  panel.start()
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('History is loading on Host')),
    'the Host-loading state')
  assert.ok(plain(panel.render(120)).some(line => line.includes('Retry · PgDn')),
    'the loading page paints the Retry action')
  panel.handleInput('\x1b[6~')
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 1 shown')),
    'the recovered page')
  assert.equal(port.searchCalls.length, 2, 'PageDown retried the Host-loading page exactly once')
})

// ── in-flight More / stale action admission ─────────────────────────────────

test('a More-loading seat disables actions; a stale More click and repeated PageDown start no request', async () => {
  const harness = makeHarness({
    items: [
      { id: 'a', preview: 'alpha prompt', text: 'alpha prompt' },
      { id: 'b', preview: 'beta prompt', text: 'beta prompt' },
      { id: 'c', preview: 'gamma prompt', text: 'gamma prompt' },
      { id: 'd', preview: 'delta prompt', text: 'delta prompt' },
    ],
    defaultScope: 'all',
    pointerEnabled: () => true,
    columns: 120,
    rows: 40,
  })
  const { panel, port, seat } = harness
  panel.start()
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 2 shown')), 'the first page')
  panel.handleInput('\x1b[B') // select the last loaded row
  await renderUntil(
    panel,
    120,
    lines => lines.some(line => line.includes('Preview') && line.includes('Copy All [Alt+C]')),
    'the exact body of the last loaded row',
  )
  port.holdSearch = true

  // Arm the painted More span, then let the seat start the page WITHOUT a
  // repaint: the pressed frame is now stale while its cells still say More.
  const frame = plain(panel.render(120))
  const height = panel.render(120).length
  const footerRow = frame.findLastIndex(line => line.includes('Cancel [Esc]'))
  const moreCol = frame[footerRow]?.indexOf('More · PgDn') ?? -1
  assert.ok(footerRow >= 0 && moreCol >= 0, `the More footer span must paint:\n${frame.join('\n')}`)
  assert.ok(panel.handleMouse(pointer('press', moreCol, footerRow, 120, height)) !== undefined)
  seat.more()
  assert.equal(port.searchCalls.length, 2, 'the seat started the page')
  assert.equal(panel.handleMouse(pointer('click', moreCol, footerRow, 120, height)), undefined,
    'a More click against the pre-loading frame does nothing')

  // More is in flight: no action is advertised or admitted.
  const loading = await renderUntil(panel, 120, lines => lines.some(line => line.includes('Loading more…')), 'the more-loading state')
  assert.ok(!loading.some(line => line.includes('More · PgDn')), 'More disappears while its page is in flight')
  assert.ok(!loading.some(line => line.includes('Copy All [Alt+C]')), 'Copy is not advertised while More is in flight')
  assert.ok(!loading.some(line => line.includes('Use Selected [Enter]')), 'Restore is not advertised while More is in flight')
  assert.equal(panel.canAccept(), false, 'More-loading disables Restore')
  panel.handleInput('\x1bc')
  panel.handleInput('\r')
  assert.deepEqual(harness.copied, [], 'More-loading refuses Copy All')
  assert.deepEqual(harness.accepted, [], 'More-loading refuses Restore')
  panel.handleInput('\x1b[6~')
  assert.equal(port.searchCalls.length, 2, 'repeated PageDown during More-loading starts no second request')

  port.releaseSearch()
  const appended = await renderUntil(panel, 120, lines => lines.some(line => line.includes('Results · 4 shown')), 'the appended page')
  assert.equal(port.searchCalls.length, 2, 'the released page appended once')
  assert.equal(panel.selected()?.id, 'ses_a\u0000b', 'More preserves the selection through the in-flight state')
  assert.ok(appended.some(line => line.startsWith('> ') && line.includes('beta prompt')))
  assert.equal(new Set(paintedListLabels(appended)).size, 4, `no duplicate/lost rows: ${paintedListLabels(appended).join(' | ')}`)
})

// ── scope availability ──────────────────────────────────────────────────────

test('Directory unavailable at open is omitted from the tabs and the cycle', async () => {
  const harness = makeHarness({
    items: [{ id: 'a', preview: 'alpha prompt', text: 'alpha prompt' }],
    defaultScope: 'all',
  })
  const { panel, port } = harness
  panel.start()
  const lines = await renderUntil(panel, 120, frame => frame.some(line => line.includes('alpha prompt')), 'the sessionless page')
  const header = lines.find(line => line.includes('Input History'))
  assert.ok(header !== undefined, `the header must paint:\n${lines.join('\n')}`)
  assert.ok(header.includes('[All Directories]'), header)
  assert.ok(!header.includes('Current Directory') && !header.includes('[Directory]'),
    'no Directory tab without a proven Host path')
  assert.ok(!header.includes('Session'), 'a sessionless open paints no Session tab')
  panel.handleInput('\t')
  panel.render(120)
  assert.equal(port.searchCalls.length, 1, 'Tab on a one-scope ring starts no search')
  assert.ok(port.searchCalls.every(call => call.scope === 'all'), 'Directory is never requested without proof')
})

test('an available Directory joins the Session/All ring while a sessionless open lacks both', async () => {
  const harness = makeHarness({
    items: [{ id: 'a', preview: 'alpha prompt', text: 'alpha prompt' }],
    defaultScope: 'session',
    sessionId: 'ses_a',
    directory: { available: true, cwd: '/srv/game' },
  })
  const { panel, port } = harness
  panel.start()
  const first = await renderUntil(panel, 120, frame => frame.some(line => line.includes('alpha prompt')), 'the session page')
  const header = first.find(line => line.includes('Input History'))
  assert.ok(header?.includes('[Current Session]'), header)
  assert.ok(header?.includes('Current Directory'), 'the proven Directory is offered')
  panel.handleInput('\t')
  await renderUntil(panel, 120, frame => frame.some(line => line.includes('Scope: directory')), 'the Directory scope')
  assert.equal(port.searchCalls.at(-1)?.scope, 'directory')
  assert.equal((port.searchCalls.at(-1) as { cwd?: string }).cwd, '/srv/game')
  panel.handleInput('\t')
  await renderUntil(panel, 120, frame => frame.some(line => line.includes('Scope: all')), 'the All scope')
  panel.handleInput('\t')
  await renderUntil(panel, 120, frame => frame.some(line => line.includes('Scope: session')), 'the Session scope')
})

// ── async commit repaint ────────────────────────────────────────────────────

test('an async seat page repaints the panel without further input', async () => {
  const harness = makeHarness({
    items: [{ id: 'a', preview: 'async alpha', text: 'async alpha' }],
    defaultScope: 'all',
    initialQuery: 'async',
  })
  const { panel, port } = harness
  port.holdSearch = true
  panel.start()
  assert.equal(port.searchCalls[0]?.query, 'async', 'the initial query is handed to the one seat')
  const searching = plain(panel.render(120))
  assert.ok(searching.some(line => line.includes('Searching…')), searching.join('\n'))
  const before = harness.resultsChanged
  port.releaseSearch()
  const committed = await renderUntil(panel, 120, lines => lines.some(line => line.includes('async alpha')), 'the async page')
  assert.ok(harness.resultsChanged > before, 'the async completion asks the host to repaint')
  assert.ok(committed.some(line => line.includes('Results · 1 shown')))
})

// ── host-provided currentness only ──────────────────────────────────────────

test('a host predicate that turns stale refuses actions without closing the panel', async () => {
  let current = true
  const harness = makeHarness({
    items: [{ id: 'a', preview: 'alpha prompt', text: 'alpha prompt' }],
    defaultScope: 'all',
    pointerEnabled: () => true,
    tenantIsCurrent: () => current,
  })
  const { panel } = harness
  panel.start()
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('alpha prompt')), 'the live page')
  const before = plain(panel.render(120))
  assert.ok(before.some(line => line.includes('Copy All [Alt+C]')))
  current = false
  assert.equal(panel.canAccept(), false)
  panel.handleInput('\r')
  panel.handleInput('\x1bc')
  assert.deepEqual(harness.copied, [], 'a stale subject copies nothing')
  assert.deepEqual(harness.accepted, [], 'a stale subject restores nothing')
  assert.equal(harness.closed, 0, 'the host owns the seat lifecycle; the panel never closes itself')
})

// ── exact-body failure ──────────────────────────────────────────────────────

test('a failed exact-text read keeps the bounded preview and offers Retry', async () => {
  const exactText = 'verified text after retry'
  const harness = makeHarness({
    items: [{ id: 'm1', preview: 'bounded preview', text: exactText }],
    defaultScope: 'all',
    pointerEnabled: () => true,
    columns: 120,
    rows: 40,
  })
  const { panel, port } = harness
  port.failReads = 2
  panel.start()
  const failed = await renderUntil(panel, 120, lines => lines.some(line => line.includes('History text failed')),
    'the body failure')
  assert.ok(failed.some(line => line.includes('bounded preview')), 'the bounded preview stays readable')
  assert.ok(failed.some(line => line.includes('Retry · PgDn')), 'the body failure offers Retry')
  assert.equal(panel.canAccept(), false, 'a failed body accepts nothing')
  panel.handleInput('\x1bc')
  panel.handleInput('\r')
  assert.deepEqual(harness.copied, [], 'a failed body copies nothing')
  assert.deepEqual(harness.accepted, [], 'a failed body restores nothing')

  const frame = plain(panel.render(120))
  const height = panel.render(120).length
  const footerRow = frame.findLastIndex(line => line.includes('Cancel [Esc]'))
  const retryCol = frame[footerRow]?.indexOf('Retry · PgDn') ?? -1
  assert.ok(footerRow >= 0 && retryCol >= 0, `the Retry footer span must paint:\n${frame.join('\n')}`)
  assert.ok(panel.handleMouse(pointer('press', retryCol, footerRow, 120, height)) !== undefined)
  assert.ok(panel.handleMouse(pointer('click', retryCol, footerRow, 120, height)) !== undefined)
  await renderUntil(panel, 120, lines => lines.some(line => line.includes('History text failed')),
    'the second failed body')
  assert.equal(port.searchCalls.length, 2, 'the pointer body Retry started exactly one new page')

  // The same failure state is retryable from the keyboard via PiTui PgDn.
  panel.handleInput('\x1b[6~')
  const recovered = await renderUntil(panel, 120,
    lines => lines.some(line => line.includes('Copy All [Alt+C]')), 'the recovered exact body')
  assert.equal(port.searchCalls.length, 3, 'PageDown body Retry started exactly one new page')
  assert.equal(panel.selected()?.content, exactText)
  assert.ok(!recovered.some(line => line.includes('History text failed')))
})

// ── construction invariant ──────────────────────────────────────────────────

test('the panel requires exactly one of a Direct source and a Remote seat', () => {
  assert.throws(() => new HistoryPanel({
    cwd: '/work/a',
    onAccept: () => {},
    onClose: () => {},
  }), /exactly one of source\/remote/u)
  const harness = makeHarness({ items: [], defaultScope: 'all' })
  assert.throws(() => new HistoryPanel({
    remote: harness.seat,
    source: { search: async () => ({ results: [], exhausted: true }) },
    cwd: '/work/a',
    onAccept: () => {},
    onClose: () => {},
  }), /exactly one of source\/remote/u)
})
