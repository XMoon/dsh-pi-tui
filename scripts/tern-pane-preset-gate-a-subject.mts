/**
 * The subject of the `/preset` v4 Gate A feasibility spike.
 *
 * It mounts STANDALONE probe pages (no production presenter) over one official SDK
 * inline surface, driven by number keys, and records on `events.jsonl` everything that
 * really arrived: the client capability set, every resize, every key, every raw
 * action/select event, and the reduced props of every rendered frame — so the flow
 * proves the probes it asserts without importing a TypeScript module.
 *
 * The probes (one per Gate A question):
 *   1  CATALOG 3-BUTTON (A1): the native picker action bar with `Use next` /
 *      `Set default` / `Close` at `layout:'cards'`, plus a disabled `Set default`
 *      whose `disabled` prop carries its REASON STRING (the SDK's
 *      `PickerAction.disabled: true | string`).
 *   2  DETAILS BACK BUTTON + STYLES (A4/A6): an `lg` overlay whose first node is an
 *      `html.button` Back carrying `class` + `role`, with a surface-scoped
 *      stylesheet installed once before the first frame (border/padding/focus),
 *      plus `ui.text`/`ui.md` body content.
 *   3  STATUS SLOTS (A1 text): the picker with `lead`, `subtitle` and `message`
 *      props carrying the committed-facts line — what the client really paints of
 *      each, at every tested width.
 *   4  SINGLE-SCROLL READER (A3): the same overlay shape with a TALL markdown body
 *      (the pinned `standard` guide repeated), for End-key scroll evidence.
 *
 * Usage: node --import tsx/esm scripts/tern-pane-preset-gate-a-subject.mts
 * @module scripts/tern-pane-preset-gate-a-subject
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { css, connect, html, span, ui, View, type Key, type Node, type TspEvent } from '@stencil-hq/tern'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => {
  appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
}

const session = await connect({ app: 'tern-pane-preset-gate-a', timeout: 2000 })
if (session === null) throw new Error('this subject must run inside a real Tern pane')
// `forwardActions: ['click']` makes the session YIELD the raw button action event
// even though the node carries an onClick handler (the SDK dispatches the handler
// AND forwards the event only for forwarded action names). The production preset
// presenter instead routes every control through admission, so it never needs this;
// the probe measures the raw client shape, so it does. `role` must be an OPEN-time
// option (it rides the `o` message as the regions' `data-surface`): assigning
// `surface.role` after open does nothing (MEASURED in this spike's first round —
// the sheet was delivered but never matched, so the button kept its raw shape).
const surface = session.open({ mode: 'inline', title: 'preset-gate-a', role: 'preset-gate-a', forwardActions: ['click'] })
note({ caps: session.caps })

/* The surface-scoped stylesheet for the Back button (A6). Selector ladder probe:
 * the first rule is scoped the documented way (`data-surface` ancestor), the
 * second falls back to the surface's own region classes (`.sf-layer` + the
 * region id attr can't be used — MEASURED: this 0.8.3 client emits NO data-*
 * attribute for `class`/`role` el props; `role` never reached the DOM as
 * `data-role` in rounds 2–3), and the third scopes by class alone. Whichever
 * matches, the layout dump proves it: border+padding change the button box. */
const BACK_CSS = css`
  .preset-back-btn {
    color: rgb(220, 0, 0);
    font-weight: 700;
    padding: 2px 10px;
  }
`
surface.stylesheet('preset-gate-a-back', BACK_CSS)

let frames = 0
let lastView: ReturnType<typeof View.from> | undefined
let clicks = 0
let probe = '1'

/** The pinned official `standard` guide body (a faithful copy of the pinned
 *  upstream copy for the scroll probe; completeness is asserted in production
 *  suites, not here). */
const TALL_GUIDE = ['## Mode details', '### How it works', 'Choose Standard mode when starting a new task. Describe what you want to accomplish, point to the relevant files, and explain how to check the result.', '### When to choose it', 'Start here for everyday coding, file work, and research. Standard mode can also write scripts and process files in batches.', '## How to use', '### Fix a bug', '> Find out why submitting the search form twice makes the results disappear. Fix it and run the relevant tests. Explain the cause and what changed.', 'Expected output: a code change, the relevant test results, and an explanation of the cause.'].join('\n\n')

const ownText = (node: Node): string => {
  const props = (node.props ?? {}) as Record<string, unknown>
  if (typeof props['text'] === 'string') return props['text']
  const spans = props['spans']
  if (!Array.isArray(spans)) return ''
  return (spans as readonly unknown[]).map((run) => typeof run === 'string' ? run : ((run as { t?: unknown }).t ?? '')).join('')
}

