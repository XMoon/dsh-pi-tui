/**
 * The APPLICATION-COMPOSED proof of the TSP input completion: the ONE seat that
 * answers the leading `/` command token, a Host `@` reference, a declared
 * `/attach` + `/image` path argument (leading and body/inline) and the inline
 * action/skill token.
 *
 * Every case drives the real production chain and asserts only what the user
 * can see on the wire or what a counted application callback recorded:
 *
 *   the REAL `registerTuiCommands` catalog commit + its provenance screen
 *     -> the composition root's `installTspCommandCompletions` seam
 *     -> the REAL `SurfaceRuntime.installTspCommandCompletions` forward
 *        (the mount's installer reference — no second catalog, no second claims)
 *     -> the REAL `mountTspRenderer` completion seat + the SAME installed
 *        provider factory the PiTui surface composes
 *     -> the shipped `@stencil-hq/tern` SDK over a scripted pane tty
 *     -> the controlled `ui.editor` wire `text`/UTF-16 `cursor`, the candidate
 *        rows the frames really carried, and the ONE application submit entry
 *        wired to the REAL `createSubmissionController`.
 *
 * The inline-attachment half composes the SAME single registration site the
 * production TSP Direct assembly uses:
 *
 *   `registerTuiCommands` -> `artifactCommands.inlineAttachmentStager()`
 *     -> `presentation.installTspInlineAttachmentStager`
 *     -> the composition's `deps.surface.installTspInlineAttachmentStager`
 *     -> the REAL `SurfaceRuntime.installTspInlineAttachmentStager` forward
 *     -> the mounted renderer's `installInlineAttachmentStager`
 *     -> `settleInlineAttachmentAcceptance` -> the SAME `runAttachmentIntake`
 *     -> the Client-local read -> the draft store -> the composer's ONE
 *        `replaceInlineAttachmentFragment` -> the real `preparePrompt`.
 *
 * EVIDENCE LEVEL: application-composed / SDK wire. PRODUCTION under test: the
 * command catalog and its provenance screen, the surface runtime, the TSP
 * renderer and its completion seat, the autocomplete composition, the extension
 * command bridge, the attachment intake and its draft stores, the submission
 * controller, the input-history owner and the display seam. DECLARED
 * STAND-INS: the scripted pane tty (no physical Tern client), a scripted Host
 * commands service, a scripted HostFilePort and scripted plugin faces (no real
 * plugin host), a scripted Client-local read TIMING (the read itself is the
 * production `readImageFileUninjected`), and an inert Agent with recording
 * writer sinks (no model turn).
 *
 * @module @xmoon76/dsh-pi-tui/test/app/tern-tsp-input-completion-composition
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Session } from '@stencil-hq/tern'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { commandSummaryOf, type SurfaceCommandSummary } from '../../src/domain/catalog/surface.ts'
import type { HumanSkillSummary } from '../../src/domain/catalog/skill.ts'
import { listGlobalCommands } from '../../src/runtime/direct/surface-catalog.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { CommandBridge } from '../../src/extension/internal/command-bridge.ts'
import type { TuiAutocompleteQuery, TuiAutocompleteSuggestions } from '../../src/extension/public-types.ts'
import type { HostFileListResult, HostFilePort, HostFileResolveResult, HostFileScope } from '../../src/runtime/host-file-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import {
  createSurfaceRuntime,
  type SurfaceRendererMount,
  type SurfaceRuntime,
  type TspCommandCompletionInstallation,
  type TspInlineAttachmentStager,
} from '../../src/app/surface/runtime.ts'
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { bindSubmissionRuntime, type SubmissionRuntimeSurface } from '../../src/app/submission/runtime.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createInputHistory } from '../../src/app/surface/input-history.ts'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { draftHasAttachments } from '../../src/client/media/draft-attachments.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { readImageFileUninjected, setImageReadForTest, type ImageFileIntake } from '../../src/client/media/image/intake.ts'
import type { ImageLimitsLike } from '../../src/domain/media/types.ts'
import type { ComposerSubmitRequest } from '../../src/tui-app.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import type { ModelApplyOutcome, ModelPickerRequest } from '../../src/app/command/model-presentation.ts'
import type { TspBuiltinPickers } from '../../src/app/command/tsp-capability.ts'
import { foldWireNodes, wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

const SESSION_ID = 'session-ic-composition'
/** The controlled composer's node path inside the Quiet Composer shell. */
const EDITOR_ID = 'dock.quiet-composer.composer'

// The shipped SDK decoder is the only key authority: every byte below is what a
// physical terminal sends, and the renderer receives its own decoded `Key`. The
// sequences are composed from `ESC` so no raw control byte is written by hand.
const ESC = String.fromCharCode(27)
const UP = `${ESC}[A`
const DOWN = `${ESC}[B`
const HOME = `${ESC}[H`
const SHIFT_ENTER = `${ESC}[13;2u`
const TAB = '\t'
const ENTER = '\r'
const ESCAPE = ESC

/**
 * The bounded observation window for this file's ABSENCE claims. A popup that
 * correctly never appears has no event to await (the seat deliberately commits
 * no render for a closed seat), so the case waits exactly this window and then
 * reads the wire, while every PRESENCE claim waits an authoritative pane frame
 * or callback. The bound covers one SDK input dispatch plus the suggestion
 * settlement the seat would have painted.
 */
const ABSENCE_WINDOW_MS = 220

/** A row of the scripted Host global command catalog. */
interface HostRow {
  readonly name: string
  readonly description: string
  readonly definitionId?: string
  readonly input?: { readonly hint: string }
}

// The provenance the screen must recognise, one row per source it names:
// `settings` is ALSO a TUI built-in the mounted renderer cannot run, so keeping
// it proves the GENUINE Host-origin rule ran first; `alpha` is an ordinary
// Host row; `help`/`login`/`logout`/`rewind` are TUI registrations the screen
// withdraws; `model` rides the mounted presenter capability.
const HOST_ROWS: readonly HostRow[] = [
  { name: 'alpha', description: 'Host alpha command' },
  { name: 'settings', description: 'Host settings panel', definitionId: '@host/genuine/settings' },
]
/** The live dynamic Skill catalog: its wrapper row is never a TUI builtin. */
const SKILL_ROWS: readonly HumanSkillSummary[] = [
  { name: 'glab', description: 'GitLab workflow' },
]
/** The plugin command contribution (merged in by the real candidate synthesis). */
const CONTRIBUTION_NAME = 'deploy-report'

/** One row of the popup as the wire carries it. `text` is the row's OWN
 *  candidate text (an `/command`, an official `@…` mention, a real local path,
 *  an inline action), `value` is the command name for the command-shaped rows
 *  and '' for every other seat. */
interface PopupRow {
  readonly id: string
  readonly text: string
  readonly value: string
  readonly highlighted: boolean
}

/** Every candidate row the CURRENT wire carries, in painted order. A row is the
 *  styled `el` button the seat's own projection produced underneath the live
 *  anchored menu (`composer-completion-menu-<scope>-<list revision>`), so a
 *  retired list can never be picked up from an older node; its leaf text
 *  children carry the candidate text and the description.
 *  The row's key is `completion-<scope>-<revision>-<index>:<item value>` with
 *  the SDK-illegal characters replaced — a REAL file name keeps its dots
 *  (`0_src/deep.ts`), so a row is addressed as the OUTERMOST `el` under the menu
 *  node, never by a dot-anchored id pattern (that would silently drop every
 *  path and mention candidate and make an absence claim vacuous). */
function popupRows(pane: TspPane): PopupRow[] {
  const live = wireNodes(pane)
  const menu = live.find(node => node.id.includes('.composer-completion-menu-'))
  if (menu === undefined) return []
  const underMenu = (node: WireNode): boolean => node.id.startsWith(`${menu.id}.`)
  const candidateEls = live.filter(node => node.k === 'el' && underMenu(node))
  const rows = candidateEls.filter(node => !candidateEls.some(other => other.id !== node.id
    && node.id.startsWith(`${other.id}.`)))
  const leafText = (node: WireNode): string => {
    const own = node.p.text
    if (typeof own === 'string' && own !== '') return own
    const subtree = live.filter(entry => entry.id.startsWith(`${node.id}.`))
    const leaves = subtree.filter(entry => typeof entry.p.text === 'string' && entry.p.text !== '')
      .filter(entry => !subtree.some(inner => inner.id.startsWith(`${entry.id}.`)
        && typeof inner.p.text === 'string' && inner.p.text !== ''))
    return leaves.map(entry => String(entry.p.text)).join('')
  }
  return rows.map(node => {
    const attrs = node.p.attrs as Record<string, unknown> | undefined
    const label = leafText(node)
    // The row's own `title`/`aria` is the seat's composed
    // `${row.name} — ${description}` text: its leading token is the EXACT
    // command name, never the concatenated label/description spans.
    const title = typeof node.p.title === 'string' ? node.p.title : ''
    const aria = typeof node.p.aria === 'string' ? node.p.aria : ''
    const full = title !== '' ? title : (aria !== '' ? aria : label)
    const name = /^\/([a-z0-9._:-]+)/u.exec(full)?.[1]
      ?? /(?:\u203a| )\/([a-z0-9._:-]+)/u.exec(label)?.[1] ?? ''
    // The candidate text is the row's first span, without the seat's own
    // highlight marker.
    const firstSpan = live.find(entry => entry.id.startsWith(`${node.id}.`)
      && typeof entry.p.text === 'string' && entry.p.text !== '')
    const text = (firstSpan !== undefined ? String(firstSpan.p.text) : label).replace(/^\u203a|^ /u, '')
    return {
      id: node.id,
      text,
      value: name,
      highlighted: attrs?.['data-highlight'] === 'true',
    }
  })
}

/** Whether a candidate row was painted in one of the frames after `mark`. */
function h_rows_changed(pane: TspPane, mark: number): boolean {
  const frames = pane.frames()
  for (let index = Math.max(0, mark); index < frames.length; index += 1) {
    for (const op of frames[index]!.ops) {
      if (op[0] === 'add' && String(op[1]).includes('.completion-')) return true
    }
  }
  return false
}

/** The candidate values, in painted order. */
function popupValues(pane: TspPane): string[] {
  return popupRows(pane).map(row => row.value)
}

/** The controlled composer's wire facts: the ONE visible draft and UTF-16 caret. */
function editorWire(pane: TspPane): { text: string; cursor: number } {
  const node = wireNodes(pane).find(candidate => candidate.id === EDITOR_ID)
  assert.ok(node, 'the controlled composer editor is on the wire')
  return { text: String(node.p.text ?? ''), cursor: Number(node.p.cursor ?? 0) }
}

/** Whether any frame from `fromFrame` onwards carried the candidate popup at
 *  all — its menu container, any of its row buttons or its own hint line. The
 *  LIVE fold alone cannot prove an absence claim: a row that was painted and
 *  then removed is gone from it, so every intermediate frame has to be
 *  inspected. The menu-container and hint checks are substring/text facts, so a
 *  candidate whose value carries dots (`src/deep.ts`, `shots/err.png`) is
 *  visible to this witness exactly like a command row is. */
function popupPaintedSince(pane: TspPane, fromFrame: number): boolean {
  const frames = pane.frames()
  for (let index = Math.max(0, fromFrame); index < frames.length; index += 1) {
    const live = foldWireNodes(frames.slice(0, index + 1))
    if (live.some(node => node.id.includes('.composer-completion-menu-'))) return true
    if (live.some(node => node.k === 'el' && node.id.includes('.completion-'))) return true
    if (live.some(node => String(node.p.text ?? '').includes('Tab/Enter complete'))) return true
  }
  return false
}


/**
 * The scripted Host commands service: the global-layer rows the Direct catalog
 * seam reads, plus the TUI's OWN compatibility mirrors. A name a scripted Host
 * row already owns refuses the mirror exactly like the official service, so the
 * surviving winner keeps its genuine `definitionId` provenance.
 */
function scriptedCommands(rows: readonly HostRow[]) {
  const mirrored: SurfaceCommandSummary[] = []
  const taken = new Set(rows.map(row => row.name))
  return {
    /** The effective global-layer view the completion merge reads. */
    list(): readonly SurfaceCommandSummary[] {
      return [
        ...rows.map(row => commandSummaryOf(row)),
        ...mirrored,
      ]
    },
    register(definition: SurfaceCommandSummary & { handler?: unknown }): () => void {
      if (taken.has(definition.name)) {
        throw new Error(`command "${definition.name}" is already registered`)
      }
      taken.add(definition.name)
      mirrored.push(commandSummaryOf(definition))
      let released = false
      return (): void => {
        if (released) return
        released = true
        taken.delete(definition.name)
        const index = mirrored.indexOf(definition)
        if (index >= 0) mirrored.splice(index, 1)
      }
    },
  }
}

/**
 * The plugin command contributions, registered through the PRODUCTION
 * `CommandBridge` (its real generation counter and disposal semantics), which
 * is the face `mergeContributions` merges into the display catalog.
 */
function scriptedContributions() {
  const bridge = new CommandBridge(() => {}, new Set<string>())
  const handles = new Map<string, { dispose(): void }>()
  return {
    bridge,
    add(name: string): void {
      const outcome = bridge.register({
        id: `plugin-${name}`,
        name,
        description: `plugin ${name}`,
        sessionless: true,
        handler: async () => ({ kind: 'success' as const }),
      }, 'plugin-owner')
      assert.equal(outcome.kind, 'registered', `the ${name} contribution must register`)
      if (outcome.kind === 'registered') handles.set(name, outcome.handle)
    },
    remove(name: string): void {
      handles.get(name)?.dispose()
      handles.delete(name)
    },
  }
}

/**
 * One scripted Host-file discovery answer for a `@` query. The port that owns
 * this script COUNTS every method, so a case can prove which source a document
 * really consulted — and that the other one was never reached.
 */
type HostFileScript = (query: string, scope: HostFileScope) => HostFileListResult | Promise<HostFileListResult>

/**
 * The scripted Host-file port. It counts each method separately (so "the Host
 * answered" and "the Host was never consulted" are distinct facts), records the
 * official query strings, the scope and the AbortSignal it received, and can
 * HOLD its next answer so a case can drive the late-answer window explicitly
 * instead of racing it. A held answer IGNORES its signal on purpose: that is the
 * hardest shape a stale settlement can take, and the seat must still refuse it.
 *
 * The DEFAULT answer is `unavailable`: the same fail-closed witness the I-C
 * suite used, so a case that scripts nothing still proves a document reached no
 * Host discovery.
 */
