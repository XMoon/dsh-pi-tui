/**
 * The Ctrl+V clipboard-paste intent queue of the application-event owner.
 *
 * The REAL `createApplicationEvents` handler is driven through its returned
 * `events.onClipboardPaste()`; only the OS clipboard probe and the injected
 * owner groups it does not touch are controlled. Every case observes the
 * clipboard probe ORDER and the live composer bytes, so a regression that
 * probes twice, commits into a replaced seat, or commits after the owner
 * moved is visible before the final draft is asserted.
 * @module @xmoon76/dsh-pi-tui/clipboard-paste-order.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createApplicationEvents, type ApplicationEventsDeps } from '../../src/app/surface/application-events.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'
import type { ClientActions } from '../../src/app/surface/client-actions.ts'
import type { ClipboardReadResult } from '../../src/client/clipboard/read.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { checkImageLimits } from '../../src/client/media/image/intake.ts'
import { prepareUserMessage } from '../../src/app/submission/direct-message-preparation.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { runOwned as runOwnedReal, type OwnedTaskOptions } from '../../src/runtime/process/tasks.ts'

/** One test-controlled clipboard probe. */
interface Probe {
  readonly promise: Promise<ClipboardReadResult>
  resolve(result: ClipboardReadResult): void
  reject(error: unknown): void
}

/** The caret editor double: the PiTui insert semantics the paste handler uses. */
interface RecordingComposer extends SubmissionComposerPort {
  readonly notices: { text: string; kind: 'info' | 'error' | undefined }[]
  readonly inserts: string[]
  caretAt(index: number): void
}

function recordingComposer(initial = ''): RecordingComposer {
  let text = initial
  let caret = initial.length
  const notices: RecordingComposer['notices'] = []
  const inserts: string[] = []
  return {
    notices,
    inserts,
    getDraft: () => text,
    setDraft: (next) => { text = next; caret = next.length },
    setEditorText: (next) => { text = next; caret = next.length },
    insertIntoEditor: (value) => {
      inserts.push(value)
      text = `${text.slice(0, caret)}${value}${text.slice(caret)}`
      caret += value.length
    },
    notify: (message, kind) => { notices.push({ text: message, kind }) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
    caretAt: (index) => { caret = index },
  }
}

function probeOf(): { probe: Probe; resolve(result: ClipboardReadResult): void; reject(error: unknown): void } {
  let resolve!: (result: ClipboardReadResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<ClipboardReadResult>((res, rej) => { resolve = res; reject = rej })
  return { probe: { promise, resolve, reject }, resolve, reject }
}

/** Drain the microtask/macrotask queue up to the next check-phase turn (no
 *  fixed wait: `setImmediate` is the earliest observable turn boundary). */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

interface Harness {
  paste(): void
  /** Script the NEXT clipboard probe (in trigger order). */
  scriptProbe(): Probe
  /** The probe indices that actually started, in start order. */
  readonly started: number[]
  readonly composer: RecordingComposer
  /** Install a replacement composer seat (the same live `surface.composer`
   *  getter returns it from then on). */
  replaceComposer(next: RecordingComposer): void
  readonly seat: { current: RecordingComposer }
  bumpGeneration(): void
  dispose(): void
  readonly store: DraftImageStore
  readonly generation: { value: number }
  readonly sessionId: { value: string | undefined }
  setImageLimits(limits: Parameters<typeof checkImageLimits>[2] | undefined): void
  /** Resolve once every owned paste task (and its classification) settled. */
  drained(): Promise<void>
}

function harness(): Harness {
  const store = new DraftImageStore()
  const fileStore = new DraftFileStore()
  const seat: { current: RecordingComposer } = { current: recordingComposer() }
  const generation = { value: 1 }
  const sessionId: { value: string | undefined } = { value: 'session-a' }
  const started: number[] = []
  const probes: Probe[] = []
  const owned: Promise<void>[] = []
  let cleanedUp = false
  let limits: Parameters<typeof checkImageLimits>[2] | undefined
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })

  const deps = {
    // The groups the paste handler does not read (the event table requires
    // them, the clipboard path never calls them).
    submission: {} as ApplicationEventsDeps['submission'],
    viewer: {} as ApplicationEventsDeps['viewer'],
    status: {} as ApplicationEventsDeps['status'],
    settings: {} as ApplicationEventsDeps['settings'],
    rewind: {} as ApplicationEventsDeps['rewind'],
    subagentDelivery: {} as ApplicationEventsDeps['subagentDelivery'],
    // The composer SEAT is read live: the identity check compares the object
    // this getter returns at trigger time with the one at commit time.
    surface: {
      get composer() { return seat.current },
      app: seat.current,
      handleTerminalFocus: () => {},
      noteUserInput: () => {},
      openTasksBrowser: () => {},
    } as unknown as ApplicationEventsDeps['surface'],
    client: {
      readClipboardImage: (): Promise<ClipboardReadResult> => {
        const index = started.length
        started.push(index)
        const probe = probes[index]
        if (probe === undefined) throw new Error(`unscripted clipboard probe #${index}`)
        return probe.promise
      },
    } as unknown as ClientActions,
    drafts: { images: store, files: fileStore },
    imageLimits: () => limits,
    lifecycle: {
      // The production wiring invokes the task factory SYNCHRONOUSLY and
      // pre-attaches diagnostics; the test keeps the REAL classifier so an
      // onError notice is observed exactly like production.
      runOwned: <T>(
        label: string,
        task: () => T | Promise<T>,
        options: Omit<OwnedTaskOptions<T>, 'diag'> | undefined,
      ): void => {
        let taskPromise: Promise<T>
        try {
          taskPromise = Promise.resolve(task())
        } catch (error) {
          taskPromise = Promise.reject(error)
        }
        runOwnedReal(label, () => taskPromise, { ...options, diag })
        // Registered AFTER the real chain: the real classifier's `onError`
        // runs inside the settlement handlers, so awaiting this observer proves
        // the classification (and any notice) already happened.
        owned.push(taskPromise.then(() => undefined, () => undefined))
      },
      isCleanedUp: () => cleanedUp,
      requestExit: () => {},
      liveAgent: () => sessionId.value === undefined ? undefined : { session: { id: sessionId.value } },
      generation: () => generation.value,
      currentSessionId: () => sessionId.value,
      navigationEpoch: () => 0,
      signal: () => new AbortController().signal,
    },
  } as unknown as ApplicationEventsDeps

  const events = createApplicationEvents(deps).events
  assert.ok(events.onClipboardPaste !== undefined, 'the owner exposes the Ctrl+V paste intent')
  return {
    started,
    seat,
    store,
    generation,
    sessionId,
    composer: seat.current,
    scriptProbe: () => {
      const scripted = probeOf()
      probes.push(scripted.probe)
      return scripted.probe
    },
    replaceComposer: (next) => { seat.current = next },
    bumpGeneration: () => { generation.value += 1 },
    setImageLimits: (next) => { limits = next },
    dispose: () => { cleanedUp = true },
    paste: () => events.onClipboardPaste!(),
    drained: async () => {
      // Two drains: a task may be queued while the first batch settles.
      await Promise.all(owned)
      await Promise.all(owned)
    },
  }
}

