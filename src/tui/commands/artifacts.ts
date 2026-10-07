/**
 * Built-in command definitions for the artifact/attachment domain
 * (/copy, /attach (+ /image), /export, /transcript) plus the attachment-intake
 * UX fence (the ONLY production session-transition UX checks).
 *
 * Registration is explicit: the coordinator (src/commands.ts) calls each
 * registrar at its frozen position and owns catalog/provenance/disposal state.
 * @module @xmoon76/dsh-pi-tui/tui/commands/artifacts
 */

import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { TuiApp } from '../../tui-app.ts'
import { isCancellation, runDetached, runOwned } from '../../detached.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import { pruneUnreferencedDraftAttachments } from '../../client/media/draft-attachments.ts'
import { readImageFile } from '../../client/media/image/intake.ts'
import { FileInputError } from '../../domain/media/errors.ts'
import { probeAttachment } from '../../client/media/attachment/intake.ts'
import { parseShellWords } from '../../shell-words.ts'
import type { RegisterOne, RegisterTuiCommand, TuiCommandRunner } from '../../commands.ts'

/** The runner operations the artifact commands consume. */
type ArtifactsCommandRunner = Pick<
  TuiCommandRunner,
  | 'captureSessionScope'
  | 'copyToClipboard'
  | 'currentSessionId'
  | 'cwd'
  | 'diag'
  | 'fileStore'
  | 'imageLimits'
  | 'imageStore'
  | 'insertIntoEditor'
  | 'isSessionScopeCurrent'
  | 'lastAssistantText'
  | 'requireLiveSessionScope'
  | 'sessionTransitionPending'
  | 'signal'
  | 'transcriptExportAvailable'
>

export interface ArtifactsCommandDeps {
  runner: ArtifactsCommandRunner
  app: TuiApp
  registerOne: RegisterOne
  registerTuiCommand: RegisterTuiCommand
  detach: DetachTaskLike
}

/** The coordinator's fire-and-forget seam (see the local `detach`). */
type DetachTaskLike = (
  label: string,
  task: () => unknown | Promise<unknown>,
  options?: { notify?: boolean },
) => void

export interface ArtifactsCommandRegistrars {
  registerCopy(): void
  registerAttach(): void
  registerExport(): void
  registerTranscript(): void
}

/**
 * Create the artifact-command registrars over the coordinator's primitives.
 * The attachment-intake fence is owned here: its three session-transition UX
 * checks and the currentness re-check after the async read are unchanged.
 */
