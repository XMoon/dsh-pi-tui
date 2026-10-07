/**
 * ArtifactSaveOwner (A5b-3, plan §A5b-3): the ONE owner of the client-local
 * artifact save workflow (`/export` session archive + `/transcript` readable
 * Markdown), including the in-flight dedupe set and the save-location dialog.
 *
 * The module is deliberately neutral: the exact Agent type is a generic
 * parameter, and the mounted app, the runner lifetime signal, the semantic
 * session-archive port and the resolved CLIENT directory arrive as narrow
 * injected capabilities.
 * @module @xmoon76/dsh-pi-tui/app/command/artifacts
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isDirectoryPath, resolveClientDirectory, streamToFile, writeTextAtomically } from '../../client/artifact/save.ts'
import { ClientLocalDiscoveryDriver, clientPathQueryEnvironment } from '../../client/file-completion/local-discovery.ts'
import { completeDirectory } from '../../client/file-completion/directory-completion.ts'
import { isCancellation, runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { SessionArchivePort } from '../../runtime/session-archive-port.ts'
import type { SaveLocationResult, TuiApp } from '../../tui-app.ts'
import { sessionArtifactFilename } from '../../session-artifact-filename.ts'
import { renderTranscriptMarkdown } from '../../client/artifact/transcript-markdown.ts'


/** One artifact save workflow outcome. */
export type ArtifactSaveOutcome =
  | { readonly kind: 'saved'; readonly path: string }
  | { readonly kind: 'cancelled' }

/** The narrow capabilities the artifact-save owner consumes. */
export interface ArtifactSaveDeps<ExactAgent> {
  /** The mounted app (save-location dialog + notifications), read live. */
  readonly app: () => TuiApp
  /** True once the runner is disposing. */
  readonly isCleanedUp: () => boolean
  /** The runner lifetime signal (the save is cancelled with it). */
  readonly signal: AbortSignal
  /** The runner diagnostic sink (the save is owned work). */
  readonly diag: Diag
  /** The semantic session-archive port (the /export read). */
  readonly sessionArchive: SessionArchivePort
  /** The resolved CLIENT working directory (the default save location). */
  readonly clientCwd: string
}

/** The artifact-save owner as the rest of the application consumes it. */
export interface ArtifactSaveOwner<ExactAgent> {
  /** Save the session archive or the readable transcript for one Agent. */
  save(name: 'export' | 'transcript', agent: ExactAgent): Promise<ArtifactSaveOutcome>
  /** Start one save, deduping concurrent saves of the same session. */
  start(name: 'export' | 'transcript', agent: ExactAgent): void
}

/** Create the artifact-save owner (plan §A5b-3). */
export function createArtifactSaveOwner<
  ExactAgent extends { readonly session: Parameters<typeof renderTranscriptMarkdown>[0] & { readonly id: string } },
