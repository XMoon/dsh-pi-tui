/**
 * L6 headless tests for the Image UX PR2 transcript integration: the
 * fullscreen info-row `[-]`/`[+]` control folds ONE occurrence, a click on the
 * visible image body opens the read-only Viewer (and never rebuilds the
 * transcript), and a Tool card's image body no longer folds the card.
 *
 * The pointer path is REAL: the test drives SGR mouse press/release through
 * `VirtualTerminal` into the alt screen's `onCellPress`/`onCellClick`, resolves
 * the same last-painted snapshot the production path uses, and asserts the
 * painted frame plus the focused overlay. No handler is called directly.
 * @module @xmoon76/dsh-pi-tui/transcript-image-viewer-tui.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { createToolResultMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const IMAGE_REF = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 33,
  width: 800,
  height: 100,
  name: 'shot.png',
}

const IMAGE_REF_2 = {
  attachmentId: 'att-2',
  mediaType: 'image/png',
  bytes: 33,
  width: 800,
  height: 100,
  name: 'second.png',
}

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function startApp(loader?: ImageLoader): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const resolvedLoader = loader ?? new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: resolvedLoader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

/** Wait for the loader settle + the repaint, then return the viewport text. */
async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** 1-based row of the Nth line containing the needle. */
function rowOfNth(text: string, needle: string, n: number): number {
  let seen = 0
  const index = text.split('\n').findIndex(line => {
    if (!line.includes(needle)) return false
    if (seen === n) return true
    seen += 1
    return false
  })
  return index === -1 ? -1 : index + 1
}

/**
 * The 1-based cell of the RIGHT-EDGE info control (`[-]` / `[+]`) painted on a
 * viewport row, or fails. The control is ASCII and right-aligned, so its exact
 * column is taken from the printed row (ANSI-aware), never recomputed.
 */
function controlCell(line: string): number {
  const index = line.includes('[-]')
    ? line.indexOf('[-]')
    : line.indexOf('[+]')
  assert.ok(index !== -1, `no info control on the row: ${JSON.stringify(line)}`)
  // Center cell of the 3-cell control: 0-based start + 1 → 1-based +1.
  return visibleWidth(line.slice(0, index)) + 2
}

async function clickControl(vt: VirtualTerminal, needle: string, nth = 0): Promise<number> {
  const view = await viewport(vt)
  const row = rowOfNth(view, needle, nth)
  assert.ok(row !== -1, `missing ${needle} #${nth + 1}:\n${view}`)
  const line = view.split('\n')[row - 1]!
  const cell = controlCell(line)
  vt.sendInput(`\x1b[<0;${cell};${row}M`)
  vt.sendInput(`\x1b[<0;${cell};${row}m`)
  await settleClick(vt)
  return row
}

async function clickCell(vt: VirtualTerminal, x: number, row: number): Promise<void> {
  vt.sendInput(`\x1b[<0;${x};${row}M`)
  vt.sendInput(`\x1b[<0;${x};${row}m`)
  await settleClick(vt)
}

/**
 * Wait out the alt screen's DOUBLE_CLICK window before the next pointer cell.
 *
 * The fork treats a fast repeat at the same cell as a double click (word
 * selection), so two consecutive disclosure clicks on one cell need the window
 * to elapse first; this is the contract under test, not a blind sleep. The
 * bound is the fork's own `DOUBLE_CLICK_INTERVAL_MS` (500) with one frame of
 * slack.
 */
async function settleClick(vt: VirtualTerminal): Promise<void> {
  // The bounded window IS the contract (fork DOUBLE_CLICK_INTERVAL_MS = 500).
  await new Promise(resolve => setTimeout(resolve, 600))
  await vt.waitForRender()
}

function userMessage(content: unknown[], seq: number): never {
  return { type: 'user/message', seq, time: seq, data: { content, source: { kind: 'user' } } } as never
}

