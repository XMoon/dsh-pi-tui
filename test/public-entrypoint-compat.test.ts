/**
 * Package-root public export compatibility guard for the Pre-M3 TS
 * Architecture Convergence (plan §7.3 Public root export guard, §14.6 Public
 * exports): `package.json` maps the package root to `dist/index.mjs` /
 * `dist/index.d.mts`, generated from `src/index.ts`. Moving an implementation
 * into `src/app/**` must re-export it from `src/index.ts`; this file pins every
 * existing root export so a silent removal fails both `tsc` (type imports) and
 * the runtime import assertion.
 *
 * It deliberately freezes only the CURRENT root surface — no API extractor, no
 * dependency, and no claim about future private implementation. Adding an
 * export is allowed; removing or renaming one is an explicit API PR.
 * @module @xmoon76/dsh-pi-tui/public-entrypoint-compat.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SurfaceCatalogContext } from '../src/surface-catalog.ts'
import type { Diag } from '../src/diag.ts'

import {
  apply,
  busyAfterTurnBoundary,
  commandIsLocalForAttachments,
  commandRejectsImages,
  compactingFromLog,
  composeAgent,
  Config,
  contextRefreshKind,
  createViewerOpenToken,
  dangerCommand,
  foldCompactionEvent,
  foldQueueRows,
  HOST_COMMAND_CATALOG,
  hostRunningProfile,
  inject,
  interruptAgent,
  isBareCommandLine,
  isLocalCommandLine,
  isPlainExitPrompt,
  LOCAL_COMMANDS,
  matchPendingSubagentCall,
  name,
  normalizeSkillInvocation,
  recordedPreset,
  resolveInitialCatalog,
  resolveSubmitDelivery,
  resumeCommand,
  runningProfile,
  SESSIONLESS_COMMANDS,
  settleCompactionSurface,
  shouldConsumeAdvertisedMiss,
  subagentJobTranscriptId,
  subagentJobViewHint,
  taskRowSelectionDisposition,
  teardownViewerForSessionSwap,
  viewerActionCapability,
} from '../src/index.ts'
import type {
  AgentComposition,
  CompactionFold,
  CompactionSettleSurface,
  Config as ConfigShape,
  InitialCatalogResolution,
  InterruptAgentLike,
  InterruptWriterLike,
  InterruptWriteOutcome,
  PendingSubagentCall,
  ProfileContextReadLike,
  QueueFoldResult,
  QueueInboxMessage,
  ResolveInitialCatalogOptions,
  ViewerOpenToken,
} from '../src/index.ts'

// Compile-time proof that every frozen public type still exists. `tsc` is the
// assertion; the tuple is erased at runtime.
type FrozenPublicTypes = [
  ConfigShape,
  InterruptWriteOutcome,
  InterruptAgentLike,
  InterruptWriterLike,
  PendingSubagentCall,
  ViewerOpenToken,
  InitialCatalogResolution,
  ResolveInitialCatalogOptions,
  QueueInboxMessage,
  QueueFoldResult,
  ProfileContextReadLike,
  CompactionFold,
  CompactionSettleSurface,
  AgentComposition,
]

/**
 * Compile-time SHAPE pins (A5a review P1). A public option type whose
 * implementation moved out of the entry must not be NARROWED: `liveAgent` stays
 * the Host `Agent`, so a consumer that READS the property (`options.liveAgent
 * ?.status`) keeps compiling. The frozen-name tuple above only proves the name
 * exists; this pins the shape.
 */
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

type ExpectedResolveInitialCatalogOptions = {
  readonly liveAgent?: Agent
  readonly presetId?: string
  readonly signal: AbortSignal
  readonly ctx: SurfaceCatalogContext
  readonly diag: Diag
  readonly onLog?: () => void
}

const _resolveInitialCatalogOptionsShape: AssertExact<
  ResolveInitialCatalogOptions,
  ExpectedResolveInitialCatalogOptions
> = true

/** Value exports are asserted at runtime; the array is the frozen list. */
const VALUE_EXPORTS: ReadonlyArray<readonly [string, unknown]> = [
  ['name', name],
  ['inject', inject],
  ['Config', Config],
  ['SESSIONLESS_COMMANDS', SESSIONLESS_COMMANDS],
  ['LOCAL_COMMANDS', LOCAL_COMMANDS],
  ['HOST_COMMAND_CATALOG', HOST_COMMAND_CATALOG],
  ['commandRejectsImages', commandRejectsImages],
  ['isLocalCommandLine', isLocalCommandLine],
  ['isBareCommandLine', isBareCommandLine],
  ['commandIsLocalForAttachments', commandIsLocalForAttachments],
  ['resolveSubmitDelivery', resolveSubmitDelivery],
  ['normalizeSkillInvocation', normalizeSkillInvocation],
  ['shouldConsumeAdvertisedMiss', shouldConsumeAdvertisedMiss],
  ['interruptAgent', interruptAgent],
  ['createViewerOpenToken', createViewerOpenToken],
  ['teardownViewerForSessionSwap', teardownViewerForSessionSwap],
  ['viewerActionCapability', viewerActionCapability],
  ['matchPendingSubagentCall', matchPendingSubagentCall],
  ['resolveInitialCatalog', resolveInitialCatalog],
  ['subagentJobTranscriptId', subagentJobTranscriptId],
  ['taskRowSelectionDisposition', taskRowSelectionDisposition],
  ['subagentJobViewHint', subagentJobViewHint],
  ['isPlainExitPrompt', isPlainExitPrompt],
  ['foldQueueRows', foldQueueRows],
  ['dangerCommand', dangerCommand],
  ['runningProfile', runningProfile],
  ['hostRunningProfile', hostRunningProfile],
  ['resumeCommand', resumeCommand],
  ['foldCompactionEvent', foldCompactionEvent],
  ['settleCompactionSurface', settleCompactionSurface],
  ['busyAfterTurnBoundary', busyAfterTurnBoundary],
  ['contextRefreshKind', contextRefreshKind],
  ['compactingFromLog', compactingFromLog],
  ['composeAgent', composeAgent],
  ['recordedPreset', recordedPreset],
  ['apply', apply],
]

test('every frozen package-root value export is present', () => {
  for (const [exportName, value] of VALUE_EXPORTS) {
    assert.notEqual(value, undefined, `missing root export: ${exportName}`)
  }
  // The tuple must stay referenced so `tsc` checks it under any future
  // unused-locals setting.
  const _typeCheck: FrozenPublicTypes | undefined = undefined
  assert.equal(_typeCheck, undefined)
})

test('the runner entrypoint exports its Cordis contract', () => {
  assert.equal(name, 'tui-runner')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('agents'))
  assert.ok(inject.includes('sessions'))
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})
