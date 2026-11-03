/**
 * The application intake owner of a terminal bracketed pasted image path.
 *
 * The renderer receipt is structural (its exact composer/receipt closures are
 * proven in the TUI/TSP renderer tests); these cases drive the OWNER: the
 * candidate gate, the asynchronous read ownership, the synchronous staged
 * commit, the fail-closed delivery predicate and every stale-authority fence.
 * The read is held with the production test seam so the await window is real
 * and the file content still goes through the real intake/Store.
 * @module @xmoon76/dsh-pi-tui/pasted-image-intake.test
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { ImageInputError, ImageTooLargeError } from '../../src/domain/media/errors.ts'
import { readImageFileUninjected, setImageReadForTest } from '../../src/client/media/image/intake.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'
import {
  createPastedImageIntakeOwner,
  type PastedImageIntakeOwner,
  type PastedPathReceipt,
} from '../../src/app/surface/pasted-image-intake.ts'
import { PasteRangeTracker, pastedBodySpan } from '../../src/tui/interaction/pasted-path-range.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

afterEach(() => { setImageReadForTest(undefined) })

/** A minimal real composer port: one text buffer and its notices. */
class FakeComposer implements SubmissionComposerPort {
  text = ''
  readonly notices: { readonly message: string; readonly kind: string }[] = []
  getDraft(): string { return this.text }
  setDraft(text: string): void { this.text = text }
  setEditorText(text: string): void { this.text = text }
  insertIntoEditor(text: string): void { this.text += text }
  notify(message: string, kind: 'info' | 'error' = 'info'): void { this.notices.push({ message, kind }) }
  setSubmitPending(): void {}
  clearSettledLocalMessages(): void {}
}

/** The renderer side of the contract: the paste span proof + the lease. */
class RendererSeat {
  readonly composer = new FakeComposer()
  readonly tracker = new PasteRangeTracker()
  current = true
  type(text: string): void {
    this.composer.text += text
    this.tracker.observe(this.composer.text)
  }
  paste(body: string): PastedPathReceipt {
    const before = this.composer.text
    const beforeCursor = before.length
    this.composer.text = before + body
    this.tracker.observe(this.composer.text)
    const span = pastedBodySpan(before, beforeCursor, this.composer.text, this.composer.text.length, body)
    assert.ok(span !== undefined, 'the test paste must prove its span')
    const id = this.tracker.add(span)
    assert.ok(id !== undefined)
    return {
      text: body,
      seatCurrent: () => this.current,
      hasLivePath: (path) => this.tracker.live(id)?.expected === path,
      replacePastedPath: (path, placeholder) => {
        const live = this.tracker.live(id)
        if (live === undefined || live.expected !== path) return false
        const next = this.composer.text.slice(0, live.start) + placeholder + this.composer.text.slice(live.end)
        this.tracker.retire(id)
        this.tracker.observe(next)
        this.composer.text = next
        return true
      },
    }
  }
}

/** The production PNG header fixture (33 bytes, IHDR 640×480). */
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

interface Harness {
  readonly owner: PastedImageIntakeOwner
  readonly seat: RendererSeat
  readonly images: DraftImageStore
  readonly files: DraftFileStore
  readonly root: string
  readonly imagePath: string
  readonly authority: {
    generation: number
    sessionId: string | undefined
    composer: SubmissionComposerPort
  }
  readonly reads: string[]
  /** Let every held read proceed; resolves after the owned tasks settled. */
  release(): Promise<void>
  drain(): Promise<void>
}

