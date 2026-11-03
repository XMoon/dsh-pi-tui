/**
 * PiTui: a REAL terminal bracketed paste carrying a local image file path is
 * attached automatically without `/image`.
 *
 * The test drives the production mount (`TuiApp` + the ONE application intake
 * owner) with the real bracketed-paste bytes a terminal sends. The file read
 * is held through the production test seam so the in-flight window is real;
 * the bytes still go through the real `readImageFile` and draft store.
 * @module @xmoon76/dsh-pi-tui/terminal-pasted-image.test
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { TuiApp, type TuiAppOptions } from '../../src/tui-app.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { readImageFileUninjected, setImageReadForTest } from '../../src/client/media/image/intake.ts'
import {
  PASTE_PENDING_NOTICE,
  createPastedImageIntakeOwner,
  type PastedImageIntakeOwner,
} from '../../src/app/surface/pasted-image-intake.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
  setImageReadForTest(undefined)
})

/** A production PNG header (33 bytes, IHDR 640×480). */
function pngBytes(width = 640, height = 480): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const set32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
  set32(16, width)
  set32(20, height)
  return bytes
}

interface PasteHarness {
  readonly app: TuiApp
  readonly vt: VirtualTerminal
  readonly owner: PastedImageIntakeOwner
  readonly images: DraftImageStore
  readonly root: string
  readonly imagePath: string
  readonly submitted: { readonly text: string; readonly request: string }[]
  readonly steered: string[]
  readonly reads: string[]
  /** Let every held read for `path` (default: all) proceed. */
  release(path?: string): Promise<void>
}

interface HarnessOptions {
  /** Start the app with a viewer-covering draft? (kept for seat-fence cases) */
  options?: TuiAppOptions
}

function harness(life: TestLifecycle, hOptions: HarnessOptions = {}): PasteHarness {
  const root = life.tempDir('dsh-terminal-pasted-image-')
  const imagePath = join(root, 'shot.png')
  writeFileSync(imagePath, pngBytes())
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const submitted: { text: string; request: string }[] = []
  const steered: string[] = []
  const reads: string[] = []
  const gates: { path: string; release: () => void }[] = []
  setImageReadForTest(async (rawPath, cwd, limits, cap) => {
    reads.push(rawPath)
    await new Promise<void>((resolve) => { gates.push({ path: rawPath, release: resolve }) })
    return readImageFileUninjected(rawPath, cwd, limits, cap)
  })
  const vt = new VirtualTerminal(100, 24)
  let appRef: TuiApp | undefined
  const owner = createPastedImageIntakeOwner({
    drafts: { images, files },
    composer: () => {
      if (appRef === undefined) throw new Error('the surface is not mounted')
      return appRef
    },
    clientCwd: () => root,
    imageLimits: () => undefined,
    lifecycle: {
      generation: () => 1,
      currentSessionId: () => 's1',
      isCleanedUp: () => false,
      runOwned: (_label, task, options) => {
        void task().catch((error: unknown) => { options.onError(error) })
      },
    },
  })
  const app = new TuiApp(vt, {
    onSubmit: (text, request) => { submitted.push({ text, request }) },
    onExit: () => {},
    onSteer: (text) => { steered.push(text) },
    // The composition root routes the renderer receipt to the ONE intake
    // owner (the same wiring ApplicationEvents performs in production).
    onTerminalPastedPath: (receipt) => owner.accept(receipt),
  }, { terminalPastedPath: owner, ...hOptions.options })
  appRef = app
  app.start()
  startedApps.add(app)
  life.defer(() => app.stop())
  return {
    app,
    vt,
    owner,
    images,
    root,
    imagePath,
    submitted,
    steered,
    reads,
    release: async (path) => {
      const index = path === undefined
        ? gates.length - 1
        : gates.findIndex(gate => gate.path === path)
      assert.ok(index >= 0, `the read for ${path ?? 'the last paste'} must have started`)
      const [gate] = gates.splice(index, 1)
      gate!.release()
      await vt.waitForRender()
    },
  }
}

async function waitFor(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail('the observable condition never became true')
}

/** Paste one terminal body as the real bracketed-paste byte sequence. */
function paste(vt: VirtualTerminal, body: string): void {
  vt.sendInput(`\x1b[200~${body}\x1b[201~`)
}

test('a real bracketed paste of a PNG path becomes an image draft without /image', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath))
  assert.deepEqual(h.reads, [h.imagePath], 'the paste entry ran the real image read for the ONE proven path')
  assert.equal(h.images.size(), 0, 'nothing is staged before the read settles')

  await h.release()
  await waitFor(() => h.images.size() === 1)
  const staged = h.images.values()
  assert.equal(staged.length, 1)
  assert.equal(staged[0]!.width, 640)
  assert.equal(staged[0]!.height, 480)
  assert.equal(h.app.getDraft(), `${staged[0]!.placeholder} `,
    'the exact pasted span became the canonical token; the separator space stays ordinary text')
  assert.equal(h.submitted.length, 0, 'the attachment never auto-submits')
})

test('Enter while the image is still being attached is refused before the clear', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath))

  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.equal(h.submitted.length, 0, 'no writer/history/ack side effect while the read is in flight')
  assert.ok(h.app.getDraft().includes(h.imagePath), 'the draft survives the refused Enter')
  assert.ok(h.vt.getViewport().join('\n').includes(PASTE_PENDING_NOTICE),
    'the ONE retry notice is shown')

  await h.release()
  await waitFor(() => h.images.size() === 1)
  const placeholder = h.images.values()[0]!.placeholder
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  await waitFor(() => h.submitted.length === 1)
  assert.equal(h.submitted[0]!.text, placeholder, 'the retried Enter sends the real image token')
})

