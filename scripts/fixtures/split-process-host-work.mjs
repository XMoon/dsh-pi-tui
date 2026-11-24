/**
 * M4-C1 isolated qualification workload.
 *
 * This module is copied into an isolated `pi-tui` profile and mounted as one
 * Loader row through `SPLIT_PROCESS_EXTRA_PATCH`. It is a TEST-ONLY Host
 * fixture: it registers a scripted `LlmAdapter` and one small tool, and it
 * observes the OFFICIAL Host services (`ctx.jobs`, `ctx.subagents`,
 * `ctx.userQuestions`, `ctx.approval`, `ctx.agents`). It never writes durable
 * Session events by hand, never creates a second Host authority and never
 * enters the published package.
 *
 * The smoke owns the barriers and the private `C1_WORK_ROOT`; this fixture
 * only records facts after the real Host entry points have been reached.
 *
 * Scenario protocol (frozen):
 *   C1_SCENARIO = long-turn | foreground-tool | job | child | question |
 *                 approval-allow | approval-reject | goal-armed | goal-round |
 *                 maintenance | schedule | unowned-job | web-workspace-changes | f1-shell
 *   C1_WORK_ROOT = private 0700 directory under the isolated work dir
 *   C1_HOLD_<NAME> = absolute barrier file path the smoke releases
 *   C1_HAS_LIVE_CLIENT_PROBE = set to sample Gateway.hasLiveClient() transitions
 *   C1_NON_ANSWERING_PEER_PROBE = absolute barrier path for the negative control
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'm4-c1-host-work'
export const inject = ['llm', 'tools', 'jobs', 'subagents', 'agents', 'sessions', 'workingDirectory', 'typertGateway', 'connection', 'commands', 'attachments']

const SCENARIOS = new Set([
  'long-turn',
  'foreground-tool',
  'job',
  'child',
  'question',
  'approval-allow',
  'approval-reject',
  // PO-3B: held long turns + ONE official approval tool call + the never
  // policy negative, staged against the scoped ACP cancel/approval owner.
  'acp-po3b',
  // G-ACP1B/B0: one live Agent mounts an official Agent-scoped MCP client
  // through `agent.runMaintenance()` and a run-owned control file sequence.
  'acp-scoped-mcp-b0',
  // G-ACP1B/B1: the production ACP stdio MCP path. The scripted model only
  // selects the same harmless MCP tools; all admission/retirement is owned by
  // the production View, not a test fixture.
  'acp-scoped-mcp-b1',
  // PO-4A content admission: only this scenario declares the test route's image modality.
  'acp-po4a',
  // PO-4C committed output: the offline model emits standard assistant/tool
  // images that were first stored and re-verified by the official Host Store.
  'acp-po4c',
  // G-ACP2 transient streaming: `long-turn`'s SELF-CONSISTENT twin. Its two
  // deltas accumulate to exactly its durable block (attempt-labelled), so the
  // ACP transient projection can settle without a divergence. `long-turn`
  // itself keeps its original rewriting behaviour for the TUI cases that prove
  // the authoritative-block-end supersede.
  'long-turn-stream',
  // G-ACP2-PR2 protocol projection: the scripted provider's three real turns
  // (official `todo_write`, one real `subagent` child, provider usage, then a
  // step-pressure compaction) are the durable facts an ACP client consumes.
  'acp-projection',
  // G-ACP2-PR3A commands: one plain, large assistant answer per prompt with no
  // tool/subagent side effects, so an explicit `/compact` is deterministic.
  'acp-command',
  // G-ACP2 transient streaming: the ONLY scripted provider whose deltas and
  // durable block agree. Its first delta is held so a case can prove the ACP
  // chunk precedes the durable append, and one prompt selects a deliberately
  // INCONSISTENT (provider-rewritten) block the View must fail closed on.
  'acp-transient',
  // Host-liveness qualification scenarios. They only reach official Host
  // services (`goals`, `schedule`, `Agent.runMaintenance`) and record facts.
  'goal-armed',
  'goal-round',
  'maintenance',
  'schedule',
  'unowned-job',
  // S5-PR5 W5-CHANGES: one real `write` tool call through the official
  // standard preset, so the official `workspace-changes` recorder observes a
  // real file intent and a real working-tree change.
  'web-workspace-changes',
  'f1-shell',
  // M6 F4: one Host-seeded Session for the real Client /attach -> official
  // receipt -> durable file proof.
  'f4-file',
  // M6 PR-C: the test-only Host /files command proving a real Client command
  // FILE delivery through the official staged-receipt resolver.
  'command-file-receipt',
  // M6-1 F6: the Skills cases only need the real Host profile; the scripted
  // model stays inert and the fault provider is gated by C1_SKILLS_FAULT_DIR.
  'skills-standing',
  'skills-recovery',
  // M6-1 F7A: register the qualification provider flows on the REAL official
  // `ctx.authorization` service. The flows commit through the official
  // `AuthorizationSession.commit` write path; this fixture is the provider
  // plugin boundary, never a replacement for the authorization seam.
  'f7a-authorization',
  // M6-1 F7B: seed stored credential RECORDS through the official
  // `ctx.credentials.modifyRecord()` write path (never a hand-edited YAML).
  'f7b-credential-records',
  // M6-1 F8: create two live Sessions and seed independent official
  // approval/sandbox policy facts; the replay scenario resumes one Session in
  // a FRESH Host to prove the durable projection replay.
  'session-policy-f8',
  'session-policy-f8-replay',
  // M6-1 F3 closure: seed the official Web settings baseline + a non-functional
  // credential sentinel through the official Services (never a hand edit).
  'web-settings-f3',
  // FR3: the MCP scene only needs the real Host composition; this row keeps the
  // scripted model inert and the work root prepared (no Session is created).
  'mcp-servers-fr3',
  // FR4: the same real Host composition plus ONE plugin-registered server, so
  // the configuration surface must classify it Plugin-owned and offer no CRUD.
  'mcp-servers-fr4',
  // FR8: the official `exit_plan_mode` review and the official Team task board
  // driven by a real Split Client. Both scenarios only author model chunks; the
  // official ToolRuntime and the official projections do every write.
  'plan-review',
  'team-board',
  // PR1 Host default environment: fixed harmless PATH probes through the
  // official standard-preset `bash` tool (foreground and background) plus one
  // real `ctx.subprocess` spawn. The probes are run-owned executables; the
  // scenario exposes no arbitrary command input.
  'host-default-environment',
])

/**
 * FR8 Split scenario markers (frozen identities this case owns).
 *
 * The smoke authors these EXACT strings as user prompts; the scripted Host
 * model turns each into the official tool call the scenario names. Nothing
 * else in this fixture reacts to them, and no Session event is written by hand.
 */
const FR8_PLAN_APPROVE = 'FR8_PLAN_APPROVE'
const FR8_PLAN_KEEP = 'FR8_PLAN_KEEP'
const FR8_PLAN_DISMISS = 'FR8_PLAN_DISMISS'
const FR8_PLAN_NEXT_STEP = 'FR8_PLAN_NEXT_STEP'
const FR8_TEAM_CREATE = 'FR8_TEAM_CREATE'
const FR8_TEAM_UPDATE = 'FR8_TEAM_UPDATE'
const FR8_PLAN_TEXT = '# FR8 official plan\n- 检查真实 Host\n- 保存会话事实\n\nFR8_PLAN_TAIL_END'
const FR8_TEAM_SUBJECT = 'FR8_BOARD_TASK'
const FR8_TEAM_DESCRIPTION = 'FR8 official task projection'

/** The FIRST official `team_task_create` result already committed in this
 *  request history (`{ id, revision }`), or undefined. The update addresses
 *  exactly that task — the fixture never invents an id or a revision. */
const FR8_TEAM_TASK_OF = (messages) => {
  for (const message of messages ?? []) {
    if (message?.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type !== 'text' || typeof part.text !== 'string') continue
      try {
        const parsed = JSON.parse(part.text)
        if (typeof parsed?.id === 'string' && Number.isInteger(parsed?.revision)) {
          return { id: parsed.id, revision: parsed.revision }
        }
      } catch { /* a non-JSON tool result never carries the task fact */ }
    }
  }
  return undefined
}

/**
 * PO-4B qualification sample: the offline model emits these two Markdown text
 * blocks verbatim for the marker prompt, and the Host file probe creates the
 * workspace files the first block links to.
 */
const PO4B_MARKER = 'po4b:markdown-host-files:v1'
const PO4B_BLOCK_1 = '# PO-4B Report\r\n\r\n- [report](./.po4b/report.md)\r\n- [missing](./.po4b/missing.md)\r\n- [private](./.po4b/private.md)\r\n\r\n'
const PO4B_BLOCK_2 = '```json\n{"path":"./.po4b/report.md","quote":"`literal`"}\n```\n\n**bold**  _italic_  中文🙂\n'
const PO4B_REPORT = 'PO4B HOST FILE BYTES\nline two: π\n'
const PO4B_PRIVATE = 'PO4B PRIVATE FILE MUST NOT BE READ\n'

/**
 * PO-4C qualification samples. The marker prompts only select fixture
 * behaviour; the committed content itself is produced by the real Agent stream
 * (assistant blocks) and the real Host tool execution (tool/result), and every
 * image is first stored and re-read through the official Host Attachment Store.
 */
const PO4C_MARKERS = Object.freeze({
  assistantMixed: 'po4c:assistant-mixed:v1',
  assistantImageOnly: 'po4c:assistant-image-only:v1',
  toolContent: 'po4c:tool-content:v1',
  toolFailed: 'po4c:tool-failed:v1',
  missingImage: 'po4c:missing-image:v1',
  toolTwoImages: 'po4c:tool-two-images:v1',
})
const PO4C_TOOL_NAME = 'po4c_output_tool'
const PO4C_TEXT_BEFORE = 'before\r\n'
const PO4C_TEXT_AFTER = 'after 中文🙂\n'
const PO4C_TOOL_TAIL = 'tool-tail\n'
const PO4C_A2UI_TEXT = 'A2UI_JSON={"version":"popo.a2ui/1","components":[{"kind":"text","value":"透明"}]}'
const PO4C_TOOL_ANSWER = 'tool completed\n'
const PO4C_TOOL_FAILED_ANSWER = 'tool failed\n'

/** Quote one token for the Host shell used by the harmless fixture commands. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** Read the last user-authored text in one model request. */
function allUserText(messages) {
  const texts = []
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    texts.push(message.content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(''))
  }
  return texts.join('\n')
}

/** Wait for one smoke-owned barrier file; the fixture owns no timeout policy. */
async function waitForBarrier(path, signal) {
  if (path === undefined || path === '') throw new Error('m4-c1-host-work: the barrier path is missing')
  while (!existsSync(path)) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('m4-c1-host-work: request aborted')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Create/validate the private work root and its 0600 append-only proof file. */
function prepareWorkRoot(rawRoot) {
  if (typeof rawRoot !== 'string' || !isAbsolute(rawRoot)) {
    throw new Error('m4-c1-host-work: C1_WORK_ROOT must be an absolute path')
  }
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 })
  const stats = statSync(rawRoot)
  if (!stats.isDirectory()) throw new Error('m4-c1-host-work: C1_WORK_ROOT is not a directory')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error('m4-c1-host-work: C1_WORK_ROOT is not owned by this process user')
  }
  chmodSync(rawRoot, 0o700)
  const proof = join(rawRoot, 'events.jsonl')
  writeFileSync(proof, '', { mode: 0o600 })
  chmodSync(proof, 0o600)
  return { root: rawRoot, proof }
}

/**
 * PO-4C: store the smoke-generated PNGs through the ONE official Host
 * Attachment Store and re-read them with its own integrity verification. The
 * returned references are exactly the durable ones the committed assistant and
 * tool content will carry; no bytes or paths are ever committed.
 */
async function createPo4cOutputProbe(ctx, record) {
  const dir = process.env.C1_PO4C_IMAGE_DIR
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('m4-c1-host-work: acp-po4c requires C1_PO4C_IMAGE_DIR')
  }
  // PO-4C capacity qualification: the official Attachment Store limits are
  // boot-frozen configuration, and this fixture is the test-only configuration
  // boundary. The env JSON replaces the SAME live store's limits object before
  // any image is stored, so every official `saveImage`/`readImage`/listener
  // derivation reads the requested independent configuration.
  const limitsJson = process.env.C1_PO4C_IMAGE_LIMITS_JSON
  if (typeof limitsJson === 'string' && limitsJson !== '') {
    const requested = JSON.parse(limitsJson)
    const current = ctx.attachments.imageLimits
    const limits = {
      maxImageBytes: Number(requested.maxImageBytes),
      maxImagesPerMessage: Number(requested.maxImagesPerMessage),
      maxMessageImageBytes: Number(requested.maxMessageImageBytes),
      maxImagePixels: Number(requested.maxImagePixels ?? current.maxImagePixels),
      maxImageDimension: Number(requested.maxImageDimension ?? current.maxImageDimension),
      mediaTypes: current.mediaTypes,
    }
    for (const key of ['maxImageBytes', 'maxImagesPerMessage', 'maxMessageImageBytes', 'maxImagePixels', 'maxImageDimension']) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0) {
        throw new Error(`m4-c1-host-work: PO-4C requested an invalid attachment limit ${key}`)
      }
    }
    ctx.attachments.imageLimits = Object.freeze(limits)
    record('po4c-image-limits', { ...limits, mediaTypes: [...limits.mediaTypes] })
  }
  const store = async name => {
    const data = readFileSync(join(dir, name))
    const stored = await ctx.attachments.saveImage({ data, mediaType: 'image/png' })
    const verified = await ctx.attachments.readImage(stored)
    const digest = createHash('sha256').update(verified.data).digest('hex')
    if (stored.attachmentId !== `sha256:${digest}` || stored.bytes !== verified.data.byteLength
      || verified.ref.mediaType !== 'image/png') {
      throw new Error(`m4-c1-host-work: PO-4C stored image ${name} did not verify against its durable reference`)
    }
    record('po4c-image-stored', {
      name,
      attachmentId: stored.attachmentId,
      mediaType: stored.mediaType,
      bytes: verified.data.byteLength,
      width: stored.width,
      height: stored.height,
      sha256: digest,
    })
    return stored
  }
  const mixed = await store('mixed.png')
  const tool = await store('tool.png')
  // A FORMAT-VALID content-addressed reference that was never stored: the real
  // official Store must reject it (never a fake/absent store).
  const missing = {
    attachmentId: `sha256:${createHash('sha256').update('po4c:missing-image:v1').digest('hex')}`,
    mediaType: 'image/png',
    bytes: 4096,
    width: 64,
    height: 64,
  }
  let missingCode
  try {
    await ctx.attachments.readImage(missing)
    throw new Error('m4-c1-host-work: the PO-4C absent image reference resolved in the official Store')
  } catch (error) {
    if (typeof error?.code !== 'string') throw error
    missingCode = error.code
  }
  record('po4c-missing-image-rejected', { attachmentId: missing.attachmentId, code: missingCode })
  return { mixed, tool, missing, missingCode }
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('\\n')
  if (value !== null && typeof value === 'object') {
    if (Object.hasOwn(value, 'content')) return textOf(value.content)
    if (Object.hasOwn(value, 'text')) return textOf(value.text)
  }
  return ''
}

function recordPromptFacts(options) {
  const evidencePath = process.env.SPLIT_PROCESS_PROMPT_EVIDENCE
  if (typeof evidencePath !== 'string' || evidencePath === '') return
  const systemText = [options.system, ...(options.messages ?? [])
    .filter(message => message?.role === 'system')
    .map(message => message.content)]
    .map(textOf).join('\\n')
  const userText = [...(options.messages ?? [])].reverse()
    .find(message => message?.role === 'user')?.content
  const allText = [options.system, ...(options.messages ?? [])
    .map(message => message.content)]
    .map(textOf).join('\\n')
  const toolNames = Array.isArray(options.tools)
    ? options.tools.map(tool => tool?.name).filter(name => typeof name === 'string').sort()
    : []
  appendFileSync(evidencePath, JSON.stringify({
    markerCount: systemText.split('Prefer showing the primary results within your final response').length - 1,
    presentInstruction: systemText.includes('Use present to publish complete deliverables'),
    presentTool: toolNames.includes('present'),
    toolNames,
    // The official session-reference additional context is appended as a
    // user message; record its stable heading and the pre-normalization URI.
    referencedSessions: allText.includes('## Referenced sessions'),
    canonicalSessionUri: allText.includes('dsh-session:'),
    // M6 PR-C C4: the model-facing TUI prompt-section facts (the parity sink).
    focusSection: systemText.includes('# Focus mode'),
    progressSection: systemText.includes('# Progress updates:'),
    userText: textOf(userText).slice(-400),
    responseSection: systemText.includes('# Response style:'),
    gitSection: systemText.includes('# Git attribution'),
  }) + '\n', { mode: 0o600 })
}

/** G-ACP1B/B0 prompt markers and the official MCP public tool names. */
const B0_HOLD_MARKER = 'B0_HOLD_A'
const B0_FAIL_MARKER = 'B0_FAIL_A'
const B0_PLAIN_MARKER = 'B0_PLAIN_A'
const B0_ECHO_TOOL = 'mcp__b0scope__echo'
const B0_HOLD_TOOL = 'mcp__b0scope__hold'
const B0_FAIL_TOOL = 'mcp__b0scope__fail'
const B0_PROMPT_PATTERN = /\b(B0_(?:ECHO|HOLD|FAIL|PLAIN)_[AB])\b(?:\s+([A-Za-z0-9_-]+))?/u

/** G-ACP1B/B1 prompt markers and the same harmless MCP public tool names. */
const B1_ECHO_MARKER = 'B1_ECHO_A'
const B1_HOLD_MARKER = 'B1_HOLD_A'
const B1_FAIL_MARKER = 'B1_FAIL_A'
const B1_PLAIN_MARKER = 'B1_PLAIN_A'
const B1_ECHO_B_MARKER = 'B1_ECHO_B'
const B1_HOLD_B_MARKER = 'B1_HOLD_B'
const B1_APPROVAL_A_MARKER = 'B1_APPROVAL_A'
const B1_APPROVAL_B_MARKER = 'B1_APPROVAL_B'
const B1_ECHO_TOOL = 'mcp__b1scope__echo'
const B1_HOLD_TOOL = 'mcp__b1scope__hold'
const B1_FAIL_TOOL = 'mcp__b1scope__fail'
const B1_PROMPT_PATTERN = /\b(B1_(?:ECHO|HOLD|FAIL|PLAIN|APPROVAL)_[AB])\b(?:\s+([A-Za-z0-9_-]+))?/u

/** The newest authored B1 prompt marker and its optional nonce. */
function b1PromptOf(messages) {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message?.role !== 'user') continue
    const text = (message.content ?? [])
      .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
    const match = text.match(B1_PROMPT_PATTERN)
    if (match !== null) return { marker: match[1], nonce: match[2] }
  }
  return undefined
}

/** The newest authored B0 prompt marker and its optional nonce. */
function b0PromptOf(messages) {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message?.role !== 'user') continue
    const text = (message.content ?? [])
      .map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
    const match = text.match(B0_PROMPT_PATTERN)
    if (match !== null) return { marker: match[1], nonce: match[2] }
  }
  return undefined
}

function sleepB0(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function b0Alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The live process identity used as the terminal-signal fence:
 * `pid + kernel start time + current parent`. Linux reads procfs; Darwin uses
 * `ps lstart`; any unreadable shape fails closed.
 */
function b0ProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
      return { pid, ppid: Number(fields[1]), started: fields[19] }
    } catch {
      return undefined
    }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, LC_ALL: 'C' },
    })
    if (result.error !== undefined || result.status !== 0) return undefined
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u.exec(line)
      if (match !== null && Number(match[1]) === pid) {
        return { pid, ppid: Number(match[2]), started: match[3].replace(/\s+/gu, ' ') }
      }
    }
    return undefined
  }
  return undefined
}

