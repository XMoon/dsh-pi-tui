/**
 * Request time zone (Client time zone propagation) on the REAL Direct
 * composition: the TUI submit gesture over real live Agents (see
 * `support/direct-tsp-fixture.ts` — REAL Host services, only the model
 * scripted), with the official `@deepseek-ai/dsh-time-context` plugin mounted
 * exactly as the shipped `standard` preset declares it
 * (`generated/dsh-presets/standard.patch.yml`).
 *
 * The cases are the direct-path halves of the plan's acceptance:
 * a reachable ordinary prompt writes the Client-sampled zone into the durable
 * `UserMessage.source` AND the model-visible request zone becomes that zone
 * instead of `unavailable`; an unsamplable process zone refuses the send
 * before dispatch (draft restored, nothing durable, no model call); and the
 * RENDERED surface the user sees keeps its ordinary Queue/transcript/composer
 * behaviour while that Context body changes (plan §7).
 *
 * The process zone IS the sampled zone (that is the plan's product boundary),
 * so the cases control `TZ` instead of depending on the machine's locale.
 *
 * ## L5 fixture manifest
 *
 * - PRODUCTION PREREQUISITES REPRODUCED: the real Direct Host composition
 *   (`support/direct-tsp-fixture.ts`: the rc.2 Agent/Session registry, AgentLoop
 *   with real live Agents, JSONL Session persistence, the real runner
 *   composition root and the real Direct submission/writer path), the REAL
 *   scripted TSP surface the SDK actually paints, and the official
 *   `@deepseek-ai/dsh-time-context` row mounted exactly as the shipped
 *   `standard` preset declares it.
 * - TEST STAND-INS: the model endpoint (the fixture's scripted streaming
 *   adapter) and the controlled `TZ` used as the Client runtime's reported zone.
 * - DELIBERATELY ABSENT: a separate Host process/timezone (the same-Host L5
 *   case with an independently controlled Client zone is
 *   `test/runner-remote-presentation.test.ts`), the real Tern GUI, and the
 *   Remote transport (this file is the Direct path).
 *
 * @module @xmoon76/dsh-pi-tui/request-time-zone.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createDirectTspFixture, directSettle, waitFor } from './support/direct-tsp-fixture.ts'
import { wireNodes, type WireNode } from './support/tsp-picker-wire.ts'

interface RecordedPrompt {
  readonly sessionId: string
  readonly message: unknown
}

interface DurableUserMessage {
  readonly source: { readonly kind?: string; readonly rpcId?: unknown; readonly clientTimeZone?: unknown }
  readonly content: readonly { readonly text?: string }[]
}

/** Every rendered text line of the pane's live node tree (the surface's paint). */
function renderedLines(fixture: Awaited<ReturnType<typeof createDirectTspFixture>>): string[] {
  const lines: string[] = []
  const collect = (node: WireNode): void => {
    if (typeof node.p.text === 'string' && node.p.text !== '') lines.push(node.p.text)
    for (const child of node.c ?? []) collect(child)
  }
  for (const node of wireNodes(fixture.pane)) collect(node)
  return lines
}

/** Every durable `user/message` the live Agents of this fixture hold. */
function durableUserMessages(fixture: Awaited<ReturnType<typeof createDirectTspFixture>>): DurableUserMessage[] {
  const agents = fixture.ctx.agents as unknown as {
    list(): Iterable<{ session: { snapshotEvents(): ReadonlyArray<{ type: string; data: unknown }> } }>
  }
  const messages: DurableUserMessage[] = []
  for (const agent of agents.list()) {
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'user/message') messages.push(event.data as DurableUserMessage)
    }
  }
  return messages
}

/** The latest controlled editor text on the wire for `dock.composer`. */
function latestComposerText(wire: string): string | undefined {
  let text: string | undefined
  let seen = false
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as { c?: Array<{ id?: string; p?: { text?: string } }> } | undefined
        const editor = node?.c?.find(child => child.id === 'dock.composer')
        if (editor?.p?.text !== undefined) text = editor.p.text
        seen = true
      } else if (op[0] === 'set' && op[1] === 'dock.composer' && (op[2] as { text?: string }).text !== undefined) {
        text = (op[2] as { text: string }).text
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        text = op[2] === 'append' ? (text ?? '') + (op[3] as string) : (op[3] as string)
      }
    }
  }
  return seen ? text : undefined
}

