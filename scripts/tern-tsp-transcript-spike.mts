#!/usr/bin/env node
/**
 * PR1 feasibility spike: a standalone, manually runnable TSP transcript demo.
 *
 * It is NOT production wiring: it is not a DSH command, profile or startup
 * path, and it never touches `src/app/**` or PiTui's terminal owner. It feeds
 * a deterministic replay of genuine `SessionEvent`/live-stream inputs into the
 * production `TranscriptFolder`, projects the canonical structure, maps it to
 * native Tern nodes, and drives ONE official SDK inline surface.
 *
 * Run it under a supported Tern pane:
 *
 *   node --import tsx/esm scripts/tern-tsp-transcript-spike.mts
 *
 * Press `n` to advance one replay step, `q` or Ctrl+C to close. Outside Tern
 * (or with `TERN_TSP=0`, inside tmux/screen/zellij) it prints an unsupported
 * note and exits without opening a surface.
 * @module @xmoon76/dsh-pi-tui/scripts/tern-tsp-transcript-spike
 */

import { pathToFileURL } from 'node:url'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { ConnectOptions, Renderable, SessionInput } from '@stencil-hq/tern'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import { projectTranscriptStructure } from '../src/tui/transcript/structure.ts'
import { TranscriptNodeKeys, transcriptView } from './support/tern-tsp-transcript-view.ts'

/** The minimum surface the spike drives (structurally the SDK `Surface`). */
export interface SpikeSurface {
  render(view: Renderable): void
  close(options?: { readonly keep?: boolean }): Promise<void>
}

/** The minimum session the spike drives (structurally the SDK `Session`). */
export interface SpikeSession {
  open(options?: { readonly mode?: 'inline' }): SpikeSurface
  close(): Promise<void>
  [Symbol.asyncIterator](): AsyncIterator<SessionInput>
}

/** The connect seam: the SDK `connect` by default, injectable for tests. */
export type SpikeConnect = (options: ConnectOptions) => Promise<SpikeSession | null>

/** One ordered replay action: a durable event or a live stream input. */
export type ReplayAction =
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'live'; readonly input: AssistantLiveInput }

/** One deterministic replay batch applied between two renders. */
export interface ReplayStep {
  readonly actions: readonly ReplayAction[]
}

const T0 = 1_700_000_000_000

function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq, data } as SessionEvent
}

function liveChunk(turn: number, step: number, chunk: unknown, seq: number): AssistantLiveInput {
  return { kind: 'chunk', sessionId: 'tern-tsp-spike', attemptId: 'attempt-1', turn, step, time: T0 + seq, chunk } as AssistantLiveInput
}

/** The settled reasoning + narration body used by the streaming step. */
const REASONING = 'checking the projector boundaries and the ambient clusters'
const NARRATION = 'The canonical structure is the only segmentation authority.'

function reasoningSettlement(seq: number): SessionEvent {
  return event('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId('assistant-1'),
      role: 'assistant',
      content: [{ type: 'reasoning', text: REASONING }, { type: 'text', text: NARRATION }],
      source: { kind: 'model', provider: 'spike', model: 'spike' },
      stream: [
        { type: 'chunk', time: T0 + 10, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + 11, chunk: { type: 'reasoning-delta', index: 0, text: REASONING } },
        { type: 'chunk', time: T0 + 12, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: REASONING } } },
        { type: 'chunk', time: T0 + 13, chunk: { type: 'block-start', index: 1, blockType: 'text' } },
        { type: 'chunk', time: T0 + 13, chunk: { type: 'text-delta', index: 1, text: NARRATION } },
        { type: 'chunk', time: T0 + 13, chunk: { type: 'block-end', index: 1, block: { type: 'text', text: NARRATION } } },
      ],
    },
  }, seq)
}

function toolResult(seq: number, callId: string, text: string): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${callId}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
}

