/**
 * M4-B2-HF Host-only composition contract test.
 *
 * Reads the REAL Host-only overlay the Host entry writes and drives the REAL
 * readiness audit over a Loader-shaped fixture (rows + fiber states + reflect
 * services). It does not boot a DSH Profile: the real cross-process Profile is
 * the split-process smoke's job; this suite pins the exact row inventory and
 * the fail-closed audit conditions.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-host-foundation.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import type { Context } from '@deepseek-ai/cordis'
import { HOST_ONLY_PATCH } from '../../src/app/remote-process/local-host-entry.ts'
import {
  assertHostOnlyComposition,
  collectHostEntryStatus,
} from '../../src/app/remote-process/host-bootstrap.ts'
import { REMOTE_HOST_PREREQUISITE_SERVICES } from '../../src/app/remote/host-prerequisites.ts'
import { PI_TUI_HOST_READY_SERVICE } from '../../src/app/host/pi-tui-host-runtime.ts'
import { PI_TUI_FILE_REFERENCES_NAMESPACE } from '../../src/runtime/remote/pi-tui-file-reference-contract.ts'
import { PI_TUI_TERMINAL_PROGRESS_NAMESPACE } from '../../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import { PI_TUI_WEB_ACCESS_NAMESPACE } from '../../src/runtime/remote/pi-tui-web-access-contract.ts'
import { PI_TUI_SKILLS_NAMESPACE } from '../../src/runtime/remote/pi-tui-skills-contract.ts'
import { PI_TUI_WEB_ACCESS_ROWS } from '../../src/app/host/features/web-roster.ts'

/** One row of a real patch file (in-place override or `insert` entry). */
interface OverlayRow {
  readonly id: string
  readonly name?: string
  readonly inject?: readonly string[]
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
}

/** One top-level overlay entry: an in-place row override or an `insert` group. */
interface OverlayEntry extends OverlayRow {
  readonly insert?: readonly OverlayRow[]
}

const OVERLAY_ENTRIES = parseYaml(HOST_ONLY_PATCH) as OverlayEntry[]
const OVERLAY_ROWS = OVERLAY_ENTRIES.flatMap(entry => entry.insert ?? [entry])

/** The bundle's OWN patch, read from the tracked file the profile installs. */
const BUNDLE_ENTRIES = parseYaml(
  readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8'),
) as OverlayEntry[]
const BUNDLE_ROWS = BUNDLE_ENTRIES.flatMap(entry => entry.insert ?? [entry])

const WORKSPACE_CONTROLLER_PACKAGE = '@deepseek-ai/dsh-api-workspace-controller'
const ACCOUNT_CONTROLLER_PACKAGE = '@deepseek-ai/dsh-api-account-controller'
const WORKSPACE_REGISTRY_PACKAGE = '@deepseek-ai/dsh-workspace'
const DELIVERABLE_GUIDANCE_ID = 'deliverable-file-references'
const DELIVERABLE_GUIDANCE_PACKAGE = '@deepseek-ai/dsh-deliverable-file-references'
const OFFICE_PACKAGE = '@deepseek-ai/dsh-office-to-pdf'
const HARNESS_DEV_CONTEXT_PACKAGE = '@deepseek-ai/dsh-harness-dev-context'

/**
 * The shared deliverable guidance is a base-profile Host row. Direct and Split
 * inherit it; the Web overlay owns neither a copy nor the Web-only Office row.
 */
function assertSharedDeliverableGuidance(
  bundleEntries: readonly OverlayEntry[],
  overlayEntries: readonly OverlayEntry[],
): void {
  const bundle = bundleEntries.flatMap(entry => entry.insert ?? [entry])
  const overlay = overlayEntries.flatMap(entry => entry.insert ?? [entry])
  const guidance = bundle.filter(candidate => candidate.id === DELIVERABLE_GUIDANCE_ID)
  assert.equal(guidance.length, 1, 'the base profile must own exactly one deliverable guidance row')
  assert.equal(guidance[0].name, DELIVERABLE_GUIDANCE_PACKAGE,
    'the shared guidance row must load the official package')
  assert.notEqual(guidance[0].disabled, true,
    'the shared guidance row must remain enabled for Direct and Split Host')
  const fileReferenceIndex = bundle.findIndex(candidate => candidate.id === 'file-reference-local')
  const guidanceIndex = bundle.findIndex(candidate => candidate.id === DELIVERABLE_GUIDANCE_ID)
  const presetRegistryIndex = bundle.findIndex(candidate => candidate.id === 'agent-preset-registry')
  assert.equal(guidanceIndex, fileReferenceIndex + 1,
    'the shared guidance row must immediately follow file-reference-local')
  assert.ok(guidanceIndex < presetRegistryIndex,
    'the shared guidance row must precede the agent preset registry')
  assert.equal(bundle.filter(candidate => candidate.name === DELIVERABLE_GUIDANCE_PACKAGE).length, 1,
    'the official shared guidance package must have exactly one base-profile owner')
  assert.equal(overlay.some(candidate => candidate.id === DELIVERABLE_GUIDANCE_ID
    || candidate.name === DELIVERABLE_GUIDANCE_PACKAGE), false,
  'the Host-only overlay must inherit shared guidance without declaring a second row')
  assert.equal(bundle.some(candidate => candidate.name === OFFICE_PACKAGE), false,
    'the Web-only Office package must not enter the common Direct profile')
  assert.equal(bundle.some(candidate => candidate.name === HARNESS_DEV_CONTEXT_PACKAGE), false,
    'the DSH GUI development context must stay out of the common profile')
  assert.equal(overlay.some(candidate => candidate.name === HARNESS_DEV_CONTEXT_PACKAGE), false,
    'the DSH GUI development context must stay out of the Split Host overlay')
}

function row(id: string): OverlayRow {
  const matches = OVERLAY_ROWS.filter(candidate => candidate.id === id)
  assert.equal(matches.length, 1, `the overlay must own exactly one "${id}" row`)
  return matches[0]
}

/**
 * The Workspace Remote composition contract, shared by the positive assertion
 * and its negative controls so each control proves THIS assertion group rejects
 * the mutation instead of a private copy.
 */
function assertWorkspaceComposition(
  bundleEntries: readonly OverlayEntry[],
  overlayEntries: readonly OverlayEntry[],
): void {
  const bundle = bundleEntries.flatMap(entry => entry.insert ?? [entry])
  const overlay = overlayEntries.flatMap(entry => entry.insert ?? [entry])
  const registries = bundle.filter(candidate => candidate.id === 'workspace')
  assert.equal(registries.length, 1, 'the bundle must own exactly one official "workspace" registry row')
  assert.equal(registries[0].name, WORKSPACE_REGISTRY_PACKAGE)
  const controllers = bundle.filter(candidate => candidate.id === 'workspace-controller')
  assert.equal(controllers.length, 1, 'the bundle must own exactly one stable "workspace-controller" row')
  assert.equal(controllers[0].name, WORKSPACE_CONTROLLER_PACKAGE,
    'the Workspace Controller row must load the official package')
  assert.deepEqual(controllers[0].inject, ['tuiStartup'],
    'Direct must gate the Workspace Controller on the same command-line admission as the TUI')
  // A second owner under a `split-host-` prefix would register the same
  // `workspace` namespace from a different row id.
  for (const rows of [bundle, overlay]) {
    assert.equal(rows.some(candidate => candidate.id === 'split-host-workspace-controller'), false,
      'no overlay may introduce a parallel split-host Workspace Controller owner')
  }
  // The Host-only overlay retunes the bundle's OWN row in place: exactly one
  // top-level override of that id, with the startup gate removed and nothing
  // re-declared (a `name` here would insert a second Loader row).
  const overrides = overlayEntries.filter(entry => entry.insert === undefined && entry.id === 'workspace-controller')
  assert.equal(overrides.length, 1, 'the Host-only overlay must override exactly one "workspace-controller" row in place')
  assert.deepEqual(overrides[0].inject, [],
    'the Host-only override must remove only the tuiStartup dependency')
  assert.equal(overrides[0].name, undefined, 'the in-place override must not re-declare the package')
  assert.equal(overrides[0].disabled, undefined, 'the Host-only overlay must not disable the Workspace Controller')
  assert.equal(overrides[0].config, undefined, 'the Host-only overlay must not replace the row config')
  // No inserted row of either official package: the registry stays the
  // bundle's own row and the controller is retuned in place, so a second
  // Loader row can never own either service.
  const inserted = overlayEntries.flatMap(entry => entry.insert ?? [])
  for (const name of [WORKSPACE_CONTROLLER_PACKAGE, WORKSPACE_REGISTRY_PACKAGE]) {
    assert.equal(inserted.filter(candidate => candidate.name === name).length, 0,
      `the Host-only overlay must not INSERT a "${name}" row`)
  }
  assert.equal(overlayEntries.filter(entry => entry.insert === undefined && entry.id === 'workspace').length, 0,
    'the Host-only overlay must not override the official "workspace" registry row')
}

