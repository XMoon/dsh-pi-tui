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
    commands.indexOf('const registerOne = ('),
    commands.indexOf('// `commands.execute()` normalizes'),
  )
  assert.ok(oneBody.includes('clientCommands.register(definition)'),
    'every TUI definition registers into the Client registry first')
  assert.ok(oneBody.includes('if (commands === undefined) return disposeClient'),
    'the Host registration is the optional Direct compatibility half')
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