const IMAGE_A = { kind: 'image' as const, bytes: new Uint8Array([1, 1, 1, 1]), mediaType: 'image/png' as const, width: 1, height: 1 }
const IMAGE_B = { kind: 'image' as const, bytes: new Uint8Array([2, 2, 2, 2, 2]), mediaType: 'image/png' as const, width: 2, height: 2 }

test('a slow first clipboard image read commits before a later fast paste', async () => {
  const h = harness()
  const first = h.scriptProbe()
  const second = h.scriptProbe()
  h.paste()
  h.paste()
  await flush()
  assert.deepEqual(h.started, [0], 'only the first probe runs while its read is pending')

  first.resolve(IMAGE_A)
  await flush()
  // The commit landed BEFORE the second probe started: the store holds one
  // image and the second probe runs only after that commit.
  assert.deepEqual(h.started, [0, 1], 'the second probe starts only after the first commit')
  assert.equal(h.store.size(), 1)
  const tokenA = h.store.values()[0]!.placeholder
  assert.equal(h.composer.getDraft(), `${tokenA} `, 'the first token is in the draft at the second probe start')

  second.resolve(IMAGE_B)
  await h.drained()
  const drafts = h.store.values()
  assert.deepEqual(drafts.map(draft => draft.bytes.byteLength), [4, 5])
  assert.equal(h.composer.getDraft(), `${drafts[0]!.placeholder} ${drafts[1]!.placeholder} `,
    'tokens land in paste order, each after its own probe')
  assert.equal(h.composer.notices.length, 2, 'each staged image announces itself once')
  assert.deepEqual(h.started, [0, 1], 'each accepted intent probes the clipboard exactly once')
})

