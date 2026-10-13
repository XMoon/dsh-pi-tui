/**
 * The subject of the `/model` real-pane flow: the PRODUCTION `TspModelPicker`
 * mounted over one official SDK inline surface, with a scripted directory and its
 * own record of everything that really arrived.
 *
 * Launched by `tern-pane-model-ux.mjs` through `harness.launch`, so it follows the
 * subject contract: read the run directory from `TERN_PANE_DIR`, record what
 * happened there (the flow reads it back as its positive control), and exit on F10.
 *
 * It renders ONLY the picker layer — no harness chrome — so the client's own
 * element boxes are the production ones. Press `1` / `2` / `3` to switch the
 * scripted directory: `1` is a model whose wide column fits (the full details
 * card), `2` is a model whose column cannot (the bounded `Open model & effort ›`
 * card), and `3` is a model with long identity/description facts for the Reader.
 * Press `e` / `l` to make the command's read owner report a FAILED read / start a
 * re-read on the open panel: the panel's phase is renderer-local, so these two
 * controls are what let the real-pane lane drive the Reader through a phase.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-model-ux-subject.mts
 * @module scripts/tern-pane-model-ux-subject
 */
import { appendFileSync } from 'node:fs'
import { connect, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import { TspModelPicker } from '../src/tui/tsp/model-picker.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => {
  appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
}

/** One advertised model; `efforts` absent means "no reasoning metadata". */
const model = (
  id: string,
  name: string,
  efforts?: readonly string[],
  description?: string,
): Record<string, unknown> => ({
  id,
  name,
  ...(description === undefined ? {} : { description }),
  ...(efforts === undefined ? {} : { reasoning: { efforts: efforts.map((e) => ({ id: e, name: e })) } }),
})

/** A one-provider directory with a live-Session-shaped configured selection. */
const directory = (provider: string, providerName: string, models: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  current: { provider, model: 'm', reasoningEffort: 'e1' },
  directory: {
    default: { provider, model: 'm', reasoningEffort: 'e1' },
    routableProviders: [provider],
    groups: [{ id: provider, name: providerName, models }],
    failures: [],
  },
})

/** Two models, short label: the wide column fits the whole card + every effort. */
const FULL = directory('shortp', 'shortp', [
  model('m', 'Budget Model', ['e1', 'e2', 'e3']),
  model('m2', 'Second Model', ['e1', 'e2', 'e3']),
])
/** Widest-glyph labels: the column cannot fit, so it becomes the Overview entry. */
const BOUNDED = directory('openrouter', 'openrouter', [
  model('m', 'Budget Model', Array.from({ length: 8 }, (_, i) => `W${i}`.padEnd(34, 'W'))),
])
/**
 * Long identity + description: the Reader must carry the COMPLETE values (an
 * unbroken 180-glyph ID, CJK, an emoji and forty explicit paragraphs) so the flow
 * can prove the client wraps them itself and can scroll to the very last line.
 */
const LONG = `${'Long description '.repeat(4)}\r\n中文描述：${'完整可读'.repeat(4)} 🚀\n${Array.from({ length: 40 }, (_, i) => `paragraph ${i}: ${'word '.repeat(20)}end-${i}`).join('\n')}`
/** The failed read's message: LF, CRLF and an explicit BLANK line, so the pane can
 *  prove the client renders every break instead of collapsing the value. */
const FAILED = 'catalog is unreachable\r\nsecond line\r\n\r\nfourth line'
const READER = {
  current: { provider: 'longp', model: 'm', reasoningEffort: 'e2' },
  directory: {
    default: { provider: 'longp', model: 'm', reasoningEffort: 'e3' },
    routableProviders: ['longp'],
    groups: [{
      id: 'longp',
      name: 'A very long advertised provider name',
      models: [model(`provider/${'W'.repeat(180)}/very-high`, 'Long Model', ['e1', 'e2', 'e3'], LONG)],
    }],
    failures: [],
  },
} as Record<string, unknown>