function harness(life: TestLifecycle, images = new DraftImageStore()): Harness {
  const root = life.tempDir('dsh-pasted-image-')
  const imagePath = join(root, 'shot.png')
  writeFileSync(imagePath, pngBytes())
  const seat = new RendererSeat()
  const files = new DraftFileStore()
  const reads: string[] = []
  const releases: (() => void)[] = []
  const held: Promise<void>[] = []
  const authority = {
    generation: 1,
    sessionId: 's1' as string | undefined,
    composer: seat.composer as SubmissionComposerPort,
  }
  setImageReadForTest(async (rawPath, cwd, limits, cap) => {
    reads.push(rawPath)
    await new Promise<void>((resolve) => { releases.push(resolve) })
    return readImageFileUninjected(rawPath, cwd, limits, cap)
  })
  const drain = async (): Promise<void> => {
    // Two rounds: the task's own settlement, then its onError/finally chain.
    await Promise.all(held)
    await Promise.all(held)
  }
  const owner = createPastedImageIntakeOwner({
    drafts: { images, files },
    composer: () => authority.composer,
    clientCwd: () => root,
    imageLimits: () => undefined,
    lifecycle: {
      generation: () => authority.generation,
      currentSessionId: () => authority.sessionId,
      isCleanedUp: () => false,
      runOwned: (_label, task, options) => {
        const settled = task().catch((error: unknown) => { options.onError(error) })
        held.push(settled)
      },
    },
  })
  return {
    owner,
    seat,
    images,
    files,
    root,
    imagePath,
    authority,
    reads,
    release: async () => {
      while (releases.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
      for (const release of releases.splice(0)) release()
      await drain()
    },
    drain,
  }
}

/** The single success notice the intake posts after a conversion. */
function successNotice(seat: RendererSeat): string | undefined {
  return seat.composer.notices.find(notice => notice.message.startsWith('attached '))?.message
}

test('a candidate paste stages the REAL bytes and replaces exactly the pasted span', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.seat.type('看看 ')
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  assert.equal(h.owner.blocksDelivery(h.seat.composer.getDraft()), true,
    'the path blocks delivery while its read is in flight')
  assert.equal(h.images.size(), 0, 'nothing is staged before the read settles')
  await h.release()

  const staged = h.images.values()
  assert.equal(staged.length, 1)
  assert.equal(staged[0]!.width, 640)
  assert.equal(staged[0]!.height, 480)
  assert.equal(staged[0]!.mediaType, 'image/png')
  assert.equal(staged[0]!.source.type, 'path')
  assert.equal(
    h.seat.composer.getDraft(),
    `看看 ${staged[0]!.placeholder} `,
    'the trailing terminal separator stays as the separator and the prose survives',
  )
  assert.equal(successNotice(h.seat), `attached ${staged[0]!.placeholder} — Enter to send`)
  assert.equal(h.owner.blocksDelivery(h.seat.composer.getDraft()), false,
    'a converted path no longer blocks delivery')
})

test('a non-candidate paste is completely inert (no read, no pending, no error)', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste('see /tmp/notes.txt '))
  await h.drain()
  assert.deepEqual(h.reads, [], 'the grammar gate ran before any filesystem read')
  assert.equal(h.images.size(), 0)
  assert.equal(h.owner.blocksDelivery(h.seat.composer.getDraft()), false)
  assert.deepEqual(h.seat.composer.notices, [])
})

test('a read failure keeps the pasted path and reports the basename once', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  setImageReadForTest(async () => { throw new ImageInputError('Image file not found: shot.png') })
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  await h.drain()
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath), 'the path text is never dropped')
  assert.equal(h.images.size(), 0, 'no bytes are staged for a failed read')
  assert.deepEqual(h.seat.composer.notices, [
    { message: 'Image file not found: shot.png', kind: 'error' },
  ])
  assert.equal(h.owner.blocksDelivery(h.seat.composer.getDraft()), false,
    'a failed read stops blocking the next delivery')
})

test('the delivery predicate ignores text that does not carry the pending path', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  assert.equal(h.owner.blocksDelivery('an unrelated prompt'), false)
  assert.equal(h.owner.blocksDelivery(`${h.imagePath} and more`), true)
  await h.release()
})

test('a stale pending entry never blocks a later delivery of the same literal path: generation moved', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  assert.equal(h.owner.blocksDelivery(h.seat.composer.getDraft()), true,
    'the CURRENT pending entry blocks while its read is in flight')
  // A session/ownership transition moves the generation: the entry can never
  // convert any more (the commit fence rejects it), so it must not block.
  h.authority.generation += 1
  assert.equal(h.owner.blocksDelivery(h.seat.composer.getDraft()), false,
    'a generation-moved entry must not block a same-literal-path delivery')
  await h.release()
  assert.equal(h.images.size(), 0, 'and the stale read still converts nothing')
})

