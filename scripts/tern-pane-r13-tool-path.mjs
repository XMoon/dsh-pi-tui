/**
 * The R13 real-pane qualification flow: the production TSP renderer whose tool
 * paths follow the CURRENT display-subject workspace.
 *
 *   TERN_PANE_R13_PRESET=full|compact|focus \
 *     TERN_BIN=/Applications/Tern.app/Contents/MacOS/tern \
 *     node scripts/tern-pane-drive.mjs scripts/tern-pane-r13-tool-path.mjs \
 *       --out <fresh dir>
 *
 * The flow runs IN-PROCESS with the driver (it reads `TERN_PANE_R13_PRESET`
 * from ITS OWN environment) and writes `preset.json` into the run directory
 * BEFORE `h.launch`, because the launcher does NOT forward driver env. It then
 * drives the subject through exactly three status-only cwd commits
 * (`cwd=C`, `cwd=B`, `cwd=unavailable`), each delivered as one atomically
 * renamed `case.json` and awaited through its `case-result.json`, and asserts
 * the painted tool paths from the REAL client node tree:
 *
 *   - B state:  every painted `ui.tool` target === `src/a.ts`, the
 *               Compact/Focus Action head is EXACTLY `Action: Read src/a.ts`,
 *               the Preparing row summary carries `src/a.ts`;
 *   - C and unavailable: the target is `/r13/workspace-B/src/a.ts`, the head is
 *               EXACTLY `Action: Read /r13/workspace-B/src/a.ts`, the summary
 *               carries the absolute path; NEVER a bare `src/a.ts`, never
 *               `/r13/launch-A` (the mount-time counter-example root);
 *   - the User node key and body text are byte-stable across ALL states;
 *   - `case-result.json` proves `setTranscriptCallsBefore === After` for every
 *               status-only commit (the no-event refresh claim).
 *
 * Disclosure consistency uses control-injected input ONLY to open EXISTING
 * Work/Tool heads (every such input is recorded CONTROL_INJECTED_INPUT). The
 * opened/collapsed verdict is read from the renderer's OWN committed section
 * prop on the real SDK wire, and the painted agreement from the client tree.
 * Visibility goes through the repository's geometry oracle: a node present in
 * the tree but clipped is recorded CLIPPED / NOT_VISUALLY_PROVEN, never a pass.
 *
 * Evidence tier: REAL_TERN_HEADLESS_RENDERER_SURFACE.
 * @module scripts/tern-pane-r13-tool-path
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { containedXY, containedX, fullyVisible, visibleSpan, visibleBox } from './tern-pane-geometry.mjs'

const EVIDENCE_TIER = 'REAL_TERN_HEADLESS_RENDERER_SURFACE'
const USER_TEXT = 'inspect the current workspace file'
const READY_TEXT = 'Preparing Read'
const WORKSPACE_B = '/r13/workspace-B'
const WORKSPACE_C = '/r13/workspace-C'
const ABS_B = `${WORKSPACE_B}/src/a.ts`
/**
 * The client paints a `sf-text` node with its LEADING WHITESPACE TRIMMED, so the
 * SDK summary text ` · src/a.ts` is painted as `· src/a.ts`. The oracle reads
 * the client's own bytes, so every painted-summary comparison uses this form.
 */
const paintedSummary = (path) => `· ${path}`
/**
 * The collapsed Action head text: `Action: <body>` where the body is the
 * running Read tool's display (`Read <path>`). The brief requires this EXACT
 * string, so the expected head is built in ONE place.
 */
const actionHeadText = (path) => `Action: Read ${path}`
const VIEWPORTS = [[1280, 800], [900, 700], [400, 600], [900, 360]]

const readJsonl = (path) => existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const events = (h) => readJsonl(join(h.root, 'events.jsonl'))
const wireRecords = (h) => readJsonl(join(h.root, 'sdk-wire.jsonl'))

/**
 * Fold the REAL SDK wire (the production `TERN_TSP_RECORD` hook) into the live
 * node tree the renderer actually committed. The client's `tree` command does
 * not expose SDK node ids, and both the "User node key is byte-stable" claim
 * and the opened/collapsed disclosure verdict need the ids and props the
 * renderer itself committed — not a DOM-path approximation.
 */
