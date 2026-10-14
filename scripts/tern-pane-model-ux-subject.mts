/**
 * The subject of the `/model` real-pane acceptance lane (list-first revision).
 *
 * It mounts the PRODUCTION `TspModelPicker` over one official SDK inline surface
 * with a scripted directory, and records on `events.jsonl` everything that really
 * arrived: the client capability set, every resize (with the client's own `cols`
 * and `cell`), every key, every raw row/action event, every native scroll the
 * presenter asked for, and the full picker/overlay props of every rendered frame.
 * The flow reads that record back as its positive control.
 *
 * Launched by `tern-pane-model-ux.mjs` through `harness.launch`, so it follows the
 * subject contract: read the run directory from `TERN_PANE_DIR`, record what
 * happened there, and exit on F10.
 *
 * Its own controls (never picker input):
 *   1  the NORMAL catalogue: current != default, one model with 3 efforts, one
 *      model without any effort metadata, and a third row that is neither
 *   2  one model advertising 8 widest-glyph effort labels
 *   3  the long-identity / long-description Reader model
 *   4  a PARTIAL catalogue whose one provider read failed (the retry row is real)
 *   e  report a FAILED read on the open panel (the Reader's phase control)
 *   l  start a re-read (loading) on the open panel
 *   s  re-open the panel SESSIONLESS (`Choose default model`, never a fake current)
 *
 * Usage: node --import tsx/esm scripts/tern-pane-model-ux-subject.mts
 * @module scripts/tern-pane-model-ux-subject
 */
import { appendFileSync } from 'node:fs'
import { View, connect, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import { TspModelPicker } from '../src/tui/tsp/model-picker.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => {
  appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
}

/* --------------------------------------------------------------- fixtures */

/** Fixture `1`: the normal catalogue. `current` and `default` are DIFFERENT rows;
 *  `Alpha Model` advertises three efforts (so the strip carries four
 *  candidates including the synthetic provider default), `Beta Model` and
 *  `Alpha Second` advertise none. */
const NORMAL = {
  current: { provider: 'alpha', model: 'm-alpha', reasoningEffort: 'medium' },
  directory: {
    default: { provider: 'beta', model: 'm-beta' },
    routableProviders: ['alpha', 'beta'],
    groups: [
      {
        id: 'alpha',
        name: 'Alpha Provider',
        models: [
          {
            id: 'm-alpha',
            name: 'Alpha Model',
            description: 'The current model.',
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
          },
          { id: 'm-alpha2', name: 'Alpha Second' },
        ],
      },
      { id: 'beta', name: 'Beta Provider', models: [{ id: 'm-beta', name: 'Beta Model' }] },
    ],
    failures: [],
  },
}

/** Fixture `2`: eight widest-glyph effort labels on ONE model. */
/** Fixture `2`: eight widest-glyph effort labels that all share one long prefix
 *  and differ ONLY in their tail. An end clamp would render all eight identically;
 *  the middle clamp must keep each tail, so this is the clamp's real witness. */
const WIDE_EFFORTS = Array.from({ length: 8 }, (_, i) => ({ id: `w${i + 1}`, name: `${'W'.repeat(30)} (${i + 1})` }))
const WIDE = {
  current: { provider: 'wide', model: 'm-wide', reasoningEffort: 'w1' },
  directory: {
    default: { provider: 'wide', model: 'm-wide' },
    routableProviders: ['wide'],
    groups: [{ id: 'wide', name: 'Wide Provider', models: [{
      id: 'm-wide',
      name: 'Wide Model',
      // A concrete default effort keeps the strip exactly the EIGHT widest-glyph
      // labels (no synthetic provider-default item), which is the Owner's edge.
      reasoning: { efforts: WIDE_EFFORTS, defaultEffort: 'w1' },
    }] }],
    failures: [],
  },
}

/** Fixture `3`: the long identity + long description Reader model. The model name
 *  stays short (the client's overlay head is single-line) while the model ID is a
 *  180-glyph unbroken token and the description carries CRLF, LF, a blank line,
 *  CJK, an emoji and forty paragraphs. */
