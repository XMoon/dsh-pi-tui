/**
 * PR4-B2-A headless command qualification.
 *
 * Every case here boots the REAL Direct composition (`createDirectTspFixture`:
 * real rc.2 Host services, real live Agents, the real runner + Submission
 * controller, the real TSP renderer) and drives the registered TUI builtin
 * through the real Composer → classification → TSP capability gate → the
 * unchanged business handler → its real authority. Only the model endpoint is
 * scripted. There is deliberately NO second command dispatcher or fake command
 * service: a case is green only when the production source→decision→sink chain
 * produced the observable result.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-headless-commands.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { symbols } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDirectTspFixture, directSettle, waitFor, waitForInputDelivery, type DirectTspFixture } from '../support/direct-tsp-fixture.ts'
import { SessionOperationBarrier } from '../../src/app/session/operation-barrier.ts'
import { pickerNode, pickerProps, sendAction, sendActivate, wireNodes } from '../support/tsp-picker-wire.ts'

// ── wire helpers ────────────────────────────────────────────────────────────

/** The latest controlled editor text committed for `dock.composer`. */
function composerText(fixture: DirectTspFixture): string | undefined {
  const composer = wireNodes(fixture.pane).find(node => node.id === 'dock.composer')
  return typeof composer?.p.text === 'string' ? composer.p.text : undefined
}

/** Whether the REAL live Host Agent inbox still holds a matching occurrence. */
function hostInboxHas(fixture: DirectTspFixture, sessionId: string, marker: string): boolean {
  const agents = fixture.ctx.get('agents') as unknown as {
    get(id: SessionId): {
      readonly inbox: {
        readonly nextTurn: readonly unknown[]
        readonly nextStep: readonly unknown[]
      }
    } | undefined
  }
  const agent = agents.get(SessionId(sessionId))
  if (agent === undefined) return false
  return [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
    .some(item => JSON.stringify(item).includes(marker))
}

/** The current Session id(s) the dock welcome card carries (hydration signal). */
function welcomeSessionIds(fixture: DirectTspFixture): string[] {
  const prefix = 'dock.welcome-'
  return wireNodes(fixture.pane).filter(node => node.id.startsWith(prefix)).map(node => node.id.slice(prefix.length))
}

/** The live DOCK notice lines (never the transcript command card). */
function dockNotices(fixture: DirectTspFixture): string[] {
  return wireNodes(fixture.pane)
    .filter(node => node.id.startsWith('dock.notice-'))
    .map(node => (typeof node.p.text === 'string' ? node.p.text : ''))
}

/**
 * The FOLDED text of every live node on the wire, i.e. what the client really
 * presents (the raw byte stream repeats a value across `add`/`set`/`text` ops,
 * so counting raw occurrences would over-count a single painted line).
 */
function liveNodeTexts(fixture: DirectTspFixture): string[] {
  return wireNodes(fixture.pane).map(node => (typeof node.p.text === 'string' ? node.p.text : ''))
}

/**
 * The highest DOCK notice sequence number on the wire. Notice ids are the
 * renderer's monotonic `n<N>`, so this is a NON-DECREASING discriminator even
 * after the dock evicts the oldest notices (a stale line of the same text can
 * never satisfy "a NEW notice was published").
 */
function lastNoticeSeq(fixture: DirectTspFixture): number {
  let max = 0
  for (const node of wireNodes(fixture.pane)) {
    const match = /^dock\.notice-n(\d+)$/.exec(node.id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return max
}

/** Type one full line into the composer and submit it with Enter. */
async function submitInput(fixture: DirectTspFixture, command: string): Promise<void> {
  fixture.pane.input.type(command)
  // The composer HOLDING the text is the completion signal: the Enter below
  // needs the draft, and the draft is the composer's own fact. A fixed
  // settle after it only guessed how long the hand-off takes.
  await waitFor(`the composer to hold ${command}`, () => composerText(fixture) === command)
  fixture.pane.input.type('\r')
}

/** Erase whatever the composer currently holds (draft-restore between cases). */
async function clearComposer(fixture: DirectTspFixture): Promise<void> {
  const current = composerText(fixture) ?? ''
  for (let index = 0; index < current.length; index += 1) fixture.pane.input.type('\x7f')
  await waitFor('the composer to clear', () => (composerText(fixture) ?? '') === '')
}

/** The authoritative persisted session headers (the real persistence seam). */
async function sessionHeaders(fixture: DirectTspFixture): Promise<Array<{ id: string; parentSession?: string; cwd?: string }>> {
  const persistence = fixture.ctx.get('sessionPersistence') as unknown as {
    list(): Promise<readonly { header: { id: string; parentSession?: string; cwd?: string } }[]>
  }
  return (await persistence.list()).map(row => ({ ...row.header }))
}

/** Read one LIVE session's authoritative folded title. */
function sessionTitle(fixture: DirectTspFixture, sessionId: string): string | undefined {
  const sessions = fixture.ctx.get('sessions') as unknown as { get(id: string): unknown }
  const titles = fixture.ctx.get('sessionTitle') as unknown as {
    get(session: unknown): { title: string } | undefined
  } | undefined
  const session = sessions.get(sessionId)
  if (session === undefined || titles === undefined) return undefined
  return titles.get(session)?.title
}

/** Start one real prompt turn and wait for it to settle. */
async function seedTurn(fixture: DirectTspFixture, text: string): Promise<string> {
  const before = fixture.modelCalls()
  await submitInput(fixture, text)
  await waitFor('the real model turn to run', () => fixture.modelCalls() > before, 25_000)
  await waitFor('the current Session owner to hydrate', () => welcomeSessionIds(fixture).length === 1, 25_000)
  await directSettle(1_200)
  const id = welcomeSessionIds(fixture)[0]
  assert.ok(id !== undefined)
  return id
}

// ── A01: /new ───────────────────────────────────────────────────────────────

test('/new creates and hydrates a real new Session without a model turn', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A01'] })
  try {
    await directSettle(4_000)
    assert.deepEqual(welcomeSessionIds(fixture), [], 'the runner boots sessionless')
    await submitInput(fixture, '/new')
    await waitFor('the first Session hydration', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const first = welcomeSessionIds(fixture)[0]!
    assert.equal(fixture.modelCalls(), 0, '/new never starts a model turn')
    assert.deepEqual((await sessionHeaders(fixture)).map(row => row.id), [first],
      'exactly ONE Session was created (no extra preceding Session)')
    // A SECOND /new publishes a DIFFERENT owner.
    await submitInput(fixture, '/new')
    await waitFor('the second Session owner', () => {
      const ids = welcomeSessionIds(fixture)
      return ids.length === 1 && ids[0] !== first
    }, 25_000)
    const second = welcomeSessionIds(fixture)[0]!
    const headers = await sessionHeaders(fixture)
    assert.equal(headers.length, 2, 'both Sessions are persisted')
    assert.ok(headers.some(row => row.id === second))
    assert.equal(fixture.modelCalls(), 0, '/new still never starts a model turn')
  } finally {
    await fixture.settle()
  }
})

// ── A02: /fork ──────────────────────────────────────────────────────────────

test('sessionless /fork refuses and creates no Session', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A02'] })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/fork')
    await waitFor('the sessionless fork refusal', () =>
      dockNotices(fixture).some(text => text.includes('no conversation to fork from')), 25_000)
    assert.equal(dockNotices(fixture).filter(text => text.includes('no conversation to fork from')).length, 1,
      'the sessionless refusal is reported EXACTLY once on the Dock (no duplicate notice)')
    assert.deepEqual(welcomeSessionIds(fixture), [], 'a refused /fork publishes no owner')
    assert.deepEqual(await sessionHeaders(fixture), [], 'a refused /fork creates no Session')
    assert.equal(fixture.modelCalls(), 0, 'a refused /fork never reaches the model')
  } finally {
    await fixture.settle()
  }
})

test('/fork forks the current conversation and publishes the child owner', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['FORK-SOURCE'] })
  try {
    await waitForInputDelivery(fixture.pane)
    const source = await seedTurn(fixture, 'seed the fork source')
    await submitInput(fixture, '/fork')
    await waitFor('the fork child owner', () => {
      const ids = welcomeSessionIds(fixture)
      return ids.length === 1 && ids[0] !== source
    }, 30_000)
    const child = welcomeSessionIds(fixture)[0]!
    const headers = await sessionHeaders(fixture)
    const childRow = headers.find(row => row.id === child)
    assert.ok(childRow !== undefined, 'the fork child is persisted')
    assert.equal(childRow.parentSession, source, 'the child carries the official parent lineage')
  } finally {
    await fixture.settle()
  }
})

