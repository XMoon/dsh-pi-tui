/**
 * Shared Delivered-files fixtures (Delivered files PR1).
 *
 * The mounted PiTui product ALWAYS receives the bootstrap-injected read
 * capability, so a headless surface fixture that exercises the delivered tail's
 * disclosure/navigation contract must model that presence. These fixtures also
 * build a REAL `TranscriptFolder` from canonical `deliverables/presented` events
 * plus the routing stub that lets a `SurfaceRuntime` select it, so a composed
 * test can join canonical event → fold → snapshot → panel.
 * @module @xmoon76/dsh-pi-tui/support/delivered-files
 */

import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createSurfaceRuntime,
  type SurfaceEventRoutingSource,
} from '../../src/app/surface/runtime.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import type { DeliveredFilesCapability, DeliveredFilesSnapshot } from '../../src/domain/deliverables/catalog.ts'

/** The capability stub: present (so the tail keeps its capped disclosure and
 *  `/deliverables` entry) but with no catalog behind it. */
export const deliveredFilesCapabilityStub: DeliveredFilesCapability = {
  snapshot: () => undefined,
  isCurrent: () => false,
}

/** One snapshot-backed capability over a fixed catalog, for fixtures that need
 *  the real reading path (currentness answers `true` until invalidated). */
export function deliveredFilesCapabilityFor(
  snapshot: DeliveredFilesSnapshot,
): DeliveredFilesCapability & { readonly current: () => boolean; invalidate(): void } {
  let current = true
  return {
    snapshot: () => (current ? snapshot : undefined),
    isCurrent: (candidate) => current && candidate === snapshot,
    current: () => current,
    invalidate: () => { current = false },
  }
}

/** One declared delivery for the folder fixture. */
export interface DeliveredFixtureTurn {
  readonly turn: number
  readonly files: readonly (string | { path: string; description?: string })[]
}

function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/**
 * Build a REAL `TranscriptFolder` whose Turns each declare delivered files
 * through the canonical durable events (turn start → `deliverables/presented` →
 * closing assistant → turn end), so the fold's own attribution/de-duplication
 * is what the fixture asserts through.
 */
export function deliveredFolder(turns: readonly DeliveredFixtureTurn[]): TranscriptFolder {
  const events: SessionEvent[] = []
  let seq = 0
  for (const entry of turns) {
    events.push(
      event('turn/start', { turn: entry.turn }, seq++),
      event('deliverables/presented', {
        turn: entry.turn,
        callId: `present-${entry.turn}`,
        files: entry.files.map(file => (typeof file === 'string' ? { path: file } : file)),
      }, seq++),
      event('assistant/message', {
        turn: entry.turn,
        step: 0,
        message: {
          id: MessageId(`assistant-${entry.turn}-${seq}`),
          role: 'assistant',
          content: [{ type: 'text', text: `final ${entry.turn}` }],
          source: { kind: 'model', provider: 'test', model: 'test' },
        },
        stream: [],
      }, seq++),
      event('turn/end', { turn: entry.turn, reason: { kind: 'completed' } }, seq++),
    )
  }
  const folder = new TranscriptFolder()
  folder.hydrate(events)
  return folder
}

/** The null terminal notification presentation (no terminal sequences). */
const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

/** The stub event-routing source: only the members a snapshot read uses are
 *  meaningful, every other member is an inert placeholder. */
export function deliveredSurfaceRouting(facts: {
  readonly sessionId: () => string | undefined
  readonly mainFolder: () => TranscriptFolder
  readonly viewedChildId?: () => string | undefined
  readonly viewedChildFolder?: () => TranscriptFolder
}): SurfaceEventRoutingSource<never> {
  const window = new TranscriptWindowController()
  return {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: facts.sessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      setTranscript: () => {},
      setStreamingToolPreviews: () => {},
      setTurnActivity: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: facts.viewedChildId ?? (() => undefined),
    viewedChild: () => ({
      window,
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    mainFolder: facts.mainFolder,
    viewedChildFolder: facts.viewedChildFolder ?? (() => { throw new Error('no viewed child') }),
  } as unknown as SurfaceEventRoutingSource<never>
}

/** Mount a real `SurfaceRuntime` over the given routing source. */
export function mountDeliveredSurface(source: SurfaceEventRoutingSource<never>): ReturnType<typeof createSurfaceRuntime> {
  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  surface.attachEventRouting(source as never)
  return surface
}