export function createArtifactsCommands(deps: ArtifactsCommandDeps): ArtifactsCommandRegistrars {
  const { runner, app, registerOne, registerTuiCommand, detach } = deps

  const stageAttachmentCommand = (
    invocation: CommandInvocation,
    intent: 'attach' | 'image',
  ): CommandResult => {
    const words = parseShellWords(invocation.rawInput)
    if (words.length !== 1 || words[0] === '') {
      return { kind: 'error', text: `Usage: /${intent} <path>` }
    }
    const raw = words[0]!
    // A sessionless-capable capture taken BEFORE the file IO: it stays current
    // only while the surface still has the same owner/generation — a first
    // Session appearing mid-read (including the publish-before-bump window)
    // makes it stale.
    const intakeScope = runner.captureSessionScope()
    // The command registry supplies the runner-owned lifecycle signal. The
    // fallback keeps direct headless handler calls honest without weakening
    // teardown cancellation in the real dispatch path.
    const intakeSignal = invocation.signal === undefined || invocation.signal === runner.signal
      ? runner.signal
      : AbortSignal.any([runner.signal, invocation.signal])
    const detach = (task: () => unknown): void => {
      runDetached('attachment intake', task, {
        diag: runner.diag,
        sessionId: () => runner.currentSessionId,
        notify: (message) => app.notify(message, 'error'),
        recoverable: () => true,
      })
    }
    detach(() => {
      runOwned('attachment intake', async () => {
        intakeSignal.throwIfAborted()
        if (runner.sessionTransitionPending()) {
          app.notify('a session transition is in progress — try again in a moment', 'error')
          return
        }
        pruneUnreferencedDraftAttachments(app.getDraft(), runner.imageStore, runner.fileStore)
        const stageImage = async (path: string): Promise<void> => {
          intakeSignal.throwIfAborted()
          const resolved = await readImageFile(path, runner.cwd, runner.imageLimits(), runner.imageStore.remainingBytes())
          intakeSignal.throwIfAborted()
          if (!runner.isSessionScopeCurrent(intakeScope)) {
            app.notify(`the session changed while reading the ${intent} — try again`, 'error')
            return
          }
          if (runner.sessionTransitionPending()) {
            app.notify(`a session transition is in progress while reading the ${intent} — try again`, 'error')
            return
          }
          pruneUnreferencedDraftAttachments(app.getDraft(), runner.imageStore, runner.fileStore)
          const draft = runner.imageStore.add({
            bytes: resolved.bytes,
            mediaType: resolved.mediaType,
            width: resolved.width,
            height: resolved.height,
            source: { type: 'path', path: resolved.path },
            name: resolved.name,
          })
          runner.insertIntoEditor(`${draft.placeholder} `)
          app.notify(`attached ${draft.placeholder} — Enter to send`)
        }

        if (intent === 'image') {
          await stageImage(raw)
          return
        }
        const probe = await probeAttachment(raw, runner.cwd, intakeSignal)
        intakeSignal.throwIfAborted()
        if (!runner.isSessionScopeCurrent(intakeScope)) {
          app.notify('the session changed while reading the attachment — try again', 'error')
          return
        }
        if (runner.sessionTransitionPending()) {
          app.notify('a session transition is in progress while reading the attachment — try again', 'error')
          return
        }
        if (probe.kind === 'image') {
          await stageImage(probe.path)
          return
        }
        pruneUnreferencedDraftAttachments(app.getDraft(), runner.imageStore, runner.fileStore)
        const fileStore = runner.fileStore
        if (fileStore === undefined) throw new FileInputError('File draft storage is unavailable.')
        const draft = fileStore.add({
          name: probe.name,
          byteLength: probe.byteLength,
          source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
        })
        runner.insertIntoEditor(`${draft.placeholder} `)
        app.notify(`attached ${draft.placeholder} — Enter to send`)
      }, {
        diag: runner.diag,
        sessionId: () => runner.currentSessionId,
        isCancellation: () => intakeSignal.aborted,
        onError: (error) => {
          app.notify(safeErrorMessage(error), 'error')
        },
      })
    })
    return { kind: 'success' }
  }

  const registerCopy = (): void => {
    registerOne({
      name: 'copy',
      description: 'Copy the last assistant message to the system clipboard (tmux-aware)',
      handler: async () => {
        const scope = await runner.requireLiveSessionScope()
        // The last assistant-message text comes from the exact owner the scope
        // pins (the facade throws on a stale scope, never a stale read).
        const text = await runner.lastAssistantText(scope)
        if (text === undefined) return { kind: 'error', text: 'no assistant message yet' }
        if (text === '') return { kind: 'error', text: 'last assistant message has no text' }
        // Issue #7: the SAME client-local shared user-clipboard policy as the
        // fullscreen drag selection (src/clipboard.ts): an independent
        // terminal-client OSC 52 leg plus an independent native/platform
        // compatibility leg. A helper success never suppresses the OSC 52 leg.
        const ok = await runner.copyToClipboard(text)
        return ok
          ? { kind: 'success', text: 'copied last assistant message' }
          : { kind: 'error', text: 'failed to copy last assistant message' }
      },
    })
  }

  const registerAttach = (): void => {
    registerTuiCommand({
      name: 'attach',
      aliases: ['image'],
      description: 'Attach an image or file to the draft; generic-file delivery requires backend support (tab completes the path)',
      input: { hint: '<path>' },
      handler: (invocation) => stageAttachmentCommand(invocation, 'attach'),
      aliasHandlers: {
        image: (invocation) => stageAttachmentCommand(invocation, 'image'),
      },
      aliasDescriptions: {
        image: 'Attach an image to the draft (image-only compatibility command)',
      },
    })
  }

  const registerExport = (): void => {
    registerOne({
      name: 'export',
      description: 'Export this session as a full archive (ZIP with descendants and attachments)',
      handler: (invocation) => {
        // Pre-Stage-D export convergence: /export accepts NO arguments — the
        // acknowledgement only; the Client-local save workflow starts AFTER
        // the command lifecycle settles (the runner's post-success seam), never
        // inside the handler.
        if (invocation.rawInput.trim() !== '') {
          return { kind: 'error', text: 'The /export command does not accept a path.' }
        }
        return { kind: 'success', text: 'Session log download requested.' }
      },
    })
  }

  const registerTranscript = (): void => {
    registerOne({
      name: 'transcript',
      description: 'Export a readable Markdown transcript of this session when supported',
      handler: (invocation) => {
        // /transcript mirrors /export: no arguments, acknowledgement only; the
        // Client-local save workflow starts after successful command
        // settlement.
        if (invocation.rawInput.trim() !== '') {
          return { kind: 'error', text: 'The /transcript command does not accept a path.' }
        }
        // Truthful-unavailable on the wire backend (the explicit capability,
        // never the M8-retiring Host-mirror field): the Markdown renderer
        // reads the whole Session event history (`snapshotEvents`), for which
        // no transport-neutral seam exists yet — the Remote post-success
        // artifact save would resolve the projected agent and crash inside
        // `renderTranscriptMarkdown` after the command already reported
        // success. The capability is REQUIRED on every assembly, so refusing
        // on `!== true` is the explicit business rule, not an optional
        // compatibility default.
        // `/export` stays available on both backends (it renders from
        // `SessionArchivePort`, not the Session).
        if (runner.transcriptExportAvailable !== true) {
          const text = 'transcript export is unavailable on this backend'
          app.notify(text, 'error')
          return { kind: 'error', text }
        }
        return { kind: 'success', text: 'Transcript export requested.' }
      },
    })
  }

  return { registerCopy, registerAttach, registerExport, registerTranscript }
}