// ── A03/A04/A05: /title and /rename ─────────────────────────────────────────

test('/title and /rename write the authoritative title and notify the dock', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['TITLE-ME'],
    officialServices: { sessionTitle: true },
  })
  try {
    await waitForInputDelivery(fixture.pane)
    const sessionId = await seedTurn(fixture, 'a conversation for the title')
    await submitInput(fixture, '/title My first title')
    // The official Direct command-result card owns the text on this mount
    // (RFL-001): the Dock does NOT repeat it.
    await waitFor('the /title result card', () =>
      fixture.pane.output.text().includes('title set: My first title'), 25_000)
    assert.equal(sessionTitle(fixture, sessionId), 'My first title',
      'the authoritative folded Session title is the new value')
    assert.ok(!dockNotices(fixture).some(text => text.includes('title set: My first title')),
      'the Dock does not repeat the title result the command card already carries')
    // The /rename alias reaches the SAME authoritative sink.
    await submitInput(fixture, '/rename Renamed by the alias')
    await waitFor('the /rename result card', () =>
      fixture.pane.output.text().includes('title set: Renamed by the alias'), 25_000)
    assert.equal(sessionTitle(fixture, sessionId), 'Renamed by the alias',
      '/rename is the same authoritative title write')
  } finally {
    await fixture.settle()
  }
})

test('a rejected /title publishes ONE refusal across Dock and transcript', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  // No session-title service is mounted, so the REAL Direct writer rejects the
  // explicit rename deterministically. On TSP+Direct the official command
  // result card owns the message; the Dock must not repeat it.
  const fixture = await createDirectTspFixture(life, { deltas: ['TITLE-REJECT'] })
  try {
    await waitForInputDelivery(fixture.pane)
    await seedTurn(fixture, 'a conversation whose title cannot be written')
    await submitInput(fixture, '/title Rejected Title')
    await waitFor('the refusal to render', () =>
      fixture.pane.output.text().includes('renaming is unavailable'), 25_000)
    await directSettle(1_000)
    // The contract counts BOTH sinks: across every live node on the wire the
    // message must appear exactly once (the command-result card), and no Dock
    // notice line may carry it.
    const sinks = liveNodeTexts(fixture).filter(text => text.includes('renaming is unavailable'))
    assert.equal(sinks.length, 1, 'the refusal is presented exactly once across the Dock and the transcript')
    assert.ok(!dockNotices(fixture).some(text => text.includes('renaming is unavailable')),
      'the Dock does not repeat the text the command-result card already carries')
    assert.ok(!dockNotices(fixture).some(text => text.includes('title set:')),
      'the rejected title is never reported as written')
  } finally {
    await fixture.settle()
  }
})

test('bare /title regenerates the title from the conversation', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['TITLE-REFRESH'],
    officialServices: { sessionTitle: true },
  })
  try {
    await waitForInputDelivery(fixture.pane)
    const sessionId = await seedTurn(fixture, 'regenerate from this sentence')
    await submitInput(fixture, '/title pinned by the user')
    await waitFor('the pinned title card', () =>
      fixture.pane.output.text().includes('title set: pinned by the user'), 25_000)
    assert.equal(sessionTitle(fixture, sessionId), 'pinned by the user')
    await submitInput(fixture, '/title')
    await waitFor('the regeneration notice', () =>
      dockNotices(fixture).some(text => text.includes('title regenerated:')), 25_000)
    const regenerated = sessionTitle(fixture, sessionId)
    assert.ok(regenerated !== undefined && regenerated !== 'pinned by the user',
      'bare /title overwrites the pinned title with the deterministic fallback')
    // The /rename ALIAS takes the same no-argument regeneration path (plan A05).
    const seqBefore = lastNoticeSeq(fixture)
    await submitInput(fixture, '/rename')
    await waitFor('the alias regeneration notice', () =>
      lastNoticeSeq(fixture) > seqBefore
      && dockNotices(fixture).some(text => text.includes('title regenerated:')), 25_000)
    const regeneratedByAlias = sessionTitle(fixture, sessionId)
    assert.ok(regeneratedByAlias !== undefined && regeneratedByAlias !== 'pinned by the user',
      'bare /rename regenerates through the same authoritative refresh')
  } finally {
    await fixture.settle()
  }
})

test('bare /title and bare /rename report the blank-Session refusal on the TSP Dock', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  // A REAL persisted, released, turn-boundary-BLANK Session resumed through the
  // official persistence seam: the mandated "no conversation yet" feedback.
  const fixture = await createDirectTspFixture(life, {
    persistedBlankSession: { id: 'b2a-blank-title' },
    startup: { sessionId: 'b2a-blank-title' },
    deltas: ['UNUSED'],
    officialServices: { sessionTitle: true },
  })
  try {
    await directSettle(4_000)
    assert.deepEqual(welcomeSessionIds(fixture), ['b2a-blank-title'],
      'the runner resumed the persisted blank Session')
    await submitInput(fixture, '/title')
    await waitFor('the no-conversation notice', () =>
      dockNotices(fixture).some(text => text.includes('no conversation yet — title left as-is')), 25_000)
    // The /rename alias takes the same path and reports it again.
    const seqBeforeAlias = lastNoticeSeq(fixture)
    await submitInput(fixture, '/rename')
    await waitFor('the alias no-conversation notice', () =>
      lastNoticeSeq(fixture) > seqBeforeAlias
      && dockNotices(fixture).some(text => text.includes('no conversation yet — title left as-is')), 25_000)
    assert.equal(fixture.modelCalls(), 0, 'a blank-Session title refresh starts no model turn')
    const sessions = fixture.ctx.get('sessions') as unknown as { get(id: string): unknown }
    const titles = fixture.ctx.get('sessionTitle') as unknown as {
      get(session: unknown): { title: string } | undefined
    }
    assert.equal(titles.get(sessions.get('b2a-blank-title')), undefined,
      'no title was invented for the blank Session')
  } finally {
    await fixture.settle()
  }
})

// ── A06: /copy ──────────────────────────────────────────────────────────────

test('/copy emits the OSC 52 sequence for the authoritative last assistant text', async (t) => {
  // On macOS/Windows the shared policy attempts the native helper
  // UNCONDITIONALLY, so driving the real copy here would write the synthetic
  // text into the developer's clipboard: the case is skipped there instead.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    t.skip('the native clipboard helper is attempted unconditionally on this platform')
    return
  }
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const assistantText = 'COPY-ME-B2A-42'
  const fixture = await createDirectTspFixture(life, { deltas: [assistantText] })
  try {
    await waitForInputDelivery(fixture.pane)
    await seedTurn(fixture, 'produce a copyable answer')
    // The copy target is the AUTHORITATIVE last assistant text, not the
    // rendered window: assert the delivered text is what the policy received.
    // The assertion is TMUX-agnostic: the tmux form wraps the same OSC 52 body
    // in a DCS passthrough, so the payload and the `]52;c;` marker identify the
    // emission either way (the suite must also pass when run inside tmux).
    const payload = Buffer.from(assistantText, 'utf8').toString('base64')
    // The positive case exercises the terminal-client (OSC 52) leg ONLY: the
    // POSIX/macOS/Windows platform-helper gates are cleared for this gesture
    // (restored below) so the suite never writes its synthetic text into a
    // developer's real clipboard.
    const helperEnvKeys = ['TMUX', 'DISPLAY', 'WAYLAND_DISPLAY'] as const
    const savedHelperEnv = helperEnvKeys.map(key => [key, process.env[key]] as const)
    for (const key of helperEnvKeys) delete process.env[key]
    try {
      await submitInput(fixture, '/copy')
      await waitFor('the copy success notice', () =>
        dockNotices(fixture).some(text => text.includes('copied last assistant message')), 25_000)
    } finally {
      for (const [key, value] of savedHelperEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    // POSITIVE CONTROL: the assistant text the OSC 52 payload encodes is the
    // text the transcript actually shows, so the copy source is the real
    // session content and not an empty/foreign string.
    assert.ok(fixture.pane.output.text().includes(assistantText),
      'the copied assistant text is the session content the client presents')
    assert.ok(fixture.pane.output.text().includes(']52;c;')
      && fixture.pane.output.text().includes(payload),
      'the client-local OSC 52 leg emitted the authoritative assistant text')
  } finally {
    await fixture.settle()
  }
})

test('/copy without an assistant message fails visibly and copies nothing', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['UNUSED'] })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    await submitInput(fixture, '/copy')
    // The refusal's existing owner is the Direct command card (the TSP renderer
    // paints it), so it must be visible without a supplementary Dock line.
    await waitFor('the copy refusal card', () =>
      fixture.pane.output.text().includes('no assistant message yet'), 25_000)
    assert.ok(!fixture.pane.output.text().includes(']52;c;'),
      'the refused copy emitted no OSC 52 sequence')
    assert.equal(fixture.modelCalls(), 0, 'the refused copy never reached the model')
  } finally {
    await fixture.settle()
  }
})