const LONG_ID = `provider/${'W'.repeat(180)}/very-high`
const LONG_DESCRIPTION = `${'Long description '.repeat(4)}\r\n中文描述：${'完整可读'.repeat(4)} 🚀\n\n${Array.from({ length: 40 }, (_, i) => `paragraph ${i}: ${'word '.repeat(20)}end-${i}`).join('\n')}`
const READER = {
  current: { provider: 'longp', model: LONG_ID, reasoningEffort: 'e2' },
  directory: {
    default: { provider: 'longp', model: LONG_ID, reasoningEffort: 'e3' },
    routableProviders: ['longp'],
    groups: [{
      id: 'longp',
      name: 'A very long advertised provider name',
      models: [{
        id: LONG_ID,
        name: 'Long Model',
        description: LONG_DESCRIPTION,
        reasoning: { efforts: [{ id: 'e1', name: 'E one' }, { id: 'e2', name: 'E two' }, { id: 'e3', name: 'E three' }] },
      }],
    }],
    failures: [],
  },
}

/** Fixture `4`: one provider read failed. The catalogue still has a usable model
 *  and must carry the `Unavailable providers` group with the ONE read-only retry
 *  row. */
const PARTIAL = {
  current: { provider: 'alpha', model: 'm-alpha' },
  directory: {
    default: { provider: 'alpha', model: 'm-alpha' },
    routableProviders: ['alpha'],
    groups: [{ id: 'alpha', name: 'Alpha Provider', models: [{ id: 'm-alpha', name: 'Alpha Model' }] }],
    failures: [{ id: 'broken', name: 'Broken Provider', message: 'read failed' }],
  },
}

/** The failed read's message: LF, CRLF and an explicit BLANK line, so the Reader
 *  can prove the client renders every break instead of collapsing the value. */
const FAILED = 'catalog is unreachable\r\nsecond line\r\n\r\nfourth line'

/* ------------------------------------------------------------- describe() */

/**
 * The frame the presenter REALLY built, reduced to what the flow asserts: the
 * page kind, the picker's own props (title/subtitle/size/preview/order/items/
 * actions), the overlay head, the raw prop-key set (so "no scopes column" is a
 * statement about the wire, not about pixels) and the summary `kv` items.
 */
