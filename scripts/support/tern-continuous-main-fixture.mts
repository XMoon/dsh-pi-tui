/**
 * T2 Stage 1 A1 — deterministic fixture builders.
 * Copies the LEGAL event-construction shape from scripts/bench.mts::buildEvents
 * (no business logic, no transcript fold rewrite). Seed fixed at 20261111.
 * All markers are deterministic: T2-F-<turn6> for plain, T2-M-<turn6> for mixed,
 * T2-L-<turn6> for long.
 */
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'

export const SEED = 20261111

const MARKDOWN_BLOCKS = [
  '## Findings\n\nThe **cache** now hits for unchanged messages, so `markdown` is not re-parsed every frame.\n\n```ts\nconst hit = cached.text === message.text\n```\n\n- one\n- two\n- three',
  '## Steps\n\n1. ingest events\n2. fold the projection\n3. render the tail\n\n> Only the visible window pays the expensive conversions.',
  '## 结论（CJK + emoji）\n\n缓存命中后 🐋🐳 单帧成本不再随完整历史线性增长。`宽度 40/80/160` 与主题切换均按 key 失效。',
]
const DIFF_BODY = 'diff --git a/src/a.ts b/src/a.ts\nindex 111..222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n const a = 1\n+const b = 2\n-const old = 3\n // tail'