function scriptedHostFilePort(script?: HostFileScript) {
  let listCalls = 0
  let resolveCalls = 0
  let canonicalizeCalls = 0
  const asked: Array<{ query: string; scope: HostFileScope; signal?: AbortSignal }> = []
  const held: Array<() => void> = []
  let holdNext = false
  const unavailable: HostFileListResult = { kind: 'unavailable', reason: 'the witness port never discovers files' }
  const port: HostFilePort = {
    async listReferences(scope: HostFileScope, query: string, options?: { signal?: AbortSignal }): Promise<HostFileListResult> {
      listCalls += 1
      asked.push({ query, scope, signal: options?.signal })
      const answer = async (): Promise<HostFileListResult> => script === undefined ? unavailable : script(query, scope)
      if (!holdNext) return answer()
      holdNext = false
      return new Promise<HostFileListResult>((resolve, reject) => {
        held.push(() => { void answer().then(resolve, reject) })
      })
    },
    async resolveReference(): Promise<HostFileResolveResult> {
      resolveCalls += 1
      return { kind: 'unavailable', reason: 'the witness port never probes a path' }
    },
    async canonicalizeMentions(_scope: HostFileScope, text: string): Promise<string> {
      canonicalizeCalls += 1
      return text
    },
  }
  return {
    port,
    /** Total calls across the port surface (the I-C absence witness). */
    calls: () => listCalls + resolveCalls + canonicalizeCalls,
    listCalls: () => listCalls,
    resolveCalls: () => resolveCalls,
    canonicalizeCalls: () => canonicalizeCalls,
    queries: () => asked.map(entry => entry.query),
    /** Every (query, scope) pair the port was asked with, in order. */
    records: () => asked.map(entry => ({ ...entry })),
    /** Whether the signal of the MOST RECENT `listReferences` call is aborted:
     *  the seat's own withdrawal is a fact the wire cannot show, this can. */
    lastAborted: () => asked.at(-1)?.signal?.aborted === true,
    /** Hold the NEXT `listReferences` answer until {@link releaseHeld}. */
    holdNext: () => { holdNext = true },
    heldCount: () => held.length,
    /** Release every held answer; each resolves through its own script. */
    releaseHeld: () => { for (const run of held.splice(0)) run() },
  }
}

/** A 33-byte PNG (signature + IHDR): enough for the REAL metadata parser the
 *  Client-local image intake runs, with no decoder. */
function pngBytes(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const set32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
  set32(16, width)
  set32(20, height)
  return bytes
}

/**
 * Write one real Client-local fixture tree into the mount's Client cwd. The
 * discovery under test is the production bounded fallback (`localFdPath: null`),
 * so the names on disk ARE the candidate source — no scripted finder stands in
 * for it.
 */
function writeClientFiles(root: string, names: readonly string[]): void {
  for (const name of names) {
    const target = join(root, name)
    mkdirSync(join(target, '..'), { recursive: true })
    if (name.endsWith('.png')) writeFileSync(target, pngBytes())
    else writeFileSync(target, `client-local ${name}`)
  }
}

/**
 * Count the Client-local image reads the ONE intake performs. The delegate is
 * the PRODUCTION read (`readImageFileUninjected`) — this is a counted callback,
 * not a replacement: when `hold` is armed the read stays genuinely in flight
 * until the case releases it, which is what makes the late-settlement window a
 * fact the case drives instead of a race it hopes to lose.
 */
function countingImageRead(options: { readonly hold?: boolean } = {}) {
  let calls = 0
  const held: Array<() => void> = []
  const read = async (
    rawPath: string,
    cwd: string,
    limits: ImageLimitsLike | undefined,
    extraSafetyCap?: number,
  ): Promise<ImageFileIntake> => {
    calls += 1
    const run = (): Promise<ImageFileIntake> => readImageFileUninjected(rawPath, cwd, limits, extraSafetyCap)
    if (options.hold !== true) return run()
    return new Promise<ImageFileIntake>((resolve, reject) => {
      held.push(() => { void run().then(resolve, reject) })
    })
  }
  setImageReadForTest(read)
  return {
    calls: () => calls,
    heldCount: () => held.length,
    releaseAll: () => { for (const run of held.splice(0)) run() },
    restore: () => setImageReadForTest(undefined),
  }
}



/**
 * The scripted plugin autocomplete chain. `suggestOwned` is consulted only when
 * the host catalog has nothing to answer, and a HELD answer resolves exactly
 * when the case releases it — so "the answer arrived late" is a fact the test
 * drives, never a race it hopes to lose.
 */
interface ScriptedPluginChain {
  suggestOwned(query: TuiAutocompleteQuery): Promise<TuiAutocompleteSuggestions | null>
  /** Releases held answer `index` with these candidates (and the plugin's own
   *  claimed replacement prefix — the wire shape a real extension returns). */
  release(index: number, items: readonly { value: string; label: string }[], prefix?: string): void
  /** Releases every outstanding answer with no candidates. */
  releaseAll(): void
  readonly asked: () => number
  /** Arm the next call so it resolves immediately with no candidates. */
  quiet(): void
  /** Hold the NEXT call until `release` (the late-answer window under test). */
  hold(): void
}

function scriptedPluginChain(): ScriptedPluginChain {
  const held: Array<(value: TuiAutocompleteSuggestions | null) => void> = []
  let immediate = true
  let asked = 0
  const chain: ScriptedPluginChain = {
    asked: () => asked,
    quiet: () => { immediate = true },
    hold: () => { immediate = false },
    async suggestOwned(): Promise<TuiAutocompleteSuggestions | null> {
      asked += 1
      if (immediate) return null
      return new Promise<TuiAutocompleteSuggestions | null>((resolve) => { held.push(resolve) })
    },
    release(index, items, prefix = '/') {
      const resolve = held[index]
      if (resolve === undefined) return
      held[index] = () => {}
      resolve({ items: [...items], prefix })
    },
    releaseAll() {
      for (let index = 0; index < held.length; index += 1) chain.release(index, [])
    },
  }
  return chain
}

/** What a case may script before the mount is built. */
interface MountOptions {
  /** Advertise the native Model presenter kinds on the pane (the real fact the
   *  catalog screen reads for `/model`). */
  readonly modelPicker?: boolean
  /** Keep every plugin answer held until the case releases it. */
  readonly holdPluginAnswers?: boolean
  readonly contributions?: readonly string[]
  readonly hostRows?: readonly HostRow[]
  /** Script the Host-file discovery answers (the default port answers
   *  `unavailable`: the fail-closed witness). */
  readonly hostFiles?: HostFileScript
  /** Hold the Client-local image read until the case releases it: the ONE way
   *  to make an intake genuinely in flight instead of racing the filesystem. */
  readonly holdImageRead?: boolean
  /** Whether the composition supplies the ONE stager install seam. `false`
   *  models an assembly with no TSP attachment plane (the command layer then
   *  installs nothing, exactly like an absent optional port). */
  readonly stagerSeam?: boolean
}

/** Every install the CURRENT mount's own ports received, in order. The
 *  recording wrapper delegates 1:1 to the real renderer, so these arrays are the
 *  composition seam's call log — never renderer internals. */
interface MountPorts {
  readonly stagers: TspInlineAttachmentStager[]
  readonly catalogInstalls: TspCommandCompletionInstallation[]
}

interface ChainHarness {
  readonly surface: SurfaceRuntime<SessionEvent>
  readonly pane: TspPane
  readonly session: Session
  readonly renderer: () => TspRenderer
  readonly commands: ReturnType<typeof registerTuiCommands>
  readonly contributions: ReturnType<typeof scriptedContributions>
  /** Add/remove a plugin command contribution through the REAL bridge. */
  readonly addContribution: (name: string) => void
  readonly plugin: ScriptedPluginChain
  readonly hostFileCalls: () => number
  /** The scripted Host-file port and its per-method counters. */
  readonly host: ReturnType<typeof scriptedHostFilePort>
  /** The counted Client-local image read of the ONE intake (see above). */
  readonly imageRead: ReturnType<typeof countingImageRead>
  /** The install calls the CURRENT mount's ports received (see MountPorts). */
  readonly mountPorts: MountPorts
  /** The ONE real draft stores the intake writes into (never a second store). */
  readonly images: DraftImageStore
  readonly files: DraftFileStore
  /** A real session-generation bump: the production publication
   *  invalidation shape a Session replacement performs. */
  readonly bumpSessionGeneration: () => number
  /** Publish a NEW owner under the SAME session id: the A -> B -> A shape where
   *  the id matches but the ownership subject does not. */
  readonly replaceSessionOwner: () => void
  /** Publish a live Session on the command runner: the completion scope and the
   *  intake's session-scope capture read it LIVE (no reinstall, no second
   *  catalog). `undefined` returns the sessionless cold surface. */
  readonly openSession: (sessionId: string | undefined) => void
  /** The ONE application submit entry the real binding forwards to. */
  readonly submits: Array<{ text: string; request: string; token: number | undefined }>
  /** The real submission controller's writer sink. */
  readonly writes: unknown[]
  readonly selects: string[]
  readonly cancels: () => number
  /** Re-commit the effective catalog through the ONE production commit point. */
  commitCatalog(): void
  editor(): { text: string; cursor: number }
  rows(): PopupRow[]
  values(): string[]
  /** One real key sequence, awaited on the frame it must paint. */
  press(bytes: string): Promise<void>
  /** A raw trigger awaited on the popup it must open. */
  triggerQuietly(bytes: string): Promise<void>
  /** One real key sequence that must change nothing on the wire. */
  pressQuietly(bytes: string): Promise<void>
  /** A program-owned draft write (no key, so no natural trigger runs). */
  setDraft(text: string): Promise<void>
  clickRow(row: PopupRow): Promise<void>
  waitNoRowPaint(sinceFrame: number, label: string): Promise<void>
  frameCount(): number
  dispose(): Promise<void>
}

/**
 * Compose ONE real mount: the surface runtime, the TSP renderer over the
 * scripted pane, the REAL command catalog commit (with its provenance screen
 * pointed at this mount), and the REAL submission controller behind the
 * surface's `pendingInputBinding`.
 */
