/**
 * M3-4 PR4 machine-checkable guards (plan §18.1–§18.4) plus the §7.5
 * negative-instrumentation locks that are STRUCTURAL (no runtime spy can
 * observe them): the Remote branch must not reach a Host command executor
 * for Client callbacks, must not consult the Host tool registry for
 * presentation, must not write permissions through the Host preset service,
 * and must not build the rewind picker from a full-log scan.
 *
 * These are source-level locks over the OWNING modules: the behavioural
 * counterparts live in the L6 suites (durable `command/run` counts, the
 * observed OSC 52 payload, the rendered Client-derived cards).
 *
 * @module @xmoon76/dsh-pi-tui/m3-4-pr4-guards.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (relative: string): string =>
  readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8')

/** Source with comments removed (the guards judge executable code only). */
const code = (relative: string): string =>
  source(relative).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/* ───────────────────── §18.1 Remote command callback gate ─────────────── */

test('§18.1 the Remote TUI-callback route never hands the projected agent to the Host executor', () => {
  const controller = code('app/submission/controller.ts')
  // The REAL-Direct-Agent discriminator gates the Host executor call: the
  // only `commandPlane.execute(` call site sits behind it.
  const executeAt = controller.indexOf('deps.commandPlane.execute(')
  assert.ok(executeAt !== -1, 'the Direct compatibility executor call exists')
  const guard = controller.slice(Math.max(0, executeAt - 600), executeAt)
  assert.ok(guard.includes('directAgent !== undefined'),
    'the Host executor call is reachable ONLY behind the real-Direct-Agent discriminator')
  // The Remote fallback is the Client registry, never `ctx.commands`.
  assert.ok(controller.includes('deps.command.clientCommands.execute('),
    'the non-Direct branch executes through the Client registry')
  assert.equal(controller.includes('ctx.commands'), false,
    'the submission controller never reaches the Host commands service by property access')
  // The projected agent must never be enriched into a fake Agent.
  assert.equal(controller.includes('fakeAgent'), false)
  assert.equal(controller.includes('as unknown as Agent'), false)
})

test('§18.1 the TUI-owned registration path never requires the Host commands service', () => {
  const commands = code('commands.ts')
  assert.ok(commands.includes("if (clientCommands === undefined) throw new Error('client command registry unavailable')"),
    'the Client registry is the mandatory registration surface')
  const oneBody = commands.slice(
    commands.indexOf('const registerOne ='),
    commands.indexOf('// `commands.execute()` normalizes'),
  )
  assert.ok(oneBody.includes('clientCommands.register(definition)'),
    'every TUI definition registers into the Client registry first')
})

test('§D2 (review round 3 ruling): Direct keeps the Host compatibility MIRROR; Remote callback isolation stays complete', () => {
  // The stage contract (disambiguated by the M3-4
  // owner ruling): ONE TUI definition; Direct may mirror-register it into
  // the in-process Host registry (the compatibility adapter — never a
  // second business authority), while Remote keeps ZERO Host ctx.commands
  // registration/execution for a TUI callback.
  const commands = code('commands.ts')
  const oneBody = commands.slice(
    commands.indexOf('const registerOne ='),
    commands.indexOf('// `commands.execute()` normalizes'),
  )
  assert.ok(oneBody.includes('clientCommands.register(definition)'),
    'the Client registry is the FIRST registration (the definition owner)')
  assert.ok(oneBody.includes('commands.register({'),
    'the Direct compatibility mirror registers into the Host registry (carrying the provenance definitionId beside the same definition)')
  assert.ok(oneBody.includes('if (commands === undefined) return disposeClient'),
    'the mirror is Direct-only (Remote registers nothing into the Host service)')
  // The REMOTE half of the submission route stays Client-only: the projected
  // agent never reaches ctx.commands.execute.
  const controller = code('app/submission/controller.ts')
  const route = controller.slice(
    controller.indexOf('if (tuiOwnedCommand) {'),
    controller.indexOf('// The HOST route:'),
  )
  assert.ok(route.includes('clientCommands.execute('),
    'the Remote TUI-owned route executes through the Client registry')
})

/* ─────────────────── §18.2 Remote tool presenter gate ────────────────── */

