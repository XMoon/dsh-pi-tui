/**
 * TSP-7 PR-E real-client subject: the PRODUCTION Quiet Composer.
 *
 * Mounts the production `mountTspRenderer` over a real Tern pane and installs
 * the shipped status/footer/input seams. The subject supplies only the status
 * snapshot fixtures and a narrow permission-writer stand-in (declared in
 * `events.jsonl`): the real Host permission I/O is owned by the application
 * qualification lane.
 *
 * Cases (`case` file or TERN_TSP7_PRE_CASE):
 *   idle-empty | idle-draft | busy-empty | busy-draft | long-cjk |
 *   permission-open | permission-select | permission-stale | custom-footer
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { resolveTspNativeFooterConfig } from '../src/domain/footer/tsp-native-config.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
const caseFile = `${dir}/case`
const testCase = (existsSync(caseFile) ? readFileSync(caseFile, 'utf8').trim() : '')
  || process.env.TERN_TSP7_PRE_CASE || 'idle-empty'

const session = await connect({ app: 'quiet-composer-production', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
note({ caps: session.caps, case: testCase })

const STANDARD_ROSTER = ['read-only', 'workspace-write', 'danger-full-access'] as const
const LABELS: Record<string, string> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'danger-full-access': 'Full Access',
}
const calls = {
  submits: [] as string[],
  cancels: 0,
  modelEntries: [] as string[],
  selects: [] as string[],
}
let current = snapshotFor(testCase)

function snapshotFor(name: string): StatusSnapshot {
  const base = emptyStatusSnapshot()
  const busy = name.startsWith('busy')
  const draft = name === 'idle-draft' || name === 'busy-draft' || name === 'permission-open'
    || name === 'permission-select' || name === 'permission-stale' || name === 'custom-footer'
  const long = name === 'long-cjk'
  return {
    ...base,
    access: { permissionPreset: { id: 'workspace-write', label: 'Workspace Write', matched: true } },
    workspace: { cwd: '/workspaces/quiet-composer', branch: 'pre-evidence' },
    collaboration: { plan: { effective: true } },
    composition: {
      model: {
        provider: 'deepseek',
        id: long ? 'provider/very-long-deepseek-model-variant-with-reasoning' : 'deepseek-v4.1-flash',
        displayName: long ? 'provider/very-long-deepseek-model-variant-with-reasoning' : 'DeepSeek V4.1 Flash',
        reasoningEffort: 'high',
      },
    },
    activity: {
      ...base.activity,
      busy,
      phase: busy ? 'working' : 'idle',
      taskCount: 2,
      taskTotalCount: 3,
      childAgentCount: 1,
      childAgentTotalCount: 2,
    },
    usage: {
      ...base.usage,
      tokens: { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 },
      context: { usedTokens: 720_000, windowTokens: 1_000_000, percent: 72 },
      performance: { ...base.usage.performance, firstTokenMs: 2_600, tokensPerSec: 116, sessionTokensPerSec: 44 },
    },
    ...(draft ? {} : {}),
  } as unknown as StatusSnapshot
}

let closing: Promise<void> | undefined
function shutdown(reason: string): Promise<void> {
  closing ??= (async () => {
    note({ closed: true, reason, calls })
    await renderer.dispose()
  })()
  return closing
}

const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit: () => { process.exitCode = 0; void shutdown('exit-requested') },
})

const draftText = testCase === 'long-cjk'
  ? '检查 Debian 13 升级后 ZFS ARC 与内存告警的关联'
  : testCase === 'busy-draft' ? 'Check the deployment logs'
    : testCase === 'idle-empty' || testCase === 'busy-empty' ? ''
      : 'Review the deployment plan'

renderer.bindInput({
  exit() { void shutdown('exit') },
  cancel: () => { calls.cancels += 1; note({ cancels: calls.cancels }) },
  submit: (text, request) => {
    calls.submits.push(text)
    note({ submit: { text, gesture: String(request) } })
  },
  steer: (text) => { note({ steer: text }) },
  pasteMedia: () => { note({ pasteMedia: true }) },
  noteUserInput: () => {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  openModelPicker: entry => { calls.modelEntries.push(entry); note({ modelEntry: entry }) },
  permissionOptions: () => [...STANDARD_ROSTER],
  selectPermission: id => {
    calls.selects.push(id)
    note({ permissionSelect: id, standIn: 'narrow writer recorder; the Host ConfigPort apply is owned by the application lane' })
    // Stand-in for the official pushed permissions projection: update the
    // READ-only fixture so the trigger repaint proves it reads the committed
    // projection rather than an optimistic local value.
    current = {
      ...current,
      access: { permissionPreset: { id, label: LABELS[id] ?? id, matched: true } },
    } as StatusSnapshot
    renderer.display.commitDisplaySubject({}, {}, undefined)
  },
})
if (draftText !== '') renderer.composer.setDraft(draftText)

const customLayout = {
  schemaVersion: 1 as const,
  rows: [{
    left: [
      { id: 'permission-preset', format: 'compact' },
      { id: 'model', format: 'plain' },
      { id: 'reasoning' },
      { id: 'cwd', format: 'basename' },
      { id: 'git-branch', format: 'plain' },
    ],
    right: [{ id: 'context', format: 'percent' }],
  }],
}
const footerConfig = testCase === 'custom-footer'
  ? resolveTspNativeFooterConfig({
      doc: { footer: 'custom', footerLayout: customLayout },
      readiness: 'ready',
      userItems: { items: [], invalidCount: 0 },
    })
  : resolveTspNativeFooterConfig({
      doc: { footer: 'default' },
      readiness: 'ready',
      userItems: { items: [], invalidCount: 0 },
    })

renderer.bindStatusReader({ snapshot: () => current })
renderer.bindNativeFooterConfig(footerConfig)
renderer.display.commitStatusFacts({ sessionTitle: `quiet-composer-production ${testCase}` })
renderer.display.commitDisplaySubject({}, {}, undefined)
note({ ready: true, case: testCase })
if (testCase === 'permission-stale') {
  // The stale case: a real subject hydration revokes the open menu after the
  // flow has captured its option identities. The old option target must die
  // with the outgoing presentation scope.
  setTimeout(() => {
    renderer.display.beginSessionHydration()
    note({ staleHydration: true })
  }, 3000)
}

await new Promise<void>((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