function foldLive(h) {
  const nodes = new Map()
  const remove = (id) => {
    const node = nodes.get(id)
    for (const child of node?.childIds ?? []) remove(child)
    nodes.delete(id)
  }
  const add = (node, parentId) => {
    if (node === undefined || node === null || typeof node.id !== 'string') return
    const childIds = (node.c ?? []).map(child => child.id).filter(id => typeof id === 'string')
    nodes.set(node.id, { id: node.id, k: node.k, p: { ...(node.p ?? {}) }, childIds, parentId })
    for (const child of node.c ?? []) add(child, node.id)
  }
  for (const entry of wireRecords(h)) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      if (op[0] === 'add') {
        remove(op[1])
        add(op[4], op[2])
        const parent = nodes.get(op[2])
        for (const child of (op[4]?.c ?? []).map(node => node.id)) {
          if (parent !== undefined && !parent.childIds.includes(child)) parent.childIds.push(child)
        }
      } else if (op[0] === 'del') {
        remove(op[1])
      } else if (op[0] === 'set') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          for (const [key, value] of Object.entries(op[2] ?? {})) {
            if (value === null) delete node.p[key]
            else node.p[key] = value
          }
        }
      } else if (op[0] === 'text') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          const before = typeof node.p.text === 'string' ? node.p.text : ''
          node.p.text = op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '')
        }
      }
    }
  }
  return nodes
}

const subtreeText = (live, id, visited = new Set()) => {
  if (visited.has(id)) return ''
  visited.add(id)
  const node = live.get(id)
  if (node === undefined) return ''
  const own = typeof node.p.text === 'string' ? node.p.text : ''
  return [own, ...node.childIds.map(child => subtreeText(live, child, visited))].filter(Boolean).join(' ')
}
const userRows = (live) => [...live.values()].filter(node => node.id.startsWith('main.')
  && node.k === 'message' && node.p.role === 'dsh.transcript.user')
/** Every `add` op the wire recorded for one node id (a re-mount would add a second). */
const addCount = (h, id) => wireRecords(h)
  .filter(entry => entry.dir === 'out' && entry.verb === 'f')
  .flatMap(entry => entry.body?.ops ?? [])
  .filter(op => op[0] === 'add' && op[1] === id).length
/** The renderer's OWN committed prop of one live node (the disclosure verdict). */
const liveProp = (live, id, prop) => live.get(id)?.p?.[prop]

// ── The REAL client node tree queries ───────────────────────────────────────
/** Every painted `ui.tool` target (the SDK `target` prop paints this span). */
const toolTargets = (snap) => snap.nodes
  .filter(node => String(node.class ?? '').includes('sf-tool-target'))
  .map(node => String(node.text ?? ''))
/** The Action heads (`Action: <body>`) — the Compact/Focus collapsed Activity. */
const actionHeads = (snap) => snap.nodes
  .filter(node => String(node.text ?? '').startsWith('Action: '))
  .map(node => String(node.text ?? ''))
/** The visible Preparing rows: a row whose own children carry the label. */
const preparingRows = (snap) => snap.nodes
  .filter(node => String(node.class ?? '').includes('sf-row')
    && (node.children ?? []).some(child => String(child.text ?? '').includes('Preparing')))
/** The Preparing row's own summary segment (` · <path>`), one per row. */
const preparingSummaries = (rows) => rows.map((row) => (row.children ?? [])
  .filter(child => String(child.class ?? '').includes('sf-text'))
  .map(child => String(child.text ?? ''))
  .find(text => text.trimStart().startsWith('· ')) ?? null)
/** The painted User body text node (the `p` inside the message's md block). */
const userBodyNode = (snap) => snap.nodes.find(node => String(node.text ?? '') === USER_TEXT)
/** Every collapsible head the client painted (a real Work/Tool head). */
const collapsibleHeads = (snap) => snap.nodes
  .filter(node => String(node.class ?? '').includes('sf-section-head')
    || String(node.class ?? '').includes('sf-tool-head'))

/**
 * Whether one probe verdict qualifies as a VISUALLY PROVEN required sink:
 * present in the tree, fully inside every clipping ancestor AND of positive
 * visible extent. `containedXY` alone is NOT enough (RFL-004): the geometry
 * oracle returns true for a zero-width/height node whose empty rect happens
 * to sit inside its ancestors, while `fullyVisible` rejects zero extent.
 * Exported so the zero-size negative probe exercises the REAL gate predicate.
 */
export const requiredSinkVisuallyProven = (verdict) =>
  verdict.found === true && verdict.containedXY === true && verdict.fullyVisible === true