test('/copy reports the shared policy failure when BOTH legs fail', async (t) => {
  // The shared policy attempts the native/platform helper on macOS and Windows
  // UNCONDITIONALLY (pbcopy/clip), so this e2e cannot make that leg fail there
  // without touching the developer's real clipboard: the case is skipped on
  // those platforms instead of faking a pass.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    t.skip('the native clipboard helper is attempted unconditionally on this platform')
    return
  }
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['COPY-BOTH-LEGS-FAIL'] })
  // The POSIX helper chain is gated on these exact environment facts, so
  // clearing them (restored below) makes the native leg deterministically
  // absent — no display, no tmux — while the OSC 52 leg is failed by the tty
  // fault below.
  const clipboardEnvKeys = ['TMUX', 'DISPLAY', 'WAYLAND_DISPLAY'] as const
  const savedClipboardEnv = clipboardEnvKeys.map(key => [key, process.env[key]] as const)
  // The one-to-one tty fault: the terminal-client leg throws on its OWN OSC 52
  // write (the real `emitTerminalClipboard` path catches it), and no tmux/display
  // helper exists here, so the shared policy settles `false`. The chunk that
  // carries the copy sequence is still forwarded for every other write.
  const stdout = process.stdout as unknown as { write(data: unknown): boolean }
  const stdoutPrototype = Object.getPrototypeOf(stdout) as Record<string, unknown>
  const hadOwnWrite = Object.prototype.hasOwnProperty.call(stdoutPrototype, 'write')
  const originalWrite = stdoutPrototype.write as (this: unknown, data: unknown) => boolean
  try {
    await waitForInputDelivery(fixture.pane)
    await seedTurn(fixture, 'produce an uncopyable answer')
    // Clear the POSIX helper gates only for THIS gesture (restored below).
    for (const key of clipboardEnvKeys) delete process.env[key]
    stdoutPrototype.write = function (this: unknown, data: unknown): boolean {
      if (typeof data === 'string' && data.includes(']52;c;')) {
        throw new Error('controlled tty write failure')
      }
      return originalWrite.call(this, data)
    }
    await submitInput(fixture, '/copy')
    // The failure is the Direct command card's (its existing owner), and it is
    // never reported as a successful copy.
    await waitFor('the copy failure card', () =>
      fixture.pane.output.text().includes('failed to copy last assistant message'), 25_000)
    assert.ok(!dockNotices(fixture).some(text => text.includes('copied last assistant message')),
      'a both-legs-failed copy never reports success')
  } finally {
    if (hadOwnWrite) stdoutPrototype.write = originalWrite
    else delete stdoutPrototype.write
    for (const [key, value] of savedClipboardEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fixture.settle()
  }
})

// ── A07: /yolo ──────────────────────────────────────────────────────────────

test('sessionless /yolo reports the unavailable official permission writer', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A07'] })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    await submitInput(fixture, '/yolo')
    // No permission-presets service is composed in this fixture: the REAL
    // writer reports `unavailable`, the handler returns the ORIGINAL message
    // and the Direct command card shows it (never an optimistic success, and
    // no extra Dock line).
    await waitFor('the /yolo unavailability card', () =>
      fixture.pane.output.text().includes('unavailable'), 25_000)
    assert.ok(!dockNotices(fixture).some(text => text.includes('approvals off')),
      'an unavailable permission writer never reports success')
  } finally {
    await fixture.settle()
  }
})

test('/yolo applies danger-full-access through the official permission writer', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['A07-APPLIED'],
    officialServices: { permissionPresets: true },
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const sessionId = welcomeSessionIds(fixture)[0]!
    const permissions = fixture.ctx.get('permissionPresets') as unknown as { names: readonly string[] }
    assert.ok(permissions.names.includes('danger-full-access'),
      'the official preset table offers danger-full-access')
    await submitInput(fixture, '/yolo')
    await waitFor('the /yolo applied notice', () =>
      dockNotices(fixture).some(text => text.includes('danger-full-access — approvals off')), 30_000)
    const sessions = fixture.ctx.get('sessions') as unknown as { get(id: string): unknown }
    const approval = fixture.ctx.get('approval') as unknown as {
      overrideOf(session: unknown): string | undefined
    }
    assert.equal(approval.overrideOf(sessions.get(sessionId)), 'never',
      'the authoritative approval policy of the live Session is the danger-full-access override')
  } finally {
    await fixture.settle()
  }
})

// ── A08/A10/A11: /logout ────────────────────────────────────────────────────

test('/logout <reference> is refused on the TSP renderer and never mutates the credential', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A08'] })
  const secret = 'sk-b2a-secret-value'
  const ref = 'DEEPSEEK_API_KEY'
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const credentials = fixture.ctx.get('credentials') as unknown as {
      set(ref: string, value: string): Promise<void>
      resolve(ref: string): Promise<{ readonly value?: string } | undefined>
    }
    await credentials.set(ref, secret)
    assert.notEqual(await credentials.resolve(ref), undefined, 'the credential is stored before the gesture')
    // The official route name resolves to its apiKeyEnv reference through the
    // handler's OWN resolver (never a name guess by the gate).
    await submitInput(fixture, '/logout deepseek')
    await waitFor('the TSP workspace refusal', () =>
      fixture.pane.output.text().includes('Settings Models/Account workspace is not available in this renderer'), 25_000)
    assert.notEqual(await credentials.resolve(ref), undefined,
      'the TSP refusal never clears the stored reference')
    assert.ok(!fixture.pane.output.text().includes(secret),
      'no message on the wire ever carries the credential VALUE')
    assert.ok(!fixture.pane.output.text().includes(`API key ${ref} cleared`),
      'the TSP renderer never reports a credential as cleared')
  } finally {
    await fixture.settle()
  }
})

test('a composition without the credentials service reports the refusal and mutates nothing', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  // The negative composition: the deployment mounts no credentials provider, so
  // the port's `available()` is false and the handler must refuse truthfully.
  const fixture = await createDirectTspFixture(life, { deltas: ['A08-PORT'], withoutCredentials: true })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    await submitInput(fixture, '/logout deepseek')
    await waitFor('the unavailable-port card', () =>
      fixture.pane.output.text().includes('credentials service unavailable'), 25_000)
    assert.equal(fixture.ctx.get('credentials'), undefined,
      'this composition really mounts no credentials service')
    assert.ok(!fixture.pane.output.text().includes('cleared'),
      'the refused logout never reports a credential as cleared')
  } finally {
    await fixture.settle()
  }
})

test('the TSP refusal never reaches a throwing credential port', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A08-THROW'] })
  const ref = 'DEEPSEEK_API_KEY'
  const secret = 'sk-b2a-throw-secret'
  const { symbols } = await import('@deepseek-ai/cordis')
  const proxied = fixture.ctx.get('credentials') as unknown as Record<symbol, unknown>
  const service = (proxied[symbols.original] ?? proxied) as unknown as {
    set(ref: string, value: string): Promise<void>
    resolve(ref: string): Promise<unknown>
  }
  // One-to-one fault on the PRODUCTION service's `unset`: the port forwards the
  // throw (it has no catch), so the existing command-error path must report it
  // and never claim a clear.
  const prototype = Object.getPrototypeOf(service) as Record<string, unknown>
  const hadOwnUnset = Object.prototype.hasOwnProperty.call(prototype, 'unset')
  const originalUnset = prototype.unset
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    await service.set(ref, secret)
    prototype.unset = () => { throw new Error('controlled credential unset failure') }
    await submitInput(fixture, '/logout deepseek')
    await waitFor('the TSP workspace refusal', () =>
      fixture.pane.output.text().includes('Settings Models/Account workspace is not available in this renderer'), 25_000)
    assert.ok(!fixture.pane.output.text().includes('cleared'),
      'the TSP refusal is never reported as a cleared credential')
    assert.notEqual(await service.resolve(ref), undefined,
      'the stored reference survives the TSP refusal without calling unset')
  } finally {
    if (hadOwnUnset) prototype.unset = originalUnset
    else delete prototype.unset
    await fixture.settle()
  }
})