test('the info control folds only its own occurrence; the body opens the Viewer and Esc returns', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    userMessage([
      { type: 'text', text: 'both' },
      { type: 'image', attachment: IMAGE_REF },
      { type: 'text', text: 'and' },
      { type: 'image', attachment: IMAGE_REF_2 },
    ], 1),
    userMessage([{ type: 'text', text: 'NEXT' }], 2),
  ])
  app.setTranscript(folder.messages())
  const before = await viewport(vt)
  const renderBefore = app.transcriptPresentationDiagnosticsForTest()
  assert.ok(before.includes('🖼️ shot.png · 800×100 · 33 B'), `first info bar painted:\n${before}`)
  assert.ok(before.includes('[-]'), `the expanded info control is painted:\n${before}`)
  // Fold the FIRST occurrence through its right-edge control: NEXT moves UP.
  const nextBefore = rowOfNth(before, 'NEXT', 0)
  await clickControl(vt, '🖼️ shot.png · 800×100', 0)
  const afterFold = await viewport(vt)
  const nextFolded = rowOfNth(afterFold, 'NEXT', 0)
  assert.ok(nextFolded > 0 && nextFolded < nextBefore, `the first occurrence folded:\n${afterFold}`)
  assert.ok(afterFold.includes('[+]'), `the collapsed occurrence advertises [+]:\n${afterFold}`)
  assert.ok(afterFold.includes('🖼️ second.png · 800×100'), 'the second occurrence stays mounted')
  // A click on the SECOND occurrence's body row opens the Viewer; it must not
  // fold anything.
  const secondInfo = rowOfNth(afterFold, '🖼️ second.png · 800×100', 0)
  await clickCell(vt, 4, secondInfo + 1)
  const opened = await viewport(vt)
  assert.ok(opened.includes('Image · second.png'), `the Viewer names the clicked occurrence:\n${opened}`)
  assert.ok(opened.includes('Esc close'), `the Viewer advertises Esc close:\n${opened}`)
  assert.ok(opened.includes('800×100 · image/png · 33 B'), `the Viewer shows the metadata row:\n${opened}`)
  // Esc closes the Viewer (one layer): the transcript is back, still folded.
  vt.sendInput('\x1b')
  const closed = await viewport(vt)
  assert.ok(!closed.includes('Image · second.png'), `Esc closed the Viewer:\n${closed}`)
  assert.equal(rowOfNth(closed, 'NEXT', 0), nextFolded, 'the transcript layout is untouched by the Viewer')
  assert.ok(closed.includes('[+]'), 'the folded occurrence stayed folded across the Viewer round trip')
  // The Viewer is presentation only: opening/closing it never rebuilds the
  // transcript (the leased screen stops/restores it untouched).
  const renderAfter = app.transcriptPresentationDiagnosticsForTest()
  assert.equal(renderAfter.structuralCommits, renderBefore.structuralCommits, 'no structural rebuild for the Viewer')
  assert.equal(renderAfter.contentCommits, renderBefore.contentCommits, 'no content rebuild for the Viewer')
  assert.equal(renderAfter.structuralFallbacks, renderBefore.structuralFallbacks, 'no structural fallback for the Viewer')
  app.setFullscreen(false)
  app.stop()
})

test('the info metadata columns are inert: no fold, no Viewer, no card disclosure', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    userMessage([
      { type: 'text', text: 'inert' },
      { type: 'image', attachment: IMAGE_REF },
    ], 1),
    userMessage([{ type: 'text', text: 'NEXT' }], 2),
  ])
  app.setTranscript(folder.messages())
  const before = await viewport(vt)
  const nextBefore = rowOfNth(before, 'NEXT', 0)
  assert.ok(nextBefore > 0, `the message is painted:\n${before}`)
  const infoRow = rowOfNth(before, '🖼️ shot.png · 800×100', 0)
  assert.ok(infoRow > 0, `the info row is painted:\n${before}`)
  const infoLine = before.split('\n')[infoRow - 1]!
  assert.ok(infoLine.includes('[-]'), `the control is painted on this row:\n${infoLine}`)
  const diagnosticsBefore = app.transcriptPresentationDiagnosticsForTest()
  // The identity text's first cell — well LEFT of the right-edge 3-cell
  // control — is read-only: it must fold nothing, open no Viewer and never
  // fall through to the card/message disclosure ladder.
  await clickCell(vt, 2, infoRow)
  const afterMetaClick = await viewport(vt)
  const diagnostics = app.transcriptPresentationDiagnosticsForTest()
  assert.ok(!afterMetaClick.includes('Image · shot.png'), `the metadata click opens no Viewer:\n${afterMetaClick}`)
  assert.ok(afterMetaClick.includes('[-]'), `the occurrence did not fold (the control still reads [-]):\n${afterMetaClick}`)
  assert.equal(rowOfNth(afterMetaClick, 'NEXT', 0), nextBefore, `the layout is unchanged by the inert click:\n${afterMetaClick}`)
  assert.equal(diagnostics.structuralCommits, diagnosticsBefore.structuralCommits,
    'an inert metadata click performs no structural rebuild')
  // Control: the RIGHT-EDGE span of the SAME row still folds the occurrence,
  // so the inert result above is the column policy and not a dead row.
  await clickControl(vt, '🖼️ shot.png · 800×100', 0)
  const folded = await viewport(vt)
  assert.ok(folded.includes('[+]'), `the same row's control still folds:\n${folded}`)
  assert.ok(rowOfNth(folded, 'NEXT', 0) < nextBefore, 'the control click really collapsed the image body')
  app.setFullscreen(false)
  app.stop()
})