async function mountChain(
  life: TestLifecycle,
  home: string,
  options: MountOptions = {},
): Promise<ChainHarness> {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const pane = installTspPane({
    composerActions: true,
    modelQuick: true,
    ...(options.modelPicker === false ? {} : { modelPicker: true }),
    // TSP I-E: negotiate the kinds the History card really paints, so this
    // composition can put a real card in the composer seat and prove the
    // attachment intake refuses to write behind it.
    historySearch: true,
  })
  life.defer(() => pane.restore())
  const connected = await sdkConnect({ timeout: 500, exitHooks: false })
  assert.ok(connected !== null, 'the shipped SDK accepts the scripted pane')
  const session: Session = connected

  const hostFile = scriptedHostFilePort(options.hostFiles)
  // The ONE Client-local read the inline intake performs is COUNTED (and, when
  // the case asks, held) through the production test seam; the delegate is the
  // production read itself.
  const imageRead = countingImageRead({ ...(options.holdImageRead === true ? { hold: true } : {}) })
  life.defer(() => imageRead.restore())
  const plugin = scriptedPluginChain()
  if (options.holdPluginAnswers === true) plugin.hold()
  const contributions = scriptedContributions()
  for (const name of options.contributions ?? [CONTRIBUTION_NAME]) contributions.add(name)
  const hostRows = options.hostRows ?? HOST_ROWS
  const registry = scriptedCommands(hostRows)
  const ctx = new Context()
  ctx.provide('commands', registry as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined } as never)

  let folder = new TranscriptFolder()
  const controllerWindow = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: candidate => candidate.id === SESSION_ID,
    currentSessionId: () => SESSION_ID,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      folder: { apply: (events: readonly SessionEvent[]) => folder.apply(events) },
      stats: { apply: () => {} },
      get window() { return controllerWindow },
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewer in this composition') },
    mainFolder: () => folder,
    viewedChildFolder: () => { throw new Error('no viewer in this composition') },
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => {},
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    refreshWorkspaceFacts: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this composition') },
    applyMainAssistantInput: input => folder.applyLiveInput(input),
  }

  const selects: string[] = []
  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    permissionUi: {
      options: () => ['read-only', 'workspace-write', 'danger-full-access'],
      select: id => { selects.push(id) },
    },
    modelPickerAvailable: () => true,
    openModelPicker: () => {},
    openModelQuick: () => {
      // The registered /model command's quick presentation, opened through the
      // renderer's OWN late-bound entry: the request's presentation is a
      // stand-in, the menu and its key ownership are production.
      const presentation = mountedRenderer?.modelPresentation
      const openQuick = presentation?.openQuick
      assert.ok(openQuick, 'the pane negotiated the native Model quick presentation')
      openQuick({
        subject: { sessionless: false },
        entry: 'models',
        isCurrent: () => true,
        retry: () => {},
        apply: async () => ({ kind: 'applied' }) as unknown as ModelApplyOutcome,
        runOwned: (_label, task) => { void task() },
      } satisfies ModelPickerRequest)
    },
    openSessionBrowser: () => {},
    sessionBrowserAvailable: () => true,
  })
  surface.attachEventRouting(source)

  const submits: Array<{ text: string; request: string; token: number | undefined }> = []
  const writes: unknown[] = []
  let cancels = 0
  let controller!: ReturnType<typeof createSubmissionController<AgentLike>>
  let mountedRenderer: TspRenderer | undefined
  /**
   * The install calls the CURRENT mount's own ports received. The wrapper below
   * delegates every member to the real renderer 1:1, so the arrays are a call
   * log of the composition seam — not a renderer-internal probe, and not a
   * second mount.
   */
  const mountPorts: MountPorts = { stagers: [], catalogInstalls: [] }
  const rendererMount: SurfaceRendererMount = {
    mount: (binding, statusReader, historySearch) => {
      mountedRenderer = mountTspRenderer(session, {
        copyVisual: async () => false,
        requestExit: () => {},
        onFatal: (error) => { throw new Error(`the mount routed a fatal: ${String(error)}`) },
      })
      mountedRenderer.bindStatusReader(statusReader)
      mountedRenderer.bindImages(binding)
      // TSP I-E: the same one-time install the production connector performs,
      // so this composition really owns a History seat (and the attachment
      // intake can be tested against a card that holds the composer seat).
      mountedRenderer.bindHistorySearch(historySearch)
      // The REAL renderer is the mount: every member (dynamic capability
      // getters included) is read live off it. Only the two composition
      // INSTALL ports are recorded, then forwarded verbatim — exactly the
      // shape `selectRendererMount` projects in production.
      const renderer = mountedRenderer
      return new Proxy(renderer, {
        get: (target, key, receiver) => {
          if (key === 'installInlineAttachmentStager') {
            return (stager: TspInlineAttachmentStager): void => {
              mountPorts.stagers.push(stager)
              target.installInlineAttachmentStager(stager)
            }
          }
          if (key === 'installCommandCompletions') {
            return (installation: TspCommandCompletionInstallation): void => {
              mountPorts.catalogInstalls.push(installation)
              target.installCommandCompletions(installation)
            }
          }
          return Reflect.get(target, key, receiver)
        },
      })
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }
  surface.start({
    events: {
      onSubmit: (text: string, request: ComposerSubmitRequest, scopeToken?: number) => {
        submits.push({ text, request: String(request), token: scopeToken })
        controller.submit(text, request, scopeToken)
      },
      onExit: () => {},
      onCancel: () => { cancels += 1 },
      shouldRememberInput: text => !draftHasAttachments(text, images, files),
    },
    renderer: rendererMount,
    workspaceRoot: home,
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => home,
    captureHistoryScope: () => ({ sessionId: SESSION_ID, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  surface.bindRendererInput()

  // The REAL submission controller, composed exactly as the I-A composition
  // test does: the application's onSubmit calls its PUBLIC entry with the live
  // third argument (the mount's occurrence token), and its writer sink is the
  // only counted business-prompt witness.
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const historyOwner = createInputHistory({
    surface: { get display() { return surface.display } },
    clientCwd: home,
    sessionCwd: () => home,
    diag: createDiag({ stderrLevel: 'off' }),
    isCleanedUp: () => false,
  })
  // The live Agent SLOT: the scope authority re-reads its owner on every
  // capture/check, so `replaceSessionOwner` below publishes a NEW owner under the
  // SAME session id (the A -> B -> A resume shape) and invalidates an older
  // capture exactly like production — the session id alone is never the fence.
  let agent: AgentLike = { status: 'idle', session: { id: SESSION_ID }, options: {}, cancel: () => {} }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, SESSION_ID)
  let draft = ''
  const runtimeSurface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: text => {
      draft = mergeDraft(draft, text)
      return draft === text
    },
    restoreStaleDraftIntoEditor: text => {
      draft = mergeDraft(draft, text)
      return draft === text ? 'merged-verbatim' : 'merged'
    },
    consumeDraftAttachments: () => {},
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: () => {},
    refuseByTransitionFence: text => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt(SESSION_ID, text, { images, files }, requestId),
    prompt: async (sessionId, message) => {
      writes.push({ sessionId, message })
      return { kind: 'committed', value: undefined }
    },
  }
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })
  const inert = new Proxy(function inert(): void {}, {
    get: (_target, key) => (key === 'then' ? undefined : inert),
    apply: () => undefined,
  })
  const deps: Record<string, unknown> = {
    app: () => surface.composer,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => agent,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
    },
    scope: {
      captureLive: () => ({ sessionId: SESSION_ID, subject: core.captureSubject()! } as never),
      isCurrent: () => true,
      requireLive: () => ({ sessionId: SESSION_ID, subject: core.captureSubject()! } as never),
    },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: {
      ...new Proxy({}, { get: () => () => false }),
      withCommandDelivery: <T,>(_delivery: unknown, run: () => T): T => run(),
      wasAdvertisedClaim: () => false,
      hostClaimOf: () => undefined,
      hostOriginClaimOf: () => undefined,
      hostCatalogResolves: () => false,
      clientClaimsLine: () => false,
      isSkillWrapperName: () => false,
      isSkillInvocation: () => false,
      takeCommandDraftDisposition: () => undefined,
      clientCommands: { get: () => undefined, execute: async () => undefined },
    },
    commandPlane: { available: () => false, execute: async () => undefined, findHandler: () => undefined },
    backendKind: 'remote',
    backend: inert,
    drafts: { images, files },
    status: { sessionCwd: () => home },
    surface: { refreshPendingInput: () => {} },
    history: {
      persist: (record: Parameters<typeof historyOwner.persist>[0]) => historyOwner.persist(record),
      persistAfterSession: async (
        resolveSession: () => Promise<string | undefined>,
        persist: (sessionId: string | undefined) => void,
      ) => { persist(await resolveSession()) },
    },
    viewer: { isViewing: () => false },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    artifacts: { start: () => {} },
    shell: { run: () => {}, interrupt: () => {} },
    supportsLocalShellCards: false,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined, llm: () => undefined },
    tuiSettings: undefined,
    captureMatches: () => true,
    ownerWasReplaced: () => false,
    direct: { withPromptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => Promise<unknown>) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text: string, requestId: string) => preparePrompt(SESSION_ID, text, { images, files }, requestId),
  }
  controller = createSubmissionController<AgentLike>(deps as unknown as SubmissionControllerDeps<AgentLike>)

  // The REAL runner the command layer registers into: a Direct-shaped fake Host
  // service, the REAL Client command registry and the REAL extension registries.
  // The presentation object is the SAME live-mount seam `createCommandSurface`
  // and `bootstrap` compose: catalog commits AND the one inline-attachment
  // stager reach the CURRENT mount through `surface.installTsp…`, and the picker
  // capability is read live from the mounted presenters at each commit.
  // The session-scope authority of the ONE intake and of the `@` completion
  // scope: `runner.currentSessionId` is read LIVE at SUGGESTION time (a session
  // appearing or switching needs no reinstall), so `openSession` below is what
  // moves it. `@`/attachment currentness rides the PRODUCTION
  // `createSessionScopeAuthority` (the same `sessionScopeFacts` adapter every
  // Direct-shaped runner stub uses) over this composition's live ownership core,
  // so a real generation bump really does retire a late intake.
  const scopeFacts = sessionScopeFacts(() => agent as never, () => core.generation())
  let runnerSessionId: string | undefined
  const base: Record<string, unknown> = {
    ctx,
    app: undefined,
    diag: createDiag({ stderrLevel: 'off' }),
    get currentSessionId() { return runnerSessionId },
    cwd: home,
    sessionCwd: () => home,
    signal: new AbortController().signal,
    commandRegistry: registry as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostShellCompletion: false,
    imageStore: images,
    fileStore: files,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    captureSessionScope: scopeFacts.captureSessionScope,
    isSessionScopeCurrent: scopeFacts.isSessionScopeCurrent,
    sessionTransitionPending: () => false,
    prepareDraftMessage: async (text: string) => ({ role: 'user', content: [{ type: 'text', text }] }),
    requestExit: () => {},
    beginClientWrite: () => () => {},
    deliveredFilesSnapshot: () => undefined,
    exit: () => {},
    ensureSession: async () => {},
    // The Direct-shaped scoped Host view: while no Session is live the runner is
    // the sessionless surface (an empty scoped view, the global layer owns the
    // catalog); once one is published the same Host rows are its scoped view.
    listScopedCommands: () => (runnerSessionId === undefined ? [] : registry.list()),
    hostFile: hostFile.port,
    extensions: {
      commands: contributions.bridge,
      autocomplete: plugin,
      health: () => [],
    },
  }
  const runner = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : inert),
  }) as unknown as TuiCommandRunner

  const capabilities = (): TspBuiltinPickers => ({
    modelPicker: surface.modelPresentation !== undefined,
    presetPicker: surface.presetPresentation !== undefined,
    sessionBrowser: surface.sessionBrowserPresentation !== undefined,
    taskCenter: surface.display.supportsTaskCenter,
  })
  const commands = registerTuiCommands(
    runner,
    { skills: { skills: [...SKILL_ROWS], complete: true } },
    { listGlobalCommands: () => listGlobalCommands(registry as never).map(commandSummaryOf) },
    undefined,
    undefined,
    {
      notify: () => {},
      titleRefusalNoticeOwner: 'result-card',
      titleSuccessNoticeVisible: false,
      composer: () => surface.composer,
      installTspCommandCompletions: (installation: TspCommandCompletionInstallation) => {
        surface.installTspCommandCompletions(installation)
      },
      // TSP I-D: the ONE inline-attachment stager, forwarded to the CURRENT
      // mount through the same live surface read `createCommandSurface` and
      // `bootstrap` use. Omitting it models an assembly that supplies no TSP
      // attachment plane at all.
      ...(options.stagerSeam === false ? {} : {
        installTspInlineAttachmentStager: (stager: TspInlineAttachmentStager) => {
          surface.installTspInlineAttachmentStager(stager)
        },
      }),
      tspCommandPickerCapabilities: capabilities,
    },
  )

  // The formal status fact that admits the Quiet Composer's Permission menu, and
  // the late-bound Model quick entry the real composition installs after the
  // command registration. Both are needed so case E can open the real owners.
  // The surface's OWN status store is the reader the mount was bound with:
  // committing the permission fact through the application seam is what makes
  // the Quiet Composer's real Permission menu operable (no second binding).
  surface.commitStatus(
    { access: { permissionPreset: { id: 'workspace-write', label: 'Workspace Write', matched: true } } } as never,
    {},
    undefined,
  )
  surface.display.commitDisplaySubject({}, {}, undefined)
  await waitUntil('the first frame carried the controlled composer', () =>
    wireNodes(pane).some(node => node.id === EDITOR_ID))

  const renderer = (): TspRenderer => {
    assert.ok(mountedRenderer, 'the TSP renderer committed its mount')
    return mountedRenderer
  }
  const harness: ChainHarness = {
    surface,
    pane,
    session,
    renderer,
    commands,
    contributions,
    addContribution: (name) => contributions.add(name),
    plugin,
    hostFileCalls: hostFile.calls,
    host: hostFile,
    imageRead,
    mountPorts,
    images,
    files,
    bumpSessionGeneration: () => core.bumpGeneration(),
    replaceSessionOwner: () => {
      // A new Agent object owns the SAME session id: the capture's owner term
      // moves even though nothing about the id text does.
      agent = { status: 'idle', session: { id: SESSION_ID }, options: {}, cancel: () => {} }
      core.setCurrentOwner({} as never, SESSION_ID)
    },
    openSession: (sessionId) => { runnerSessionId = sessionId },
    submits,
    writes,
    selects,
    cancels: () => cancels,
    commitCatalog: () => commands.refreshCommandCompletions(),
    editor: () => editorWire(pane),
    rows: () => popupRows(pane),
    values: () => popupValues(pane),
    async press(bytes) {
      const mark = pane.frameCount()
      const before = editorWire(pane)
      pane.key(bytes)
      // The SDK delivers a key asynchronously. A key that edits the draft
      // commits a controlled-editor frame; a candidate query commits its own
      // frame; a key with NO visual effect (a Tab that only re-queries the
      // SAME list) commits no frame at all. Either paint ends the wait.
      await waitUntil(`the ${JSON.stringify(bytes)} key was delivered`, () =>
        pane.frameCount() > mark || editorWire(pane).text !== before.text
          || editorWire(pane).cursor !== before.cursor || h_rows_changed(pane, mark))
    },
    /** A raw key with NO frame wait (a trigger whose only sink is the popup). */
    async triggerQuietly(bytes) {
      pane.key(bytes)
      // reason: bounded SDK-key delivery window — the trigger's authoritative
      // sink is the candidate list the caller waits for next.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    async pressQuietly(bytes) {
      pane.key(bytes)
      // reason: bounded negative-observation window — the SDK's async input
      // loop is the single producer of a routed key; a correctly ignored
      // gesture has no positive sink to await.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    async setDraft(text) {
      surface.composer.setDraft(text)
      await waitUntil('the composer wire carries the program-owned draft', () => editorWire(pane).text === text)
    },
    async clickRow(row) {
      pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: row.id, act: 'click' })
      // reason: bounded click-settlement window — the frame a refused click
      // would not produce has no positive sink to await.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
    },
    async waitNoRowPaint(sinceFrame, label) {
      // reason: bounded absence window — every settlement the seat would have
      // painted writes a frame; a correctly dropped answer writes none.
      await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
      assert.equal(popupPaintedSince(pane, sinceFrame), false, label)
      assert.equal(harness.rows().length, 0, `${label}: the live wire carries no candidate rows`)
    },
    frameCount: () => pane.frameCount(),
    dispose: async () => {
      // Every held async answer belongs to THIS case: release it before the
      // teardown so no promise outlives the mount it was scripted against.
      plugin.releaseAll()
      hostFile.releaseHeld()
      imageRead.releaseAll()
      await surface.dispose()
      await session.close()
    },
  }
  life.defer(() => harness.dispose())
  return harness
}

interface AgentLike {
  status: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
  cancel(): void
}

// ── A. Catalog provenance through the REAL registerTuiCommands ───────────────

