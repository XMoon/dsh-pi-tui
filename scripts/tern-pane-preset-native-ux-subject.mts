/**
 * The subject of the `/preset` real-pane acceptance lane (native cards + Overview +
 * Guide revision).
 *
 * It mounts the PRODUCTION `TspPresetPicker` over one official SDK inline surface with
 * scripted rosters, and records on `events.jsonl` everything that really arrived: the
 * client capability set, every resize (with the client's own `cols` and `cell`), every
 * key, every raw row/action event, the request-side `apply`/`setDefault`/`retry` calls
 * (the business spies the flow's boundary controls read), every native scroll the
 * presenter asked for, and the reduced data of every rendered frame: the picker's own
 * props (including the `subtitle` the client turns into the header tooltip), the overlay's
 * operation rows by node KEY, the reading body's key and the Guide's full Markdown text —
 * so the flow proves completeness without importing a TypeScript module.
 *
 * Launched by `tern-pane-preset-native-ux.mjs` through `harness.launch`, so it follows
 * the subject contract: read the run directory from `TERN_PANE_DIR`, record what
 * happened there, and exit on F10.
 *
 * Its own controls (never picker input):
 *   1  the NORMAL rosters: the four SHIPPED presets + twelve Custom declarations, one
 *      of them broken (the default is a shipped preset that is NOT the first row)
 *   2  the long-identity / long-description / long-broken-reason fixture
 *   3  a CUSTOM declaration that reuses a shipped id (`minimal`) with its own copy
 *   r  re-open the panel with the CURRENT fixture and subject
 *   s  toggle the subject between SESSIONLESS and LIVE, then re-open
 *   e  report a FAILED read on the open panel (the error-phase control)
 *   l  start a re-read on the open panel (the loading-phase control)
 *   u  forge a footer action whose frame token is WRONG (the stale-action control)
 *
 * Usage: node --import tsx/esm scripts/tern-pane-preset-native-ux-subject.mts
 * @module scripts/tern-pane-preset-native-ux-subject
 */
import { appendFileSync } from 'node:fs'
import { View, connect, ui, type Key, type Node, type TspEvent } from '@stencil-hq/tern'
import { TspPresetPicker } from '../src/tui/tsp/preset-picker.ts'
import type { PresetApplyOutcome, PresetDefaultOutcome, PresetPickerRoster } from '../src/app/command/preset-presentation.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => {
  appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/* --------------------------------------------------------------- fixtures */

/** The four SHIPPED presets, exactly as the official registry publishes them: a
 *  known id with NO `name`, which is what the shipped classification keys on. */
const SHIPPED: ReadonlyArray<{ id: string }> = [
  { id: 'standard' },
  { id: 'ptc' },
  { id: 'minimal' },
  { id: 'cordis' },
]

/** Twelve Custom declarations, so the catalogue really needs its own scrolling. */
const CUSTOM: ReadonlyArray<{ id: string; name: string; description: string }> = Array.from(
  { length: 12 },
  (_, index) => ({
    id: `custom-${index + 1}`,
    name: `Custom preset ${index + 1}`,
    description: `A user declaration number ${index + 1} with its own published copy.`,
  }),
)

const BROKEN: { id: string; name: string; broken: string } = {
  id: 'broken-preset',
  name: 'Broken preset',
  broken: 'plugin "missing-tools" is not installed; the declaration could not be composed',
}

const BASE_PRESETS: ReadonlyArray<{ id: string; name?: string; description?: string; broken?: string }> = [
  ...SHIPPED,
  ...CUSTOM,
  BROKEN,
]

const NORMAL: PresetPickerRoster = {
  roster: { presets: [...BASE_PRESETS], defaultId: 'ptc' },
  currentId: undefined,
  pendingId: undefined,
  defaultId: 'ptc',
  canSetDefault: true,
}

/** The live variant: the session's own preset is NOT the run-local pending one. */
const NORMAL_LIVE: PresetPickerRoster = {
  ...NORMAL,
  currentId: 'minimal',
}

/** The run-local pending variant, for a sessionless subject. */
const NORMAL_PENDING: PresetPickerRoster = {
  ...NORMAL,
  pendingId: 'cordis',
}

/** Fixture `2`: a 180-glyph unbroken identity, a CRLF/LF/CJK/emoji description and a
 *  long failure reason — every value the Overview must render COMPLETE. */