function contextInput(seq: number, id: string, text: string, source: Record<string, unknown>): SessionEvent {
  return event('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, seq)
}

/**
 * The deterministic replay: turn start + human prompt, a live reasoning pass
 * with one real tool call, the authoritative settlement, two ambient Context
 * injections, a non-ambient Work boundary plus a settled interaction, one
 * standalone control-plane command, and one post-turn replay result.
 */
export function buildReplaySteps(): readonly ReplayStep[] {
  return [
    {
      actions: [
        { type: 'event', event: event('turn/start', { turn: 1 }, 0) },
        { type: 'event', event: event('user/message', {
          id: MessageId('user-1'),
          role: 'user',
          content: [{ type: 'text', text: 'Inspect the transcript projector boundary.' }],
          source: { kind: 'user' },
        }, 1) },
      ],
    },
    {
      actions: [
        { type: 'live', input: liveChunk(1, 0, { type: 'block-start', index: 0, blockType: 'reasoning' }, 2) },
        { type: 'live', input: liveChunk(1, 0, { type: 'reasoning-delta', index: 0, text: 'checking the projector' }, 3) },
        { type: 'event', event: event('tool/call', {
          turn: 1,
          step: 0,
          callId: ToolCallId('call-read-1'),
          name: 'read',
          arguments: JSON.stringify({ file_path: 'src/tui/transcript/structure.ts' }),
        }, 4) },
      ],
    },
    {
      actions: [
        { type: 'live', input: liveChunk(1, 0, { type: 'reasoning-delta', index: 0, text: ' boundaries' }, 5) },
        { type: 'event', event: toolResult(6, 'call-read-1', '<path>src/tui/transcript/structure.ts</path><type>file</type><content>1\texport function projectTranscriptStructure() {}</content>') },
        { type: 'event', event: reasoningSettlement(7) },
      ],
    },
    {
      actions: [
        { type: 'event', event: contextInput(8, 'ctx-agents', 'AGENTS instructions body', { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] }) },
        { type: 'event', event: contextInput(9, 'ctx-catalog', 'Skill catalog body', { kind: 'plugin', form: 'catalog', plugin: 'skill-catalog' }) },
      ],
    },
    {
      actions: [
        { type: 'event', event: event('tool/call', {
          turn: 1,
          step: 1,
          callId: ToolCallId('call-bash-1'),
          name: 'bash',
          arguments: JSON.stringify({ command: 'pnpm test --filter transcript' }),
        }, 10) },
        { type: 'event', event: event('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: MessageId('result-call-bash-1'),
            role: 'tool',
            toolCallId: ToolCallId('call-bash-1'),
            content: [{ type: 'text', text: 'all green' }],
            source: { kind: 'tool', callId: ToolCallId('call-bash-1') },
          },
        }, 11) },
        { type: 'event', event: event('tool/call', {
          turn: 1,
          step: 2,
          callId: ToolCallId('call-question-1'),
          name: 'ask_user_question',
          arguments: JSON.stringify({ questions: [] }),
        }, 12) },
        { type: 'event', event: event('tool/result', {
          turn: 1,
          step: 2,
          message: {
            id: MessageId('result-call-question-1'),
            role: 'tool',
            toolCallId: ToolCallId('call-question-1'),
            content: [{ type: 'text', text: 'answer: keep the spike standalone' }],
            source: { kind: 'tool', callId: ToolCallId('call-question-1') },
          },
        }, 13) },
      ],
    },
    {
      actions: [
        { type: 'event', event: event('command/run', { commandId: CommandId('cmd-spike-1'), name: 'status', source: { kind: 'user' } }, 14) },
        { type: 'event', event: event('command/done', { commandId: CommandId('cmd-spike-1'), kind: 'success', text: 'session healthy' }, 15) },
      ],
    },
    {
      actions: [
        { type: 'event', event: event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 16) },
        { type: 'event', event: event('tool/result', {
          turn: 1,
          step: 9,
          message: {
            id: MessageId('result-late-1'),
            role: 'tool',
            toolCallId: ToolCallId('call-late-1'),
            content: [{ type: 'text', text: 'late replay evidence' }],
            source: { kind: 'tool', callId: ToolCallId('call-late-1') },
          },
        }, 17) },
      ],
    },
  ]
}

/** Apply one replay batch to the folder, in its recorded action order. */
export function applyReplayStep(folder: TranscriptFolder, step: ReplayStep): void {
  for (const action of step.actions) {
    if (action.type === 'event') folder.apply([action.event])
    else folder.applyLiveInput(action.input)
  }
}

/** Where the spike writes its CLI diagnostics. */
export interface SpikeIO {
  write(text: string): void
}

/** What `runTernTranscriptSpike` takes; every field is an explicit test seam. */
export interface SpikeRunOptions {
  readonly connect?: SpikeConnect
  readonly io?: SpikeIO
  readonly steps?: readonly ReplayStep[]
  /** Workspace root for the shared tool-args relativization. */
  readonly cwd?: string
}

/** The spike's outcome: an unsupported environment, or a closed surface. */
export type SpikeRunResult =
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'closed'; readonly rendered: number; readonly steps: number }

const STANDARD_IO: SpikeIO = { write: text => void process.stdout.write(text) }

/**
 * Connect, replay the fold into ONE inline surface, then close it. Returns
 * `{kind: 'unsupported'}` without opening a surface when TSP is unavailable;
 * SDK errors are never converted into an unsupported result — they propagate
 * to the caller after the surface/session are closed.
 */
export async function runTernTranscriptSpike(options: SpikeRunOptions = {}): Promise<SpikeRunResult> {
  const connect = options.connect ?? sdkConnect
  const io = options.io ?? STANDARD_IO
  const steps = options.steps ?? buildReplaySteps()
  const session = await connect({ app: 'dsh-pi-tui-tsp-spike' })
  if (session === null) {
    io.write('Tern Surface Protocol unavailable (not a supported Tern pane); no surface opened.\n')
    return { kind: 'unsupported' }
  }

  const folder = new TranscriptFolder()
  const keys = new TranscriptNodeKeys()
  const cwd = options.cwd ?? process.cwd()
  let applied = 0
  let rendered = 0
  const advance = (surface: SpikeSurface, next: number): void => {
    applied = next
    applyReplayStep(folder, steps[applied]!)
    surface.render({ main: transcriptView(projectTranscriptStructure(folder.messages()), keys, { cwd }) })
    rendered += 1
  }

  try {
    // The surface is created INSIDE the owned scope: a throwing `open` must
    // still release the session (and therefore the tty).
    const surface = session.open({ mode: 'inline' })
    try {
      advance(surface, 0)
      for await (const input of session) {
        if (input.type !== 'key') continue
        const { key } = input
        if (key.ctrl && key.name === 'c') break
        if (key.ctrl || key.alt || key.meta) continue
        if (key.name === 'q') break
        if (key.name === 'n' && applied < steps.length - 1) advance(surface, applied + 1)
      }
    } finally {
      await surface.close({ keep: false })
    }
  } finally {
    await session.close()
  }

  io.write(`TSP spike closed: rendered ${rendered} of ${steps.length} replay step(s).\n`)
  return { kind: 'closed', rendered, steps: steps.length }
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    await runTernTranscriptSpike()
  } catch (error) {
    process.stderr.write(`tern tsp transcript spike failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