test('typing Chinese after the paste keeps every typed character around the token', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath))
  h.vt.sendInput('这是啥')
  await waitFor(() => h.app.getDraft().endsWith('这是啥'))

  await h.release()
  await waitFor(() => h.images.size() === 1)
  const placeholder = h.images.values()[0]!.placeholder
  assert.equal(h.app.getDraft(), `${placeholder} 这是啥`)
})

test('two pastes complete out of order but each replaces its OWN text position', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  const secondPath = join(h.root, 'second.png')
  writeFileSync(secondPath, pngBytes(320, 200))
  paste(h.vt, `${h.imagePath} `)
  paste(h.vt, `${secondPath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath) && h.app.getDraft().includes(secondPath))

  await h.release(secondPath)
  await waitFor(() => h.images.size() === 1)
  await h.release(h.imagePath)
  await waitFor(() => h.images.size() === 2)
  const [first, second] = h.images.values()
  assert.equal(first!.width, 320, 'the faster paste staged first')
  assert.equal(second!.width, 640)
  assert.equal(h.app.getDraft(), `${second!.placeholder} ${first!.placeholder} `,
    'the earlier TEXT position keeps the earlier occurrence; ids follow completion order')
})

test('a pasted non-image text is ordinary draft content (inert, no read, no error)', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, '/image shot.png\n/exit')
  await waitFor(() => h.app.getDraft().includes('/image shot.png'))
  assert.deepEqual(h.reads, [])
  assert.equal(h.app.getDraft(), '/image shot.png\n/exit')
})

test('a paste in shell mode is a shell document and never an image attachment', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.vt.sendInput('!')
  await h.vt.waitForRender()
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath))
  assert.deepEqual(h.reads, [], 'shell words are the shell plane authority')
})

test('a missing file keeps the path text and reports the basename once', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  const missing = join(h.root, 'gone.png')
  paste(h.vt, `${missing} `)
  await waitFor(() => h.reads.length === 1)
  await h.release()
  await h.vt.waitForRender()
  const draft = h.app.getDraft()
  assert.ok(draft.includes(missing), 'the path text is never dropped')
  assert.equal(h.images.size(), 0)
  assert.ok(h.vt.getViewport().join('\n').includes('Image file not found: gone.png'),
    'the notice names the basename, never the full private path')
})

test('the accelerated submit chord and Ctrl+S steer are refused while the paste is attaching', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath))

  h.vt.sendInput('\x1b[13;5u') // kitty ctrl+enter: the accelerated submit chord
  await h.vt.waitForRender()
  assert.equal(h.submitted.length, 0, 'the accelerated chord is refused before any clear')
  h.vt.sendInput('\x13') // Ctrl+S: the steer gesture
  await h.vt.waitForRender()
  assert.deepEqual(h.steered, [], 'the steer gesture is refused before any clear')
  assert.ok(h.app.getDraft().includes(h.imagePath), 'the draft survives both refusals')

  await h.release()
  await waitFor(() => h.images.size() === 1)
  const placeholder = h.images.values()[0]!.placeholder
  h.vt.sendInput('\x13')
  await waitFor(() => h.steered.length === 1)
  assert.equal(h.steered[0], `${placeholder} `, 'the retried steer sends the real image token')
})

test('the first Undo after the conversion restores the raw pasted path, then the paste itself', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath))
  await h.release()
  await waitFor(() => h.images.size() === 1)
  const placeholder = h.images.values()[0]!.placeholder
  assert.equal(h.app.getDraft(), `${placeholder} `)

  h.vt.sendInput('\x1b[45;5u') // kitty Ctrl+- : the fork editor's Undo
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), `${h.imagePath} `,
    'the first Undo restores the raw pasted path text, never a dead image token')

  h.vt.sendInput('\x1b[45;5u')
  await h.vt.waitForRender()
  assert.equal(h.app.getDraft(), '', 'the second Undo removes the paste itself')
})

test('two pastes of the SAME path each replace their own occurrence', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, `${h.imagePath} `)
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.reads.length === 2)
  await h.release()
  await waitFor(() => h.images.size() === 1)
  await h.release()
  await waitFor(() => h.images.size() === 2)
  const [firstCompleted, secondCompleted] = h.images.values()
  assert.equal(h.app.getDraft(), `${secondCompleted!.placeholder} ${firstCompleted!.placeholder} `,
    'both occurrences converted independently in text order; ids follow completion order')
})

test('deleting the pending path clears the block and the next Enter submits normally', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  paste(h.vt, `${h.imagePath} `)
  await waitFor(() => h.app.getDraft().includes(h.imagePath))
  // The user deletes the pasted path (and its separator) before the read ends.
  for (let index = 0; index < h.imagePath.length + 1; index += 1) h.vt.sendInput('\x7f')
  h.vt.sendInput('hello')
  await waitFor(() => h.app.getDraft() === 'hello')
  h.vt.sendInput('\r')
  await waitFor(() => h.submitted.length === 1)
  assert.equal(h.submitted[0]!.text, 'hello',
    'a dead lease never blocks an unrelated submission')

  await h.release()
  await h.vt.waitForRender()
  assert.equal(h.images.size(), 0, 'the stale read converts nothing after its span was deleted')
})