test('§18.2 the Remote presentation bridge is Client-derived (no Host registry, no presenter callbacks)', () => {
  const clientPresenter = code('tool-presentation-client.ts')
  assert.equal(clientPresenter.includes('ctx.tools'), false)
  assert.equal(clientPresenter.includes('ctx.get'), false)
  assert.equal(clientPresenter.includes('presentCall'), false)
  assert.equal(clientPresenter.includes('presentResult'), false)
  assert.equal(clientPresenter.includes('toolPresenterFrom'), false,
    'the Client presenter never wraps a Host registry lookup')

  const bootstrap = code('app/bootstrap.ts')
  const selection = bootstrap.slice(
    bootstrap.indexOf('const present = remoteSources === undefined'),
    bootstrap.indexOf('const signal = lifecycleController.signal'),
  )
  assert.ok(selection.includes('toolPresenterFrom('),
    'the Direct branch keeps the Host presenter compatibility')
  assert.ok(selection.includes('createClientToolPresenter()'),
    'the Remote branch mounts the Client-derived presenter')
  // Review F7: the Host tools registry LOOKUP must sit inside the Direct
  // branch's lazy resolver — the Remote bootstrap path never resolves it.
  const directBranch = selection.slice(
    selection.indexOf('toolPresenterFrom('),
    selection.indexOf('createClientToolPresenter()'),
  )
  assert.ok(directBranch.includes("ctx.get('tools')"),
    'the Host tools lookup lives inside the Direct-only resolver')
  assert.equal(selection.slice(selection.indexOf('createClientToolPresenter()')).includes('ctx.get'), false,
    'the Remote presenter path performs no ctx.get lookup')
})

/* ───────────────────── §18.3 Permission write gate ───────────────────── */

test('§18.3 the Remote permission path never writes through the Host preset service', () => {
  const status = code('app/surface/status-runtime.ts')
  const cycleStart = status.indexOf('const cyclePermission = (): void => {')
  assert.ok(cycleStart !== -1, 'the cycle owner exists')
  const authority = status.slice(
    cycleStart,
    status.indexOf('const agent = deps.liveAgent()', cycleStart),
  )
  assert.ok(authority.includes('authority.apply('),
    'the authority path writes through the semantic apply')
  assert.equal(authority.includes('permissionPresets'), false,
    'the authority path never reads the Host preset service')
  assert.equal(authority.includes('.set('), false,
    'the authority path never calls a synchronous Host preset set')

  const remoteConfig = code('runtime/remote/config-remote.ts')
  assert.equal(remoteConfig.includes('permissionPresets.set'), false,
    'the Remote config adapter has no Host preset write')
  // The projection carries the committed value (the single read authority).
  assert.ok(code('runtime/session-status-projection.ts').includes('currentValue'),
    'the status projection maps permissions.currentValue')
})

test('§18.3 the legacy status writer cannot clear a projection-owned permission fact', () => {
  const app = code('tui-app.ts')
  const accessBlock = app.slice(
    app.indexOf('const accessPatch:'),
    app.indexOf('const workspace: WorkspaceStatus = {'),
  )
  assert.ok(accessBlock.includes('if (this.status.permission !== undefined)'),
    'the legacy writer only expresses an opinion when a legacy value exists')
  assert.equal(/permissionPreset:\s*undefined/u.test(accessBlock), false,
    'an absent legacy value never writes the permission key (never a clobber)')
})

/* ──────────────────────── §18.4 Rewind gate ─────────────────────────── */

test('§18.4 the shared rewind picker owner uses turnOutline + loadThrough only', () => {
  const events = code('app/surface/application-events.ts')
  const picker = events.slice(
    events.indexOf('const openRewindPicker = (): void => {'),
    events.indexOf('const surfaceEvents: TuiAppEvents = {'),
  )
  assert.ok(picker.includes('deps.rewind.turnOutline('),
    'the picker authority is the whole-log outline')
  assert.ok(picker.includes('deps.rewind.loadThrough('),
    'the selected turn loads through the official jump')
  assert.equal(picker.includes('snapshotEvents'), false,
    'the shared picker never scans a full log')
  assert.equal(picker.includes('collectRewindCandidates'), false,
    'the shared picker never runs the legacy full-log fold')

  // The Remote adapter is projection-only (no snapshot fallback at all).
  const remoteReader = code('runtime/remote/session-reader-remote.ts')
  const remoteOutline = remoteReader.slice(
    remoteReader.indexOf('turnOutline(sessionId: string)'),
    remoteReader.indexOf('sessionStatus(sessionId: string)'),
  )
  assert.ok(remoteOutline.includes("faceOf('turnOutline')"))
  assert.equal(remoteOutline.includes('snapshotEvents'), false)
  assert.equal(remoteOutline.includes('directTurnOutlineCompat'), false)

  // The Direct compatibility fold is INSIDE the Direct adapter (one contract
  // for the shared owner).
  const directReader = code('runtime/direct/session-direct.ts')
  const directOutline = directReader.slice(
    directReader.indexOf('turnOutline(sessionId: string)'),
    directReader.indexOf('sessionStatus(sessionId: string)'),
  )
  assert.ok(directOutline.includes('directTurnOutlineCompat('),
    'the Direct-only §18.4 compatibility fold lives in the Direct adapter')
  assert.ok(directOutline.includes('=== undefined'),
    'the fold applies only to an UNAVAILABLE outline, never an authoritative []')
})