/** The node that carries one exact text, with its geometry-oracle verdict.
 *  The comparison is on TRIMMED text: the client keeps a row segment's leading
 *  separator space (` · <summary>`), while the expected form is trimmed. */
function proveText(snap, text) {
  const node = snap.nodes.find(candidate => String(candidate.text ?? '').trim() === String(text).trim())
  if (node === undefined) return { found: false }
  return {
    found: true,
    node,
    containedXY: containedXY(snap.chains, node),
    fullyVisible: fullyVisible(snap.chains, node),
    containedX: containedX(snap.chains, node),
    span: { x: visibleSpan(snap.chains, node, 'x'), y: visibleSpan(snap.chains, node, 'y') },
    box: visibleBox(snap.chains, node),
  }
}

/** Every node carrying one exact text (trimmed), each with its verdict. */
function proveAllText(snap, text) {
  return snap.nodes
    .filter(candidate => String(candidate.text ?? '').trim() === String(text).trim())
    .map(node => ({
      found: true,
      node,
      containedXY: containedXY(snap.chains, node),
      fullyVisible: fullyVisible(snap.chains, node),
      containedX: containedX(snap.chains, node),
      span: { x: visibleSpan(snap.chains, node, 'x'), y: visibleSpan(snap.chains, node, 'y') },
      box: visibleBox(snap.chains, node),
    }))
}

async function waitFor(h, predicate, { limit = 250, intervalMs = 60 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (predicate()) return true
    await h.sleep(intervalMs)
  }
  return false
}

