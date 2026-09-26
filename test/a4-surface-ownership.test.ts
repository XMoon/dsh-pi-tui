import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compositionSource } from './support/composition-surface.ts'

/**
 * A4 surface-ownership locks (plan §18/§20).
 *
 * These are SOURCE locks: the ownership claim is "the runner owns no surface
 * construction / no surface lifetime, and the surface owner reads no Host
 * business service and no Direct wiring". Behaviour is covered by the runner
 * integration suites; these locks pin the dependency direction so a later edit
 * cannot silently move construction or Host coupling back.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const indexSource = compositionSource()

/** Every TypeScript source under `src/app/surface`. */
function surfaceSources(): Array<{ rel: string; source: string }> {
  const out: Array<{ rel: string; source: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      out.push({ rel: relative(ROOT, path), source: readFileSync(path, 'utf8') })
    }
  }
  walk(join(ROOT, 'src', 'app', 'surface'))
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

test('A4: the runner owns no surface construction or mount', () => {
  // The mounted TuiApp, the status store and the opening journal are constructed
  // by the surface owner — never in the runner.
  assert.doesNotMatch(indexSource, /\bstartProcessTui\(/u,
    'the runner must not mount the process TUI directly (SurfaceRuntime.start owns the mount)')
  assert.doesNotMatch(indexSource, /new StatusStore\(/u,
    'the runner must not construct the status store (the surface owner owns the instance)')
  assert.doesNotMatch(indexSource, /new ImageLoader\(/u,
    'the runner must not construct the image loader (the surface owner builds the option wiring)')
  assert.match(indexSource, /createSurfaceRuntime<SessionEvent>\(/u,
    'the runner must create the surface owner')
  assert.match(indexSource, /surface\.start\(\{/u,
    'the runner must mount through the surface owner')
  // A4-5 surface-owned constructions (plan §14/§20).
  assert.doesNotMatch(indexSource, /new SurfaceHost\(/u,
    'the runner must not construct the extension surface host')
  assert.doesNotMatch(indexSource, /new PluginManagerController\(/u,
    'the runner must not construct the Plugin Manager controller')
  assert.doesNotMatch(indexSource, /new PluginManagerPanel\(/u,
    'the runner must not construct a Plugin Manager panel')
  assert.doesNotMatch(indexSource, /new PluginManagerHostRegistry\(/u,
    'the runner must not construct the Plugin Manager host registry')
  assert.match(indexSource, /surface\.attachPluginManager\(\{ port: backend\.pluginManager, diag \}\)/u,
    'the runner must attach the Plugin Manager owner through the surface')
  // A4-4 notification presentation ownership (plan §13.3).
  assert.doesNotMatch(indexSource, /new CompletionNotificationController\(/u,
    'the runner must not construct the completion-notification controller')
  assert.doesNotMatch(indexSource, /new TerminalNotifier\(/u,
    'the runner must not construct the terminal notifier')
  assert.doesNotMatch(indexSource, /new TerminalFocusTracker\(/u,
    'the runner must not construct the terminal focus tracker')
  // A4-6 Task Browser / Job viewer + approval/question ownership (plan §15/§16).
  assert.doesNotMatch(indexSource, /new TaskBrowserRuntime\(/u,
    'the runner must not construct the Task Browser coordinator')
  assert.match(indexSource, /surface\.attachTasks\(\{/u,
    'the runner must attach the Task Center through the surface owner')
  assert.match(read('src/app/surface/runtime.ts'), /jobsEventsDispose = jobs\.subscribe\(/u,
    'the surface owner must own the jobs-event subscription')
  assert.doesNotMatch(indexSource, /backend\.interaction\.onApprovalRequest\(/u,
    'the runner must not register the approval provider directly')
  assert.doesNotMatch(indexSource, /backend\.interaction\.registerQuestionProvider\(/u,
    'the runner must not register the question provider directly')
  assert.match(indexSource, /surface\.attachInteraction\(backend\.interaction,/u,
    'the runner must attach the interaction providers through the surface owner')
  assert.match(read('src/app/surface/runtime.ts'), /new TaskBrowserRuntime\(/u,
    'the surface owner must construct the Task Browser coordinator')
})

test('A4: the mounted TuiApp has exactly one lifetime owner', () => {
  // The runner borrows the mounted reference; only the surface owner releases it.
  assert.match(indexSource, /app = surface\.app/u, 'the runner borrows the mounted app from the surface owner')
  assert.doesNotMatch(indexSource, /app\?\.dispose\(\)/u, 'the runner must not dispose the mounted app')
  assert.doesNotMatch(indexSource, /app\.dispose\(\)/u, 'the runner must not dispose the mounted app')
})

test('A4: the runner releases the surface-owned resources in the documented order', () => {
  // Plan §12.2: the teardown order is behavior. The runner only orchestrates;
  // every release hook is surface-owned.
  const cleanupStart = indexSource.indexOf('const disposeSurface = (): void => {')
  assert.ok(cleanupStart >= 0, 'disposeSurface must exist')
  const cleanup = indexSource.slice(cleanupStart, indexSource.indexOf('diag.dispose()', cleanupStart) + 20)
  const order = [
    'surface.disposePluginManager()',
    'surface.disposeJobEvents()',
    'surface.disposeJobObservation()',
    'surface.disposeTaskBrowser()',
    'surface.dispose()',
  ]
  let cursor = -1
  for (const hook of order) {
    const at = cleanup.indexOf(hook)
    assert.ok(at >= 0, `cleanup must call ${hook}`)
    assert.ok(at > cursor, `cleanup must call ${hook} after the previous surface release hook`)
    cursor = at
  }
})

test('A4: app/surface reads no Host business service and no Direct wiring', () => {
  const sources = surfaceSources()
  assert.ok(sources.length > 0, 'src/app/surface must exist')
  for (const { rel, source } of sources) {
    assert.doesNotMatch(source, /ctx\s*\.\s*get\(/u,
      `${rel}: the surface owner must consume injected capabilities, never a Host service lookup`)
    assert.doesNotMatch(source, /from '[^']*(?:\/|^)(?:app\/direct|runtime\/direct)\//u,
      `${rel}: the surface owner must not import Direct wiring`)
    assert.doesNotMatch(source, /new Direct[A-Za-z0-9_]*\(/u,
      `${rel}: the surface owner must not construct a Direct semantic adapter`)
  }
})

test('A4: the opening journal instance is surface-owned', () => {
  // The concrete state lives in the surface module; the runner only reads the
  // surface owner's instance (A4-1 module, A4-2 instance).
  assert.match(indexSource, /surface\.openingJournal\./u,
    'the runner must drive the opening journal through the surface owner')
  assert.doesNotMatch(indexSource, /createOpeningJournal</u,
    'the runner must not create the opening journal instance')
  const journal = read('src/app/surface/opening-journal.ts')
  assert.match(journal, /export function createOpeningJournal</u, 'the surface module owns the journal implementation')
})

test('A4-7: the four presentation routing bodies live in app/surface, not the runner', () => {
  // Plan §16: the runner keeps the Host registrations and the Direct install as
  // THIN delegations; the routing decisions/fences and the apply/paint calls
  // are surface-owned. Each routing body is pinned to BOTH sides: the runner
  // must not re-grow the body, and the surface must actually own it.
  const surface = read('src/app/surface/runtime.ts')

  // 1. session/event routing.
  assert.match(indexSource, /ctx\.on\('session\/event', \(session, event\) => surface\.routeSessionEvent\(session, event\)\)/u,
    'the runner must delegate session/event to the surface routing')
  assert.doesNotMatch(indexSource, /openingJournal\.isOpening\(/u,
    'the opening-journal decision must live in the surface routing')
  assert.doesNotMatch(indexSource, /openingJournal\.record\(/u,
    'the opening-journal record must live in the surface routing')
  assert.doesNotMatch(indexSource, /viewing\.folder\.apply\(/u,
    'the viewed-child transcript application must live in the surface routing')
  assert.match(surface, /const routeSessionEvent = /u,
    'the surface must own the session/event routing body')
  assert.match(surface, /openingJournal\.isOpening\(session\.id\)/u,
    'the surface must decide the opening-journal target')
  assert.match(surface, /openingJournal\.record\(session\.id, event\)/u,
    'the surface must record the opening event')
  assert.match(surface, /main\.folder\.apply\(\[event\]\)/u,
    'the surface must issue the main transcript apply call')
  assert.match(surface, /viewer\.folder\.apply\(\[event\]\)/u,
    'the surface must issue the viewed-child transcript apply call')
  assert.match(surface, /\bpaintNow\(\)/u,
    'the surface must coordinate the forced repaint')

  // 2. assistant stream: the Direct INSTALL stays, the routing bodies move.
  assert.match(indexSource, /isCurrentAgent: \(agent\) => surface\.isCurrentAssistantAgent\(agent\)/u,
    'the Direct install must delegate the identity fence to the surface')
  assert.match(indexSource, /onInput: \(input\) => surface\.applyAssistantInput\(input\)/u,
    'the Direct install must delegate the neutral input routing to the surface')
  assert.doesNotMatch(indexSource, /registeredAgentFor\(candidateId\)/u,
    'the exact-Agent identity fence must live in the surface routing')
  assert.match(surface, /const isCurrentAssistantAgent = /u,
    'the surface must own the assistant-stream identity routing')
  assert.match(surface, /const applyAssistantInput = /u,
    'the surface must own the assistant-stream input routing')

  // 3. subagent lifecycle + agent/status presentation triggers.
  assert.match(indexSource, /ctx\.on\('subagent\/start', \(\) => surface\.routeSubagentLifecycle\(\)\)/u,
    'subagent/start must delegate to the surface routing')
  assert.match(indexSource, /ctx\.on\('subagent\/end', \(\) => surface\.routeSubagentLifecycle\(\)\)/u,
    'subagent/end must delegate to the surface routing')
  assert.match(indexSource, /ctx\.on\('agent\/status', \(\{ agent, status \}\) => surface\.routeAgentStatus\(agent\.id, status\)\)/u,
    'agent/status must delegate to the surface routing')
  assert.match(surface, /const routeSubagentLifecycle = /u,
    'the surface must own the subagent lifecycle routing')
  assert.match(surface, /const routeAgentStatus = /u,
    'the surface must own the agent/status routing')

  // 4. provider/settings/credential refresh routing.
  assert.match(indexSource, /ctx\.on\('llm\/adapters-updated', \(\) => surface\.routeProviderRefresh\(\)\)/u,
    'llm/adapters-updated must delegate to the surface routing')
  assert.match(indexSource, /ctx\.on\('settings\/document-updated', \(ns\) => surface\.routeSettingsRefresh\(ns\)\)/u,
    'settings/document-updated must delegate to the surface routing')
  assert.match(indexSource, /credentials\.onChanged\(\(\) => surface\.routeProviderRefresh\(\)\)/u,
    'the credential listener must delegate to the surface routing')
  assert.match(surface, /const routeProviderRefresh = /u,
    'the surface must own the provider/credential refresh routing')
  assert.match(surface, /const routeSettingsRefresh = /u,
    'the surface must own the settings refresh routing')
  assert.match(surface, /namespace === 'llm-pi-ai' \|\| namespace === 'llm-deepseek'/u,
    'the surface must own the settings namespace filter')

  // 5. the subagent tool/call refresh DECISION (A4-7 P2): the runner reports
  // the presentation intent; the surface routing performs the refresh.
  assert.match(surface, /SurfaceMainEventObservation/u,
    'the surface must define the observation-intent record')
  assert.match(surface, /if \(observed\.refreshAgents\) refreshAgents\(\)/u,
    'the surface must decide/perform the subagent tool/call refresh')
  assert.match(indexSource, /return \{ settledViewChildId, refreshAgents \}/u,
    'the runner must report the refresh intent instead of calling it')
  assert.doesNotMatch(indexSource, /startsWith\('subagent'\)\) \{\n\s*surface\.refreshAgents\(\)/u,
    'the runner must not call refreshAgents inside the subagent tool/call branch')
})

test('A4-4: the status commit and the pending-input presentation are surface-owned', () => {
  const surface = read('src/app/surface/runtime.ts')

  // Status COMMIT coordination: the runner keeps the semantic derivation and
  // delegates the two-call commit (`status.update` then `mounted().setStatus`).
  assert.match(surface, /commitStatus\(patch, legacyFacts\)/u,
    'the surface must own the status commit')
  assert.match(surface, /status\.update\(patch\)/u,
    'the surface must commit the status patch')
  assert.match(surface, /mounted\(\)\.setStatus\(legacyFacts\)/u,
    'the surface must commit the legacy footer facts')
  assert.match(indexSource, /surface\.commitStatus\(patch,/u,
    'the runner must delegate the status commit to the surface')
  assert.doesNotMatch(indexSource, /surface\.status\.update\(/u,
    'the runner must not commit the status store directly')
  assert.doesNotMatch(indexSource, /app\.setStatus\(/u,
    'the runner must not commit the legacy status directly')

  // Pending-input presentation: the runner injects only the semantic read,
  // the submission echoes and the text projection.
  assert.match(surface, /const refreshPendingInput = /u,
    'the surface must own the pending-input presentation')
  assert.match(surface, /buildPendingPresentation\(/u,
    'the surface must own the pending/submission join')
  assert.match(surface, /pendingOwnInputBySubject/u,
    'the surface must own the own-input viewport memory')
  assert.match(surface, /\.setPendingInputPresentation\(/u,
    'the surface must publish the pending presentation')
  assert.doesNotMatch(indexSource, /const refreshPendingInput\b/u,
    'the runner must not hold the pending-input presentation implementation')
  assert.doesNotMatch(indexSource, /pendingOwnInputBySubject/u,
    'the runner must not hold the own-input memory')
  assert.doesNotMatch(indexSource, /buildPendingPresentation\(/u,
    'the runner must not hold the pending/submission join')
  assert.match(indexSource, /pendingSubjectId: \(\) => activePendingSessionId\(\)/u,
    'the runner must inject the active pending subject only')
  assert.match(indexSource, /pendingSnapshot: \(sessionId\) => backend\.pendingInputReader\.snapshot\(sessionId\)/u,
    'the runner must inject the semantic pending snapshot only')
  assert.match(indexSource, /submissionEchoes: \(sessionId\) => submissionPresentation\.snapshot\(sessionId\)/u,
    'the runner must inject the submission-presentation echoes only')
  assert.match(indexSource, /queueTextOf: content => queueTextOf\(/u,
    'the runner must inject the text projection only')
  // Every runner call site goes through the surface owner.
  assert.match(indexSource, /surface\.refreshPendingInput\(\)/u,
    'the runner must drive the pending refresh through the surface')
  assert.doesNotMatch(indexSource, /(?<!surface\.)\brefreshPendingInput\(\)/u,
    'no runner-local pending refresh remains')
})

test('A4-8: the active-target, repaint and search/transcript wiring are surface-owned', () => {
  const surface = read('src/app/surface/runtime.ts')

  // The SELECTION policy (main vs viewed child).
  assert.match(surface, /const activeFolder = /u, 'the surface must own the active folder selection')
  assert.match(surface, /const activeWindow = /u, 'the surface must own the active window selection')
  assert.match(surface, /const activeStreamingToolPreviews = /u,
    'the surface must own the active previews selection')
  assert.doesNotMatch(indexSource, /const activeFolder\b/u,
    'the runner must not select the active folder')
  assert.doesNotMatch(indexSource, /const activeWindow\b/u,
    'the runner must not select the active window')
  assert.doesNotMatch(indexSource, /const activeStreamingToolPreviews\b/u,
    'the runner must not select the active previews')

  // Repaint SCHEDULING + the projection glue.
  assert.match(surface, /const repaintTarget = /u, 'the surface must own the projection glue')
  assert.match(surface, /const paintNow = /u, 'the surface must own the forced repaint')
  assert.match(surface, /const schedulePaint = /u, 'the surface must own the coalesced repaint')
  assert.match(surface, /REPAINT_FLUSH_MS = 50/u, 'the surface must own the flush interval')
  assert.doesNotMatch(indexSource, /const paintNow\b/u, 'the runner must not schedule the forced repaint')
  assert.doesNotMatch(indexSource, /const schedulePaint\b/u, 'the runner must not schedule the coalesced repaint')
  assert.doesNotMatch(indexSource, /REPAINT_FLUSH_MS/u, 'the runner must not own the flush interval')
  assert.doesNotMatch(indexSource, /function repaint\(/u, 'the runner must not own the repaint algorithm')
  assert.doesNotMatch(indexSource, /\brepaint\(app,/u, 'the runner must not call the moved repaint algorithm')
  assert.match(indexSource, /surface\.repaint\(\)/u, 'the runner must repaint through the surface')
  assert.match(surface, /schedulePaint\(\): void/u, 'the surface must expose schedulePaint()')
  assert.match(surface, /paintNow\(\): void/u, 'the surface must expose paintNow()')

  // The transcript-navigation + search presentation callbacks.
  assert.match(surface, /const transcriptMoveOlder = /u, 'the surface must own the navigation wiring')
  assert.match(surface, /const transcriptJumpLatest = /u, 'the surface must own the jump-latest wiring')
  assert.match(surface, /const jumpToSearchMatch = /u, 'the surface must own the search commit')
  assert.match(surface, /const runSearchQuery = /u, 'the surface must own the search query wiring')
  assert.match(surface, /const closeSearch = /u, 'the surface must own the search close wiring')
  assert.match(surface, /onSearchQuery: query => runSearchQuery\(query\)/u,
    'the surface must wire the search query callback')
  assert.match(surface, /onTranscriptMoveOlder: \(\) => transcriptMoveOlder\(\)/u,
    'the surface must wire the navigation callback')
  assert.match(surface, /searchBindingForRepaint/u, 'the surface must own the search repaint binding')
  assert.doesNotMatch(indexSource, /onTranscriptMoveOlder:/u,
    'the runner must not wire the transcript navigation callbacks')
  assert.doesNotMatch(indexSource, /onTranscriptTurnOlder:/u,
    'the runner must not wire the transcript turn navigation')
  assert.doesNotMatch(indexSource, /onTranscriptJumpLatest:/u,
    'the runner must not wire the jump-latest callback')
  assert.doesNotMatch(indexSource, /onSearchOpen:/u, 'the runner must not wire the search-open callback')
  assert.doesNotMatch(indexSource, /onSearchQuery:/u, 'the runner must not wire the search-query callback')
  assert.doesNotMatch(indexSource, /onSearchNext:/u, 'the runner must not wire the search-next callback')
  assert.doesNotMatch(indexSource, /onSearchClose:/u, 'the runner must not wire the search-close callback')
  assert.doesNotMatch(indexSource, /searchBindingForRepaint/u, 'the runner must not hold the search binding')
  assert.doesNotMatch(indexSource, /const jumpToSearchMatch\b/u, 'the runner must not hold the search commit')
  assert.doesNotMatch(indexSource, /const resetSearchState\b/u, 'the runner must not hold the search reset')
  assert.match(indexSource, /surface\.resetSearchPresentation\(\)/u,
    'the runner must reset the search presentation through the surface')

  // The Host registrations, the Direct install and the credential
  // subscription/disposal stay in the runner.
  assert.match(indexSource, /ctx\.on\('session\/event'/u, 'the runner keeps the session/event registration')
  assert.match(indexSource, /directRuntime\.installAssistantStream\(/u, 'the runner keeps the Direct assistant-stream install')
  assert.match(indexSource, /credentials\.onChanged\(/u, 'the runner keeps the credential subscription')
  assert.match(indexSource, /disposeCredentialSubscription/u, 'the runner keeps the credential disposal')
})