/** Run `body` with the process zone set, always restoring the previous one. */
async function withProcessZone<T>(life: { defer(task: () => unknown): void }, zone: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ
  process.env.TZ = zone
  life.defer(() => {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  })
  return body()
}

test('a real Direct TUI submit writes the Client-sampled zone durably and the mounted time-context plugin reports it', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  await withProcessZone(life, 'Asia/Shanghai', async () => {
    const fixture = await createDirectTspFixture(life, { deltas: ['zone turn ran'] })
    // The official request-clock row, mounted ONLY for this test: the shipped
    // `standard` preset declares it the same way, and the product's default
    // composition is untouched by this file.
    const timeContext = await import('@deepseek-ai/dsh-time-context')
    await fixture.ctx.plugin(timeContext as never, {} as never)
    const prompts: RecordedPrompt[] = []
    const recorder = fixture.recordPrompts(call => prompts.push({ sessionId: call.sessionId, message: call.message }))
    try {
      await directSettle(4_000)
      fixture.pane.input.type('which day is it')
      await directSettle()
      fixture.pane.input.type('\r')
      await waitFor('the scripted model reply', () => fixture.pane.output.text().includes('zone turn ran'), 25_000)
      assert.equal(recorder.calls(), 1, 'the submit commits exactly one Direct write')

      // The message the production pipeline handed to the Direct writer.
      const source = (prompts[0]!.message as { source: Record<string, unknown> }).source
      assert.equal(source.kind, 'user', 'the ordinary prompt keeps its human provenance')
      assert.equal(typeof source.rpcId, 'string', 'the ordinary prompt keeps its own request identity')
      assert.equal(source.clientTimeZone, 'Asia/Shanghai', 'the zone sampled at the send point rides the source')

      // The durable session log: the same source, and the plugin's own reading.
      const durable = durableUserMessages(fixture)
      const human = durable.filter(message => message.source.kind === 'user' && typeof message.source.rpcId === 'string')
      assert.equal(human.length, 1, 'one durable human message for this turn')
      assert.equal(human[0]!.source.rpcId, source.rpcId, 'the durable occurrence keeps the same identity')
      assert.equal(human[0]!.source.clientTimeZone, 'Asia/Shanghai',
        'the durable UserMessage.source carries the Client zone (no Host re-derivation)')
      const injected = durable.filter(message => message.source.kind === 'time-context')
      assert.equal(injected.length, 1, 'the mounted official plugin injected one request-clock snapshot')
      const timeContextText = injected[0]!.content.map(part => part.text ?? '').join('\n')
      assert.match(timeContextText, /Browser time zone for this request: Asia\/Shanghai\./u,
        'the model-visible request zone is the Client zone, never "unavailable"')
      assert.match(timeContextText, /Interpret otherwise-unqualified dates and times in this zone\./u)
    } finally {
      await fixture.settle()
    }
  })
})

test('an unsamplable process zone refuses the Direct send before dispatch and restores the draft', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  await withProcessZone(life, 'Foo/Bar', async () => {
    const fixture = await createDirectTspFixture(life, { deltas: ['zone turn ran'] })
    const recorder = fixture.recordPrompts(() => {})
    try {
      await directSettle(4_000)
      fixture.pane.input.type('zone-less send')
      await directSettle()
      assert.equal(latestComposerText(fixture.pane.output.text()), 'zone-less send',
        'the draft is present before submission')
      fixture.pane.input.type('\r')
      await waitFor('the truthful zone refusal', () =>
        fixture.pane.output.text().includes('reports no time zone'), 25_000)
      assert.equal(recorder.calls(), 0, 'no Direct write was dispatched')
      assert.equal(fixture.modelCalls(), 0, 'the model never saw a zone-less human prompt')
      assert.equal(latestComposerText(fixture.pane.output.text()), 'zone-less send',
        'the refused draft is restored for a corrected retry')

      // The refused request is never replayed: only the corrected retry below
      // reaches the official write, and it carries the zone that is now real.
      process.env.TZ = 'Asia/Shanghai'
      await directSettle()
      assert.equal(recorder.calls(), 0, 'the refusal schedules no automatic replay')
      fixture.pane.input.type('\r')
      await waitFor('the corrected retry to reach the model', () =>
        fixture.pane.output.text().includes('zone turn ran'), 25_000)
      assert.equal(recorder.calls(), 1, 'exactly one write: the corrected retry')
      const messages = durableUserMessages(fixture)
        .filter(message => message.source.kind === 'user' && typeof message.source.rpcId === 'string')
      assert.equal(messages.length, 1, 'only the corrected retry is durable')
      assert.equal(messages[0]!.source.clientTimeZone, 'Asia/Shanghai')
    } finally {
      await fixture.settle()
    }
  })
})