test('a tool-card image body opens the Viewer without folding the card; a non-image row still folds it', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'call-1', name: 'screenshot_tool', arguments: [] } } as never,
    {
      type: 'tool/result',
      seq: 2,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: createToolResultMessage({
          callId: ToolCallId('call-1'),
          content: [
            { type: 'text', text: 'caption' },
            { type: 'image', attachment: IMAGE_REF },
          ] as unknown as ContentBlock[],
          isError: false,
        }),
      },
    } as never,
  ])
  app.setTranscript(folder.messages())
  // Expand the card through its header click.
  const header = rowOfNth(await viewport(vt), 'screenshot_tool', 0)
  await clickCell(vt, 4, header)
  const expanded = await viewport(vt)
  assert.ok(expanded.includes('caption'), `the card body is expanded:\n${expanded}`)
  assert.ok(expanded.includes('🖼️ shot.png · 800×100 · 33 B'), `the tool image is mounted:\n${expanded}`)
  // The image BODY opens the Viewer; the card must stay expanded.
  const imageRow = rowOfNth(expanded, '🖼️ shot.png · 800×100', 0)
  await clickCell(vt, 4, imageRow + 1)
  const opened = await viewport(vt)
  assert.ok(opened.includes('Image · shot.png'), `the tool image body opens the Viewer:\n${opened}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const back = await viewport(vt)
  assert.ok(back.includes('caption'), `the card stayed expanded under the Viewer:\n${back}`)
  assert.ok(back.includes('🖼️ shot.png'), 'the tool image is still mounted')
  // A NON-image card row keeps the card disclosure: the caption row folds it.
  const captionRow = rowOfNth(back, 'caption', 0)
  await clickCell(vt, 4, captionRow)
  const folded = await viewport(vt)
  assert.ok(!folded.includes('🖼️ shot.png · 800×100'), `the caption row folded the card:\n${folded}`)
  app.setFullscreen(false)
  app.stop()
})

test('the info control press cannot transfer to another occurrence after an async image growth', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const pending: Array<() => void> = []
  const loader = new ImageLoader((ref) => ref.attachmentId === IMAGE_REF.attachmentId
    ? new Promise(resolve => { pending.push(() => resolve({ ref: {}, data: pngBytes() })) })
    : Promise.resolve({ ref: {}, data: pngBytes() }))
  const { vt, app } = startApp(loader)
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    userMessage([
      { type: 'text', text: 'both' },
      { type: 'image', attachment: IMAGE_REF },
      { type: 'image', attachment: IMAGE_REF_2 },
    ], 1),
  ])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const loading = await viewport(vt)
  // Both images are still loading: press B's info CONTROL (no release).
  const bRow = rowOfNth(loading, '🖼️ second.png · 800×100', 0)
  const bCell = controlCell(loading.split('\n')[bRow - 1]!)
  vt.sendInput(`\x1b[<0;${bCell};${bRow}M`)
  await vt.waitForRender()
  // A loads and grows: B's rows move down, the old cell no longer belongs to B.
  const settled = new Promise<void>(resolve => {
    const unsubscribe = loader.subscribe(IMAGE_REF.attachmentId, () => { unsubscribe(); resolve() })
  })
  pending[0]!()
  await settled
  app.requestRender()
  await vt.waitForRender()
  const grown = await viewport(vt)
  assert.ok(rowOfNth(grown, '🖼️ second.png · 800×100', 0) > bRow, `A's growth pushed B down:\n${grown}`)
  // Release on the OLD cell: nothing may be folded.
  vt.sendInput(`\x1b[<0;${bCell};${bRow}m`)
  await vt.waitForRender()
  const collapsed = (app as unknown as { collapsedOccurrences: Map<unknown, Set<number>> }).collapsedOccurrences
  assert.equal(collapsed.size, 0, `the stale control press must not fold an occurrence:\n${vt.getViewport().join('\n')}`)
  app.stop()
})

