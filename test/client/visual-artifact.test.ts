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