/**
 * G-ACP1B/B0 test-owned Host workload.
 *
 * The workload owns exactly one run/one Agent A handle. It never creates an
 * Agent/Session, never registers through the global `ctx.mcpManager`, and
 * every control request is a fixed file name consumed once. All replies are
 * JSONL facts with actionId/sessionId/agentId/hostPid/kind and never carry a
 * command or env value.
 */
function createScopedMcpB0Workload(ctx, { root, record }) {
  const controlPath = process.env.C1_B0_CONTROL ?? join(root, 'b0-control.json')
  const serverPath = process.env.C1_B0_MCP_SERVER
  const proofPath = process.env.C1_B0_PROOF
  const holdArm = process.env.C1_B0_HOLD_ARM
  const holdRelease = process.env.C1_B0_HOLD_RELEASE
  const runNonce = process.env.C1_B0_RUN_NONCE
  if ([controlPath, serverPath, proofPath, holdArm, holdRelease, runNonce].some(value => typeof value !== 'string' || value === '')) {
    throw new Error('m4-c1-host-work: acp-scoped-mcp-b0 requires C1_B0_CONTROL, C1_B0_MCP_SERVER, C1_B0_PROOF, C1_B0_HOLD_ARM, C1_B0_HOLD_RELEASE and C1_B0_RUN_NONCE')
  }
  const state = {
    fiberA: undefined,
    fiberCrash: undefined,
    crashStatusDispose: undefined,
    crashIdentity: undefined,
    globalDispose: undefined,
    stopped: false,
    pinnedAgentA: undefined,
    pinnedSessionA: undefined,
    pinnedAgentB: undefined,
    pinnedSessionB: undefined,
    retireRequest: undefined,
  }
  const calls = new Map()
  const results = new Set()
  /** Session id -> highest observed durable turn/end turn. */
  const lastTurnEnd = new Map()
  let current
  let timer

  const fact = (actionId, action, fields = {}) => {
    record('b0-fact', {
      actionId,
      action,
      sessionId: fields.sessionId ?? '',
      agentId: fields.agentId ?? '',
      hostPid: process.pid,
      ...fields,
    })
  }
  const requireAgent = sessionId => {
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('m4-c1-host-work: B0 control requires a sessionId')
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`m4-c1-host-work: B0 control could not resolve live Agent ${sessionId}`)
    return agent
  }
  /** Pin and re-check the exact Agent/Session object identities for one slot. */
  const pinAgent = (sessionId, slot) => {
    const agent = requireAgent(sessionId)
    const sessions = ctx.reflect.get('sessions')
    const session = sessions?.get(sessionId)
    if (session === undefined || session !== agent.session) {
      throw new Error(`m4-c1-host-work: B0 ${slot} requires the exact live Session store identity`)
    }
    const agentKey = `pinnedAgent${slot}`
    const sessionKey = `pinnedSession${slot}`
    if (state[agentKey] === undefined) {
      state[agentKey] = agent
      state[sessionKey] = session
    } else if (!Object.is(state[agentKey], agent) || !Object.is(state[sessionKey], session)) {
      throw new Error(`m4-c1-host-work: B0_AGENT_STALE: ${slot} Agent/Session identity changed`)
    }
    return agent
  }
  const assertPinned = slot => {
    const agent = state[`pinnedAgent${slot}`]
    const session = state[`pinnedSession${slot}`]
    if (agent === undefined || session === undefined) return
    const sessions = ctx.reflect.get('sessions')
    const current = ctx.agents.get(String(session.id))
    const currentSession = sessions?.get(String(session.id))
    if (!Object.is(current, agent) || !Object.is(currentSession, session)) {
      throw new Error(`m4-c1-host-work: B0_AGENT_STALE: ${slot} Agent/Session identity changed after await`)
    }
  }
  const schemaNames = agent => ctx.tools.schemas(agent).map(schema => schema.name)
  const proofLines = () => {
    if (!existsSync(proofPath)) return []
    return readFileSync(proofPath, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  }
  const proofOf = (kind, tag) => [...proofLines()].reverse().find(line => line.kind === kind && line.tag === tag)
  const serverStartOf = tag => proofOf('server-start', tag)
  const activeCallsOf = sessionId => [...calls.values()].filter(call => call.sessionId === sessionId && !results.has(call.callId))
  const waitForProcessGone = async (pid, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!b0Alive(pid)) return true
      await sleepB0(25)
    }
    return !b0Alive(pid)
  }
  const clientConfig = (McpClient, agent, serverName, tag, extraEnv = {}) => {
    // The action already resolved its exact Agent; its committed Host Session
    // cwd is the only directory authority, never a client/request directory.
    return McpClient.Config({
      transport: 'stdio',
      serverName,
      command: process.execPath,
      args: [serverPath],
      env: {
        B0_RUN_NONCE: runNonce,
        B0_FIXTURE_PROOF: proofPath,
        B0_HOLD_ARM: holdArm,
        B0_HOLD_RELEASE: holdRelease,
        B0_SERVER_TAG: tag,
        ...(typeof process.env.C1_B0_SECRET_SENTINEL === 'string' && process.env.C1_B0_SECRET_SENTINEL !== ''
          ? { B0_SECRET_SENTINEL: process.env.C1_B0_SECRET_SENTINEL }
          : {}),
        ...extraEnv,
      },
      cwd: realpathSync(agent.session.header.cwd),
      toolCallTimeoutMs: 15_000,
      startupTimeoutMs: 20_000,
      closeTimeoutMs: 5_000,
      expandTemplates: false,
      failOnStartupError: true,
      reconnect: { enabled: false, initialDelayMs: 500, maxDelayMs: 500, maxAttempts: 1 },
    })
  }

  const handleMountA = async (request) => {
    const agent = pinAgent(request.sessionId, 'A')
    const sessions = ctx.reflect.get('sessions')
    const cwd = agent.session.header.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd)) {
      throw new Error('m4-c1-host-work: B0 mount-A requires the existing absolute Host Session cwd')
    }
    const canonicalCwd = realpathSync(cwd)
    const agentCountBefore = ctx.agents.list().length
    const sessionCountBefore = sessions.list().length
    const McpClient = await import('@deepseek-ai/dsh-mcp-client')
    let handle
    let abortDisposal
    try {
      await agent.runMaintenance(async signal => {
        const onAbort = () => {
          if (handle !== undefined) abortDisposal ??= handle.dispose().catch(() => {})
        }
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          if (signal.aborted) throw signal.reason ?? new Error('B0 mount-A aborted')
          // The exact Agent already exists; this only mounts the official
          // plugin on its Context and never creates/replaces an Agent.
          handle = agent.ctx.plugin(McpClient, clientConfig(McpClient, agent, 'b0scope', 'b0scope'))
          await handle.await()
          if (signal.aborted) throw signal.reason ?? new Error('B0 mount-A aborted')
          const status = McpClient.connectionStatusOf(handle)?.current()
          if (status?.state !== 'connected') {
            throw new Error(`m4-c1-host-work: B0 mount-A fiber is ${String(status?.state)} instead of connected`)
          }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      })
      assertPinned('A')
      state.fiberA = handle
      handle = undefined
      const status = McpClient.connectionStatusOf(state.fiberA)?.current()
      const server = serverStartOf('b0scope')
      const agentCountAfter = ctx.agents.list().length
      const sessionCountAfter = sessions.list().length
      fact(request.actionId, 'mount-A', {
        ok: status?.state === 'connected' && agentCountAfter === agentCountBefore && sessionCountAfter === sessionCountBefore,
        agentCountBefore,
        agentCountAfter,
        sessionCountBefore,
        sessionCountAfter,
        sessionId: String(agent.id),
        agentId: String(agent.id),
        cwd: canonicalCwd,
        toolNames: schemaNames(agent),
        connectionState: status?.state,
        toolCount: status?.state === 'connected' ? status.toolCount : undefined,
        serverPid: server?.pid,
        serverPpid: server?.ppid,
      })
    } catch (error) {
      if (abortDisposal !== undefined) await abortDisposal
      if (handle !== undefined) {
        try { await handle.dispose() } catch { /* the failed fiber owns its rollback */ }
      }
      fact(request.actionId, 'mount-A', {
        ok: false,
        sessionId: request.sessionId,
        agentId: String(agent.id),
        error: error instanceof Error ? error.message : String(error),
        errorCode: typeof error?.code === 'string' ? error.code : undefined,
      })
    }
  }

  const handleProbeB = async (request) => {
    const agentA = pinAgent(request.sessionId, 'A')
    const agentB = pinAgent(request.sessionIdB, 'B')
    const sessions = ctx.reflect.get('sessions')
    assertPinned('A')
    assertPinned('B')
    const aToolNames = schemaNames(agentA)
    const bToolNames = schemaNames(agentB)
    const agentCount = ctx.agents.list().length
    const sessionCount = sessions?.list().length
    fact(request.actionId, 'probe-B', {
      ok: sessions !== undefined && sessions.get(request.sessionId) === agentA.session
        && sessions.get(request.sessionIdB) === agentB.session,
      sessionId: String(agentB.id),
      agentId: String(agentB.id),
      agentAId: String(agentA.id),
      agentBId: String(agentB.id),
      agentASessionExact: sessions?.get(request.sessionId) === agentA.session,
      agentBSessionExact: sessions?.get(request.sessionIdB) === agentB.session,
      agentAToolNames: aToolNames,
      agentBToolNames: bToolNames,
      agentAHasEcho: aToolNames.includes(B0_ECHO_TOOL),
      agentBHasEcho: bToolNames.includes(B0_ECHO_TOOL),
      agentCount,
      sessionCount,
    })
  }

  const handleMountDuplicate = async (request) => {
    const agent = pinAgent(request.sessionId, 'A')
    const McpClient = await import('@deepseek-ai/dsh-mcp-client')
    const serverStartsBefore = proofLines().filter(line => line.kind === 'server-start' && line.tag === 'b0scope').length
    let duplicate
    let rejected = false
    let message
    try {
      duplicate = agent.ctx.plugin(McpClient, clientConfig(McpClient, agent, 'b0scope', 'b0scope'))
      await duplicate.await()
    } catch (error) {
      rejected = true
      message = error instanceof Error ? error.message : String(error)
    }
    assertPinned('A')
    if (duplicate !== undefined) {
      try { await duplicate.dispose() } catch { /* rollback already owns it */ }
    }
    const firstStatus = state.fiberA === undefined ? undefined : McpClient.connectionStatusOf(state.fiberA)?.current()
    const serverStartsAfter = proofLines().filter(line => line.kind === 'server-start' && line.tag === 'b0scope').length
    const duplicateClosure = duplicate === undefined ? undefined : McpClient.connectionStatusOf(duplicate)?.closure()
    fact(request.actionId, 'mount-duplicate-A', {
      ok: rejected && firstStatus?.state === 'connected'
        && serverStartsAfter === serverStartsBefore
        && typeof message === 'string' && message.includes('serverName "b0scope" is already in use'),
      sessionId: String(agent.id),
      agentId: String(agent.id),
      rejected,
      error: message,
      duplicateClosure,
      serverStartsBefore,
      serverStartsAfter,
      firstConnectionState: firstStatus?.state,
      firstToolNames: schemaNames(agent),
    })
  }

  const handleGlobalShadow = async (request) => {
    if (state.globalDispose !== undefined) throw new Error('m4-c1-host-work: B0 global shadow is already installed')
    const agentA = pinAgent(request.sessionId, 'A')
    const agentB = pinAgent(request.sessionIdB, 'B')
    state.globalDispose = ctx.tools.register(defineTool({
      name: B0_ECHO_TOOL,
      description: 'B0 GLOBAL_ONLY shadow tool',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: () => [{ type: 'text', text: 'GLOBAL_ONLY' }],
      },
      async execute() {
        return 'GLOBAL_ONLY'
      },
    }))
    const aDefinition = ctx.tools.get(B0_ECHO_TOOL, agentA)
    const bDefinition = ctx.tools.get(B0_ECHO_TOOL, agentB)
    fact(request.actionId, 'global-shadow-A', {
      ok: aDefinition?.description === 'B0 scoped echo tool: returns the caller nonce'
        && bDefinition?.description === 'B0 GLOBAL_ONLY shadow tool',
      sessionId: String(agentA.id),
      agentId: String(agentA.id),
      aDescription: aDefinition?.description,
      bDescription: bDefinition?.description,
      aToolNames: schemaNames(agentA),
      bToolNames: schemaNames(agentB),
      collisionGuardRequired: true,
      marker: 'B1_COLLISION_GUARD_REQUIRED',
    })
  }

  const handleClearGlobalShadow = async (request) => {
    const disposer = state.globalDispose
    if (disposer === undefined) throw new Error('m4-c1-host-work: B0 global shadow is not installed')
    disposer()
    state.globalDispose = undefined
    const agentB = pinAgent(request.sessionIdB, 'B')
    fact(request.actionId, 'clear-global-shadow', {
      ok: !schemaNames(agentB).includes(B0_ECHO_TOOL),
      sessionId: String(agentB.id),
      agentId: String(agentB.id),
      bToolNames: schemaNames(agentB),
    })
  }

  const handleRequestRetire = async (request) => {
    const agent = pinAgent(request.sessionId, 'A')
    if (state.fiberA === undefined) throw new Error('m4-c1-host-work: request-retire-A requires a mounted B0 fiber')
    const active = activeCallsOf(request.sessionId)
    state.retireRequest = {
      actionId: request.actionId,
      requestedAt: Date.now(),
      sessionId: request.sessionId,
      activeCallIds: active.map(call => call.callId),
      lastTurnEnd: lastTurnEnd.get(request.sessionId) ?? null,
    }
    fact(request.actionId, 'request-retire-A', {
      ok: true,
      retireRequested: true,
      deferred: active.length > 0,
      activeCallIds: active.map(call => call.callId),
      sessionId: String(agent.id),
      agentId: String(agent.id),
      lastTurnEnd: lastTurnEnd.get(request.sessionId) ?? null,
    })
  }

  const handleRetireAfterTerminal = async (request) => {
    const agent = pinAgent(request.sessionId, 'A')
    const pending = state.retireRequest
    if (pending === undefined || pending.sessionId !== request.sessionId) {
      fact(request.actionId, 'retire-after-terminal', {
        ok: false,
        reason: 'B0_RETIRE_NOT_REQUESTED',
        sessionId: String(agent.id),
        agentId: String(agent.id),
      })
      return
    }
    // whole-Agent quiescence is the ONLY admission before the synchronous
    // maintenance owner; a status snapshot alone is not an atomic fact.
    await agent.whenIdle()
    assertPinned('A')
    const active = activeCallsOf(request.sessionId)
    if (active.length > 0) {
      fact(request.actionId, 'retire-after-terminal', {
        ok: false,
        reason: 'B0_RETIRE_DEFERRED',
        activeCallIds: active.map(call => call.callId),
        sessionId: String(agent.id),
        agentId: String(agent.id),
      })
      return
    }
    const missingTerminal = pending.activeCallIds.filter(callId => !results.has(callId))
    const currentTurnEnd = lastTurnEnd.get(request.sessionId) ?? -1
    if (missingTerminal.length > 0 || currentTurnEnd < (pending.lastTurnEnd ?? -1)) {
      fact(request.actionId, 'retire-after-terminal', {
        ok: false,
        reason: 'B0_RETIRE_TERMINAL_UNCONFIRMED',
        missingTerminal,
        lastTurnEnd: currentTurnEnd,
        requestedLastTurnEnd: pending.lastTurnEnd,
        sessionId: String(agent.id),
        agentId: String(agent.id),
      })
      return
    }
    if (agent.status !== 'idle') {
      fact(request.actionId, 'retire-after-terminal', {
        ok: false,
        reason: 'B0_AGENT_NOT_IDLE',
        agentStatus: agent.status,
        sessionId: String(agent.id),
        agentId: String(agent.id),
      })
      return
    }
    const handle = state.fiberA
    if (handle === undefined) {
      fact(request.actionId, 'retire-after-terminal', {
        ok: false,
        reason: 'B0_MCP_NOT_MOUNTED',
        sessionId: String(agent.id),
        agentId: String(agent.id),
      })
      return
    }
    const server = serverStartOf('b0scope')
    const serverAliveBeforeDispose = server !== undefined && b0Alive(server.pid)
    const McpClient = await import('@deepseek-ai/dsh-mcp-client')
    try {
      await agent.runMaintenance(async signal => {
        if (signal.aborted) throw signal.reason ?? new Error('B0 retire aborted')
        await handle.dispose()
      })
      assertPinned('A')
      state.fiberA = undefined
      state.retireRequest = undefined
      const closure = McpClient.connectionStatusOf(handle)?.closure()
      const toolNames = schemaNames(agent)
      const serverExited = server === undefined ? false : await waitForProcessGone(server.pid)
      const stdinClosed = server === undefined ? undefined : proofOf('server-stdin-closed', 'b0scope')
      fact(request.actionId, 'retire-after-terminal', {
        ok: closure?.closeConfirmed === true && closure?.cleanupError === undefined
          && !toolNames.includes(B0_ECHO_TOOL) && serverAliveBeforeDispose && serverExited
          && stdinClosed !== undefined && stdinClosed.pid === server.pid,
        sessionId: String(agent.id),
        agentId: String(agent.id),
        closure,
        toolNames,
        serverPid: server?.pid,
        serverAliveBeforeDispose,
        serverExited,
        stdinClosed: stdinClosed !== undefined,
        lastTurnEnd: lastTurnEnd.get(request.sessionId) ?? null,
      })
    } catch (error) {
      fact(request.actionId, 'retire-after-terminal', {
        ok: false,
        reason: 'B0_MCP_CLEANUP_UNCONFIRMED',
        sessionId: String(agent.id),
        agentId: String(agent.id),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleMountFailing = async (request) => {
    const agent = pinAgent(request.sessionId, 'A')
    const McpClient = await import('@deepseek-ai/dsh-mcp-client')
    let handle
    let rejected = false
    let message
    try {
      handle = agent.ctx.plugin(McpClient, clientConfig(McpClient, agent, 'b0fail', 'b0fail', { B0_BOOT_FAIL: '1' }))
      await handle.await()
    } catch (error) {
      rejected = true
      message = error instanceof Error ? error.message : String(error)
    }
    const bootFail = proofOf('server-boot-fail', 'b0fail')
    const childExited = bootFail === undefined ? false : await waitForProcessGone(bootFail.pid)
    assertPinned('A')
    const connectionLostClosure = handle === undefined ? undefined : McpClient.connectionStatusOf(handle)?.closure()
    if (handle !== undefined) {
      try { await handle.dispose() } catch { /* failed activation already rolled back */ }
    }
    const retireClosure = handle === undefined ? undefined : McpClient.connectionStatusOf(handle)?.closure()
    fact(request.actionId, 'mount-failing-A', {
      ok: rejected && bootFail !== undefined && childExited
        && retireClosure?.closeConfirmed === true && retireClosure?.cleanupError === undefined,
      rejected,
      error: message,
      childPid: bootFail?.pid,
      childPpid: bootFail?.ppid,
      childExited,
      connectionLostClosure,
      retireClosure,
      sessionId: String(agent.id),
      agentId: String(agent.id),
    })
  }

  const handleMountCrash = async (request) => {
    const agent = pinAgent(request.sessionId, 'A')
    const McpClient = await import('@deepseek-ai/dsh-mcp-client')
    state.fiberCrash = agent.ctx.plugin(McpClient, clientConfig(McpClient, agent, 'b0crash', 'b0crash'))
    await state.fiberCrash.await()
    assertPinned('A')
    const status = McpClient.connectionStatusOf(state.fiberCrash)
    state.crashStatusDispose = status?.onChange(next => {
      record('b0-crash-status', { tag: 'b0crash', state: next.state, reason: next.reason, lastError: next.lastError })
    })
    const server = serverStartOf('b0crash')
    const liveIdentity = server === undefined ? undefined : b0ProcessIdentity(server.pid)
    if (liveIdentity === undefined || liveIdentity.ppid !== process.pid) {
      throw new Error('m4-c1-host-work: mount-crash-A cannot prove the live MCP child parent identity')
    }
    state.crashIdentity = liveIdentity
    fact(request.actionId, 'mount-crash-A', {
      ok: status?.current().state === 'connected' && server !== undefined
        && liveIdentity.started !== undefined && liveIdentity.ppid === process.pid,
      sessionId: String(agent.id),
      agentId: String(agent.id),
      connectionState: status?.current().state,
      serverPid: server?.pid,
      serverPpid: liveIdentity.ppid,
      serverStarttime: liveIdentity.started,
    })
  }

  const handleCrashFailing = async (request) => {
    const agent = pinAgent(request.sessionId, 'A')
    const McpClient = await import('@deepseek-ai/dsh-mcp-client')
    const server = serverStartOf('b0crash')
    const recorded = state.crashIdentity
    if (server === undefined || recorded === undefined || recorded.pid !== server.pid) {
      throw new Error('m4-c1-host-work: B0 crash-failing-A has no recorded live child identity')
    }
    const live = b0ProcessIdentity(recorded.pid)
    if (live === undefined || live.pid !== recorded.pid || live.started !== recorded.started || live.ppid !== process.pid) {
      fact(request.actionId, 'crash-failing-A', {
        ok: false,
        reason: 'B0_MCP_PID_REUSED',
        sessionId: String(agent.id),
        agentId: String(agent.id),
        serverPid: recorded.pid,
        recordedStarttime: recorded.started,
        observedStarttime: live?.started,
        recordedPpid: recorded.ppid,
        observedPpid: live?.ppid,
      })
      return
    }
    process.kill(recorded.pid, 'SIGKILL')
    const deadline = Date.now() + 10_000
    let status
    while (Date.now() < deadline) {
      status = McpClient.connectionStatusOf(state.fiberCrash)?.current()
      if (status?.state === 'failed') break
      await sleepB0(25)
    }
    const handle = state.fiberCrash
    state.fiberCrash = undefined
    const connectionLostClosure = handle === undefined ? undefined : McpClient.connectionStatusOf(handle)?.closure()
    if (handle !== undefined) await handle.dispose()
    const retireClosure = handle === undefined ? undefined : McpClient.connectionStatusOf(handle)?.closure()
    if (state.crashStatusDispose !== undefined) {
      state.crashStatusDispose()
      state.crashStatusDispose = undefined
    }
    assertPinned('A')
    const serverExited = await waitForProcessGone(recorded.pid)
    state.crashIdentity = undefined
    fact(request.actionId, 'crash-failing-A', {
      ok: status?.state === 'failed' && retireClosure?.closeConfirmed === true && retireClosure?.cleanupError === undefined
        && serverExited && !schemaNames(agent).includes('mcp__b0crash__echo'),
      sessionId: String(agent.id),
      agentId: String(agent.id),
      connectionState: status?.state,
      failureReason: status?.reason,
      connectionLostClosure,
      retireClosure,
      serverPid: recorded.pid,
      serverStarttime: recorded.started,
      serverExited,
    })
  }

  const runAction = async request => {
    if (typeof request?.actionId !== 'string' || request.actionId === '') {
      throw new Error('m4-c1-host-work: B0 control request has no actionId')
    }
    switch (request.action) {
      case 'mount-A': return await handleMountA(request)
      case 'probe-B': return await handleProbeB(request)
      case 'mount-duplicate-A': return await handleMountDuplicate(request)
      case 'global-shadow-A': return await handleGlobalShadow(request)
      case 'clear-global-shadow': return await handleClearGlobalShadow(request)
      case 'request-retire-A': return await handleRequestRetire(request)
      case 'retire-after-terminal': return await handleRetireAfterTerminal(request)
      case 'mount-failing-A': return await handleMountFailing(request)
      case 'mount-crash-A': return await handleMountCrash(request)
      case 'crash-failing-A': return await handleCrashFailing(request)
      default:
        throw new Error(`m4-c1-host-work: unknown B0 control action ${JSON.stringify(request.action)}`)
    }
  }

  ctx.effect(() => {
    timer = setInterval(() => {
      if (state.stopped || current !== undefined || !existsSync(controlPath)) return
      let request
      try {
        request = JSON.parse(readFileSync(controlPath, 'utf8'))
      } catch (error) {
        rmSync(controlPath, { force: true })
        record('b0-control-invalid', { message: error instanceof Error ? error.message : String(error) })
        return
      }
      // Consume the request BEFORE any action: one request means one attempt.
      rmSync(controlPath, { force: true })
      current = runAction(request)
        .catch(error => {
          fact(request?.actionId, request?.action ?? 'unknown', {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            errorCode: typeof error?.code === 'string' ? error.code : undefined,
          })
        })
        .finally(() => { current = undefined })
    }, 25)
    return async () => {
      state.stopped = true
      clearInterval(timer)
      if (current !== undefined) await current
      if (state.globalDispose !== undefined) {
        state.globalDispose()
        state.globalDispose = undefined
      }
      if (state.crashStatusDispose !== undefined) {
        state.crashStatusDispose()
        state.crashStatusDispose = undefined
      }
      for (const key of ['fiberCrash', 'fiberA']) {
        const handle = state[key]
        if (handle === undefined) continue
        state[key] = undefined
        try { await handle.dispose() } catch (error) {
          record('b0-dispose-failed', { handle: key, message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
  }, 'b0-workload-owner')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (event?.type === 'tool/call') {
      const callId = String(event.data?.callId)
      calls.set(callId, {
        callId,
        sessionId,
        turn: event.data?.turn,
        step: event.data?.step,
        name: event.data?.name,
        arguments: event.data?.arguments,
      })
      record('b0-session-tool-call', {
        sessionId,
        callId,
        turn: event.data?.turn,
        name: event.data?.name,
      })
      return
    }
    if (event?.type === 'tool/result') {
      const callId = String(event.data?.message?.toolCallId)
      results.add(callId)
      record('b0-session-tool-result', {
        sessionId,
        callId,
        turn: event.data?.turn,
        isError: event.data?.message?.isError === true,
        errorCode: event.data?.error?.code,
        text: (event.data?.message?.content ?? [])
          .map(part => (part?.type === 'text' ? part.text : ''))
          .join('')
          .slice(0, 500),
      })
      return
    }
    if (event?.type === 'turn/end') {
      lastTurnEnd.set(sessionId, event.data?.turn)
      record('b0-session-turn-end', {
        sessionId,
        turn: event.data?.turn,
        reason: event.data?.reason,
      })
    }
  }), 'b0-session-event-observer')

  return { state }
}

/**
 * G-ACP1B/B1 test-owned Host control surface.
 *
 * It only performs the two facts a real qualification needs beyond the
 * production MCP admission: a deliberately installed GLOBAL tool that must be
 * rejected as a shadow, and an exact Agent/Session/tool-count probe used to
 * prove an invalid request created nothing. No Session/Agent/MCP child is
 * created or mounted here.
 */
function createScopedMcpB1Workload(ctx, { root, record }) {
  const controlPath = process.env.C1_B1_CONTROL ?? join(root, 'b1-control.json')
  if (typeof process.env.C1_B1_CONTROL !== 'string' || process.env.C1_B1_CONTROL === '') {
    throw new Error('m4-c1-host-work: acp-scoped-mcp-b1 requires C1_B1_CONTROL')
  }
  let globalDispose
  let timer
  let current
  const fact = (actionId, action, fields = {}) => {
    record('b1-fact', { actionId, action, hostPid: process.pid, ...fields })
  }
  const sessionCounts = () => {
    const sessions = ctx.reflect.get('sessions')
    return { agentCount: ctx.agents.list().length, sessionCount: sessions?.list().length }
  }
  const handle = async request => {
    if (request.action === 'probe') {
      const counts = sessionCounts()
      const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
      const tools = agent === undefined ? [] : ctx.tools.schemas(agent).map(schema => schema.name)
      fact(request.actionId, 'probe', { ok: true, sessionId: request.sessionId, agentId: agent?.id, ...counts, toolNames: tools })
      return
    }
    if (request.action === 'global-shadow') {
      if (globalDispose !== undefined) throw new Error('m4-c1-host-work: B1 global shadow is already installed')
      globalDispose = ctx.tools.register(defineTool({
        name: B1_ECHO_TOOL,
        description: 'B1 GLOBAL_ONLY shadow tool',
        parameters: {},
        output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'GLOBAL_ONLY' }] },
        async execute() { return 'GLOBAL_ONLY' },
      }))
      const agent = request.sessionId === undefined ? undefined : ctx.agents.get(request.sessionId)
      fact(request.actionId, 'global-shadow', {
        ok: true,
        sessionId: request.sessionId,
        agentId: agent?.id,
        toolNames: agent === undefined ? [] : ctx.tools.schemas(agent).map(schema => schema.name),
        ...sessionCounts(),
      })
      return
    }
    if (request.action === 'clear-global-shadow') {
      if (globalDispose === undefined) throw new Error('m4-c1-host-work: B1 global shadow is not installed')
      globalDispose()
      globalDispose = undefined
      fact(request.actionId, 'clear-global-shadow', { ok: true, ...sessionCounts() })
      return
    }
    throw new Error(`m4-c1-host-work: unknown B1 control action ${JSON.stringify(request.action)}`)
  }
  ctx.effect(() => {
    timer = setInterval(() => {
      if (current !== undefined || !existsSync(controlPath)) return
      let request
      try {
        request = JSON.parse(readFileSync(controlPath, 'utf8'))
      } catch (error) {
        rmSync(controlPath, { force: true })
        record('b1-control-invalid', { message: error instanceof Error ? error.message : String(error) })
        return
      }
      rmSync(controlPath, { force: true })
      current = handle(request)
        .catch(error => {
          fact(request?.actionId, request?.action ?? 'unknown', {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => { current = undefined })
    }, 25)
    return async () => {
      clearInterval(timer)
      if (current !== undefined) await current
      if (globalDispose !== undefined) {
        globalDispose()
        globalDispose = undefined
      }
    }
  }, 'b1-workload-owner')
}

/**
 * PR1 Host default environment: the fixed harmless command the scripted model
 * may request. The Command probes the run-owned executables by BARE name; the
 * `command -v` guard makes an absent tool an explicit `PR1_ABSENT` fact instead
 * of a shell failure, and every present tool is really executed.
 */
const PR1_FOREGROUND_COMMAND = [
  'status=0;',
  'for p in dsh-pr1-user-probe dsh-pr1-mise-probe dsh-pr1-cargo-probe dsh-pr1-pnpm-probe dsh-pr1-client-only-probe; do',
  'if command -v "$p" >/dev/null 2>&1; then "$p" || status=1; else printf "PR1_ABSENT=%s\\n" "$p"; fi;',
  'done;',
  'dsh-pr1-shadow-probe || status=1;',
  'printf "PR1_SHELL=%s\\n" "${DSH_SHELL:-unset}";',
  'printf "PR1_SECRET=%s\\n" "${PR1_API_KEY:-unset}";',
  'exit "$status"',
].join(' ')
/** The ONE harmless background command this scenario may request. */
const PR1_BACKGROUND_COMMAND = 'dsh-pr1-user-probe'

class C1Model extends LlmAdapter {
  constructor(scenario, proof, root, agentStatusOf, neverSetup, imageProbe, markdownFileProbe, po4c, probeRegistry, subprocessProbe) {
    super()
    this.scenario = scenario
    this.proof = proof
    this.root = root
    this.agentStatusOf = agentStatusOf
    this.neverSetup = neverSetup
    this.imageProbe = imageProbe
    this.markdownFileProbe = markdownFileProbe
    this.po4c = po4c
    this.probeRegistry = probeRegistry
    this.subprocessProbe = subprocessProbe
    this.toolIssued = new Set()
    this.longTurnCount = new Map()
    this.failflowStep = new Map()
    // G-ACP2-PR2: the real provider step counter of the protocol-projection
    // scenario (one extra turn per official tool result).
    this.projectionStep = new Map()
    this.childHeld = false
  }

  projectionStepOf(sessionId) {
    return this.projectionStep.get(sessionId) ?? 0
  }

  setProjectionStep(sessionId, step) {
    this.projectionStep.set(sessionId, step)
  }

  /** Emit ONE standard provider tool-call block (the same chunk shape every
   *  other C1 scenario uses), so the official ToolRuntime admits and executes
   *  it exactly as it would a real model's request. */
  async *toolCall(name, callId, args) {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  record(kind, fields = {}) {
    appendFileSync(this.proof, `${JSON.stringify({ kind, scenario: this.scenario, time: Date.now(), pid: process.pid, ...fields })}\n`, { mode: 0o600 })
  }

  async resolveModel(provider, model) {
    const po4a = this.scenario === 'acp-po4a' && process.env.C1_PO4A_IMAGE_CAPABLE === '1'
    // Model-S1's second offline route must be switchable by a real TUI turn:
    // the official compaction pressure check needs context capacity on the
    // target route. C1_MODEL_S1_ROUTE is a dedicated Model-S1-only switch set
    // by both ACP Host starts; it never changes the base c1 route or the
    // unrelated sessionless-default-model scenario.
    const modelSwitchContext = process.env.C1_MODEL_S1_ROUTE === model
      ? { context: { contextWindow: 200_000 } }
      : {}
    // G-ACP2-PR2: the protocol-projection scenario needs a REAL declared route
    // capacity so the official token meter can pair provider usage with it.
    const projectionRouteContext = this.scenario === 'acp-projection' && model === 'c1'
      ? { context: { contextWindow: Number(process.env.C1_PROJECTION_CONTEXT_WINDOW ?? 200_000) } }
      : {}
    const modelS1Reasoning = process.env.C1_MODEL_S1_ROUTE === model
      ? { reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: 'low' } }
      : {}
    return {
      provider,
      id: model,
      name: model,
      ...modelSwitchContext,
      ...projectionRouteContext,
      ...modelS1Reasoning,
      ...(po4a && model === 'c1' ? { inputModalities: ['text', 'image'] } : {}),
      ...(po4a && model === 'c1-text-only' ? { inputModalities: ['text'] } : {}),
    }
  }

  async listModels() {
    const models = [{ provider: 'c1-qualification', id: 'c1', name: 'c1' }]
    if (this.scenario === 'acp-po4a' && process.env.C1_PO4A_IMAGE_CAPABLE === '1') {
      models.push({ provider: 'c1-qualification', id: 'c1-text-only', name: 'c1-text-only', inputModalities: ['text'] })
    }
    // Qualification-only: a SECOND offline route so the sessionless default
    // save case can prove a REAL default change. No other case sets this env.
    const extra = process.env.C1_EXTRA_MODEL
    if (typeof extra === 'string' && extra !== '') {
      models.push({ provider: 'c1-qualification', id: extra, name: extra })
    }
    return models
  }

  async *stream(options) {
    const signal = options.signal
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
    if (options.purpose === 'session-title') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'C1 qualification' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'C1 qualification' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    recordPromptFacts(options)
    const userText = allUserText(options.messages ?? [])
    // QUALIFICATION-ONLY read-only observation of the official live registries
    // for ONE watched Session id (`C1_WATCH_SESSION`). The phase marker comes
    // from the CURRENT authored prompt only: the official agent loop forwards
    // the derived history, so an older marker must never shadow this step's.
    // The pack does not ship this.
    const reversedMessages = [...(options.messages ?? [])].reverse()
    // The request's last user message IS this step's prompt; when the message
    // shape carries an explicit source, prefer the user-authored one.
    const authored = reversedMessages.find(message => message?.role === 'user' && message?.source?.kind === 'user')
      ?? reversedMessages.find(message => message?.role === 'user')
    const phaseText = authored === undefined ? '' : allUserText([authored])
    const phaseMatch = /projection-registry-marker:([a-z0-9-]+)/u.exec(phaseText)
    if (phaseMatch !== null) this.record('live-registry-phase', { phase: phaseMatch[1] })
    const registry = this.probeRegistry?.({ phase: phaseMatch?.[1] ?? null, sessionId })
    if (registry !== undefined) this.record('live-registry', registry)
    const afterTool = Array.isArray(options.messages) && options.messages.at(-1)?.role === 'tool'
    const token = `${this.scenario}-${sessionId}`

    if (this.scenario === 'host-default-environment') {
      // The ONLY authored markers this scenario accepts. Each maps to a fixed
      // harmless command below; no prompt text can become a command.
      const background = userText.includes('pr1-background-probe')
      const foreground = userText.includes('pr1-foreground-probe')
      const subprocess = userText.includes('pr1-subprocess-probe')
      if (subprocess && !this.toolIssued.has(`pr1-subprocess-${sessionId}`)) {
        this.toolIssued.add(`pr1-subprocess-${sessionId}`)
        if (this.subprocessProbe === undefined) {
          throw new Error('m4-c1-host-work: host-default-environment requires the ctx.subprocess probe')
        }
        await this.subprocessProbe(sessionId)
      } else if ((background || foreground) && !this.toolIssued.has(`pr1-${background ? 'background' : 'foreground'}-${sessionId}`)) {
        this.toolIssued.add(`pr1-${background ? 'background' : 'foreground'}-${sessionId}`)
        const args = background
          ? { command: PR1_BACKGROUND_COMMAND, description: 'Run the Host PATH probe in the background', run_in_background: true }
          : { command: PR1_FOREGROUND_COMMAND, description: 'Run the Host PATH probes' }
        yield {
          type: 'block-start',
          index: 0,
          blockType: 'tool-call',
        }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `pr1-${background ? 'background' : 'foreground'}-${sessionId}`,
            name: 'bash',
            arguments: JSON.stringify(args),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `host-default-environment answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `host-default-environment answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'acp-transient') {
      // A provider whose streamed text IS its committed text: the two deltas
      // accumulate to exactly the block-end block. The hold between them lets a
      // case observe the first ACP chunk BEFORE the durable `assistant/message`
      // append, which is the whole transient-stream settlement contract.
      if (userText.includes('ts-inconsistent')) {
        // Deliberate negative control: the provider rewrites the block it
        // already streamed. ACP v1 cannot retract the provisional bytes, so the
        // View must fail the request closed instead of pretending the rewritten
        // committed text was delivered.
        this.record('acp-transient-inconsistent', { sessionId })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `acp-transient provisional ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `acp-transient committed ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const first = `acp-transient first ${token} `
      const second = `acp-transient second ${token}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: first }
      this.record('acp-transient-held', { sessionId, userText: userText.slice(0, 200) })
      await waitForBarrier(process.env.C1_HOLD_ACP_TRANSIENT, signal)
      this.record('acp-transient-released', { sessionId })
      yield { type: 'text-delta', index: 0, text: second }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${first}${second}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'acp-po4a') {
      // The Host appends its OWN user-role context (runtime/time context) after
      // the author's prompt, so the marker is matched against the newest
      // AUTHORED user text, never a substring of the whole conversation.
      const authoredUser = [...(options.messages ?? [])].reverse()
        .find(message => message?.role === 'user' && message?.source?.kind === 'user')
      const authoredUserText = (authoredUser?.content ?? [])
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .join('')
      if (authoredUserText === PO4B_MARKER) {
        await this.markdownFileProbe(sessionId)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: PO4B_BLOCK_1 }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: PO4B_BLOCK_1 } }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        yield { type: 'text-delta', index: 1, text: PO4B_BLOCK_2 }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: PO4B_BLOCK_2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const latestUser = [...(options.messages ?? [])].reverse().find(message => message?.role === 'user')
      const latestUserText = (latestUser?.content ?? [])
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .join('')
      if (latestUserText.includes('po4a-held-tui')) {
        this.record('po4a-tui-turn-held', { sessionId })
        await waitForBarrier(process.env.C1_PO4A_TUI_HOLD, signal)
        this.record('po4a-tui-turn-released', { sessionId })
      }
      await this.imageProbe?.(sessionId)
      const answer = `acp-po4a answer ${token}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'acp-po4c') {
      // The Host appends its OWN user-role context after the author's prompt, so
      // the marker is matched against the newest AUTHORED user text only.
      const authoredUser = [...(options.messages ?? [])].reverse()
        .find(message => message?.role === 'user' && message?.source?.kind === 'user')
      const authoredText = (authoredUser?.content ?? [])
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .join('')
      const matched = Object.entries(PO4C_MARKERS).find(([, value]) => authoredText.includes(value))
      this.record('po4c-model-branch', { marker: matched?.[0] ?? 'none', afterTool })
      const imageBlocks = (ref, index) => [
        { type: 'block-start', index, blockType: 'image' },
        { type: 'block-end', index, block: { type: 'image', attachment: ref } },
      ]
      if (authoredText.includes(PO4C_MARKERS.assistantMixed)) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: PO4C_TEXT_BEFORE }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: PO4C_TEXT_BEFORE } }
        yield* imageBlocks(this.po4c.mixed, 1)
        yield { type: 'block-start', index: 2, blockType: 'text' }
        yield { type: 'text-delta', index: 2, text: PO4C_TEXT_AFTER }
        yield { type: 'block-end', index: 2, block: { type: 'text', text: PO4C_TEXT_AFTER } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (authoredText.includes(PO4C_MARKERS.assistantImageOnly)) {
        yield* imageBlocks(this.po4c.mixed, 0)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (authoredText.includes(PO4C_MARKERS.missingImage)) {
        yield* imageBlocks(this.po4c.missing, 0)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (authoredText.includes(PO4C_MARKERS.toolTwoImages)) {
        if (afterTool) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: PO4C_TOOL_ANSWER }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: PO4C_TOOL_ANSWER } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: 'po4c-tool-two',
            name: PO4C_TOOL_NAME,
            arguments: JSON.stringify({ twoImages: true }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (authoredText.includes(PO4C_MARKERS.toolContent) || authoredText.includes(PO4C_MARKERS.toolFailed)) {
        if (afterTool) {
          const answer = authoredText.includes(PO4C_MARKERS.toolContent) ? PO4C_TOOL_ANSWER : PO4C_TOOL_FAILED_ANSWER
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: answer }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        const failing = authoredText.includes(PO4C_MARKERS.toolFailed)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: failing ? 'po4c-tool-failed' : 'po4c-tool-ok',
            name: PO4C_TOOL_NAME,
            arguments: JSON.stringify(failing ? { fail: true } : {}),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `po4c answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `po4c answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'acp-command') {
      if (options.purpose === 'compaction') {
        const hold = process.env.C1_COMPACT_HOLD
        if (typeof hold === 'string' && hold !== '') {
          appendFileSync(`${hold}.entered`, `${String(process.pid)}\n`, { mode: 0o600 })
          const deadline = Date.now() + 30_000
          while (!existsSync(`${hold}.release`)) {
            if (options.signal?.aborted === true) {
              throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('acp-command compaction hold aborted')
            }
            if (Date.now() > deadline) throw new Error('acp-command compaction hold timed out')
            await new Promise(resolveWait => setTimeout(resolveWait, 25))
          }
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'acp command compaction summary' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'acp command compaction summary' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const answer = `acp command answer ${token} ${'acp command long context '.repeat(6_000)}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'acp-projection') {
      // The compaction summarizer runs with its OWN purpose: the answer must be
      // a plain text summary, never one of the scenario's tool turns.
      if (options.purpose === 'compaction') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'projection compaction summary' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'projection compaction summary' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // A delegated CHILD session first sends ONE real message to its creator
      // through the official `send_message` tool — the only real producer of a
      // durable `source.kind:'agent-message'` — and then answers its own task.
      if (userText.includes('projection-child-task')) {
        if (!afterTool) {
          yield* this.toolCall('send_message', `projection-child-message-${sessionId}`, {
            agent: 'lead',
            message: `projection child message ${token}`,
          })
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `projection child answer ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `projection child answer ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // G-ACP2-PR2 protocol projection: three REAL provider turns per Session.
      // Step 0 writes the official whole-list todo snapshot through the real
      // `todo_write` tool, step 1 delegates one REAL subagent child through the
      // `subagent` tool, and step 2 answers with text plus its own provider
      // usage so the official token meter has a real occupancy sample.
      const step = this.projectionStepOf(sessionId)
      this.setProjectionStep(sessionId, step + 1)
      if (step === 0) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `projection-todo-${sessionId}`,
            name: 'todo_write',
            arguments: JSON.stringify({
              todos: [
                { content: 'inspect the projection', status: 'in_progress' },
                { content: 'prove the replay', status: 'pending' },
              ],
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (step === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `projection-child-${sessionId}`,
            name: 'subagent',
            arguments: JSON.stringify({
              description: 'projection child',
              prompt: `projection-child-task ${token}`,
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      // The first prompt's CLOSING answer reports a LARGE provider occupancy,
      // so the official step-pressure check compacts the context before the
      // NEXT prompt's first step. Any later answer reports a small real sample.
      // The closing answer of the FIRST prompt is deliberately large and
      // reports the scripted provider's occupancy: the next step's official
      // pressure check then has a real surface to compact (the retained tail is
      // the big assistant node, the prefix is the system prompt + first user
      // message), which is what makes a REAL durable compaction happen.
      const closingAnswer = step === 2
        ? {
          text: `projection answer ${token} ${'projection long context '.repeat(6_000)}`,
          usage: {
            inputTokens: Number(process.env.C1_PROJECTION_PRESSURE_TOKENS ?? 150_000),
            outputTokens: 20,
            totalTokens: Number(process.env.C1_PROJECTION_PRESSURE_TOKENS ?? 150_000) + 20,
          },
        }
        : { text: `projection answer ${token}`, usage: { inputTokens: 1_200, outputTokens: 20, totalTokens: 1_220 } }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: closingAnswer.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: closingAnswer.text } }
      yield { type: 'usage', usage: closingAnswer.usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'f1-shell' || this.scenario === 'f4-file') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `${this.scenario} answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${this.scenario} answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // G-ACP1A/A1 qualification only: a bounded output stream large enough to
    // fill the real OS stdout pipe (2 committed blocks, each 64 KiB) without
    // crossing the existing ACP pending-update capacity (64). The stdio case
    // pauses its downstream sink, observes the child stay alive, then resumes
    // and proves every byte drains. No other case sends this marker.
    if (userText.includes('a1-pressure-output')) {
      const payload = 'x'.repeat(64 * 1024)
      for (let index = 0; index < 2; index += 1) {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'block-end', index, block: { type: 'text', text: `a1-pressure-${String(index)}-${payload}` } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // PO-3A qualification only: the ACP prompt marker asks for ONE committed
    // assistant message with more standard text blocks than the bounded ACP
    // output queue, so the real projection reaches its fixed cap. No other
    // case sends the marker, so no other lane's model behaviour changes.
    if (userText.includes('po3a-large-output') && !this.largeOutputIssued?.has(sessionId)) {
      this.largeOutputIssued ??= new Set()
      this.largeOutputIssued.add(sessionId)
      for (let index = 0; index < 200; index += 1) {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'block-end', index, block: { type: 'text', text: `po3a-large-block-${String(index)}-${token}` } }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'long-turn-stream') {
      // Same hold/turn mechanics and text vocabulary as `long-turn`, but the
      // streamed deltas ARE the committed block: the second delta carries the
      // attempt label the original scenario only put in its block-end.
      const token = `long-turn-${sessionId}`
      if (afterTool) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `long-turn answer ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `long-turn answer ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const attempt = (this.longTurnCount.get(sessionId) ?? 0) + 1
      this.longTurnCount.set(sessionId, attempt)
      const first = `long-turn started ${String(attempt)} ${token} `
      const second = `long-turn answer ${String(attempt)} ${token}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: first }
      this.record('long-turn-held', {
        sessionId,
        attempt,
        userText: userText.slice(0, 400),
        agentStatus: this.agentStatusOf(sessionId),
      })
      await waitForBarrier(process.env.C1_HOLD_LONG_TURN, signal)
      this.record('long-turn-released', { sessionId, attempt })
      yield { type: 'text-delta', index: 0, text: second }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${first}${second}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'long-turn') {
      if (afterTool) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `long-turn answer ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `long-turn answer ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const attempt = (this.longTurnCount.get(sessionId) ?? 0) + 1
      this.longTurnCount.set(sessionId, attempt)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `long-turn started ${token}` }
      this.record('long-turn-held', {
        sessionId,
        attempt,
        userText: userText.slice(0, 400),
        agentStatus: this.agentStatusOf(sessionId),
      })
      await waitForBarrier(process.env.C1_HOLD_LONG_TURN, signal)
      this.record('long-turn-released', { sessionId, attempt })
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `long-turn answer ${String(attempt)} ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'web-workspace-changes') {
      // The FIRST turn of a Session performs exactly ONE official `write` tool
      // call (the standard preset's real tool); the follow-up stream after its
      // result answers. Every later turn is a plain answer, and a
      // `w5-nochange` prompt runs one official `bash` tool call that changes no
      // file, so the recorder's genuine no-change path is exercised too.
      // The Host appends its OWN runtime/time context as user-role messages
      // AFTER the author's prompt, so the whole user text is matched instead of
      // a positional "last user message".
      const nonce = process.env.C1_CHANGES_NONCE ?? 'c1'
      const wrote = this.toolIssued.has(sessionId)
      const prompt = userText
      const toolCall = (id, toolName, args) => ({
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: toolName, arguments: JSON.stringify(args) },
      })
      if (prompt.includes('w5-changes2-')) {
        // The post-disable/re-enable Turn (F2): a SECOND real official `write`
        // through the same standard preset, into a different file.
        if (!this.secondIssued?.has(sessionId)) {
          this.secondIssued ??= new Set()
          this.secondIssued.add(sessionId)
          this.record('web-changes-write2-issued', { sessionId, nonce, userText: prompt })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield toolCall(`w5-write2-${sessionId}`, 'write', { file_path: 'changed2.txt', content: `w5-change2-${nonce}\n` })
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const secondText = `w5-editing2 ${nonce}\n\n[changed2.txt](changed2.txt)\n\nw5-second answer ${nonce}`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: secondText }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: secondText } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (!wrote && prompt.includes('w5-changes-')) {
        this.toolIssued.add(sessionId)
        this.record('web-changes-write-issued', { sessionId, nonce, userText: prompt })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield toolCall(`w5-write-${sessionId}`, 'write', { file_path: 'changed.txt', content: `w5-change-${nonce}\n` })
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (prompt.includes('w5-nochange') && !this.noChangeIssued?.has(sessionId)) {
        this.noChangeIssued ??= new Set()
        this.noChangeIssued.add(sessionId)
        this.record('web-changes-nochange-tool-issued', { sessionId, nonce })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield toolCall(`w5-nochange-${sessionId}`, 'read', { file_path: 'README.md' })
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const tail = prompt.includes('w5-nochange') ? 'w5-nochange answer' : 'w5-done answer'
      const text = `w5-editing ${nonce}\n\n[changed.txt](changed.txt)\n\n${tail} ${nonce}`
      this.record('web-changes-answer', { sessionId, nonce, tail })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'foreground-tool') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-foreground-${sessionId}`,
            name: 'c1_foreground_tool',
            arguments: JSON.stringify({ token }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `foreground answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `foreground answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'job') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        const release = join(this.root, 'job.release')
        const command = `while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done; printf 'c1-job-done'`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-job-${sessionId}`,
            name: 'bash',
            arguments: JSON.stringify({ command, description: 'Hold the M4-C1 background job', run_in_background: true }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `job accepted ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `job accepted ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'child') {
      if (userText.includes('c1-child-task')) {
        this.childHeld = true
        this.record('child-stream-held', { sessionId, userText })
        await waitForBarrier(process.env.C1_HOLD_CHILD, signal)
        this.record('child-stream-released', { sessionId })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `child answer ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `child answer ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-child-${sessionId}`,
            name: 'subagent',
            arguments: JSON.stringify({ description: 'C1 child work', prompt: `c1-child-task ${token}` }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `child delegated ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `child delegated ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'question') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        // The newest AUTHORED user text selects the question form: a marker
        // asks for the indefinite official `ask` (blocking) or the 1s timed
        // wait; the environment keeps its historical whole-scenario meaning.
        const authoredUser = [...(options.messages ?? [])].reverse()
          .find(message => message?.role === 'user' && message?.source?.kind === 'user')
        const authoredText = (authoredUser?.content ?? [])
          .map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
        const timeout = authoredText.includes('acp-question-timed') || process.env.C1_TIMED_QUESTION === '1'
          ? 1
          : authoredText.includes('acp-question-blocking') || authoredText.includes('acp-question-decline')
            ? -1
            : undefined
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-question-${sessionId}`,
            name: 'ask_user_question',
            arguments: JSON.stringify({
              questions: [{
                id: 'c1-question',
                question: 'Continue the C1 test?',
                options: [{ label: 'Proceed' }, { label: 'Cancel' }],
              }],
              ...(timeout === undefined ? {} : { timeout }),
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (process.env.C1_HOLD_AFTER_TIMED !== undefined && process.env.C1_HOLD_AFTER_TIMED !== '') {
        this.record('after-timed-held', { sessionId })
        await waitForBarrier(process.env.C1_HOLD_AFTER_TIMED, signal)
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `question answered ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `question answered ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'goal-armed' || this.scenario === 'goal-round' || this.scenario === 'maintenance' || this.scenario === 'schedule' || this.scenario === 'unowned-job') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `${this.scenario} answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${this.scenario} answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'plan-review') {
      // FR8: the ONLY authored markers, matched against the NEWEST authored
      // user text (the Host appends its own user-role context after it). Every
      // other prompt keeps the ordinary text answer, so `/plan` and the other
      // real Client gestures are never turned into tool calls.
      const authoredUser = [...(options.messages ?? [])].reverse()
        .find(message => message?.role === 'user' && message?.source?.kind === 'user')
      const authoredText = (authoredUser?.content ?? [])
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .join('')
      for (const [marker, review] of [
        [FR8_PLAN_APPROVE, 'approve'],
        [FR8_PLAN_KEEP, 'keep'],
        [FR8_PLAN_DISMISS, 'dismiss'],
      ]) {
        if (!authoredText.includes(marker)) continue
        // One exit_plan_mode per authored marker per Session: a repeated prompt
        // must not fabricate a second review of the same identity.
        const callId = `c1-plan-${review}-${sessionId}`
        if (this.toolIssued.has(callId)) break
        this.toolIssued.add(callId)
        yield* this.toolCall('exit_plan_mode', callId, { plan: FR8_PLAN_TEXT })
        return
      }
      const answer = `${authoredText.includes(FR8_PLAN_NEXT_STEP) ? 'next-step' : 'plan-review'} answer ${token}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'team-board') {
      // FR8: the created task's identity and revision come from the OFFICIAL
      // `team_task_create` tool result in this SAME request history — never a
      // pre-seeded task, never a guessed id.
      const authoredUser = [...(options.messages ?? [])].reverse()
        .find(message => message?.role === 'user' && message?.source?.kind === 'user')
      const authoredText = (authoredUser?.content ?? [])
        .map(part => typeof part?.text === 'string' ? part.text : '')
        .join('')
      if (authoredText.includes(FR8_TEAM_CREATE) && !this.toolIssued.has(`team-create:${sessionId}`)) {
        this.toolIssued.add(`team-create:${sessionId}`)
        yield* this.toolCall('team_task_create', `c1-team-create-${sessionId}`, {
          subject: FR8_TEAM_SUBJECT,
          description: FR8_TEAM_DESCRIPTION,
        })
        return
      }
      if (authoredText.includes(FR8_TEAM_UPDATE) && !this.toolIssued.has(`team-update:${sessionId}`)) {
        this.toolIssued.add(`team-update:${sessionId}`)
        const created = FR8_TEAM_TASK_OF(options.messages)
        if (created === undefined) throw new Error('m4-c1-host-work: team-board update has no official create result to address')
        yield* this.toolCall('team_task_update', `c1-team-update-${sessionId}`, {
          task_id: created.id,
          expected_revision: created.revision,
          action: 'reassign',
          owner: 'lead',
        })
        return
      }
      const answer = `team-board answer ${token}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'approval-allow' || this.scenario === 'approval-reject') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        const marker = join(this.root, `${this.scenario}.marker`)
        const command = `printf 'c1-${this.scenario}' > ${shellQuote(marker)}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-${this.scenario}-${sessionId}`,
            name: 'bash',
            arguments: JSON.stringify({
              command,
              description: 'Create the harmless M4-C1 approval marker',
              sandbox_permissions: 'danger-full-access',
              justification: 'Qualification verifies the human approval decision on an isolated harmless command.',
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `approval settled ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `approval settled ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'acp-po3b') {
      // The latest queue-probe user input avoids matching an earlier Turn's
      // marker in the assembled history. Hold before the second step's tool
      // activation so the smoke can cancel B after it joined TUI Turn A.
      const queueInput = (options.messages ?? [])
        .filter(message => message?.role === 'user')
        .flatMap(message => (message.content ?? []).filter(part => part?.type === 'text').map(part => part.text))
        .findLast(text => typeof text === 'string' && /^po3b-(?:tui|acp)-q/u.test(text))
      if (queueInput === 'po3b-acp-qsteer') {
        const key = `reverse-steer:${sessionId}`
        if (!this.toolIssued.has(key)) {
          this.toolIssued.add(key)
          this.record('reverse-steer-awaiting-approval', { sessionId })
          await waitForBarrier(process.env.C1_PO3B_REVERSE_APPROVAL, signal)
          const marker = join(this.root, `po3b-reverse-steer-${sessionId}.marker`)
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: {
            type: 'tool-call', id: `po3b-reverse-steer-${sessionId}`, name: 'bash',
            arguments: JSON.stringify({
              command: `printf 'reverse-steer' > ${shellQuote(marker)}`,
              description: 'Create the harmless reverse-steer approval marker',
              sandbox_permissions: 'danger-full-access',
              justification: 'Qualification checks that the original TUI Turn retains its approval responder.',
            }),
          } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `reverse-steer settled ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // A one-time official approval-policy switch for the never negative:
      // the marker prompt itself is answered as a plain turn, and every LATER
      // approval ask in this Session is decided by the OFFICIAL `never`
      // policy before the waterfall (no ACP question may appear).
      if (userText.includes('po3b-never-setup') && !this.toolIssued.has(`never:${sessionId}`)) {
        this.toolIssued.add(`never:${sessionId}`)
        if (this.neverSetup !== undefined) await this.neverSetup(sessionId)
        this.record('po3b-never-set', { sessionId })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `po3b never armed ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `po3b never armed ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // PO-3B F2 qualification only: `po3b-failflow` drives ONE turn through
      // tool1 (its approval settles normally) -> an over-capacity committed
      // output (the real View output bound fails the flight) -> tool2 (its
      // approval arrives AFTER the flight failed, proving the retired-turn
      // fence). The per-session step counter keys each model request.
      if (userText.includes('po3b-failflow')) {
        const key = `failflow:${sessionId}`
        const step = (this.failflowStep?.get(key) ?? 0) + 1
        this.failflowStep ??= new Map()
        this.failflowStep.set(key, step)
        const marker = join(this.root, `po3b-failflow-${sessionId}.marker`)
        const command = `printf 'po3b-failflow' > ${shellQuote(marker)}`
        if (step === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: `c1-po3b-fail1-${sessionId}`,
              name: 'bash',
              arguments: JSON.stringify({
                command,
                description: 'Create the harmless PO-3B failflow marker',
                sandbox_permissions: 'danger-full-access',
                justification: 'Qualification verifies the retired-turn approval fence on an isolated harmless command.',
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (step === 2) {
          // The over-capacity committed output fails the View flight while
          // the SAME turn continues to tool2.
          for (let index = 0; index < 200; index += 1) {
            yield { type: 'block-start', index, blockType: 'text' }
            yield { type: 'block-end', index, block: { type: 'text', text: `po3b-failflow-block-${String(index)}-${token}` } }
          }
          yield { type: 'block-start', index: 200, blockType: 'tool-call' }
          yield {
            type: 'block-end',
            index: 200,
            block: {
              type: 'tool-call',
              id: `c1-po3b-fail2-${sessionId}`,
              name: 'bash',
              arguments: JSON.stringify({
                command,
                description: 'The second harmless PO-3B failflow approval',
                sandbox_permissions: 'danger-full-access',
                justification: 'Qualification verifies the retired-turn approval fence on an isolated harmless command.',
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `po3b failflow settled ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `po3b failflow settled ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      // PO-3B qualification only. Prompts carrying the approval marker ask
      // for ONE official `bash` tool call (an approval waterfall question)
      // before answering; a `never`-policy Session never even asks because
      // the official service decides before the waterfall. Every other turn
      // is a held long turn (the C1_HOLD_LONG_TURN barrier), so the smoke can
      // stage queued-vs-running cancels against real Host facts.
      if (userText.includes('po3b-approval') && !afterTool) {
        const suffix = userText.includes('reject') ? 'reject' : 'allow'
        // ONE tool call per distinct ask marker: the follow-up model request
        // of the SAME turn is excluded by `afterTool`, and different asks use
        // different `po3b-*` marker words. The LAST match wins because the
        // assembled history repeats every earlier marker.
        const matches = userText.match(/po3b-(?:acp|tui|never)-[a-z-]+/g) ?? ['po3b-ask']
        const markerKey = `${sessionId}:${matches.at(-1)}`
        if (!this.toolIssued.has(markerKey)) {
          this.toolIssued.add(markerKey)
          const marker = join(this.root, `po3b-${suffix}-${sessionId}.marker`)
          const command = `printf 'po3b-${suffix}' > ${shellQuote(marker)}`
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: `c1-po3b-${suffix}-${sessionId}`,
              name: 'bash',
              arguments: JSON.stringify({
                command,
                description: 'Create the harmless PO-3B approval marker',
                sandbox_permissions: 'danger-full-access',
                justification: 'Qualification verifies the ACP approval ownership on an isolated harmless command.',
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `po3b settled ${suffix} ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `po3b settled ${suffix} ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (afterTool) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `po3b answer ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `po3b answer ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const attempt = (this.longTurnCount.get(sessionId) ?? 0) + 1
      this.longTurnCount.set(sessionId, attempt)
      // The two deltas ARE the committed block: the attempt label lives in the
      // text that is really streamed, so an ACP transient join can prove it.
      const first = `po3b started ${token} `
      const second = `po3b answer ${String(attempt)} ${token}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: first }
      this.record('long-turn-held', {
        sessionId,
        attempt,
        userText: userText.slice(0, 400),
        agentStatus: this.agentStatusOf(sessionId),
      })
      await waitForBarrier(process.env.C1_HOLD_LONG_TURN, signal)
      this.record('long-turn-released', { sessionId, attempt })
      yield { type: 'text-delta', index: 0, text: second }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${first}${second}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'acp-scoped-mcp-b0') {
      const prompt = b0PromptOf(options.messages ?? [])
      const toolNames = Array.isArray(options.tools)
        ? options.tools.map(tool => tool?.name).filter(name => typeof name === 'string').sort()
        : []
      if (prompt === undefined) {
        // The Host appends its own runtime/time context as a later user message;
        // a request with no B0 marker is an ordinary final answer, never a call.
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `b0 plain ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `b0 plain ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      this.record('b0-model-tools', {
        sessionId,
        marker: prompt.marker,
        nonce: prompt.nonce,
        toolNames,
        hasEchoTool: toolNames.includes(B0_ECHO_TOOL),
        hasHoldTool: toolNames.includes(B0_HOLD_TOOL),
        hasFailTool: toolNames.includes(B0_FAIL_TOOL),
        afterTool,
      })
      if (prompt.marker === B0_PLAIN_MARKER) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `b0 plain settled ${prompt.nonce ?? ''} ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `b0 plain settled ${prompt.nonce ?? ''} ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (afterTool) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `b0 ${prompt.marker} settled ${prompt.nonce ?? ''} ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `b0 ${prompt.marker} settled ${prompt.nonce ?? ''} ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const toolName = prompt.marker === B0_HOLD_MARKER
        ? B0_HOLD_TOOL
        : prompt.marker === B0_FAIL_MARKER
          ? B0_FAIL_TOOL
          : B0_ECHO_TOOL
      const callId = `b0-${prompt.marker.toLowerCase()}-${sessionId}-${prompt.nonce ?? '0'}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callId,
          name: toolName,
          arguments: JSON.stringify({ nonce: prompt.nonce ?? '' }),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    if (this.scenario === 'acp-scoped-mcp-b1') {
      const prompt = b1PromptOf(options.messages ?? [])
      const toolNames = Array.isArray(options.tools)
        ? options.tools.map(tool => tool?.name).filter(name => typeof name === 'string').sort()
        : []
      if (prompt === undefined) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `b1 plain ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `b1 plain ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      this.record('b1-model-tools', {
        sessionId,
        marker: prompt.marker,
        nonce: prompt.nonce,
        toolNames,
        hasEchoTool: toolNames.includes(B1_ECHO_TOOL),
        hasHoldTool: toolNames.includes(B1_HOLD_TOOL),
        hasFailTool: toolNames.includes(B1_FAIL_TOOL),
        afterTool,
      })
      if ((prompt.marker === B1_APPROVAL_A_MARKER || prompt.marker === B1_APPROVAL_B_MARKER) && !afterTool) {
        const approvalKey = `b1-approval:${sessionId}`
        if (!this.toolIssued.has(approvalKey)) {
          this.toolIssued.add(approvalKey)
          const marker = join(this.root, `b1-approval-${sessionId}.marker`)
          const command = `printf 'b1-approval' > ${shellQuote(marker)}`
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'block-end',
            index: 0,
            block: {
              type: 'tool-call',
              id: `b1-approval-${sessionId}`,
              name: 'bash',
              arguments: JSON.stringify({
                command,
                description: 'Create the harmless B2 permission marker',
                sandbox_permissions: 'danger-full-access',
                justification: 'Qualification verifies exact ACP permission routing on an isolated harmless command.',
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
      }
      if (prompt.marker === B1_PLAIN_MARKER) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `b1 plain settled ${prompt.nonce ?? ''} ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `b1 plain settled ${prompt.nonce ?? ''} ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (prompt.marker === B1_HOLD_B_MARKER) {
        this.record('b1-long-turn-held', { sessionId, nonce: prompt.nonce, agentStatus: this.agentStatusOf(sessionId) })
        await waitForBarrier(process.env.C1_HOLD_LONG_TURN, signal)
        this.record('b1-long-turn-released', { sessionId, nonce: prompt.nonce })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `b1 long settled ${prompt.nonce ?? ''} ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `b1 long settled ${prompt.nonce ?? ''} ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (afterTool) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `b1 ${prompt.marker} settled ${prompt.nonce ?? ''} ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `b1 ${prompt.marker} settled ${prompt.nonce ?? ''} ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const toolName = prompt.marker === B1_HOLD_MARKER
        ? B1_HOLD_TOOL
        : prompt.marker === B1_FAIL_MARKER
          ? B1_FAIL_TOOL
          : B1_ECHO_TOOL
      const callId = `b1-${prompt.marker.toLowerCase()}-${sessionId}-${prompt.nonce ?? '0'}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callId,
          name: toolName,
          arguments: JSON.stringify({ nonce: prompt.nonce ?? '' }),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    throw new Error(`m4-c1-host-work: unsupported scenario ${JSON.stringify(this.scenario)}`)
  }
}

/**
 * Mount the scripted workload on the Host profile. A profile without
 * `C1_SCENARIO` keeps this row inert: the ordinary B1/B2-S lanes share the
 * same installed profile and must not gain a second model route.
 */
export async function apply(ctx) {
  const scenario = process.env.C1_SCENARIO
  if (scenario === undefined || scenario === '') return
  if (!SCENARIOS.has(scenario)) throw new Error(`m4-c1-host-work: unsupported C1_SCENARIO ${JSON.stringify(scenario)}`)
  const { root, proof } = prepareWorkRoot(process.env.C1_WORK_ROOT)
  const record = (kind, fields = {}) => {
    appendFileSync(proof, `${JSON.stringify({ kind, scenario, time: Date.now(), pid: process.pid, ...fields })}\n`, { mode: 0o600 })
  }

  // Test-only lifecycle controls for the packed PR3A qualification. The smoke
  // writes immutable action files under its private work root; this fixture
  // only invokes OFFICIAL Host capabilities (Agent.cancel, the live Agent
  // Fiber disposer and the official Session flush). No product branch exists.
  const lifecycleControl = process.env.C1_LIFECYCLE_CONTROL
  if (typeof lifecycleControl === 'string' && lifecycleControl !== '') {
    const actions = new Set()
    const flushFailureSessions = new Set()
    const flushSummarySeen = new Set()
    const flushHoldSessions = new Map()
    let killAfterSummarySession
    const sessions = ctx.sessions
    const originalFlush = sessions.flush
    const lifecycleFlush = async function (...args) {
      // Fail only the exact Session's flush that follows its real committed
      // summary; the engine's earlier start/admission flush keeps its real
      // behavior, and a different Session can never consume this fault.
      const sessionId = String(args[0]?.id ?? '')
      const holdRelease = flushHoldSessions.get(sessionId)
      if (holdRelease !== undefined && flushSummarySeen.has(sessionId)) {
        flushHoldSessions.delete(sessionId)
        record('lifecycle-flush-held', { sessionId, release: holdRelease })
        const deadline = Date.now() + 30_000
        while (!existsSync(holdRelease)) {
          if (Date.now() > deadline) throw new Error('m4-c1-host-work: held flush timed out')
          await new Promise(resolveWait => setTimeout(resolveWait, 25))
        }
      }
      if (flushFailureSessions.has(sessionId) && flushSummarySeen.has(sessionId)) {
        flushFailureSessions.delete(sessionId)
        flushSummarySeen.delete(sessionId)
        record('lifecycle-flush-failure-hit', { sessionId })
        throw new Error('m4-c1-host-work: injected official Session flush failure')
      }
      return await originalFlush.apply(this, args)
    }
    sessions.flush = lifecycleFlush
    ctx.effect(() => () => {
      const restored = sessions.flush === originalFlush
      if (!restored) sessions.flush = originalFlush
      record('lifecycle-flush-restored', { restored })
    }, 'lifecycle-flush-restore')
    const runAction = async action => {
      const agent = action.sessionId === undefined ? undefined : ctx.agents.get(action.sessionId)
      if (action.action === 'arm-flush-failure') {
        flushFailureSessions.add(String(action.sessionId))
        flushSummarySeen.delete(String(action.sessionId))
        record('lifecycle-flush-failure-armed', { sessionId: action.sessionId })
        return
      }
      if (action.action === 'arm-kill-after-summary') {
        killAfterSummarySession = String(action.sessionId)
        record('lifecycle-kill-after-summary-armed', { sessionId: action.sessionId })
        return
      }
      if (action.action === 'arm-hold-flush') {
        flushHoldSessions.set(String(action.sessionId), String(action.release))
        record('lifecycle-flush-hold-armed', { sessionId: action.sessionId })
        return
      }
      if (action.action === 'arm-end-failure') {
        const target = String(action.sessionId)
        const session = agent.session
        const originalAppend = session.append
        session.append = function lifecycleAppend(...args) {
          if (String(this?.id ?? target) === target && args[0] === 'compaction/end') {
            record('lifecycle-end-failure-hit', { sessionId: target })
            throw new Error('m4-c1-host-work: injected compaction/end failure')
          }
          return originalAppend.apply(this, args)
        }
        ctx.effect(() => () => { if (session.append !== lifecycleAppend) session.append = originalAppend }, 'lifecycle-end-failure-restore')
        record('lifecycle-end-failure-armed', { sessionId: action.sessionId })
        return
      }
      if (agent === undefined) {
        record('lifecycle-action-no-agent', { action: action.action, sessionId: action.sessionId })
        return
      }
      if (action.action === 'flush-now') {
        await ctx.sessions.flush(agent.session)
        record('lifecycle-flush-complete', { sessionId: action.sessionId })
        return
      }
      if (action.action === 'cancel') {
        agent.cancel({ kind: 'user' })
        record('lifecycle-agent-cancelled', { sessionId: action.sessionId })
        return
      }
      if (action.action === 'dispose') {
        // DSH defines disposal as a disposed-cause cancel followed by fiber
        // quiescence; both are official Agent/Fiber capabilities.
        agent.cancel({ kind: 'disposed' }, { keepInbox: true })
        await agent.ctx.fiber.dispose()
        record('lifecycle-agent-disposed', { sessionId: action.sessionId })
        return
      }
      throw new Error(`m4-c1-host-work: unknown lifecycle action ${String(action.action)}`)
    }
    ctx.effect(() => {
      const timer = setInterval(() => {
        let names
        try {
          names = readdirSync(lifecycleControl)
        } catch {
          return
        }
        for (const name of names) {
          if (!name.endsWith('.json') || actions.has(name)) continue
          actions.add(name)
          try {
            const action = JSON.parse(readFileSync(join(lifecycleControl, name), 'utf8'))
            void runAction(action).catch(error => record('lifecycle-action-failed', {
              action: String(action?.action),
              message: error instanceof Error ? error.message : String(error),
            }))
          } catch (error) {
            record('lifecycle-action-unreadable', { name, message: error instanceof Error ? error.message : String(error) })
          }
        }
      }, 25)
      return () => clearInterval(timer)
    }, 'lifecycle-control-poll')
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      const sessionId = String(session.id)
      if (event?.type === 'compaction/start') flushSummarySeen.delete(sessionId)
      if (event?.type === 'compaction/summary') flushSummarySeen.add(sessionId)
      if (killAfterSummarySession !== sessionId || event?.type !== 'compaction/summary') return
      killAfterSummarySession = undefined
      record('lifecycle-kill-after-summary', {
        sessionId,
        compactionId: String(event.data?.compactionId ?? ''),
      })
      process.kill(process.pid, 'SIGKILL')
    }), 'lifecycle-kill-after-summary')
  }
  // PO-3B never negative: set the OFFICIAL durable approval policy of one
  // Session through the official service (the same seam the F8 case proves).
  const neverSetup = scenario === 'acp-po3b'
    ? async sessionId => {
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) throw new Error('m4-c1-host-work: po3b-never-setup requires the live Agent')
        const approval = ctx.reflect.get('approval')
        if (approval === undefined) throw new Error('m4-c1-host-work: po3b-never-setup requires the official ctx.approval service')
        const official = await import('@deepseek-ai/dsh-user-approval')
        official.setApprovalPolicy(agent.session, 'never')
      }
    : undefined
  if (scenario === 'acp-po4a') {
    ctx.effect(() => ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      if (agent === undefined || message?.source?.kind !== 'user') return
      record('po4a-inbox-discarded', {
        sessionId: String(agent.id),
        messageId: String(message.id),
        rpcId: String(message.source.rpcId ?? ''),
      })
    }), 'po4a-discarded-observer')
  }

  const imageProbe = scenario === 'acp-po4a'
    ? async sessionId => {
        const probeDir = process.env.C1_PO4A_IMAGE_PROBE_DIR
        if (probeDir === undefined || probeDir === '') return
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) throw new Error('m4-c1-host-work: PO-4A image probe could not resolve the live Agent')
        const events = agent.session.snapshotEvents()
        const message = [...events].reverse().find(event => event.type === 'user/message')?.data
        const image = message?.content?.find(part => part?.type === 'image')
        if (image === undefined) return
        if (image.attachment === undefined) throw new Error('m4-c1-host-work: PO-4A image probe found no durable image reference')
        const stored = await ctx.attachments.readImage(image.attachment)
        const digest = createHash('sha256').update(stored.data).digest('hex')
        if (stored.ref.attachmentId !== `sha256:${digest}` || stored.ref.bytes !== stored.data.byteLength) {
          throw new Error('m4-c1-host-work: PO-4A readImage bytes did not match their durable reference')
        }
        const expected = process.env.C1_PO4A_EXPECTED_IMAGE_SHA256
        if (expected !== undefined && expected !== '' && expected !== digest) {
          throw new Error('m4-c1-host-work: PO-4A image digest did not match the expected input')
        }
        appendFileSync(join(probeDir, 'image-probe.jsonl'), `${JSON.stringify({
          sessionId,
          attachmentId: stored.ref.attachmentId,
          mediaType: stored.ref.mediaType,
          bytes: stored.ref.bytes,
          sha256: digest,
          success: true,
        })}\n`, { mode: 0o600 })
      }
    : undefined

  const markdownFileProbe = scenario === 'acp-po4a'
    ? async sessionId => {
        // The Host Workspace authority is the official committed directory of
        // the exact live Agent; neither the Client cwd nor the marker text is a
        // file root.
        const expected = process.env.C1_PO4B_EXPECTED_WORKSPACE
        if (expected === undefined || expected === '') {
          throw new Error('m4-c1-host-work: the PO-4B file probe requires C1_PO4B_EXPECTED_WORKSPACE')
        }
        if (process.platform !== 'linux' || process.geteuid() === 0) {
          throw new Error(`m4-c1-host-work: the PO-4B permission proof requires a non-root Linux Host (platform=${process.platform}, euid=${String(process.geteuid())})`)
        }
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) throw new Error('m4-c1-host-work: the PO-4B file probe could not resolve the live Agent')
        const workspace = realpathSync(ctx.workingDirectory.get(agent.session))
        if (workspace !== realpathSync(expected)) {
          throw new Error('m4-c1-host-work: the official Session workingDirectory does not match the expected Host workspace')
        }
        const root = join(workspace, '.po4b')
        mkdirSync(root, { recursive: true, mode: 0o700 })
        const reportPath = join(root, 'report.md')
        writeFileSync(reportPath, PO4B_REPORT, { mode: 0o600 })
        const report = readFileSync(reportPath)
        if (report.toString('utf8') !== PO4B_REPORT) {
          throw new Error('m4-c1-host-work: the PO-4B report file did not read back its exact bytes')
        }
        const reportSha256 = createHash('sha256').update(report).digest('hex')
        let missing
        try {
          readFileSync(join(root, 'missing.md'))
          missing = 'READ'
        } catch (error) {
          missing = error?.code
        }
        if (missing !== 'ENOENT') throw new Error(`m4-c1-host-work: the PO-4B absent file read must fail with ENOENT (got ${String(missing)})`)
        const privatePath = join(root, 'private.md')
        writeFileSync(privatePath, PO4B_PRIVATE, { mode: 0o600 })
        chmodSync(privatePath, 0o000)
        let unreadable
        try {
          readFileSync(privatePath)
          unreadable = 'READ'
        } catch (error) {
          unreadable = error?.code
        }
        if (unreadable !== 'EACCES') throw new Error(`m4-c1-host-work: the PO-4B unreadable file read must fail with EACCES (got ${String(unreadable)})`)
        record('po4b-host-file-proof', { sessionId, workspaceMatched: true, reportSha256, missing, unreadable })
      }
    : undefined

  const po4c = scenario === 'acp-po4c'
    ? await createPo4cOutputProbe(ctx, record)
    : undefined

  const watchSession = process.env.C1_WATCH_SESSION
  const probeRegistry = watchSession === undefined || watchSession === ''
    ? undefined
    : ({ phase, sessionId }) => {
      // Global live counts come from the official registries' own `list()`; the
      // call's OWN session is the known-live positive control, so a probe that
      // always reports false cannot pass.
      const sessionIds = ctx.get('sessions')?.list().map(session => session.id) ?? []
      const agentIds = ctx.get('agents')?.list().map(agent => agent.id) ?? []
      return {
        phase,
        watched: watchSession,
        watchedSessionLive: sessionIds.includes(watchSession),
        watchedAgentLive: agentIds.includes(watchSession),
        sessionCount: sessionIds.length,
        agentCount: agentIds.length,
        selfSessionLive: sessionIds.includes(sessionId),
        selfAgentLive: agentIds.includes(sessionId),
      }
    }
  // PR1: one REAL bare-command spawn through the official `ctx.subprocess`
  // service. It is the same provider `dsh-tool-bash` uses; this fixture never
  // substitutes the executor or its credential/PATH scrub.
  const subprocessProbe = scenario === 'host-default-environment'
    ? async sessionId => {
        const subprocess = ctx.get('subprocess')
        if (subprocess === undefined) throw new Error('m4-c1-host-work: the official ctx.subprocess service is unavailable')
        const handle = subprocess.spawn({
          argv: ['dsh-pr1-user-probe'],
          cwd: root,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
          graceMs: 10_000,
        })
        const outcome = await handle.done
        const stdout = handle.collected.stdout === undefined ? '' : handle.collected.stdout.readFrom(0).text
        const stderr = handle.collected.stderr === undefined ? '' : handle.collected.stderr.readFrom(0).text
        record('subprocess-probe', { sessionId, exitCode: outcome.exitCode, signal: outcome.signal, stdout, stderr })
      }
    : undefined
  const model = new C1Model(scenario, proof, root, sessionId => {
    const agent = ctx.agents.get(sessionId)
    return agent === undefined ? undefined : agent.status
  }, neverSetup, imageProbe, markdownFileProbe, po4c, probeRegistry, subprocessProbe)

  ctx.effect(() => ctx.llm.registerAdapter(['c1-qualification'], model))

  if (scenario === 'acp-scoped-mcp-b0') {
    createScopedMcpB0Workload(ctx, { root, record })
  }

  if (scenario === 'acp-scoped-mcp-b1') {
    createScopedMcpB1Workload(ctx, { root, record })
  }

  if (scenario === 'acp-po4c') {
    ctx.effect(() => ctx.on('agent/error', payload => {
      record('po4c-agent-error', {
        turn: payload?.turn,
        step: payload?.step,
        name: payload?.error?.name,
        code: payload?.error?.code,
        message: String(payload?.error?.message ?? payload?.error).slice(0, 500),
      })
    }), 'po4c-agent-error-probe')
    // PO-4C late-read race: when the smoke arms this barrier, ONE read of the
    // mixed image is held and then completes even though the caller already
    // aborted (a real backend read can finish concurrently with an abort). The
    // View must drop those late bytes, never project them into a new View.
    const attachments = ctx.attachments
    const readImage = attachments.readImage
    attachments.readImage = async function (ref, signal) {
      const arm = process.env.C1_PO4C_READ_ARM
      if (typeof arm === 'string' && arm !== '' && existsSync(arm) && ref?.attachmentId === po4c.mixed.attachmentId) {
        record('po4c-read-held', { attachmentId: ref.attachmentId })
        await waitForBarrier(process.env.C1_PO4C_READ_RELEASE, new AbortController().signal)
        record('po4c-read-released', { attachmentId: ref.attachmentId })
        return await readImage.call(this, ref)
      }
      return await readImage.call(this, ref, signal)
    }
    // One real Host tool whose rendered model-facing content is the ordered
    // [text, verified image, text] batch the Host commits to `tool/result`.
    ctx.effect(() => ctx.tools.register(defineTool({
      name: PO4C_TOOL_NAME,
      description: 'PO-4C qualification tool emitting one ordered text/image/text result batch.',
      parameters: {
        // Optional by omission: the parameter DSL only annotates `required: true`.
        fail: { type: 'boolean', description: 'Throw instead of returning the ordered content.' },
        twoImages: { type: 'boolean', description: 'Return TWO independently stored images instead of the ordered text/image/text batch.' },
      },
      output: {
        schema: { type: 'string' },
        render: args => (args?.twoImages === true
          ? [
            { type: 'image', attachment: po4c.mixed },
            { type: 'image', attachment: po4c.tool },
          ]
          : [
            { type: 'text', text: PO4C_A2UI_TEXT },
            { type: 'image', attachment: po4c.tool },
            { type: 'text', text: PO4C_TOOL_TAIL },
          ]),
      },
      async execute(args, exec) {
        record('po4c-tool-executed', {
          callId: String(exec.callId),
          sessionId: exec.agent === undefined ? undefined : String(exec.agent.id),
          failing: args?.fail === true,
        })
        if (args?.fail === true) throw new Error('po4c tool failure')
        return 'po4c-tool-ok'
      },
    })))
  }

  if (scenario === 'mcp-servers-fr3' || scenario === 'mcp-servers-fr4') {
    // FR3: one PLUGIN-OWNED server contributed for this Host row's lifetime.
    // It has no settings entry, so the management surface must classify it
    // Plugin-owned (never Configured) while it is registered.
    const inline = [
      "import { createInterface } from 'node:readline'",
      "const send = payload => process.stdout.write(JSON.stringify(payload) + '\\n')",
      "createInterface({ input: process.stdin }).on('line', line => {",
      "  let m; try { m = JSON.parse(line) } catch { return }",
      "  if (m.id === undefined) return",
      "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fr3-plugin', version: '1.0.0' } } })",
      "  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [] } })",
      "  else if (m.method === 'ping') send({ jsonrpc: '2.0', id: m.id, result: {} })",
      "  else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } })",
      "})",
    ].join('\n')
    const pluginName = scenario === 'mcp-servers-fr4' ? 'fr4-plugin' : 'fr3-plugin'
    const releaseRegistration = ctx.effect(() => ctx.mcpManager.register(pluginName, {
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', inline],
    }), `${pluginName} plugin-owned MCP server`)
    // The scene triggers a clean revocation through a file, proving the
    // unregister path removes the entry (no retained cleanup record).
    ctx.effect(() => {
      const trigger = process.env.C1_FR3_UNREGISTER
      if (trigger === undefined || trigger === '') return
      const timer = setInterval(() => {
        if (!existsSync(trigger)) return
        clearInterval(timer)
        releaseRegistration()
      }, 50)
      return () => clearInterval(timer)
    }, 'fr3 plugin revocation trigger')
  }

  // PO-3B qualification only: the OFFICIAL `agent/inbox/discarded` notice is
  // the documented way to learn WHICH message an ordinary inbox removal
  // dropped (the durable splice carries only coordinates/counts). Recording it
  // lets the L6 case bind the scoped cancellation to its exact message id.
  if (scenario === 'acp-po3b') {
    ctx.effect(() => ctx.on('agent/inbox/discarded', ({ message }) => {
      record('po3b-inbox-discarded', {
        messageId: message?.id === undefined ? undefined : String(message.id),
        text: (message?.content ?? [])
          .map(part => (typeof part?.text === 'string' ? part.text : ''))
          .join('')
          .slice(0, 200),
      })
    }), 'po3b-discarded-observer')
  }

  // M6-1 F6 qualification fault: an EMPTY official provider that reports an
  // INCOMPLETE observation while the control file exists. The real filesystem
  // provider keeps contributing its candidates, so the catalog can prove
  // "incomplete must not replace the same-target last-good, then a complete
  // observation recovers".
  const skillsFaultDir = process.env.C1_SKILLS_FAULT_DIR
  if (skillsFaultDir !== undefined && skillsFaultDir !== '') {
    ctx.skills.registerProvider(() => ({
      name: 'c1-skills-fault',
      list: async () => {
        const readsPath = join(skillsFaultDir, 'fault-reads.jsonl')
        const record = (phase, incomplete) => appendFileSync(readsPath,
          `${JSON.stringify({ phase, incomplete, time: Date.now() })}\n`, { mode: 0o600 })
        const incomplete = existsSync(join(skillsFaultDir, 'incomplete'))
        record('start', incomplete)
        // A qualification-only HELD read: the smoke observes the painted
        // target-change state while this discovery is provably in flight,
        // then releases it explicitly. Production timing is untouched.
        if (existsSync(join(skillsFaultDir, 'slow'))) {
          const release = join(skillsFaultDir, 'release-slow')
          while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 20))
        }
        record('end', incomplete)
        return incomplete ? { candidates: [], complete: false } : { candidates: [], complete: true }
      },
      get: async () => undefined,
    }))
  }

  if (scenario === 'web-settings-f3') {
    // Seed the OFFICIAL rc.2 Web settings baseline with KNOWN values through
    // the real `ctx.settings` (SettingsForms) write path, and plant a
    // NON-FUNCTIONAL unique credential sentinel through the official
    // `ctx.credentials.set` path. Nothing here is a product input; the case
    // supplies the sentinel and the Search API override URL through its own
    // environment and later proves neither the sentinel nor a Client guess
    // reached any observable surface.
    //
    // rc.2 schema ONLY: the retired single-endpoint keys `baseURL`, `apiKeyEnv`
    // and `apiKey` are NEVER written (they no longer control Search/Fetch).
    // The initial section has NO advanced override: both Billing rows are
    // writable through the real TUI. AFTER those CAS phases the smoke asks this
    // fixture (one file-triggered official `ctx.settings.mutate`, never the
    // TUI) to set `searchBaseURL`, so the Search API override becomes a
    // read-only Host YAML fact that owns Search Billing while Fetch Billing
    // stays independently writable, and later clears it again so the shared
    // lane's profile is left without a fabricated endpoint.
    // The writes are FULLY DEFERRED (loader settled, own detached task): a
    // settings write from inside apply() would deadlock the plugin-row startup
    // the same way the f1-shell row reads settings only from event callbacks.
    const seedBaseURL = process.env.C1_F3_BASE_URL
    const sentinel = process.env.C1_F3_SECRET
    if (seedBaseURL === undefined || seedBaseURL === '' || sentinel === undefined || sentinel === '') {
      throw new Error('m4-c1-host-work: web-settings-f3 requires C1_F3_BASE_URL and C1_F3_SECRET')
    }
    const apiNamespace = 'web-deepseek-api'
    const webNamespace = 'web'
    const plainValue = descriptor => descriptor?.value !== null && typeof descriptor?.value === 'object'
      ? descriptor.value
      : undefined
    const apiFactsOf = value => value === null || typeof value !== 'object'
      ? undefined
      : {
          count: value.count,
          sendOriginalQuestion: value.sendOriginalQuestion,
          searchBilling: value.searchBilling,
          fetchBilling: value.fetchBilling,
          searchBaseURL: value.searchBaseURL,
          fetchBaseURL: value.fetchBaseURL,
          // Proof that the rc.2 seed/override wrote NONE of the retired keys.
          legacyKeys: ['baseURL', 'apiKeyEnv', 'apiKey'].filter(field => value[field] !== undefined),
        }
    void (async () => {
      try {
        await new Promise(resolve => ctx.root.loader.await().then(resolve, resolve))
        // Both Billing rows need their API provider selected: only the
        // Search/Fetch API consumes a billing mode.
        await ctx.settings.mutate(webNamespace, [
          { op: 'set', path: ['searchProvider'], value: 'deepseek-search-api' },
          { op: 'set', path: ['fetchProvider'], value: 'deepseek-fetch-api' },
        ])
        await ctx.settings.mutate(apiNamespace, [
          // Start from a KNOWN no-override state even if an earlier run of this
          // case left the YAML-only override in the shared isolated profile.
          { op: 'unset', path: ['searchBaseURL'] },
          { op: 'unset', path: ['fetchBaseURL'] },
          { op: 'set', path: ['count'], value: 10 },
          { op: 'set', path: ['sendOriginalQuestion'], value: false },
          { op: 'set', path: ['searchBilling'], value: 'auto' },
          { op: 'set', path: ['fetchBilling'], value: 'auto' },
        ])
        // The late-override control: ONE qualification-only file trigger; the
        // Host applies the rc.2 YAML field through the official Settings
        // mutation (never a hand edit, never a TUI write) and records the
        // resulting effective facts so the smoke can assert the true values.
        const overrideRequestPath = join(root, 'f3-search-override-request.json')
        let overrideBusy = false
        const applySearchOverride = async request => {
          await ctx.settings.mutate(apiNamespace, [request.op === 'set'
            ? { op: 'set', path: ['searchBaseURL'], value: seedBaseURL }
            : { op: 'unset', path: ['searchBaseURL'] }])
          const descriptor = ctx.settings.describe().find(entry => entry.ns === apiNamespace)
          record('f3-search-override', {
            nonce: request.nonce,
            op: request.op,
            api: apiFactsOf(plainValue(descriptor)),
            revision: descriptor?.revision,
          })
        }
        const overrideTimer = setInterval(() => {
          if (overrideBusy || !existsSync(overrideRequestPath)) return
          overrideBusy = true
          let request
          try {
            request = JSON.parse(readFileSync(overrideRequestPath, 'utf8'))
          } catch (error) {
            rmSync(overrideRequestPath, { force: true })
            overrideBusy = false
            record('f3-search-override-failed', {
              message: error instanceof Error ? error.message : String(error),
            })
            return
          }
          // Consume the request BEFORE the write: one request means one
          // mutation, and a repeated poll can never apply it twice.
          rmSync(overrideRequestPath, { force: true })
          void applySearchOverride(request)
            .catch(error => record('f3-search-override-failed', {
              nonce: request?.nonce,
              message: error instanceof Error ? error.message : String(error),
            }))
            .finally(() => { overrideBusy = false })
        }, 40)
        ctx.effect(() => () => clearInterval(overrideTimer))
        // The A5 negative matrix: the smoke asks the REAL Host to move the
        // search provider to AUTOMATIC (unset), a CUSTOM id, or an explicit
        // official id through ONE official Settings mutation, so the inert
        // Billing row's zero-write evidence runs on the real Host path.
        // F8: a TEST-ONLY counter at the REAL SettingsForms mutation ingress.
        // The Settings revision only moves when serialized row state changes,
        // so a rejected/same-value call is invisible there; counting the
        // ingress itself is what proves ZERO Billing mutation calls.
        const mutationCounts = {}
        // The op KIND and path per ingress: `set` and `unset` on the same field
        // are different official operations, so the reset evidence cannot be
        // inferred from a field-count / revision alone.
        const mutationOps = []
        const settingsService = ctx.settings
        const originalMutate = settingsService.mutate
        settingsService.mutate = async function countedMutate(namespace, ops, expected) {
          const fields = Array.isArray(ops)
            ? ops.map(op => Array.isArray(op?.path) ? op.path.join('.') : '').join(',')
            : ''
          mutationCounts[namespace] = (mutationCounts[namespace] ?? 0) + 1
          mutationCounts[`${namespace}:${fields}`] = (mutationCounts[`${namespace}:${fields}`] ?? 0) + 1
          mutationOps.push({
            namespace,
            ops: Array.isArray(ops)
              ? ops.map(op => ({
                  op: op?.op,
                  path: Array.isArray(op?.path) ? op.path.map(String) : [],
                }))
              : [],
          })
          return originalMutate.call(this, namespace, ops, expected)
        }
        const webRequestPath = join(root, 'f3-web-provider-request.json')
        let webRequestBusy = false
        const applyWebProvider = async request => {
          // `observe` is the AUTHORITATIVE zero-mutation probe: it never calls
          // the official setter, and reports the namespace revision the smoke
          // compares across an inert Enter.
          if (request.mode !== 'observe') {
            await ctx.settings.mutate(webNamespace, [request.mode === 'automatic'
              ? { op: 'unset', path: ['searchProvider'] }
              : { op: 'set', path: ['searchProvider'], value: String(request.value) }])
          }
          const descriptors = ctx.settings.describe()
          const descriptor = descriptors.find(entry => entry.ns === webNamespace)
          const apiDescriptor = descriptors.find(entry => entry.ns === apiNamespace)
          const value = plainValue(descriptor)
          record('f3-web-provider', {
            nonce: request.nonce,
            mode: request.mode,
            searchProvider: value?.searchProvider,
            fetchProvider: value?.fetchProvider,
            // The Billing setters write `web-deepseek-api.searchBilling`, so the
            // A5 zero-mutation observation must watch THAT namespace's revision
            // (the `web` revision only tracks provider changes).
            revision: descriptor?.revision,
            apiRevision: apiDescriptor?.revision,
            mutationCounts: { ...mutationCounts },
            mutationOps: mutationOps.map(entry => ({ namespace: entry.namespace, ops: entry.ops.map(op => ({ ...op, path: [...op.path] })) })),
          })
        }
        const webRequestTimer = setInterval(() => {
          if (webRequestBusy || !existsSync(webRequestPath)) return
          webRequestBusy = true
          let request
          try {
            request = JSON.parse(readFileSync(webRequestPath, 'utf8'))
          } catch (error) {
            rmSync(webRequestPath, { force: true })
            webRequestBusy = false
            record('f3-web-provider-failed', {
              message: error instanceof Error ? error.message : String(error),
            })
            return
          }
          rmSync(webRequestPath, { force: true })
          void applyWebProvider(request)
            .catch(error => record('f3-web-provider-failed', {
              nonce: request?.nonce,
              message: error instanceof Error ? error.message : String(error),
            }))
            .finally(() => { webRequestBusy = false })
        }, 40)
        ctx.effect(() => () => clearInterval(webRequestTimer))
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
        const ref = credentialRef('DEEPSEEK_API_KEY')
        // The sentinel reference is fixture state on the shared lane's ONE
        // dshHome: snapshot the prior reference value and restore the exact
        // pre-case state at row disposal (same lifecycle as the f7a/f7b record
        // seeds) so no later case inherits the sentinel.
        const previous = await ctx.credentials.resolve(ref)
        await ctx.credentials.set(ref, sentinel)
        ctx.effect(() => async () => {
          if (previous === undefined) await ctx.credentials.unset(ref)
          else await ctx.credentials.set(ref, previous.value)
          record('f3-credential-restored', { hadPrevious: previous !== undefined })
        }, 'f3-credential-restorer')
        const descriptors = ctx.settings.describe()
        const revisions = Object.fromEntries(descriptors.map(descriptor => [descriptor.ns, descriptor.revision]))
        const apiValue = plainValue(descriptors.find(descriptor => descriptor.ns === apiNamespace))
        const webValue = plainValue(descriptors.find(descriptor => descriptor.ns === webNamespace))
        const web = webValue === undefined
          ? undefined
          : {
              searchProvider: webValue.searchProvider,
              fetchProvider: webValue.fetchProvider,
            }
        // The sentinel VALUE never enters the proof: only its bounded digest proves
        // which value the store holds.
        const sentinelDigest = createHash('sha256').update(sentinel).digest('hex').slice(0, 16)
        record('f3-host-seed', {
          namespace: apiNamespace,
          api: apiFactsOf(apiValue),
          web,
          revisions,
          credentialReference: 'DEEPSEEK_API_KEY',
          sentinelDigest,
        })
      } catch (error) {
        record('f3-host-seed-failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  if (scenario === 'f1-shell') {
    const sessionId = process.env.C1_F1_SESSION_ID
    const cwd = process.env.C1_F1_SESSION_CWD
    const otherSessionId = process.env.C1_F1_OTHER_SESSION_ID
    if (sessionId === undefined || cwd === undefined) {
      throw new Error('m4-c1-host-work: f1-shell requires its isolated Session id and Host cwd')
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: 'c1-qualification', model: 'c1' },
    })
    ctx.effect(() => () => handle.dispose())
    record('f1-host-session-created', {
      sessionId: String(handle.agent.id),
      cwd: ctx.workingDirectory.get(handle.agent.session),
    })
    if (otherSessionId !== undefined) {
      const otherHandle = await ctx.agents.create({
        sessionId: SessionId(otherSessionId),
        meta: { cwd },
        agentOptions: { provider: 'c1-qualification', model: 'c1' },
      })
      ctx.effect(() => () => otherHandle.dispose())
      record('f1-host-other-session-created', {
        sessionId: String(otherHandle.agent.id),
        cwd: ctx.workingDirectory.get(otherHandle.agent.session),
      })
    }
  }

  if (scenario === 'command-file-receipt') {
    const sessionId = process.env.C1_CFR_SESSION_ID
    const cwd = process.env.C1_CFR_SESSION_CWD
    if (sessionId === undefined || sessionId === '' || cwd === undefined || cwd === '') {
      throw new Error('m4-c1-host-work: command-file-receipt requires its isolated Session id and Host cwd')
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: 'c1-qualification', model: 'c1' },
    })
    ctx.effect(() => () => handle.dispose())
    record('cfr-host-session-created', {
      sessionId: String(handle.agent.id),
      cwd: ctx.workingDirectory.get(handle.agent.session),
    })
    // Describe ONE admitted durable block in the exact submission order. A
    // FILE is read through the official Host attachment authority (the SAME
    // `readFileStream` the F4 probe uses); an IMAGE records its admitted
    // durable metadata only.
    const describeBlock = async (block, order) => {
      if (block?.type === 'file' && block.attachment?.attachmentId !== undefined) {
        const digest = createHash('sha256')
        let bytes = 0
        let chunks = 0
        for await (const chunk of ctx.attachments.readFileStream(block.attachment)) {
          bytes += chunk.byteLength
          chunks += 1
          digest.update(chunk)
        }
        return {
          order,
          type: 'file',
          attachmentId: block.attachment.attachmentId,
          name: block.attachment.name,
          refBytes: block.attachment.bytes,
          bytes,
          chunks,
          sha256: digest.digest('hex'),
        }
      }
      if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
        return {
          order,
          type: 'image',
          attachmentId: block.attachment.attachmentId,
          mediaType: block.attachment.mediaType,
          width: block.attachment.width,
          height: block.attachment.height,
          bytes: block.attachment.bytes,
        }
      }
      return { order, type: typeof block?.type === 'string' ? block.type : 'unknown', unsupported: true }
    }
    const runInvocation = async (name, invocation) => {
      const attachments = []
      for (let index = 0; index < invocation.attachments.length; index += 1) {
        attachments.push(await describeBlock(invocation.attachments[index], index))
      }
      record('cfr-command-invocation', {
        command: name,
        sessionId: String(invocation.agent.id),
        commandId: String(invocation.commandId),
        args: invocation.rawInput,
        attachments,
      })
      if (attachments.some(entry => entry.unsupported === true)) {
        return { kind: 'error', text: 'unsupported command attachment' }
      }
      return { kind: 'success', text: 'file verified' }
    }
    // The test-only Host command declaration: `attachments: true` is the ONE
    // official declaration a real command FILE delivery requires. It is
    // registered only in this isolated C1 Host context, never the product
    // profile.
    ctx.effect(() => ctx.commands.register({
      name: 'files',
      description: 'C1 command FILE receipt proof',
      input: { hint: '<task>', attachments: true },
      handler: invocation => runInvocation('files', invocation),
    }))
    // The negative control: a genuine Host command that does NOT declare
    // attachment support. A FILE-bearing submission must be refused by the
    // composer and never reach this handler.
    ctx.effect(() => ctx.commands.register({
      name: 'no-files',
      description: 'C1 command without attachment support',
      input: { hint: '<task>' },
      handler: invocation => runInvocation('no-files', invocation),
    }))
  }

  if (scenario === 'f4-file') {
    const sessionId = process.env.C1_F4_SESSION_ID
    const cwd = process.env.C1_F4_SESSION_CWD
    if (sessionId === undefined || sessionId === '' || cwd === undefined || cwd === '') {
      throw new Error('m4-c1-host-work: f4-file requires its isolated Session id and Host cwd')
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: 'c1-qualification', model: 'c1' },
    })
    ctx.effect(() => () => handle.dispose())
    record('f4-host-session-created', {
      sessionId: String(handle.agent.id),
      cwd: ctx.workingDirectory.get(handle.agent.session),
    })
    // Test-only Host attachment probe. The smoke writes `{sessionId, marker}`
    // into its private C1 work root; this fixture resolves the EXACT Agent and
    // durable `user/message`, then reads the stored bytes through the official
    // Host `ctx.attachments.readFileStream` authority. It never accepts a path
    // or raw bytes from the smoke.
    const probeDir = process.env.C1_F4_PROBE_DIR
    if (probeDir !== undefined && probeDir !== '') {
      const seen = new Set()
      const fileBlockOf = content => Array.isArray(content)
        ? content.find(block => block?.type === 'file' && block.attachment?.attachmentId !== undefined)
        : undefined
      const imageBlockOf = content => Array.isArray(content)
        ? content.find(block => block?.type === 'image' && block.attachment?.attachmentId !== undefined)
        : undefined
      const textOfContent = content => Array.isArray(content)
        ? content.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('')
        : ''
      const runProbe = async request => {
        const marker = typeof request.marker === 'string' ? request.marker : undefined
        const requestedSession = typeof request.sessionId === 'string' ? request.sessionId : undefined
        if (marker === undefined || requestedSession === undefined) {
          record('f4-file-probe', { error: 'request-shape' })
          return
        }
        const agent = ctx.agents.get(SessionId(requestedSession))
        if (agent === undefined) {
          record('f4-file-probe', { marker, sessionId: requestedSession, error: 'no-exact-agent' })
          return
        }
        if (String(agent.id) !== requestedSession) {
          record('f4-file-probe', { marker, sessionId: requestedSession, error: 'agent-identity-mismatch', agentId: String(agent.id) })
          return
        }
        const event = agent.session.snapshotEvents().find(candidate => candidate.type === 'user/message'
          && textOfContent(candidate.data?.content).includes(marker)
          && (fileBlockOf(candidate.data?.content) !== undefined || imageBlockOf(candidate.data?.content) !== undefined))
        const fileRef = event === undefined ? undefined : fileBlockOf(event.data.content)?.attachment
        const imageRef = event === undefined ? undefined : imageBlockOf(event.data.content)?.attachment
        if (event === undefined || (fileRef === undefined && imageRef === undefined)) {
          record('f4-file-probe', { marker, sessionId: requestedSession, error: 'no-durable-file-message' })
          return
        }
        const attachments = ctx.get('attachments')
        if (imageRef !== undefined) {
          // The ONE official Host image authority: `readImage` verifies the
          // stored bytes against their durable reference. PNG signature and
          // pixel facts come from the Store's own stored facts, never from
          // the Client source.
          const stored = await attachments.readImage(imageRef)
          const digest = createHash('sha256').update(stored.data).digest('hex')
          record('f4-file-probe', {
            marker,
            sessionId: requestedSession,
            attachmentId: stored.ref.attachmentId,
            mediaType: stored.ref.mediaType,
            refBytes: stored.ref.bytes,
            bytes: stored.data.byteLength,
            width: stored.ref.width,
            height: stored.ref.height,
            sha256: digest,
            pngSignature: stored.data.length >= 8
              && stored.data[0] === 0x89 && stored.data[1] === 0x50 && stored.data[2] === 0x4e
              && stored.data[3] === 0x47 && stored.data[4] === 0x0d && stored.data[5] === 0x0a
              && stored.data[6] === 0x1a && stored.data[7] === 0x0a,
            chunks: 1,
          })
          return
        }
        const digest = createHash('sha256')
        let bytes = 0
        let chunks = 0
        for await (const chunk of attachments.readFileStream(fileRef)) {
          bytes += chunk.byteLength
          chunks += 1
          digest.update(chunk)
        }
        record('f4-file-probe', {
          marker,
          sessionId: requestedSession,
          attachmentId: fileRef.attachmentId,
          name: fileRef.name,
          refBytes: fileRef.bytes,
          bytes,
          chunks,
          sha256: digest.digest('hex'),
        })
      }
      const timer = setInterval(() => {
        let names
        try {
          names = readdirSync(probeDir)
        } catch {
          return
        }
        for (const name of names) {
          if (!name.endsWith('.json') || seen.has(name)) continue
          seen.add(name)
          let request
          try {
            request = JSON.parse(readFileSync(join(probeDir, name), 'utf8'))
          } catch (error) {
            record('f4-file-probe', { request: name, error: error instanceof Error ? error.message : String(error) })
            continue
          }
          runProbe(request).catch(error => {
            record('f4-file-probe', { marker: request?.marker, error: error instanceof Error ? error.message : String(error) })
          })
        }
      }, 20)
      ctx.effect(() => () => clearInterval(timer))
    }
  }

  // Real Agent status transitions are Host facts, not a boolean this fixture
  // invents. `agent/status` is the official runtime event; the durable
  // Session events remain the smoke's final authority.
  ctx.on('agent/status', payload => {
    const statusFields = {
      agentId: payload?.agent?.id === undefined ? undefined : String(payload.agent.id),
      agentStatus: payload?.status,
    }
    if (scenario === 'f1-shell') {
      const descriptors = ctx.settings.describe()
      const settingsNamespace = process.env.C1_F1_SETTINGS_NAMESPACE ?? 'tui-app'
      const tui = descriptors.find(descriptor => descriptor.ns === settingsNamespace)
      const value = tui?.value !== null && typeof tui?.value === 'object'
        ? tui.value.localShellSandbox
        : undefined
      record('f1-host-effective-shell-policy', {
        ...statusFields,
        settingsNamespaces: descriptors.map(descriptor => descriptor.ns),
        localShellSandbox: value,
      })
    }
    record('agent-status', statusFields)
  })

  // Job registry lifecycle facts. The proof carries the official job id,
  // owner, kind and the registry status; it never constructs a fake job.
  ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type === 'output') return
    let output
    if (event.type === 'settled' && event.job !== undefined) {
      try {
        const read = ctx.jobs.readAt(event.job.id, 0, event.job.owner)
        output = read.chunks.map(chunk => chunk.text).join('')
      } catch {
        output = undefined
      }
    }
    record('job-event', {
      event: event.type,
      jobId: event.job?.id,
      owner: event.job?.owner === undefined ? undefined : String(event.job.owner),
      jobKind: event.job?.kind,
      label: event.job?.label,
      status: event.job?.status,
      cause: event.type === 'settled' ? event.cause : undefined,
      output,
    })
  })

  ctx.on('subagent/start', info => {
    record('subagent-start', { runId: info?.runId, provider: info?.provider, childId: info?.id === undefined ? undefined : String(info.id), local: info?.local })
  })
  ctx.on('subagent/end', info => {
    record('subagent-end', {
      runId: info?.runId,
      provider: info?.provider,
      childId: info?.id === undefined ? undefined : String(info.id),
      local: info?.local,
      stopReason: info?.stopReason,
      lastAssistantMessage: info?.lastAssistantMessage,
    })
  })

  // FR8 team-board: after every durable `team/task` write, record the OFFICIAL
  // `agentTeam` projection of the owning Session. This is a test-only OBSERVER of
  // the real authority (the same projection the Client's Team page reads) — it
  // writes nothing and creates no second Team service.
  if (scenario === 'team-board') {
    const recordTeamProjection = (sessionId) => {
      const agent = ctx.agents.get(sessionId)
      // A Session that is already gone is an honest absence, not a failure: the
      // observer records nothing and the durable team/task event stays the write
      // authority. A LIVE Session with no readable projection THROWS — a
      // swallowed read error would let the case treat a broken read as a board.
      if (agent === undefined) return
      const state = ctx.get('sessionProjections').stateOf(agent.session, 'agentTeam')
      record('team-projection', {
        sessionId: String(sessionId),
        enabled: state.enabled,
        tasks: (state.tasks ?? []).map(task => ({
          id: task.id,
          revision: task.revision,
          subject: task.subject,
          status: task.status,
          ownerName: task.ownerName,
        })),
      })
    }
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (event?.type !== 'team/task' && event?.type !== 'team/mode') return
      recordTeamProjection(String(session.id))
    }), 'fr8-team-projection-observer')
  }

  // Observe the official Question/Approval waterfalls without claiming them:
  // each listener records the exact Host request/answer identity and then
  // delegates with `next()`, so the real C2 PiTui answerer remains the only
  // consumer. Durable `tool/call` / `tool/result` / `approval/asked` /
  // `approval/decided` events remain the final authority.
  let lastQuestionCallId
  const questionProjection = () => {
    try {
      const agent = ctx.agents.list().find(candidate => ctx.subagents.rootOf(candidate) === candidate)
      if (agent === undefined) return undefined
      const projections = ctx.get('sessionProjections')
      const state = projections?.stateOf(agent.session, 'userQuestions')
      return state?.questions?.active
    } catch {
      return undefined
    }
  }
  ctx.on('user-questions/request', async (request, next) => {
    const callId = request?.wait?.callId
    if (typeof callId === 'string') lastQuestionCallId = callId
    const sessionId = request?.agent?.id === undefined ? undefined : String(request.agent.id)
    record('question-request', {
      callId: callId === undefined ? undefined : String(callId),
      sessionId,
      timed: request?.wait?.timed === true,
      questions: request?.questions,
    })
    try {
      const answer = await next()
      record('question-settled', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        answers: answer?.answers,
      })
      record('question-projection', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        active: questionProjection(),
      })
      return answer
    } catch (error) {
      record('question-failed', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error
          ? String(error.stack ?? '').split('\n').slice(0, 12).join(' | ').slice(0, 2000)
          : undefined,
      })
      record('question-projection', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        active: questionProjection(),
      })
      // The projection settles asynchronously after the timed tool result is
      // written. Poll briefly for the official `continued` transition; this is
      // evidence capture only and never drives the Host flow.
      if (callId !== undefined) {
        const started = Date.now()
        const timer = setInterval(() => {
          const active = questionProjection()
          if (Array.isArray(active) && active.some(item => item?.callId === String(callId) && item?.state === 'continued')) {
            clearInterval(timer)
            record('question-projection', {
              callId: String(callId),
              sessionId,
              active,
              phase: 'continued',
            })
          } else if (Date.now() - started > 5_000) {
            clearInterval(timer)
          }
        }, 100)
      }
      throw error
    }
  }, { prepend: true })

  ctx.on('approval/request', async (request, next) => {
    const callId = request?.callId === undefined ? undefined : String(request.callId)
    record('approval-request', {
      toolName: request?.toolName,
      callId,
      sessionId: request?.agent?.id === undefined ? undefined : String(request.agent.id),
      reason: request?.reason,
    })
    try {
      const outcome = await next()
      record('approval-settled', { toolName: request?.toolName, callId, outcome })
      return outcome
    } catch (error) {
      record('approval-failed', { toolName: request?.toolName, callId, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }, { prepend: true })

  // Qualification-only Host Agent cancel trigger: the smoke writes the
  // barrier file, and the fixture calls the official Agent cancel. It never
  // writes an approval/question event itself.
  const cancelBarrier = process.env.C1_CANCEL_AGENT
  if (cancelBarrier !== undefined && cancelBarrier !== '') {
    const timer = setInterval(() => {
      if (!existsSync(cancelBarrier)) return
      clearInterval(timer)
      for (const agent of ctx.agents.list().filter(candidate => ctx.subagents.rootOf(candidate) === candidate)) {
        record('agent-cancel-requested', { agentId: String(agent.id) })
        agent.cancel({ kind: 'user' })
      }
    }, 20)
    ctx.effect(() => () => clearInterval(timer))
  }

  // Qualification-only Host-side continued-answer probe. It calls the
  // official `ctx.userQuestions.answer` service (the same authority behind the
  // Remote namespace) at a smoke-controlled barrier and records the exact
  // boolean/error taxonomy. It never writes a question event itself.
  for (const [envName, phase] of [
    ['C1_ANSWER_PROBE_DUPLICATE', 'duplicate'],
    ['C1_ANSWER_PROBE_EXPIRED', 'expired'],
  ]) {
    const probePath = process.env[envName]
    if (probePath === undefined || probePath === '') continue
    record('answer-probe-armed', { phase, probePath })
    const timer = setInterval(() => {
      if (!existsSync(probePath)) return
      clearInterval(timer)
      try {
        const agent = ctx.agents.list().find(candidate => ctx.subagents.rootOf(candidate) === candidate)
        const userQuestions = ctx.get('userQuestions')
        if (agent === undefined || userQuestions === undefined) {
          record('answer-probe', { phase, error: agent === undefined ? 'no-root-agent' : 'no-user-questions' })
          return
        }
        const call = userQuestions.continued(agent)[0]
        const callId = call?.callId ?? lastQuestionCallId
        if (callId === undefined) {
          record('answer-probe', { phase, error: 'no-call-id' })
          return
        }
        // Call the official Host answer service even when the Projection no
        // longer lists the call: the settled-call classification must come
        // from the service return, never from local projection absence.
        const value = userQuestions.answer(agent, callId, { answers: [{ id: 'c1-question', selected: ['Proceed'] }] })
        record('answer-probe', { phase, callId, value })
      } catch (error) {
        record('answer-probe', {
          phase,
          code: error?.code,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 20)
    ctx.effect(() => () => clearInterval(timer))
  }

  // M4-C2-A liveness scenarios: produce one official source fact only after
  // the first real turn, so the Agent is idle at the moment the fact exists.
  // Every step uses the official Host owner; the fixture only records.
  if (scenario === 'goal-armed' || scenario === 'goal-round' || scenario === 'maintenance' || scenario === 'schedule') {
    let sawRunning = false
    let armed = false
    const afterFirstTurn = (callback) => {
      ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'running') {
          sawRunning = true
          return
        }
        if (status !== 'idle' || !sawRunning || armed) return
        if (ctx.subagents.rootOf(agent) !== agent) return
        armed = true
        setTimeout(() => { callback(agent) }, 0)
      })
    }
    if (scenario === 'goal-armed' || scenario === 'goal-round') {
      // Every durable Goal transition is recorded as the official Host event,
      // never as a value this fixture invents. The armed case needs the proof
      // that nothing moved the Goal; the round case needs the automatic
      // `round-limit` block that ends the armed state.
      ctx.on('goal/changed', ({ agent, change }) => {
        record('goal-changed', {
          agentId: String(agent.id),
          goalId: String(change?.ref?.id ?? ''),
          revision: change?.goal?.revision ?? change?.ref?.revision,
          operation: change?.operation,
          goalPhase: change?.goal?.phase,
          activation: change?.goal?.activation,
          roundsStarted: change?.goal?.roundsStarted,
          blockCode: change?.goal?.blockedReason?.code,
        })
      })
      // The REAL goal-round-driver owns the automatic reservation; this
      // fixture only creates the governing Goal record through the service.
      ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        const source = message?.source
        if (source?.kind !== 'goal') return
        record('goal-round-observed', {
          agentId: String(agent.id),
          agentStatus: agent.status,
          goalId: String(source.goalId),
          revision: source.revision,
          round: source.round,
          inboxNextTurn: agent.inbox.nextTurn.length,
          inboxNextStep: agent.inbox.nextStep.length,
        })
      })
      afterFirstTurn(agent => {
        const goals = ctx.get('goals')
        if (goals === undefined) {
          record('goal', { phase: 'unavailable' })
          return
        }
        try {
          const view = goals.create(agent, { objective: 'M4-C2-A qualification goal', maxGoalRounds: 1 })
          record('goal-created', {
            agentId: String(agent.id),
            goalId: String(view.id),
            revision: view.revision,
            goalPhase: view.phase,
            activation: view.activation,
          })
        } catch (error) {
          record('goal-create-failed', {
            agentId: String(agent.id),
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    }
    if (scenario === 'maintenance') {
      afterFirstTurn(agent => {
        const release = join(root, 'maintenance.release')
        record('maintenance', { phase: 'before', agentId: String(agent.id), agentStatus: agent.status })
        agent.runMaintenance(async (signal) => {
          record('maintenance', { phase: 'running', agentId: String(agent.id), agentStatus: agent.status })
          while (!existsSync(release)) {
            if (signal?.aborted === true) throw signal.reason ?? new Error('m4-c1-host-work: maintenance aborted')
            await new Promise(resolveWait => setTimeout(resolveWait, 20))
          }
          record('maintenance', { phase: 'released', agentId: String(agent.id) })
          return 'released'
        }).then(
          () => { record('maintenance', { phase: 'settled', agentId: String(agent.id), agentStatus: agent.status }) },
          error => { record('maintenance', { phase: 'failed', agentId: String(agent.id), error: error instanceof Error ? error.message : String(error) }) },
        )
      })
    }
    if (scenario === 'schedule') {
      afterFirstTurn(agent => {
        const schedule = ctx.get('schedule')
        if (schedule === undefined) {
          record('schedule', { phase: 'unavailable' })
          return
        }
        // rc.1 Schedule API: `create(request, actorSessionId)` with a typed
        // `timing` selector, and `edit({ id, action: 'delete' }, actorSessionId)`
        // for removal. The old `create(sessionId, {...after_seconds})` /
        // `delete({sessionId,id})` shape no longer exists.
        schedule.create({
          prompt: 'M4-C2-A qualification schedule task',
          title: 'M4-C2-A qualification schedule task',
          timing: { kind: 'after', after_seconds: 600 },
        }, agent.id).then(view => {
          record('schedule-created', {
            agentId: String(agent.id),
            scheduleId: String(view.id),
            status: 'active',
          })
          const deleteBarrier = join(root, 'schedule.delete')
          const timer = setInterval(() => {
            if (!existsSync(deleteBarrier)) return
            clearInterval(timer)
            schedule.edit({ id: view.id, action: 'delete' }, agent.id).then(
              result => { record('schedule-deleted', { scheduleId: String(view.id), deleted: result.deleted, code: result.code }) },
              error => { record('schedule-delete-failed', { scheduleId: String(view.id), error: error instanceof Error ? error.message : String(error) }) },
            )
          }, 20)
          timer.unref?.()
          ctx.effect(() => () => clearInterval(timer))
        }, error => {
          record('schedule-create-failed', {
            agentId: String(agent.id),
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })
    }
  }

  // M4-C2-B B1: observe the one official Gateway eligibility fact rc.4 exposes.
  // `hasLiveClient()` reports whether ANY owner event stream is open; it never
  // identifies a request, so the proof below only records a boolean transition
  // and never infers a pending inventory or an expiry.
  const liveClientProbe = process.env.C1_HAS_LIVE_CLIENT_PROBE
  if (liveClientProbe !== undefined && liveClientProbe !== '') {
    const gateway = ctx.get('typertGateway')
    if (gateway === undefined) throw new Error('m4-c1-host-work: typertGateway is missing for the live-client probe')
    let last
    let sequence = 0
    const sample = () => {
      const value = gateway.hasLiveClient()
      if (value === last) return
      last = value
      sequence += 1
      record('has-live-client', { value, sequence })
    }
    sample()
    const timer = setInterval(sample, 20)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }

  // Negative control: a real in-process Peer that is not eligible to answer
  // forwarded events must not open `$events`, and must not make
  // `hasLiveClient()` true. Both services are official Host APIs; the fixture
  // only observes the refusal and records its stable code.
  const nonAnsweringProbe = process.env.C1_NON_ANSWERING_PEER_PROBE
  if (nonAnsweringProbe !== undefined && nonAnsweringProbe !== '') {
    const timer = setInterval(() => {
      if (!existsSync(nonAnsweringProbe)) return
      clearInterval(timer)
      const gateway = ctx.get('typertGateway')
      const connection = ctx.get('connection')
      if (gateway === undefined || connection === undefined) {
        record('non-answering-peer', { opened: false, code: 'service-unavailable' })
        return
      }
      const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
      gateway.wireStream.open('$events', { args: {} }, (async function* emptyUplink() {})(), peer, peer.signal).then(
        stream => {
          record('non-answering-peer', { opened: true, code: 'opened', liveClient: gateway.hasLiveClient() })
          stream[Symbol.asyncIterator]().return?.()
        },
        error => {
          record('non-answering-peer', { opened: false, code: error?.code ?? 'unknown', liveClient: gateway.hasLiveClient() })
        },
      ).finally(() => peer.dispose()).catch(error => {
        record('non-answering-peer-failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }, 20)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }

  // Host-liveness unowned-Job qualification: start one real DSH Job with no
  // Session owner and hold it until the smoke releases it. The observer must
  // see it through the unowned registry list and the official event stream.
  if (scenario === 'unowned-job') {
    const armBarrier = process.env.C1_UNOWNED_JOB_ARM
    if (armBarrier !== undefined && armBarrier !== '') {
      const timer = setInterval(() => {
        if (!existsSync(armBarrier)) return
        clearInterval(timer)
        try {
          // An unowned Job requires a global controller; the Host-only overlay
          // does not mount tool-jobs at the root, so this test fixture attaches
          // its own unscoped controller through the official registry seam.
          const detachController = ctx.jobs.attachController('c2a-unowned-job')
          ctx.effect(() => () => detachController())
          const id = ctx.jobs.start({
            kind: 'c2a-unowned',
            label: 'C2A unowned qualification job',
            run(handle) {
              record('unowned-job-created', { jobId: String(handle.id), status: 'running' })
              const release = join(root, 'unowned-job.release')
              let settle
              const done = new Promise(resolve => { settle = resolve })
              let settled = false
              let poll
              const finish = outcome => {
                if (settled) return
                settled = true
                if (poll !== undefined) clearInterval(poll)
                settle(outcome)
              }
              poll = setInterval(() => {
                if (!existsSync(release)) return
                record('unowned-job-released', { jobId: String(handle.id) })
                finish({ status: 'completed' })
              }, 20)
              poll.unref?.()
              ctx.effect(() => () => clearInterval(poll))
              return {
                cancel(reason) {
                  record('unowned-job-cancelled', { jobId: String(handle.id), reason })
                  finish({ status: 'killed', ...(reason === undefined ? {} : { detail: reason }) })
                },
                done,
              }
            },
          })
          record('unowned-job-armed', { jobId: String(id) })
        } catch (error) {
          record('unowned-job-start-failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }, 20)
      timer.unref?.()
      ctx.effect(() => () => clearInterval(timer))
    }
  }

  if (scenario === 'foreground-tool') {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'c1_foreground_tool',
      description: 'Hold one real Host tool call until the qualification barrier is released.',
      parameters: {
        token: { type: 'string', required: true, description: 'Opaque qualification token.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        record('tool-started', {
          callId: String(exec.callId),
          sessionId: exec.agent === undefined ? undefined : String(exec.agent.id),
          token: args.token,
        })
        await waitForBarrier(process.env.C1_HOLD_TOOL, exec.signal)
        record('tool-released', { callId: String(exec.callId) })
        return `c1-tool-result-${String(args.token)}`
      },
    })))
  }
  if (scenario === 'acp-po4a') {
    const attachments = ctx.attachments
    const saveImages = attachments.saveImages
    attachments.saveImages = async function (inputs) {
      const hold = process.env.C1_PO4A_ADMISSION_HOLD
      if (hold !== undefined && hold !== '' && existsSync(hold)) {
        rmSync(hold, { force: true })
        record('po4a-image-admission-held', { imageCount: inputs.length })
        await waitForBarrier(process.env.C1_PO4A_ADMISSION_RELEASE, new AbortController().signal)
        record('po4a-image-admission-released', { imageCount: inputs.length })
      }
      return await saveImages.call(this, inputs)
    }
  }

  if (scenario === 'f7a-authorization') {
    // F7A qualification flows. The official `ctx.authorization` seam owns the
    // attempt, the mutual exclusion and the credential write; this row only
    // provides the PROVIDER bodies (the plugin boundary the seam is designed
    // around). Every step records a proof line; a secret ANSWER is never
    // recorded, only the fact that the exact prompt was answered.
    const authorization = ctx.reflect.get('authorization')
    if (authorization === undefined || typeof authorization.registerFlow !== 'function') {
      throw new Error('m4-c1-host-work: f7a-authorization requires the official ctx.authorization service')
    }
    const barrier = name => join(root, name)
    const waitFor = async (name, signal) => {
      await waitForBarrier(barrier(name), signal)
    }
    const holdIfPresent = async (holdName, releaseName, phase, signal, run) => {
      if (!existsSync(barrier(holdName))) return
      record(`f7a-${phase}-held`, { run })
      await waitFor(releaseName, signal)
      record(`f7a-${phase}-released`, { run })
    }
    const answer = async (session, prompt) => {
      const value = await session.prompt(prompt)
      // The value may be a secret: record only the prompt kind, never the text.
      record('f7a-prompt-answered', { kind: prompt.kind, message: prompt.message })
      return value
    }
    let mainRunCount = 0
    const runMain = async session => {
      mainRunCount += 1
      const run = mainRunCount
      record('f7a-run-start', { key: 'llm-pi-ai/f7a-main', run, method: session.method })
      session.notify({ message: 'F7A sign-in', url: 'https://provider.example/f7a', code: 'F7A-CODE-1' })
      await holdIfPresent('f7a-hold-before-prompt', 'f7a-release-before-prompt', 'before-prompt', session.signal, run)
      if (existsSync(barrier('f7a-withdraw'))) {
        const controller = new AbortController()
        const losing = session.prompt({
          kind: 'text',
          message: 'F7A losing prompt',
          signal: controller.signal,
        }).then(
          () => 'answered',
          () => 'withdrawn',
        )
        // Retire the losing prompt of the race, exactly as a real flow does;
        // the prompt-level withdrawal must NOT cancel the whole attempt.
        setTimeout(() => controller.abort(), 50)
        const outcome = await losing
        record('f7a-withdrawn-prompt', { outcome, run })
        if (outcome !== 'withdrawn') throw new Error('m4-c1-host-work: the losing F7A prompt was not withdrawn')
        await answer(session, { kind: 'text', message: 'F7A winning prompt' })
      }
      await answer(session, { kind: 'secret', message: 'F7A secret code', placeholder: 'F7A-SECRET' })
      const label = await answer(session, { kind: 'text', message: 'F7A account label' })
      const choice = await answer(session, {
        kind: 'select',
        message: 'F7A choose account',
        options: [{ id: 'primary', label: 'Primary' }, { id: 'secondary', label: 'Secondary' }],
      })
      await session.commit({
        kind: 'grant',
        payload: { provider: 'f7a-main', label, choice },
      })
      record('f7a-committed', { key: 'llm-pi-ai/f7a-main', run })
      await holdIfPresent('f7a-hold-after-commit', 'f7a-release-after-commit', 'after-commit', session.signal, run)
      record('f7a-run-end', { key: 'llm-pi-ai/f7a-main', run })
    }
    const runOther = async session => {
      record('f7a-run-start', { key: 'llm-pi-ai/f7a-other', method: session.method })
      session.notify({ message: 'F7A other sign-in', url: 'https://provider.example/f7a-other' })
      await answer(session, { kind: 'secret', message: 'F7A other secret' })
      await session.commit({
        kind: 'grant',
        payload: { provider: 'f7a-other' },
      })
      record('f7a-committed', { key: 'llm-pi-ai/f7a-other' })
      record('f7a-run-end', { key: 'llm-pi-ai/f7a-other' })
    }
    const register = (id, label, run) => {
      ctx.effect(() => authorization.registerFlow({
        key: credentialKey('llm-pi-ai', id),
        label,
        methods: [{ id: 'device', label: 'Continue in the browser' }],
        async run(session) {
          try {
            await run(session)
          } catch (error) {
            record('f7a-run-failed', {
              key: `llm-pi-ai/${id}`,
              aborted: session.signal.aborted,
              code: typeof error?.code === 'string' ? error.code : undefined,
            })
            throw error
          }
        },
      }), `f7a-authorization-${id}`)
    }
    register('f7a-main', 'F7A main', runMain)
    register('f7a-other', 'F7A other', runOther)
    // The committed flow records are fixture products on the shared lane's ONE
    // dshHome: snapshot and restore them through the official store at row
    // disposal so no later case inherits them (same lifecycle as the F7B
    // seeds). The case asserts the restored listing after shutdown.
    const credentials = ctx.reflect.get('credentials')
    if (credentials === undefined || typeof credentials.modifyRecord !== 'function') {
      throw new Error('m4-c1-host-work: f7a-authorization requires the official ctx.credentials service')
    }
    const flowKeys = [credentialKey('llm-pi-ai', 'f7a-main'), credentialKey('llm-pi-ai', 'f7a-other')]
    const baselineKeys = (await credentials.listRecords()).map(entry => String(entry.key)).sort()
    const baseline = []
    for (const key of flowKeys) {
      baseline.push({ key, pre: await credentials.readRecord(key) })
    }
    record('f7a-flows-registered', { keys: ['llm-pi-ai/f7a-main', 'llm-pi-ai/f7a-other'], baselineKeys })
    ctx.effect(() => async () => {
      for (const { key, pre } of baseline) {
        if (pre === undefined) await credentials.deleteRecord(key)
        else await credentials.modifyRecord(key, async () => pre)
      }
      const restored = await credentials.listRecords()
      record('f7a-records-restored', {
        baselineKeys,
        keys: restored.map(entry => String(entry.key)).sort(),
      })
    }, 'f7a-records-restorer')
  }

  if (scenario === 'f7b-credential-records') {
    // F7B stored-record qualification. The OFFICIAL `ctx.credentials` store is
    // the only authority: every seed goes through its read-modify-write path,
    // the fixture never edits the YAML file and never mounts a second
    // credential service. Sentinels live in the record payloads only; a
    // qualification proof line records keys/kinds, never a value.
    const credentials = ctx.reflect.get('credentials')
    if (credentials === undefined || typeof credentials.modifyRecord !== 'function') {
      throw new Error('m4-c1-host-work: f7b-credential-records requires the official ctx.credentials service')
    }
    const seeds = [
      {
        key: credentialKey('llm-pi-ai', 'f7b-grant'),
        record: { kind: 'grant', payload: { token: 'f7b-grant-token-sentinel-20261112' } },
      },
      {
        key: credentialKey('llm-pi-ai', 'f7b-api-key'),
        record: {
          kind: 'api-key',
          key: 'f7b-api-key-value-sentinel-20261112',
          env: { F7B_ENV: 'f7b-env-value-sentinel-20261112' },
        },
      },
      {
        key: credentialKey('other-plugin', 'f7b-orphan'),
        record: { kind: 'grant', payload: { token: 'f7b-orphan-token-sentinel-20261112' } },
      },
      {
        // The DeepSeek Account grant: seeded so the smoke can prove the generic
        // records list EXCLUDES it while the Account page owns it.
        key: credentialKey('deepseek-account-platform', 'default'),
        record: { kind: 'grant', payload: { token: 'f7b-account-token-sentinel-20261112' } },
      },
    ]
    // The shared lane reuses ONE dshHome across cases: snapshot every seed key
    // BEFORE its write so disposal can restore the exact pre-case record state
    // through the SAME official authority (a pre-existing record is written
    // back, a fixture-only record is deleted). Every path that reaches a clean
    // Host shutdown — case success, assertion failure, exception — disposes
    // this row, and the restored listing is recorded so the case can assert a
    // zero record delta before the next case boots.
    const baselineKeys = (await credentials.listRecords()).map(entry => String(entry.key)).sort()
    const baseline = []
    for (const seed of seeds) {
      baseline.push({ key: seed.key, pre: await credentials.readRecord(seed.key) })
    }
    for (const seed of seeds) {
      await credentials.modifyRecord(seed.key, async () => seed.record)
    }
    const listed = await credentials.listRecords()
    record('f7b-records-seeded', {
      keys: listed.map(entry => String(entry.key)).sort(),
      kinds: listed.map(entry => `${String(entry.key)}:${entry.kind}`).sort(),
      baselineKeys,
    })
    // The REAL official record-updated event is the observable commit proof the
    // smoke waits for after a delete (one key, never a payload).
    ctx.effect(() => ctx.on('credentials/record-updated', (key) => {
      record('f7b-record-updated', { key: String(key) })
    }), 'f7b-record-updated-observer')
    ctx.effect(() => async () => {
      for (const { key, pre } of baseline) {
        if (pre === undefined) await credentials.deleteRecord(key)
        else await credentials.modifyRecord(key, async () => pre)
      }
      const restored = await credentials.listRecords()
      record('f7b-records-restored', {
        baselineKeys,
        keys: restored.map(entry => String(entry.key)).sort(),
      })
    }, 'f7b-records-restorer')
  }

  if (scenario === 'session-policy-f8' || scenario === 'session-policy-f8-replay') {
    // M6-1 F8 exact-Session policy qualification. The OFFICIAL `ctx.approval`
    // and `ctx.sandboxPolicy` services are the only policy authority: the
    // seeds and the replayed facts are computed from THEIR projections, never
    // from a TUI mirror. The fixture records policy VALUES only (no session
    // paths, no agent objects).
    const approval = ctx.reflect.get('approval')
    const sandboxPolicy = ctx.reflect.get('sandboxPolicy')
    if (approval === undefined || sandboxPolicy === undefined) {
      throw new Error('m4-c1-host-work: session-policy-f8 requires the official ctx.approval and ctx.sandboxPolicy services')
    }
    const sessionA = process.env.C1_F8_SESSION_A
    const sessionB = process.env.C1_F8_SESSION_B
    const cwd = process.env.C1_F8_CWD
    if (sessionA === undefined || sessionA === '' || cwd === undefined || cwd === '') {
      throw new Error('m4-c1-host-work: session-policy-f8 requires its isolated Session ids and Host cwd')
    }
    const factsOf = session => ({
      approvalOverride: approval.overrideOf(session) ?? null,
      approvalEffective: approval.overrideOf(session) ?? approval.config?.policy ?? 'ask',
      sandboxOverride: sandboxPolicy.overrideOf(session) ?? null,
      sandboxEffective: sandboxPolicy.resolve({ session }).mode,
    })
    if (scenario === 'session-policy-f8-replay') {
      // DURABLE REPLAY: a FRESH Host loads the persisted Session log through
      // the official registry and the projections re-derive the facts.
      const resumed = await ctx.agents.resume({
        resumeSessionId: SessionId(sessionA),
        agentOptions: { provider: 'c1-qualification', model: 'c1' },
      })
      ctx.effect(() => () => resumed.dispose())
      record('f8-replayed', {
        sessionId: String(resumed.agent.id),
        ...factsOf(resumed.agent.session),
      })
    } else {
      const officialApproval = await import('@deepseek-ai/dsh-user-approval')
      const officialSandbox = await import('@deepseek-ai/dsh-sandbox-policy')
      const handles = []
      for (const sessionId of [sessionA, sessionB]) {
        if (sessionId === undefined || sessionId === '') {
          throw new Error('m4-c1-host-work: session-policy-f8 requires BOTH isolated Session ids')
        }
        const handle = await ctx.agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd },
          agentOptions: { provider: 'c1-qualification', model: 'c1' },
        })
        ctx.effect(() => () => handle.dispose())
        handles.push(handle)
      }
      const [a, b] = handles
      // A keeps the deployment defaults (approval ask / sandbox default); B
      // carries an INDEPENDENT approval never and a workspace-write sandbox
      // override, written through the OFFICIAL durable event path.
      officialApproval.setApprovalPolicy(b.agent.session, 'never')
      officialSandbox.setSandboxMode(b.agent.session, 'workspace-write')
      // Observe the official durable knob events (type + policy/mode only).
      ctx.effect(() => ctx.on('session/event', (session, event) => {
        if (event?.type !== 'approval/policy' && event?.type !== 'sandbox/mode') return
        record('f8-knob-event', {
          sessionId: String(session.id),
          type: event.type,
          value: event.data?.policy ?? event.data?.mode ?? null,
        })
      }), 'f8-knob-observer')
      record('f8-seeded', {
        sessions: [
          { sessionId: String(a.agent.id), ...factsOf(a.agent.session) },
          { sessionId: String(b.agent.id), ...factsOf(b.agent.session) },
        ],
      })
    }
  }
}