test('a provenance-screened catalog keeps Host, skill and extension rows, drops unsupported TUI rows, and gates /model on the mounted picker -> the rendered popup rows', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-provenance-')
  const h = await mountChain(life, home)
  // TSP I-C: the genuine Host-origin winner is never screened by the
  // TUI-builtin gate, even under a name the mounted renderer cannot run.
  assert.deepEqual(h.commands.hostClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the Host claims still route /settings through the advertised union')
  assert.deepEqual(h.commands.hostOriginClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the genuine Host-origin authority still owns the same name')
  assert.equal(h.commands.isSkillWrapper('glab'), true, 'the live dynamic skill wrapper is really installed')

  const shown = await visibleCatalog(h)
  assert.ok(shown.includes('settings'), `the genuine Host-origin row survives the screen: ${shown.join(', ')}`)
  assert.ok(shown.includes('glab'), `the live skill wrapper survives the screen: ${shown.join(', ')}`)
  assert.ok(shown.includes(CONTRIBUTION_NAME), `the extension contribution survives the screen: ${shown.join(', ')}`)
  assert.ok(shown.includes('model'), `a mounted Model presenter keeps /model: ${shown.join(', ')}`)
  for (const unsupported of ['help', 'rewind', 'login', 'logout']) {
    assert.equal(shown.includes(unsupported), false, `/${unsupported} is not offered in the full catalog scan`)
    // A name-typed query is the DIRECT witness: had the screen kept that TUI
    // Client registration, the provider would have returned exactly it.
    await h.surface.composer.setDraft(`/${unsupported}`)
    await waitUntil(`the /${unsupported} query reached the wire`, () => h.editor().text === `/${unsupported}`)
    await h.triggerQuietly(TAB)
    assert.equal(h.values().includes(unsupported), false,
      `the mounted renderer cannot run /${unsupported}, so the provenance screen dropped that row`)
    assert.deepEqual(h.submits, [], `the /${unsupported} query never submitted`)
  }
  await h.surface.composer.setDraft('/')
  await waitUntil('the catalog query returned to /', () => h.editor().text === '/')
  assert.deepEqual(h.editor(), { text: '/', cursor: 1 }, 'typing / only queried the catalog; it never edited a row')
  assert.equal(h.submits.length, 0, 'catalog completion never submits')

  // The SAME live capability read the command layer samples per commit: false
  // removes /model, and the genuine Host-origin row still survives. Overriding
  // the SURFACE's own getter is the real fact `bootstrap` reads; no renderer
  // internals are replaced and no second catalog is installed.
  Object.defineProperty(h.surface, 'modelPresentation', { configurable: true, get: () => undefined })
  h.commitCatalog()
  const after = await visibleCatalog(h)
  assert.equal(after.includes('model'), false, 'without the mounted presenter /model leaves the menu')
  assert.ok(after.includes('settings'), 'the genuine Host-origin row is never gated by the picker')
  assert.ok(after.includes('glab'), 'the live skill wrapper is never gated by the picker')
  assert.ok(after.includes(CONTRIBUTION_NAME), 'the extension contribution is never gated by the picker')
  assert.equal(h.commands.hostClaimOf({ name: 'settings' })?.claimed, true,
    'the advertised Host claim survived the recommit')
  assert.equal(h.commands.hostOriginClaimOf({ name: 'settings' })?.claimed, true,
    'the genuine Host-origin claim survived the recommit')
})

/**
 * Re-open the popup and walk the REAL candidate list through its own Tab /
 * Shift+Tab gestures, so a catalog of more than six rows is observed in full.
 * The first highlighted row is recorded once per position; the walk is bounded
 * by the number of rows the wire can show, never an open-ended loop.
 */
async function visibleCatalog(h: ChainHarness): Promise<string[]> {
  const seen = new Set<string>()
  // A fresh query starts on the empty first line. Program-owned draft writes
  // commit their own frame but deliberately run no completion trigger.
  h.surface.composer.setDraft('')
  await waitUntil('the composer is clear for the catalog observation', () => h.editor().text === '')
  await h.press('/')
  await waitUntil('the first candidate window painted', () => h.values().length > 0)
  const total = 64 // bounded: the scripted catalog is smaller than this window
  for (let step = 0; step < total; step += 1) {
    for (const value of h.values()) seen.add(value)
    const highlighted = h.rows().find(row => row.highlighted)
    if (highlighted === undefined) break
    const before = highlighted.id
    await h.press(TAB)
    const after = h.rows().find(row => row.highlighted)
    if (after?.id === before || after === undefined) break
    if (after.id === h.rows()[0]?.id) {
      for (const value of h.values()) seen.add(value)
      break // wrapped back to the first row: the whole window was visited
    }
  }
  return [...seen]
}

test('a failed source synthesis installs an empty candidate set while the Host claims still route -> Tab paints no popup and the claims still resolve', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-collision-')
  const h = await mountChain(life, home)
  // `display:'none'` is the command layer's FAILED-SOURCE state: a fresh
  // contribution colliding with the Host catalog fails the synthesis at the
  // SAME single commit point that forwards the catalog to the mount.
  h.addContribution('alpha')
  h.commitCatalog()
  assert.deepEqual(h.commands.hostClaimOf({ name: 'alpha' }), { claimed: true, attachments: false },
    'the Host still claims the bare /alpha line')
  assert.deepEqual(h.commands.hostOriginClaimOf({ name: 'alpha' }), { claimed: true, attachments: false },
    'the genuine Host-origin authority still resolves the name')
  assert.deepEqual(h.commands.hostClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the genuine Host settings claim is never withdrawn by the failed display')
  assert.deepEqual(h.commands.hostOriginClaimOf({ name: 'settings' }), { claimed: true, attachments: false },
    'the routing authority still owns /settings')
  assert.equal(h.commands.wasAdvertised('alpha'), true, 'the advertised claim survives the empty display')
  assert.equal(h.commands.isSkillWrapper('glab'), true, 'the live skill wrapper still exists')

  const since = h.frameCount()
  await h.press('/')
  await h.waitNoRowPaint(since, 'the empty display list offers no candidate row')
  await h.pressQuietly(TAB)
  assert.equal(h.values().length, 0, 'Tab cannot open a shell of a menu against the empty source')
  assert.deepEqual(h.editor(), { text: '/', cursor: 1 }, 'the failed source never wrote a candidate into the draft')
  assert.equal(h.submits.length, 0, 'the failed source never submitted')
})

// ── B. Accept never executes ─────────────────────────────────────────────────

test('Tab then Enter accepts /new into the composer -> the wire shows /new␠ with zero submissions, and the next Enter submits that line once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-accept-')
  const h = await mountChain(life, home)
  await typeKeys(h, '/ne')
  await waitUntil('the natural query painted', () => h.values().length > 0)
  // Escape closes only the list; the draft stays exactly what the user typed.
  await h.press(ESCAPE)
  assert.deepEqual(h.values(), [], 'Escape closed the candidate list')
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the dismissal edited nothing')
  assert.equal(h.submits.length, 0, 'the dismissal ran no cancel and no submit')
  // Tab is now the seat's OWN trigger: the fresh list highlights /new.
  await h.triggerQuietly(TAB)
  assert.deepEqual(h.values()[0], 'new', 'the Tab trigger re-opened the list on /new')
  // A plain Enter accepts the highlighted row. It only ever EDITS the composer.
  await h.press(ENTER)
  await waitUntil('the accept reached the composer wire', () => h.editor().text === '/new ')
  assert.deepEqual(h.editor(), { text: '/new ', cursor: 5 },
    'the accept wrote the command name plus the provider separator with the caret after it (UTF-16)')
  assert.deepEqual(h.values(), [], 'the accepted frame carries no stale popup')
  assert.equal(h.submits.length, 0, 'accepting a candidate recorded ZERO application submissions')
  assert.equal(h.writes.length, 0, 'the real controller wrote ZERO business prompts')

  // The LATER plain Enter is the only gesture that reaches the existing
  // submission path (the same live third argument / scopeToken chain I-A uses).
  await h.press(ENTER)
  await waitUntil('the application submit entry recorded the submission', () => h.submits.length === 1)
  assert.deepEqual(h.submits.map(entry => entry.text), ['/new '],
    'exactly ONE submission of the resulting composer line')
  assert.equal(typeof h.submits[0]!.token, 'number',
    'the application submit entry carried the mount\'s live scope token into the real controller')
  assert.equal(h.submits[0]!.request, 'enter', 'the gesture stayed the plain Enter the composer reports')
  assert.deepEqual(h.editor(), { text: '/new ', cursor: 5 },
    'the second Enter submitted the resulting line without a second draft edit')
})

/** Type one draft through REAL decoded SDK keys: each character is its own
 *  committed composer edit, never a program-owned draft replacement. */
async function typeKeys(h: ChainHarness, text: string): Promise<void> {
  for (const char of text) await h.press(char)
}

// ── C. Every catalog commit replaces the source ──────────────────────────────

test('a catalog commit that withdraws a command removes its row from the wire -> the stale row cannot be clicked or accepted', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-replace-')
  const h = await mountChain(life, home)
  await typeKeys(h, '/g')
  await waitUntil('the L1 candidate painted', () => h.values().includes('glab'))
  const stale = h.rows().find(row => row.value === 'glab')
  assert.ok(stale, 'the live skill wrapper row is on the wire before the recommit')

  // L2: the REAL single commit point re-synthesises the catalog WITHOUT the
  // skill wrapper (a genuine Host same-name winner blocks its registration).
  const l2: readonly HostRow[] = [
    { name: 'alpha', description: 'Host alpha command' },
    { name: 'settings', description: 'Host settings panel', definitionId: '@host/genuine/settings' },
    { name: 'glab', description: 'the genuine Host glab', definitionId: '@host/genuine/glab' },
  ]
  // Drive the same `installSnapshot` commit the coordinator owns: the Host
  // authority changes, the wrapper is retired and the catalog is reinstalled.
  h.commands.installSnapshot(Object.freeze({
    commands: Object.freeze(l2.map(row => Object.freeze({ ...row }))),
    scopedCommands: Object.freeze([]),
    skills: Object.freeze([]),
    issues: Object.freeze([]),
  }))
  await waitUntil('the new catalog withdrew the old row', () => !h.values().includes('glab'))
  assert.equal(h.commands.isSkillWrapper('glab'), false, 'the live wrapper was really retired by the recommit')
  assert.equal(h.commands.hostOriginClaimOf({ name: 'glab' })?.claimed, true,
    'the same name is now the genuine Host winner, never the withdrawn wrapper')

  // The stale painted row's own identity cannot write into the composer.
  await h.clickRow(stale)
  assert.deepEqual(h.editor(), { text: '/g', cursor: 2 }, 'the withdrawn row cannot be accepted by click')
  assert.equal(h.submits.length, 0, 'the withdrawn row cannot submit')
  // A plain Enter with the new (empty) source belongs to the Composer again:
  // its ordinary draft text can still be submitted, but never a withdrawn row.
  await h.press(ENTER)
  assert.deepEqual(h.submits.map(entry => entry.text), ['/g'],
    'the key submitted the LIVE draft text, never the withdrawn candidate')
  assert.ok(!h.editor().text.includes('/glab'),
    'the withdrawn command was never written into the composer')
})

// ── D. Late/async currentness ────────────────────────────────────────────────

test('a slow extension answer arriving after the user typed on paints no popup, writes no draft and submits nothing -> the wire stays on the typed query', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-late-typed-')
  const h = await mountChain(life, home, { holdPluginAnswers: true })
  // An unknown token is the honest plugin-fallback path: the REAL host
  // provider answers null and the command layer's extensionSuggest wrapper
  // asks the REAL plugin registry, whose answer is scripted to be late.
  await typeKeys(h, '/zz')
  await waitUntil('the plugin chain was really asked', () => h.plugin.asked() > 0)
  const before = h.frameCount()
  await h.press('q')
  await waitUntil('the typed-on document reached the wire', () => h.editor().text === '/zzq')
  h.plugin.release(0, [{ value: 'stale', label: 'stale' }])
  await h.waitNoRowPaint(before, 'a superseded plugin answer never paints')
  assert.deepEqual(h.editor(), { text: '/zzq', cursor: 4 }, 'the late answer never wrote a candidate into the draft')
  assert.equal(h.submits.length, 0, 'the late answer never submitted')
  assert.equal(h.hostFileCalls(), 0, 'the late path never touched the Host-file port')
})

test('a slow extension answer arriving after a new display subject commits paints no popup, writes no draft and submits nothing -> the wire carries the committed subject', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-late-subject-')
  const h = await mountChain(life, home, { holdPluginAnswers: true })
  await typeKeys(h, '/zz')
  await waitUntil('the plugin chain was really asked', () => h.plugin.asked() > 0)
  const before = h.frameCount()
  // The application's OWN formal display commit (a new projection source).
  const subject = {}
  h.surface.display.setTranscript([], undefined, undefined, undefined, undefined, subject)
  h.plugin.release(0, [{ value: 'stale', label: 'stale' }])
  await h.waitNoRowPaint(before, 'a plugin answer from the outgoing subject never paints')
  assert.deepEqual(h.editor(), { text: '/zz', cursor: 3 }, 'the late answer never wrote a draft')
  assert.equal(h.submits.length, 0, 'the late answer never submitted')
  assert.equal(h.hostFileCalls(), 0, 'no file discovery ran for the late answer')
})

test('a slow extension answer arriving after a scope begin paints no popup, writes no draft and submits nothing -> the wire keeps the original query', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-late-scope-')
  const h = await mountChain(life, home, { holdPluginAnswers: true })
  await typeKeys(h, '/zz')
  await waitUntil('the plugin chain was really asked', () => h.plugin.asked() > 0)
  const before = h.frameCount()
  h.renderer().display.beginInputHistoryScope('B')
  h.plugin.release(0, [{ value: 'stale', label: 'stale' }])
  await h.waitNoRowPaint(before, 'a plugin answer from the retired scope never paints')
  assert.deepEqual(h.editor(), { text: '/zz', cursor: 3 }, 'the late answer never wrote a draft')
  assert.equal(h.submits.length, 0, 'the late answer never submitted')
  assert.equal(h.hostFileCalls(), 0, 'no file discovery ran for the late answer')
})

// ── E. Seat priority ─────────────────────────────────────────────────────────