const describe = (layer: Node) => {
  let pickerNode: Node | undefined
  let overlayNode: Node | undefined
  let kvNode: Node | undefined
  let notice: Record<string, unknown> | undefined
  const visit = (node: Node | undefined): void => {
    if (node === undefined) return
    if (node.kind === 'picker' && pickerNode === undefined) pickerNode = node
    if (node.kind === 'overlay' && overlayNode === undefined) overlayNode = node
    if (node.kind === 'kv' && kvNode === undefined) kvNode = node
    // The Reader's notice is a `ui.text` whose value is a TONED span, not a bare
    // `text` prop. The frame record keeps the span's text + tone and the text
    // node's own key set, so the role ink is asserted on the WIRE, not inferred.
    // (Kind-agnostic: the notice node's kind token is not part of the contract.)
    const ownText = (node.props ?? {})['text']
    if (typeof ownText === 'string' && ownText.startsWith('catalog is unreachable')) {
      notice = { text: ownText, tone: undefined, kind: node.kind, textNodeHasTextProp: true, textNodeKeys: Object.keys(node.props ?? {}).sort(), childKeys: [] }
    }
    // `ui.text({…}, span(text, tone))` keeps the styled runs in `props.spans`.
    const spans = (node.props ?? {})['spans']
    if (Array.isArray(spans)) {
      for (const run of spans as readonly { t?: unknown; s?: unknown }[]) {
        if (typeof run?.t === 'string' && run.t.startsWith('catalog is unreachable')) {
          notice = {
            text: run.t,
            tone: run.s,
            kind: node.kind,
            textNodeHasTextProp: 'text' in (node.props ?? {}),
            textNodeKeys: Object.keys(node.props ?? {}).sort(),
            spanKeys: Object.keys((run as object) ?? {}),
          }
        }
      }
    }
    for (const child of node.children) {
      const spanText = (child as { t?: unknown })?.t ?? (child as { props?: Record<string, unknown> })?.props?.['text']
      const spanTone = (child as { s?: unknown })?.s ?? (child as { props?: Record<string, unknown> })?.props?.['tone']
      if (typeof spanText === 'string' && spanText.startsWith('catalog is unreachable')) {
        notice = {
          text: spanText,
          tone: spanTone,
          kind: node.kind,
          textNodeHasTextProp: 'text' in (node.props ?? {}),
          textNodeKeys: Object.keys(node.props ?? {}).sort(),
          childKeys: Object.keys((child as object) ?? {}),
        }
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(layer)
  const props = pickerNode?.props
  const title = props?.['title']
  // TWO pages only: the catalogue or the read-only Reader. There is no
  // intermediate page, so a picker frame is always the catalogue.
  const page = overlayNode !== undefined ? 'details' : pickerNode === undefined ? 'none' : 'models'
  return {
    page,
    head: overlayNode?.props['head'],
    title,
    subtitle: props?.['subtitle'],
    size: props?.['size'],
    preview: props?.['preview'],
    layout: props?.['layout'],
    focus: props?.['focus'],
    selected: props?.['selected'],
    current: props?.['current'],
    total: props?.['total'],
    query: props?.['query'],
    placeholder: props?.['placeholder'],
    propKeys: props === undefined ? undefined : Object.keys(props).sort(),
    // The catalogue's ONE Reasoning Effort editor (present only while the
    // highlighted model advertises candidates).
    strip: props?.['strip'],
    actions: Array.isArray(props?.['actions'])
      ? (props['actions'] as readonly Record<string, unknown>[]).map((action) => ({
        id: action.id, label: action.label, primary: action.primary === true, disabled: action.disabled === true, end: action.end === true,
      }))
      : undefined,
    order: props?.['order'],
    columns: props?.['columns'],
    items: Array.isArray(props?.['items'])
      ? (props['items'] as readonly Record<string, unknown>[]).map((item) => ({
        id: item.id, label: item.label, detail: item.detail, title: item.title, mark: item.mark, badges: item.badges, disabled: item.disabled, dot: item.dot, facts: item.facts,
      }))
      : undefined,
    summary: kvNode === undefined ? undefined : kvNode.props['items'],
    notice,
  }
}

/**
 * The wire id of the frame's picker node.
 *
 * The SDK assigns ids when a view is built, so the raw `Node` a presenter hands back has
 * none: the id must be read from the SDK's own tree (`View.from`), exactly like the
 * presenter resolves the ids it routes on. A control needs a REAL id to dispatch a forged
 * event through that same admission path, and the flow needs it to assert the node's
 * identity across a click (the identity that must not change, or the client remounts the
 * list and moves the viewport).
 */
const findPickerId = (layer: Node): string | undefined => {
  let found: string | undefined
  const visit = (node: { readonly id?: string; readonly kind?: string; readonly children?: readonly unknown[] }): void => {
    if (node === undefined || found !== undefined) return
    if (node.kind === 'picker') {
      found = node.id
      return
    }
    for (const child of node.children ?? []) visit(child as { readonly id?: string; readonly kind?: string; readonly children?: readonly unknown[] })
  }
  for (const root of View.from({ layer }).regions) visit(root as { readonly id?: string; readonly kind?: string; readonly children?: readonly unknown[] })
  return found
}

/** Fixture `5`: TWO models that advertise the SAME candidates. It is what the reviewer's
 *  keyboard-zone case needs: a candidate click puts the keys on the strip, a MOUSE click then
 *  selects the OTHER effort-bearing model, and the keys must follow the click back to the list
 *  (with a value-only strip id the second click could also be drafted into by the first). */
const TWIN: Record<string, unknown> = {
  current: { provider: 'alpha', model: 'm-alpha', reasoningEffort: 'medium' },
  directory: {
    default: { provider: 'beta', model: 'm-beta' },
    routableProviders: ['alpha', 'beta'],
    groups: [
      {
        id: 'alpha',
        name: 'Alpha Provider',
        models: [{
          id: 'm-alpha',
          name: 'Alpha Model',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        }],
      },
      {
        id: 'beta',
        name: 'Beta Provider',
        models: [{
          id: 'm-beta',
          name: 'Beta Model',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        }],
      },
    ],
    failures: [],
  },
}

/* ------------------------------------------------------------- the panel */

const session = await connect({ app: 'tern-pane-model-ux', timeout: 2000 })
if (session === null) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'model-ux' })
note({ caps: session.caps })

let picker!: TspModelPicker
let frames = 0
let pickerId: string | undefined
let pickerSelected: string | undefined
const draw = (): void => {
  const layer = picker.renderLayer()
  surface.render({ layer })
  frames += 1
  pickerId = findPickerId(layer)
  const described = describe(layer)
  pickerSelected = described.selected
  note({ frame: { n: frames, ...described, pickerId } })
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

const openPanel = (sessionless: boolean) => picker.presentation.open({
  subject: { sessionless },
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

let handle = openPanel(false)

const useFixture = (fixture: Record<string, unknown>, label: string): void => {
  handle.setDirectory(fixture)
  note({ fixture: label })
  draw()
}
useFixture(NORMAL, 'normal')
note({ ready: true })

try {
  for await (const input of session) {
    if (input.type === 'key') {
      const key: Key = input.key
      if (key.name === 'f10') break
      // The subject's own phase controls, so the real-pane lane can exercise the
      // open panel through a failed/running read.
      if (key.text === 'e' || key.text === 'l') {
        if (key.text === 'e') handle.setLoadError(FAILED)
        else handle.setLoading()
        note({ control: key.text === 'e' ? 'load-error' : 'loading' })
        continue
      }
      // A FORGED strip action, dispatched through the presenter's real admission
      // path: proves the phase gate refuses the strip channel while it is not
      // painted (the client cannot click a chip that does not exist).
      if (key.text === 'f') {
        // A WELL-FORMED id for the panel's HIGHLIGHTED model and a value it does NOT
        // advertise: a strip id names the model it was built for, so a control that dropped
        // the model half would only prove that a MALFORMED id is refused.
        const forged = `effort:${String(pickerSelected ?? '')}\u0000not-a-candidate`
        if (pickerId !== undefined) {
          picker.handleEvent({ ev: 'action', id: pickerId, act: 'strip', value: forged } as unknown as TspEvent)
        }
        note({ control: 'forged-strip', id: pickerId, value: forged })
        continue
      }
      // The panel-lifecycle control: a SESSIONLESS subject (never a live one).
      if (key.text === 's') {
        handle = openPanel(true)
        useFixture(NORMAL, 'sessionless')
        continue
      }
      // The fixture switch is the subject's own control, not picker input.
      if (key.text === '1' || key.text === '2' || key.text === '3' || key.text === '4' || key.text === '5') {
        if (key.text === '1') useFixture(NORMAL, 'normal')
        else if (key.text === '2') useFixture(WIDE, 'wide-efforts')
        else if (key.text === '3') useFixture(READER, 'reader')
        else if (key.text === '4') useFixture(PARTIAL, 'partial')
        else useFixture(TWIN, 'twin-efforts')
        note({ key: key.text })
        continue
      }
      note({ key: key.name ?? key.text ?? '?' })
      picker.handleKey(key)
      continue
    }
    const event = input.event as TspEvent
    note({ event: { ev: event.ev, id: 'id' in event ? event.id : undefined, item: 'item' in event ? event.item : undefined, act: 'act' in event ? event.act : undefined, value: 'value' in event ? event.value : undefined } })
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