/** Reduce one frame to the props the flow asserts, verbatim. */
const describe = (layer: Node | undefined) => {
  if (layer === undefined) return { page: 'closed' }
  let picker: Node | undefined
  let overlay: Node | undefined
  let button: Node | undefined
  let md: Node | undefined
  const visit = (node: Node): void => {
    if (node.kind === 'picker' && picker === undefined) picker = node
    if (node.kind === 'overlay' && overlay === undefined) overlay = node
    if (node.kind === 'el' && button === undefined) button = node
    if (node.kind === 'md' && md === undefined) md = node
    for (const child of node.children) visit(child)
  }
  visit(layer)
  const props = (picker?.props ?? {}) as Record<string, unknown>
  const actions = Array.isArray(props['actions'])
    ? (props['actions'] as readonly Record<string, unknown>[]).map((action) => ({
        id: String(action.id),
        label: action.label,
        primary: action.primary === true,
        end: action.end === true,
        disabled: action.disabled === true ? true : (typeof action.disabled === 'string' ? action.disabled : false),
      }))
    : undefined
  const buttonProps = (button?.props ?? {}) as Record<string, unknown>
  return {
    page: picker !== undefined ? 'catalog' : overlay !== undefined ? 'details' : 'none',
    probe,
    title: props['title'],
    subtitle: props['subtitle'],
    lead: props['lead'],
    message: props['message'],
    state: props['state'],
    layout: props['layout'],
    actions,
    button: button === undefined ? undefined : {
      tag: buttonProps['tag'],
      class: buttonProps['class'],
      role: buttonProps['role'],
      actions: Object.keys(buttonProps['actions'] ?? {}),
      text: button === undefined ? undefined : ownText(button),
    },
    mdLength: md === undefined ? undefined : ownText(md).length,
    head: overlay === undefined ? undefined : (overlay.props as Record<string, unknown>)['head'],
  }
}

const draw = (layer: Node): void => {
  frames += 1
  surface.render({ layer })
  lastView = View.from({ layer })
  note({ frame: { n: frames, ...describe(layer) } })
}

/** The wire id the SDK gave the probe-4 reading body THIS view, resolved from the
 *  view the presenter built (never a guessed path) — the production presenter's
 *  own resolution rule. */
const findReadingBodyId = (): string | undefined => {
  let found: string | undefined
  const visit = (node: { readonly id?: string; readonly children?: readonly unknown[] }): void => {
    if (node === undefined || found !== undefined) return
    if (typeof node.id === 'string' && node.id.includes('gate-reading-body')) found = node.id
    for (const child of node.children ?? []) visit(child as { readonly id?: string; readonly children?: readonly unknown[] })
  }
  for (const root of lastView?.regions ?? []) visit(root)
  return found
}

/** Probe 1: the catalogue with THREE native actions, `Set default` disabled with its
 *  reason string, and the status line on `subtitle` (the measured tooltip slot). */
const catalogue = (): Node =>
  ui.picker({
    key: 'gate-picker',
    title: 'Agent presets',
    noun: 'preset',
    layout: 'cards',
    size: 'md',
    preview: 'none',
    subtitle: 'Next session: none · Default: standard',
    placeholder: 'Search presets…',
    items: [
      { id: 'preset:standard', label: 'Standard mode', detail: 'Built-in · Full coding agent', title: 'standard', badges: [{ text: 'Default' }] },
      { id: 'preset:ptc', label: 'PTC mode', detail: 'Built-in · Programmatic Tool Calling', title: 'ptc' },
    ],
    order: [{ group: 'g-builtin', label: 'Built-in', count: 2 }, 'preset:standard', 'preset:ptc'],
    total: 2,
    selected: 'preset:standard',
    focus: 'list',
    state: 'ready',
    actions: [
      { id: 'close', label: 'Close' },
      { id: 'set-default', label: 'Set default', disabled: 'Already the default', primary: true },
      { id: 'use', label: 'Use next', primary: true },
    ],
  })

/** Probe 2: the Details page — an `html.button` Back (class+role for the scoped
 *  sheet) followed by the read-only identity/body content. */
const details = (): Node =>
  ui.overlay({ key: 'gate-details', head: 'Standard mode', size: 'lg', modal: true },
    html.button({
      key: 'gate-back',
      class: 'preset-back-btn',
      role: 'preset.back',
      onClick: () => {
        clicks += 1
        note({ backClick: clicks })
        draw(catalogue())
        probe = '1'
      },
    }, '← Back'),
    ui.col({ key: 'gate-body', gap: 'xs' },
      ui.text({ key: 'gate-id', text: 'standard', wrap: 'char' }),
      ui.text({ key: 'gate-type', spans: ['Type: ', 'Built-in'] }),
      ui.text(span('Description', 'muted')),
      ui.text({ key: 'gate-desc', text: 'Full coding agent with editing, shell, search, skills, planning and goals.', wrap: 'word' }),
    ),
  )

