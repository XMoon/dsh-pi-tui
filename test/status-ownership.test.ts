/**
 * M3-4 PR4 §6.4 status-ownership regression lock: the legacy `setStatus`
 * writer is a PARTIAL compatibility writer. It owns the `permissionPreset`
 * field ONLY while a legacy Direct service value exists; an absent legacy
 * value expresses NO opinion and never clears a projection-owned preset.
 * Clearing a retired subject's sections is the SESSION LIFECYCLE owner's
 * job (the surface's explicit `resetSubjectStatus` on a generation bump),
 * never the legacy writer's.
 *
 * Cases (the review's required evidence):
 * 1. a semantic preset + an unrelated legacy refresh → the preset survives;
 * 2. an absent legacy permission → NO permission field mutation;
 * 3. the lifecycle reset is the explicit clear (the real surface owner);
 * 4. a legacy value still projects when a Direct composition supplies one;
 * 5. the generation-bump wiring: the composition's reset hook retires the
 *    subject sections (a switch cannot leak the old preset into the new
 *    subject while its projection is pending).
 *
 * @module @xmoon76/dsh-pi-tui/status-ownership.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { StatusStore } from '../src/domain/status/store.ts'
import { createSurfaceRuntime } from '../src/app/surface/runtime.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import type { AccessStatus } from '../src/domain/status/types.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** A mounted app over a caller-owned store (the production shape). */
function mountedStore(): { app: TuiApp; store: StatusStore; dispose: () => void } {
  const store = new StatusStore()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { statusStore: store })
  app.start()
  return {
    app,
    store,
    dispose: () => { if (!app.isDisposed()) app.dispose() },
  }
}

/** The null terminal notification presentation (the terminal sequences are
 *  asserted by the notification suites; these fixtures exercise the surface
 *  aggregate without a real terminal). */
const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

/** The real surface owner over a null notification sink (cheap, no mount). */
function surfaceOwner() {
  return createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    createPluginManagerPanel,
  })
}

const access = (store: StatusStore): AccessStatus => store.snapshot().access

test('§6.4 (1) an unrelated legacy refresh never clears the projection-owned preset', () => {
  const { app, store, dispose } = mountedStore()
  try {
    // The semantic owner commits the projection value (the status-runtime path).
    store.update({ access: { permissionPreset: { id: 'workspace-write', label: 'workspace-write', matched: true } } })
    assert.equal(access(store).permissionPreset?.id, 'workspace-write')

    // An unrelated legacy refresh (workspace/usage only, no legacy permission).
    app.setStatus({ model: 'm', cwd: '/tmp/legacy-refresh', branch: '', turns: 3, steps: 7, statsLine: '' })

    assert.equal(access(store).permissionPreset?.id, 'workspace-write',
      'the legacy writer expressed no opinion on permissionPreset — the projection value survives')
    assert.equal(store.snapshot().workspace.cwd, '/tmp/legacy-refresh',
      'the legacy-owned sections did update')
  } finally {
    dispose()
  }
})

test('§6.4 (2) an absent legacy permission produces NO permission field mutation', () => {
  const { app, store, dispose } = mountedStore()
  try {
    const before = access(store)
    // No legacy permission is supplied at all.
    app.setStatus({ model: 'm', cwd: '/tmp/no-perm', branch: '', turns: 0, steps: 0, statsLine: '' })
    const after = access(store)
    assert.equal('permissionPreset' in after, 'permissionPreset' in before,
      'the key is neither added nor removed by a legacy refresh without a legacy value')
  } finally {
    dispose()
  }
})

test('§6.4 (3) the real surface owner reset is the explicit clear', () => {
  const surface = surfaceOwner()
  try {
    surface.status.update({
      access: {
        permissionPreset: { id: 'read-only', label: 'read-only', matched: true },
        approval: { policy: 'never' },
      },
      composition: { model: { provider: 'p', id: 'm', displayName: 'm' } },
    })
    assert.equal(access(surface.status).permissionPreset?.id, 'read-only')

    // The session-lifecycle owner's explicit reset (a generation bump).
    surface.resetSubjectStatus()

    assert.equal(access(surface.status).permissionPreset, undefined,
      'the subject reset retires the permission preset')
    assert.equal(access(surface.status).approval, undefined,
      'the subject reset retires the independent approval fact too')
    assert.deepEqual(surface.status.snapshot().composition, {},
      'the subject reset retires the composition section')
  } finally {
    surface.dispose()
  }
})

test('§6.4 (4) a legacy value still projects when a Direct composition supplies one', () => {
  const { app, store, dispose } = mountedStore()
  try {
    app.setStatus({ model: 'm', cwd: '/tmp/direct', branch: '', turns: 0, steps: 0, statsLine: '', permission: 'danger-full-access' })
    assert.equal(access(store).permissionPreset?.id, 'danger-full-access',
      'a PRESENT legacy value projects (the Direct compatibility path)')
    assert.equal(access(store).permissionPreset?.matched, true)
  } finally {
    dispose()
  }
})

test('§6.4 (5) the generation-bump wiring retires the subject sections', () => {
  // The composition's ownership-core reset hook is the ONLY caller: it must
  // invoke the surface's explicit subject reset (a switch cannot leak the
  // old preset while the new subject's projection is pending).
  const bootstrap = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  const hook = bootstrap.slice(
    bootstrap.indexOf('const ownership = createSessionOwnershipCore({'),
    bootstrap.indexOf('const sessionScope = createSessionScopeAuthority({'),
  )
  assert.ok(hook.includes('presentation.resetForGeneration()'),
    'the generation reset still retires the presentation state')
  assert.ok(hook.includes('surface.resetSubjectStatus()'),
    'the generation reset must retire the subject-owned status sections')

  // And the surface member really clears them (behaviour above), so a switch
  // cannot carry the retired subject's preset into the new one.
  const surfaceSource = readFileSync(new URL('../src/app/surface/runtime.ts', import.meta.url), 'utf8')
  const reset = surfaceSource.slice(
    surfaceSource.indexOf('const resetSubjectStatus = (): void => {'),
    surfaceSource.indexOf('const resetSearchPresentation = ('),
  )
  assert.match(reset, /access: \{\}/, 'the reset clears access')
  assert.match(reset, /composition: \{\}/, 'the reset clears composition')
})
