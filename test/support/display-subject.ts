/**
 * The test driver for the M3-5 PR1 display-subject commit.
 *
 * Production derives the display-subject payload from the viewed child's
 * `SessionReader.sessionStatus(childId)` inside StatusRuntime and installs it
 * with ONE `TuiApp.commitDisplaySubject()`. A TuiApp-level suite (chrome /
 * todo / extension behaviour) uses this driver to make the SAME atomic commit
 * with the child facts it cares about, instead of standing up a whole
 * StatusRuntime whose main-session derivation would override the suite's own
 * `setStatus` fixtures. The production child-status derivation itself is
 * covered end-to-end by the Direct viewer/Task L6 suite and the focused
 * `status-display-subject.test.ts`.
 * @module test/support/display-subject
 */

import type { TodoItem, TuiApp } from '../../src/tui-app.ts'
import type { UsageStatus } from '../../src/status/types.ts'

/** The child facts one TuiApp-level suite declares for the viewed subject. */
export interface ChildDisplaySubject {
  readonly id: string
  readonly label: string
  readonly mode: 'one-shot' | 'continuable'
  readonly activity: 'running' | 'inactive'
  readonly cwd: string
  readonly turns: number
  readonly steps: number
  /** The child's OFFICIAL structured usage facts. Omitted mirrors the
   *  production "the official projection cannot answer" disposition: the
   *  cumulative token/context facts are ABSENT (the child's own fold is never
   *  a stand-in) while turns/steps/recent performance stay presentation-local. */
  readonly usage?: UsageStatus
  readonly todos?: readonly TodoItem[]
  readonly title?: string
  /** The child's rendered goal-badge text. */
  readonly goal?: string
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly permission?: string
  readonly parentSessionId?: string
  /** The LIVE session's legacy display facts merged into the live slot by the
   *  same commit (default: leave the live slot untouched). */
  readonly live?: {
    readonly model?: string
    readonly cwd?: string
    readonly branch?: string
    readonly turns?: number
    readonly steps?: number
    readonly permission?: string
  }
}

/** Enter the viewer and commit the CHILD as the display subject in ONE atomic
 *  update (the production `refreshStatusCheap` child shape). */
export function enterChildDisplaySubject(app: TuiApp, child: ChildDisplaySubject): void {
  app.setViewerMode({
    parentSessionId: child.parentSessionId ?? 'parent-session',
    childSessionId: child.id,
    label: child.label,
    mode: child.mode,
    activity: child.activity,
    access: child.mode === 'one-shot' ? 'readonly-one-shot' : 'interactive-direct-child',
  })
  const parts = child.cwd.split('/').filter(Boolean)
  const model = child.model
  app.commitDisplaySubject(
    {
      view: {
        subject: {
          kind: 'subagent',
          id: child.id,
          label: child.label,
          mode: child.mode,
          activity: child.activity,
        },
      },
      // An absent child fact is ABSENT — never the parent's (M3-5 PR1 §9.4).
      composition: model === undefined
        ? {}
        : {
            model: {
              provider: model.provider,
              id: model.model,
              displayName: model.model,
              ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
            },
          },
      access: child.permission === undefined
        ? {}
        : { permissionPreset: { id: child.permission, label: child.permission, matched: true } },
      collaboration: { plan: { effective: false } },
      workspace: {
        cwd: child.cwd,
        ...parts.length === 0 ? {} : { project: parts[parts.length - 1]! },
      },
      usage: child.usage ?? {
        // NO `tokens`/`context`: an unavailable official child fact stays
        // absent — the fold's window totals are never presented as a session
        // total (production `usageFromStats` official path).
        performance: { llmMs: 0, firstTokenMs: 0, tokensPerSec: 0 },
        turns: child.turns,
        steps: child.steps,
      },
    },
    // The legacy fields travel as the LIVE session's (M3-5 PR1 contract
    // decision): a child commit merges them into the live slot without
    // re-projecting the store, so the extension v2 live snapshot stays fresh.
    // Only the facts the suite declares are merged — an omitted `live` leaves
    // the suite's live facts untouched.
    {
      ...child.live?.model === undefined ? {} : { model: child.live.model },
      ...child.live?.cwd === undefined ? {} : { cwd: child.live.cwd },
      ...child.live?.branch === undefined ? {} : { branch: child.live.branch },
      ...child.live?.turns === undefined ? {} : { turns: child.live.turns },
      ...child.live?.steps === undefined ? {} : { steps: child.live.steps },
      ...child.live?.permission === undefined ? {} : { permission: child.live.permission },
      goal: undefined,
    },
    {
      sessionId: child.id,
      workspaceRoot: child.cwd,
      title: child.title ?? '',
      todos: child.todos ?? [],
      goal: child.goal,
    },
  )
}

/** Leave the viewer and commit MAIN as the display subject again. The main
 *  facts the suite declared with `setStatus` are re-written here (their LATEST
 *  values, never an enter-time copy). The whole main subject travels in ONE
 *  patch, exactly like the production exit refresh. */
export function exitChildDisplaySubject(
  app: TuiApp,
  main: {
    readonly model?: string
    readonly cwd?: string
    readonly branch?: string
    readonly turns?: number
    readonly steps?: number
    readonly usage?: UsageStatus
    readonly permission?: string
  } = {},
): void {
  app.setViewerMode(undefined)
  const cwd = main.cwd ?? ''
  const parts = cwd.split('/').filter(Boolean)
  app.commitDisplaySubject(
    {
      view: { subject: { kind: 'main' } },
      composition: {},
      access: {},
      collaboration: { plan: { effective: false } },
      workspace: {
        cwd,
        ...parts.length === 0 ? {} : { project: parts[parts.length - 1]! },
        ...main.branch === undefined || main.branch === '' ? {} : { branch: main.branch },
      },
      usage: main.usage ?? {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        performance: { llmMs: 0, firstTokenMs: 0, tokensPerSec: 0 },
        turns: main.turns ?? 0,
        steps: main.steps ?? 0,
      },
    },
    {
      model: main.model ?? '',
      cwd,
      branch: main.branch ?? '',
      goal: undefined,
      turns: main.turns ?? 0,
      steps: main.steps ?? 0,
      statsLine: '',
      permission: main.permission,
      contextTokens: undefined,
      contextWindow: undefined,
    },
    undefined,
  )
}