test('bare /logout is refused by the gate — no picker, no credential mutation', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A10'] })
  const ref = 'DEEPSEEK_API_KEY'
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const credentials = fixture.ctx.get('credentials') as unknown as {
      set(ref: string, value: string): Promise<void>
      resolve(ref: string): Promise<unknown>
    }
    await credentials.set(ref, 'sk-keep-me')
    await submitInput(fixture, '/logout')
    await waitFor('the bare /logout refusal', () =>
      dockNotices(fixture).some(text => text.includes('not available in TSP')), 25_000)
    assert.equal(dockNotices(fixture).filter(text => text.includes('not available in TSP')).length, 1,
      'the gate refusal is reported EXACTLY once on the Dock (no duplicate notice)')
    assert.equal(composerText(fixture), '/logout', 'the refused line is the live draft again')
    assert.notEqual(await credentials.resolve(ref), undefined, 'the refusal mutated no credential')
    assert.ok(!fixture.pane.output.text().includes('logout · credentials'),
      'the bare refusal opened no credential picker')
    // The WHITESPACE-ONLY form is refused by the same shape rule, end to end.
    await clearComposer(fixture)
    const seqBeforeWhitespace = lastNoticeSeq(fixture)
    await submitInput(fixture, '/logout   ')
    await waitFor('the whitespace-only refusal', () =>
      lastNoticeSeq(fixture) > seqBeforeWhitespace
      && dockNotices(fixture).some(text => text.includes('not available in TSP')), 25_000)
    assert.equal(composerText(fixture), '/logout   ', 'the whitespace-only line is the live draft again')
    assert.notEqual(await credentials.resolve(ref), undefined, 'the whitespace-only refusal mutated no credential')
  } finally {
    await fixture.settle()
  }
})

test('/logout with an unresolvable target reports the real unknown-target error', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A11'] })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    // A hyphenated target can be neither a route nor an env-var-shaped
    // reference: the handler's own resolver reports it (never the bare UI),
    // and the Direct command card carries the message.
    await submitInput(fixture, '/logout No-Such-Route')
    await waitFor('the unknown-target card', () =>
      fixture.pane.output.text().includes('unknown credential target'), 25_000)
  } finally {
    await fixture.settle()
  }
})

// ── A13: the unchanged refusal matrix ───────────────────────────────────────

test('every remaining PiTui-only builtin stays refused with the draft restored', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A13'] })
  // `/attach` and `/image` are deliberately NOT here: they are Client-local
  // intake commands that the mounted composer can complete without any PiTui
  // chrome, so the capability gate admits them (their own case is below).
  const refused = [
    '/settings', '/help', '/status', '/rewind', '/tasks', '/subagents', '/plugins', '/reload',
    '/export', '/transcript',
    '/login', '/skill', '/display', '/focus', '/footer', '/statusline', '/keybindings',
  ]
  try {
    await waitForInputDelivery(fixture.pane)
    for (const line of refused) {
      const noticeBefore = lastNoticeSeq(fixture)
      await submitInput(fixture, line)
      await waitFor(`the refusal for ${line}`, () =>
        lastNoticeSeq(fixture) > noticeBefore
        && dockNotices(fixture).some(text => text.includes('not available in TSP')), 25_000)
      assert.equal(composerText(fixture), line, `${line} restores its draft`)
      await clearComposer(fixture)
    }
    assert.deepEqual(welcomeSessionIds(fixture), [], 'no refused builtin created a Session')
    assert.equal(fixture.modelCalls(), 0, 'no refused builtin reached the model')
  } finally {
    await fixture.settle()
  }
})

// ── Sessionless synchronous refusals are classified as errors ───────────────

test('a sessionless /image with no argument shows ONE error-marked refusal and creates no Session', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['SESSIONLESS-IMAGE-REFUSAL'] })
  await waitForInputDelivery(fixture.pane)
  // NO Session exists yet: this line takes the SESSIONLESS local route, not the
  // card-less Client-registry one, so it exercises the OTHER refusal owner.
  await submitInput(fixture, '/image')
  await waitFor('the usage refusal', () =>
    dockNotices(fixture).some(text => text.includes('Usage: /image <path>')), 25_000)
  // The Dock marks ONLY kind === 'error' with `!`, so the marker is the witness
  // that the returned CommandResult.error kept its error classification.
  const refusalLines = dockNotices(fixture).filter(text => text.includes('Usage: /image <path>'))
  assert.equal(refusalLines.length, 1, 'exactly ONE refusal notice, never a duplicate')
  assert.ok(refusalLines[0]!.startsWith('! '),
    `the refusal is classified as an error: ${JSON.stringify(refusalLines)}`)
  assert.deepEqual(welcomeSessionIds(fixture), [], 'the refused intake created no Session')
  assert.equal(fixture.modelCalls(), 0, 'the refused intake never reached the model')
})

test('a sessionless /attach with no argument shows ONE error-marked refusal and creates no Session', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['SESSIONLESS-ATTACH-REFUSAL'] })
  await waitForInputDelivery(fixture.pane)
  await submitInput(fixture, '/attach')
  await waitFor('the usage refusal', () =>
    dockNotices(fixture).some(text => text.includes('Usage: /attach <path>')), 25_000)
  const refusalLines = dockNotices(fixture).filter(text => text.includes('Usage: /attach <path>'))
  assert.equal(refusalLines.length, 1, 'exactly ONE refusal notice, never a duplicate')
  assert.ok(refusalLines[0]!.startsWith('! '),
    `the refusal is classified as an error: ${JSON.stringify(refusalLines)}`)
  assert.deepEqual(welcomeSessionIds(fixture), [], 'the refused intake created no Session')
  assert.equal(fixture.modelCalls(), 0, 'the refused intake never reached the model')
})

// ── The Client-local attachment intake on the mounted composer ──────────────

test('a real /attach of a regular file stages metadata and inserts the canonical token into the mounted composer', async (t) => {
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ATTACH-INTAKE'] })
  // Teardown is registered on `life` by the fixture itself, so this case needs
  // no explicit settle step of its own.
  const file = join(fixture.workRoot, 'report.pdf')
  writeFileSync(file, Buffer.from('%PDF-1.7 report'))
  await waitForInputDelivery(fixture.pane)
  await submitInput(fixture, `/attach ${file}`)
  // The success notice is published by the INTAKE, after the metadata draft
  // exists and its token was inserted — never by the synchronous command
  // result (the card-less result scope is error-only).
  await waitFor('the attach success notice', () =>
    dockNotices(fixture).some(text => text.includes('attached [file #1')), 25_000)
  // The token is in the MOUNTED composer: the TSP renderer's own draft seat,
  // which is the whole point of the composer seam.
  await waitFor('the canonical file token in the composer', () =>
    (composerText(fixture) ?? '').includes('[file #1 ('), 25_000)
  assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
    'the Client-local intake is admitted instead of refused')
  assert.deepEqual(welcomeSessionIds(fixture), [], 'the intake created no Session')
  assert.equal(fixture.modelCalls(), 0, 'the intake never reached the model')
})

test('a real /attach of a missing path reports the real Client-local error and stages nothing', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['ATTACH-MISSING'] })
  await waitForInputDelivery(fixture.pane)
  await submitInput(fixture, '/attach no-such-file-here.bin')
  await waitFor('the not-found notice', () =>
    dockNotices(fixture).some(text => text.includes('File not found: no-such-file-here.bin')), 25_000)
  assert.equal(composerText(fixture), '', 'no canonical token was inserted for a failed probe')
  assert.deepEqual(welcomeSessionIds(fixture), [], 'a failed intake created no Session')
  assert.equal(fixture.modelCalls(), 0)
})

// ── A09: the flow-route logout branch (capability absent here) ──────────────