test('a Question modal refuses the image body Viewer but keeps the occurrence fold inspectable', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    userMessage([
      { type: 'text', text: 'inspect' },
      { type: 'image', attachment: IMAGE_REF },
    ], 1),
    userMessage([{ type: 'text', text: 'NEXT' }], 2),
  ])
  app.setTranscript(folder.messages())
  const question = app.askQuestions([{ id: 'q1', question: 'Inspect safely?', options: [{ label: 'Continue' }] }])
  await vt.waitForRender()
  const view = await viewport(vt)
  assert.ok(view.includes('Inspect safely?'), `the Question owns the modal front:\n${view}`)
  const infoRow = rowOfNth(view, '🖼️ shot.png · 800×100', 0)
  assert.ok(infoRow > 0, `the image is mounted behind the modal:\n${view}`)
  // The image BODY click must NOT open the workspace screen while the modal
  // owns the seat.
  await clickCell(vt, 4, infoRow + 1)
  const afterBody = await viewport(vt)
  assert.ok(!afterBody.includes('Image · shot.png'), `no Viewer opens under a modal:\n${afterBody}`)
  assert.ok(afterBody.includes('Inspect safely?'), 'the Question remains the response owner')
  // The info control stays a READ-ONLY fold in the modal inspection plane.
  await clickControl(vt, '🖼️ shot.png · 800×100')
  const folded = await viewport(vt)
  assert.ok(folded.includes('[+]'), `the modal-safe fold still works:\n${folded}`)
  assert.ok(folded.includes('Inspect safely?'), 'the Question still owns the response')
  vt.sendInput('1')
  vt.sendInput('\r')
  assert.deepEqual(await question, [{ id: 'q1', selected: ['Continue'] }])
  app.setFullscreen(false)
  app.stop()
})

test('an Approval modal refuses the image body Viewer but keeps the occurrence fold inspectable', async () => {
  // The Approval action sheet has its OWN pointer admission branch
  // (`handleFullscreenPress`) separate from the Question branch, so the
  // Question-only regression above cannot prove this one. The sheet occupies
  // the editor seat at the bottom of the screen; the transcript above it stays
  // reachable ONLY through the modal-safe inspection plane.
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    userMessage([
      { type: 'text', text: 'inspect' },
      { type: 'image', attachment: IMAGE_REF },
    ], 1),
    userMessage([{ type: 'text', text: 'NEXT' }], 2),
  ])
  app.setTranscript(folder.messages())
  const decision = app.showApprovalPrompt({ toolName: 'bash', reason: 'run a shell command' })
  decision.catch(() => {})
  await vt.waitForRender()
  const view = await viewport(vt)
  assert.ok(app.approvalFrameForTest() !== undefined, `the Approval sheet is presented:\n${view}`)
  const infoRow = rowOfNth(view, '🖼️ shot.png · 800×100', 0)
  assert.ok(infoRow > 0, `the image is mounted behind the sheet:\n${view}`)
  const nextBefore = rowOfNth(view, 'NEXT', 0)
  // The image BODY click must NOT open the workspace screen while the Approval
  // owns the seat: `attachment:view:` is deliberately outside the modal-safe
  // whitelist.
  await clickCell(vt, 4, infoRow + 1)
  const afterBody = await viewport(vt)
  assert.ok(!afterBody.includes('Image · shot.png'), `no Viewer opens under an Approval:\n${afterBody}`)
  assert.ok(app.approvalFrameForTest() !== undefined, 'the Approval still owns the response')
  assert.equal(rowOfNth(afterBody, 'NEXT', 0), nextBefore, 'the refused body click changed no layout')
  // The info control stays a READ-ONLY fold in the Approval inspection plane.
  await clickControl(vt, '🖼️ shot.png · 800×100', 0)
  const folded = await viewport(vt)
  assert.ok(folded.includes('[+]'), `the Approval-safe fold still works:\n${folded}`)
  assert.ok(rowOfNth(folded, 'NEXT', 0) < nextBefore, 'the fold really collapsed the image body')
  assert.ok(app.approvalFrameForTest() !== undefined, 'the Approval survived the inspection fold')
  // The sheet still settles through its own keyboard path (Escape = cancel).
  vt.sendInput('\x1b')
  assert.equal(await decision, 'cancelled', 'the Approval still owns its decision')
  app.setFullscreen(false)
  app.stop()
})