test('the rendered surface keeps the ordinary Queue/transcript/composer behaviour while only the Context body changes', async (t) => {
  // The plan §7 UX contract: no new entry point, gesture, control or
  // placement — the ONE intended visible difference is the already-existing
  // Context card's body text. This case asserts that rendered result on the
  // REAL scripted TSP surface the SDK actually paints: a running-turn queue
  // submission still renders as the queue row, the transcript still carries
  // both user rows, the composer is consumed, and the Context body is the
  // Client zone.
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  await withProcessZone(life, 'Asia/Shanghai', async () => {
    let releaseStream!: () => void
    const held = new Promise<void>(resolve => { releaseStream = resolve })
    const fixture = await createDirectTspFixture(life, {
      deltas: ['zone parity reply'],
      streamHold: () => held,
    })
    const timeContext = await import('@deepseek-ai/dsh-time-context')
    await fixture.ctx.plugin(timeContext as never, {} as never)
    const prompts: unknown[] = []
    const recorder = fixture.recordPrompts(call => { prompts.push(call.message) })
    try {
      await directSettle(4_000)
      fixture.pane.input.type('parity question')
      await directSettle()
      fixture.pane.input.type('\r')
      await waitFor('the running turn', () => fixture.pane.output.text().includes('working'), 25_000)
      await waitFor('the first settled prompt', () => recorder.calls() === 1, 25_000)

      // The busy submission while the turn runs: the ordinary queue placement.
      fixture.pane.input.type('parity busy follow-up')
      await directSettle()
      fixture.pane.input.type('\r')
      await waitFor('the busy delivery to settle', () => recorder.calls() === 2, 25_000)
      await directSettle(1_500)
      assert.deepEqual(prompts.map(message =>
        (message as { source: { clientTimeZone?: string } }).source.clientTimeZone),
      ['Asia/Shanghai', 'Asia/Shanghai'],
      'the ordinary AND the busy (queue) submission carry the same per-submit source zone')
      const renderedDuringBusy = renderedLines(fixture)
      assert.ok(renderedDuringBusy.some(line => line.includes('queued (followup): parity busy follow-up')),
        `the busy submission must render as the ordinary queue row:\n${renderedDuringBusy.join('\n')}`)
      assert.equal(renderedDuringBusy.some(line => line.includes('parity busy follow-up') && line.includes('steering')),
        false, 'a queued submission never renders as a steering row')
      assert.ok(renderedDuringBusy.some(line => line.includes('Browser time zone for this request: Asia/Shanghai.')),
        `the rendered Context body must carry the Client zone:\n${renderedDuringBusy.join('\n')}`)
      assert.equal(renderedLines(fixture).some(line => line === 'parity busy follow-up'), false,
        'the submitted text is consumed from the composer, never left as a draft')

      releaseStream()
      await waitFor('the scripted reply', () => fixture.pane.output.text().includes('zone parity reply'), 25_000)
      await directSettle(2_000)
      const rendered = renderedLines(fixture)
      assert.ok(rendered.some(line => line === 'parity question'), 'the first user row stays in the transcript')
      assert.ok(rendered.some(line => line === 'parity busy follow-up'), 'the queued row becomes a transcript row')
      assert.ok(rendered.some(line => line.includes('zone parity reply')), 'the scripted reply renders')
      assert.ok(rendered.some(line => line.includes('Browser time zone for this request: Asia/Shanghai.')),
        'the Context body keeps the Client zone after the turn settles')
      assert.equal(rendered.some(line => line.includes('queued (followup):')), false,
        'the queue row is gone once the queued turn is admitted')
    } finally {
      releaseStream()
      await fixture.settle()
    }
  })
})