test('/logout <flow-route> is refused truthfully while no flow provider is installed', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  // The REAL authorization seam is mounted; this environment installs no
  // provider plugin that registers a flow, so the flow branch has no route to
  // resolve. The handler must report the real unknown-target error and mutate
  // nothing — a simulated flow is explicitly NOT evidence for this case.
  const fixture = await createDirectTspFixture(life, {
    deltas: ['A09'],
    officialServices: { authorization: true },
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const authorization = fixture.ctx.get('authorization') as unknown as { list(): readonly unknown[] }
    assert.deepEqual([...authorization.list()], [],
      'no authorization flow provider is installed in this environment')
    const credentials = fixture.ctx.get('credentials') as unknown as {
      listRecords(): Promise<readonly unknown[]>
    }
    assert.deepEqual([...await credentials.listRecords()], [], 'no credential record exists before the gesture')
    // A keyless-flow ROUTE name is hyphenated: it can be neither a provider
    // route (none is configured) nor an env-var-shaped reference, so it is the
    // only input shape that reaches the handler's `flowForRoute` branch.
    await submitInput(fixture, '/logout openai-codex')
    // The refusal's existing owner is the Direct command card.
    await waitFor('the unknown-target card', () =>
      fixture.pane.output.text().includes('unknown credential target'), 25_000)
    assert.deepEqual([...await credentials.listRecords()], [], 'the refused flow logout stored/deleted no record')
    assert.ok(!dockNotices(fixture).some(text => text.includes('signed out locally')),
      'a flowless deployment never reports a stored credential as cleared')
  } finally {
    await fixture.settle()
  }
})

// ── A16: a no-panel TUI builtin is never steered into the running turn ──────

test('a no-panel TUI builtin executes locally while the turn runs (busyEnter=steer)', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  let releaseStream!: () => void
  const held = new Promise<void>(resolve => { releaseStream = resolve })
  const fixture = await createDirectTspFixture(life, {
    deltas: ['A16-LATE'],
    streamHold: () => held,
    tuiConfig: { busyEnter: 'steer' },
    officialServices: { sessionTitle: true },
  })
  const writes = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    // seedTurn already waits for the AUTHORITATIVE running-turn fact (the real
    // model request). TSP-7 PR-A retired the dock banner, so there is no banner
    // word left to wait for.
    const sessionId = await seedTurn(fixture, 'hold the turn open')
    const writesBefore = writes.calls()
    await submitInput(fixture, '/title While the turn runs')
    await waitFor('the title write while running', () =>
      fixture.pane.output.text().includes('title set: While the turn runs'), 25_000)
    assert.equal(writes.calls(), writesBefore, 'the command produced NO prompt write (it was never steered)')
    assert.equal(sessionTitle(fixture, sessionId), 'While the turn runs',
      'the command ran through its real business owner while the turn was running')
    // The plain prompt keeps the configured busy policy (steer).
    await submitInput(fixture, 'a plain busy prompt')
    await waitFor('the busy steer write', () => writes.calls() === writesBefore + 1, 25_000)
  } finally {
    releaseStream()
    writes.detach()
    await fixture.settle()
  }
})

// ── F5: a late command outcome never lands on the replacement owner ────────

