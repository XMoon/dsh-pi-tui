/**
 * Real Tern qualification of the production Direct native-conversation surface.
 * Run once per preset in a fresh Tern pane root; GUI mode uses the same flow.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { containedXY, rect, visibleBox, visiblePoint, visibleSpan } from './tern-pane-geometry.mjs'

const PRESET = process.env.TSP_CONVERSATION_PRESET ?? 'full'
const MODE = process.env.TSP_CONVERSATION_MODE ?? 'headless'
const SOURCE_REPO = process.env.TSP_CONVERSATION_REPO ?? process.cwd()
const SUBJECT = join(import.meta.dirname, 'tern-pane-conversation-layout-subject.mts')
const TERN_PATH = process.env.TERN_BIN ?? '/home/xmoon/.local/bin/tern'
const VIEWPORTS = [
  { id: 'M1', width: 1280, height: 800, appearance: 'dark' },
  { id: 'M2', width: 900, height: 700, appearance: 'light' },
  { id: 'M3', width: 420, height: 650, appearance: 'dark' },
  { id: 'M4', width: 400, height: 600, appearance: 'dark' },
  { id: 'M5', width: 900, height: 360, appearance: 'light' },
]

const descendants = node => {
  const out = []
  const visit = current => {
    out.push(current)
    for (const child of current.children ?? []) visit(child)
  }
  if (node !== undefined) visit(node)
  return out
}
const textOf = node => descendants(node).map(child => String(child.text ?? '')).filter(Boolean).join('\n')
const attrsOf = node => ({ ...(node.attrs ?? {}), ...(node.props ?? {}) })
const allText = snapshot => snapshot.nodes.map(node => String(node.text ?? '')).filter(Boolean).join('\n')
const subjectEvents = h => readJsonl(join(h.root, 'subject-events.jsonl'))
const sdkEvents = h => readJsonl(join(h.root, 'sdk-wire.jsonl'))
const copyPayloads = h => readJsonl(join(h.root, 'copy-payloads.jsonl'))
function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function waitFor(h, label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await h.sleep(40)
  }
  h.check(label, false, 'timed out waiting for the observed production/client fact')
  return false
}
function commitCase(h, id, kind) {
  const target = join(h.root, 'case.json')
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ id, kind })}\n`, { mode: 0o600 })
  renameSync(tmp, target)
}
function currentMessage(snapshot, marker) {
  return snapshot.nodes.find(node => (node.tag === 'message' || String(node.class ?? '').split(/\s+/u).includes('sf-message'))
    && textOf(node).includes(marker))
}
function copyLabel(node) {
  const attrs = attrsOf(node)
  return [node.text, node.label, node.title, node.aria, attrs.text, attrs.title, attrs.aria]
    .filter(value => typeof value === 'string').join(' ')
}
function actionButtonForUser(snapshot, message) {
  const inside = new Set(descendants(message))
  return snapshot.nodes.find(node => inside.has(node) && node.tag === 'button'
    && /Copy user message/iu.test(copyLabel(node)))
}
function assistantCopyButton(snapshot) {
  return snapshot.nodes.find(node => node.tag === 'button'
    && /(^|\s)Copy(\s|$)/u.test(copyLabel(node))
    && !/Copy (?:SVG|Data|chart|the history)/iu.test(copyLabel(node))
    && !String(node.class ?? '').split(/\\s+/u).includes('code-copy'))
}
function region(snapshot, name) {
  return snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))
}
function safeRect(node) {
  return node === undefined ? undefined : rect(node)
}
function recordViewport(h, spec, resized, captureId) {
  const snapshot = h.snapshot()
  const main = region(snapshot, 'sf-main')
  const dock = region(snapshot, 'sf-dock')
  const user = currentMessage(snapshot, 'TSP-QUESTION-MIXED')
  const answer = snapshot.nodes.find(node => String(node.text ?? '').includes('TSP-ANSWER-FINAL'))
  const userVisible = user === undefined ? undefined : {
    rect: rect(user),
    contained: containedXY(snapshot.chains, user),
    vertical: visibleSpan(snapshot.chains, user, 'y'),
  }
  const answerVisible = answer === undefined ? undefined : {
    rect: rect(answer),
    contained: containedXY(snapshot.chains, answer),
    vertical: visibleSpan(snapshot.chains, answer, 'y'),
  }
  return {
    id: spec.id,
    requested: [spec.width, spec.height],
    actual: resized.viewport,
    clamped: resized.clamped,
    theme: h.ctl('state').theme,
    captureId,
    main: main === undefined ? undefined : visibleBox(snapshot.chains, main),
    dock: dock === undefined ? undefined : visibleBox(snapshot.chains, dock),
    user: userVisible,
    answer: answerVisible,
    messageTextVisible: allText(snapshot).includes('TSP-QUESTION-MIXED')
      || allText(snapshot).includes('TSP-ANSWER-FINAL'),
  }
}

export function currentFrameCopyActions(records) {
  return records.filter(event => event.ev === 'action' && event.act === 'dsh-transcript-copy')
}
export function exactCopyOutcomes(records) {
  return records.filter(event => event.kind === 'client.copy.result')
}
function inputActionRecords(records) {
  return currentFrameCopyActions(records
    .filter(record => record.dir === 'in' && record.verb === 'e')
    .map(record => record.body))
}
export function transcriptCopyNodeId(records, kind) {
  // Anchor to the SAME marker the flow clicks, so the expected id is provably the
  // exact message under test (not whichever copy node a reverse walk hits first).
  const marker = kind === 'user' ? 'TSP-QUESTION-MIXED' : 'TSP-ANSWER-FINAL'
  const textOf = node => {
    let text = typeof node.p?.text === 'string' ? node.p.text : ''
    for (const child of node.c ?? []) text += `\n${textOf(child)}`
    return text
  }
  const findCopyButton = node => {
    if (node.k === 'button' && node.p?.role === 'dsh.transcript.copy'
      && node.p?.actions?.click === 'dsh-transcript-copy') return node.id
    for (const child of node.c ?? []) {
      const found = findCopyButton(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  let found
  const visit = node => {
    if (kind === 'user') {
      if (node.k === 'message' && node.p?.role === 'dsh.transcript.user'
        && Array.isArray(node.p?.actions) && node.p.actions.some(action => action?.act === 'dsh-transcript-copy')
        && textOf(node).includes(marker)) found = node.id
    } else if (textOf(node).includes(marker)) {
      // Deepest subtree carrying the marker wins over any transcript-root match.
      const button = findCopyButton(node)
      if (button !== undefined) found = button
    }
    for (const child of node.c ?? []) visit(child)
  }
  for (const frame of records.filter(record => record.dir === 'out' && record.verb === 'f')) {
    for (const op of frame.body?.ops ?? []) {
      if (op[0] === 'add' && op[4] !== undefined) visit(op[4])
    }
  }
  return found
}
export function qualifiesClipboardSink(actionEvents, outcomes, expectedPayloads) {
  const ids = actionEvents.map(event => event.id)
  const surfaceIds = actionEvents.map(event => event.sf)
  const identityIsExact = ids.every(id => typeof id === 'string' && id !== '')
    && new Set(ids).size === ids.length
    && surfaceIds.every(id => typeof id === 'string' && id !== '')
    && new Set(surfaceIds).size <= 1
  return identityIsExact
    && actionEvents.length === expectedPayloads.length
    && outcomes.length === expectedPayloads.length
    && expectedPayloads.every((payload, index) => outcomes[index]?.payload === payload && outcomes[index]?.copied === true)
}

export default async function (h) {
  const version = h.ctl('stats')
  h.check('the pane reports a live viewport before the subject starts', Array.isArray(version.viewport), JSON.stringify(version.viewport))
  if (MODE === 'gui') {
    const system = h.ctl('system')
    h.check('the GUI run owns a real display window', (system.displays ?? []).length > 0, JSON.stringify({ title: system.title, displays: system.displays }))
  }

  const initialSize = [1280, 800]
  let firstSize
  if (MODE === 'gui') firstSize = await h.resize(...initialSize)
  else {
    await h.resize(...initialSize)
    firstSize = { requested: initialSize, viewport: h.ctl('stats').viewport ?? [], clamped: false }
  }
  h.check('M1 request reaches the intended content viewport', !firstSize.clamped, JSON.stringify(firstSize))
  if (MODE === 'gui') {
    if (h.ctl('state').theme !== 'dark') h.send('plugins', 'run', 'appearance:dark')
  } else {
    h.send('appearance', 'dark')
  }
  h.check('the client resolved the dark appearance', h.ctl('state').theme === 'dark', String(h.ctl('state').theme))

  writeFileSync(join(h.root, 'subject-config.json'), `${JSON.stringify({ sourceRoot: SOURCE_REPO, preset: PRESET })}\n`, { mode: 0o600 })
  await h.launch(SUBJECT)
  await waitFor(h, 'the isolated Direct TSP fixture starts', () =>
    subjectEvents(h).some(event => event.kind === 'subject.ready')
    && h.texts(h.snapshot()).some(text => /What would you like to work on\?|Message/u.test(text)))
  commitCase(h, 1, 'seed')
  await waitFor(h, 'the fixed synthetic Session events commit through the real Direct fixture', () =>
    subjectEvents(h).some(event => event.kind === 'fixture.seeded')
    && h.texts(h.snapshot()).some(text => text.includes('TSP-ANSWER-FINAL')))

  const hello = sdkEvents(h).find(record => record.dir === 'in' && record.verb === 'r' && record.body?.r === 'hello')?.body
  const clientIdentity = {
    ternVersion: execFileSync(TERN_PATH, ['--version'], { encoding: 'utf8' }).trim(),
    ternSha256: createHash('sha256').update(readFileSync(TERN_PATH)).digest('hex'),
    preset: PRESET,
    mode: MODE,
    sourceRoot: process.env.TSP_CONVERSATION_REPO,
    sourceCommit: execFileSync('git', ['-C', process.env.TSP_CONVERSATION_REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sdkIntegrity: 'sha512-yPHByMKANO4618AsN20f8kanmaSLQiozpBJYV/hoDY3q3BTLCdX+fVc2LNF3lN/iNASJ1TCxutl5YjvDQ5jnOw==',
    sdkCaps: hello,
  }
  h.measure('client and source identity', JSON.stringify(clientIdentity))
  if (MODE !== 'baseline') {
    h.check('the SDK negotiated native message and button nodes', hello?.kinds?.includes('message') === true
      && hello?.kinds?.includes('button') === true, JSON.stringify(hello?.kinds ?? []))
  }

  if (MODE !== 'baseline') {
  const seededTree = h.snapshot()
  const user = currentMessage(seededTree, 'TSP-QUESTION-MIXED')
  h.check('the real Direct projection paints a native User message', user !== undefined,
    JSON.stringify(seededTree.nodes.filter(node => node.tag === 'message').map(node => ({ id: node.id, text: textOf(node), attrs: attrsOf(node) })).slice(-4)))
  const withoutLegacyLabels = !seededTree.nodes.some(node => /^(You|Assistant)$/.test(String(node.text ?? '')))
  h.check('the painted transcript has no You or Assistant heading text', withoutLegacyLabels)
  const imageNodes = descendants(user).filter(node => node.tag === 'img' || /image/u.test(String(node.class ?? '')))
  h.check('the mixed message retains its actual image child', imageNodes.length > 0,
    JSON.stringify(descendants(user).map(node => ({ tag: node.tag, class: node.class, text: node.text }))))
  h.check('the Assistant source fixture includes the published Chart and SVG in order',
    seededTree.nodes.some(node => node.tag === 'canvas' || /chart/u.test(String(node.class ?? '')))
      && seededTree.nodes.some(node => node.tag === 'img' || /image/u.test(String(node.class ?? ''))),
    `nodes=${seededTree.nodes.length}`)
  h.check('a User time uses the UTC wall-clock form', seededTree.nodes.some(node => /\b\d{2}:\d{2} UTC\b/u.test(String(node.text ?? ''))),
    JSON.stringify(seededTree.nodes.filter(node => /UTC/u.test(String(node.text ?? ''))).map(node => String(node.text))))
  if (PRESET === 'focus') {
    h.check('the Focus preset does not paint per-message duration stats (no duplication)',
      !seededTree.nodes.some(node => String(node.text ?? '').includes('Took')),
      JSON.stringify(seededTree.nodes.filter(node => /Took/u.test(String(node.text ?? ''))).map(node => String(node.text))))
  } else {
    h.check('the final Assistant footer carries sourced duration and token facts',
      seededTree.nodes.some(node => String(node.text ?? '').includes('Took'))
        && seededTree.nodes.some(node => /\btok\b/u.test(String(node.text ?? ''))),
      JSON.stringify(seededTree.nodes.filter(node => /Took|\btok\b/u.test(String(node.text ?? ''))).map(node => String(node.text))))
  }

  const userCopy = user === undefined ? undefined : actionButtonForUser(seededTree, user)
  h.check('the user message exposes a real visible Copy icon control', userCopy !== undefined,
    JSON.stringify(seededTree.nodes.filter(node => node.tag === 'button').map(node => ({ id: node.id, label: copyLabel(node), class: node.class }))))
  let currentUserCopy = userCopy
  let userSnapshot = seededTree
  let pageUps = 0
  for (; userCopy !== undefined && visiblePoint(userSnapshot.chains, currentUserCopy) === undefined && pageUps < 6; pageUps += 1) {
    await h.key('PageUp', 300)
    userSnapshot = h.snapshot()
    currentUserCopy = actionButtonForUser(userSnapshot, currentMessage(userSnapshot, 'TSP-QUESTION-MIXED'))
  }
  // The Dock AND the client's floating "back to live" button (tv-back) are sibling
  // overlays, not clipping ancestors: when the transcript is scrolled away from the
  // tail, tv-back paints over the bottom-right corner — exactly where the
  // right-aligned User action icon sits. Lift the icon fully above BOTH with the
  // client's own Main wheel scroll (the same path the inner-disclosure lane uses).
  const copyCeiling = snapshot => {
    const dock = region(snapshot, 'sf-dock')
    const back = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('tv-back'))
    const tops = [dock === undefined ? undefined : rect(dock)[1], back === undefined ? undefined : rect(back)[1]]
      .filter(value => typeof value === 'number')
    return tops.length === 0 ? undefined : Math.min(...tops)
  }
  let wheelLifts = 0
  for (; currentUserCopy !== undefined && wheelLifts < 8; wheelLifts += 1) {
    const point = visiblePoint(userSnapshot.chains, currentUserCopy)
    const ceiling = copyCeiling(userSnapshot)
    const box = rect(currentUserCopy)
    if (point === undefined || ceiling === undefined || box[1] + box[3] < ceiling - 4) break
    const main = region(userSnapshot, 'sf-main')
    if (main === undefined) break
    const mainRect = rect(main)
    const amount = Math.min(240, Math.max(24, Math.ceil(box[1] + box[3] - ceiling + 12)))
    h.send('move', mainRect[0] + mainRect[2] / 2, ceiling - 40)
    h.send('wheel', 0, amount)
    await h.sleep(250)
    userSnapshot = h.snapshot()
    currentUserCopy = actionButtonForUser(userSnapshot, currentMessage(userSnapshot, 'TSP-QUESTION-MIXED'))
  }
  const userPoint = currentUserCopy === undefined ? undefined : visiblePoint(userSnapshot.chains, currentUserCopy)
  const userCeiling = copyCeiling(userSnapshot)
  const userBox = currentUserCopy === undefined ? undefined : rect(currentUserCopy)
  const userClickable = userPoint !== undefined && userBox !== undefined
    && (userCeiling === undefined || userBox[1] + userBox[3] < userCeiling - 4)
  h.check('the current-frame User Copy action is visible above the Dock and the tv-back overlay',
    userClickable,
    JSON.stringify({ pagesSent: pageUps, wheelLifts, point: userPoint, ceiling: userCeiling, button: userBox }))
  if (userClickable) {
    const clickPoint = currentUserCopy === undefined ? undefined : visiblePoint(userSnapshot.chains, currentUserCopy)
    if (clickPoint !== undefined) {
      h.capture('user-icon-preclick', 'client tree at the exact User icon click moment')
      const covering = userSnapshot.nodes.filter(node => {
        const r = rect(node)
        return r[2] > 0 && r[3] > 0
          && clickPoint.x >= r[0] && clickPoint.x <= r[0] + r[2]
          && clickPoint.y >= r[1] && clickPoint.y <= r[1] + r[3]
      })
      h.measure('nodes whose rect contains the User icon click point (paint order, deepest last)',
        JSON.stringify(covering.map(node => ({ tag: node.tag, class: node.class, id: node.id, rect: rect(node) }))))
    }
    const clicked = currentUserCopy !== undefined && await h.click(userSnapshot.chains, currentUserCopy)
    h.check('the user Copy icon receives one visible control-channel pointer click', clicked,
      JSON.stringify({ box: currentUserCopy === undefined ? undefined : rect(currentUserCopy) }))
    const userActions = inputActionRecords(sdkEvents(h))
    const expectedUserId = transcriptCopyNodeId(sdkEvents(h), 'user')
    h.check('that User pointer click emits the current custom action and reaches ClientActions',
      userActions.length === 1 && exactCopyOutcomes(subjectEvents(h)).length === 1
        && userActions[0]?.id === expectedUserId && userActions[0]?.act === 'dsh-transcript-copy',
      JSON.stringify({ actions: userActions, expectedUserId, outcomes: exactCopyOutcomes(subjectEvents(h)) }))
  }

  const assistantCopyButton = snapshot => {
    const finalText = snapshot.nodes.find(node => String(node.text ?? '').includes('TSP-ANSWER-FINAL'))
    if (finalText === undefined) return undefined
    const ancestors = snapshot.chains.get(finalText) ?? []
    const assistantRoot = ancestors.findLast(node => {
      const subtree = descendants(node)
      return subtree.some(child => String(child.text ?? '').includes('TSP-ANSWER-FINAL'))
        && subtree.some(child => child.tag === 'button' && String(child.class ?? '').includes('sf-button')
          && textOf(child).trim() === 'Copy')
    })
    if (assistantRoot === undefined) return undefined
    const subtree = new Set(descendants(assistantRoot))
    return snapshot.nodes.find(node => subtree.has(node) && node.tag === 'button'
      && String(node.class ?? '').includes('sf-button')
      && textOf(node).trim() === 'Copy')
  }
  const targetAssistantCopy = assistantCopyButton(h.snapshot())
  h.check('the Assistant footer exposes its actual native quiet Copy button', targetAssistantCopy !== undefined,
    JSON.stringify(h.snapshot().nodes.filter(node => node.tag === 'button').map(node => ({ id: node.id, label: copyLabel(node), class: node.class }))))
  let assistantUserInput = false
  if (targetAssistantCopy !== undefined) {
    let assistantSnapshot = h.snapshot()
    let assistantButton = assistantCopyButton(assistantSnapshot)
    let pageDowns = 0
    for (; assistantButton !== undefined && visiblePoint(assistantSnapshot.chains, assistantButton) === undefined && pageDowns < 6; pageDowns += 1) {
      await h.key('PageDown', 300)
      assistantSnapshot = h.snapshot()
      assistantButton = assistantCopyButton(assistantSnapshot)
    }
    const actionsBeforeAssistant = inputActionRecords(sdkEvents(h)).length
    const copiesBeforeAssistant = exactCopyOutcomes(subjectEvents(h)).length
    assistantUserInput = assistantButton !== undefined && await h.click(assistantSnapshot.chains, assistantButton)
    h.check('the Assistant footer Copy button receives one visible control-channel pointer click', assistantUserInput,
      JSON.stringify({ pageDowns, id: assistantButton?.id, rect: assistantButton === undefined ? undefined : rect(assistantButton) }))
    const assistantActions = inputActionRecords(sdkEvents(h)).slice(actionsBeforeAssistant)
    const assistantCopies = exactCopyOutcomes(subjectEvents(h)).slice(copiesBeforeAssistant)
    // The client DOM tree carries no TSP node ids; the exact current id is the
    // one the production frame assigned to this Assistant Copy button.
    const expectedAssistantId = transcriptCopyNodeId(sdkEvents(h), 'assistant')
    h.check('that Assistant pointer click emits its exact current action node id', assistantActions.length === 1
      && expectedAssistantId !== undefined
      && assistantActions[0]?.id === expectedAssistantId
      && assistantActions[0]?.sf === 's1'
      && assistantActions[0]?.act === 'dsh-transcript-copy',
      JSON.stringify({ actions: assistantActions, expectedAssistantId }))
    h.check('that Assistant action reaches one real ClientActions.copySelection result', assistantCopies.length === 1
      && assistantCopies[0]?.payload === 'TSP-ANSWER-FINAL 最终建议：先处理 p99 上游延迟，再复核数据库连接。'
      && assistantCopies[0]?.copied === true,
      JSON.stringify(assistantCopies.map(({ payload, copied }) => ({ payload, copied }))))
  }
  let focusedAssistantCopy = false
  let focusTrace = []
  if (targetAssistantCopy !== undefined) {
    const targetSubtree = new Set(descendants(targetAssistantCopy))
    for (let step = 0; step < 32 && !focusedAssistantCopy; step += 1) {
      await h.key(step % 2 === 0 ? 'Tab' : 'Shift+Tab', 180)
      const snapshot = h.snapshot()
      const focused = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes('focused'))
      focusTrace.push({ focused: focused?.id, class: focused?.class, label: focused === undefined ? undefined : copyLabel(focused) })
      if (focused !== undefined && targetSubtree.has(focused)) {
        focusedAssistantCopy = true
        await h.key('Enter', 900)
      }
    }
  }
  h.measure('native keyboard activation observation', focusedAssistantCopy
    ? `the client's actual focus reached its Assistant Copy node: ${JSON.stringify(focusTrace.slice(-8))}`
    : `NOT_VERIFIED_UPSTREAM; focus stayed on the Composer: ${JSON.stringify(focusTrace.slice(-8))}`)
  h.check('the actual Clipboard outcomes still match the successful pointer routes',
    exactCopyOutcomes(subjectEvents(h)).length === inputActionRecords(sdkEvents(h)).length,
    JSON.stringify({ actions: inputActionRecords(sdkEvents(h)), outcomes: exactCopyOutcomes(subjectEvents(h)) }))

  const actionEvents = currentFrameCopyActions(sdkEvents(h).filter(record => record.dir === 'in' && record.verb === 'e').map(record => record.body))
  const outcomes = exactCopyOutcomes(subjectEvents(h))
  const expected = ['TSP-QUESTION-MIXED 检查这一段日志，保留 CJK 与代码：\n```ts\nconst ready = true\n```\n窄屏文本：这是一个用于验证原生消息气泡边界与换行的长中文句子。\nlongword_without_break_that_must_wrap_in_a_narrow_native_message_bubble\n\n图像保持在原始 block 位置。',
    'TSP-ANSWER-FINAL 最终建议：先处理 p99 上游延迟，再复核数据库连接。']
  h.check('two real client action events reach two one-to-one production copySelection results',
    qualifiesClipboardSink(actionEvents, outcomes, expected),
    JSON.stringify({ actionEvents, outcomes: outcomes.map(({ payload, copied }) => ({ payload, copied })) }))
  h.measure('native clipboard helper invocation (OS clipboard NOT_VERIFIED)', JSON.stringify(copyPayloads(h)
    .map(({ payload }) => payload)))
  }

  const layout = []
  for (const spec of VIEWPORTS) {
  const requested = [spec.width, spec.height]
  let resized
  if (MODE === 'gui') resized = await h.resize(spec.width, spec.height)
  else {
    await h.resize(spec.width, spec.height)
    const actual = h.ctl('stats').viewport ?? []
    resized = { requested, viewport: actual, clamped: actual[0] !== spec.width || actual[1] !== spec.height }
  }
  h.measure(`${spec.id} requested/actual viewport`, JSON.stringify(resized))
    if (spec.height <= 360) await h.key('End', 350)
    if (MODE === 'gui') {
      const current = h.ctl('state').theme
      if (current !== spec.appearance) h.send('plugins', 'run', `appearance:${spec.appearance}`)
    } else {
      h.send('appearance', spec.appearance)
    }
    h.check(`${spec.id} client appearance resolved`, h.ctl('state').theme === spec.appearance, String(h.ctl('state').theme))
    const snap = h.snapshot()
    const captureId = h.capture(`${PRESET}-${spec.id}-${spec.width}x${spec.height}-${spec.appearance}`,
      `${MODE} Direct transcript ${PRESET} at ${spec.width}x${spec.height}`)
    const evidence = recordViewport(h, spec, resized, captureId)
    layout.push(evidence)
    const main = region(snap, 'sf-main')
    const dock = region(snap, 'sf-dock')
    h.check(`${spec.id} keeps Main and Dock as distinct non-zero client regions`,
      main !== undefined && dock !== undefined && rect(main)[2] > 0 && rect(dock)[2] > 0,
      JSON.stringify({ main: safeRect(main), dock: safeRect(dock) }))
    const visibleText = allText(snap)
    h.check(`${spec.id} paints at least one real transcript message`,
      visibleText.includes('TSP-QUESTION-MIXED') || visibleText.includes('TSP-ANSWER-FINAL'),
      visibleText.slice(-800))
    if (spec.width <= 420) {
      const visibleUser = currentMessage(snap, 'TSP-QUESTION-MIXED')
      h.check(`${spec.id} preserves the beginning of the long CJK User body when it is in view`,
        visibleUser === undefined || textOf(visibleUser).includes('TSP-QUESTION-MIXED'),
        JSON.stringify(evidence.user))
    }
    if (spec.height <= 360) {
      const mainBox = main === undefined ? undefined : visibleBox(snap.chains, main)
      const dockBox = dock === undefined ? undefined : visibleBox(snap.chains, dock)
      const mainTop = mainBox?.start.y
      const mainBottom = mainBox === undefined ? undefined : mainBox.start.y + mainBox.span.y
      const dockTop = dockBox?.start.y
      const dockBottom = dockBox === undefined ? undefined : dockBox.start.y + dockBox.span.y
      h.check(`${spec.id} keeps the visible Dock outside the clipped Main content`,
        mainBottom === undefined || dockTop === undefined || dockBottom === undefined
          || mainBottom <= dockTop + 1 || dockBottom <= mainTop + 1,
        JSON.stringify({ main: mainBox, dock: dockBox }))
    }
  }
  writeFileSync(join(h.root, 'conversation-layout.json'), `${JSON.stringify({
    ...clientIdentity,
    viewports: layout,
    physicalKeyboard: 'NOT_VERIFIED',
    osClipboard: MODE === 'baseline'
      ? 'NOT_RUN for clipboard qualification; before screenshots only'
      : 'NOT_VERIFIED; controlled xclip helper observed the production ClientActions sink',
  }, null, 2)}\n`)
  h.measure('qualification observation tier', MODE === 'gui'
    ? 'REAL_TERN_GUI + CONTROL_INJECTED_INPUT; OS_INPUT_VERIFIED and OS clipboard NOT_VERIFIED'
    : MODE === 'baseline' ? 'REAL_TERN_HEADLESS baseline only; no new contract claims'
      : 'REAL_TERN_HEADLESS + CONTROL_INJECTED_INPUT; physical GUI and OS clipboard NOT_VERIFIED')
  h.capture(`${PRESET}-qualification-final`, 'final rendered conversation after the responsive matrix')
}
