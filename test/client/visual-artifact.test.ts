/**
 * PR-D: search and Markdown export read the durable visual facts, never a
 * rendered PNG/blob derivative.
 *
 * The chart values live in the final result text; the SVG source lives in the
 * durable tool-call arguments and the result carries the description plus the
 * credential. Both consumers therefore reproduce the authorized facts on a
 * cold path.
 * @module @xmoon76/dsh-pi-tui/visual-artifact.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { renderTranscriptMarkdown } from '../../src/client/artifact/transcript-markdown.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { transcriptSearchText } from '../../src/domain/transcript/search.ts'
import { chartContentBlocks, chartFactFromArgs } from '../../src/domain/visual/chart.ts'
import { svgContentBlocks, svgFactFromArgs } from '../../src/domain/visual/svg.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12">Gateway</text></svg>'

const CHART_ARGS = {
  kind: 'bars' as const,
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}
const SVG_ARGS = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }

function events(): never[] {
  return [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } } as never,
    { type: 'step/start', seq: 2, time: 1, data: { turn: 1, step: 0 } } as never,
    { type: 'tool/call', seq: 3, time: 1, data: { turn: 1, step: 0, callId: ToolCallId('call-chart'), name: 'dsh_pi_tui_chart', arguments: JSON.stringify(CHART_ARGS) } } as never,
    {
      type: 'tool/result', seq: 4, time: 1,
      data: {
        turn: 1, step: 0,
        message: createToolResultMessage({
          callId: ToolCallId('call-chart'),
          content: chartContentBlocks(chartFactFromArgs(CHART_ARGS)),
          isError: false,
        }),
      },
    } as never,
    { type: 'tool/call', seq: 5, time: 1, data: { turn: 1, step: 0, callId: ToolCallId('call-svg'), name: 'dsh_pi_tui_svg', arguments: JSON.stringify(SVG_ARGS) } } as never,
    {
      type: 'tool/result', seq: 6, time: 1,
      data: {
        turn: 1, step: 0,
        message: createToolResultMessage({
          callId: ToolCallId('call-svg'),
          content: svgContentBlocks(svgFactFromArgs(SVG_ARGS)),
          isError: false,
        }),
      },
    } as never,
  ]
}

test('search finds the chart values and the authorized SVG source', () => {
  const folder = new TranscriptFolder()
  folder.apply(events() as never)
  const chart = folder.messages().find(message => message.kind === 'tool' && message.name === 'dsh_pi_tui_chart')
  const svg = folder.messages().find(message => message.kind === 'tool' && message.name === 'dsh_pi_tui_svg')
  assert.ok(chart !== undefined && svg !== undefined)
  const chartText = transcriptSearchText(chart)
  assert.match(chartText, /p50/u)
  assert.match(chartText, /42/u)
  const svgText = transcriptSearchText(svg)
  assert.match(svgText, /Service topology/u)
  assert.match(svgText, /Gateway/u)
  assert.match(svgText, /<svg/u, 'the durable call source is searchable')
})

test('Markdown export carries the authorized facts, never a PNG/blob derivative', () => {
  const markdown = renderTranscriptMarkdown({
    header: { id: 'visual-artifact', cwd: '/ws', version: 4, createdAt: 0, isSeeded: false, delegationDepth: 0 },
    snapshotEvents: () => events() as never,
  } as never)
  assert.match(markdown, /Request latency/u)
  assert.match(markdown, /42 ms/u)
  assert.match(markdown, /Gateway -> App -> Database/u)
  assert.match(markdown, /<svg/u, 'the export keeps the authorized SVG source from the call')
  assert.doesNotMatch(markdown, /blobId/u, 'no client blob id becomes durable export material')
  assert.doesNotMatch(markdown, /base64/u, 'no raster bytes are exported')
})

/** One durable call/result pair carrying the given blocks. */
function pair(
  turn: number,
  step: number,
  seq: number,
  callId: string,
  name: string,
  args: unknown,
  content: readonly { type: 'text'; text: string }[],
): never[] {
  return [
    {
      type: 'tool/call', seq, time: 1,
      data: { turn, step, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) },
    } as never,
    {
      type: 'tool/result', seq: seq + 1, time: 1,
      data: {
        turn, step,
        message: createToolResultMessage({
          callId: ToolCallId(callId),
          content: content as never,
          isError: false,
        }),
      },
    } as never,
  ]
}

const REF_LINE = 'visual-ref-v1:sv1_0123456789abcdef0123'
const PUBLISHED_LINE = 'visual-published-v1:{"version":1,"published":[{"ref":"sv1_0123456789abcdef0123"}]}'