test('a /copy success that outlives its Session is not announced on the replacement', async (t) => {
  // POSIX only: the deterministic interleave needs a controllable native
  // clipboard helper (macOS/Windows attempt theirs unconditionally).
  if (process.platform === 'darwin' || process.platform === 'win32') {
    t.skip('the native clipboard helper is attempted unconditionally on this platform')
    return
  }
  const { existsSync, readFileSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const workDir = life.tempDir('b2a-f5-clip-')
  const binDir = life.tempDir('b2a-f5-bin-')
  const capturePath = join(workDir, 'capture.txt')
  const enteredPath = join(workDir, 'entered')
  const releasePath = join(workDir, 'release')
  const exitedPath = join(workDir, 'exited')
  // The helper captures its stdin (the copy text), publishes an ENTERED marker,
  // then blocks until the release marker exists. `entered` is the synchronization
  // proof that the copy really is inside the clipboard policy on A's text before
  // the switch is allowed to publish.
  writeFileSync(join(binDir, 'xclip'), [
    '#!/bin/sh',
    `cat > "${capturePath}"`,
    `: > "${enteredPath}"`,
    `while [ ! -f "${releasePath}" ]; do sleep 0.02; done`,
    `: > "${exitedPath}"`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  const saved = {
    PATH: process.env.PATH,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    TMUX: process.env.TMUX,
  }
  process.env.PATH = `${binDir}:${saved.PATH ?? ''}`
  process.env.DISPLAY = ':0'
  delete process.env.TMUX
  delete process.env.WAYLAND_DISPLAY
  life.defer(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const fixture = await createDirectTspFixture(life, {
    deltas: ['F5-COPY-TEXT'],
    sessionBrowser: true,
    persistedBlankSession: { id: 'f5-target-b' },
  })
  try {
    await waitForInputDelivery(fixture.pane)
    const source = await seedTurn(fixture, 'seed the F5 copy source')
    const sessionEvents = (sessionId: string): Array<{ type: string }> => {
      const sessions = fixture.ctx.get('sessions') as unknown as {
        get(id: string): { snapshotEvents(): Array<{ type: string }> }
      }
      return sessions.get(sessionId)?.snapshotEvents() ?? []
    }
    // Hold the switch INSIDE the official resume so it publishes later.
    const agents = fixture.ctx.get('agents') as unknown as {
      resume(options: unknown): Promise<unknown>
    }
    const originalResume = agents.resume
    let resumeEntered = false
    let releaseResume!: () => void
    const resumeGate = new Promise<void>(resolve => { releaseResume = resolve })
    agents.resume = async function (this: unknown, options: unknown): Promise<unknown> {
      resumeEntered = true
      await resumeGate
      return originalResume.call(this, options)
    }
    life.defer(() => { agents.resume = originalResume })
    // The Browser settles its handler without waiting for the switch, so the
    // FIFO is free while the transition is still in flight.
    // PR-C: direct `/resume` now waits for its tracked switch settlement. Use
    // the independent Browser selection (a non-FIFO navigation entry) to start
    // the gated switch, then close the Browser so `/copy` can run on A while
    // the switch is still held.
    await submitInput(fixture, '/sessions')
    await waitFor('the Session Browser is ready', () => pickerNode(fixture.pane, 'session-browser-') !== undefined, 25_000)
    const browserId = pickerNode(fixture.pane, 'session-browser-')!.id
    sendAction(fixture.pane, 'scope', 'all', browserId)
    await waitFor('the target row is listed', () => {
      const items = (pickerProps(fixture.pane, 'session-browser-').items ?? []) as Array<{ id?: unknown }>
      return items.some(item => String(item.id).includes('f5-target-b'))
    }, 25_000)
    const targetItem = (pickerProps(fixture.pane, 'session-browser-').items as Array<{ id?: unknown }>)
      .find(item => String(item.id).includes('f5-target-b'))!
    sendActivate(fixture.pane, String(targetItem.id), pickerNode(fixture.pane, 'session-browser-')!.id)
    await waitFor('the resume to be entered', () => resumeEntered, 25_000)
    fixture.pane.key('\x1b')
    await waitFor('the Browser closes while the switch stays held', () => pickerNode(fixture.pane, 'session-browser-') === undefined, 25_000)
    await submitInput(fixture, '/copy')
    // SYNCHRONIZATION PROOF: the copy is INSIDE the native clipboard helper and
    // already carries A's assistant text before the switch may publish. Without
    // this wait the test could pass without ever creating the race.
    await waitFor('the copy to reach the blocked clipboard helper', () => existsSync(enteredPath), 25_000)
    const captured = readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes('F5-COPY-TEXT'),
      'the blocked helper really received A\'s assistant text (the copy pinned A)')
    releaseResume()
    await waitFor('the replacement Session to become current', () =>
      welcomeSessionIds(fixture).includes('f5-target-b'), 30_000)
    writeFileSync(releasePath, '')
    // The helper writes `exited` just before it returns 0, so waiting for it
    // proves the copy policy (and therefore the handler) really completed.
    await waitFor('the stale copy to complete', () => existsSync(exitedPath), 25_000)
    await directSettle(600)
    assert.ok(!dockNotices(fixture).some(text => text.includes('copied last assistant message')),
      'the late success is not announced on the replacement owner')
    assert.ok(welcomeSessionIds(fixture).includes('f5-target-b'),
      'the switch really completed (the stale outcome was fenced, not the switch)')
    // POSITIVE CONTROL: on the SAME (now current) Session the success notice
    // still appears exactly once — the fence is not an unconditional silence.
    const modelBefore = fixture.modelCalls()
    await submitInput(fixture, 'a prompt on the replacement session')
    await waitFor('the replacement session turn', () => fixture.modelCalls() > modelBefore, 25_000)
    await directSettle(1_200)
    const noticesBefore = dockNotices(fixture).filter(text => text.includes('copied last assistant message')).length
    await submitInput(fixture, '/copy')
    await waitFor('the same-session copy notice', () =>
      dockNotices(fixture).filter(text => text.includes('copied last assistant message')).length === noticesBefore + 1,
    25_000)
    assert.equal(
      dockNotices(fixture).filter(text => text.includes('copied last assistant message')).length,
      noticesBefore + 1,
      'a current owner receives the copy success exactly once')
  } finally {
    writeFileSync(releasePath, '')
    await fixture.settle()
  }
})

// ── F4: the result's visible owner is frozen at dispatch ───────────────────

test('a Host-route result keeps its own card when the Host claim is revoked mid-flight', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  let releaseHost!: () => void
  const hostGate = new Promise<void>(resolve => { releaseHost = resolve })
  // The genuine Host claim must exist BEFORE the runner boots (otherwise the
  // TUI's own compatibility mirror owns the name). Its handler waits for the
  // gate so the claim can be revoked mid-flight.
  const fixture = await createDirectTspFixture(life, {
    deltas: ['F4-HOST'],
    hostCommands: [{
      name: 'copy',
      description: 'gated genuine Host copy',
      handler: async () => {
        await hostGate
        return { kind: 'error', text: 'host copy failed mid-flight' }
      },
    }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    const sessionId = await seedTurn(fixture, 'seed the F4 host route')
    const sessionEvents = (): Array<{ type: string }> => {
      const sessions = fixture.ctx.get('sessions') as unknown as {
        get(id: string): { snapshotEvents(): Array<{ type: string }> }
      }
      return sessions.get(sessionId)?.snapshotEvents() ?? []
    }
    await submitInput(fixture, '/copy')
    await waitFor('the Host route to be entered', () => sessionEvents().some(event => event.type === 'command/run'), 25_000)
    // MID-FLIGHT REVOCATION: the claim disappears while the Host handler runs.
    // A settlement-time re-classification would now read /copy as Client-owned
    // and repeat the error beside the Host card.
    for (const dispose of fixture.hostCommandDisposers) dispose()
    await directSettle(800)
    releaseHost()
    await waitFor('the Host command to settle', () => sessionEvents().some(event => event.type === 'command/done'), 25_000)
    await directSettle(600)
    assert.equal(
      dockNotices(fixture).filter(text => text.includes('host copy failed mid-flight')).length, 0,
      'the Host result card owns the error; no extra Dock line is published')
    assert.equal(sessionEvents().filter(event => event.type === 'command/run').length, 1,
      'exactly one Host command/run row exists (its own card)')
  } finally {
    await fixture.settle()
  }
})

// ── A14: genuine Host same-name winners ─────────────────────────────────────

test('genuine Host /new, /copy, /logout, /title and /rename keep their Host sink', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const calls: string[] = []
  const names = ['new', 'copy', 'logout', 'title', 'rename'] as const
  const fixture = await createDirectTspFixture(life, {
    deltas: ['A14'],
    hostCommands: names.map(name => ({
      name,
      description: `Host-owned ${name}`,
      definitionId: `host-${name}-definition`,
      handler: (invocation: { readonly rawInput: string }) => {
        calls.push(`${name}:${invocation.rawInput}`)
        return { kind: 'success', text: `Host ${name} ran` }
      },
    })),
  })
  try {
    await waitForInputDelivery(fixture.pane)
    // An execute-kind Host descriptor claims its BARE token only (the official
    // `matchEnter` rule), so the genuine-winner control uses the bare lines.
    for (const name of names) {
      await submitInput(fixture, `/${name}`)
      await waitFor(`the genuine Host /${name} sink`, () => calls.length === names.indexOf(name) + 1, 25_000)
    }
    assert.deepEqual(calls, names.map(name => `${name}:`),
      'every genuine Host handler ran once, and the TUI handler ran for none of them')
    // The Host command path lazily ensures ONE Session for the session-keyed
    // Host surface. A TUI `/new` handler running here would have published a
    // SECOND Session; a TUI `/title` or `/rename` handler would have surfaced
    // its own (successful or refused) title notice.
    const headers = await sessionHeaders(fixture)
    assert.equal(headers.length, 1, 'the TUI /new handler never created an extra Session')
    assert.ok(!dockNotices(fixture).some(text => text.includes('title set:') || text.includes('title regenerated:') || text.includes('renaming is unavailable')),
      'the TUI /title and /rename handlers never ran')
    assert.equal(fixture.modelCalls(), 0, 'no Host winner reached the model')
    assert.ok(!fixture.pane.output.text().includes(']52;c;'),
      'the Host /copy winner never ran the TUI clipboard policy')
    assert.ok(!dockNotices(fixture).some(text => text.includes('cleared')),
      'the Host /logout winner never ran the TUI credential path')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'the TSP gate never captured a genuine Host winner')
  } finally {
    await fixture.settle()
  }
})

test('an argued line of a genuine Host execute-kind command stays an ordinary prompt', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const calls: string[] = []
  // A genuine Host name that does NOT claim the argued line (an execute-kind
  // descriptor without `input`): the production classifier must classify the
  // line as an ordinary submission — never re-own it as the TUI builtin.
  const fixture = await createDirectTspFixture(life, {
    deltas: ['ARGUED-ORDINARY'],
    hostCommands: [{
      name: 'new',
      description: 'Host-owned new (execute kind, no input descriptor)',
      definitionId: 'host-new-definition',
      handler: (invocation: { readonly rawInput: string }) => {
        calls.push(invocation.rawInput)
        return { kind: 'success', text: 'Host new ran' }
      },
    }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, '/new argued-line')
    // The line reached the MODEL as a prompt (the ordinary-submission route).
    await waitFor('the ordinary prompt turn', () => fixture.modelCalls() === 1, 25_000)
    await waitFor('the prompt transcript row', () =>
      fixture.pane.output.text().includes('ARGUED-ORDINARY'), 25_000)
    assert.deepEqual(calls, [], 'the unclaimed argued line never reached the Host handler')
    assert.equal((await sessionHeaders(fixture)).length, 1,
      'exactly the prompt Session exists; the TUI /new handler created no second one')
    assert.ok(!fixture.pane.output.text().includes('not available in TSP'),
      'an ordinary argued line is never refused as a TSP builtin')
  } finally {
    await fixture.settle()
  }
})

// ── The post-boot delivery boundary ──────────────────────────────────────────

test('the post-boot wait observes the tty input DELIVERY boundary, not a fixed slice', async (t) => {
  // The post-boot wait used to be a fixed 4-second sleep. It is now the
  // delivery boundary: the shipped Tern SDK attaches its stdin listener only
  // after the hello handshake, and the scripted pane DROPS a `data` event that
  // has no listener. So the listener registration IS the input-delivery
  // fact, and a key typed before it is lost rather than merely unhandled.
  //
  // This lock proves the boundary is real in BOTH directions: a key typed
  // BEFORE the boundary never arrives, and a key typed AFTER it does — so
  // the wait cannot be replaced by an arbitrary delay.
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['DELIVERY'] })
  try {
    // BEFORE the boundary: the SDK has not attached its listener yet.
    assert.equal(fixture.pane.input.listenerCount('data'), 0,
      'the SDK attaches its stdin listener only after the hello handshake')
    fixture.pane.input.type('lost')
    await waitForInputDelivery(fixture.pane)
    // The lost key never reached the composer.
    assert.equal(composerText(fixture), undefined,
      'a key typed before the SDK attached its listener is lost, never buffered')

    // AFTER the boundary: the key is delivered (the renderer holds it until
    // the one input bind and replays it).
    fixture.pane.input.type('kept')
    await waitFor('the delivered key to reach the composer', () => composerText(fixture) === 'kept', 25_000)
  } finally {
    await fixture.settle()
  }
})