const LONG_ID = `no-space-${'W'.repeat(180)}:%:🧪`
const LONG_DESCRIPTION = `${'Long description '.repeat(6)}\r\n中文描述：${'完整可读'.repeat(6)} 🚀\n\n${Array.from({ length: 12 }, (_, index) => `paragraph ${index}: ${'word '.repeat(24)}end-${index}`).join('\n')}`
const LONG_BROKEN = `plugin "missing-tools" is not installed: ${'reason-segment '.repeat(12)}tail-of-the-reason`
const LONG: PresetPickerRoster = {
  roster: {
    presets: [
      { id: 'standard' },
      { id: LONG_ID, name: 'A long custom preset', description: LONG_DESCRIPTION, broken: LONG_BROKEN },
    ],
    defaultId: 'standard',
  },
  currentId: undefined,
  pendingId: undefined,
  defaultId: 'standard',
  canSetDefault: true,
}

/** Fixture `3`: a Custom declaration that reuses a SHIPPED id and publishes its own
 *  copy. It must stay Custom and must NOT borrow the official Mode guide. */
const REUSED: PresetPickerRoster = {
  roster: { presets: [{ id: 'minimal', name: 'My minimal', description: 'Mine, not the shipped one.' }], defaultId: 'minimal' },
  currentId: undefined,
  pendingId: undefined,
  defaultId: 'minimal',
  canSetDefault: true,
}

/** The failed read's message: LF, CRLF and an explicit BLANK line, so the flow can
 *  prove the client renders every break instead of collapsing the value. */
const FAILED = 'agent presets are unavailable\r\nsecond line\r\n\r\nfourth line'

/* ------------------------------------------------------------- describe() */

/** One node's own visible text: the `text` prop, or its `spans` runs joined. */
const ownText = (node: Node): string => {
  const props = (node.props ?? {}) as Record<string, unknown>
  if (typeof props['text'] === 'string') return props['text']
  const spans = props['spans']
  if (!Array.isArray(spans)) return ''
  return (spans as readonly unknown[])
    .map((run) => {
      if (typeof run === 'string') return run
      const record = run as { t?: unknown; text?: unknown }
      const value = record.t ?? record.text
      return typeof value === 'string' ? value : ''
    })
    .join('')
}

const nodeKey = (node: Node): string => {
  const key = ((node.props ?? {}) as Record<string, unknown>)['key']
  return typeof key === 'string' ? key : ''
}

/**
 * The frame the presenter REALLY built, reduced to what the flow asserts. The node
 * KEYS are recorded verbatim (they are the app's own identity contract: the picker and
 * the layer carry the panel serial, a reading page carries the panel serial and the
 * reading's epoch), and the Guide's Markdown arrives in full so a flow can prove its
 * completeness against the pinned official copy.
 */
const describe = (layer: Node) => {
  let picker: Node | undefined
  let overlay: Node | undefined
  let markdown: Node | undefined
  let backRow: Node | undefined
  const texts: Array<{ key: string; text: string }> = []
  let readingBodyKey: string | undefined
  const visit = (node: Node | undefined): void => {
    if (node === undefined) return
    const key = nodeKey(node)
    if (node.kind === 'picker' && picker === undefined) picker = node
    if (node.kind === 'overlay' && overlay === undefined) overlay = node
    if (node.kind === 'md' && markdown === undefined) markdown = node
    if (node.kind === 'row' && key.startsWith('preset-details-back-') && backRow === undefined) backRow = node
    if (node.kind === 'text' && (key.startsWith('details-') || key.startsWith('relation-') || key.startsWith('preset-details-back'))) {
      texts.push({ key, text: ownText(node) })
    }
    if (key.startsWith('preset-reading-body-')) readingBodyKey = key
    for (const child of node.children) visit(child)
  }
  visit(layer)
  const props = (picker?.props ?? {}) as Record<string, unknown>
  const actions = Array.isArray(props['actions'])
    ? (props['actions'] as readonly Record<string, unknown>[]).map((action) => ({
        id: String(action.id),
        label: action.label,
        primary: action.primary === true,
        disabled: action.disabled === true ? true : (typeof action.disabled === 'string' ? action.disabled : false),
      }))
    : undefined
  const items = Array.isArray(props['items'])
    ? (props['items'] as readonly Record<string, unknown>[]).map((item) => ({
        id: String(item.id),
        label: item.label,
        detail: item.detail,
        title: item.title,
        badges: item.badges,
        dot: item.dot,
        disabled: item.disabled,
      }))
    : undefined
  const mdText = markdown === undefined ? undefined : ownText(markdown)
  const backProps = (backRow?.props ?? {}) as Record<string, unknown>
  return {
    page: picker !== undefined ? 'catalog' : overlay !== undefined ? 'details' : 'none',
    head: overlay === undefined ? undefined : (overlay.props as Record<string, unknown>)['head'],
    pickerKey: picker === undefined ? undefined : nodeKey(picker),
    layerKey: layer === undefined ? undefined : nodeKey(layer),
    title: props['title'],
    subtitle: props['subtitle'],
    message: props['message'],
    state: props['state'],
    layout: props['layout'],
    size: props['size'],
    preview: props['preview'],
    query: props['query'],
    total: props['total'],
    selected: props['selected'],
    current: props['current'],
    propKeys: Object.keys(props).sort(),
    actions,
    order: props['order'],
    items,
    back: backRow === undefined ? undefined : {
      key: nodeKey(backRow),
      clickable: backProps['actions'] !== undefined,
    },
    readingBodyKey,
    texts,
    markdown: mdText === undefined ? undefined : { length: mdText.length, text: mdText },
  }
}