/** The twelve Host execution rows whose lifetime must not depend on the mutable
 *  `tuiStartup` provider: `webserver` / `workspace-files` /
 *  `workspace-controller` are the three existing rows overridden in place, the
 *  other eight are the Host-only inserted rows. */
const HOST_EXECUTION_INJECT: ReadonlyArray<{ id: string; inject: readonly string[] }> = [
  { id: 'webserver', inject: [] },
  { id: 'workspace-files', inject: [] },
  { id: 'workspace-controller', inject: [] },
  { id: 'split-host-connection', inject: ['credentials', 'webServer'] },
  { id: 'split-host-file-upload', inject: ['agents', 'attachments', 'commands', 'connection'] },
  { id: 'split-host-session-stats', inject: ['sessionProjections'] },
  { id: 'split-host-turn-outline', inject: ['sessionProjections'] },
  {
    id: 'split-host-session-controller',
    inject: [
      'agentDefaultModel', 'agents', 'attachments', 'fileUploads', 'fs', 'llm',
      'remoteAccess', 'sessions', 'sessionProjections', 'sessionQuery', 'typert', 'workspaceRegistry',
    ],
  },
  { id: 'split-host-settings-controller', inject: ['typert'] },
  { id: 'split-host-account-controller', inject: ['deepseekAccount', 'agents'] },
  { id: 'split-host-session-log-download', inject: ['commands', 'connection'] },
  { id: 'split-host-pi-tui-runtime', inject: ['typert', 'agents', 'fileReferences', 'workingDirectory', 'sessions', 'sandboxPolicy', 'sandbox', 'subprocess', 'workspaceRegistry', 'skills', 'agentPresets'] },
]

/**
 * Pin the exact dependency set of the twelve Host execution rows. Shared by the
 * positive assertion and its negative control so the control proves THIS
 * assertion group rejects a reintroduced `tuiStartup`, not a private copy.
 */
function assertHostExecutionInject(entries: readonly OverlayEntry[]): void {
  const rows = entries.flatMap(entry => entry.insert ?? [entry])
  for (const { id, inject } of HOST_EXECUTION_INJECT) {
    const matches = rows.filter(candidate => candidate.id === id)
    assert.equal(matches.length, 1, `the overlay must own exactly one "${id}" row`)
    assert.deepEqual(matches[0].inject, inject, `the "${id}" row inject mismatch`)
    assert.equal(matches[0].inject?.includes('tuiStartup'), false,
      `the "${id}" row must not depend on the mutable tuiStartup provider`)
  }
  // The three existing rows are overridden in place; inserting them again would
  // create a second service owner instead of retuning the production row.
  for (const id of ['webserver', 'workspace-files', 'workspace-controller']) {
    const topLevel = entries.filter(entry => entry.insert === undefined && entry.id === id)
    assert.equal(topLevel.length, 1, `the overlay must declare exactly one top-level "${id}" override`)
    assert.deepEqual(topLevel[0].inject, [], `the "${id}" top-level override must inject nothing`)
  }
}

