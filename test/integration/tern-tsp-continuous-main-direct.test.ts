/**
 * The official Direct Host -> Composer -> Agent -> production TSP Main chain.
 * Only the fixture model endpoint is scripted; the Client pane is SDK-scripted,
 * so this proves application wire behavior rather than real Tern pixels.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDirectTspFixture, waitFor, waitForInputDelivery } from '../support/direct-tsp-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'

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

test('real Direct Composer turns keep earlier loaded Users mounted in the same TSP Main', { timeout: 300_000 }, async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    tuiConfig: { displayPreset: 'full' },
    deltas: ['direct continuous reply'],
  })
  const promptRecords: Array<{
    readonly sessionId: string
    readonly message: unknown
    readonly outcome: { readonly kind: string }
    readonly sessionEvents: () => readonly { readonly type: string; readonly data?: unknown }[]
  }> = []
  const recorder = fixture.recordPrompts(call => { promptRecords.push(call) })
  const userNodes = () => wireNodes(fixture.pane).filter(node =>
    node.k === 'message' && node.p['role'] === 'dsh.transcript.user')
  const textOf = (node: ReturnType<typeof wireNodes>[number]): string => {
    const parts: string[] = []
    const visit = (current: ReturnType<typeof wireNodes>[number]): void => {
      if (typeof current.p['text'] === 'string') parts.push(current.p['text'])
      for (const child of current.c ?? []) visit(child)
    }
    visit(node)
    return parts.join(' ')
  }
  try {
    await waitForInputDelivery(fixture.pane)
    await waitFor('the production inline Surface opens', () => fixture.pane.openSurfaces().length === 1, 20_000)
    assert.equal(fixture.pane.openSurfaces().length, 1, 'the production renderer owns one SDK surface')
    assert.equal(fixture.pane.openSurfaces()[0]?.mode, 'inline', 'the one surface is the native Main')

    const submit = async (ordinal: number): Promise<void> => {
      const marker = `DIRECT-CONT-${String(ordinal).padStart(2, '0')}`
      fixture.pane.input.type(marker)
      await waitFor(`the production Composer holds ${marker}`, () =>
        latestComposerText(fixture.pane.output.text()) === marker, 25_000)
      assert.equal(recorder.calls(), ordinal - 1, `${marker} has not been written before Enter`)
      fixture.pane.input.type('\r')
      await waitFor(`the real Direct writer settles ${marker}`, () =>
        recorder.calls() === ordinal && promptRecords.length === ordinal, 30_000)
      const record = promptRecords[ordinal - 1]!
      assert.ok(JSON.stringify(record.message).includes(marker), `${marker} is present in the settled production writer message`)
      assert.equal(record.outcome.kind, 'committed', `${marker} commits through the Direct writer`)
      if (ordinal > 1) assert.equal(record.sessionId, promptRecords[0]!.sessionId, 'every prompt addresses the same Direct Session')
      await waitFor(`the official turn/end for ${marker}`, () => record.sessionEvents().some(event =>
        event.type === 'turn/end' && (event.data as { readonly turn?: number } | undefined)?.turn === ordinal), 30_000)
      await waitFor(`${marker} mounted in the current SDK Main`, () =>
        userNodes().filter(node => textOf(node).includes(marker)).length === 1, 30_000)
    }

    for (let ordinal = 1; ordinal <= 25; ordinal += 1) await submit(ordinal)

    let users = userNodes()
    assert.equal(users.length, 25, 'the current Main contains every submitted User message')
    assert.equal(new Set(users.map(node => node.id)).size, 25, 'each User message has one distinct SDK node id')
    for (const marker of ['DIRECT-CONT-01', 'DIRECT-CONT-13', 'DIRECT-CONT-25']) {
      assert.equal(users.filter(node => textOf(node).includes(marker)).length, 1,
        `${marker} is mounted exactly once in the live node set`)
    }
    assert.ok(!wireNodes(fixture.pane).some(node => textOf(node).includes('Earlier turns')),
      'the TSP Main has no synthetic window summary')

    const earliest = users.find(node => textOf(node).includes('DIRECT-CONT-01'))!
    const framesBeforeAppend = fixture.pane.frames().length
    await submit(26)
    users = userNodes()
    assert.equal(users.length, 26, 'the next real Agent turn appends to the same Main')
    assert.equal(users.find(node => textOf(node).includes('DIRECT-CONT-01'))?.id, earliest.id,
      'the earliest User retains its SDK node id after the 26th turn')
    assert.ok(wireNodes(fixture.pane).some(node => textOf(node).includes('direct continuous reply')),
      'the 26th official Agent response reaches the same Main')
    const earliestMutations = fixture.pane.frames().slice(framesBeforeAppend).flatMap(frame => frame.ops)
      .filter(op => (op[0] === 'del' && op[1] === earliest.id)
        || (op[0] === 'move' && op.some(value => value === earliest.id)))
    assert.equal(earliestMutations.length, 0, 'the 26th turn neither deletes nor moves the earliest User node')
    assert.equal(recorder.calls(), 26, 'each Composer submission produced one settled Writer call')
    assert.equal(fixture.modelCalls(), 26, 'each committed turn reached the scripted model exactly once')
    assert.equal(fixture.pane.openSurfaces().length, 1, 'the sequence never creates a second SDK surface')
  } finally {
    recorder.detach()
    // Bounded lifecycle settlement releases the fixture's Host fibers, Session and SDK pane.
    await fixture.settle()
  }
})