/** The wire id of the frame's picker node: the raw `Node` a presenter hands back has
 *  none, so it is read from the SDK's own tree exactly like the presenter does. */
const findNodeId = (layer: Node, kind: string): string | undefined => {
  let found: string | undefined
  const visit = (node: { readonly id?: string; readonly kind?: string; readonly children?: readonly unknown[] }): void => {
    if (node === undefined || found !== undefined) return
    if (node.kind === kind) {
      found = node.id
      return
    }
    for (const child of node.children ?? []) visit(child as { readonly id?: string; readonly kind?: string; readonly children?: readonly unknown[] })
  }
  for (const root of View.from({ layer }).regions) visit(root as { readonly id?: string; readonly kind?: string; readonly children?: readonly unknown[] })
  return found
}

/** The wire id of the frame's FIRST node whose own key starts with `prefix`. */
const findIdByKeyPrefix = (layer: Node, prefix: string): string | undefined => {
  let found: string | undefined
  const visit = (node: { readonly id?: string; readonly props?: Record<string, unknown>; readonly children?: readonly unknown[] }): void => {
    if (node === undefined || found !== undefined) return
    const key = node.props?.['key']
    if (typeof key === 'string' && key.startsWith(prefix)) {
      found = node.id
      return
    }
    for (const child of node.children ?? []) visit(child as { readonly id?: string; readonly props?: Record<string, unknown>; readonly children?: readonly unknown[] })
  }
  for (const root of View.from({ layer }).regions) visit(root as { readonly id?: string; readonly props?: Record<string, unknown>; readonly children?: readonly unknown[] })
  return found
}

/* ------------------------------------------------------------- the panel */

const session = await connect({ app: 'tern-pane-preset-native-ux', timeout: 2000 })
if (session === null) throw new Error('this subject must run inside a real Tern pane')
const surface = session.open({ mode: 'inline', title: 'preset-native-ux' })
note({ caps: session.caps })

let picker!: TspPresetPicker
let frames = 0
let lastLayer: Node | undefined
let pickerId: string | undefined
let fixture = 1
let sessionless = true

const draw = (): void => {
  const layer = picker.renderLayer()
  lastLayer = layer
  // A closed panel renders NO layer: the production renderer always substitutes the seat's
  // own layer there, so this subject does the same instead of handing the SDK `undefined`.
  surface.render({ layer: layer ?? ui.col({ key: 'preset-closed' }) })
  frames += 1
  pickerId = layer === undefined ? undefined : findNodeId(layer, 'picker')
  note({ frame: { n: frames, ...describe(layer) } })
}

picker = new TspPresetPicker({
  render: draw,
  canInteract: () => true,
  notify: (message) => note({ notify: message }),
  // The renderer owns the SDK: the presenter only names the node it built, and the op
  // really reaching the pane is recorded here.
  nativeScroll: (id, to) => {
    note({ nativeScroll: { id, to } })
    surface.scroll(id, to)
  },
})

const rosterOf = (): PresetPickerRoster => {
  if (fixture === 2) return LONG
  if (fixture === 3) return REUSED
  if (sessionless) return NORMAL_PENDING
  return NORMAL_LIVE
}

