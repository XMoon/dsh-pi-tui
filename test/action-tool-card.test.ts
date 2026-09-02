import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import {
  compactToolExpandedLines,
  compactToolPresentation,
  formatAgentListSummary,
  focusToolDisplay,
  interruptAgentCallPresentation,
  listAgentsCallPresentation,
  sendMessageCallPresentation,
  summarizeAgentListResult,
  terminalSendCallPresentation,
  toolCardHeader,
} from '../src/present.ts'
import type { CompactToolPresentation } from '../src/present.ts'
import { CompactTextPreview } from '../src/compact-text-preview.ts'
import { TuiApp, transcriptContentWidth } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of startedApps) {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
})

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

function actionMessage(
  name: string,
  args: Record<string, unknown>,
  result: string,
  status: 'ok' | 'error' | 'running' = 'ok',
  error?: { name: string; code: string },
) {
  return { kind: 'tool' as const, turn: 0, name, args: JSON.stringify(args), result, status, error }
}

test('action call presenters normalize standard and Team shapes', () => {
  assert.deepEqual(sendMessageCallPresentation(JSON.stringify({ agent_id: 'child-1', message: 'review' })), {
    target: 'child-1', message: 'review',
  })
  assert.deepEqual(sendMessageCallPresentation(JSON.stringify({ target: 'reviewer', message: 'inspect' })), {
    target: 'reviewer', message: 'inspect',
  })
  assert.deepEqual(interruptAgentCallPresentation(JSON.stringify({ agent_id: 'child-1' })), { target: 'child-1' })
  assert.deepEqual(interruptAgentCallPresentation(JSON.stringify({ target: 'reviewer' })), { target: 'reviewer' })
  assert.deepEqual(terminalSendCallPresentation(JSON.stringify({ sessionId: 'pty-3', text: 'make test' })), {
    sessionId: 'pty-3', text: 'make test',
  })
  assert.deepEqual(listAgentsCallPresentation('{}'), { scope: 'children' })
  assert.deepEqual(listAgentsCallPresentation(''), { scope: 'children' })
  assert.deepEqual(listAgentsCallPresentation('{"scope":"descendants"}'), { scope: 'descendants' })

  assert.equal(sendMessageCallPresentation(JSON.stringify({ agent_id: 'child-1' })), undefined)
  assert.equal(interruptAgentCallPresentation(JSON.stringify({ target: '' })), undefined)
  assert.equal(terminalSendCallPresentation(JSON.stringify({ sessionId: 'pty-3' })), undefined)
  assert.equal(listAgentsCallPresentation('{"scope":"invalid"}'), undefined)
})

test('compact action presentations are payload-first and receipt-safe', () => {
  const standard = compactToolPresentation(
    'send_message',
    JSON.stringify({ agent_id: 'child-1', message: 'Review the CI failure.' }),
    'message delivered to agent child-1',
  )
  assert.deepEqual(standard, {
    title: 'Send message',
    summary: 'child-1',
    payload: 'Review the CI failure.',
    suppressSuccessResult: true,
  })
  const accepted = compactToolPresentation(
    'send_message',
    JSON.stringify({ target: 'reviewer', message: 'Inspect the card.' }),
    JSON.stringify({ messageId: 'm1', status: 'accepted' }),
  )
  assert.equal(accepted?.result, undefined)
  assert.equal(accepted?.payload, 'Inspect the card.')
  const queued = compactToolPresentation(
    'send_message',
    JSON.stringify({ target: 'reviewer', message: 'Wake the reviewer.' }),
    JSON.stringify({ messageId: 'm2', status: 'queued' }),
  )
  assert.equal(queued?.result, 'queued')

  const terminal = compactToolPresentation(
    'terminal_send',
    JSON.stringify({ sessionId: 'pty-3', text: 'make test' }),
    'viewport output\n[wait: stdin_read]\n[session: running]',
  )
  assert.deepEqual(terminal, {
    title: 'Terminal', summary: 'pty-3', payload: 'make test', suppressSuccessResult: true,
  })
  assert.equal(compactToolPresentation(
    'terminal_send',
    JSON.stringify({ sessionId: 'pty-3', text: 'make test', run_in_background: true }),
    'started background job job-1',
  )?.result, 'started background job job-1')
  const interrupt = compactToolPresentation(
    'interrupt_agent',
    JSON.stringify({ target: 'reviewer' }),
    'interrupt requested for agent reviewer',
  )
  assert.equal(interrupt?.result, undefined)
  const failure = compactToolPresentation(
    'send_message',
    JSON.stringify({ agent_id: 'child-1', message: 'retry' }),
    'target is not a direct continuable child',
    { isError: true },
  )
  assert.equal(failure?.result, 'target is not a direct continuable child')
  assert.equal(compactToolPresentation('send_message', '{"agent_id":"child-1"}'), undefined)

  assert.deepEqual(toolCardHeader('send_message', JSON.stringify({ agent_id: 'child-1', message: 'review' })), {
    title: 'Send message', summary: 'child-1',
  })
  assert.deepEqual(toolCardHeader('terminal_send', JSON.stringify({ sessionId: 'pty-3', text: 'make' })), {
    title: 'Terminal', summary: 'pty-3',
  })
  assert.equal(focusToolDisplay({ name: 'send_message', args: JSON.stringify({ target: 'reviewer', message: 'Inspect the card.' }) }), 'Send message reviewer · Inspect the card.')
})