function atomicJson(path, value) {
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(value)}\n`)
  renameSync(temp, path)
}

export default async function (h) {
  const ledger = {
    evidenceTier: EVIDENCE_TIER,
    fixtureRationale: 'turn-2 live Preparing preview: a turn-1 preview is ADOPTED by the trailing open Work and the shipped compactPreparingSummary() (Preparing <Title>… only, never a path) would own the collapsed Action slot, so the required exact `Action: Read src/a.ts` would be unreachable; turn 1 carries a settled read (tool/result) and a running read (no result) in ONE Work span — the running read is what the collapsed Action head names, because a settled card would prefix it with `✓ `.',
    controlInjectedInputs: [],
    states: [],
    clipped: [],
    viewports: {},
    appearances: {},
    userNode: {},
    limitations: [],
  }
  h.check('TERN_PANE_R13_PRESET names one of full|compact|focus',
    ['full', 'compact', 'focus'].includes(String(process.env.TERN_PANE_R13_PRESET)),
    String(process.env.TERN_PANE_R13_PRESET))
  if (!['full', 'compact', 'focus'].includes(String(process.env.TERN_PANE_R13_PRESET))) {
    return h.finish({ ...ledger, qualification: 'FAILED_ASSERTIONS' })
  }
  const preset = String(process.env.TERN_PANE_R13_PRESET)
  ledger.preset = preset

  // The preset travels through the RUN DIRECTORY: the launcher does not forward
  // the driver process environment to the subject.
  atomicJson(join(h.root, 'preset.json'), { preset })
  h.check('preset.json was written into the run directory before launch',
    existsSync(join(h.root, 'preset.json')))

  // The wide light baseline every key state is captured against.
  await h.resize(1280, 800)
  h.send('appearance', 'light')
  h.check('the client resolved the light appearance at the baseline viewport',
    h.ctl('state').theme === 'light', JSON.stringify({ theme: h.ctl('state').theme }))
  ledger.appearances.light = h.ctl('state').theme
  ledger.viewports['1280x800-baseline'] = h.ctl('stats').viewport ?? null
  h.measure('viewport-1280x800-light', JSON.stringify(h.ctl('stats').viewport ?? null))

  const subject = join(h.repo, 'scripts', 'tern-pane-r13-tool-path-subject.mts')
  const booted = await h.launch(subject, { ready: READY_TEXT })
  h.check('the subject boots inside a real Tern pane', booted)

  // The subject's own record is the positive control: the boot commit happened
  // AFTER the transcript commit, and the flow snapshots only from there on.
  const subjectReady = await waitFor(h, () => events(h).some(entry => entry.kind === 'subject.ready'))
  h.check('the subject committed its boot display subject (B) before the first read', subjectReady,
    JSON.stringify(events(h).filter(entry => entry.kind === 'display.committed')))
  h.check('the subject mounted with the deliberate counter-example cwd /r13/launch-A',
    events(h).some(entry => entry.kind === 'subject.ready' && entry.mountCwd === '/r13/launch-A'))
  h.check('the subject applied the requested preset',
    events(h).some(entry => entry.kind === 'subject.ready' && entry.preset === preset),
    JSON.stringify(events(h).filter(entry => entry.kind === 'subject.ready')))

  /**
   * ONE state evaluation: the exact painted bytes, the User identity, the
   * geometry-oracle visibility, and every "never" invariant of this state.
   * `expected` is the tool path the CURRENT committed workspace must produce.
   */
  const evaluate = async (state, seq, expected, { barePathForbidden = false, forbiddenTexts = [] } = {}) => {
    // The painted frame must settle: wait until the state's Action/target is
    // what the committed workspace says, then take the REAL tree snapshot.
    const settled = await waitFor(h, () => {
      const snap = h.snapshot()
      return (preset === 'full'
        ? toolTargets(snap).includes(expected)
        : actionHeads(snap).includes(actionHeadText(expected)))
        && preparingSummaries(preparingRows(snap)).includes(paintedSummary(expected))
    })
    const snap = h.snapshot()
    const targets = toolTargets(snap)
    const heads = actionHeads(snap)
    const rows = preparingRows(snap)
    const summaries = preparingSummaries(rows)
    const userNode = userBodyNode(snap)
    const userText = String(userNode?.text ?? '')
    const live = foldLive(h)
    const users = userRows(live)
    const userId = users.length === 1 ? users[0].id : null
    const userWireText = userId === null ? '' : subtreeText(live, userId).trim()

    const record = {
      state, seq, expected, settled,
      toolTargets: targets, actionHeads: heads,
      preparingSummaries: summaries,
      userBodyText: userText,
      userNodeId: userId,
      userWireText,
      userAdds: userId === null ? null : addCount(h, userId),
      theme: h.ctl('state').theme,
      viewport: h.ctl('stats').viewport ?? null,
    }
    ledger.states.push(record)

    // ── the required exact bytes ──
    if (preset === 'full') {
      h.check(`[${state}] every painted ui.tool target is exactly ${JSON.stringify(expected)}`,
        targets.length > 0 && targets.every(target => target === expected),
        `targets=${JSON.stringify(targets)}`)
    } else {
      h.check(`[${state}] the Compact/Focus Action head is EXACTLY ${JSON.stringify(actionHeadText(expected))}`,
        heads.includes(actionHeadText(expected)), `heads=${JSON.stringify(heads)}`)
      h.check(`[${state}] every ui.tool target painted in the state is exactly ${JSON.stringify(expected)}`,
        targets.length === 0 || targets.every(target => target === expected),
        `targets=${JSON.stringify(targets)} (a collapsed Work paints no tool card)`)
    }
    h.check(`[${state}] the Preparing row summary is exactly ${JSON.stringify(paintedSummary(expected))}`,
      summaries.includes(paintedSummary(expected)), `summaries=${JSON.stringify(summaries)}`)
    h.check(`[${state}] exactly one Preparing row is painted`, rows.length === 1,
      `rows=${JSON.stringify(summaries)}`)

    // ── the User identity: the node the renderer committed + its bytes ──
    h.check(`[${state}] the User node body text is painted byte-exactly`, userText === USER_TEXT,
      JSON.stringify(userText))
    h.check(`[${state}] the real SDK wire carries exactly one User node`, users.length === 1,
      JSON.stringify(users.map(node => ({ id: node.id, text: subtreeText(live, node.id).trim() }))))
    if (userId !== null) {
      ledger.userNode[state] = { id: userId, adds: addCount(h, userId), text: userText }
      h.check(`[${state}] the User node id is byte-stable`, typeof userId === 'string' && userId.startsWith('main.'),
        JSON.stringify({ id: userId, text: userWireText }))
    }

    // ── the "never" invariants of this state (EXACT text matches; the absolute
    // path CONTAINS `src/a.ts`, so a substring test would be a false positive).
    // The mount-time root is forbidden in EVERY state, and `barePathForbidden`
    // adds the bare relative path as a prohibited EXACT output of this state ──
    const forbidden = ['/r13/launch-A', ...(barePathForbidden ? ['src/a.ts'] : []), ...(forbiddenTexts ?? [])]
    const allTexts = snap.nodes.map(node => String(node.text ?? ''))
    const offenders = allTexts.filter(text => forbidden.some(bad => text === bad
      || (bad === '/r13/launch-A' && text.includes(bad))))
    h.check(`[${state}] never ${barePathForbidden ? 'a bare src/a.ts or ' : ''}the mount-time root /r13/launch-A`,
      offenders.length === 0, JSON.stringify({ forbidden, offenders }))

    // ── the geometry oracle: what the CLIENT actually shows ──
    // Full paints the path on the card target (no Work container, no Action
    // head); Compact/Focus paint it on the collapsed Action head.
    const targetProbe = proveText(snap, expected)
    const probe = preset === 'full' ? targetProbe : proveText(snap, actionHeadText(expected))
    const summaryProbe = proveText(snap, paintedSummary(expected))
    const visible = { actionHead: probe, toolTarget: targetProbe, preparingSummary: summaryProbe }
    // ── R13-RV-01 / RFL-004: EVERY required painted path sink must be
    // VISUALLY PROVEN (present in the client tree, fully contained through
    // every clipping ancestor AND of positive visible extent — `fullyVisible`
    // rejects the zero-geometry node `containedXY` alone accepts) as a
    // DECISIVE check. A clipped, zero-extent or missing required sink FAILS
    // the run; a measurement can never carry that weight, so a CLIPPED /
    // NOT_VISUALLY_PROVEN item can no longer coexist with a run-level PASS. ──
    const provenance = (verdict) => verdict.found === true
      ? { containedXY: verdict.containedXY, fullyVisible: verdict.fullyVisible, box: verdict.box }
      : { found: false }
    const requireVisible = (label, verdict) => h.check(
      `[${state}] ${label} is visually proven (geometry oracle)`,
      requiredSinkVisuallyProven(verdict),
      JSON.stringify(provenance(verdict)))
    // The path sinks of this state: the Full Tool target (EVERY painted card
    // instance), the Compact/Focus collapsed Action head, and the Preparing
    // summary. A Tool target is intentionally ABSENT while a Compact/Focus
    // Work is collapsed — one that IS painted must be proven like any sink.
    const targetInstances = proveAllText(snap, expected)
    const summaryInstances = proveAllText(snap, paintedSummary(expected))
    if (preset === 'full') {
      h.check(`[${state}] at least one Tool target is painted`,
        targetInstances.length > 0, `instances=${targetInstances.length}`)
    }
    for (const [index, instance] of targetInstances.entries()) {
      requireVisible(`the painted Tool target (instance ${index + 1})`, instance)
    }
    if (preset !== 'full') {
      requireVisible('the Action head', probe)
    }
    h.check(`[${state}] at least one Preparing summary is painted`,
      summaryInstances.length > 0, `instances=${summaryInstances.length}`)
    for (const [index, instance] of summaryInstances.entries()) {
      requireVisible(`the Preparing summary (instance ${index + 1})`, instance)
    }
    const clipped = (probe.found === true && !requiredSinkVisuallyProven(probe))
      || targetInstances.some(instance => !requiredSinkVisuallyProven(instance))
      || summaryInstances.some(instance => !requiredSinkVisuallyProven(instance))
      || (preset === 'full' && targetInstances.length === 0)
      || summaryInstances.length === 0
    if (clipped) {
      const item = {
        state, viewport: record.viewport,
        actionHead: probe.found ? provenance(probe) : 'absent',
        toolTarget: targetInstances.map(provenance),
        preparingSummary: summaryInstances.map(provenance),
        verdict: 'CLIPPED / NOT_VISUALLY_PROVEN',
      }
      ledger.clipped.push(item)
      h.measure(`CLIPPED / NOT_VISUALLY_PROVEN ${state}@${JSON.stringify(record.viewport)}`, JSON.stringify(item))
    }
    // The run-level verdict may never coexist with a CLIPPED record of a
    // required sink (the ledger entry is the audit trail, this is the gate).
    h.check(`[${state}] no required path sink is CLIPPED / NOT_VISUALLY_PROVEN`,
      clipped === false, JSON.stringify(ledger.clipped))
    const proven = clipped === false
    return { snap, record, visible, proven, clipped }
  }

  // ── state B: the initial committed workspace ──
  const b = await evaluate('B', 0, 'src/a.ts', { forbiddenTexts: [ABS_B] })
  h.check('[B] the relative path is fully visible through every clipping ancestor at 1280x800 light',
    b.proven, JSON.stringify(b.visible.actionHead.box ?? b.visible.toolTarget.box))
  if (preset === 'full') {
    h.check('[B] the settled and the running Read card share the SAME root',
      b.record.toolTargets.length >= 2 && b.record.toolTargets.every(target => target === 'src/a.ts'),
      `targets=${JSON.stringify(b.record.toolTargets)}`)
  }
  const bCapture = h.capture('01-B-1280x800-light', 'B: workspace /r13/workspace-B — relative tool paths')

  /**
   * Disclosure consistency: control-injected input ONLY to open EXISTING
   * collapsed Work/Tool heads. A Focus root nests its Work section, so the
   * root's head is opened FIRST and the nested Work head (which only exists
   * once the root is open) SECOND — never a fabricated head, never a click
   * anywhere else. Every click is recorded CONTROL_INJECTED_INPUT; the
   * open/closed verdict is the renderer's OWN committed `collapsed` prop on
   * the real SDK wire, and the painted agreement is the client tree's
   * expanded tool targets vs the collapsed head's path.
   */
  const disclosureAt = async (state, expected, workspace) => {
    const openCount = () => {
      const live = foldLive(h)
      return [...live.values()].filter(node => node.p?.collapsible === true
        && node.p?.collapsed === false).length
    }
    const openBefore = openCount()
    let targets = []
    let clicks = 0
    /**
     * The deterministic head plan for THIS preset, outermost first: Full opens
     * the Tool card; Compact opens its one Work section; Focus opens the root
     * and THEN the nested Work head, which only exists once the root is open.
     * The head is identified by its own painted head text (`Working …` root vs
     * `Activity …` Work), never by document order alone.
     */
    const plan = preset === 'full' ? ['tool'] : preset === 'compact' ? ['work'] : ['root', 'work']
    const pickHead = (snap, kind) => {
      const heads = snap.nodes.filter(node => String(node.class ?? '').includes('sf-section-head')
        || String(node.class ?? '').includes('sf-tool-head'))
      if (kind === 'tool') return heads.find(node => String(node.class ?? '').includes('sf-tool-head'))
      const work = heads.find(node => h.descendantsText(node).startsWith('Activity'))
      const root = heads.find(node => h.descendantsText(node).startsWith('Working'))
      return kind === 'root' ? (root ?? work) : (work ?? root)
    }
    for (const kind of plan) {
      const snap = h.snapshot()
      const head = pickHead(snap, kind)
      if (head === undefined) break
      const headText = h.descendantsText(head)
      const clicked = await h.click(snap.chains, head)
      clicks += 1
      ledger.controlInjectedInputs.push({ state, kind, clicked, headText: headText.slice(0, 160) })
      h.measure(`CONTROL_INJECTED_INPUT open an EXISTING collapsed ${kind} head (${state}, click ${clicks})`,
        JSON.stringify({ clicked, kind, headText: headText.slice(0, 160) }))
      h.check(`[${state}] the control-injected click reached the EXISTING collapsed ${kind} head (click ${clicks})`,
        clicked === true)
      const grew = await waitFor(h, () => openCount() >= openBefore + clicks)
      h.check(`[${state}] the renderer committed that head OPEN on the real SDK wire (click ${clicks})`, grew,
        JSON.stringify({ openBefore, clicks, openNow: openCount() }))
    }
    targets = toolTargets(h.snapshot())
    h.check(`[${state}] the expanded content's path agrees with the collapsed head's path`,
      targets.length > 0 && targets.every(target => target === expected),
      `targets=${JSON.stringify(targets)}`)
    if (preset !== 'full') {
      h.check(`[${state}] the expanded Work paints BOTH Read cards under the SAME root`,
        targets.length >= 2 && targets.every(target => target === expected),
        `targets=${JSON.stringify(targets)}`)
    } else {
      // Full: the opened card body paints the RAW args path; the shipped rule
      // peels only the workspace root, so the raw path must agree with the head.
      const raw = h.snapshot().nodes
        .map(node => String(node.text ?? ''))
        .find(text => text.includes('"file_path"'))
      const expectedRaw = expected === 'src/a.ts' ? `${workspace}/src/a.ts` : expected
      h.check(`[${state}] the expanded card body carries the SAME file as the collapsed head`,
        typeof raw === 'string' && raw.includes(expectedRaw),
        JSON.stringify({ raw: raw?.slice(0, 160), expectedRaw }))
    }
    h.capture(`02-disclosure-${state}-1280x800-light`,
      'the opened Work/Tool head after the control-injected click(s)')
    // Collapse back: every later state must be read from the same collapsed shape.
    while (openCount() > openBefore) {
      const after = h.snapshot()
      const head = after.nodes.find(node => String(node.class ?? '').includes('sf-section-head')
        || String(node.class ?? '').includes('sf-tool-head'))
      if (head === undefined) break
      const closedClick = await h.click(after.chains, head)
      clicks += 1
      ledger.controlInjectedInputs.push({ state, kind: 'close-head', clicked: closedClick })
      h.measure(`CONTROL_INJECTED_INPUT click the open head to close it (${state}, click ${clicks})`,
        JSON.stringify({ clicked: closedClick }))
      await waitFor(h, () => openCount() < openBefore + clicks - 1 || openCount() <= openBefore)
    }
    const closed = openCount() === openBefore
      && toolTargets(h.snapshot()).every(target => target !== expected || preset === 'full')
    h.check(`[${state}] closing restores the collapsed shape (the state is readable again)`, closed,
      JSON.stringify({ openBefore, openNow: openCount() }))
  }
  await disclosureAt('B', 'src/a.ts', WORKSPACE_B)

  // ── the three status-only commits: cwd=C, cwd=B, cwd=unavailable ──
  const runCase = async (seq, cmd, state, expected, statusCwd, options = {}) => {
    atomicJson(join(h.root, 'case.json'), { seq, cmd })
    const settledResult = await waitFor(h, () => {
      const path = join(h.root, 'case-result.json')
      if (!existsSync(path)) return false
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'))
        return parsed.seq === seq && parsed.commitDone === true
      } catch { return false }
    })
    const recorded = settledResult === true
      ? JSON.parse(readFileSync(join(h.root, 'case-result.json'), 'utf8'))
      : null
    h.check(`[${state}] the subject applied seq ${seq} (${cmd}) and wrote its atomic result`, recorded !== null,
      JSON.stringify(recorded))
    h.check(`[${state}] the status-only commit did NOT re-commit the transcript`,
      recorded !== null && recorded.setTranscriptCallsBefore === recorded.setTranscriptCallsAfter,
      JSON.stringify(recorded && {
        before: recorded.setTranscriptCallsBefore, after: recorded.setTranscriptCallsAfter }))
    h.check(`[${state}] the committed workspace is ${JSON.stringify(statusCwd)}`,
      recorded !== null && recorded.statusCwd === statusCwd,
      JSON.stringify(recorded && { statusCwd: recorded.statusCwd }))
    return evaluate(state, seq, expected, options)
  }

  const c = await runCase(1, 'cwd=C', 'C', ABS_B, WORKSPACE_C, { barePathForbidden: true })
  h.check('[C] the absolute path is fully visible through every clipping ancestor at 1280x800 light',
    c.proven, JSON.stringify(c.visible.actionHead.box))
  h.capture('03-C-1280x800-light', 'C: workspace /r13/workspace-C — the B path stays absolute')

  // R13-RV-02: a POST-SWITCH native disclosure observation (plan §12.5): the
  // expanded content of the state AFTER a status-only switch must agree with
  // the same state's collapsed head, not only at B.
  await disclosureAt('C', ABS_B, WORKSPACE_C)

  const b2 = await runCase(2, 'cwd=B', 'B2', 'src/a.ts', WORKSPACE_B, { forbiddenTexts: [ABS_B] })
  h.check('[B2] the User node body text is byte-stable with the first B state',
    b2.record.userBodyText === b.record.userBodyText && b2.record.userBodyText === USER_TEXT,
    JSON.stringify({ first: b.record.userBodyText, second: b2.record.userBodyText }))
  h.check('[B2] the User node id is byte-stable with the first B state',
    b2.record.userNodeId === b.record.userNodeId,
    JSON.stringify({ first: b.record.userNodeId, second: b2.record.userNodeId }))

  const u = await runCase(3, 'cwd=unavailable', 'unavailable', ABS_B, '', { barePathForbidden: true })
  h.check('[unavailable] the User node body text is byte-stable with the first B state',
    u.record.userBodyText === b.record.userBodyText && u.record.userBodyText === USER_TEXT,
    JSON.stringify({ first: b.record.userBodyText, final: u.record.userBodyText }))
  h.check('[unavailable] the User node id is byte-stable with the first B state',
    u.record.userNodeId === b.record.userNodeId,
    JSON.stringify({ first: b.record.userNodeId, final: u.record.userNodeId }))
  h.capture('04-unavailable-1280x800-light', 'unavailable: cwdUnavailable — the B path stays absolute')

  // The positive control on the claim itself: the transcript was committed once
  // in the whole run, and the User node was mounted exactly once.
  h.check('the subject committed the transcript exactly ONCE for the whole run',
    events(h).filter(entry => entry.kind === 'transcript.committed').length === 1
      && events(h).every(entry => entry.calls === undefined || entry.calls === 1),
    JSON.stringify(events(h).filter(entry => entry.kind === 'transcript.committed'
      || entry.kind === 'command.applied')))
  if (typeof b.record.userNodeId === 'string') {
    const adds = addCount(h, b.record.userNodeId)
    h.check('the real SDK wire added the User node exactly ONCE across every status-only commit', adds === 1,
      JSON.stringify({ id: b.record.userNodeId, adds }))
    ledger.userNode.totalAdds = adds
  }
  // The settled-vs-running agreement again in the FINAL state (absolute root):
  // both painted cards must carry the same absolute path.
  if (preset === 'full') {
    h.check('[unavailable] the settled and the running Read card share the SAME absolute root',
      u.record.toolTargets.length >= 2 && u.record.toolTargets.every(target => target === ABS_B),
      `targets=${JSON.stringify(u.record.toolTargets)}`)
  }

  // ── the viewport sweep: what the client can actually show ──
  for (const [width, height] of VIEWPORTS) {
    await h.resize(width, height)
    const stats = h.ctl('stats')
    const viewport = stats.viewport ?? []
    ledger.viewports[`${width}x${height}`] = viewport
    h.measure(`viewport-${width}x${height}`, JSON.stringify({ viewport, state: 'unavailable' }))
    const sweep = await evaluate('unavailable', 3, ABS_B, { barePathForbidden: true })
    h.check(`[unavailable@${width}x${height}] the absolute path is visually proven by the geometry oracle`,
      sweep.proven, JSON.stringify(sweep.visible.actionHead.box))
  }
  await h.resize(400, 600)
  await evaluate('unavailable', 3, ABS_B, { barePathForbidden: true })
  h.capture('05-unavailable-400x600-light', 'the absolute path at a narrow viewport')

  // ── both appearances, read back from state (an {ok:true} reply is NOT evidence) ──
  await h.resize(1280, 800)
  h.send('appearance', 'dark')
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark',
    JSON.stringify({ theme: h.ctl('state').theme }))
  ledger.appearances.dark = h.ctl('state').theme
  await evaluate('unavailable', 3, ABS_B, { barePathForbidden: true })
  h.capture('06-unavailable-1280x800-dark', 'the surface in the dark appearance')
  h.send('appearance', 'light')
  h.check('the client resolved the light appearance again', h.ctl('state').theme === 'light',
    JSON.stringify({ theme: h.ctl('state').theme }))
  ledger.appearances.light = h.ctl('state').theme
  await evaluate('unavailable', 3, ABS_B, { barePathForbidden: true })
  h.capture('07-unavailable-1280x800-light', 'the surface back in the light appearance')

  // ── the run ledger: every state's painted bytes for the reviewer ──
  writeFileSync(join(h.root, 'r13-ledger.json'), `${JSON.stringify({
    ...ledger,
    captures: [bCapture, '02-disclosure-B-1280x800-light', '03-C-1280x800-light',
      '04-unavailable-1280x800-light', '05-unavailable-400x600-light',
      '06-unavailable-1280x800-dark', '07-unavailable-1280x800-light'],
    subjectRecord: events(h),
    wireAdds: typeof b.record.userNodeId === 'string'
      ? { [b.record.userNodeId]: addCount(h, b.record.userNodeId) } : {},
  }, null, 1)}\n`)

  return h.finish({
    qualification: `${EVIDENCE_TIER}_PASS`,
    preset,
    evidenceTier: EVIDENCE_TIER,
    fixtureRationale: ledger.fixtureRationale,
    userNode: ledger.userNode,
    viewports: ledger.viewports,
    appearances: ledger.appearances,
    controlInjectedInputs: ledger.controlInjectedInputs,
    clipped: ledger.clipped,
    limitations: ledger.limitations,
    physicalGui: 'NOT_VERIFIED by this headless lane',
  })
}