test('a first clipboard read failure does not block the second queued paste', async () => {
  const h = harness()
  const first = h.scriptProbe()
  const second = h.scriptProbe()
  h.paste()
  h.paste()
  first.reject(new Error('clipboard probe exploded'))
  second.resolve(IMAGE_B)
  await h.drained()

  assert.deepEqual(h.started, [0, 1], 'the failed intent still ran exactly one probe and the next one ran too')
  assert.equal(h.store.size(), 1, 'the failed intent staged nothing; the second intent staged its image')
  const token = h.store.values()[0]!.placeholder
  assert.equal(h.composer.getDraft(), `${token} `)
  const errors = h.composer.notices.filter(notice => notice.kind === 'error')
  assert.deepEqual(errors, [{ text: 'clipboard probe exploded', kind: 'error' }],
    'exactly one error notice, on the composer that started the failed paste')
  assert.deepEqual(h.composer.notices.filter(notice => notice.kind !== 'error'), [{ text: `attached ${token} — Enter to send`, kind: undefined }],
    'the successful queued paste announces its own token only')
})

test('a session generation change before a queued probe drops its work without reading', async () => {
  const h = harness()
  const first = h.scriptProbe()
  const second = h.scriptProbe()
  h.paste()
  h.paste()
  await flush()
  assert.deepEqual(h.started, [0])
  h.bumpGeneration()
  first.resolve(IMAGE_A)
  await h.drained()

  assert.deepEqual(h.started, [0], 'the queued intent never probed after the generation changed')
  assert.equal(h.store.size(), 0, 'neither intent staged bytes into the new generation')
  assert.equal(h.seat.current.getDraft(), '', 'no token reached the replaced generation draft')
  assert.deepEqual(h.seat.current.notices, [], 'no notice is published to the new generation')
})

test('a same session id on a new generation never receives old paste data', async () => {
  const h = harness()
  const first = h.scriptProbe()
  h.paste()
  await flush()
  assert.deepEqual(h.started, [0])
  // Same literal session id: only the ownership generation moved.
  assert.equal(h.sessionId.value, 'session-a')
  h.bumpGeneration()
  first.resolve(IMAGE_A)
  await h.drained()

  assert.equal(h.store.size(), 0, 'the same-id new generation receives no staged image')
  assert.equal(h.seat.current.getDraft(), '')
  assert.deepEqual(h.seat.current.notices, [], 'the old intent publishes no notice')
})

test('a composer seat replacement without a session id change rejects stale paste', async () => {
  const h = harness()
  const oldSeat = h.seat.current
  const newSeat = recordingComposer()
  const first = h.scriptProbe()
  h.paste()
  await flush()
  h.replaceComposer(newSeat)
  first.resolve(IMAGE_A)
  await h.drained()

  assert.equal(h.sessionId.value, 'session-a', 'the session id never changed in this case')
  assert.equal(h.generation.value, 1, 'the generation never changed in this case')
  assert.deepEqual(oldSeat.inserts, [], 'the captured seat receives nothing after replacement')
  assert.equal(newSeat.getDraft(), '', 'the replacement seat never receives the old paste')
  assert.equal(h.store.size(), 0, 'the stale image is not staged at all')
  assert.deepEqual(newSeat.notices, [], 'the replacement seat gets no stale notice')
})

test('a plain text clipboard result inserts at the live cursor without auto-submit or a no-image notice', async () => {
  const h = harness()
  const first = h.scriptProbe()
  h.paste()
  await flush()
  // The user types and moves the caret while the OS read is pending.
  h.seat.current.setEditorText('hello world')
  h.seat.current.caretAt(5)
  first.resolve({ kind: 'text', text: 'PASTED' })
  await h.drained()

  assert.equal(h.seat.current.getDraft(), 'helloPASTED world', 'the paste lands at the CURRENT caret, over nothing')
  assert.deepEqual(h.seat.current.notices, [], 'a text paste never reports "no image"')
  assert.equal(h.store.size(), 0, 'a text paste stages nothing')
  assert.deepEqual(h.seat.current.inserts, ['PASTED'], 'exactly one editor insert, no submit')
})

test('an unsupported or empty clipboard result leaves the draft untouched and reports no spurious error', async () => {
  const h = harness()
  const unsupported = h.scriptProbe()
  const empty = h.scriptProbe()
  h.paste()
  h.paste()
  unsupported.resolve({ kind: 'unsupported' })
  empty.resolve({ kind: 'text', text: '' })
  await h.drained()

  assert.deepEqual(h.started, [0, 1], 'both intents were accepted and probed once each')
  assert.equal(h.seat.current.getDraft(), '')
  assert.deepEqual(h.seat.current.inserts, [])
  assert.deepEqual(h.seat.current.notices, [])
  assert.equal(h.store.size(), 0)
})

