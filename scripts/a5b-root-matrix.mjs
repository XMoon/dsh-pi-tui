// A5b root-declaration ownership matrix — the COMMITTED generator (plan §6.1).
//
// One row per root-scope declaration of `startRunner()` in
// `src/app/bootstrap.ts`: kind/mutability/line span/reference count/Host-seam
// flag/first-line evidence/mentioning tests, the auto-derived CALLERS (which
// other root declarations read it) and the curated ownership CLASSIFICATION,
// owner, LIFECYCLE and minimum CAPABILITY set of the plan §7.6.1 category set.
//
// usage:
//   node scripts/a5b-root-matrix.mjs           # print the summary
//   node scripts/a5b-root-matrix.mjs --write   # regenerate the committed artifact
//   node scripts/a5b-root-matrix.mjs --check   # fail when the artifact is stale
//
// `test/a5b-root-matrix.test.ts` enforces exact coverage of the declarations and
// the shrink-only MUST_MOVE residual; re-run `--write` after every A5b slice.
import ts from 'typescript'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT = join(ROOT, 'test/a5b-root-declaration-matrix.json')

const FILE = process.env.A5B_MATRIX_SOURCE ?? join(ROOT, 'src/app/bootstrap.ts')
const source = readFileSync(FILE, 'utf8')
const sf = ts.createSourceFile(FILE, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

let startRunner = null
const findSR = (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'startRunner') startRunner = node.initializer
  ts.forEachChild(node, findSR)
}
findSR(sf)
if (!startRunner) throw new Error('startRunner not found')