let handle = picker.presentation.open({
  subject: { sessionless },
  isCurrent: () => true,
  retry: () => note({ retry: true }),
  // A write is REFUSED on purpose (the panel must stay usable) but only after a real
  // delay, so the flow can observe the admitted-write frame while it is in flight.
  apply: async (id): Promise<PresetApplyOutcome> => {
    note({ apply: { id } })
    await sleep(1200)
    return { kind: 'rejected', message: `preset "${id}" does not resolve` }
  },
  setDefault: async (id): Promise<PresetDefaultOutcome> => {
    note({ setDefault: { id } })
    await sleep(1200)
    return { kind: 'unconfirmed', message: 'the settings write raised' }
  },
  runOwned: (_label, task, options) => {
    void task().then(
      (result) => options.onResult(result),
      (error: unknown) => options.onError(error),
    )
  },
})

/** Adopt the current fixture into the OPEN panel (the first load and every switch). */
const load = (label: string): void => {
  handle.setRoster(rosterOf())
  note({ fixture: label })
  draw()
}

/** Re-open the panel from scratch on the current fixture and subject. */
const reopen = (): void => {
  handle = picker.presentation.open({
    subject: { sessionless },
    isCurrent: () => true,
    retry: () => note({ retry: true }),
    apply: async (id): Promise<PresetApplyOutcome> => {
      note({ apply: { id } })
      await sleep(1200)
      return { kind: 'rejected', message: `preset "${id}" does not resolve` }
    },
    setDefault: async (id): Promise<PresetDefaultOutcome> => {
      note({ setDefault: { id } })
      await sleep(1200)
      return { kind: 'unconfirmed', message: 'the settings write raised' }
    },
    runOwned: (_label, task, options) => {
      void task().then(
        (result) => options.onResult(result),
        (error: unknown) => options.onError(error),
      )
    },
  })
  note({ reopen: { fixture, sessionless } })
  load(`reopen-${fixture}-${sessionless ? 'sessionless' : 'live'}`)
}

load('normal-sessionless')
note({ ready: true })

try {
  for await (const input of session) {
    if (input.type === 'key') {
      const key: Key = input.key
      if (key.name === 'f10') break
      // The subject's own phase controls, so the real-pane lane can exercise the open
      // panel through a failed or running read.
      if (key.text === 'e' || key.text === 'l') {
        if (key.text === 'e') handle.setLoadError(FAILED)
        else handle.setLoading()
        note({ control: key.text === 'e' ? 'load-error' : 'loading' })
        continue
      }
      // The stale-footer control: a well-formed id whose frame token is NOT the
      // revision this panel rendered, dispatched through the presenter's REAL
      // admission path.
      if (key.text === 'u') {
        const forged = 'use#99999'
        if (pickerId !== undefined) {
          picker.handleEvent({ ev: 'action', id: pickerId, act: forged } as unknown as TspEvent)
        }
        note({ control: 'forged-footer', id: pickerId, act: forged })
        continue
      }
      // The disabled-footer control: a raw click action addressed at the catalogue's
      // `set-default` BUTTON NODE the client really painted while it is disabled —
      // the pointer path a click would take, against an entry whose admission must
      // refuse it. (The v3 shape forged a click at the OVERVIEW's operation row; the
      // v4 footer is the only writer, so the control moved here.)
      if (key.text === 'g') {
        const id = pickerId
        if (id !== undefined) picker.handleEvent({ ev: 'action', id, act: 'set-default#' + '99999' } as unknown as TspEvent)
        note({ control: 'forged-disabled-footer', id })
        continue
      }
      if (key.text === 'r') {
        reopen()
        continue
      }
      if (key.text === 's') {
        sessionless = !sessionless
        reopen()
        continue
      }
      if (key.text === '1' || key.text === '2' || key.text === '3') {
        fixture = Number(key.text)
        load(`fixture-${key.text}`)
        note({ key: key.text })
        continue
      }
      note({ key: key.name ?? key.text ?? '?' })
      picker.handleKey(key)
      continue
    }
    const event = input.event as TspEvent
    note({
      event: {
        ev: event.ev,
        id: 'id' in event ? event.id : undefined,
        item: 'item' in event ? event.item : undefined,
        act: 'act' in event ? event.act : undefined,
      },
    })
    if (event.ev === 'resize' && typeof event.cols === 'number') {
      note({ resize: { cols: event.cols, cell: event.cell ?? null } })
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