/** The picker's own props at render time, so the flow can assert the real bar,
 *  the layout it really asked for, and the page it really painted. */
const propsOf = (layer: Node): {
  title: unknown
  actions: unknown
  size: unknown
  preview: unknown
  selected: unknown
  rows: unknown
} => {
  let found: Node | undefined
  const visit = (node: Node | undefined): void => {
    if (node === undefined || found !== undefined) return
    if (node.kind === 'picker') {
      found = node
      return
    }
    for (const child of node.children) visit(child)
  }
  visit(layer)
  const items = found?.props['items']
  return {
    title: found?.props['title'],
    actions: found?.props['actions'],
    size: found?.props['size'],
    preview: found?.props['preview'],
    selected: found?.props['selected'],
    // The MAIN LIST row ids, in wire order: the flow can then tell a candidate
    // row from a summary row without guessing at rendered text.
    rows: Array.isArray(items)
      ? items.map((item) => (item !== null && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
      : undefined,
  }
}

const session = await connect({ app: 'tern-pane-model-ux', timeout: 2000 })
if (session === null) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'model-ux' })

let picker!: TspModelPicker
let frames = 0
const draw = (): void => {
  const layer = picker.renderLayer()
  surface.render({ layer })
  frames += 1
  note({ frame: { n: frames, ...propsOf(layer) } })
}
picker = new TspModelPicker({
  render: draw,
  canInteract: () => true,
  notify: (message) => note({ notify: message }),
  // The renderer owns the SDK: the presenter only names the node it built, and
  // the op really reaching the pane is recorded here.
  nativeScroll: (id, to) => {
    note({ nativeScroll: { id, to } })
    surface.scroll(id, to)
  },
})

const handle = picker.presentation.open({
  subject: { sessionless: false },
  isCurrent: () => true,
  retry: () => note({ retry: true }),
  apply: async (selection) => {
    note({ apply: { selection } })
    // Refused on purpose: the panel stays usable, which is what the flow asserts.
    return 'rejected'
  },
  runOwned: (_label, task, options) => {
    void task().then(
      (result) => options.onResult(result),
      (error: unknown) => options.onError(error),
    )
  },
})

const useFixture = (fixture: Record<string, unknown>, label: string): void => {
  handle.setDirectory(fixture)
  note({ fixture: label })
  draw()
}
useFixture(FULL, 'full')
note({ ready: true })

try {
  for await (const input of session) {
    if (input.type === 'key') {
      const key: Key = input.key
      if (key.name === 'f10') break
      // The subject's own phase controls, so the real-pane lane can exercise the
      // Reader through a failed/running read instead of leaving that to the
      // headless suite: `e` reports a failed read, `l` starts a re-read.
      if (key.text === 'e' || key.text === 'l') {
        if (key.text === 'e') handle.setLoadError(FAILED)
        else handle.setLoading()
        note({ control: key.text === 'e' ? 'load-error' : 'loading' })
        continue
      }
      // The fixture switch is the subject's own control, not picker input.
      if (key.text === '1' || key.text === '2' || key.text === '3') {
        if (key.text === '1') useFixture(FULL, 'full')
        else if (key.text === '2') useFixture(BOUNDED, 'bounded')
        else useFixture(READER, 'reader')
        note({ key: key.text })
        continue
      }
      note({ key: key.name ?? key.text ?? '?' })
      picker.handleKey(key)
      continue
    }
    const event = input.event as TspEvent
    note({ event: { ev: event.ev, id: 'id' in event ? event.id : undefined, item: 'item' in event ? event.item : undefined, act: 'act' in event ? event.act : undefined } })
    if (event.ev === 'resize' && typeof event.cols === 'number') {
      note({ resize: { cols: event.cols, cell: event.cell ?? null } })
      picker.resize(event.cols, event.cell?.w ?? session.caps.cell.w)
      draw()
      continue
    }
    picker.handleEvent(event)
  }
} finally {
  note({ closed: true })
  await surface.close({ keep: false })
  await session.close()
}