test('Busy Esc preserves the REAL Direct Host pending inbox while a REAL admitted Host-command writer holds a frozen /new transition', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  let releaseHold!: () => void
  const hold = new Promise<void>(resolve => { releaseHold = resolve })
  let releaseSlow!: () => void
  const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })
  let slowStarted = false
  const fixture = await createDirectTspFixture(life, {
    deltas: ['PR-A real host'],
    streamHold: () => hold,
    tuiConfig: { busyEnter: 'queue' },
    hostCommands: [{
      name: 'slowcmd',
      description: 'hold the admitted writer',
      handler: async () => {
        slowStarted = true
        await slowGate
        return { kind: 'success' }
      },
    }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, 'opener marker')
    await waitFor('the real Direct session', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const oldId = welcomeSessionIds(fixture)[0]!
    const agents = fixture.ctx.get('agents') as unknown as {
      get(id: SessionId): {
        readonly status: string
        readonly inbox: {
          readonly nextTurn: readonly unknown[]
          readonly nextStep: readonly unknown[]
        }
      } | undefined
    }
    await waitFor('the real turn running', () => agents.get(SessionId(oldId))?.status === 'running', 25_000)
    const inboxHas = (sessionId: string, marker: string): boolean => {
      const agent = agents.get(SessionId(sessionId))
      if (agent === undefined) return false
      return [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
        .some(item => JSON.stringify(item).includes(marker))
    }

    // The real Host-owned queue: Enter while the real Agent runs queues the
    // message in the official inbox.
    await submitInput(fixture, 'queued marker')
    await waitFor('the real pending queue occurrence', () => inboxHas(oldId, 'queued marker'), 25_000)

    // A real admitted Host-command writer holds the ordinary-writer barrier.
    await submitInput(fixture, '/slowcmd')
    await waitFor('the real Host command handler admitted', () => slowStarted, 25_000)

    // Observe the real /new transition freeze on that writer.
    const originalRunTransition = SessionOperationBarrier.prototype.runTransition
    let frozen = false
    let bodyRan = false
    SessionOperationBarrier.prototype.runTransition = function <T>(
      this: SessionOperationBarrier,
      fn: () => Promise<T>,
      stopOldOwner?: () => Promise<void>,
    ): Promise<T> {
      const promise = originalRunTransition.call(this, async () => {
        bodyRan = true
        return fn()
      }, stopOldOwner) as Promise<T>
      if (this.activeWriters > 0) frozen = true
      return promise
    }
    life.defer(() => { SessionOperationBarrier.prototype.runTransition = originalRunTransition })

    // Record the durable flush -> child create order on the REAL Host services.
    const sessions = fixture.ctx.get('sessions') as unknown as { flush: (session?: unknown) => Promise<unknown> }
    const originalFlush = sessions.flush
    const order: string[] = []
    sessions.flush = async function (this: unknown, session?: unknown) {
      order.push(`flush:${(session as { id?: string } | undefined)?.id ?? '?'}`)
      return originalFlush.call(this, session)
    }
    const realAgents = fixture.ctx.get('agents') as unknown as {
      create: (options: { sessionId: string }) => Promise<unknown>
    }
    const originalCreate = realAgents.create
    realAgents.create = async function (this: unknown, options) {
      order.push(`create:${options.sessionId}`)
      return originalCreate.call(this, options)
    }
    life.defer(() => {
      sessions.flush = originalFlush
      realAgents.create = originalCreate
    })

    // The real registered /new command entry (the production handler).
    const commands = fixture.ctx.get('commands') as {
      find(agent: unknown, name: string): { handler: (invocation: unknown) => unknown } | undefined
    }
    const newDefinition = commands.find(undefined, 'new')
    assert.ok(newDefinition, 'the real TUI /new handler must be registered in the Host registry')
    // Record EVERY cancel the real Agent receives, with its options, by
    // shadowing the production instance method and forwarding unchanged (never
    // `.bind`, so the real receiver and the original function identity are
    // preserved): the navigation stop and the Busy Esc control stop must BOTH
    // be visible even after the first one already ended the held request.
    const realOldAgent = agents.get(SessionId(oldId)) as unknown as {
      cancel: (cause: unknown, options?: { keepInbox?: boolean }) => void
    }
    const originalCancel = realOldAgent.cancel
    const cancelCalls: Array<{ keepInbox: boolean | undefined }> = []
    realOldAgent.cancel = function recordedCancel(
      this: unknown,
      cause: unknown,
      options?: { keepInbox?: boolean },
    ): void {
      cancelCalls.push({ keepInbox: options?.keepInbox })
      originalCancel.call(this, cause, options)
    }
    life.defer(() => { realOldAgent.cancel = originalCancel })
    const transition = Promise.resolve(newDefinition.handler({
      commandId: 'cmd-pra-real-new',
      agent: undefined,
      rawInput: '',
      signal: new AbortController().signal,
    }))
    await waitFor('the real /new transition froze on the admitted writer', () => frozen, 25_000)
    assert.equal(bodyRan, false, 'the transition body must still be waiting for the real writer')

    // The navigation stop lands at admission: the OLD turn's held model
    // request observes the cancel while the admitted writer is STILL draining,
    // and before the transition body runs.
    await waitFor('the /new navigation stop cancelled the held turn', () => fixture.cancellations() === 1, 25_000)
    assert.deepEqual(cancelCalls, [{ keepInbox: true }],
      'the navigation stop is ONE keepInbox user cancel of the exact old Agent, before any control Stop')
    assert.equal(bodyRan, false, 'the navigation stop must not shortcut the real writer drain')
    assert.ok(inboxHas(oldId, 'queued marker'),
      'the REAL Direct Host pending inbox preserves the queued occurrence across the navigation stop')

    // The real Busy Esc: TSP pane input -> application onCancel -> the real
    // SessionRuntime.interrupt -> the exact real Direct Agent cancel.
    fixture.pane.key('\x1b')
    await waitFor('the Busy Esc control stop also reached the exact old Agent', () => cancelCalls.length === 2, 25_000)
    assert.deepEqual(cancelCalls[1], { keepInbox: true },
      'the control stop keeps the Host pending inbox even when the turn already ended')
    assert.equal(bodyRan, false, 'the control cancel must not shortcut the real writer drain')
    assert.ok(inboxHas(oldId, 'queued marker'),
      'the REAL Direct Host pending inbox preserves the queued occurrence across the control cancel')

    // Release the real writer: drain -> old flush -> child create/commit.
    releaseSlow()
    await transition
    await waitFor('the /new child session', () => {
      const ids = welcomeSessionIds(fixture)
      return ids.length === 1 && ids[0] !== oldId
    }, 25_000)
    const newId = welcomeSessionIds(fixture)[0]!
    assert.notEqual(newId, oldId)
    assert.ok(order.includes(`flush:${oldId}`), `the old session must be flushed: ${JSON.stringify(order)}`)
    assert.ok(order.includes(`create:${newId}`), `the child session must be created: ${JSON.stringify(order)}`)
    assert.ok(order.indexOf(`flush:${oldId}`) < order.indexOf(`create:${newId}`),
      `the old flush must precede the child create: ${JSON.stringify(order)}`)
    assert.ok(agents.get(SessionId(newId)) !== undefined, 'the new owner Agent must be live')
    assert.equal(inboxHas(newId, 'queued marker'), false,
      'the old queue is never transferred to the new Session')

    // The old durable history survives the retirement; the new Session exists.
    const headers = await sessionHeaders(fixture)
    assert.ok(headers.some(row => row.id === oldId), 'the old Session history remains persisted')
    assert.ok(headers.some(row => row.id === newId), 'the new Session is persisted')
    const query = fixture.ctx.get('sessionQuery') as unknown as {
      observeSession(id: SessionId): Promise<{ events: readonly { type: string; data?: unknown }[] }>
    }
    const oldLog = await query.observeSession(SessionId(oldId))
    assert.ok(oldLog.events.some(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('opener marker')),
      'the old Session keeps its durable user history')
    assert.ok(oldLog.events.some(event => event.type === 'turn/end'),
      'the cancelled old turn has a durable terminal boundary')
  } finally {
    releaseHold()
    releaseSlow()
    await fixture.settle() // bounded fixture teardown (not a fixed wait)
  }
})
test('a BUSY TSP /new submit runs the TUI navigation command, never Queue/Steer', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  let releaseHold!: () => void
  const hold = new Promise<void>(resolve => { releaseHold = resolve })
  const fixture = await createDirectTspFixture(life, {
    deltas: ['BUSY NEW'],
    streamHold: () => hold,
    tuiConfig: { busyEnter: 'queue' },
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, 'busy /new opener')
    await waitFor('the real Direct session', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const oldId = welcomeSessionIds(fixture)[0]!
    await waitFor('the real turn running', () => {
      const agents = fixture.ctx.get('agents') as unknown as {
        get(id: SessionId): { readonly status: string } | undefined
      }
      return agents.get(SessionId(oldId))?.status === 'running'
    }, 25_000)
    const modelCallsBefore = fixture.modelCalls()

    // The REAL busy Composer submit: if the line were misrouted as a queue or
    // steer prompt it would enter the Host inbox and later start a model turn.
    await submitInput(fixture, '/new')
    assert.equal(hostInboxHas(fixture, oldId, '/new'), false,
      'the /new line must never enter the Host queue or steering inbox')
    assert.equal(fixture.modelCalls(), modelCallsBefore, 'the /new line must never start a model turn')

    // The navigation stop cancels the held turn: the fresh Session is created
    // WITHOUT waiting for the hold to be released (a `/new` never waits for
    // the old Turn to finish naturally).
    await waitFor('the /new child session while the old stream is still held', () => {
      const ids = welcomeSessionIds(fixture)
      return ids.length === 1 && ids[0] !== oldId
    }, 25_000)
    assert.equal(fixture.cancellations(), 1,
      'the navigation stop is the cancellation that ended the held old turn')
    const newId = welcomeSessionIds(fixture)[0]!
    assert.notEqual(newId, oldId)
    assert.equal(fixture.modelCalls(), modelCallsBefore,
      'the /new line never became a queued prompt that started a second model turn')
  } finally {
    releaseHold()
    await fixture.settle() // bounded fixture teardown (not a fixed wait)
  }
})

test('a BUSY TSP /new with a genuine Host /new keeps the Host sink', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  let releaseHold!: () => void
  const hold = new Promise<void>(resolve => { releaseHold = resolve })
  const calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    deltas: ['HOST NEW'],
    streamHold: () => hold,
    tuiConfig: { busyEnter: 'queue' },
    hostCommands: [{
      name: 'new',
      description: 'Host-owned new',
      handler: () => { calls.push('host-new'); return { kind: 'success' } },
    }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await submitInput(fixture, 'busy host /new opener')
    await waitFor('the real Direct session', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const oldId = welcomeSessionIds(fixture)[0]!
    await waitFor('the real turn running', () => {
      const agents = fixture.ctx.get('agents') as unknown as {
        get(id: SessionId): { readonly status: string } | undefined
      }
      return agents.get(SessionId(oldId))?.status === 'running'
    }, 25_000)
    const modelCallsBefore = fixture.modelCalls()

    await submitInput(fixture, '/new')
    await waitFor('the genuine Host /new sink', () => calls.length === 1, 25_000)
    assert.deepEqual(welcomeSessionIds(fixture), [oldId],
      'the TUI /new navigation handler must not create a second Session when the Host wins')
    assert.equal(hostInboxHas(fixture, oldId, '/new'), false,
      'the genuine Host /new line must never become a queued prompt')
    assert.equal(fixture.modelCalls(), modelCallsBefore, 'the genuine Host /new must not start a model turn')
  } finally {
    releaseHold()
    await fixture.settle() // bounded fixture teardown (not a fixed wait)
  }
})

test('a real ask_user_question tool call settles ASK_ABORTED on the /new navigation cancel', async (t) => {
  const life = (await import('../support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['the question was cancelled'],
    // The REAL production tool invocation: the scripted model requests the
    // official ask-user tool, the production Agent loop executes it with its
    // OWN tool-call signal, and that tool takes that signal into
    // `userQuestions.ask` — no test-side signal bridge.
    scriptedToolCall: {
      callId: 'call-nav-question',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{ id: 'q-nav', question: 'Which target?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
      }),
    },
    officialServices: { askUserTool: true },
  })
  // Observe the PRODUCTION user-questions service instance the tool actually
  // calls. Unwrap the Cordis proxy, keep the real receiver and the original
  // function identity, and forward every settlement unchanged (one call ⇒ one
  // record): the test must assert the actual rejection code, not infer it from
  // the withdrawn modal.
  const questionsProxy = fixture.ctx.get('userQuestions') as unknown as {
    ask(request: unknown): Promise<unknown>
    readonly [symbols.original]?: unknown
  }
  const questions = (questionsProxy[symbols.original] ?? questionsProxy) as {
    ask(request: unknown): Promise<unknown>
  }
  const originalAsk = questions.ask
  const askFailures: Array<string | undefined> = []
  questions.ask = function recordedAsk(this: unknown, request: unknown): Promise<unknown> {
    return originalAsk.call(this, request).then(
      value => value,
      (error: unknown) => {
        askFailures.push(typeof error === 'object' && error !== null
          ? (error as { readonly code?: string }).code
          : undefined)
        throw error
      },
    )
  }
  life.defer(() => { questions.ask = originalAsk })
  try {
    await waitForInputDelivery(fixture.pane)
    // A real user turn: the model answers with the tool call, the Host executes
    // it and the official Question request blocks on the TUI answerer.
    await submitInput(fixture, 'ask me before you continue')
    await waitFor('the Session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    const oldId = welcomeSessionIds(fixture)[0]!
    await waitFor('the live official Question form', () => fixture.pane.output.text().includes('Which target?'), 30_000)
    const agents = fixture.ctx.get('agents') as unknown as {
      get(id: SessionId): { readonly status: string } | undefined
    }
    const oldAgent = agents.get(SessionId(oldId))
    assert.ok(oldAgent !== undefined, 'the fresh Session has a live Host Agent')
    assert.equal(oldAgent.status, 'running',
      'the Agent Turn is RUNNING while the tool awaits the human answer')

    // The REAL registered /new handler (the live modal owns the keys, so the
    // command plane is the production path to a navigation transition).
    const commands = fixture.ctx.get('commands') as unknown as {
      find(agent: unknown, name: string): { handler(invocation: unknown): unknown } | undefined
    }
    const newDefinition = commands.find(undefined, 'new')
    assert.ok(newDefinition, 'the real TUI /new handler is registered')
    const transition = Promise.resolve(newDefinition.handler({
      commandId: 'cmd-nav-question',
      agent: undefined,
      rawInput: '',
      signal: new AbortController().signal,
    }))
    await transition

    // The navigation stop cancelled the running owner: the REAL tool call's
    // signal aborted, the official request settled (the form leaves the seat),
    // and the cancelled Turn reached its durable terminal boundary.
    await waitFor('the /new child session', () => {
      const ids = welcomeSessionIds(fixture)
      return ids.length === 1 && ids[0] !== oldId
    }, 25_000)
    const liveModalCount = (): number => {
      const live = new Set<string>()
      for (const frame of fixture.pane.frames()) {
        for (const op of frame.ops) {
          if (op[0] === 'add' && /^layer\.modal-\d+$/u.test(op[1])) live.add(op[1])
          else if (op[0] === 'del' && /^layer\.modal-\d+$/u.test(op[1])) live.delete(op[1])
        }
      }
      return live.size
    }
    await waitFor('the replaced Question form left the seat', () => liveModalCount() === 0, 25_000)
    assert.deepEqual(askFailures, ['ASK_ABORTED'],
      'the REAL user-questions service rejected the tool request ONCE with the official abort code')
    const query = fixture.ctx.get('sessionQuery') as unknown as {
      observeSession(id: SessionId): Promise<{ events: readonly { type: string; data?: unknown }[] }>
    }
    const oldLog = await query.observeSession(SessionId(oldId))
    const end = oldLog.events.filter(event => event.type === 'turn/end').at(-1)?.data as
      { reason?: { kind?: string; reason?: { kind?: string } } } | undefined
    assert.equal(end?.reason?.kind, 'aborted',
      'the cancelled Turn has the durable aborted terminal result')
    assert.equal(end?.reason?.reason?.kind, 'user',
      'the abort cause is the user navigation stop, not a shutdown cancel')
    // No fabricated answer was ever dispatched: the request died by its own
    // cancellation lifetime, and the new Session owns the surface.
    const ids = welcomeSessionIds(fixture)
    assert.equal(ids.length, 1)
    assert.notEqual(ids[0], oldId)
  } finally {
    await fixture.settle()
  }
})