test('list_agents summarizes structured and rendered historical snapshots', () => {
  const structured = summarizeAgentListResult(JSON.stringify([
    { kind: 'child', id: '1', label: 'a', status: 'running' },
    { kind: 'child', id: '2', label: 'b', status: 'idle' },
    { kind: 'child', id: '3', label: 'c', status: 'ready' },
  ]))!
  assert.equal(formatAgentListSummary(structured), '3 agents · 1 running · 1 idle · 1 ready')
  assert.equal(formatAgentListSummary(summarizeAgentListResult('[]')!), 'no subagents')
  assert.equal(formatAgentListSummary(summarizeAgentListResult(JSON.stringify([
    { kind: 'diagnostic', id: 'x', reason: 'unavailable' },
  ]))!), '1 entry · 1 diagnostic')
  assert.equal(formatAgentListSummary(summarizeAgentListResult('1 [running] — a\n2 [idle] — b\n3 [ready] — c')!), '3 agents · 1 running · 1 idle · 1 ready')
  assert.equal(formatAgentListSummary(summarizeAgentListResult('(no subagents)')!), 'no subagents')

  const list = compactToolPresentation('list_agents', '{}', '1 [running] — a\n2 [idle] — b\n3 [ready] — c')
  assert.equal(list?.title, 'List agents')
  assert.equal(list?.summary, 'children')
  assert.equal(list?.result, '3 agents · 1 running · 1 idle · 1 ready')
  assert.deepEqual(compactToolExpandedLines('list_agents', '{}', '1 [running] — a\n2 [idle] — b'), [
    '1 [running] — a', '2 [idle] — b',
  ])
})

test('CompactTextPreview is Unicode-safe, capped, and re-derived on resize', () => {
  const preview = new CompactTextPreview({
    text: '检查 👨‍💻 flow and 🧪 regression.\nsecond payload with more details',
    maxVisualRows: 2,
    indent: '  ',
  })
  const narrow = preview.render(12)
  assert.equal(narrow.length, 2)
  assert.ok(narrow.some(line => line.includes('…')), `overflow marker missing: ${narrow.join('|')}`)
  for (const line of narrow) assert.ok(visibleWidth(line) <= 12, JSON.stringify(line))
  const wide = preview.render(60)
  assert.ok(wide.some(line => line.includes('second payload')), `wide render lost later payload: ${wide.join('|')}`)
  for (const line of wide) assert.ok(visibleWidth(line) <= 60, JSON.stringify(line))
  assert.deepEqual(preview.render(12), narrow, 'narrow cache must remain deterministic after a wide render')
})