test('an oversized clipboard image is rejected without inserting an orphan placeholder and later pastes still proceed', async () => {
  const h = harness()
  h.setImageLimits({
    maxImageBytes: 128,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 1024,
    maxImagePixels: 64,
    maxImageDimension: 32,
    mediaTypes: ['image/png'],
  })
  const oversized = h.scriptProbe()
  h.paste()
  // 256 bytes exceeds the 128-byte deployment cap; the payload itself parses.
  oversized.resolve({ ...IMAGE_B, bytes: new Uint8Array(256) })
  await h.drained()

  assert.equal(h.store.size(), 0, 'the byte-cap rejection stages nothing')
  assert.equal(h.seat.current.getDraft(), '', 'no orphan placeholder is inserted')
  assert.equal(h.seat.current.notices.length, 1, 'the rejection is reported exactly once')
  assert.equal(h.seat.current.notices[0]!.kind, 'error')

  // A later paste still commits normally in the same owner lifetime.
  const later = h.scriptProbe()
  h.paste()
  later.resolve(IMAGE_A)
  await h.drained()
  assert.equal(h.store.size(), 1, 'the following paste stages its own image')
  assert.equal(h.seat.current.getDraft(), `${h.store.values()[0]!.placeholder} `)
  assert.equal(h.seat.current.notices.length, 2, 'the recovered paste announces its own token only')
})

test('a composer insert failure drops the just-staged image and reports the failure once', async () => {
  const h = harness()
  const failing: RecordingComposer = {
    ...recordingComposer(),
    // The editor refuses the token BEFORE the text changes.
    insertIntoEditor: () => { throw new Error('the editor seat refused the insert') },
  }
  h.replaceComposer(failing)
  const probe = h.scriptProbe()
  h.paste()
  probe.resolve(IMAGE_A)
  await h.drained()

  assert.equal(h.store.size(), 0, 'the staged bytes are dropped: no orphan draft outlives the failed token')
  assert.equal(failing.getDraft(), '')
  const errors = failing.notices.filter(notice => notice.kind === 'error')
  assert.deepEqual(errors, [{ text: 'the editor seat refused the insert', kind: 'error' }],
    'the real insert failure is reported once, never hidden')
})

test('clipboard paste never commits or notifies after owner disposal', async () => {
  // The probe SETTLES after disposal in both directions: a resolve must not
  // commit, a rejection must not reach the error notice.
  for (const settlement of ['resolve', 'reject'] as const) {
    const h = harness()
    const pending = h.scriptProbe()
    h.paste()
    await flush()
    assert.deepEqual(h.started, [0], `${settlement}: the probe is in flight`)
    h.dispose()
    if (settlement === 'resolve') pending.resolve(IMAGE_A)
    else pending.reject(new Error('probe failed after disposal'))
    await h.drained()

    assert.equal(h.store.size(), 0, `${settlement}: a disposed owner stages nothing`)
    assert.equal(h.seat.current.getDraft(), '', `${settlement}: a disposed owner never writes the composer`)
    assert.deepEqual(h.seat.current.notices, [], `${settlement}: a disposed owner never publishes a notice`)
  }
  // A queued intent created before disposal never probes afterwards.
  const queued = harness()
  const first = queued.scriptProbe()
  queued.scriptProbe()
  queued.paste()
  queued.paste()
  await flush()
  queued.dispose()
  first.resolve(IMAGE_A)
  await queued.drained()
  assert.deepEqual(queued.started, [0], 'a disposed owner starts no further clipboard probe')
  assert.equal(queued.store.size(), 0)
})

test('a committed clipboard image token is consumed by ordinary message preparation', async () => {
  // The C2 chain: the REAL paste handler -> ONE OS probe -> generation/seat
  // fence -> live draft prune -> store add -> caret insert -> the SAME
  // placeholder/store an ordinary submission preparation consumes.
  const h = harness()
  h.seat.current.setEditorText('look at this')
  h.seat.current.caretAt(4)
  const probe = h.scriptProbe()
  h.paste()
  probe.resolve({ ...IMAGE_A, bytes: new Uint8Array(33) })
  await h.drained()

  const draft = h.store.values()[0]!
  assert.equal(h.seat.current.getDraft(), `look${draft.placeholder}  at this`,
    'the canonical token (with its trailing separator) landed at the caret the user left')
  const message = await prepareUserMessage(h.seat.current.getDraft(), h.store, {
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png'],
      },
      saveImages: async inputs => inputs.map((input, index) => ({
        attachmentId: `att-${index + 1}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        name: input.name,
      })),
    },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } as never,
    currentModel: () => ({ provider: 'provider', model: 'model' }),
    canonicalizeMentions: async text => text,
  })
  assert.equal(message.content.filter(block => block.type === 'image').length, 1,
    'the submission preparation consumes the clipboard image the handler staged')
  assert.deepEqual(message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text),
    ['look', '  at this'], 'the surrounding text keeps its order around the resolved image')
})