const rows = []
const bindNames = (nameNode, cb) => { if (ts.isIdentifier(nameNode)) cb(nameNode); else ts.forEachChild(nameNode, (c) => bindNames(c, cb)) }
for (const stmt of startRunner.body.statements) {
  let names = []
  let kind = 'const'
  let mutable = false
  if (ts.isVariableStatement(stmt)) {
    mutable = (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0
    kind = mutable ? 'let' : ((stmt.declarationList.flags & ts.NodeFlags.Const) !== 0 ? 'const' : 'var')
    for (const d of stmt.declarationList.declarations) bindNames(d.name, (id) => names.push(id.text))
  } else if (ts.isFunctionDeclaration(stmt) && stmt.name) { names = [stmt.name.text]; kind = 'function' }
  else if (ts.isClassDeclaration(stmt) && stmt.name) { names = [stmt.name.text]; kind = 'class' }
  else if (ts.isTypeAliasDeclaration(stmt)) { names = [stmt.name.text]; kind = 'type' }
  else if (ts.isInterfaceDeclaration(stmt)) { names = [stmt.name.text]; kind = 'interface' }
  else continue
  if (names.length === 0) continue
  const text = source.slice(stmt.getStart(sf), stmt.getEnd())
  const head = text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))[0]?.slice(0, 120) ?? ''
  for (const name of names) {
    // Identifier-reference count across the whole file (declaration sites included).
    const refs = (source.match(new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g')) ?? []).length
    rows.push({
      name,
      kind,
      mutable,
      lines: `${lineOf(stmt)}-${sf.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1}`,
      refs,
      hostDependency: /\bctx\.(get|logger)\b|\bprocess\.env\b|\bdirectRuntime\b|\bAgent\b|\bSessionId\b|\bSessionSeq\b|\bModelSelection\b|\bSessionScope\b|\bLiveSessionScope\b/.test(text),
      head,
      tests: [],
      classification: '',
      owner: '',
      capabilities: '',
    })
  }
}

// Which test files mention each declaration (lock re-anchoring candidates).
// The matrix's own guard file is not a lock candidate: including it would make
// the artifact self-referential (its own text mentions declaration names).
// SORTED before slicing: directory enumeration order is filesystem-dependent and
// `--check` compares the `tests` array, so an unsorted slice would make the gate
// non-deterministic across checkouts.
const testFiles = readdirSync(join(ROOT, 'test')).filter((f) => f.endsWith('.ts') && f !== 'a5b-root-matrix.test.ts').sort()
const testText = new Map(testFiles.map((f) => [f, readFileSync(join(ROOT, 'test', f), 'utf8')]))
for (const row of rows) {
  const re = new RegExp(`\\b${row.name.replace(/[$]/g, '\\$')}\\b`)
  row.tests = testFiles.filter((f) => re.test(testText.get(f))).slice(0, 4)
}

// ── curated ownership classification (review-driven; evidence = the head line
// in the JSON, re-verified at A5b-6) ────────────────────────────────────────
const HOST = 'KEEP_BOOTSTRAP:host-service-resolution'
const PRE = 'KEEP_BOOTSTRAP:process-cordis-prerequisite'
const BIND = 'KEEP_BOOTSTRAP:owner-construction-or-bind'
const START = 'KEEP_BOOTSTRAP:startup-resume-create-orchestration'
const CONN = 'KEEP_BOOTSTRAP:owner-connector'
const DISC = 'KEEP_BOOTSTRAP:mount-dispose-fatal-coordination'
const SURF = 'MUST_MOVE:app-surface'
const SUB = 'MUST_MOVE:app-submission'
const CLASSIFICATION = {
  // Host-service resolution needed for owner construction / Host wiring.
  agents: HOST, defaultModel: HOST, sessions: HOST, settingsForms: HOST, tools: HOST,
  jobs: HOST, subagents: HOST, present: HOST,
  assistantStreamHandle: HOST, disposeCredentialSubscription: HOST,
  // A5b-6 sweep refinements (evidence = the sweep note): these are NOT Host
  // service lookups; they are narrow composition-to-owner connectors, so the
  // §7.6.1 owner-connector category is the honest one.
  compose: CONN, lifecycleAgents: CONN,
  // A5b-6 sweep refinement: the ONE exit orchestration is dispose/fatal
  // coordination, not a process prerequisite.
  requestExit: DISC,
  // Process / Cordis prerequisites and lifetime-owned state.
  cwd: PRE, signal: PRE, cleanedUp: PRE, app: PRE, extensionService: PRE,
  tuiSettings: PRE, persistedTuiSettings: PRE, displayResolution: PRE, displayState: PRE,
  progressUpdatesState: PRE, responseStyleState: PRE, launchPreset: PRE, pendingPreset: PRE,
  draftImages: PRE, draftFiles: PRE, viewerRef: PRE,
  initialSnapshot: PRE, initialSkills: PRE, surfaceNotice: PRE, handle: PRE,
  resumeFailure: PRE, resumeResolved: PRE, assistantStreamBaselineFor: PRE,
  flushTurn: PRE, startupAgent: PRE,
  // Startup / resume / create orchestration.
  launchComposition: START, resumeQuiesce: START, currentWorkingFromLog: START,
  currentPreset: START, sessionBlank: START,
  // Owner construction / bind (incl. the late-bound submission runtime slot).
  ownership: BIND, sessionScope: BIND, surface: BIND, directRuntime: BIND, model: BIND,
  sessionRuntime: BIND, backend: BIND, settings: BIND, command: BIND, status: BIND,
  history: BIND, localShell: BIND, viewer: BIND, presentation: BIND, submission: BIND,
  artifacts: BIND, pluginManager: BIND, submissionRuntime: BIND,
  // A5b-5: the application-event owner + the client-local platform owner are
  // constructed in the composition root (owner-construction-or-bind).
  applicationEvents: BIND, clientActions: BIND,
  // Narrow owner-to-owner connectors (incl. the late-bound viewed-queue slot).
  agentNow: CONN, handleNow: CONN, captureMatches: CONN, isCurrentOwnerAgent: CONN,
  directAgentOfOwner: CONN, requireLiveScope: CONN, viewedQueueAgent: CONN,
  // Mount / dispose / fatal coordination.
  disposeSurface: DISC, registerRunnerDisposal: DISC,
  // Residual work (A5b-5 / A5b-6): the shrink-only ledger this matrix pins.
  surfaceEvents: SURF, runClipboardCommand: SURF, clipboardEnv: SURF, runCopyCommand: SURF,
  copyEnv: SURF, openRewindPicker: SURF,
  attachmentRefusal: SUB, commandSubmitAttachments: SUB, submissionPlacement: SUB,
  submissionWriterSection: SUB,
}
const ALLOWED = new Set([HOST, PRE, BIND, START, CONN, DISC, SURF, SUB,
  'MUST_MOVE:app-command', 'MUST_MOVE:app-session', 'MUST_MOVE:app-direct',
  'CLIENT_LOCAL_HELPER_ALREADY_OWNED'])
// Curated lifecycle / minimum-capability evidence. Required for every
// MUST_MOVE row and every non-trivial KEEP connector; other KEEP rows document
// their category by classification.
const LIFECYCLE = {
  surfaceEvents: 'mount-owned: installed by surface.start(), disposed with the surface',
  runClipboardCommand: 'process-lifetime: created once at startup',
  clipboardEnv: 'process-lifetime: immutable client policy',
  runCopyCommand: 'process-lifetime: immutable client executor',
  copyEnv: 'process-lifetime: immutable client policy',
  openRewindPicker: 'per-gesture action (status/presentation reads)',
  submissionWriterSection: 'per-write: scope-fenced async section',
  agentNow: 'live read, per call (exact Direct attachment)',
  handleNow: 'live read, per call (exact Direct handle)',
  directAgentOfOwner: 'live read, per call (owner → attachment)',
  isCurrentOwnerAgent: 'live read, per call (currentness check)',
  captureMatches: 'live read, per call (ownership subject fence)',
  requireLiveScope: 'per-write admission seam (scope capture or throw)',
  viewedQueueAgent: 'late-bound slot: written by the viewer owner, read by the Direct runtime',
  compose: 'process-lifetime: created once at startup (Direct compose wrapper)',
  lifecycleAgents: 'process-lifetime: immutable create/open bridge bound to the runner signal',
}
const CAPABILITIES = {
  surfaceEvents: 'SubmissionController, CommandSurface, presentation/status/settings owners, SurfaceRuntime, extension semantic hooks, lifecycle/exit callbacks (A5b-5: app/surface/application-events.ts; must not become a callback bag)',
  runClipboardCommand: 'client-local clipboard policy only (no Host port)',
  clipboardEnv: 'client-local clipboard environment (no Host port)',
  runCopyCommand: 'client-local copy executor (no Host port)',
  copyEnv: 'client-local copy environment (no Host port)',
  openRewindPicker: 'presentation/status owner reads (rewind candidates)',
  submissionWriterSection: 'SessionScopeAuthority.captureLive + SubmissionRuntime.withWriter',
  agentNow: 'DirectApplicationRuntime.owners.currentDirectAttachment',
  handleNow: 'DirectApplicationRuntime owner attachment handle',
  directAgentOfOwner: 'DirectApplicationRuntime.owners.attachmentOf',
  isCurrentOwnerAgent: 'DirectApplicationRuntime.owners.currentDirectAttachment',
  captureMatches: 'SessionOwnershipCore.captureSubject',
  requireLiveScope: 'SessionScopeAuthority.captureLive/requireLive',
  viewedQueueAgent: 'viewer publishQueueAuthority + Direct runtime getViewedQueueAgent',
  compose: 'DirectApplicationRuntime.compose',
  lifecycleAgents: 'Backend.sessionLifecycle create/open through the runner signal',
}
// ── A5b-6 zero-assumption sweep verdict (plan §7.6.1 / §7.6.3) ───────────────
// Every remaining root declaration was re-checked from zero assumptions: the
// `sweep` is the verdict, `sweepNote` is the concrete §7.6.1 justification
// (category + evidence, using the row's callers/lifecycle/capabilities). A row
// without a note ABORTS generation, so no keep can be silent. This makes the
// audit reproducible: `--check` guards every verdict.
const SWEEP_VERDICT = 'verified@a5b6'
const SWEEP_NOTES = {
  // host-service-resolution: ctx.get(...) required to construct owners / wire
  // the surface (plan §7.6.4).
  agents: 'ctx.get(agents) Host registry resolved for the Direct owner registry/attachment reads; owner-construction input (plan §7.6.4).',
  defaultModel: 'ctx.get(agentDefaultModel) Host model service injected into the Direct runtime; owner-construction input.',
  sessions: 'ctx.get(sessions) Host session registry read by the Direct/surface seams; owner-construction input.',
  settingsForms: 'ctx.get(settings) SettingsForms service turned into the DirectTuiSettings facade and the settings owner.',
  tools: 'ctx.get(tools) Host tool registry read by the presenter connector.',
  present: 'toolPresenterFrom over the live Agent plus the tools registry; narrow Host read for presentation.',
  jobs: 'ctx.get(jobs) Host job registry forwarded to surface.attachTasks; narrow list/get/kill reads only.',
  subagents: 'ctx.get(subagents) Host subagent registry forwarded to surface.attachTasks; narrow descendant reads only.',
  assistantStreamHandle: 'directRuntime.installAssistantStream handle plus the abort listener; Direct install coordination.',
  disposeCredentialSubscription: 'credentials.onChanged subscription handle disposed on abort; Host event wiring (thin delegation).',
  // process-cordis-prerequisite: process/Cordis lifetime input or boot state the
  // first compose needs (plan §7.6.1).
  tuiSettings: 'DirectTuiSettings facade over config plus SettingsForms; process-lifetime config prerequisite.',
  persistedTuiSettings: 'one boot-time settings document snapshot; drives display/progress/response resolution before the first compose.',
  displayResolution: 'resolveDisplayPreset boot result resolved before the first compose (plan §8.4 ordering).',
  displayState: 'DisplayState holder constructed once and injected into Direct compose/surface/command; bootstrap does not mutate it.',
  progressUpdatesState: 'ProgressUpdatesState holder constructed once before the first compose and injected; no bootstrap state machine.',
  responseStyleState: 'ResponseStyleState holder constructed once before the first compose and injected; no bootstrap state machine.',
  launchPreset: 'startup.presetId / DSH_PI_TUI_PRESET resolution; startup input (process prerequisite).',
  pendingPreset: 'late-bound preset chosen during startup/resume; startup orchestration prerequisite.',
  resumeFailure: 'resume failure message shown post-mount then cleared; startup/resume transaction state.',
  handle: 'resumed SessionHandle held across the resume transaction; startup/resume orchestration state.',
  resumeResolved: 'resume transaction resolved flag; startup/resume orchestration state.',
  initialSnapshot: 'prefetched catalog snapshot installed at registration; startup prefetch (plan §7.6.4).',
  initialSkills: 'prefetched skill catalog installed at registration; startup prefetch.',
  surfaceNotice: 'deferred startup notice shown once post-mount then cleared; startup prerequisite.',
  viewerRef: 'late-binding reference to the viewer owner for the Direct queue resolver; lifetime seam, not viewer state.',
  cwd: 'process.cwd() client composition fact injected into owners as a value (execution-notes item 4).',
  cleanedUp: 'runner disposal flag owned by the composition root; lifetime prerequisite.',
  app: 'the mounted TuiApp assigned once by surface.start; process-lifetime reference.',
  extensionService: 'Host extension service resolved for surface.attachExtensionHost; process prerequisite.',
  signal: 'lifecycleController.signal abort signal; process lifetime.',
  draftImages: 'per-TUI draft image store created once and injected; client input buffer, not a §7.6.2 named state category.',
  draftFiles: 'per-TUI draft file store created once and injected; client input buffer, not a §7.6.2 named state category.',
  assistantStreamBaselineFor: 'late-bound assistant-stream baseline getter installed by the Direct runtime; capability slot, not viewer state.',
  startupAgent: 'agentNow() snapshot deciding the resume vs deferred startup surface; startup orchestration.',
  flushTurn: 'turn-persistence hook invoked by the surface routing; Direct/domain persistence seam.',
  // owner-construction-or-bind: the owner factories the composition root binds
  // exactly once (plan §7.6.4, test/a5b-bootstrap-closure OWNER_CONSTRUCTIONS).
  ownership: 'createSessionOwnershipCore(...) — the ONE ownership authority (plan §7.6.4).',
  sessionScope: 'createSessionScopeAuthority(...) — the ONE live-scope authority (plan §7.6.4).',
  submissionRuntime: 'late-bound SubmissionRuntime slot assigned by bindSubmissionRuntime; sole writer/admission owner.',
  surface: 'createSurfaceRuntime(...) — the ONE mounted-surface owner (plan §7.6.4).',
  directRuntime: 'createDirectApplicationRuntime(...) — the Direct composition runtime.',
  model: 'createModelSelectionOwner<ModelSelection>(...) — the A5b-3b model-selection owner.',
  sessionRuntime: 'bindSessionRuntime(...) — the bound session runtime owner.',
  backend: 'directRuntime.backend — the semantic Backend port bundle.',
  settings: 'createSettingsRuntime(...) — the A5b-2b settings/footer/display owner.',
  presentation: 'createSessionPresentation(...) — the A5b-1 live-session presentation owner.',
  clientActions: 'createClientActions() — the A5b-5 client-local platform owner.',
  applicationEvents: 'late-bound ApplicationEventsOwner slot assigned by createApplicationEvents (A5b-5 adapter).',
  command: 'createCommandSurface<...>(...) — the A5b-3 command authority/facade owner.',
  status: 'createStatusRuntime(...) — the A5b-2a status/context-measurement owner.',
  history: 'createInputHistory(...) — the A5b-2c input-history owner.',
  localShell: 'createLocalShell<Agent>(...) — the A5b-4b local-shell owner; reads the controller through late-bound withWriterSection.',
  viewer: 'createViewerRuntime<SessionEvent, Agent>(...) — the A5b-1 viewer owner; the A5b-6 move made it own the published queue authority slot.',
  submission: 'createSubmissionController<Agent>(...) — the A5b-4a submission/input owner; the A5b-6 move made it own withWriterSection.',
  artifacts: 'createArtifactSaveOwner<Agent>(...) — the A5b-3c artifact-save owner.',
  pluginManager: 'surface.attachPluginManager(...) result — the ONE plugin-manager owner handle.',
  // owner-connector: a narrow, late-bound composition-to-owner seam (plan
  // §7.6.1).
  requireLiveScope: 'sessionScope.captureLive plus throw; synchronous admission connector into owners.',
  agentNow: 'directRuntime.owners.currentDirectAttachment() — exact Direct attachment read per call.',
  handleNow: 'ownership.owner plus directRuntime.owners.handleOf — exact owner handle read per call.',
  captureMatches: 'ownership.owner/isSubjectCurrent — ownership subject fence connector.',
  isCurrentOwnerAgent: 'ownership.owner plus directRuntime attachmentOf — exact identity connector.',
  directAgentOfOwner: 'directRuntime.owners.attachmentOf — owner-to-attachment connector.',
  compose: 'narrow wrapper over directRuntime.compose consumed by launchComposition; owner-to-owner connector, not a Host lookup (reclassified in the A5b-6 sweep).',
  lifecycleAgents: 'TuiCommandRunner agents create/open bridge over backend.sessionLifecycle; owner-to-owner connector (reclassified in the A5b-6 sweep).',
  // startup-resume-create-orchestration (plan §7.6.1).
  launchComposition: 'startup compose wrapper (compose plus failure capture); startup orchestration.',
  resumeQuiesce: 'sessionRuntime.publishResumedOwner(...) resume transaction step; startup/resume orchestration.',
  currentPreset: 'agentNow plus agentPresets resolve for the status projection; startup/resume read.',
  sessionBlank: 'semantic Session blank read for the startup surface; startup/resume orchestration.',
  currentWorkingFromLog: 'workingFromLog(snapshotEvents()) read for the compaction settle; runner-owned log read.',
  // mount-dispose-fatal-coordination (plan §7.6.1 / §7.6.4).
  disposeSurface: 'sequences owner disposal in the fixed order (plan §7.6.4); no policy of its own.',
  registerRunnerDisposal: 'ctx.effect cleanup registration; runner lifetime/disposal coordination.',
  requestExit: 'createExitController(...) — the ONE exit orchestration (dispose/fatal coordination; reclassified in the A5b-6 sweep).',
}
for (const row of rows) {
  row.classification = CLASSIFICATION[row.name] ?? ''
  if (row.classification === '') throw new Error(`unclassified root declaration: ${row.name}`)
  if (!ALLOWED.has(row.classification)) throw new Error(`unknown classification ${row.classification}`)
  row.owner = row.classification.startsWith('MUST_MOVE:') ? row.classification.slice('MUST_MOVE:'.length) : 'bootstrap'
  row.lifecycle = LIFECYCLE[row.name] ?? 'n/a (category documents ownership)'
  row.capabilities = CAPABILITIES[row.name] ?? (row.hostDependency ? 'Host/Direct-touching composition seam' : 'pure / owner capability')
  row.sweep = SWEEP_VERDICT
  row.sweepNote = SWEEP_NOTES[row.name] ?? ''
  if (row.sweepNote === '') throw new Error(`unverified root declaration (no A5b-6 sweep note): ${row.name}`)
  if ((row.classification.startsWith('MUST_MOVE:') || row.classification === CONN) && (row.lifecycle.startsWith('n/a') || row.capabilities === '')) {
    throw new Error(`${row.name} (${row.classification}) needs curated lifecycle + minimum capabilities`)
  }
}
// ── callers: the other root declarations whose text reads this name ────────
const declText = new Map()
{
  const sfText = sf
  let sr = null
  const find = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'startRunner') sr = node.initializer
    ts.forEachChild(node, find)
  }
  find(sfText)
  for (const stmt of sr.body.statements) {
    const names = []
    const bind = (nameNode) => { if (ts.isIdentifier(nameNode)) names.push(nameNode.text); else ts.forEachChild(nameNode, bind) }
    if (ts.isVariableStatement(stmt) || ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      if (ts.isVariableStatement(stmt)) for (const d of stmt.declarationList.declarations) bind(d.name)
      else if (stmt.name) names.push(stmt.name.text)
      else continue
    } else continue
    const text = source.slice(stmt.getStart(sfText), stmt.getEnd())
    for (const name of names) declText.set(name, text)
  }
}
// Root-level statements that are not declarations (owner construction calls,
// surface.start, mount wiring, ...) are callers too: label them by line.
const rootStatements = []
{
  let sr = null
  const find = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'startRunner') sr = node.initializer
    ts.forEachChild(node, find)
  }
  find(sf)
  for (const stmt of sr.body.statements) {
    if (ts.isVariableStatement(stmt) || ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue
    rootStatements.push({ line: lineOf(stmt), text: source.slice(stmt.getStart(sf), stmt.getEnd()) })
  }
}
for (const row of rows) {
  const re = new RegExp(`\\b${row.name.replace(/[$]/g, '\\$')}\\b`)
  const fromDecls = [...declText.entries()]
    .filter(([other, text]) => other !== row.name && re.test(text))
    .map(([other]) => other)
  const fromStatements = rootStatements.filter((st) => re.test(st.text)).map((st) => `root-statement@${st.line}`)
  row.callers = [...fromDecls, ...fromStatements].slice(0, 12)
}