/** P-plain: one User + one finalized Assistant per turn, ~300 UTF-16 body. */
export function buildPlainEvents(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < turns; turn += 1) {
    const marker = `T2-F-${String(turn).padStart(6, '0')}`
    const body = `${marker} plain assistant reply about transcript projection cost. ` +
      'This sentence pads the body to approximately three hundred UTF-16 code units so the SDK node text is realistic. '.repeat(2)
    events.push({ type: 'turn/start', seq: seq++, time: turn * 1000, data: { turn } } as SessionEvent)
    events.push({
      type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq++), time: turn * 1000 + 1, data: {
        id: MessageId(`plain-user-${turn}`), role: 'user',
        content: [{ type: 'text', text: `${marker} user prompt for turn ${turn}` }],
        source: { kind: 'user' },
      },
    } as SessionEvent)
    events.push({
      type: 'assistant/message', seq: seq++, time: turn * 1000 + 2, data: {
        turn, step: 0,
        message: { id: `plain-msg-${turn}`, role: 'assistant', content: [{ type: 'text', text: body.slice(0, 300) }], source: { kind: 'assistant' } },
      },
    } as unknown as SessionEvent)
    events.push({ type: 'turn/end', seq: seq++, time: turn * 1000 + 3, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return events
}

/**
 * P-mixed: mirrors scripts/bench.mts::buildEvents exactly (16 events/turn):
 * turn/start, user/message, 8 assistant/chunk, assistant/message,
 * tool/call read, tool/result, tool/call bash, tool/result, turn/end.
 * `skipBashResultTurns` leaves those turns' bash call pending for the
 * historical-update variant (a late tool/result is a legal in-place settle).
 */
export function buildMixedEvents(turns: number, skipBashResultTurns: ReadonlySet<number> = new Set()): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < turns; turn += 1) {
    const marker = `T2-M-${String(turn).padStart(6, '0')}`
    events.push({ type: 'turn/start', seq: seq++, time: turn * 1000, data: { turn } } as SessionEvent)
    events.push({
      type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq++), time: turn * 1000 + 1, data: {
        id: MessageId(`mixed-user-${turn}`), role: 'user',
        content: [{ type: 'text', text: `${marker} user prompt ${turn} with CJK 你好 and emoji 🐋` }],
        source: { kind: 'user' },
      },
    } as SessionEvent)
    for (let chunk = 0; chunk < 8; chunk += 1) {
      events.push({
        type: 'assistant/chunk', seq: seq++, time: turn * 1000 + 2 + chunk, data: {
          turn, step: 0, index: chunk,
          chunk: { type: 'text-delta', index: chunk, text: MARKDOWN_BLOCKS[turn % 3]!.slice(chunk * 40, chunk * 40 + 40) },
        },
      } as unknown as SessionEvent)
    }
    events.push({
      type: 'assistant/message', seq: seq++, time: turn * 1000 + 11, data: {
        turn, step: 0,
        message: { id: `mixed-msg-${turn}`, role: 'assistant', content: [{ type: 'text', text: MARKDOWN_BLOCKS[turn % 3]! }], source: { kind: 'assistant' } },
      },
    } as unknown as SessionEvent)
    events.push({
      type: 'tool/call', seq: seq++, time: turn * 1000 + 12, data: {
        turn, step: 0, callId: `r${turn}`, name: 'read', arguments: JSON.stringify({ file: `src/file-${turn}.ts` }),
      },
    } as SessionEvent)
    events.push({
      type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(seq++), time: turn * 1000 + 13, data: {
        turn, step: 0, message: {
          id: MessageId(`m-${turn}`), role: 'tool', toolCallId: ToolCallId(`r${turn}`),
          content: [{ type: 'text', text: DIFF_BODY }],
          source: { kind: 'tool', callId: ToolCallId(`r${turn}`) },
        },
      },
    } as SessionEvent)
    events.push({
      type: 'tool/call', seq: seq++, time: turn * 1000 + 14, data: {
        turn, step: 0, callId: `b${turn}`, name: 'bash', arguments: JSON.stringify({ command: 'ls -la' }),
      },
    } as SessionEvent)
    if (!skipBashResultTurns.has(turn)) {
      events.push({
        type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(seq++), time: turn * 1000 + 15, data: {
          turn, step: 0, message: {
            id: MessageId(`bm-${turn}`), role: 'tool', toolCallId: ToolCallId(`b${turn}`),
            content: [{ type: 'text', text: 'total 8\ndrwxr-xr-x 2 user user 4096 Aug 15 00:00 .\n-rw-r--r-- 1 user user 123 src/a.ts' }],
            source: { kind: 'tool', callId: ToolCallId(`b${turn}`) },
          },
        },
      } as SessionEvent)
    }
    events.push({ type: 'turn/end', seq: seq++, time: turn * 1000 + 16, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return events
}

/** P-long: 100 turns, each Assistant carries ~8 KiB Markdown + CJK + code fence + long path. */
export function buildLongEvents(turns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  let seq = 0
  const longPath = '/home/user/projects/very/deeply/nested/workspace/src/components/transcript/projection/' + 'segment/'.repeat(8) + 'file.ts'
  for (let turn = 0; turn < turns; turn += 1) {
    const marker = `T2-L-${String(turn).padStart(6, '0')}`
    const section = `### Section ${turn}\n\n${marker} 这是长文本测试段落，包含 CJK 字符与代码块。\n\n` +
      '```typescript\nconst value = computeProjection(messages, { preset: "full", window: undefined })\nconsole.log(value.nodeCount)\n```\n\n' +
      `Path: \`${longPath}\`\n\n` +
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6) + '\n\n'
    // ~8 KiB total: repeat the section enough times
    const body = section.repeat(Math.ceil(8192 / section.length)).slice(0, 8192)
    events.push({ type: 'turn/start', seq: seq++, time: turn * 1000, data: { turn } } as SessionEvent)
    events.push({
      type: 'user/message', surfaceOp: 'append', seq: SessionSeq(seq++), time: turn * 1000 + 1, data: {
        id: MessageId(`long-user-${turn}`), role: 'user',
        content: [{ type: 'text', text: `${marker} long prompt for turn ${turn}` }],
        source: { kind: 'user' },
      },
    } as SessionEvent)
    events.push({
      type: 'assistant/message', seq: seq++, time: turn * 1000 + 2, data: {
        turn, step: 0,
        message: { id: `long-msg-${turn}`, role: 'assistant', content: [{ type: 'text', text: body }], source: { kind: 'assistant' } },
      },
    } as unknown as SessionEvent)
    events.push({ type: 'turn/end', seq: seq++, time: turn * 1000 + 3, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
  }
  return events
}

/** Build the late tool/result event that settles a pending bash call in-place. */
export function lateBashResult(turn: number, seq: number): SessionEvent {
  return {
    type: 'tool/result', surfaceOp: 'append', seq: SessionSeq(seq), time: turn * 1000 + 99, data: {
      turn, step: 0, message: {
        id: MessageId(`bm-late-${turn}`), role: 'tool', toolCallId: ToolCallId(`b${turn}`),
        content: [{ type: 'text', text: 'total 8\ndrwxr-xr-x 2 user user 4096 Aug 15 00:00 .\n-rw-r--r-- 1 user user 123 src/a.ts' }],
        source: { kind: 'tool', callId: ToolCallId(`b${turn}`) },
      },
    },
  } as SessionEvent
}