test('a Modal or Permission menu owning the keys keeps arrows and Enter from the hidden composer popup -> no candidate is consumed or painted, and keys work again after the owner closes', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-priority-')
  const h = await mountChain(life, home)
  await typeKeys(h, '/n')
  await waitUntil('the composer popup is open before the modal', () => h.values().length > 0)
  const before = h.editor()
  // A REAL Question through the mount's own interaction presenter: the modal
  // seat is above the composer's completion seat in dispatchKey's fixed ladder.
  const promise = h.renderer().interaction.askQuestions(
    [{ id: 'q1', question: 'Pick one?', options: [{ label: 'first' }, { label: 'second' }] }],
    undefined,
    undefined,
    false,
  )
  promise.catch(() => {})
  await waitUntil('the real Question owns a modal wire layer', () =>
    wireNodes(h.pane).some(node => /^layer\.modal-\d+$/.test(node.id)))
  assert.equal(h.rows().length, 0, 'the hidden popup is withdrawn at the modal paint')
  const modalFrame = h.frameCount()
  await h.pressQuietly(DOWN)
  await h.pressQuietly(ENTER)
  assert.equal(h.rows().length, 0, 'the hidden popup was never painted or consumed under the modal')
  assert.deepEqual(h.editor(), before, 'the modal Arrow/Enter never edited the hidden composer draft')
  assert.equal(h.submits.length, 0, 'the modal Arrow/Enter never submitted the hidden draft')
  assert.ok(h.frameCount() >= modalFrame, 'the modal stayed the visible owner on the wire')
  // Close through the modal's OWN Escape route; keys then return to the composer.
  await h.pressQuietly(ESCAPE)
  await waitUntil('the modal seat closed', () =>
    !wireNodes(h.pane).some(node => /^layer\.modal-\d+$/.test(node.id)))
  await typeKeys(h, 'e')
  await waitUntil('a fresh composer query painted after the modal closed', () => h.values().length > 0)
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the composer keys work again after the modal')
  assert.equal(h.submits.length, 0, 'the reopened seat still never submits on its own')

  // The REAL Quiet Composer Permission menu: its trigger is the wire's own
  // node, and Arrow/Enter belong to the menu while it is expanded.
  const trigger = wireNodes(h.pane).find(node => node.k === 'el'
    && node.id.includes('.composer-permission-s') && !node.id.includes('option'))
  assert.ok(trigger, 'the Permission trigger is on the wire')
  h.pane.event({ ev: 'action', sf: h.pane.frames().at(-1)!.sf, id: trigger.id, act: 'click' })
  await waitUntil('the Permission menu owns its options on the wire', () =>
    wireNodes(h.pane).filter(node => node.k === 'el' && node.id.includes('.composer-permission-option-')).length === 3)
  assert.equal(h.rows().length, 0, 'the hidden composer popup was withdrawn under the Permission menu')
  const optionsBefore = wireNodes(h.pane).filter(node => node.id.includes('.composer-permission-option-'))
    .map(node => (node.p.attrs as Record<string, unknown> | undefined)?.['data-highlight'] === 'true')
  await h.press(DOWN)
  const optionsAfter = wireNodes(h.pane).filter(node => node.id.includes('.composer-permission-option-'))
    .map(node => (node.p.attrs as Record<string, unknown> | undefined)?.['data-highlight'] === 'true')
  assert.notDeepEqual(optionsAfter, optionsBefore, 'the Arrow moved the MENU highlight, not a candidate row')
  assert.equal(h.rows().length, 0, 'the hidden composer popup was not painted under the Permission menu')
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the menu Arrow never edited the draft')
  assert.equal(h.submits.length, 0, 'the menu Arrow never submitted')
  await h.press(ESCAPE)
  assert.equal(h.cancels(), 0, 'the menu Escape closed only the menu, it never became a cancel intent')
  // The REAL Model Quick menu: the combined Model/Effort trigger opens it
  // through the surface's late-bound /model command entry. Its arrows and
  // Enter belong to that higher presenter, never to the hidden popup.
  const modelTrigger = wireNodes(h.pane).find(node => node.k === 'el'
    && node.id.includes('.composer-model-quick') && !node.id.includes('menu'))
  assert.ok(modelTrigger, 'the Model Quick trigger is on the wire')
  h.pane.event({ ev: 'action', sf: h.pane.frames().at(-1)!.sf, id: modelTrigger.id, act: 'click' })
  await waitUntil('the Model Quick menu mounted on the wire', () =>
    wireNodes(h.pane).some(node => node.id.includes('.composer-quick-menu-')))
  assert.equal(h.rows().length, 0, 'the hidden composer popup was withdrawn under the Model Quick menu')
  const quickFrame = h.frameCount()
  await h.pressQuietly(DOWN)
  await h.pressQuietly(ENTER)
  assert.equal(h.rows().length, 0, 'the Model Quick menu owned the keys without painting a candidate list')
  assert.deepEqual(h.editor(), { text: '/ne', cursor: 3 }, 'the Model Quick gestures never edited the draft')
  assert.equal(h.submits.length, 0, 'the Model Quick gestures never submitted')
  assert.ok(h.frameCount() >= quickFrame, 'the Model Quick menu remained the visible owner')
  // Its own Escape closes it; then the composer's keys work again.
  await h.pressQuietly(ESCAPE)
  await waitUntil('the Model Quick menu closed', () =>
    !wireNodes(h.pane).some(node => node.id.includes('.composer-quick-menu-')))
  await h.press(ENTER)
  await waitUntil('a fresh composer key submitted after the Model Quick menu', () => h.submits.length === 1)
  assert.deepEqual(h.submits.map(entry => entry.text), ['/ne'],
    'the composer keys work again after the Model Quick menu: a plain Enter submits the live draft')
  assert.equal(h.rows().length, 0, 'the key never painted a hidden candidate list')
})


// ── F. Session switch A -> B -> A ────────────────────────────────────────────

test('an open popup at A is withdrawn when B publishes and needs a fresh query after returning to A -> the stale row never reaches B or A', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-switch-')
  const h = await mountChain(life, home)
  // A's REAL formal history/recall scope: the I-B composition's publication seam.
  h.surface.display.beginInputHistoryScope('A')
  h.surface.display.resetInputHistory(['newest A row', 'older A row'], 'A')
  await typeKeys(h, '/n')
  await waitUntil('A\'s candidate list painted', () => h.values().length > 0)
  const stale = h.rows().find(row => row.value === 'new')
  assert.ok(stale, 'A\'s /new row is on the wire')
  // B publishes through the SAME seam; the list belongs to A's scope only.
  // `beginInputHistoryScope` is a pure-state commit, so a real decoded key
  // drives the frame that withdraws A's painted rows.
  h.surface.display.beginInputHistoryScope('B')
  await h.press('x')
  await waitUntil('B withdrew A\'s candidate list', () => h.values().length === 0)
  assert.deepEqual(h.editor(), { text: '/nx', cursor: 3 }, 'the publication edited no draft; the probe key did')
  await h.clickRow(stale)
  assert.deepEqual(h.editor(), { text: '/nx', cursor: 3 }, 'A\'s stale row cannot be accepted into B')
  assert.equal(h.submits.length, 0, 'A\'s stale row cannot submit into B')
  // Back to A: no list is resurrected from the retired scope.
  h.surface.display.beginInputHistoryScope('A')
  assert.deepEqual(h.values(), [], 'returning to A shows no stale popup')
  await h.pressQuietly(HOME)
  assert.deepEqual(h.editor(), { text: '/nx', cursor: 0 },
    'the retired completion list consumed no arrow; the caret moved to the line start')
  assert.equal(h.submits.length, 0, 'the recall arrow submitted nothing')
  // A fresh Edit is required before candidates paint again: the natural
  // trigger runs off the composer's OWN committed edit, never off a scope seam.
  await h.surface.composer.setDraft('')
  await waitUntil('the program-owned clear reached the wire', () => h.editor().text === '')
  await typeKeys(h, '/n')
  await waitUntil('a fresh query painted A\'s new list', () => h.values().length > 0)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 2 }, 'only the fresh query rebuilt the seat')
})

// ── G. I-B coexistence ───────────────────────────────────────────────────────

test('with the popup closed unmodified arrows recall newest-first and restore the original draft -> with it open they walk candidates and leave the recall kernel unchanged', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-ic-coexistence-')
  const h = await mountChain(life, home)
  h.surface.display.beginInputHistoryScope(SESSION_ID)
  h.surface.display.resetInputHistory(['newest row', 'oldest row'], SESSION_ID)
  await typeKeys(h, '/n')
  await waitUntil('the candidate list is open', () => h.values().length > 0)
  const factsBefore = h.renderer().scopeFactCountForTest()
  const reconcileBefore = h.renderer().reconcileStepsForTest()
  const highlightedBefore = h.rows().find(row => row.highlighted)?.id
  await h.press(UP)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 2 },
    'with the popup open, Up walked a candidate and never recalled history')
  assert.notEqual(h.rows().find(row => row.highlighted)?.id, highlightedBefore,
    'the candidate highlight really moved')
  assert.equal(h.renderer().scopeFactCountForTest(), factsBefore,
    'the recall kernel settled no new scope fact while the list owned the arrow')
  assert.equal(h.renderer().reconcileStepsForTest(), reconcileBefore,
    'the recall snapshot did not reseed/reconcile while the list owned the arrow')
  assert.equal(h.submits.length, 0, 'a candidate arrow submitted nothing')
  await h.press(ESCAPE)
  assert.deepEqual(h.values(), [], 'Escape closed only the candidate list')
  // Popup CLOSED: the I-B recall is the owner again. A first Up moves the caret
  // to the line start, the second Up recalls the newest row, Down from index 0
  // restores the original draft exactly as the I-B composition proves.
  await h.press(UP)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 0 }, 'the first Up is the I-B line Home step')
  await h.press(UP)
  assert.deepEqual(h.editor(), { text: 'newest row', cursor: 0 }, 'unmodified Up recalls the newest row')
  await h.press(UP)
  assert.equal(h.editor().text, 'oldest row', 'a second Up recalls the older row')
  assert.equal(h.renderer().scopeFactCountForTest(), factsBefore,
    'browsing the recall snapshot still added no new scope fact')
  await h.press(DOWN)
  assert.equal(h.editor().text, 'newest row', 'Down walks back toward index 0')
  await h.press(DOWN)
  assert.deepEqual(h.editor(), { text: '/n', cursor: 2 },
    'Down from index 0 restored the original draft and caret')
  assert.equal(h.submits.length, 0, 'no recall arrow submitted')
})

// ── H. The I-D seat matrix: which documents still open NOTHING ───────────────

/** The documents that stay closed at BOTH file seats (plan §0/§6 D04): a shell
 *  line, an absolute path, an ordinary relative path (even one that EXISTS
 *  Client-locally), a path inside prose, an email, a package version and a URL
 *  are never a `@` mention and never a declared file argument. */
const CLOSED_DRAFTS: readonly string[] = [
  '!',
  '!!',
  '/usr/bin',
  './notes.txt',
  'look at shots/err.png',
  'hello notes',
  'a@b.com',
  'pkg@1.0.0',
  'https://example.com/notes',
]

test('a shell line, an absolute or ordinary path, prose, an email, a version and a URL open no candidate seat -> no row, no Host discovery and no Client read, while an @src/ draft asks ONLY the Host port and accepts the official literal reference', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-matrix-')
  writeClientFiles(home, ['notes.txt', 'shots/err.png'])
  const h = await mountChain(life, home, {
    // The Host authority answers `src/` and answers an EMPTY list for
    // everything else — an authoritative `ok:[]`, never `unavailable`.
    hostFiles: query => query === 'src/'
      ? {
        kind: 'ok',
        items: [
          { path: 'src/deep.ts', kind: 'file' },
          { path: 'src/deep', kind: 'directory' },
        ],
      }
      : { kind: 'ok', items: [] },
  })
  for (const draft of CLOSED_DRAFTS) {
    // Program-owned draft writes commit their own controlled-editor frame but
    // run NO natural completion query; ONE real decoded Tab — the seat's own
    // trigger — then probes exactly this document.
    // NON-VACUOUS WITNESS: the positive half at the end of this very case shows
    // the SAME `rows()`/`popupPaintedSince` machinery reporting a dotted
    // candidate (`@src/deep.ts`), so "no row" here is an observation, not a
    // blind filter.
    await h.setDraft(draft)
    const since = h.frameCount()
    const hostBefore = h.host.listCalls()
    await h.triggerQuietly(TAB)
    assert.equal(h.rows().length, 0, `${JSON.stringify(draft)} paints no candidate popup`)
    assert.equal(popupPaintedSince(h.pane, since), false,
      `${JSON.stringify(draft)} never painted a candidate list in any frame`)
    assert.equal(h.host.listCalls(), hostBefore, `${JSON.stringify(draft)} never reached the Host-file port`)
    assert.equal(h.host.resolveCalls() + h.host.canonicalizeCalls(), 0,
      `${JSON.stringify(draft)} never probed or canonicalized a Host path`)
    assert.equal(h.imageRead.calls(), 0, `${JSON.stringify(draft)} read no Client-local file`)
    assert.equal(h.images.values().length + h.files.values().length, 0,
      `${JSON.stringify(draft)} staged no draft attachment`)
    assert.equal(h.submits.length, 0, `${JSON.stringify(draft)} submitted nothing`)
    assert.deepEqual(h.editor(), { text: draft, cursor: draft.length },
      `the Tab trigger edited nothing in ${JSON.stringify(draft)}`)
  }
  // `/attach` with NO separator is the I-C leading COMMAND seat, never a path
  // argument seat: the classifier needs the separator. Whatever that seat shows
  // is a command name — a path row here would mean the file seat opened early.
  await h.setDraft('/attach')
  const attachHostBefore = h.host.listCalls()
  await h.triggerQuietly(TAB)
  t.diagnostic(`/attach with no separator painted: ${JSON.stringify(h.rows().map(row => row.text))}`)
  assert.equal(h.rows().every(row => /^\/[a-z0-9._:-]+$/u.test(row.text)), true,
    `no separator means no argument seat: ${h.rows().map(row => row.text).join(', ')}`)
  assert.equal(h.host.listCalls(), attachHostBefore, 'the /attach command seat never reached the Host-file port')
  assert.equal(h.imageRead.calls(), 0, 'the /attach command seat read no Client-local file')
  assert.equal(h.submits.length, 0, 'the /attach probe submitted nothing')

  // A bare `@` alone IS an open seat now (I-D retires I-C's no-file-seat rule),
  // and the Host's authoritative EMPTY answer paints nothing: no row, no
  // Client-local fallback scan, no read, no stage.
  await h.setDraft('@')
  const atSince = h.frameCount()
  const atHostBefore = h.host.listCalls()
  await h.triggerQuietly(TAB)
  assert.ok(h.host.listCalls() > atHostBefore, 'a bare @ asks the Host-file port')
  assert.deepEqual(h.host.queries().slice(-1), [''], 'the official query form is the text AFTER the @')
  assert.equal(h.rows().length, 0, 'the Host answered ok:[] — nothing is painted')
  assert.equal(popupPaintedSince(h.pane, atSince), false,
    'an authoritative empty Host answer painted no list in any frame')
  assert.equal(h.imageRead.calls(), 0, 'an empty Host answer never falls back to a Client-local read')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'an empty Host answer staged nothing')

  // THE POSITIVE HALF: `@src/` opens the Host seat and ONLY the Host seat.
  await h.setDraft('请看 @src/')
  const hostBefore = h.host.listCalls()
  const positiveSince = h.frameCount()
  await h.triggerQuietly(TAB)
  await waitUntil('the Host @ candidates painted', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['@src/deep.ts', '@src/deep/'],
    'the official mention form paints the Host list in the Host order')
  // The SAME absence witness used above must report THIS popup: the negatives
  // above are observations, not a blind filter (a dotted candidate name is
  // exactly what an id-anchored pattern would have missed).
  assert.equal(popupPaintedSince(h.pane, positiveSince), true,
    'the popup witness really sees a dotted @ candidate')
  assert.equal(h.host.listCalls(), hostBefore + 1, 'ONE query per trigger — no second discovery')
  assert.deepEqual(h.host.queries().slice(-1), ['src/'], 'the port received the official path query')
  assert.equal(h.imageRead.calls(), 0, 'a Host @ reference reads no Client-local file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'a Host @ reference stages nothing')
  assert.equal(h.mountPorts.stagers.length, 1, 'the ONE stager install reached the current mount')
  // Accepting a Host reference only EDITS the composer: never a submit, never a
  // read, never a stage — and the prose on both sides survives byte for byte.
  await h.press(ENTER)
  await waitUntil('the accepted reference reached the composer wire', () => h.editor().text === '请看 @src/deep.ts ')
  assert.deepEqual(h.editor(), { text: '请看 @src/deep.ts ', cursor: 16 },
    'the official mention value landed with ONE separator and the UTF-16 caret after it')
  assert.deepEqual(h.rows(), [], 'the accepted frame carries no stale popup')
  assert.equal(h.submits.length, 0, 'accepting a Host reference recorded ZERO submissions')
  assert.equal(h.writes.length, 0, 'accepting a Host reference wrote ZERO business prompts')
  assert.equal(h.imageRead.calls(), 0, 'the accepted reference read no Client-local file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'the accepted reference staged nothing')
  // The LATER plain Enter is the only gesture that submits, and it sends the
  // LITERAL reference: no send-time probe, no rewrite, no attachment.
  await h.press(ENTER)
  await waitUntil('the application submit entry recorded the literal reference', () => h.submits.length === 1)
  assert.deepEqual(h.submits.map(entry => entry.text), ['请看 @src/deep.ts '])
  await waitUntil('the real controller wrote the literal prompt', () => h.writes.length === 1)
  const written = h.writes[0] as { sessionId: string; message: { text: string; segments: readonly { type: string }[]; hasFiles: boolean } }
  assert.equal(written.sessionId, SESSION_ID, 'the write carried this composition\'s session')
  assert.equal(written.message.text, '请看 @src/deep.ts ', 'the submitted draft travelled verbatim into the real prompt')
  assert.deepEqual(written.message.segments.map(segment => segment.type), ['text'],
    'a Host @ reference is ordinary text — never a staged attachment')
  assert.equal(written.message.hasFiles, false, 'no generic file rode that prompt')
  assert.equal(h.host.resolveCalls(), 0, 'the send path never probed the reference for existence')
  assert.equal(h.host.canonicalizeCalls(), 0, 'the send path never canonicalized the reference')
})