const out = {
  generatedFrom: 'src/app/bootstrap.ts',
  // Freshness is tied to the SOURCE CONTENT, never to a commit SHA: a SHA moves
  // on unrelated commits, while this hash moves exactly when bootstrap does.
  sourceHash: `sha256:${createHash('sha256').update(source).digest('hex').slice(0, 16)}`,
  note: 'One row per root-scope declaration of startRunner(). classification is the ownership decision; UNCLASSIFIED rows are the A5b-6 worklist (must reach zero).',
  total: rows.length,
  rows,
}
if (process.argv.includes('--write')) {
  writeFileSync(ARTIFACT, JSON.stringify(out, null, 2))
  console.error(`wrote ${ARTIFACT} (${rows.length} declarations)`)
} else if (process.argv.includes('--check')) {
  const current = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
  // Provenance text is not freshness: compare everything else, including the
  // per-row lines/refs/hostDependency/head/tests/callers/lifecycle/capabilities/
  // classification/owner and the bootstrap content hash.
  const normalize = ({ generatedFrom: _generatedFrom, ...rest }) => rest
  const before = normalize(current)
  const after = normalize(out)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const stored = new Map(current.rows.map((r) => [r.name, JSON.stringify(r)]))
    const fresh = new Map(out.rows.map((r) => [r.name, JSON.stringify(r)]))
    const added = [...fresh.keys()].filter((n) => !stored.has(n))
    const removed = [...stored.keys()].filter((n) => !fresh.has(n))
    const changed = [...fresh.keys()].filter((n) => stored.has(n) && stored.get(n) !== fresh.get(n))
    console.error('matrix is STALE (regenerated content differs)')
    if (before.sourceHash !== after.sourceHash) console.error(`  bootstrap content changed: ${before.sourceHash} -> ${after.sourceHash}`)
    if (added.length) console.error(`  new declarations:   ${added.join(', ')}`)
    if (removed.length) console.error(`  gone declarations:  ${removed.join(', ')}`)
    if (changed.length) console.error(`  changed metadata:   ${changed.join(', ')}`)
    if (!added.length && !removed.length && !changed.length) console.error('  (only the source hash / top-level metadata differs)')
    console.error('run: node scripts/a5b-root-matrix.mjs --write')
    process.exit(1)
  }
  console.error(`matrix is current (${rows.length} declarations, ${out.sourceHash})`)
} else {
  const counts = new Map()
  for (const r of rows) counts.set(r.classification, (counts.get(r.classification) ?? 0) + 1)
  console.error(`declarations: ${rows.length}`)
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.error(`  ${v}\t${k}`)
  console.error('\nUNCLASSIFIED / heuristic-owner-construction rows (need curation):')
  for (const r of rows.filter((x) => x.classification.startsWith('MUST_MOVE')).slice(0, 60)) {
    console.error(`  ${r.lines}\t${r.classification}\t${r.name}`)
  }
}