const FOUNDATION_ROWS: ReadonlyArray<{ owner: string; id: string; name: string }> = [
  { owner: 'fileUpload', id: 'split-host-file-upload', name: '@deepseek-ai/dsh-client-file-upload' },
  { owner: 'sessionStats', id: 'split-host-session-stats', name: '@deepseek-ai/dsh-session-stats' },
  { owner: 'turnOutline', id: 'split-host-turn-outline', name: '@deepseek-ai/dsh-session-turn-outline' },
  { owner: 'sessionController', id: 'split-host-session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
  { owner: 'settingsController', id: 'split-host-settings-controller', name: '@deepseek-ai/dsh-api-settings-controller' },
  { owner: 'accountController', id: 'split-host-account-controller', name: ACCOUNT_CONTROLLER_PACKAGE },
  { owner: 'sessionLogExport', id: 'split-host-session-log-download', name: '@deepseek-ai/dsh-session-log-export' },
  { owner: 'piTuiHostRuntime', id: 'split-host-pi-tui-runtime', name: '@xmoon76/dsh-pi-tui/host-runtime' },
]

test('the shared deliverable guidance is inherited by Direct and Split without Web coupling', () => {
  assertSharedDeliverableGuidance(BUNDLE_ENTRIES, OVERLAY_ENTRIES)
  const guidanceGroup = BUNDLE_ENTRIES.find(entry => entry.insert?.some(row => row.id === DELIVERABLE_GUIDANCE_ID))
  assert.ok(guidanceGroup?.insert !== undefined, 'the base profile must contain the shared guidance in an insert group')
  const mutateBundle = (mutate: (rows: readonly OverlayRow[]) => readonly OverlayRow[]): OverlayEntry[] =>
    BUNDLE_ENTRIES.map(entry => entry === guidanceGroup ? { ...entry, insert: mutate(entry.insert ?? []) } : entry)

  assert.throws(
    () => assertSharedDeliverableGuidance(
      mutateBundle(rows => rows.filter(candidate => candidate.id !== DELIVERABLE_GUIDANCE_ID)),
      OVERLAY_ENTRIES,
    ),
    /exactly one deliverable guidance row/u,
    'a missing shared row must fail the common-profile assertion',
  )
  assert.throws(
    () => assertSharedDeliverableGuidance(
      mutateBundle(rows => rows.map(candidate => candidate.id === DELIVERABLE_GUIDANCE_ID
        ? { ...candidate, name: '@deepseek-ai/dsh-file-reference-local' }
        : candidate)),
      OVERLAY_ENTRIES,
    ),
    /official package/u,
    'a repointed shared row must fail the common-profile assertion',
  )
  assert.throws(
    () => assertSharedDeliverableGuidance(
      mutateBundle(rows => [...rows, { id: DELIVERABLE_GUIDANCE_ID, name: DELIVERABLE_GUIDANCE_PACKAGE }]),
      OVERLAY_ENTRIES,
    ),
    /exactly one deliverable guidance row/u,
    'a duplicated shared row must fail the common-profile assertion',
  )
})

test('the Host-only overlay declares the official Host service rows and ONE built-in Host Runtime row', () => {
  // B1 rows unchanged.
  assert.equal(row('split-host-connection').name, '@deepseek-ai/dsh-client-connection')
  assert.deepEqual(row('split-host-api-remotes').inject, ['typertGateway', 'connection'])
  // TUI/Client-UI rows are disabled by declaration.
  for (const id of ['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins']) {
    assert.equal(row(id).disabled, true, `${id} must stay disabled`)
  }
  // The eight official service rows; the package runtime remains one combined row.
  assert.equal(OVERLAY_ROWS.filter(candidate => candidate.id.startsWith('split-host-')).length, 10,
    'the overlay must own the two B1 rows and eight official Host service rows')
  for (const { id, name } of FOUNDATION_ROWS) {
    assert.equal(row(id).name, name)
  }
  assert.equal(OVERLAY_ROWS.filter(candidate => candidate.name === '@xmoon76/dsh-pi-tui/host-runtime').length, 1,
    'one built-in Host Runtime Loader row')
  assert.equal(OVERLAY_ROWS.some(candidate => /file-reference-host|terminal-progress-host/u.test(candidate.name ?? '')),
    false, 'the private features must not be independent Loader rows')
  assert.deepEqual(row('split-host-session-controller').config, { nativeOpen: false })
  // The exact twelve-row dependency contract, including the three in-place overrides.
  assertHostExecutionInject(OVERLAY_ENTRIES)
})

test('the bundle owns ONE stable official Workspace Controller row the Host overlay retunes in place', () => {
  assertWorkspaceComposition(BUNDLE_ENTRIES, OVERLAY_ENTRIES)
  // The positive path is what the assertions above accept; the negative
  // controls below prove the same function rejects each mutation.
  assert.equal(BUNDLE_ROWS.filter(candidate => candidate.id === 'workspace-controller').length, 1)
})

test('the protected Workspace composition rejects a tuiStartup gate carried into the Host-only override', () => {
  // Negative control 4: the Host row must not depend on the mutable startup
  // provider (a `tuiStartup` reload would dispose the Host Workspace owner).
  const gatedOverlay = OVERLAY_ENTRIES.map(entry =>
    entry.insert === undefined && entry.id === 'workspace-controller'
      ? { ...entry, name: WORKSPACE_CONTROLLER_PACKAGE, inject: ['tuiStartup'] }
      : entry)
  assert.throws(
    () => assertWorkspaceComposition(BUNDLE_ENTRIES, gatedOverlay),
    /workspace-controller|tuiStartup/u,
    'the negative control must reject a reintroduced tuiStartup gate',
  )
})

test('the protected Workspace composition rejects an in-place row that re-declares, disables or duplicates the owner', () => {
  const redeclared = OVERLAY_ENTRIES.map(entry =>
    entry.insert === undefined && entry.id === 'workspace-controller'
      ? { ...entry, name: WORKSPACE_CONTROLLER_PACKAGE }
      : entry)
  assert.throws(
    () => assertWorkspaceComposition(BUNDLE_ENTRIES, redeclared),
    /must not re-declare the package/u,
    'an override that re-declares `name` inserts a second Loader row',
  )
  const disabled = OVERLAY_ENTRIES.map(entry =>
    entry.insert === undefined && entry.id === 'workspace-controller'
      ? { ...entry, disabled: true }
      : entry)
  assert.throws(
    () => assertWorkspaceComposition(BUNDLE_ENTRIES, disabled),
    /must not disable the Workspace Controller/u,
  )
  // A parallel split-host owner is the rejected plan alternative.
  const parallel = OVERLAY_ENTRIES.flatMap(entry => entry.insert === undefined ? [entry] : [{
    ...entry,
    insert: [...entry.insert, { id: 'split-host-workspace-controller', name: WORKSPACE_CONTROLLER_PACKAGE }],
  }])
  assert.throws(
    () => assertWorkspaceComposition(BUNDLE_ENTRIES, parallel),
    /parallel split-host Workspace Controller owner|not INSERT a "@deepseek-ai\/dsh-api-workspace-controller"/u,
  )
  // A second `workspace` registry row is the other duplicate-owner shape.
  const duplicateRegistry = OVERLAY_ENTRIES.flatMap(entry => entry.insert === undefined ? [entry] : [{
    ...entry,
    insert: [...entry.insert, { id: 'workspace-hidden', name: WORKSPACE_REGISTRY_PACKAGE }],
  }])
  assert.throws(
    () => assertWorkspaceComposition(BUNDLE_ENTRIES, duplicateRegistry),
    /not INSERT a "@deepseek-ai\/dsh-workspace" row/u,
  )
})

test('the protected twelve-row dependency assertion rejects a reintroduced tuiStartup', () => {
  const reintroduced = OVERLAY_ENTRIES.map(entry => entry.insert === undefined ? entry : {
    ...entry,
    insert: entry.insert.map(candidate => candidate.id === 'split-host-turn-outline'
      ? { ...candidate, inject: [...(candidate.inject ?? []), 'tuiStartup'] }
      : candidate),
  })
  assert.throws(
    () => assertHostExecutionInject(reintroduced),
    /split-host-turn-outline/u,
    'the negative control must fail on the protected row id',
  )
})

test('the protected twelve-row dependency assertion rejects a duplicated protected row', () => {
  const insertEntry = OVERLAY_ENTRIES.find(entry => entry.insert !== undefined)
  const insertRows = insertEntry?.insert
  assert.ok(insertRows !== undefined, 'the overlay must insert the Host execution rows')
  const protectedRow = insertRows.find(candidate => candidate.id === 'split-host-session-stats')
  assert.ok(protectedRow !== undefined, 'the negative control needs one real protected row to duplicate')
  const duplicated = OVERLAY_ENTRIES.map(entry => entry === insertEntry
    ? { ...entry, insert: [...insertRows, protectedRow] }
    : entry)
  assert.throws(
    () => assertHostExecutionInject(duplicated),
    /the overlay must own exactly one "split-host-session-stats" row/u,
    'the negative control must reject the duplicated row itself',
  )
})

/**
 * M5-W PR-A + S5-PR5: the official Web rows the Host-only overlay declares, in
 * order. This list is FROZEN here on purpose: the composition assertion below
 * compares the real overlay against it, so a silently dropped, renamed,
 * reordered or re-enabled Web row fails the test instead of being mirrored by a
 * generated list. It is the official browser graph of the installed DSH family
 * minus every row whose authority already exists in this Host, plus the one
 * official `terminal-controller` row the Browser x TUI composition needs. The
 * mandatory client-dependency closure of the shipped official UIs
 * (`ui-context-menu`, `ui-file-drag`), the official file-actions /
 * message-quotes Client features and the `workspace-changes` Host recorder
 * `ui-deliverables` injects are part of it.
 *
 * The list is the contract, not its length: a legitimate future official
 * package may extend it, and the assertion proves the exact set — never a
 * bare count.
 */
const WEB_ROWS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app' },
  { id: 'modules', name: '@deepseek-ai/dsh-client-modules' },
  { id: 'client-hmr', name: '@deepseek-ai/dsh-client-hmr' },
  { id: 'cordis-client-runner', name: '@deepseek-ai/dsh-cordis-client-runner' },
  { id: 'ui-file-actions', name: '@deepseek-ai/dsh-client-ui-file-actions' },
  { id: 'ui-context-menu', name: '@deepseek-ai/dsh-client-ui-context-menu' },
  { id: 'ui-open-in-app', name: '@deepseek-ai/dsh-client-ui-open-in-app' },
  { id: 'ui-settings-account', name: '@deepseek-ai/dsh-client-ui-settings-account' },
  { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme' },
  { id: 'locale', name: '@deepseek-ai/dsh-client-locale' },
  { id: 'shortcuts', name: '@deepseek-ai/dsh-client-shortcuts' },
  { id: 'ui-shortcuts', name: '@deepseek-ai/dsh-client-ui-shortcuts' },
  { id: 'ui-layout', name: '@deepseek-ai/dsh-client-ui-layout' },
  { id: 'ui-renderer', name: '@deepseek-ai/dsh-client-ui-renderer' },
  { id: 'ui-session', name: '@deepseek-ai/dsh-client-ui-session' },
  { id: 'resources', name: '@deepseek-ai/dsh-client-resources' },
  { id: 'ui-sidebar', name: '@deepseek-ai/dsh-client-ui-sidebar' },
  { id: 'ui-sidebar-right', name: '@deepseek-ai/dsh-client-ui-sidebar-right' },
  { id: 'office-to-pdf', name: '@deepseek-ai/dsh-office-to-pdf' },
  { id: 'ui-sidebar-documentpreview', name: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' },
  { id: 'ui-sidebar-terminal', name: '@deepseek-ai/dsh-client-ui-sidebar-terminal' },
  { id: 'ui-sidebar-files', name: '@deepseek-ai/dsh-client-ui-sidebar-files' },
  { id: 'ui-settings', name: '@deepseek-ai/dsh-client-ui-settings' },
  { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general' },
  { id: 'ui-settings-models', name: '@deepseek-ai/dsh-client-ui-settings-models' },
  { id: 'ui-plugin-manager', name: '@deepseek-ai/dsh-client-ui-plugin-manager' },
  { id: 'ui-settings-plugin-inventory', name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory' },
  { id: 'ui-conversation', name: '@deepseek-ai/dsh-client-ui-conversation' },
  { id: 'ui-approval', name: '@deepseek-ai/dsh-client-ui-approval' },
  { id: 'message-quotes', name: '@deepseek-ai/dsh-message-quotes' },
  { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
  { id: 'ui-brand-official', name: '@deepseek-ai/dsh-client-ui-brand-official' },
  { id: 'ui-attachment', name: '@deepseek-ai/dsh-client-ui-attachment' },
  { id: 'ui-file-drag', name: '@deepseek-ai/dsh-client-ui-file-drag' },
  { id: 'ui-tool', name: '@deepseek-ai/dsh-client-ui-tool' },
  { id: 'ui-cordis', name: '@deepseek-ai/dsh-client-ui-cordis' },
  { id: 'workspace-changes', name: '@deepseek-ai/dsh-workspace-changes' },
  { id: 'ui-deliverables', name: '@deepseek-ai/dsh-client-ui-deliverables' },
  { id: 'ui-workspace', name: '@deepseek-ai/dsh-client-ui-workspace' },
  { id: 'ui-workflow-run', name: '@deepseek-ai/dsh-client-ui-workflow-run' },
  { id: 'ui-input-trigger', name: '@deepseek-ai/dsh-client-ui-input-trigger' },
  { id: 'ui-commands', name: '@deepseek-ai/dsh-client-ui-commands' },
  { id: 'ui-skill', name: '@deepseek-ai/dsh-client-ui-skill' },
  { id: 'ui-subagent', name: '@deepseek-ai/dsh-client-ui-subagent' },
  { id: 'ui-reference', name: '@deepseek-ai/dsh-client-ui-reference' },
  { id: 'ui-secret-mask', name: '@deepseek-ai/dsh-client-ui-secret-mask' },
  { id: 'ui-jobs', name: '@deepseek-ai/dsh-client-ui-jobs' },
  { id: 'ui-schedule', name: '@deepseek-ai/dsh-client-ui-schedule' },
  { id: 'ui-goal', name: '@deepseek-ai/dsh-client-ui-goal' },
  { id: 'ui-message-feedback', name: '@deepseek-ai/dsh-client-ui-message-feedback' },
  { id: 'ui-model-selection', name: '@deepseek-ai/dsh-client-ui-model-selection' },
  { id: 'ui-permission', name: '@deepseek-ai/dsh-client-ui-permission-presets' },
  { id: 'ui-agent-preset', name: '@deepseek-ai/dsh-client-ui-agent-preset' },
  { id: 'entry-customization', name: '@deepseek-ai/dsh-client-ui-entry-customization' },
  { id: 'ui-settings-session-log', name: '@deepseek-ai/dsh-client-ui-settings-session-log' },
  { id: 'ui-settings-plugins', name: '@deepseek-ai/dsh-client-ui-settings-plugins' },
  { id: 'ui-settings-shell', name: '@deepseek-ai/dsh-client-ui-settings-shell' },
  { id: 'ui-settings-agent-loop', name: '@deepseek-ai/dsh-client-ui-settings-agent-loop' },
  { id: 'ui-settings-subagent', name: '@deepseek-ai/dsh-client-ui-settings-subagent' },
  { id: 'ui-settings-web-search', name: '@deepseek-ai/dsh-client-ui-settings-web-search' },
  { id: 'ui-plan', name: '@deepseek-ai/dsh-client-ui-plan' },
  { id: 'ui-user-questions', name: '@deepseek-ai/dsh-client-ui-user-questions' },
  { id: 'ui-trajectory', name: '@deepseek-ai/dsh-client-ui-trajectory' },
  { id: 'terminal-controller', name: '@deepseek-ai/dsh-api-terminal-controller' },
]

const WEB_RUNTIME_ID = 'web-runtime'
const WEB_RUNTIME_PACKAGE = '@deepseek-ai/dsh-web-app'
const CLIENT_MODULES_PACKAGE = '@deepseek-ai/dsh-client-modules'
/** The runtime values the plan fixes: no launcher, no printed token URL, no DSH_WEB_URL. */
const WEB_RUNTIME_CONFIG = { openBrowser: false, printUrl: false, surfaceContext: false }
/** Packages whose ONE Host authority already exists; the Web group must not re-declare them. */
const DUPLICATED_HOST_AUTHORITY_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-settings-controller',
  ACCOUNT_CONTROLLER_PACKAGE,
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-api-job-controller',
]

/**
 * The Host authorities that ALREADY exist on the bundle/base rows. Group 2
 * proves each is still owned by exactly ONE row across the bundle patch and the
 * Host-only overlay, so the Web composition can never add a second owner of the
 * same official package.
 */
const HOST_AUTHORITY_OWNERS: ReadonlyArray<{ pkg: string; id: string }> = [
  { pkg: '@deepseek-ai/dsh-workspace', id: 'workspace' },
  { pkg: '@deepseek-ai/dsh-api-workspace-controller', id: 'workspace-controller' },
  { pkg: '@deepseek-ai/dsh-host-webserver', id: 'webserver' },
  { pkg: '@deepseek-ai/dsh-api-job-controller', id: 'job-controller' },
  { pkg: '@deepseek-ai/dsh-client-connection', id: 'split-host-connection' },
  { pkg: '@deepseek-ai/dsh-api-remotes', id: 'split-host-api-remotes' },
  { pkg: '@deepseek-ai/dsh-client-file-upload', id: 'split-host-file-upload' },
  { pkg: '@deepseek-ai/dsh-api-session-controller', id: 'split-host-session-controller' },
  { pkg: '@deepseek-ai/dsh-api-settings-controller', id: 'split-host-settings-controller' },
  { pkg: ACCOUNT_CONTROLLER_PACKAGE, id: 'split-host-account-controller' },
]

/** The Direct-only Schedule activation prerequisites the Host-only overlay disables. */
const DIRECT_SCHEDULE_PREREQUISITE_IDS: readonly string[] = [
  'pi-tui-direct-connection',
  'pi-tui-direct-file-upload',
  'pi-tui-direct-session-controller',
]

/** The overlay's LAST insert group is the Web composition declaration. */
function webInsertGroup(entries: readonly OverlayEntry[]): readonly OverlayRow[] {
  const groups = entries.filter(entry => entry.insert !== undefined)
  assert.ok(groups.length >= 2, 'the overlay must keep the Host execution insert and add ONE Web insert')
  return groups[groups.length - 1].insert ?? []
}

/**
 * The S5-PR5 official additions: each is an ONE-owner row of the shared
 * composition, so a roster that loses one of them is an incomplete Web graph
 * rather than a shorter list.
 */
const PR5_REQUIRED_WEB_ROWS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
  { id: 'ui-file-actions', name: '@deepseek-ai/dsh-client-ui-file-actions' },
  { id: 'message-quotes', name: '@deepseek-ai/dsh-message-quotes' },
  { id: 'workspace-changes', name: '@deepseek-ai/dsh-workspace-changes' },
]

/**
 * Group 1 — the frozen Web roster: exact ids, exact packages, order, ONE row
 * per id and the three runtime values the plan fixes. Shared by the positive
 * assertion and its negative controls so each control proves THIS assertion
 * group rejects the mutation instead of a private copy.
 */
function assertWebRoster(
  web: readonly OverlayRow[],
  expected: readonly { readonly id: string; readonly name: string }[] = WEB_ROWS,
): void {
  assert.deepEqual(web.map(candidate => candidate.id), expected.map(row => row.id),
    'the Web insert must declare exactly the official Web rows in order')
  assert.deepEqual(web.map(candidate => candidate.name), expected.map(row => row.name),
    'every Web row id must keep its exact official package')
  for (const candidate of web) {
    assert.equal(candidate.disabled, true, `the "${candidate.id}" Web row must stay disabled by default`)
    if (candidate.id === WEB_RUNTIME_ID) {
      assert.equal(candidate.name, WEB_RUNTIME_PACKAGE)
      assert.deepEqual(candidate.inject, ['webServer'],
        'web-runtime must inject the existing webserver, not a second listener')
      assert.deepEqual(candidate.config, WEB_RUNTIME_CONFIG,
        'web-runtime must stay silent: no browser launch, no printed token URL, no DSH_WEB_URL')
      continue
    }
    assert.equal(candidate.inject, undefined, `the "${candidate.id}" Web row must not inject extra services`)
    assert.equal(candidate.config, undefined, `the "${candidate.id}" Web row must not carry extra config`)
  }
  const ids = web.map(candidate => candidate.id)
  assert.equal(new Set(ids).size, ids.length, 'a duplicated Web row would activate one package twice')
  // S5-PR5 required closure: every added official capability is owned by
  // exactly ONE row loading its exact official package.
  for (const required of PR5_REQUIRED_WEB_ROWS) {
    const owners = web.filter(candidate => candidate.name === required.name)
    assert.equal(owners.length, 1, `exactly ONE Web row must load "${required.name}", found ${String(owners.length)}`)
    assert.equal(owners[0].id, required.id, `"${required.name}" must be owned by the "${required.id}" row`)
  }
  // The changed-files provider is enabled before its consumer: the toggle
  // activates one awaited row at a time, so a consumer that mounts first would
  // stay PENDING and roll the whole Web composition back.
  const providerIndex = ids.indexOf('workspace-changes')
  const consumerIndex = ids.indexOf('ui-deliverables')
  assert.ok(providerIndex >= 0 && consumerIndex >= 0 && providerIndex < consumerIndex,
    'the "workspace-changes" provider must precede its "ui-deliverables" consumer')
  assert.equal(ids.includes('ui-deliverables'), true, 'the official deliverables UI row belongs to the roster')
  assert.equal(ids.includes('terminal-controller'), true, 'the ONE official Host row on top of the roster is terminal-controller')
  assert.equal(ids.includes('workspace-controller'), false,
    'the Workspace Controller authority already exists: the Web group must not insert a second one')
}

/**
 * Group 2 — Host owner de-duplication: the Web composition adds rows, never a
 * second owner of an authority this Host already publishes.
 */
function assertWebOwnerDedupe(
  bundleEntries: readonly OverlayEntry[],
  overlayEntries: readonly OverlayEntry[],
): void {
  const web = webInsertGroup(overlayEntries)
  const webPackages = new Set(web.map(candidate => candidate.name))
  for (const name of DUPLICATED_HOST_AUTHORITY_PACKAGES) {
    assert.equal(webPackages.has(name), false, `the Web group must not re-declare the existing "${name}" authority`)
  }
  // Each existing Host authority keeps exactly ONE owning row across the whole
  // composed declaration, on the row that owned it before this PR.
  const composed = [
    ...bundleEntries.flatMap(entry => entry.insert ?? [entry]),
    ...overlayEntries.flatMap(entry => entry.insert ?? [entry]),
  ]
  // Rows the overlay disables are DECLARED but never mount in a Host-only PID.
  // The one-owner property is therefore about ENABLED rows: the bundle's
  // Direct-only Schedule activation prerequisites exist statically and are
  // switched off here, so the split-host row remains the only real owner.
  const overlayDisabled = new Set(overlayEntries.filter(entry => entry.disabled === true).map(entry => entry.id))
  const enabled = composed.filter(row => overlayDisabled.has(row.id) === false && row.disabled !== true)
  for (const { pkg, id } of HOST_AUTHORITY_OWNERS) {
    const owners = enabled.filter(row => row.name === pkg)
    assert.equal(owners.length, 1,
      `exactly ONE "${pkg}" enabled row must own the Host authority; found ${owners.map(row => row.id).join(',')}`)
    assert.equal(owners[0].id, id, `the "${pkg}" authority must stay on the enabled "${id}" row`)
  }
  // The Direct-only prerequisites stay declared in the bundle for a Direct
  // Host, and the overlay disables every one of them.
  for (const direct of DIRECT_SCHEDULE_PREREQUISITE_IDS) {
    assert.equal(composed.some(row => row.id === direct), true, `the bundle keeps the "${direct}" declaration`)
    assert.equal(overlayDisabled.has(direct), true, `the Host-only overlay must disable "${direct}"`)
  }
  // The whole overlay keeps ONE row per id: a second owner is an added row, not
  // a renamed one. The three in-place overrides appear once each.
  const overlayRows = overlayEntries.flatMap(entry => entry.insert ?? [entry])
  const overlayIds = overlayRows.map(candidate => candidate.id)
  assert.equal(new Set(overlayIds).size, overlayIds.length, 'the Host-only overlay must own exactly one row per id')
  for (const name of [WEB_RUNTIME_PACKAGE, CLIENT_MODULES_PACKAGE]) {
    assert.equal(overlayRows.filter(candidate => candidate.name === name).length, 1,
      `exactly ONE "${name}" row may exist in the Host-only overlay`)
  }
  // The fallback owns the only SPA seat, so it arrives through web-runtime
  // alone; a declared row would be a second static owner.
  const bundle = bundleEntries.flatMap(entry => entry.insert ?? [entry])
  assert.equal(bundle.some(candidate => candidate.name === '@deepseek-ai/dsh-host-frontend-static'), false,
    'the Direct bundle must not mount the Web static owner')
  assert.equal(overlayRows.some(candidate => candidate.name === '@deepseek-ai/dsh-host-frontend-static'), false,
    'the fallback is web-runtime-owned: no separate frontend-static row may be declared')
}

test('the Host-only overlay declares the official Web rows DEFAULT-DISABLED on ONE insert', () => {
  assertWebRoster(webInsertGroup(OVERLAY_ENTRIES))
  // The composition is static: no production switch selects these rows.
  assert.doesNotMatch(HOST_ONLY_PATCH, /WEB_ENABLED|M5_WEB_MODE|--web\b/u,
    'the overlay must not introduce a user-facing Web switch')
})

test('the Web composition reuses the existing Host authorities instead of declaring a second owner', () => {
  assertWebOwnerDedupe(BUNDLE_ENTRIES, OVERLAY_ENTRIES)
})

/**
 * M5-W PR-B — the runtime toggle's roster must BE the overlay's roster.
 *
 * The service owns a frozen table of official Web rows (id + package) because it
 * flips those exact rows at runtime. This assertion compares that table with
 * the real `HOST_ONLY_PATCH` insert, so a silently added, dropped, renamed or
 * reordered declaration cannot leave the toggle driving a different graph than
 * the Host booted.
 */
function assertWebAccessRoster(web: readonly OverlayRow[]): void {
  assert.deepEqual(PI_TUI_WEB_ACCESS_ROWS.map(row => row.id), web.map(row => row.id),
    'the toggle roster must be the overlay roster: same ids, same order')
  assert.deepEqual(PI_TUI_WEB_ACCESS_ROWS.map(row => row.name), web.map(row => row.name),
    'the toggle roster must keep every row`s official package')
  const ids = PI_TUI_WEB_ACCESS_ROWS.map(row => row.id)
  assert.equal(new Set(ids).size, ids.length, 'the toggle roster must not repeat a row id')
  for (const row of web) {
    assert.equal(row.disabled, true, `the "${row.id}" row must start disabled for the toggle to enable it`)
  }
}

test('the runtime toggle owns exactly the overlay Web roster', () => {
  assertWebAccessRoster(webInsertGroup(OVERLAY_ENTRIES))
})

test('the toggle roster assertion rejects a missing, renamed, duplicated or foreign row', () => {
  const webGroups = OVERLAY_ENTRIES.filter(entry => entry.insert !== undefined)
  const webGroup = webGroups[webGroups.length - 1]
  assert.ok(webGroup.insert !== undefined, 'the negative controls need the real Web insert group')
  const mutateWeb = (
    mutate: (rows: readonly OverlayRow[]) => readonly OverlayRow[],
  ): readonly OverlayRow[] => mutate(webGroup.insert ?? [])
  // Drift 1: a removed declaration row would make the toggle's table name
  // a row this Host never mounts.
  assert.throws(
    () => assertWebAccessRoster(mutateWeb(rows => rows.filter(row => row.id !== 'terminal-controller'))),
    /same ids, same order/u,
  )
  // Drift 2: the same id pointed at a different official package.
  assert.throws(
    () => assertWebAccessRoster(mutateWeb(rows => rows.map(row =>
      row.id === WEB_RUNTIME_ID ? { ...row, name: '@deepseek-ai/dsh-host-webserver' } : row))),
    /official package/u,
  )
  // Drift 3: a duplicated graph composer would register the browser module
  // table twice.
  assert.throws(
    () => assertWebAccessRoster(mutateWeb(rows => [...rows, { id: 'modules', name: CLIENT_MODULES_PACKAGE, disabled: true }])),
    /same ids, same order|repeat a row id/u,
  )
  // Drift 4: a protected Host owner inside the roster would be disposed by the
  // toggle. The exactly-one-owner rule rejects it before the toggle can.
  assert.throws(
    () => assertWebOwnerDedupe(BUNDLE_ENTRIES, OVERLAY_ENTRIES.map(entry => entry === webGroup
      ? { ...entry, insert: [...(entry.insert ?? []), { id: 'workspace-controller-copy', name: WORKSPACE_CONTROLLER_PACKAGE, disabled: true }] }
      : entry)),
    /must not re-declare the existing "@deepseek-ai\/dsh-api-workspace-controller"|exactly ONE "@deepseek-ai\/dsh-api-workspace-controller"/u,
  )
})

test('the Web composition assertion rejects a re-enabled row, a browser launch and duplicate owners', () => {
  const webGroups = OVERLAY_ENTRIES.filter(entry => entry.insert !== undefined)
  const webGroup = webGroups[webGroups.length - 1]
  assert.ok(webGroup.insert !== undefined, 'the negative controls need the real Web insert group')
  const mutateWeb = (
    mutate: (rows: readonly OverlayRow[]) => readonly OverlayRow[],
  ): OverlayEntry[] => OVERLAY_ENTRIES.map(entry => entry === webGroup ? { ...entry, insert: mutate(entry.insert ?? []) } : entry)
  // Drift 1: the runtime row enabled by default would open a Web surface the
  // product has not shipped.
  assert.throws(
    () => assertWebRoster(webInsertGroup(mutateWeb(rows =>
      rows.map(row => row.id === WEB_RUNTIME_ID ? { ...row, disabled: false } : row)))),
    /web-runtime.*disabled by default/u,
  )
  // Drift 2: the official runtime defaults would launch a browser and print a
  // token-bearing URL from the Host log.
  assert.throws(
    () => assertWebRoster(webInsertGroup(mutateWeb(rows =>
      rows.map(row => row.id === WEB_RUNTIME_ID
        ? { ...row, config: { ...WEB_RUNTIME_CONFIG, openBrowser: true } }
        : row)))),
    /web-runtime must stay silent/u,
  )
  // Drift 3: a second Workspace Controller inside the Web insert is the second
  // owner the plan forbids (it already exists as an in-place override).
  assert.throws(
    () => assertWebOwnerDedupe(BUNDLE_ENTRIES, mutateWeb(rows => [...rows, {
      id: 'workspace-controller', name: WORKSPACE_CONTROLLER_PACKAGE, disabled: true,
    }])),
    /exactly one row per id|re-declare the existing "@deepseek-ai\/dsh-api-workspace-controller"/u,
  )
  // Drift 4: a duplicated graph composer registers the browser module table
  // twice.
  assert.throws(
    () => assertWebOwnerDedupe(BUNDLE_ENTRIES, mutateWeb(rows => [...rows, {
      id: 'modules-again', name: CLIENT_MODULES_PACKAGE, disabled: true,
    }])),
    /exactly ONE "@deepseek-ai\/dsh-client-modules"/u,
  )
  // Drift 5/6: the two mandatory Client dependencies the shipped official UIs
  // inject may not be missing from the REAL overlay. The expectations are
  // mutated here (not the overlay), so the control proves the comparison catches
  // a roster that no longer satisfies the official inject closure.
  for (const dependency of MANDATORY_CLIENT_DEPENDENCY_PACKAGES) {
    assert.throws(
      () => assertWebRoster(webInsertGroup(OVERLAY_ENTRIES), WEB_ROWS.filter(row => row.name !== dependency)),
      /must declare exactly the official Web rows in order/u,
      `dropping "${dependency}" from the frozen roster must fail the composition assertion`,
    )
  }
  // Drift 7: the deleted official label may not come back into the expectations
  // (and therefore never into the overlay).
  assert.throws(
    () => assertWebRoster(webInsertGroup(OVERLAY_ENTRIES), [...WEB_ROWS, {
      id: 'ui-deepseek-model-label-1017',
      name: '@deepseek-ai/dsh-client-ui-deepseek-model-label-1017',
    }]),
    /must declare exactly the official Web rows in order/u,
    'the deleted 1017 label must fail the roster comparison instead of being re-added',
  )
  // Drift 8/9: a second `connection`/`api-remotes` owner in the Web insert (or at
  // the top level) is the duplicate Host authority this composition forbids.
  for (const [suffix, authority] of [
    ['connection-copy', '@deepseek-ai/dsh-client-connection'],
    ['api-remotes-copy', '@deepseek-ai/dsh-api-remotes'],
  ] as const) {
    assert.throws(
      () => assertWebOwnerDedupe(BUNDLE_ENTRIES, mutateWeb(rows => [...rows, {
        id: suffix, name: authority, disabled: true,
      }])),
      /must not re-declare the existing|exactly ONE/u,
      `a second "${authority}" row must fail the owner de-duplication`,
    )
  }
  assert.throws(
    () => assertWebOwnerDedupe(BUNDLE_ENTRIES, [...OVERLAY_ENTRIES, {
      id: 'api-remotes-copy', name: '@deepseek-ai/dsh-api-remotes',
    }]),
    /exactly ONE "@deepseek-ai\/dsh-api-remotes"/u,
    'a top-level second api-remotes row must fail the owner de-duplication',
  )
})

/**
 * The official Client UIs whose declared `dsh.client.inject` closure the Web
 * roster must satisfy. The manifests are read from the REAL installed npm
 * packages of the pinned DSH family, anchored at the official Web bundle that
 * declares them — never from a hand-written dependency list.
 */
const OFFICIAL_CLIENT_UI_PACKAGES = [
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-deliverables',
  // S5-PR5 additions: their real manifests prove the official packages resolve
  // from the pinned family and that their inject closure is satisfied by the
  // roster below.
  '@deepseek-ai/dsh-client-ui-file-actions',
  '@deepseek-ai/dsh-message-quotes',
] as const

/** The mandatory Client packages whose only owner is one Web-only roster row. */
const MANDATORY_CLIENT_DEPENDENCY_PACKAGES = [
  '@deepseek-ai/dsh-client-ui-context-menu',
  '@deepseek-ai/dsh-client-ui-file-drag',
] as const

/** The installed official Web-bundle manifest, the anchor of the Client family. */
function officialWebAppManifest(): { readonly version: string } {
  const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json')
  return JSON.parse(readFileSync(anchor, 'utf8')) as { readonly version: string }
}

/** Read an installed official package manifest through the Web bundle dependency graph. */
function officialPackageVersion(pkg: string): string {
  const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json')
  const manifestPath = createRequire(anchor).resolve(`${pkg}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly version?: unknown }
  assert.equal(typeof manifest.version, 'string', `the official "${pkg}" manifest must declare its version`)
  return manifest.version as string
}

/**
 * Read one installed official manifest's `dsh.client.inject` list. A missing
 * package, an unreadable manifest or an unknown shape fails closed instead of
 * being treated as "no dependencies".
 */
function readOfficialClientInject(pkg: string): { readonly version: string; readonly inject: readonly string[] } {
  const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json')
  const manifestPath = createRequire(anchor).resolve(`${pkg}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    readonly version?: unknown
    readonly dsh?: { readonly client?: { readonly inject?: unknown } }
  }
  assert.equal(typeof manifest.version, 'string', `the official "${pkg}" manifest must declare its version`)
  const inject = manifest.dsh?.client?.inject
  assert.ok(
    Array.isArray(inject) && inject.every(entry => typeof entry === 'string' && entry.length > 0),
    `the official "${pkg}" manifest must declare a string "dsh.client.inject" list`,
  )
  return { version: manifest.version as string, inject }
}

/**
 * The official Client inject closure, shared by the positive assertion and its
 * negative control: every mandatory dependency some shipped official UI
 * declares must be owned by exactly ONE Web roster row, declared default-OFF.
 */
function assertMandatoryClientInjectClosure(
  web: readonly OverlayRow[],
  manifests: ReadonlyMap<string, readonly string[]>,
): void {
  for (const dependency of MANDATORY_CLIENT_DEPENDENCY_PACKAGES) {
    const consumers = [...manifests]
      .filter(([, inject]) => inject.includes(dependency))
      .map(([pkg]) => pkg)
    assert.ok(consumers.length > 0,
      `no shipped official Client UI declares "${dependency}"; the mandatory dependency list is stale`)
    for (const consumer of consumers) {
      const owners = web.filter(row => row.name === dependency)
      assert.equal(owners.length, 1,
        `"${consumer}" injects "${dependency}": exactly ONE Web row must load it, found ${String(owners.length)}`)
      const owner = owners[0] as OverlayRow
      assert.equal(owner.disabled, true,
        `the "${owner.id}" row serving "${dependency}" must start disabled so only the toggle mounts it`)
    }
  }
}

test('the Web roster satisfies the official Client inject closure of the pinned npm family', () => {
  const webApp = officialWebAppManifest()
  const pinned = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    readonly devDependencies: Readonly<Record<string, string>>
  }).devDependencies['@deepseek-ai/dsh-web-app']
  assert.equal(webApp.version, pinned,
    'the installed official Web bundle must be the DSH family this repository pins')
  for (const pkg of [DELIVERABLE_GUIDANCE_PACKAGE, OFFICE_PACKAGE, HARNESS_DEV_CONTEXT_PACKAGE]) {
    assert.equal(officialPackageVersion(pkg), webApp.version,
      `the official "${pkg}" must resolve from the pinned Web bundle dependency family`)
  }
  const manifests = new Map<string, readonly string[]>()
  for (const pkg of OFFICIAL_CLIENT_UI_PACKAGES) {
    const manifest = readOfficialClientInject(pkg)
    assert.equal(manifest.version, webApp.version,
      `the official "${pkg}" must come from the same pinned DSH family as the Web bundle`)
    manifests.set(pkg, manifest.inject)
  }
  const web = webInsertGroup(OVERLAY_ENTRIES)
  assertMandatoryClientInjectClosure(web, manifests)
  // The two mandatory rows own their package exactly once and are plain rows:
  // no local inject/config override, no feature configuration.
  for (const dependency of MANDATORY_CLIENT_DEPENDENCY_PACKAGES) {
    const owners = web.filter(row => row.name === dependency)
    assert.equal(owners.length, 1, `the Web roster must own exactly one "${dependency}" row`)
    assert.equal(owners[0].inject, undefined, `"${dependency}" keeps its own official manifest injects`)
    assert.equal(owners[0].config, undefined, `"${dependency}" carries no local feature configuration`)
  }
  // Negative control: the SAME closure assertion rejects a roster that dropped
  // either mandatory dependency.
  for (const dependency of MANDATORY_CLIENT_DEPENDENCY_PACKAGES) {
    assert.throws(
      () => assertMandatoryClientInjectClosure(web.filter(row => row.name !== dependency), manifests),
      /exactly ONE Web row must load it/u,
      `dropping "${dependency}" from the Web roster must fail the inject-closure assertion`,
    )
  }
})

test('the Direct bundle keeps no Web-only row and its own listener/startup gates', () => {
  const bundleIds = new Set(BUNDLE_ROWS.map(row => row.id))
  for (const { id } of WEB_ROWS) {
    assert.equal(bundleIds.has(id), false, `the Direct bundle must not declare the Web-only row "${id}"`)
  }
  const webserver = BUNDLE_ROWS.find(row => row.id === 'webserver')
  assert.deepEqual(webserver?.config, { host: '127.0.0.1', port: 0 },
    'Direct keeps the loopback listener with an OS-assigned port')
  assert.deepEqual(webserver?.inject, ['tuiStartup'], 'Direct keeps its own command-line startup gate')
  assert.deepEqual(BUNDLE_ROWS.find(row => row.id === 'workspace-controller')?.inject, ['tuiStartup'],
    'Direct keeps the Workspace Controller behind the TUI startup admission')
  assert.equal(BUNDLE_ROWS.some(row => row.name === WEB_RUNTIME_PACKAGE), false, 'Direct mounts no Web runtime')
})

interface FixtureRow {
  readonly options: { readonly id: string; readonly name: string; readonly disabled?: boolean }
  readonly fiber?: { readonly state: number; readonly uid?: number }
}

/**
 * One distinct fake Loader fiber UID per row id. A status that caches,
 * serializes or invents a UID therefore cannot match the live row object.
 */
const ROW_FIBER_UIDS = new Map<string, number>()

function rowUid(id: string): number {
  const known = ROW_FIBER_UIDS.get(id)
  if (known !== undefined) return known
  const next = 1000 + ROW_FIBER_UIDS.size
  ROW_FIBER_UIDS.set(id, next)
  return next
}

/** The baseline row set every Host-only Profile must expose as ACTIVE. */
function baselineRows(): FixtureRow[] {
  const active = (id: string, name: string, withUid = true): FixtureRow => ({
    options: { id, name },
    fiber: withUid ? { state: 2, uid: rowUid(id) } : { state: 2 },
  })
  return [
    active('agent', '@deepseek-ai/dsh-agent'),
    active('session', '@deepseek-ai/dsh-session'),
    active('job-controller', '@deepseek-ai/dsh-api-job-controller'),
    active('typert-gateway', '@deepseek-ai/dsh-api-gateway'),
    active('split-host-connection', '@deepseek-ai/dsh-client-connection'),
    active('split-host-api-remotes', '@deepseek-ai/dsh-api-remotes'),
    active('pi-tui-performance-host', '@xmoon76/dsh-pi-tui/performance-host'),
    active('pi-tui-visual-tools', '@xmoon76/dsh-pi-tui/visual-tools'),
    // The bundle's two official Workspace owners, both ACTIVE exactly once.
    active('workspace', WORKSPACE_REGISTRY_PACKAGE),
    active('workspace-controller', WORKSPACE_CONTROLLER_PACKAGE),
    ...FOUNDATION_ROWS.map(({ id, name }) => active(id, name)),
    ...['tui-app', 'pi-tui-extension-host', 'pi-tui-builtins'].map(id => ({
      options: { id, name: id, disabled: true },
    })),
  ]
}

function typertService(serviceKey: string, namespace: string): { typertRemote: { serviceKey: string; namespace: string } } {
  return { typertRemote: { serviceKey, namespace } }
}

/** Build the minimal reflect/loader shape the Host readiness audit consumes. */
function hostContext(rows: FixtureRow[], overrides: Record<string, unknown> = {}): Context {
  const services = new Map<string, unknown>()
  for (const service of REMOTE_HOST_PREREQUISITE_SERVICES) services.set(service, {})
  services.set('connection', {})
  services.set('webServer', {
    host: '127.0.0.1',
    port: 4567,
    protocol: 'http:',
    getOrigin: () => 'http://127.0.0.1:4567',
  })
  services.set('sessionController', typertService('sessionController', 'session'))
  services.set('fileUploads', typertService('fileUploads', 'fileUploads'))
  services.set('settingsController', typertService('settingsController', 'settings'))
  services.set('accountController', typertService('accountController', 'account'))
  // The official Workspace Controller's REAL binding shape: the Host publishes
  // `workspaceController` under the `workspace` namespace.
  services.set('workspaceController', typertService('workspaceController', 'workspace'))
  services.set('piTuiFileReferences', typertService('piTuiFileReferences', PI_TUI_FILE_REFERENCES_NAMESPACE))
  services.set('piTuiTerminalProgress', {
    ...typertService('piTuiTerminalProgress', PI_TUI_TERMINAL_PROGRESS_NAMESPACE),
    records: new Map(),
  })
  services.set('piTuiWebAccess', typertService('piTuiWebAccess', PI_TUI_WEB_ACCESS_NAMESPACE))
  services.set('piTuiSkills', {
    ...typertService('piTuiSkills', PI_TUI_SKILLS_NAMESPACE),
    activeSubscriptions: 0,
  })
  services.set(PI_TUI_HOST_READY_SERVICE, {})
  services.set('piTuiPerformanceReady', {})
  for (const [name, value] of Object.entries(overrides)) services.set(name, value)
  return {
    reflect: { get: (name: string) => services.get(name) },
    loader: { entries: () => rows, await: async () => undefined },
    fiber: { uid: 1 },
  } as unknown as Context
}

test('the readiness audit passes only when every owner row and binding is real', () => {
  const status = collectHostEntryStatus(hostContext(baselineRows()), { profile: 'pi-tui' })
  assert.equal(status.phase, 'ready')
  assert.equal(status.sessionOpen, false, 'Host RPC readiness is not an open Client Session')
  assert.equal(status.terminalProgressWatches, 0, 'the Host reports no live terminal-progress watch')
  assert.equal(status.skillInvalidationWatches, 0, 'the Host reports no live private Skills subscription')
  assert.deepEqual(status.ownerEntries.piTuiHostRuntime, ['split-host-pi-tui-runtime'])
  assert.deepEqual(status.ownerEntries.performance, ['pi-tui-performance-host'])
  assert.deepEqual(status.ownerEntries.visualTools, ['pi-tui-visual-tools'])
  // The ONE official Workspace registry and controller owners.
  assert.deepEqual(status.ownerEntries.workspaceRegistry, ['workspace'])
  assert.deepEqual(status.ownerEntries.workspaceController, ['workspace-controller'])
  assert.equal(status.services.workspaceRegistry, true, 'the official workspaceRegistry service must be live')
  assert.equal(status.services.workspaceController, true, 'the official Workspace Controller service must be live')
  assert.deepEqual(status.ownerEntries.accountController, ['split-host-account-controller'])
  assert.equal(status.services.accountController, true, 'the official Account Controller service must be live')
  for (const { owner, id } of FOUNDATION_ROWS) {
    assert.deepEqual(status.ownerEntries[owner], [id], `${owner} owner row mismatch`)
  }
})

test('the Workspace owners fail the audit unless each official package is ACTIVE once with a real binding', () => {
  // Control 1: the Controller row disabled or absent -> no degraded ready.
  const disabled = baselineRows().map(candidate => candidate.options.id === 'workspace-controller'
    ? { ...candidate, fiber: { state: 0, uid: rowUid('workspace-controller') } }
    : candidate)
  assert.throws(
    () => collectHostEntryStatus(hostContext(disabled), { profile: 'pi-tui' }),
    /expected exactly one active workspaceController owner row, found 0/u,
  )
  const absent = baselineRows().filter(candidate => candidate.options.id !== 'workspace-controller')
  assert.throws(
    () => collectHostEntryStatus(hostContext(absent), { profile: 'pi-tui' }),
    /expected exactly one active workspaceController owner row, found 0/u,
  )
  // Control 2: a readable service object is not a working Workspace API. A
  // missing or different Typert binding must fail the audit.
  assert.throws(
    () => collectHostEntryStatus(hostContext(baselineRows(), { workspaceController: {} }), { profile: 'pi-tui' }),
    /workspaceController.*Typert binding|workspaceController\/workspace/u,
  )
  assert.throws(
    () => collectHostEntryStatus(
      hostContext(baselineRows(), { workspaceController: typertService('directoryPickerController', 'directoryPicker') }),
      { profile: 'pi-tui' },
    ),
    /workspaceController.*Typert binding/u,
  )
  // Control 3: a second ACTIVE row of the SAME official package under a
  // different Loader id must fail even though `workspace-controller` is still
  // exactly one row.
  const imposter = baselineRows().concat({
    options: { id: 'split-host-workspace-controller', name: WORKSPACE_CONTROLLER_PACKAGE },
    fiber: { state: 2, uid: rowUid('split-host-workspace-controller') },
  })
  assert.throws(
    () => collectHostEntryStatus(hostContext(imposter), { profile: 'pi-tui' }),
    /exactly one active workspaceController row for "@deepseek-ai\/dsh-api-workspace-controller" named "workspace-controller"/u,
  )
  // The same duplicate-package rule covers the Registry.
  const duplicateRegistry = baselineRows().concat({
    options: { id: 'workspace-hidden', name: WORKSPACE_REGISTRY_PACKAGE },
    fiber: { state: 2, uid: rowUid('workspace-hidden') },
  })
  assert.throws(
    () => collectHostEntryStatus(hostContext(duplicateRegistry), { profile: 'pi-tui' }),
    /exactly one active workspaceRegistry row for "@deepseek-ai\/dsh-workspace" named "workspace"/u,
  )
  // A missing Registry row is a Host startup failure, not a degraded ready.
  const missingRegistry = baselineRows().filter(candidate => candidate.options.id !== 'workspace')
  assert.throws(
    () => collectHostEntryStatus(hostContext(missingRegistry), { profile: 'pi-tui' }),
    /expected exactly one active workspaceRegistry owner row, found 0/u,
  )
})

test('the Host account controller fails Ready without one exact package row and account binding', () => {
  const id = 'split-host-account-controller'
  const disabled = baselineRows().map(candidate => candidate.options.id === id
    ? { ...candidate, fiber: { state: 0, uid: rowUid(id) } }
    : candidate)
  assert.throws(
    () => collectHostEntryStatus(hostContext(disabled), { profile: 'pi-tui' }),
    /expected exactly one active accountController owner row, found 0/u,
  )
  const absent = baselineRows().filter(candidate => candidate.options.id !== id)
  assert.throws(
    () => collectHostEntryStatus(hostContext(absent), { profile: 'pi-tui' }),
    /expected exactly one active accountController owner row, found 0/u,
  )
  assert.throws(
    () => collectHostEntryStatus(hostContext(baselineRows(), { accountController: {} }), { profile: 'pi-tui' }),
    /accountController.*Typert binding/u,
  )
  assert.throws(
    () => collectHostEntryStatus(
      hostContext(baselineRows(), { accountController: typertService('otherController', 'other') }),
      { profile: 'pi-tui' },
    ),
    /accountController.*Typert binding/u,
  )
  const duplicatePackage = baselineRows().concat({
    options: { id: 'account-controller-copy', name: ACCOUNT_CONTROLLER_PACKAGE },
    fiber: { state: 2, uid: rowUid('account-controller-copy') },
  })
  assert.throws(
    () => collectHostEntryStatus(hostContext(duplicatePackage), { profile: 'pi-tui' }),
    /exactly one active accountController row for.*named "split-host-account-controller"/u,
  )
})

test('the Host status reports the live Loader fiber UID of each row and never invents one', () => {
  const status = collectHostEntryStatus(hostContext(baselineRows()), { profile: 'pi-tui' })
  const byId = new Map(status.entries.map(entry => [entry.id, entry]))
  // Positive: every ACTIVE row carries the UID of the live fiber object.
  for (const { id } of FOUNDATION_ROWS) {
    const entry = byId.get(id)
    assert.ok(entry !== undefined, `${id} must appear in the Host status`)
    assert.equal(entry.state, 'active')
    assert.equal(entry.fiberUid, rowUid(id), `${id} must report its live Loader fiber UID`)
  }
  assert.equal(byId.get('agent')?.fiberUid, rowUid('agent'))
  assert.equal(byId.get('pi-tui-performance-host')?.fiberUid, rowUid('pi-tui-performance-host'))
  // Negative control: a row whose fiber object has no UID reports NO UID. The
  // status must never substitute an index, a sequence number or a cached id.
  const withoutUid = baselineRows().map(candidate => candidate.options.id === 'split-host-session-stats'
    ? { ...candidate, fiber: { state: 2 } }
    : candidate)
  const degraded = collectHostEntryStatus(hostContext(withoutUid), { profile: 'pi-tui' })
  const missing = degraded.entries.find(entry => entry.id === 'split-host-session-stats')
  assert.equal(missing?.state, 'active')
  assert.equal(missing?.fiberUid, undefined,
    'a fiber without a UID must not be given a fabricated one')
  // A row that never started has no fiber at all and therefore no UID.
  assert.equal(degraded.entries.find(entry => entry.id === 'tui-app')?.fiberUid, undefined)
})

test('a duplicated or inactive protected row still fails even with fiber UIDs present', () => {
  const duplicated = baselineRows().concat({
    options: { id: 'split-host-turn-outline', name: 'duplicate' },
    fiber: { state: 2, uid: rowUid('split-host-turn-outline') + 500 },
  })
  assert.throws(
    () => collectHostEntryStatus(hostContext(duplicated), { profile: 'pi-tui' }),
    /expected exactly one active turnOutline owner row/u,
  )
  const inactive = baselineRows().map(candidate => candidate.options.id === 'split-host-settings-controller'
    ? { ...candidate, fiber: { state: 1, uid: rowUid('split-host-settings-controller') } }
    : candidate)
  assert.throws(
    () => collectHostEntryStatus(hostContext(inactive), { profile: 'pi-tui' }),
    /expected exactly one active settingsController owner row/u,
  )
})

test('the Host status reports live terminal-progress subscribers, not a cached flag', () => {
  const watched = hostContext(baselineRows(), {
    piTuiTerminalProgress: {
      ...typertService('piTuiTerminalProgress', PI_TUI_TERMINAL_PROGRESS_NAMESPACE),
      records: new Map([['watched-session', { subscribers: new Set([{}, {}]) }]]),
    },
  })
  assert.equal(
    collectHostEntryStatus(watched, { profile: 'pi-tui' }).terminalProgressWatches,
    2,
    'the status must count the actual subscribers in the Host service',
  )
})

test('a missing foundation row, a missing binding or a duplicate row fails the audit', () => {
  for (const { owner, id } of FOUNDATION_ROWS) {
    const rows = baselineRows().filter(candidate => candidate.options.id !== id)
    assert.throws(
      () => collectHostEntryStatus(hostContext(rows), { profile: 'pi-tui' }),
      new RegExp(`expected exactly one active ${owner} owner row`, 'u'),
      `missing ${id} must fail the audit`,
    )
    // A second active copy of the same row must also fail the exactly-one rule.
    const duplicated = baselineRows().concat({ options: { id, name: 'duplicate' }, fiber: { state: 2 } })
    assert.throws(
      () => collectHostEntryStatus(hostContext(duplicated), { profile: 'pi-tui' }),
      new RegExp(`expected exactly one active ${owner} owner row`, 'u'),
    )
  }

  const missingBindingContext = hostContext(baselineRows(), { sessionController: {} })
  assert.throws(
    () => collectHostEntryStatus(missingBindingContext, { profile: 'pi-tui' }),
    /sessionController.*Typert binding/u,
  )
  const missingReady = hostContext(baselineRows(), { [PI_TUI_HOST_READY_SERVICE]: undefined })
  assert.throws(
    () => collectHostEntryStatus(missingReady, { profile: 'pi-tui' }),
    /piTuiHostReady/u,
  )
})

test('an active forbidden TUI row or an enabled-but-absent one fails the declaration audit', () => {
  const activeTui = baselineRows().map(candidate =>
    candidate.options.id === 'tui-app' ? { ...candidate, options: { ...candidate.options, disabled: false }, fiber: { state: 2 } } : candidate)
  assert.throws(
    () => assertHostOnlyComposition(hostContext(activeTui)),
    /forbidden TUI\/Client-UI rows are active|not disabled/u,
  )
  const enabledButAbsent = baselineRows().map(candidate =>
    candidate.options.id === 'pi-tui-builtins' ? { ...candidate, options: { ...candidate.options, disabled: false } } : candidate)
  assert.throws(
    () => assertHostOnlyComposition(hostContext(enabledButAbsent)),
    /not disabled/u,
  )
})