>(
  deps: ArtifactSaveDeps<ExactAgent>,
): ArtifactSaveOwner<ExactAgent> {
  // ── Pre-Stage-D export convergence: the post-command-success artifact
  // save workflows. The save NEVER starts inside the command handler —
  // it starts here, after `commands.execute()` resolved (command/done
  // durable), from the CAPTURED originating Agent/Session identity (never
  // a later `liveAgent` read). The Client-local Save Location prompt, the
  // fixed filename, the collision handling and the local sink are shared
  // by /export (archive) and /transcript (Markdown).
  
  const artifactInFlight = new Set<string>()

  /** A user-facing artifact failure with a STABLE message (never a raw
   * Host path from an upstream exception). */
  
  class ArtifactSaveFailure extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'ArtifactSaveFailure'
    }
  }

  /** The Client-local directory completion driver (the Client's own fs). */
  
  const clientDiscovery = new ClientLocalDiscoveryDriver()

  const saveArtifact = async (
    name: 'export' | 'transcript',
    agent: ExactAgent,
  ): Promise<ArtifactSaveOutcome> => {
    const sessionId = agent.session.id
    const filename = sessionArtifactFilename(sessionId, name === 'export' ? 'archive' : 'transcript')
    let result: SaveLocationResult
    try {
      result = await deps.app().askSaveLocation({
        title: name === 'export' ? 'Save session archive' : 'Save readable transcript',
        filename,
        initialDirectory: './',
      }, {
        // Save Location is CLIENT-local filesystem UI: resolution, validation
        // and completion all run against the Client process cwd — never the
        // Host/session cwd, and never a Host call.
        resolveDirectory: (input) => resolveClientDirectory(input, deps.clientCwd),
        isDirectory: (path) => isDirectoryPath(path),
        targetExists: (directory, filename) => {
          try {
            // lstatSync: a dangling symlink is a real directory entry and
            // must surface the collision confirmation too (the sink's
            // commit guard uses the same non-following check).
            lstatSync(join(directory, filename))
            return true
          } catch {
            return false
          }
        },
        complete: (raw, completionSignal) => completeDirectory(
          raw,
          deps.clientCwd,
          clientDiscovery,
          clientPathQueryEnvironment(),
          completionSignal,
        ),
      }, deps.signal)
    } catch (error) {
      // A REFUSAL (a duplicate prompt, or an active Host question/approval)
      // is a real user-visible failure — never a silent cancellation: the
      // runOwned onCancel path emits no notice, so a second concurrent
      // artifact save would silently disappear. The signal-abort path stays
      // a cancellation (the task-local predicate classifies it).
      if (isCancellation(error) && !deps.signal.aborted) {
        throw new ArtifactSaveFailure(safeErrorMessage(error))
      }
      throw error
    }
    if (deps.isCleanedUp()) return { kind: 'cancelled' }
    if (result.kind === 'cancelled') return { kind: 'cancelled' }
    const target = join(result.directory, filename)
    if (name === 'export') {
      const opened = await deps.sessionArchive.open(sessionId, deps.signal)
      if (deps.isCleanedUp()) return { kind: 'cancelled' }
      if (opened.kind === 'unavailable') throw new ArtifactSaveFailure('Session archive export is unavailable.')
      if (opened.kind === 'none') throw new ArtifactSaveFailure('Session was not found.')
      const path = await streamToFile(target, opened.artifact.stream, deps.signal, result.overwrite)
      if (deps.isCleanedUp()) return { kind: 'cancelled' }
      return { kind: 'saved', path }
    }
    // /transcript: render from the CAPTURED originating Session after the
    // command lifecycle settled — never `liveAgent` at delayed settle time.
    if (deps.isCleanedUp()) return { kind: 'cancelled' }
    const markdown = renderTranscriptMarkdown(agent.session)
    const path = await writeTextAtomically(target, markdown, deps.signal, result.overwrite)
    if (deps.isCleanedUp()) return { kind: 'cancelled' }
    return { kind: 'saved', path }
  }

  const startArtifactSave = (name: 'export' | 'transcript', agent: ExactAgent): void => {
    if (deps.isCleanedUp()) return
    const sessionId = agent.session.id
    const key = `${name}:${sessionId}`
    // A narrow Client-local in-flight key: two simultaneous writes for the
    // same logical artifact/session must never race the fixed filename.
    if (artifactInFlight.has(key)) {
      deps.app().notify('this artifact is already being saved', 'error')
      return
    }
    artifactInFlight.add(key)
    runOwned(`artifact save: ${name}`, () => saveArtifact(name, agent).finally(() => {
      artifactInFlight.delete(key)
    }), {
      diag: deps.diag,
      sessionId: () => sessionId,
      isCancellation: () => deps.signal.aborted,
      onResult: (outcome) => {
        if (deps.isCleanedUp()) return
        if (outcome.kind === 'saved') deps.app().notify(`saved to ${outcome.path}`, 'info')
      },
      onError: (error) => {
        if (deps.isCleanedUp()) return
        // The detailed diagnostic (including any Host path inside an
        // upstream exception) stays in the runOwned diag path; the user
        // sees a stable artifact-level message.
        const message = error instanceof ArtifactSaveFailure
          ? error.message
          : (name === 'export' ? 'session archive export failed' : 'transcript export failed')
        deps.app().notify(message, 'error')
      },
      onCancel: () => {
        // A cancelled save (surface dispose / runner abort) needs no
        // user notice; the temp cleanup is owned by the sink.
      },
    })
  }


  return {
    save: (name, agent) => saveArtifact(name, agent),
    start: (name, agent) => startArtifactSave(name, agent),
  }
}