test('folded action cards show payloads and suppress successful receipts', async () => {
  const vt = new VirtualTerminal(100, 32)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript([
    actionMessage('send_message', { agent_id: 'child-1', message: 'Review the CI failure.\nCompare the transition fence.' }, 'message delivered to agent child-1'),
    actionMessage('terminal_send', { sessionId: 'pty-3', text: 'make test' }, 'viewport output\n[wait: stdin_read]'),
    actionMessage('interrupt_agent', { agent_id: 'child-1' }, 'interrupt requested for agent child-1'),
    actionMessage('list_agents', { scope: 'children' }, '1 [running] — a\n2 [idle] — b\n3 [ready] — c'),
    actionMessage('send_message', { target: 'reviewer', message: 'Inspect the failed target.' }, JSON.stringify({ messageId: 'm1', status: 'accepted' })),
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('Send message · child-1 [ok]'), view)
  assert.ok(view.includes('Review the CI failure.'), view)
  assert.ok(view.includes('Compare the transition fence.'), view)
  assert.ok(view.includes('Terminal · pty-3 [ok]'), view)
  assert.ok(view.includes('make test'), view)
  assert.ok(view.includes('Interrupt agent · child-1 [ok]'), view)
  assert.ok(view.includes('List agents · children [ok]'), view)
  assert.ok(view.includes('3 agents · 1 running · 1 idle · 1 ready'), view)
  assert.ok(view.includes('Inspect the failed target.'), view)
  assert.ok(!view.includes('message delivered to agent'), view)
  assert.ok(!view.includes('interrupt requested for agent'), view)
  assert.ok(!view.includes('viewport output'), view)
  assert.ok(!view.includes('"messageId"'), view)
})

test('expanded action cards keep payloads, historical snapshots, and terminal output', async () => {
  const vt = new VirtualTerminal(100, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setToolOutputExpanded(true)
  app.setTranscript([
    actionMessage('send_message', { agent_id: 'child-1', message: 'first line\nsecond line\nthird line' }, 'message delivered to agent child-1'),
    actionMessage('terminal_send', { sessionId: 'pty-3', text: 'make test' }, 'viewport output\n[wait: stdin_read]'),
    actionMessage('list_agents', { scope: 'children' }, '1 [running] — a\n2 [ready] — b'),
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('first line'), view)
  assert.ok(view.includes('second line'), view)
  assert.ok(view.includes('third line'), view)
  assert.ok(view.includes('viewport output'), view)
  assert.ok(view.includes('[wait: stdin_read]'), view)
  assert.ok(view.includes('1 [running] — a'), view)
  assert.ok(view.includes('2 [ready] — b'), view)
  assert.ok(!view.includes('message delivered to agent'), view)
})

test('terminal_send payload is added above a dedicated terminal result view', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({ card: 'terminal', title: 'make test' }),
      result: () => ({ card: 'terminal', output: 'terminal output', exitCode: 0 }),
    },
  })
  app.start()
  startedApps.add(app)
  app.setToolOutputExpanded(true)
  app.setTranscript([actionMessage(
    'terminal_send',
    { sessionId: 'pty-3', text: 'make test' },
    'rendered viewport',
  )])
  const view = await viewport(vt)
  assert.ok(view.includes('make test'), view)
  assert.ok(view.includes('terminal output'), view)
  assert.ok(view.includes('[exit 0]'), view)
})

test('action payload preview survives narrow-wide-narrow resize without stale truncation', async () => {
  const vt = new VirtualTerminal(24, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript([actionMessage(
    'send_message',
    { agent_id: 'child-1', message: 'alpha beta gamma delta epsilon\nsecond payload' },
    'message delivered to agent child-1',
  )])
  const narrow = await viewport(vt)
  assert.ok(!narrow.includes('second payload'), narrow)
  vt.resize(80, 24)
  const wide = await viewport(vt)
  assert.ok(wide.includes('second payload'), wide)
  assert.ok(visibleWidth(stripTerminalSequences(wide.split('\n').find(line => line.includes('second payload')) ?? '')) <= transcriptContentWidth(80), wide)
  vt.resize(24, 24)
  const narrowAgain = await viewport(vt)
  assert.ok(!narrowAgain.includes('second payload'), narrowAgain)
})

test('action errors remain visible in folded cards', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript([actionMessage(
    'interrupt_agent',
    { target: 'missing-child' },
    'target is not interruptible',
    'error',
    { name: 'SubagentError', code: 'NOT_INTERRUPTIBLE' },
  )])
  const view = await viewport(vt)
  assert.ok(view.includes('Interrupt agent · missing-child [error]'), view)
  assert.ok(view.includes('SubagentError: NOT_INTERRUPTIBLE'), view)
  assert.ok(view.includes('target is not interruptible'), view)
})

// Keep the imported model type checked as a public data-only contract.
const _compactModelTypeCheck: CompactToolPresentation | undefined = compactToolPresentation('send_message', '{}')
void _compactModelTypeCheck