// ── I. One failed source closes only ITS seat (matrix D23) ───────────────────

test('a failed catalog source closes only the leading-slash seat -> the Host @ seat and the Client-local path seat still answer from their own sources and no plugin answer revives the failed command menu', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-sourcefailed-')
  writeClientFiles(home, ['notes.txt'])
  const h = await mountChain(life, home, {
    // Every plugin answer is HELD: if the seat asked the chain for a command
    // the failed source withdrew, the case would see `asked()` move.
    holdPluginAnswers: true,
    hostFiles: query => query === 'src/'
      ? { kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }
      : { kind: 'ok', items: [] },
  })
  // The same single commit point that forwards the catalog fails its synthesis.
  h.addContribution('alpha')
  h.commitCatalog()
  assert.deepEqual(h.commands.hostClaimOf({ name: 'alpha' }), { claimed: true, attachments: false },
    'the Host claim survives the failed display')

  const slashSince = h.frameCount()
  await h.setDraft('/new')
  await h.triggerQuietly(TAB)
  assert.equal(h.rows().length, 0, 'the failed command source paints no menu')
  assert.equal(popupPaintedSince(h.pane, slashSince), false,
    'the failed command source never painted a list in any frame')
  assert.equal(h.plugin.asked(), 0,
    'a failed command source is not asked, so no plugin answer can revive it')

  // A failed COMMAND source says nothing about the Host file source.
  await h.setDraft('@src/')
  const hostBefore = h.host.listCalls()
  await h.triggerQuietly(TAB)
  await waitUntil('the Host @ seat still answered while the command source failed', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['@src/deep.ts'],
    'the Host source answers its own seat over a failed catalog')
  assert.equal(h.host.listCalls(), hostBefore + 1, 'exactly ONE Host discovery for that query')

  // …and nothing about the Client-local filesystem either.
  await h.setDraft('/image note')
  const hostBeforePath = h.host.listCalls()
  await h.triggerQuietly(TAB)
  await waitUntil('the Client-local path seat still answered while the command source failed', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['notes.txt'],
    'the Client-local discovery answers its own seat over a failed catalog')
  assert.equal(h.host.listCalls(), hostBeforePath, 'the local path seat never asked the Host port')
  assert.equal(h.plugin.asked(), 0, 'neither file seat needed the plugin chain')
  assert.equal(h.imageRead.calls(), 0, 'a candidate list reads no file')
  assert.equal(h.submits.length, 0, 'a candidate at any of these seats never submits')

  // The failure is not sticky: the collision goes, the SAME commit restores the
  // command seat, and the file seats stay correct throughout.
  h.contributions.remove('alpha')
  h.commitCatalog()
  await h.setDraft('/ne')
  await h.triggerQuietly(TAB)
  await waitUntil('the recovered command source paints its menu again', () => h.values().includes('new'))
  assert.equal(h.rows().every(row => /^\/[a-z0-9._:-]+$/u.test(row.text)), true,
    `the recovered menu is the command menu, never a file list: ${h.rows().map(row => row.text).join(', ')}`)
})

// ── J. Host-vs-Client locality of ONE name (matrix D18/D05) ──────────────────

test('one file name is owned by exactly ONE authority per seat -> @notes asks only the HostFilePort, /image notes lists only the Client-local file, an authoritative empty Host answer never falls back, and /image @foo stays a local argument', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-locality-')
  writeClientFiles(home, ['notes.txt'])
  // The SAME name exists on both sides, with DIFFERENT content: the Host lists
  // `from-host/notes.txt`, the Client filesystem holds `notes.txt`.
  let hostAnswers = true
  const h = await mountChain(life, home, {
    hostFiles: query => {
      if (query === 'notes' && hostAnswers) {
        return { kind: 'ok', items: [{ path: 'from-host/notes.txt', kind: 'file' }] }
      }
      return { kind: 'ok', items: [] }
    },
  })

  await h.setDraft('@notes')
  const localBeforeHost = h.imageRead.calls()
  const hostBefore = h.host.listCalls()
  await h.triggerQuietly(TAB)
  await waitUntil('the Host answered the @ seat', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['@from-host/notes.txt'],
    'the @ seat shows ONLY what the Host authority returned')
  assert.ok(h.host.listCalls() > hostBefore, 'the @ seat reached the Host port')
  assert.equal(h.imageRead.calls(), localBeforeHost, 'the @ seat ran no Client-local read')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'the @ seat staged nothing')

  await h.setDraft('/image notes')
  const hostBeforeLocal = h.host.listCalls()
  await h.triggerQuietly(TAB)
  await waitUntil('the Client-local discovery answered the path seat', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['notes.txt'],
    'the /image argument shows ONLY the Client-local file')
  assert.equal(h.host.listCalls(), hostBeforeLocal, 'the local path seat never asked the Host port')

  // A declared command argument that LITERALLY reads `@foo` is still the
  // Client-local path seat: the classifier owns that order and the Host mention
  // seat never borrows a command argument.
  await h.setDraft('看一下 /image @no')
  const hostBeforeQuoted = h.host.listCalls()
  await h.triggerQuietly(TAB)
  assert.equal(h.host.listCalls(), hostBeforeQuoted,
    'the /image argument beginning with @ never reaches the Host port')
  assert.equal(h.rows().length, 0, 'no Client-local file is named `@no`, so nothing paints')

  // The Host's authoritative `ok:[]` is a Host FACT: the Client filesystem that
  // really does hold `notes.txt` is never scanned as a fallback.
  hostAnswers = false
  await h.setDraft('@notes')
  const emptySince = h.frameCount()
  const hostBeforeEmpty = h.host.listCalls()
  await h.triggerQuietly(TAB)
  assert.ok(h.host.listCalls() > hostBeforeEmpty, 'the @ seat still asked the Host')
  assert.equal(h.rows().length, 0, 'an authoritative empty Host answer paints nothing')
  assert.equal(popupPaintedSince(h.pane, emptySince), false,
    'the empty Host answer never painted a Client-local fallback list')
  assert.equal(h.imageRead.calls(), 0, 'the empty Host answer read no Client-local file')
  // …and the local seat keeps answering from its own source, unaffected.
  await h.setDraft('/image notes')
  await h.triggerQuietly(TAB)
  await waitUntil('the local seat still answers after the Host went empty', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['notes.txt'],
    'the Client-local source is independent of the Host answer')
})

// ── K. The ONE inline stager really reaches the mount (matrix D11 positive) ──

/** Every text value the live wire carries, joined for a contains-check. */
function wireText(pane: TspPane): string {
  return wireNodes(pane).map(node => String(node.p.text ?? '')).join('\n')
}

test('the command registration installs the ONE inline stager on the current mount -> an inline action opens the local path seat, a real file accept reads through the production intake, replaces its own fragment with the placeholder and the real controller carries that attachment into the prompt', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-inline-stage-')
  writeClientFiles(home, ['shot.png'])
  const h = await mountChain(life, home)
  // POSITIVE installation: the real chain
  // `registerTuiCommands` → `presentation.installTspInlineAttachmentStager` →
  // `surface.installTspInlineAttachmentStager` → the SurfaceRuntime forward →
  // THIS mount's port. Exactly ONE stager install (the single registration
  // site), beside the catalog commits of the same registration.
  assert.equal(h.mountPorts.stagers.length, 1, 'the registration installed ONE stager on the current mount')
  assert.ok(h.mountPorts.catalogInstalls.length >= 1,
    `the same registration committed its catalog onto this mount (${h.mountPorts.catalogInstalls.length} commits)`)

  // The inline ACTION seat: the fixed Client-local attachment actions ride the
  // same inline `/name` lexicon as the skills, and accepting one reads nothing.
  await h.setDraft('看一下 /im')
  await h.triggerQuietly(TAB)
  await waitUntil('the inline action rows painted', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['/image'],
    'the inline seat answers the `im` query with the fixed image action (the Provider owns the filtering)')
  assert.equal(h.imageRead.calls(), 0, 'the action list read no file')

  await h.press(ENTER)
  await waitUntil('the accepted action wrote its command token', () => h.editor().text === '看一下 /image ')
  assert.deepEqual(h.editor(), { text: '看一下 /image ', cursor: 11 },
    'the action accepted itself plus exactly one separator, caret after it')
  assert.equal(h.submits.length, 0, 'accepting an inline action never submitted')
  // The SAME seat continues into the Client-local path list, immediately.
  await waitUntil('the same seat reopened on the path argument', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['shot.png'],
    'the path seat answers from the Client-local cwd')
  assert.equal(h.host.listCalls(), 0, 'the local path seat never asked the Host port')
  assert.equal(h.imageRead.calls(), 0, 'a candidate list alone reads nothing')

  // The FILE accept: ONE committed Composer edit first, then the real intake.
  await h.press(ENTER)
  await waitUntil('the staged attachment replaced its own fragment', () =>
    h.editor().text === '看一下 [image #1 (1×1)] ')
  assert.deepEqual(h.editor(), { text: '看一下 [image #1 (1×1)] ', cursor: 20 },
    'the placeholder landed in place with the prose before it and the caret after it')
  assert.equal(h.imageRead.calls(), 1, 'exactly ONE Client-local read for one accepted file')
  assert.equal(h.images.values().length, 1, 'exactly ONE staged draft image')
  const staged = h.images.values()[0]!
  assert.equal(staged.name, 'shot.png', 'the store holds the accepted file itself')
  assert.equal(staged.mediaType, 'image/png', 'the real intake sniffed the media type from the bytes')
  assert.equal(staged.width, 1, 'the real intake parsed the header')
  assert.equal(staged.placeholder, '[image #1 (1×1)]', 'the canonical placeholder is the store\'s own')
  assert.equal(h.files.values().length, 0, '/image never staged a generic file draft')
  assert.equal(h.host.listCalls(), 0, 'the Client-local intake never consulted the Host port')
  assert.equal(h.submits.length, 0, 'accepting the file never submitted')
  assert.equal(h.writes.length, 0, 'accepting the file wrote no business prompt')
  assert.deepEqual(h.rows(), [], 'the accepted frame carries no stale popup')
  // The intake's OWN success notice reached the dock — exactly once, and only
  // because the placeholder really landed (a refused commit reports nothing).
  assert.deepEqual(wireNodes(h.pane)
    .map(node => String(node.p.text ?? ''))
    .filter(text => text.includes('attached [image #1 (1×1)] — Enter to send')),
  ['attached [image #1 (1×1)] — Enter to send'],
    'exactly ONE success notice for exactly ONE staged attachment')

  // A LATER separate Enter is the only submit, and the staged attachment rides
  // the real PreparedPrompt the REAL controller built.
  await h.press(ENTER)
  await waitUntil('the application submit entry recorded the attachment draft', () => h.submits.length === 1)
  assert.deepEqual(h.submits.map(entry => entry.text), ['看一下 [image #1 (1×1)] '],
    'the submitted draft is the placeholder text, never the raw path')
  await waitUntil('the real controller wrote the attachment-bearing prompt', () => h.writes.length === 1)
  const written = h.writes[0] as {
    sessionId: string
    message: {
      text: string
      hasFiles: boolean
      segments: readonly { type: string; text?: string; image?: { name?: string; mediaType: string; bytes: Uint8Array } }[]
    }
  }
  assert.equal(written.sessionId, SESSION_ID, 'the write carried this composition\'s session')
  assert.deepEqual(written.message.segments.map(segment => segment.type), ['text', 'image', 'text'],
    'the real PreparedPrompt expanded the placeholder into ONE staged image between the prose')
  assert.equal(written.message.segments[0]?.text, '看一下 ', 'the prose before the attachment survived')
  assert.equal(written.message.segments[2]?.text, ' ', 'the separator after the placeholder survived')
  const imageSegment = written.message.segments[1]!
  assert.equal(imageSegment.image?.name, 'shot.png', 'the prompt carries the accepted file\'s own name')
  assert.equal(imageSegment.image?.mediaType, 'image/png', 'the prompt carries the sniffed media type')
  assert.equal(imageSegment.image?.bytes.byteLength, 33, 'the prompt carries the real bytes')
  assert.equal(written.message.hasFiles, false, 'no generic file rode that prompt')
})

// ── L. A forged attachment marker buys no read (matrix D14) ──────────────────

/** Ask the seat ONE query that the host provider cannot answer, let the REAL
 *  plugin chain answer it, and wait for that answer on the wire. */
async function pluginAnswer(
  h: ChainHarness,
  draft: string,
  prefix: string,
  items: readonly { value: string; label: string }[],
): Promise<void> {
  await h.setDraft(draft)
  await h.triggerQuietly(TAB)
  const index = h.plugin.asked() - 1
  assert.ok(index >= 0, `the plugin chain was really asked for ${JSON.stringify(draft)}`)
  h.plugin.release(index, items, prefix)
  await waitUntil(`the plugin answer for ${JSON.stringify(draft)} painted`, () => h.rows().length > 0)
}