test('a stale pending entry never blocks a later delivery of the same literal path: composer replaced', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.authority.composer = new FakeComposer()
  assert.equal(h.owner.blocksDelivery(`restored ${h.imagePath} `), false,
    'an entry captured on another composer object must not block the new one')
  await h.release()
})

test('a stale pending entry never blocks a later delivery of the same literal path: seat lost', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.seat.current = false
  assert.equal(h.owner.blocksDelivery(h.seat.composer.getDraft()), false,
    'an entry whose seat is no longer current must not block')
  await h.release()
})

test('typing after the paste while the read is in flight preserves the typed text', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.seat.type('这是啥')
  await h.release()
  const staged = h.images.values()
  assert.equal(staged.length, 1)
  assert.equal(h.seat.composer.getDraft(), `${staged[0]!.placeholder} 这是啥`)
})

test('a generation bump while the read is in flight cancels the commit silently', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.authority.generation += 1
  await h.release()
  assert.equal(h.images.size(), 0)
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath))
  assert.deepEqual(h.seat.composer.notices, [], 'a stale task never notifies the new owner')
})

test('a session id change while the read is in flight cancels the commit silently', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.authority.sessionId = 's2'
  await h.release()
  assert.equal(h.images.size(), 0)
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath))
  assert.deepEqual(h.seat.composer.notices, [])
})

test('a composer replacement while the read is in flight cancels the commit silently', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.authority.composer = new FakeComposer()
  await h.release()
  assert.equal(h.images.size(), 0)
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath), 'the old composer keeps its text')
  assert.deepEqual(h.seat.composer.notices, [])
})

test('a seat that is no longer current cancels the commit silently', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.seat.current = false
  await h.release()
  assert.equal(h.images.size(), 0)
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath))
  assert.deepEqual(h.seat.composer.notices, [])
})

test('deleting the pasted path while the read is in flight cancels the commit and the block', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.seat.composer.text = '看看 '
  h.seat.tracker.observe(h.seat.composer.text)
  await h.release()
  assert.equal(h.images.size(), 0)
  assert.equal(h.owner.blocksDelivery('anything'), false, 'the dead lease no longer blocks')
  assert.deepEqual(h.seat.composer.notices, [])
})

test('a store budget rejection keeps the path and surfaces the actionable error', async (t) => {
  const life = testLifecycle(t)
  const tiny = new DraftImageStore(16, 8, 8, 8)
  const h = harness(life, tiny)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  await h.release()
  assert.equal(tiny.size(), 0)
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath))
  const errors = h.seat.composer.notices.filter(notice => notice.kind === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /attachment limit/i)
})

test('replacePastedPath false drops the just-staged image and reports no success', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  const receipt = h.seat.paste(`${h.imagePath} `)
  h.owner.accept({ ...receipt, replacePastedPath: () => false })
  await h.release()
  assert.equal(h.images.size(), 0, 'no orphan bytes survive a refused replacement')
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath))
  assert.equal(successNotice(h.seat), undefined)
})

test('a throwing replacement drops the un-tokenized image and reports the failure', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  const receipt = h.seat.paste(`${h.imagePath} `)
  h.owner.accept({ ...receipt, replacePastedPath: () => { throw new ImageTooLargeError(10, 1) } })
  await h.release()
  assert.equal(h.images.size(), 0, 'the staged image is compensated when its token never landed')
  assert.equal(h.seat.composer.notices.filter(notice => notice.kind === 'error').length, 1)
})

test('dispose retires every pending commit', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life)
  h.owner.accept(h.seat.paste(`${h.imagePath} `))
  h.owner.dispose()
  await h.release()
  assert.equal(h.images.size(), 0)
  assert.ok(h.seat.composer.getDraft().includes(h.imagePath))
  assert.deepEqual(h.seat.composer.notices, [])
})