/** Probe 3: the status SLOTS — the same committed-facts line on `lead`, then on
 *  `message`, so the flow can record what the client really paints of each. */
const statusSlots = (which: 'lead' | 'message'): Node =>
  ui.picker({
    key: 'gate-slots',
    title: 'Agent presets',
    noun: 'preset',
    layout: 'cards',
    size: 'md',
    preview: 'none',
    placeholder: 'Search presets…',
    ...(which === 'lead' ? { lead: 'Next session: none · Default: standard' } : { message: 'Next session: none · Default: standard' }),
    items: [
      { id: 'preset:standard', label: 'Standard mode', detail: 'Built-in · Full coding agent' },
    ],
    order: [{ group: 'g-builtin', label: 'Built-in', count: 1 }, 'preset:standard'],
    total: 1,
    selected: 'preset:standard',
    focus: 'list',
    state: 'ready',
    actions: [
      { id: 'close', label: 'Close' },
      { id: 'use', label: 'Use next', primary: true },
    ],
  })

/** Probe 4: the tall single-scroll reader (A3). */
const reader = (): Node =>
  ui.overlay({ key: 'gate-reader', head: 'Standard mode', size: 'lg', modal: true },
    html.button({
      key: 'gate-reader-back',
      class: 'preset-back-btn',
      role: 'preset.back',
      onClick: () => {
        clicks += 1
        note({ backClick: clicks })
      },
    }, '← Back'),
    ui.col({ key: 'gate-reading-body', gap: 'xs' },
      ui.md({ key: 'gate-md', text: TALL_GUIDE }),
      ui.md({ key: 'gate-md-2', text: TALL_GUIDE }),
      ui.md({ key: 'gate-md-3', text: TALL_GUIDE }),
      ui.md({ key: 'gate-md-4', text: TALL_GUIDE }),
    ),
  )

const draw_ = (p: string): void => {
  probe = p
  // The layer REGION root is the production shape: ONE `ui.col` wrapping the page
  // node (the production `presetPickerLayer` does exactly this). MEASURED (this
  // spike's first run): a BARE `ui.picker` as the region root is accepted by the
  // SDK and ACKed by the client, but the client paints NOTHING for it — the
  // `sf-layer` region stays empty. The wrap is not cosmetic; it is load-bearing.
  const page = p === '1' ? catalogue() : p === '2' ? details() : p === '3' ? statusSlots('lead') : p === '3m' ? statusSlots('message') : reader()
  draw(ui.col({ key: 'gate-layer' }, page))
}

draw_('1')
note({ ready: true })

for await (const input of session) {
  if (input.type === 'key') {
    const key: Key = input.key
    if (key.name === 'f10') break
    // `4` first, then `m` re-renders the LAST page (used as "probe 3m": `3` then `m`).
    if (key.text === '1' || key.text === '2' || key.text === '4') {
      note({ control: `probe-${key.text}` })
      draw_(key.text)
      continue
    }
    if (key.text === '3') {
      note({ control: 'probe-3' })
      draw_('3')
      continue
    }
    if (key.text === 'm') {
      note({ control: 'probe-3m' })
      draw_('3m')
      continue
    }
    // Reading keys drive the reader body EXACTLY like the production presenter:
    // the app resolves the body node's real wire id from the view it built and
    // asks the ONE surface owner to scroll it. (MEASURED in this spike's first
    // reader round: the client does NOT scroll the overlay body on its own from
    // a bare End key — the app's `scroll` op is the only mover.)
    if (probe === '4' && (key.name === 'end' || key.name === 'page_down' || key.name === 'down')) {
      const to = key.name === 'end' ? 'end' : key.name === 'page_down' ? 'page-down' : 'line-down'
      const id = findReadingBodyId()
      note({ readerScroll: { id, to } })
      if (id !== undefined) surface.scroll(id, to)
      continue
    }
    note({ key: key.name ?? key.text ?? '?' })
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
    // Re-render the SAME probe so the client re-lays it at the new viewport.
    draw_(probe)
  }
}

note({ closed: true })
await surface.close({ keep: false })
await session.close()

// The source hash of the stylesheet text travels with the run.
note({ stylesheet: { name: 'preset-gate-a-back', sha: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 12) } })