test('the readable export drops the three visual tools’ machine tails but keeps their human text', () => {
  const chartFact = chartFactFromArgs(CHART_ARGS)
  const chartBlocks = chartContentBlocks(chartFact) as { type: 'text'; text: string }[]
  const markdown = renderTranscriptMarkdown({
    header: { id: 'visual-machine', cwd: '/ws', version: 4, createdAt: 0, isSeeded: false, delegationDepth: 0 },
    snapshotEvents: () => [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never,
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 0 } } as never,
      ...pair(1, 0, 2, 'call-chart', 'dsh_pi_tui_chart', CHART_ARGS,
        [chartBlocks[0] as { type: 'text'; text: string }, { type: 'text', text: REF_LINE }, chartBlocks[1] as { type: 'text'; text: string }]),
      ...pair(1, 1, 5, 'call-present', 'present_visual', { visuals: [{ ref: 'sv1_0123456789abcdef0123' }] },
        [{ type: 'text', text: 'Selected 1 visual for presentation.' }, { type: 'text', text: PUBLISHED_LINE }]),
    ] as never,
  } as never)
  assert.match(markdown, /Request latency/u, 'the human chart text is exported')
  assert.match(markdown, /Selected 1 visual for presentation\./u, 'the human publication summary is exported')
  assert.doesNotMatch(markdown, /visual-ref-v1:/u, 'the reference machine block is not readable export material')
  assert.doesNotMatch(markdown, /^visual-v1:/mu, 'the fact machine block is not readable export material')
  assert.doesNotMatch(markdown, /visual-published-v1:/u, 'the receipt machine block is not readable export material')
})

test('the readable export keeps another tool’s lookalike machine text verbatim', () => {
  const lookalike = `${REF_LINE}\n${PUBLISHED_LINE}`
  const markdown = renderTranscriptMarkdown({
    header: { id: 'visual-lookalike', cwd: '/ws', version: 4, createdAt: 0, isSeeded: false, delegationDepth: 0 },
    snapshotEvents: () => [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never,
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 0 } } as never,
      ...pair(1, 0, 2, 'call-bash', 'bash', { command: 'cat out.txt' }, [{ type: 'text', text: lookalike }]),
    ] as never,
  } as never)
  assert.match(markdown, /visual-ref-v1:sv1_0123456789abcdef0123/u, 'a non-visual tool’s text is untouched')
  assert.match(markdown, /visual-published-v1:/u, 'even a receipt-looking line from another tool survives')
})

test('search never indexes a visual tool’s machine tails', () => {
  const chartFact = chartFactFromArgs(CHART_ARGS)
  const chartBlocks = chartContentBlocks(chartFact) as { type: 'text'; text: string }[]
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never,
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 0 } } as never,
    ...pair(1, 0, 2, 'call-chart', 'dsh_pi_tui_chart', CHART_ARGS,
      [chartBlocks[0] as { type: 'text'; text: string }, { type: 'text', text: REF_LINE }, chartBlocks[1] as { type: 'text'; text: string }]),
    ...pair(1, 1, 5, 'call-present', 'present_visual', { visuals: [{ ref: 'sv1_0123456789abcdef0123' }] },
      [{ type: 'text', text: 'Selected 1 visual for presentation.' }, { type: 'text', text: PUBLISHED_LINE }]),
  ] as never)
  const chart = folder.messages().find(message => message.kind === 'tool' && message.name === 'dsh_pi_tui_chart')
  const present = folder.messages().find(message => message.kind === 'tool' && message.name === 'present_visual')
  assert.ok(chart !== undefined && present !== undefined)
  const chartText = transcriptSearchText(chart)
  assert.match(chartText, /Request latency/u, 'the human values stay searchable')
  assert.doesNotMatch(chartText, /visual-ref-v1:/u)
  assert.doesNotMatch(chartText, /visual-v1:/u)
  const presentText = transcriptSearchText(present)
  assert.match(presentText, /Selected 1 visual/u, 'the human summary stays searchable')
  assert.doesNotMatch(presentText, /visual-published-v1:/u)
})

test('search keeps another tool’s lookalike machine text searchable', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as never,
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 0 } } as never,
    ...pair(1, 0, 2, 'call-bash', 'bash', { command: 'cat out.txt' },
      [{ type: 'text', text: `${REF_LINE}\n${PUBLISHED_LINE}` }]),
  ] as never)
  const bash = folder.messages().find(message => message.kind === 'tool' && message.name === 'bash')
  assert.ok(bash !== undefined)
  const text = transcriptSearchText(bash)
  assert.match(text, /visual-ref-v1:sv1_0123456789abcdef0123/u)
  assert.match(text, /visual-published-v1:/u)
})