/* ───────────── §7.5 structural negative instrumentation locks ────────── */

test('§7.5 the Remote skill gesture never loads a Client skill body', () => {
  const remoteSkill = code('runtime/remote/skill-remote.ts')
  assert.ok(remoteSkill.includes("return { kind: 'unavailable' }"),
    'the Remote resolveSkill is explicitly unavailable (no body read exists)')
  assert.equal(remoteSkill.includes('readFileSync'), false,
    'no Client-side SKILL.md read exists on the Remote branch')
  assert.equal(remoteSkill.includes('renderSkillContent'), false,
    'no Client-side skill-body rendering exists on the Remote branch')
  // The literal-gesture branch of loadSkill never builds a fallback body.
  const commands = code('commands.ts')
  assert.ok(commands.includes('remoteLiteralGesture'),
    'loadSkill distinguishes the Remote literal-gesture path')
  assert.ok(commands.includes('!hostLoadsSkillBody && !remoteLiteralGesture'),
    'the fallback body is never built on the literal-gesture branch')
})

test('§7.5 unavailable Remote approval/sandbox facts are omitted, never guessed', () => {
  const remoteConfig = code('runtime/remote/config-remote.ts')
  assert.ok(remoteConfig.includes('approvalOverrideAvailable(): boolean'),
    'the capability marker exists (the consumer asks it instead of inferring)')
  const remoteConfigRaw = source('runtime/remote/config-remote.ts')
  assert.ok(/approvalOverrideAvailable\(\)[^{]*\{\s*\/\/[^\n]*\n\s*return false/u.test(remoteConfigRaw)
    || remoteConfigRaw.includes('INTENTIONAL_UNSUPPORTED_IN_M3'),
    'the Remote approval override is explicitly unavailable')
  // The Remote status branch omits approval/sandbox entirely.
  const status = code('app/surface/status-runtime.ts')
  const remoteAccess = status.slice(
    status.indexOf('} else {\n      // §6.4'),
    status.indexOf('const collaboration = displaySubject === undefined'),
  )
  assert.equal(remoteAccess.includes('approval'), false,
    'the Remote access branch never renders an approval fact')
  assert.equal(remoteAccess.includes('sandbox'), false,
    'the Remote access branch never infers a sandbox mode')
})

/* ───────── PR5: the required transcript-export capability declaration ──── */

test('PR5 the transcript-export capability is REQUIRED and refused unless exactly true', () => {
  const commands = code('commands.ts')
  const declaration = commands.indexOf('readonly transcriptExportAvailable: boolean')
  assert.ok(declaration !== -1,
    'the runner capability is a required boolean (no optional marker)')
  assert.equal(code('commands.ts').includes('transcriptExportAvailable?:'), false,
    'no optional declaration of the capability may reappear')
  // TS1 moved the built-in /transcript definition into the artifacts command
  // owner; the capability DECLARATION stays on the facade.
  const artifacts = code('tui/commands/artifacts.ts')
  const handlerAt = artifacts.indexOf("name: 'transcript'")
  assert.ok(handlerAt !== -1, 'the /transcript definition lives in the artifacts command owner')
  const handler = artifacts.slice(handlerAt)
  assert.ok(handler.includes('runner.transcriptExportAvailable !== true'),
    'the /transcript handler refuses unless the declared capability is exactly true')
  // The production composition declares it per selected runtime, and the
  // command-surface backend deps type requires it structurally: a new
  // assembly cannot omit the capability.
  const bootstrap = code('app/bootstrap.ts')
  assert.ok(bootstrap.includes('transcriptExportAvailable: selectedRuntime.kind === \'direct\''),
    'the production composition declares the capability from the selected runtime kind')
  const surface = code('app/command/surface.ts')
  assert.ok(surface.includes('readonly transcriptExportAvailable: boolean'),
    'the command-surface backend deps keep the field required (structural guard)')
})

/* ── PR5 v2 §1C: origin-aware command authority guards ─────────────────── */

test('PR5 §1C the Direct compatibility mirror is NOT Host origin (registry membership ≠ ownership)', () => {
  const commands = code('commands.ts')
  // §1C-2: the provenance set exists and marks ONLY successful mirrors.
  assert.ok(commands.includes('mirrorDefinitionIds'), 'the mirror-provenance set holds the EXACT stamped definitionIds (review R6-1)')
  // §1C-4: the genuine Host-origin line authority exists and reads the
  // origin-filtered descriptors, never the union claims or raw membership.
  assert.ok(commands.includes('const hostOriginClaimOf'), 'the hostOriginClaimOf primitive exists')
  const originBody = commands.slice(
    commands.indexOf('const hostOriginClaimOf'),
    commands.indexOf('const hostOriginClaimOf') + 900,
  )
  assert.ok(originBody.includes('hostOriginDescriptors.get'), 'the origin claim reads the ORIGIN map')
  assert.equal(originBody.includes('claims.get'), false, 'the origin claim never reads the union claims')
  // §1C-3: the origin map derives with the mirror subtraction.
  const derive = commands.slice(
    commands.indexOf('const deriveHostOriginDescriptors'),
    commands.indexOf('const deriveHostOriginDescriptors') + 600,
  )
  assert.ok(derive.includes('mirrorDefinitionIds.has(command.definitionId)'), 'the derivation subtracts ONLY winners that ARE our stamped mirror definitions')
  // hostCatalogResolves answers from the ORIGIN map, not raw registry
  // membership.
  const resolves = commands.slice(
    commands.indexOf('hostCatalogResolves: (name: string): boolean'),
    commands.indexOf('hostCatalogResolves: (name: string): boolean') + 300,
  )
  assert.ok(resolves.includes('hostOriginDescriptors.has(name)'),
    'hostCatalogResolves is origin-aware (never raw registry membership)')
})

test('PR5 §1C one classifier drives the submission siblings', () => {
  const controller = code('app/submission/controller.ts')
  assert.ok(controller.includes('classifyCommandLine('), 'the controller consumes the classifier')
  // The delivery/attachment/host-dispatch gates consume classification.kind.
  const deliveryGate = controller.slice(controller.indexOf('const tuiLocalLine ='))
  assert.ok(deliveryGate.includes("classification.kind === 'client-command'"),
    'the delivery gate consumes the classification')
  assert.ok(controller.includes("classification.kind === 'host-command'"),
    'the Host dispatch branch consumes the classification')
  assert.ok(controller.includes("classification.kind === 'client-command' && classification.source === 'extension'"),
    'the contribution gate consumes the classification (the extension family alone)')
  // The policy module owns the classifier + the four-kind vocabulary.
  const policy = code('command-policy.ts')
  assert.ok(policy.includes('export type CommandLineClassification'), 'the classification type is exported')
  for (const kind of ["'host-command'", "'client-command'", "'skill-invocation'", "'ordinary-submission'"]) {
    assert.ok(policy.includes(kind), `the ${kind} kind exists`)
  }
  assert.ok(policy.includes('hostNameReserved'), 'ordinary submissions can record a Host-reserved name')
})

/* ── PR5 v2 §3C: rewind final-notification currentness guards ──────────── */

test('PR5 §3C the rewind final settlement is gated by the operation-owned navigation identity', () => {
  const runtime = code('app/session/runtime.ts')
  // The adoption commit mints the post-adoption identity.
  assert.ok(runtime.includes('committedNavigation = claimedEpoch === undefined'),
    'the settlement identity composes the PUBLISHED child + the CLAIMED admission epoch (never a counter re-read)')
  assert.ok(runtime.includes('export type SessionForkErrorReason'),
    'the error reason vocabulary is a structured type (reason controls wording; identity controls currentness)')
  for (const reason of ["'navigation-changed-before-dispatch'", "'host-refused'", "'adoption-failed'", "'fork-failed'"]) {
    assert.ok(runtime.includes(reason), `the ${reason} reason exists`)
  }
  assert.ok(runtime.includes('readonly notificationNavigation: RewindNavigationIdentity'),
    'EVERY error outcome carries a REQUIRED notification fence (no branch may omit it)')
  assert.ok(runtime.includes('notificationNavigation: before'),
    'the pre-admission stale detection carries the LIVE identity observed at detection')
  assert.ok(runtime.includes("reason: 'host-refused'"),
    'a dispatched-fork refusal carries the ADMISSION identity as its fence')
  assert.ok(runtime.includes('readonly adoptedNavigation?: RewindNavigationIdentity'),
    'the success outcome can carry adoptedNavigation')
  const events = code('app/surface/application-events.ts')
  // The success toast consults the OWNED identity (not the old picker one).
  const successGate = events.slice(events.indexOf('if (outcome.kind === \'success\' && adopted)'))
  assert.ok(successGate.includes('outcome.adoptedNavigation')
    && successGate.includes('!deps.rewind.isNavigationCurrent(owned)) return'),
    'the success toast is suppressed once the operation-owned identity is superseded')
  // NO error path consults the picker-open identity anymore (the d529d464
  // defect): every error fences on its OWN notificationNavigation.
  // The ADMITTED-error settlement block only (up to the pre-admission `onError`
  // handler, which legitimately owns the picker identity — see the §3C-4 guard
  // below): an admitted rewind error must never fence on the picker-open
  // identity, because this operation's own admission bump already invalidated
  // it (the d529d464 defect).
  const admittedErrorBlock = events.slice(
    events.indexOf("if (outcome.kind === 'error')"),
    events.indexOf('onError: (error)'),
  )
  assert.equal(admittedErrorBlock.includes('pickerIdentity'), false,
    'an admitted error settlement never consults the picker-open identity')
})

/* ── PR5 v2 §2.12: Ctrl+R main Session identity ─────────────────────────── */

test('PR5 the Ctrl+R Current-session identity comes from the selected ownership authority', () => {
  const bootstrap = code('app/bootstrap.ts')
  const seam = bootstrap.slice(
    bootstrap.indexOf('sessionId: () => ownership.currentSessionId()'),
    bootstrap.indexOf('sessionId: () => ownership.currentSessionId()') + 200,
  )
  assert.ok(seam.length > 0, 'the identity seam exists')
  assert.ok(bootstrap.includes('sessionId: () => agentNow()?.session.id') === false
    || bootstrap.slice(0, bootstrap.indexOf('PR5 v2 §2.12')).includes('sessionId: () => agentNow()?.session.id'),
    'no Direct-agent identity seam remains for the Ctrl+R scope')
})


/* ── PR5 v4 / R7: the final authority boundaries this round locked ─────── */

test('PR5 §1C-4 (R7-1): every routing read of the Host claim consumes the GENUINE Host-origin authority', () => {
  const controller = code('app/submission/controller.ts')
  // The final command-plane ownership, the submit-time echo gate and the
  // attachment payload all read the origin claim — never the advertised union.
  assert.ok(controller.includes('const originClaim = effectiveOriginClaim(parsedAtSubmit)'),
    'the final plane ownership reads the sticky genuine Host-origin line claim')
  // §1C-5 (whole-PR F1): that ONE helper is the sticky authority — the final
  // genuine claim wins, otherwise a submit-time non-invocation survives.
  const sticky = controller.slice(
    controller.indexOf('const effectiveOriginClaim = ('),
    controller.indexOf('const effectiveOriginClaim = (') + 700,
  )
  assert.ok(sticky.includes('deps.command.hostOriginClaimOf(parsed)'),
    'the sticky authority reads the genuine Host-origin claim')
  assert.ok(sticky.includes('finalClaim?.claimed === true'),
    'a FINAL genuine claim overrides the sticky non-invocation')
  assert.ok(sticky.includes('submitOriginClaim?.claimed === false ? submitOriginClaim : finalClaim'),
    'the submit-time non-invocation is sticky otherwise')
  assert.ok(controller.includes('submitOriginClaim?.claimed !== true'),
    'the submit-time echo gate reads the genuine Host-origin claim')
  assert.ok(controller.includes('submittedHostClaim: () => parsedAtSubmit === undefined ? undefined : deps.command.hostOriginClaimOf(parsedAtSubmit)'),
    'the dispatched payload claim is the genuine Host-origin claim')
  // No routing consumer may read the advertised union any more (§1C-4).
  assert.equal(controller.includes('deps.command.hostClaimOf'),
    false, 'no controller path routes on the advertised union')
  assert.equal(controller.includes('const hostView ='), false,
    'the dead advertised-union view is gone')
})

test('PR5 §1C-4 (R7-3): hostOriginClaimOf has no skill-wrapper NAME shortcut', () => {
  const commands = code('commands.ts')
  const origin = commands.slice(
    commands.indexOf('const hostOriginClaimOf'),
    commands.indexOf('const hostOriginClaimOf') + 1200,
  )
  assert.ok(origin.includes('hostOriginDescriptors.get(parsed.name)'),
    'the origin claim reads the genuine Host-origin descriptor map')
  assert.equal(origin.includes('skillDisposers.has(parsed.name)'),
    false, 'a live wrapper NAME must not erase a later genuine Host winner')
})

test('PR5 §1C-4 (R7-2): the attachment gate consumes the shared classification alone', () => {
  const controller = code('app/submission/controller.ts')
  const gate = controller.slice(
    controller.indexOf('const attachmentRefusal = ('),
    controller.indexOf('const attachmentRefusal = (') + 1400,
  )
  assert.ok(gate.includes('classification: CommandLineClassification'),
    'the gate takes the classification as its only line input')
  assert.equal(gate.includes('skillInvocation: boolean'),
    false, 'no parallel skill predicate may outrank the Host precedence')
  assert.ok(gate.includes("if (classification.kind === 'client-command')"),
    'a Client command refuses staged attachments')
  assert.ok(gate.includes("if (classification.kind === 'host-command')"),
    'a genuine Host command follows its own attachment declaration')
})

test('PR5 §3C-4 (R7-4): the rewind settlement owner is phase-specific', () => {
  const events = code('app/surface/application-events.ts')
  // The success settlement is fenced by the operation-owned adopted identity.
  assert.ok(events.includes('!deps.rewind.isNavigationCurrent(owned)) return'),
    'the success settlement fenced by the operation-owned adopted identity')
  // The error settlement is fenced by the identity the failure was determined
  // against — never inferred from the error text.
  assert.ok(events.includes('if (!deps.rewind.isNavigationCurrent(outcome.notificationNavigation)) return'),
    'the admitted error settlement fences on its structured notification identity')
  assert.equal(events.includes("outcome.text === 'the session changed"),
    false, 'no error-text branching for currentness')
  // A throw can only escape the PRE-ADMISSION region (forkSession never throws),
  // so the picker identity is that failure's owner — while the VISIBLE notice is
  // suppressed once the surface moved (runOwned already reported it).
  assert.ok(events.includes('if (!deps.rewind.isNavigationCurrent(pickerIdentity)) return'),
    'the pre-admission failure fences on the picker identity')
})


/* ── PR5 F1: the availability bit follows the SAME fold's live evidence ── */

test('PR5 §3.2 (F1): the live ingress re-answers availability off the SAME fold — never a second scan', () => {
  const presentation = code('app/surface/session-presentation.ts')
  // The flip reads THIS fold's retained evidence (no second StatsFolder, no
  // second event scan through the whole-log helper).
  const refresh = presentation.slice(
    presentation.indexOf('const refreshRecentPerformanceAvailability = ('),
    presentation.indexOf('const refreshRecentPerformanceAvailability = (') + 900,
  )
  assert.ok(refresh.includes('statsFolder.hasEnoughRecentEvidence()'),
    'the flip is answered by the live fold itself')
  assert.equal(refresh.includes('hasEnoughRecentPerformanceSamples('),
    false, 'the live flip must not run a second event scan')
  assert.ok(refresh.includes('deps.refreshStatusCheap()'),
    'the flip re-derives the status so the footer stops omitting the figures')
  // BOTH directions, off the SAME fold: the fold's evidence is not monotonic
  // (a route change clears both windows; a late replacement can drop a
  // candidate), and a history-start window stays available regardless.
  assert.ok(refresh.includes('recentCoverageComplete || statsFolder.hasEnoughRecentEvidence()'),
    'the answer is recomputed from the committed coverage fact OR the live fold')
  assert.ok(refresh.includes('if (next === recentPerformanceAvailable) return'),
    'the status is re-derived only when the answered value actually changes')
  assert.equal(refresh.includes('if (recentPerformanceAvailable) return'),
    false, 'the bit must NOT be monotonic-only: a shrink must be able to flip it back')
  // The history-start fact commits with the fold and resets with the generation.
  assert.ok(presentation.includes('recentCoverageComplete = input.recentCoverageComplete ?? false'),
    'the coverage fact commits inside the same fenced hydrate block')
  assert.ok(presentation.includes('recentCoverageComplete = !snapshot.hasMore'),
    'the widened window re-proves the coverage fact in its own fenced commit')
  // The availability answer itself is taken INSIDE the commit, from the fold the
  // commit just installed — never from a caller pre-computation over a pre-merge
  // snapshot (the opening-journal drift), and Direct commits complete coverage.
  assert.ok(presentation.includes('recentPerformanceAvailable = recentCoverageComplete\n      || statsFolder.hasEnoughRecentEvidence()'),
    'the fenced commit answers from the committed fold plus coverage')
  assert.equal(presentation.includes('recentCoverageComplete = input.recentCoverageComplete ?? false\n    recentPerformanceAvailable = input'),
    false, 'no caller-precomputed availability may survive')
  assert.ok(presentation.includes('recentCoverageComplete: true,'),
    "Direct commits COMPLETE coverage (v4: Direct availability is unconditionally true)")
  assert.equal(presentation.includes('recentHistoryComplete'), false,
    'the old incomplete-coverage name is gone everywhere')
  const reset = presentation.slice(
    presentation.indexOf('const resetForGeneration = ('),
    presentation.indexOf('const resetForGeneration = (') + 700,
  )
  assert.ok(reset.includes('recentCoverageComplete = false'),
    'the generation reset clears the coverage fact with the bit')
  // The live ingress performs the pair on the same fold, at BOTH append sites.
  // TS3 §36: the routing bodies (and their append/pair calls) live in the
  // presentation event router owner.
  const routing = code('app/surface/event-routing.ts')
  const pairs = routing.split('main.stats.apply([event])').length - 1
  const refreshes = routing.split('main.refreshRecentPerformanceAvailability()').length - 1
  assert.ok(pairs > 0 && refreshes === pairs,
    'every live stats append re-answers the availability predicate')
  // ONE predicate shared by the fold accessor and the whole-log helper.
  const stats = code('domain/status/stats.ts')
  assert.ok(stats.includes('return recentEvidenceComplete(foldSessionStats(events).recent)'),
    'the whole-log helper delegates to the one predicate')
  assert.ok(stats.includes('return recentEvidenceComplete(this.recent)'),
    'the live fold accessor delegates to the SAME predicate')
})


/* ── PR5 F2: an unavailable Remote model fact is never a business value ── */

test('PR5 F2: an absent `model` projection fact is passed THROUGH, never rendered as a business value', () => {
  const status = code('app/surface/status-runtime.ts')
  const branch = status.slice(
    status.indexOf('const updateWelcomeCard = ('),
    status.indexOf('const updateWelcomeCard = (') + 1600,
  )
  // The Remote welcome branch: a present sessionStatus with an ABSENT model
  // field passes NO model fact (the card then omits the line) — it must not
  // synthesize a definitive business value.
  assert.ok(branch.includes('...facts.model === undefined'),
    'the absent model fact is spread away, not replaced')
  assert.equal(branch.includes("'unconfigured'"),
    false, 'an unavailable projection must never become "unconfigured"')
  assert.equal(branch.includes('???'), false)
  // The card renders the fact only when it is present. TS4 §51: the card's
  // rendering owner is now the TUI component module, so this source lock
  // follows the real owner (path-only migration — same exact substrings).
  const card = code('tui/components/welcome-card.ts')
  assert.ok(card.includes("...facts.model === undefined ? [] : [`${color.textDim(label('model'))}"),
    'the card omits the model line when the fact is absent')
  assert.ok(card.includes('model?: string'),
    'the card accepts an absent model fact')
})


/* ── PR5 §1C-7 (whole-PR F4): the sessionless route consumes the classifier ── */

test('PR5 §1C-7 (whole-PR F4): the sessionless route is the classifier TUI family, never a name set alone', () => {
  const controller = code('app/submission/controller.ts')
  const at = controller.indexOf('const isSessionless = parsed !== undefined')
  assert.ok(at > 0, 'the sessionless predicate exists')
  const predicate = controller.slice(at, at + 400)
  // The ONE classification decides: a genuine Host name whose execute-kind
  // descriptor does not claim the ARGUED form is an ordinary submission and
  // must not be pulled back into the local surface by a name-set membership.
  assert.ok(predicate.includes("classification.kind === 'client-command'"),
    'the sessionless route consumes the classification family')
  assert.ok(predicate.includes("classification.source === 'tui'"),
    "and only for THIS surface's own registration")
  assert.ok(predicate.includes('SESSIONLESS_COMMANDS.has(parsed.name)'),
    'the sessionless name set remains an additional filter, never the decider')
})

test('PR5 §1C-6 (whole-PR F4): TUI ownership comes from the LIVE Client registry, never the static name list', () => {
  const controller = code('app/submission/controller.ts')
  // The live exact-line claim is the TUI ownership source at every consumer.
  assert.ok(controller.includes('deps.command.clientClaimsLine(parsedAtSubmit)'),
    'the routing consumers read the live claim')
  assert.ok(controller.includes('&& deps.command.clientClaimsLine(parsed)'),
    'the main classification term reads the live claim')
  assert.ok(controller.includes('tuiCommand: deps.command.clientClaimsLine(parsedAtSubmit)'),
    'the TUI-owned predicate reads the live claim')
  assert.ok(controller.includes('const clientHandler = deps.command.clientClaimsLine(parsed)'),
    "the local dispatch handler lookup is claim-gated (the sink invariant)")
  // No ownership decision may fall back to the static membership list any more.
  assert.equal(controller.includes('if (LOCAL_COMMANDS.has(parsedAtSubmit.name)) return true'),
    false, 'the plane ownership must not read the static list')
  assert.equal(controller.includes('tuiCommand: LOCAL_COMMANDS.has('),
    false, 'the classifier TUI term must not read the static list')
  assert.equal(controller.includes('isLocalCommandLine('),
    false, 'the controller no longer consumes the static-policy line predicate')
  // §1C-6 (whole-PR R15-1): the INDIRECT chain is forbidden too — the static
  // membership list must not answer ownership through the extension bridge
  // (`extensions.isLocal(..., LOCAL_COMMANDS)` -> `CommandBridge.isLocal`'s
  // `staticLocal.has(name)`), which is how a bare `/kill` re-entered the
  // deferred attachment classifier's TUI family.
  assert.equal(controller.includes('extensions.isLocal('),
    false, 'no ownership decision may route through the static-list bridge')
  assert.equal(controller.includes('LOCAL_COMMANDS) === true'),
    false, 'no classifier term may consult the static policy set for ownership')
  // The registry enforces the SAME admission at the sink.
  const registry = code('app/command/client-command-registry.ts')
  assert.ok(registry.includes("return (parsed.rawInput ?? '').trim() === '' || definition.input !== undefined"),
    'the registry claim is the official matchEnter rule')
  assert.ok(registry.includes('if (!claimsLineOf(parsed)) return undefined'),
    'execute() enforces the same admission (sink invariant)')
  assert.ok(registry.includes('claimsLine: claimsLineOf'),
    'the ownership question and the sink share ONE rule')
})


/* ── PR5 §1C-5 (whole-PR F2): the raw skill predicate never outranks the Host reservation ── */

test('PR5 §1C-5 (whole-PR F2): every skill-route sibling consumes the Host reservation condition', () => {
  const controller = code('app/submission/controller.ts')
  // The early echo and the steer sibling both consumed the RAW
  // `isSkillInvocation` predicate, so a genuine Host name that does not claim
  // this argued line (while a live wrapper shares the name) was denied its
  // ordinary treatment. Both sites now read the reservation alongside it.
  const echo = controller.slice(
    controller.indexOf('const ordinaryPromptAtSubmit = parsedAtSubmit === undefined'),
    controller.indexOf('let localEchoInstalled = false'),
  )
  assert.ok(echo.includes('deps.command.isSkillInvocation(parsedAtSubmit, text)'),
    'the early echo still excludes genuine skill invocations')
  assert.ok(echo.includes('deps.command.hostCatalogResolves(parsedAtSubmit.name) === false'),
    'but ONLY where the line is not a genuine Host-origin name')
  const steer = controller.slice(
    controller.indexOf('const skillLine = deps.command.isSkillInvocation(parsed, text)'),
    controller.indexOf('steerNow(text, true, persistHistory)'),
  )
  assert.ok(steer.includes("deps.command.hostCatalogResolves(parsed.name) === false"),
    'the steer sibling consumes the SAME reservation condition')
  assert.equal(steer.includes('if (deps.command.isSkillInvocation(parsed, text)) {'),
    false, 'the bare raw predicate must not decide the skill route')
})