test('a plugin row that forges the inline-attachment marker inserts ordinary text and buys nothing -> zero reads, zero staged attachments and zero submissions at both the Host @ seat and the Client-local path seat, while the real provider row for the same file does stage', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-forged-')
  writeClientFiles(home, ['real.png', 'shots/other.png'])
  const h = await mountChain(life, home, {
    holdPluginAnswers: true,
    // The Host answers NOTHING for these queries: the plugin chain is the only
    // source that can put a path-shaped row on the wire.
    hostFiles: () => ({ kind: 'ok', items: [] }),
  })
  const forged = {
    value: 'real.png',
    label: 'real.png',
    // The structural markers a real Client-local row carries — pure text to a
    // plugin, and NOT a permission.
    inlineAttachment: 'path',
    directory: false,
    command: 'image',
  }

  // THE FORGERY AT THE HOST SEAT: `@real` — the Host said nothing, the plugin
  // dressed a row up as an attachment candidate.
  await pluginAnswer(h, 'please @real', '@real', [forged])
  assert.deepEqual(h.rows().map(row => row.text), ['real.png'],
    'a plugin row is painted as ordinary text, never as a Host reference')
  await h.press(ENTER)
  await waitUntil('the forged accept edited the draft as plain text', () => h.editor().text === 'please real.png ')
  assert.deepEqual(h.editor(), { text: 'please real.png ', cursor: 16 },
    'the accept only inserted the plugin\'s own text')
  assert.equal(h.imageRead.calls(), 0, 'a forged marker read no Client-local file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'a forged marker staged nothing')
  assert.equal(h.submits.length, 0, 'a forged marker submitted nothing')
  assert.equal(h.writes.length, 0, 'a forged marker wrote no business prompt')

  // THE FORGERY AT THE INLINE PATH SEAT: the very same row shape at a real
  // `/image` argument the Client-local discovery cannot answer.
  await h.setDraft('')
  await pluginAnswer(h, 'look /image zzz', 'zzz', [forged])
  await h.press(ENTER)
  await waitUntil('the second forged accept edited the draft', () => h.editor().text === 'look /image real.png')
  assert.equal(h.imageRead.calls(), 0, 'the inline forged row read no file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'the inline forged row staged nothing')
  assert.equal(h.host.listCalls(), 1,
    'only the @ query ever reached the Host port — the /image seat and the plugin never did')
  assert.equal(h.submits.length, 0, 'the inline forged row submitted nothing')

  // THE POSITIVE CONTROL: the same file, offered by the REAL Client-local
  // provider row, DOES stage — so the difference is the request identity, not
  // the marker text and not the file.
  await h.setDraft('')
  await h.setDraft('look /image real')
  await h.triggerQuietly(TAB)
  await waitUntil('the real local row painted', () => h.rows().map(row => row.text).includes('real.png'))
  assert.equal(h.plugin.asked(), 2, 'the host provider answered this seat itself, without the plugin')
  await h.press(ENTER)
  await waitUntil('the real row staged its file', () => h.images.values().length === 1)
  assert.equal(h.imageRead.calls(), 1, 'the real row ran exactly ONE Client-local read')
  assert.equal(h.editor().text, 'look [image #1 (1×1)] ')
  assert.equal(h.submits.length, 0, 'even the real staging never submitted')
})

// ── M. A write the Composer refuses owns no read (matrix D15) ────────────────

test('a real Client-local row whose accepted value would cross the logical line is refused by the ONE composer write -> zero stager calls, zero Client reads, zero staged attachments, the popup really closes and the typed path stays editable, while the same seat accepts an in-line value', async (t) => {
  const life = testLifecycle(t)
  // A POSIX filename may legally contain a line break; the completion grammar
  // hands it back verbatim, so the accept is a CROSS-LINE document edit — the
  // one write the controlled composer must refuse. The seat's own admitted
  // window is exactly the argument token `[12, 18)` of `look /image broken`,
  // which this replacement fills, so the window check is not what stops it:
  // only the composer's one-logical-line invariant does.
  const home = life.tempDir('pi-tui-tsp-id-refused-write-')
  writeClientFiles(home, ['broken\nname.png', 'sub/ok.png'])
  const h = await mountChain(life, home)
  assert.equal(h.mountPorts.stagers.length, 1, 'the real stager IS installed (the refusal is the write, not the wiring)')

  // THE CONTROL AT THE SAME SEAT: an in-line value really does write, so the
  // rejection below is the document shape, not a closed seat or a no-op apply.
  await h.setDraft('look /image sub')
  await h.triggerQuietly(TAB)
  await waitUntil('the directory row painted', () => h.rows().length > 0)
  assert.equal(h.rows()[0]!.text, 'sub/', 'the directory candidate leads its own row')
  assert.equal(h.rows()[0]!.highlighted, true, 'the first candidate is the highlighted one')
  await h.press(ENTER)
  await waitUntil('the in-line value wrote', () => h.editor().text === 'look /image sub/')
  assert.deepEqual(h.editor(), { text: 'look /image sub/', cursor: 16 },
    'the same seat accepts an in-line value with one committed edit')
  assert.equal(h.imageRead.calls(), 0, 'a directory continuation reads no file')

  await h.setDraft('')
  await waitUntil('the draft is clear for the refused accept', () => h.editor().text === '')
  await h.setDraft('look /image broken')
  await h.triggerQuietly(TAB)
  await waitUntil('the real Client-local row painted', () => h.rows().length > 0)
  assert.equal(h.host.listCalls(), 0, 'the local seat never asked the Host port')
  assert.equal(h.plugin.asked(), 0, 'the host provider answered; no plugin row is involved')
  const before = h.editor()
  assert.deepEqual(before, { text: 'look /image broken', cursor: 18 }, 'the user\'s own query is on the wire')

  await h.press(ENTER)
  await waitUntil('the refused write closed the popup without editing the draft', () => h.rows().length === 0)
  assert.deepEqual(h.editor(), before, 'the refused accept changed neither the text nor the caret')
  assert.equal(h.imageRead.calls(), 0, 'a refused write read no Client-local file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'a refused write staged nothing')
  assert.equal(h.submits.length, 0, 'a refused write never degraded into a submit of the draft')
  assert.equal(h.writes.length, 0, 'a refused write wrote no business prompt')
  assert.equal(h.cancels(), 0, 'the refusal consumed the gesture, it did not become a cancel intent')
  assert.equal(wireText(h.pane).includes('Enter to send'), false,
    'a write that never landed announces no attachment')
  // The user's path text is still THEIRS: the next edit lands on it.
  await h.press('x')
  await waitUntil('the kept path text stays editable', () => h.editor().text === 'look /image brokenx')
  assert.deepEqual(h.editor(), { text: 'look /image brokenx', cursor: 19 },
    'the draft the refusal preserved is the draft the user keeps editing')
})

// ── N. Currentness of one answer across every formal commit (matrix D17) ─────

test('a Host @ answer that settles after the seat moved is dropped by every formal commit -> a session publication, a catalog commit, a hydration, an input-history reset and a draft clear each paint nothing, write nothing and still allow a fresh query', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-stale-at-')
  const h = await mountChain(life, home, {
    hostFiles: query => query === 'src/'
      ? { kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }
      : { kind: 'ok', items: [] },
  })
  const invalidations: readonly { name: string; run: () => void }[] = [
    { name: 'a new Session publication (A -> B)', run: () => h.surface.display.beginInputHistoryScope('B') },
    { name: 'a new catalog commit', run: () => h.commitCatalog() },
    { name: 'a session hydration', run: () => {
      h.surface.display.beginSessionHydration()
      // The hydration fence lifts when the incoming subject commits — the same
      // formal display commit the application owner performs.
      h.surface.display.setTranscript([], undefined, undefined, undefined, undefined, {})
    } },
    { name: 'an input-history reset', run: () => h.surface.display.resetInputHistory(['a row'], 'B') },
    { name: 'a draft clear', run: () => h.surface.composer.setDraft('') },
  ]
  for (const invalidation of invalidations) {
    await h.setDraft('请看 @src/')
    h.host.holdNext()
    const since = h.frameCount()
    await h.triggerQuietly(TAB)
    await waitUntil(`${invalidation.name}: the Host request is really in flight`, () => h.host.heldCount() === 1)
    assert.equal(h.host.lastAborted(), false, `${invalidation.name}: the live request is not aborted yet`)
    invalidation.run()
    // A formal seat retirement ABORTS the in-flight query, not merely fences it.
    // (The draft clear is the composer's own write, not a seat retirement, so
    // only the document fence applies there — asserted by the same absence.)
    if (invalidation.name !== 'a draft clear') {
      assert.equal(h.host.lastAborted(), true, `${invalidation.name}: the retired request was aborted`)
    }
    h.host.releaseHeld()
    await h.waitNoRowPaint(since, `${invalidation.name}: the answer from the retired seat never painted`)
    assert.deepEqual(h.editor(), invalidation.name === 'a draft clear'
      ? { text: '', cursor: 0 }
      : { text: '请看 @src/', cursor: 8 }, `${invalidation.name}: the late answer wrote no draft`)
    assert.equal(h.submits.length, 0, `${invalidation.name}: the late answer submitted nothing`)
    assert.equal(h.imageRead.calls(), 0, `${invalidation.name}: a Host reference read no Client-local file`)
    // The seat is not poisoned: a fresh query on that document answers again.
    await h.setDraft('请看 @src/')
    await h.triggerQuietly(TAB)
    await waitUntil(`${invalidation.name}: a fresh query reopened the seat`, () => h.rows().length > 0)
    assert.deepEqual(h.rows().map(row => row.text), ['@src/deep.ts'])
    await h.setDraft('')
    await waitUntil('the seat is clear for the next invalidation', () => h.editor().text === '')
  }
  // Returning to A resurrects nothing: the retired scope's rows are gone for good.
  h.surface.display.beginInputHistoryScope('A')
  assert.deepEqual(h.values(), [], 'no candidate list survives a scope publication')
})

test('a painted Client-local path list is withdrawn by a catalog commit, a session publication and a hydration -> its stale row cannot be clicked, staged or submitted, and only a fresh query answers again', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-stale-path-')
  writeClientFiles(home, ['real.png'])
  const h = await mountChain(life, home)
  const openLocalSeat = async (): Promise<{ text: string; cursor: number }> => {
    await h.setDraft('look /image real')
    await h.triggerQuietly(TAB)
    await waitUntil('the Client-local row painted', () => h.rows().length > 0)
    assert.deepEqual(h.rows().map(row => row.text), ['real.png'])
    return h.editor()
  }

  // 1. A new catalog commit replaces the source: the old row identity dies with it.
  const before = await openLocalSeat()
  const staleRow = h.rows()[0]!
  h.commitCatalog()
  await waitUntil('the catalog commit withdrew the painted row', () => h.rows().length === 0)
  await h.clickRow(staleRow)
  assert.deepEqual(h.editor(), before, 'the withdrawn row cannot be accepted into the draft')
  assert.equal(h.imageRead.calls(), 0, 'the withdrawn row read no file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'the withdrawn row staged nothing')

  // 2. A Session publication (A -> B -> A) retires the list its scope built.
  h.surface.display.beginInputHistoryScope('A')
  await openLocalSeat()
  const secondRow = h.rows()[0]!
  h.surface.display.beginInputHistoryScope('B')
  await h.press('x')
  await waitUntil('the publication withdrew B-side candidates for A\'s row', () => h.rows().length === 0)
  await h.clickRow(secondRow)
  assert.equal(h.editor().text, 'look /image realx', 'A\'s stale row wrote nothing into B\'s draft')
  assert.equal(h.imageRead.calls(), 0, 'the stale click ran no read')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'the stale click staged nothing')
  assert.equal(h.submits.length, 0, 'the stale click submitted nothing')

  // 3. A hydration retires the list BEFORE any incoming subject can be seen.
  h.surface.composer.setDraft('look /image real')
  await waitUntil('the draft is back for the hydration probe', () => h.editor().text === 'look /image real')
  await h.triggerQuietly(TAB)
  await waitUntil('the Client-local row painted again', () => h.rows().length > 0)
  const hydratedRow = h.rows()[0]!
  const sinceHydration = h.frameCount()
  h.surface.display.beginSessionHydration()
  await h.waitNoRowPaint(sinceHydration, 'the hydrated window shows no old candidate list')
  await h.clickRow(hydratedRow)
  assert.equal(h.imageRead.calls(), 0, 'a click under the hydration fence read no file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'a click under the hydration fence staged nothing')
  h.surface.display.setTranscript([], undefined, undefined, undefined, undefined, {})
  await waitUntil('the incoming subject committed', () => h.editor().text === 'look /image real')
  // A fresh query is required, and then the seat works again.
  await h.triggerQuietly(TAB)
  await waitUntil('a fresh query reopened the local seat', () => h.rows().map(row => row.text).includes('real.png'))
  await h.press(ENTER)
  await waitUntil('the fresh row staged its file', () => h.images.values().length === 1)
  assert.equal(h.imageRead.calls(), 1, 'exactly ONE read followed the one fresh accept')
  assert.equal(h.submits.length, 0, 'none of this submitted anything')
  // 4. A SECOND-LINE inline seat is an ordinary seat too: it opens, and the same
  //    formal commit retires it.
  h.surface.composer.setDraft('')
  await waitUntil('the draft cleared for the second-line seat', () => h.editor().text === '')
  await h.setDraft('first\n/im')
  await h.triggerQuietly(TAB)
  await waitUntil('the second-line inline action seat painted', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['/image'],
    'a later logical line\'s `/name` token is the shared inline seat')
  const secondLineRow = h.rows()[0]!
  // `beginInputHistoryScope` is a pure-state commit: ONE real key drives the
  // frame in which the retired list is actually withdrawn.
  h.surface.display.beginInputHistoryScope('C')
  await h.press('x')
  await waitUntil('the publication retired the second-line list', () => h.rows().length === 0)
  await h.clickRow(secondLineRow)
  assert.deepEqual(h.editor(), { text: 'first\n/imx', cursor: 10 },
    'the retired second-line row wrote nothing into the newer draft')
  assert.equal(h.imageRead.calls(), 1, 'the retired second-line row still read nothing new')
  assert.equal(h.images.values().length, 1, 'the retired second-line row staged nothing new')
})

// ── O. A late intake settlement owns no draft and no store (matrix D16/D17) ───

test('a Client-local read still in flight when the seat moves commits nothing -> an edited draft, an invalidated session scope and a disposed mount each refuse the late placeholder, and after the disposal a late stager or catalog install reaches no mount', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-late-intake-')
  writeClientFiles(home, ['real.png'])
  // The production read is held, so "still in flight" is a fact the case drives.
  const h = await mountChain(life, home, { holdImageRead: true })
  assert.equal(h.mountPorts.stagers.length, 1, 'the ONE stager is installed on this mount')

  const acceptTheRealRow = async (): Promise<void> => {
    await h.setDraft('')
    await waitUntil('the draft is clear', () => h.editor().text === '')
    await h.setDraft('look /image real')
    await h.triggerQuietly(TAB)
    await waitUntil('the Client-local row painted', () => h.rows().length > 0)
    await h.press(ENTER)
    await waitUntil('the accepted path is on the wire', () => h.editor().text === 'look /image real.png ')
    await waitUntil('the intake read is really in flight', () => h.imageRead.heldCount() === 1)
    assert.equal(h.images.values().length, 0, 'a read in flight staged nothing yet')
  }

  // 1. The user keeps editing: the same bytes are not the same operation. The
  // accepted FILE token leaves the caret right before its terminating space, so
  // the very next character is a real edit INSIDE the accepted path.
  await acceptTheRealRow()
  assert.deepEqual(h.editor(), { text: 'look /image real.png ', cursor: 20 },
    'the accepted path stayed an editable token of the user\'s own draft')
  await h.press('x')
  await waitUntil('the edit landed on the accepted path', () => h.editor().text === 'look /image real.pngx ')
  h.imageRead.releaseAll()
  // reason: bounded absence window — a committed placeholder is a controlled
  // editor frame; a refused intake commits nothing and writes no frame.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.deepEqual(h.editor(), { text: 'look /image real.pngx ', cursor: 21 },
    'the late intake never overwrote the draft the user moved on')
  assert.equal(h.images.values().length, 0, 'the late intake staged nothing')
  assert.equal(h.files.values().length, 0, 'the late intake staged no generic file either')
  assert.equal(wireText(h.pane).includes('Enter to send'), false,
    'a placeholder that never landed is never announced as attached')

  // 2. The Session the intake captured is replaced WHILE it reads: the same
  // session id under a new owner token is a different operation (an id match
  // grants nothing), so the late settlement must not touch this draft.
  await acceptTheRealRow()
  h.replaceSessionOwner()
  h.imageRead.releaseAll()
  await waitUntil('the refusal notice reached the dock', () =>
    wireText(h.pane).includes('the session changed while reading the image'))
  assert.deepEqual(h.editor(), { text: 'look /image real.png ', cursor: 20 },
    'the refused settlement left the accepted path text exactly as it was')
  assert.equal(h.images.values().length, 0, 'an intake for a superseded scope staged nothing')
  assert.equal(wireText(h.pane).includes('attached [image'), false,
    'a scope-refused intake announces no success')

  // 2b. The generation-only invalidation shape (the same owner, a newer
  // generation): a capture mints its own record and dies with the generation.
  await acceptTheRealRow()
  h.bumpSessionGeneration()
  h.imageRead.releaseAll()
  // reason: bounded absence window — the refusal has no positive sink; the only
  // one it could have had (a placeholder frame) is what must not appear.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.deepEqual(h.editor(), { text: 'look /image real.png ', cursor: 20 },
    'the generation-invalidated settlement wrote no placeholder')
  assert.equal(h.images.values().length, 0, 'a newer generation staged nothing')

  const readsBeforeCard = h.imageRead.calls()
  // 2c. TSP I-E: the History card takes the composer seat WHILE the read is in
  // flight. The card owns the draft meanwhile (its Restore target is the same
  // one editor), so a placeholder landing behind the card would be a hidden
  // business write into a seat the user is no longer operating.
  await acceptTheRealRow()
  await h.press('\u0012')
  await waitUntil('the History card owns the seat', () =>
    wireNodes(h.pane).some(node => /history-card-\d+$/.test(String(node.id))))
  const draftBehindCard = h.editor()
  h.imageRead.releaseAll()
  // reason: bounded absence window — a refused intake commits nothing, so the
  // only observation is that no frame, store entry or notice appears.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.deepEqual(h.editor(), draftBehindCard, 'the card-owned draft was not written behind the card')
  assert.equal(h.images.values().length, 0, 'the late intake staged nothing while History owned the seat')
  assert.equal(h.files.values().length, 0, 'and no generic file either')
  assert.equal(wireText(h.pane).includes('attached [image'), false, 'no success notice was announced behind the card')
  // The completion seat is retired when the card opens and no key reaches it
  // while the card owns every key, so its admission is not black-box witnessed
  // here: the card's own key ownership is the primary fence. The case's real
  // witness remains the post-read `current()` refusal above.
  await h.press('\u001b')
  await waitUntil('the card closed', () => !wireNodes(h.pane).some(node => /history-card-\d+$/.test(String(node.id))))

  // 3. The mount itself dies before the read settles.
  await acceptTheRealRow()
  await h.surface.dispose()
  h.imageRead.releaseAll()
  // reason: bounded absence window — a disposed mount has no frame and no seat
  // left to write into; the refusal is the absence of any store mutation.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.equal(h.images.values().length, 0, 'a disposed mount committed no attachment')
  assert.equal(h.files.values().length, 0, 'a disposed mount staged no generic file')
  assert.equal(h.submits.length, 0, 'none of the three refusals submitted')

  // THE LATE INSTALLS: the disposal withdrew this mount's installer references,
  // so neither a late stager nor a late catalog commit reaches ANY mount.
  const catalogsBefore = h.mountPorts.catalogInstalls.length
  let lateStagerCalls = 0
  h.surface.installTspInlineAttachmentStager(() => { lateStagerCalls += 1 })
  h.surface.installTspCommandCompletions({
    commands: [],
    cwd: home,
    fileReferences: null,
    scope: () => ({ kind: 'workspace', cwd: home }),
    localCwd: () => home,
    skillReferences: [],
    hostShellCompletion: false,
  })
  assert.equal(h.mountPorts.stagers.length, 1, 'the late stager install reached no mount')
  assert.equal(h.mountPorts.catalogInstalls.length, catalogsBefore, 'the late catalog install reached no mount')
  assert.equal(lateStagerCalls, 0, 'nothing invoked the late stager')
})

