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
import { createDirectTspFixture, directSettle, waitFor, type DirectTspFixture } from './support/direct-tsp-fixture.ts'
import { wireNodes } from './support/tsp-picker-wire.ts'

// ── wire helpers ────────────────────────────────────────────────────────────

/** The latest controlled editor text committed for `dock.composer`. */
function composerText(fixture: DirectTspFixture): string | undefined {
  const composer = wireNodes(fixture.pane).find(node => node.id === 'dock.composer')
  return typeof composer?.p.text === 'string' ? composer.p.text : undefined
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
  await waitFor(`the composer to hold ${command}`, () => composerText(fixture) === command)
  await directSettle()
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

test('A01: /new creates and hydrates a real new Session without a model turn', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
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

test('A02: sessionless /fork refuses and creates no Session', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A02'] })
  try {
    await directSettle(4_000)
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

test('A02: /fork forks the current conversation and publishes the child owner', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['FORK-SOURCE'] })
  try {
    await directSettle(4_000)
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

test('A03/A04: /title and /rename write the authoritative title and notify the dock', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['TITLE-ME'],
    officialServices: { sessionTitle: true },
  })
  try {
    await directSettle(4_000)
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

test('RFL-001: a rejected /title publishes ONE refusal across Dock and transcript', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  // No session-title service is mounted, so the REAL Direct writer rejects the
  // explicit rename deterministically. On TSP+Direct the official command
  // result card owns the message; the Dock must not repeat it.
  const fixture = await createDirectTspFixture(life, { deltas: ['TITLE-REJECT'] })
  try {
    await directSettle(4_000)
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

test('A05: bare /title regenerates the title from the conversation', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['TITLE-REFRESH'],
    officialServices: { sessionTitle: true },
  })
  try {
    await directSettle(4_000)
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

test('A05: bare /title and bare /rename report the blank-Session refusal on the TSP Dock', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
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

test('A06: /copy emits the OSC 52 sequence for the authoritative last assistant text', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const assistantText = 'COPY-ME-B2A-42'
  const fixture = await createDirectTspFixture(life, { deltas: [assistantText] })
  try {
    await directSettle(4_000)
    await seedTurn(fixture, 'produce a copyable answer')
    // The copy target is the AUTHORITATIVE last assistant text, not the
    // rendered window: assert the delivered text is what the policy received.
    // The assertion is TMUX-agnostic: the tmux form wraps the same OSC 52 body
    // in a DCS passthrough, so the payload and the `]52;c;` marker identify the
    // emission either way (the suite must also pass when run inside tmux).
    const payload = Buffer.from(assistantText, 'utf8').toString('base64')
    await submitInput(fixture, '/copy')
    await waitFor('the copy success notice', () =>
      dockNotices(fixture).some(text => text.includes('copied last assistant message')), 25_000)
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

test('A06: /copy without an assistant message fails visibly and copies nothing', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['UNUSED'] })
  try {
    await directSettle(4_000)
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

test('A06: /copy reports the shared policy failure when BOTH legs fail', async (t) => {
  // The shared policy attempts the native/platform helper on macOS and Windows
  // UNCONDITIONALLY (pbcopy/clip), so this e2e cannot make that leg fail there
  // without touching the developer's real clipboard: the case is skipped on
  // those platforms instead of faking a pass.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    t.skip('the native clipboard helper is attempted unconditionally on this platform')
    return
  }
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
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
    await directSettle(4_000)
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

test('A07: sessionless /yolo reports the unavailable official permission writer', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A07'] })
  try {
    await directSettle(4_000)
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

test('A07: /yolo applies danger-full-access through the official permission writer', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['A07-APPLIED'],
    officialServices: { permissionPresets: true },
  })
  try {
    await directSettle(4_000)
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

test('A08: /logout <reference> clears the credential and reports it visibly', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A08'] })
  const secret = 'sk-b2a-secret-value'
  const ref = 'DEEPSEEK_API_KEY'
  try {
    await directSettle(4_000)
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
    await waitFor('the logout success notice', () =>
      dockNotices(fixture).some(text => text.includes(`API key ${ref} cleared`)), 25_000)
    assert.equal(await credentials.resolve(ref), undefined,
      'the authoritative credential read confirms the reference is gone')
    assert.ok(!fixture.pane.output.text().includes(secret),
      'no message on the wire ever carries the credential VALUE')
  } finally {
    await fixture.settle()
  }
})

test('A08: a composition without the credentials service reports the refusal and mutates nothing', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  // The negative composition: the deployment mounts no credentials provider, so
  // the port's `available()` is false and the handler must refuse truthfully.
  const fixture = await createDirectTspFixture(life, { deltas: ['A08-PORT'], withoutCredentials: true })
  try {
    await directSettle(4_000)
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

test('A08: a THROWING credential port surfaces the failure and never reports a clear', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
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
    await directSettle(4_000)
    await submitInput(fixture, '/new')
    await waitFor('the session owner', () => welcomeSessionIds(fixture).length === 1, 25_000)
    await service.set(ref, secret)
    prototype.unset = () => { throw new Error('controlled credential unset failure') }
    await submitInput(fixture, '/logout deepseek')
    await waitFor('the throwing-port error notice', () =>
      fixture.pane.output.text().includes('controlled credential unset failure'), 25_000)
    assert.ok(!fixture.pane.output.text().includes('cleared'),
      'a throwing port is never reported as a cleared credential')
    assert.notEqual(await service.resolve(ref), undefined,
      'the stored reference survives the failed logout')
  } finally {
    if (hadOwnUnset) prototype.unset = originalUnset
    else delete prototype.unset
    await fixture.settle()
  }
})

test('A10: bare /logout is refused by the gate — no picker, no credential mutation', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A10'] })
  const ref = 'DEEPSEEK_API_KEY'
  try {
    await directSettle(4_000)
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

test('A11: /logout with an unresolvable target reports the real unknown-target error', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A11'] })
  try {
    await directSettle(4_000)
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

test('A13: every remaining PiTui-only builtin stays refused with the draft restored', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['A13'] })
  const refused = [
    '/settings', '/help', '/status', '/rewind', '/tasks', '/subagents', '/plugins', '/reload',
    '/export', '/transcript', '/attach some-file', '/image some-file',
    '/login', '/skill', '/display', '/focus', '/footer', '/statusline', '/keybindings',
  ]
  try {
    await directSettle(4_000)
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

// ── A09: the flow-route logout branch (capability absent here) ──────────────

test('A09: /logout <flow-route> is refused truthfully while no flow provider is installed', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
  // The REAL authorization seam is mounted; this environment installs no
  // provider plugin that registers a flow, so the flow branch has no route to
  // resolve. The handler must report the real unknown-target error and mutate
  // nothing — a simulated flow is explicitly NOT evidence for this case.
  const fixture = await createDirectTspFixture(life, {
    deltas: ['A09'],
    officialServices: { authorization: true },
  })
  try {
    await directSettle(4_000)
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

test('A16: a no-panel TUI builtin executes locally while the turn runs (busyEnter=steer)', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
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
    await directSettle(4_000)
    const sessionId = await seedTurn(fixture, 'hold the turn open')
    await waitFor('the running turn', () => fixture.pane.output.text().includes('working'), 25_000)
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

// ── A14: genuine Host same-name winners ─────────────────────────────────────

test('A14: genuine Host /new, /copy, /logout, /title and /rename keep their Host sink', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
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
    await directSettle(4_000)
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

test('A14: an argued line of a genuine Host execute-kind command stays an ordinary prompt', async (t) => {
  const life = (await import('./support/temp-lifecycle.ts')).testLifecycle(t)
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
    await directSettle(4_000)
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