// ── P. The `@` scope is the LIVE session, resolved per query (matrix D02) ─────

test('the @ seat resolves its Host scope at query time -> the sessionless surface asks the workspace cwd, a live Session answers with its own id and no reinstall happens, and an answer captured for the outgoing session is refused mid-flight', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-at-scope-')
  const h = await mountChain(life, home, {
    hostFiles: query => query === 'src/'
      ? { kind: 'ok', items: [{ path: 'src/deep.ts', kind: 'file' }] }
      : { kind: 'ok', items: [] },
  })
  // 1. The cold sessionless surface: the Host WORKSPACE scope of this mount.
  await h.setDraft('@src/')
  await h.triggerQuietly(TAB)
  await waitUntil('the workspace-scoped answer painted', () => h.rows().length > 0)
  assert.deepEqual(h.host.records().at(-1)!.scope, { kind: 'workspace', cwd: home },
    'the sessionless @ query carried the workspace cwd scope')
  const installsAfterFirst = h.mountPorts.catalogInstalls.length

  // 2. A live Session appears. No reinstall, no second source: the SAME
  //    installed provider resolves the NEW scope for the NEXT query.
  h.openSession('session-live-A')
  await h.setDraft('')
  await waitUntil('the seat is clear for the scoped query', () => h.rows().length === 0)
  await h.setDraft('@src/')
  h.host.holdNext()
  const since = h.frameCount()
  await h.triggerQuietly(TAB)
  await waitUntil('the session-scoped request is in flight', () => h.host.heldCount() === 1)
  assert.deepEqual(h.host.records().at(-1)!.scope, { kind: 'session', sessionId: 'session-live-A' },
    'the live Session id is the Host scope')
  assert.equal(h.mountPorts.catalogInstalls.length, installsAfterFirst,
    'a session change never reinstalled the completion source')
  // The session moves again WHILE the Host is answering: the captured scope is
  // stale and the provider refuses its own answer.
  h.openSession('session-live-B')
  h.host.releaseHeld()
  await h.waitNoRowPaint(since, 'an @ answer from the outgoing session never paints')
  assert.deepEqual(h.editor(), { text: '@src/', cursor: 5 }, 'the stale answer wrote no draft')
  assert.equal(h.submits.length, 0, 'the stale answer submitted nothing')
  // A fresh query under the new scope answers normally.
  await h.triggerQuietly(TAB)
  await waitUntil('the new session scope answers', () => h.rows().length > 0)
  assert.deepEqual(h.host.records().at(-1)!.scope, { kind: 'session', sessionId: 'session-live-B' })
  assert.deepEqual(h.rows().map(row => row.text), ['@src/deep.ts'])
  assert.equal(h.imageRead.calls(), 0, 'a Host reference read no Client-local file')
})

// ── Q. The install seam is what makes staging real (falsification control) ───

test('an assembly that supplies no stager seam installs nothing -> the catalog seat still works, an inline file accept stays ordinary editable text and reads, stages and submits nothing', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-no-seam-')
  writeClientFiles(home, ['real.png'])
  const h = await mountChain(life, home, { stagerSeam: false })
  assert.equal(h.mountPorts.stagers.length, 0, 'no stager install reached this mount')
  assert.ok(h.mountPorts.catalogInstalls.length >= 1, 'the catalog commit still installed its seat')
  await h.setDraft('look /image real')
  await h.triggerQuietly(TAB)
  await waitUntil('the Client-local row painted without any stager', () => h.rows().length > 0)
  await h.press(ENTER)
  await waitUntil('the accepted path is on the wire', () => h.editor().text === 'look /image real.png ')
  // reason: bounded absence window — a staged placeholder is a committed
  // controlled-editor frame; an uninstalled stager commits none.
  await new Promise(resolve => setTimeout(resolve, ABSENCE_WINDOW_MS))
  assert.deepEqual(h.editor(), { text: 'look /image real.png ', cursor: 20 },
    'with no installed stager the accepted path stays the user\'s own text')
  assert.equal(h.imageRead.calls(), 0, 'an uninstalled stager read no file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'an uninstalled stager staged nothing')
  assert.equal(h.submits.length, 0, 'none of this submitted')
  await h.press('x')
  await waitUntil('the un-staged path is still editable', () => h.editor().text === 'look /image real.pngx ')
})

// ── R. The natural keystroke trigger reaches the file seats too ──────────────

test('real keystrokes at a file seat open the SAME seat with no explicit trigger -> the typed @ query paints the Host row and the typed /image argument paints the local file, and Escape closes only the list', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-natural-')
  writeClientFiles(home, ['real.png'])
  const h = await mountChain(life, home, {
    hostFiles: query => query === 'r'
      ? { kind: 'ok', items: [{ path: 'real.png', kind: 'file' }] }
      : { kind: 'ok', items: [] },
  })
  await typeKeys(h, 'look @r')
  await waitUntil('the typed @ query painted the Host row', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['@real.png'],
    'every keystroke re-queried the same seat; the newest answer is the one painted')
  assert.deepEqual(h.host.queries(), ['', 'r'],
    'each keystroke asked the official query form (the text AFTER the @), never the raw token')
  await h.press(ESCAPE)
  assert.deepEqual(h.rows(), [], 'Escape closed the candidate list')
  assert.deepEqual(h.editor(), { text: 'look @r', cursor: 7 }, 'the dismissal edited nothing')
  assert.equal(h.submits.length, 0, 'the dismissal ran no submit and no cancel-then-submit')

  await h.setDraft('')
  await waitUntil('the draft is clear for the local seat', () => h.editor().text === '')
  await typeKeys(h, 'see /image rea')
  await waitUntil('the typed argument painted the local row', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['real.png'],
    'the natural keystroke opened the Client-local path seat')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'a painted list staged nothing')
  assert.equal(h.imageRead.calls(), 0, 'a painted list read nothing')
  assert.equal(h.submits.length, 0, 'typing a path never submitted')

  // A MODIFIED Enter is never this seat's accept gesture: the open list retires
  // and the key stays exactly the composer gesture it always was. At a file seat
  // there is no "already complete token" exception, so nothing is applied, read,
  // staged OR submitted.
  await h.press(SHIFT_ENTER)
  await waitUntil('the modified Enter retired the list', () => h.rows().length === 0)
  assert.deepEqual(h.editor(), { text: 'see /image rea\n', cursor: 15 },
    'the modified Enter became the composer\'s own newline, never a candidate accept')
  assert.equal(h.imageRead.calls(), 0, 'the retired list read no file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'the retired list staged nothing')
  assert.equal(h.submits.length, 0, 'the modified Enter submitted nothing')
  assert.equal(h.cancels(), 0, 'and it was no cancel intent either')
})

// ── S. Every non-inline-file kind writes text and calls no stager ────────────

test('accepting at the first line\'s command argument and at the inline skill seat writes text and nothing else -> the command token survives, the reference stays a literal, and neither seat reads a file, stages an attachment or executes anything', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('pi-tui-tsp-id-non-file-kinds-')
  writeClientFiles(home, ['real.png'])
  const h = await mountChain(life, home)
  assert.equal(h.mountPorts.stagers.length, 1, 'the stager IS installed — these seats just never use it')

  // THE LEGACY LEADING ARGUMENT SEAT: the accept completes the argument of the
  // declared command and changes nothing else. The command is NOT executed by
  // this gesture (the next explicit Enter is the command plane's own).
  await h.setDraft('/image real')
  await h.triggerQuietly(TAB)
  await waitUntil('the leading argument seat painted', () => h.rows().length > 0)
  assert.deepEqual(h.rows().map(row => row.text), ['real.png'])
  assert.equal(h.host.listCalls(), 0, 'the leading argument seat never asked the Host port')
  await h.press(ENTER)
  await waitUntil('the accepted argument landed on the wire', () => h.editor().text === '/image real.png')
  assert.deepEqual(h.editor(), { text: '/image real.png', cursor: 15 },
    'ONLY the argument changed: the `/image` token, the caret and no stray text')
  assert.equal(h.imageRead.calls(), 0, 'a leading argument accept is never an intake')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'a leading argument accept staged nothing')
  assert.equal(h.submits.length, 0, 'a leading argument accept never executed the command')
  assert.equal(h.writes.length, 0, 'a leading argument accept wrote no business prompt')
  assert.deepEqual(h.rows(), [], 'the accepted frame carries no stale popup')

  // THE INLINE SKILL SEAT shares the action lexicon and stays a literal text
  // reference: it is not an attachment, not a command and not an execution.
  await h.setDraft('')
  await waitUntil('the draft is clear for the skill seat', () => h.editor().text === '')
  await h.setDraft('look /gla')
  await h.triggerQuietly(TAB)
  await waitUntil('the inline skill row painted', () => h.rows().map(row => row.text).includes('/glab'))
  assert.deepEqual(h.rows().map(row => row.text), ['/glab'],
    'the skill reference rides the same inline seat as the fixed actions')
  await h.press(ENTER)
  await waitUntil('the accepted skill reference landed on the wire', () => h.editor().text === 'look /glab ')
  assert.deepEqual(h.editor(), { text: 'look /glab ', cursor: 11 },
    'the skill accept inserted its literal reference plus one separator')
  assert.equal(h.imageRead.calls(), 0, 'an inline skill reference read no file')
  assert.equal(h.images.values().length + h.files.values().length, 0, 'an inline skill reference staged nothing')
  assert.equal(h.submits.length, 0, 'an inline skill reference executed nothing')
  assert.equal(h.writes.length, 0, 'an inline skill reference wrote no business prompt')
})
