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
import type { SubmissionComposerPort } from '../../app/submission/composer-port.ts'
import { isCancellation, runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { pruneUnreferencedDraftAttachments } from '../../client/media/draft-attachments.ts'
import { readImageFile } from '../../client/media/image/intake.ts'
import { FileInputError } from '../../domain/media/errors.ts'
import { probeAttachment } from '../../client/media/attachment/intake.ts'
import { parseShellWords } from '../../client/shell/words.ts'
import type { RegisterOne, RegisterTuiCommand, TuiCommandRunner } from '../../commands.ts'
import type { SessionScope } from '../../app/session/scope.ts'
import type {
  InlineAttachmentStager,
  InlineAttachmentStake,
} from '../interaction/autocomplete/inline-attachment.ts'

/** The runner operations the artifact commands consume. */
type ArtifactsCommandRunner = Pick<
  TuiCommandRunner,
  | 'app'
  | 'captureSessionScope'
  | 'copyToClipboard'
  | 'currentSessionId'
  | 'cwd'
  | 'diag'
  | 'fileStore'
  | 'imageLimits'
  | 'imageStore'
  | 'isSessionScopeCurrent'
  | 'lastAssistantText'
  | 'requireLiveSessionScope'
  | 'sessionTransitionPending'
  | 'signal'
  | 'transcriptExportAvailable'
>

export interface ArtifactsCommandDeps {
  runner: ArtifactsCommandRunner
  /** The mounted PiTui app, when there is one: `/view-image` needs it and the
   *  attachment-intake notices keep their PiTui route there. `undefined` on a
   *  non-PiTui renderer, where the live composer owns the intake. */
  app: TuiApp | undefined
  /**
   * Image UX PR3-B: the LIVE draft composer of the mounted renderer. The
   * attachment intake reads the current draft and commits its token here; a
   * non-PiTui renderer has no `TuiApp`, so `app` cannot serve this. Read at
   * call time — never a first captured value.
   */
  composer: () => SubmissionComposerPort | undefined
  registerOne: RegisterOne
  registerTuiCommand: RegisterTuiCommand
  detach: DetachTaskLike
  /**
   * PR4-B2-A: the TSP-only CONFIRMED-SUCCESS notice (a no-op wherever a PiTui
   * command card already presents the outcome). Only `/copy` uses it; the
   * attachment/export/transcript routes are unchanged.
   */
  notifyOutcome: (text: string, kind?: 'info' | 'error') => void
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
  /**
   * Image UX PR5: the INLINE completion route's attachment stager. It runs the
   * SAME read/stage core as the leading command; only the commit (the app's
   * one undoable in-place edit) differs. Handed to the mounted app by the
   * coordinator; a renderer without a composer gets a stager that refuses.
   */
  inlineAttachmentStager(): InlineAttachmentStager
  /** Image UX PR2: the PiTui-only `/view-image` transcript window list. */
  registerViewImage(): void
  registerExport(): void
  registerTranscript(): void
}

/**
 * Create the artifact-command registrars over the coordinator's primitives.
 * The attachment-intake fence is owned here: its three session-transition UX
 * checks and the currentness re-check after the async read are unchanged.
 */
/** One attachment intake COMMIT target: where the staged token goes. The
 *  leading `/image` `/attach` command inserts at the composer cursor; the
 *  inline completion replaces its accepted fragment in place. The intake owns
 *  the read, the budget, the store and the notices either way — only the
 *  commit policy differs. */
export interface AttachmentIntakeCommit {
  /** The draft the caller commits against, read INSIDE the synchronous commit
   *  segment (the command's live draft, or the inline stake's current draft).
   *  Used for the reference prune and the orphan check. */
  draft(): string
  /** Write the staged placeholder. Returns whether the token really reached
   *  the draft — a `false` answer drops ONLY this staged item. */
  commit(placeholder: string): boolean
}

/** Where one attachment intake reports and commits. */
export interface AttachmentIntakeTarget {
  /** Whether the seat that asked for this intake is still the live one. When
   *  it is not, the commit is skipped silently (no notice, no token). */
  seatCurrent(): boolean
  /** The live draft, or undefined when the seat moved away. */
  draft(): string | undefined
  /** The commit target, or undefined once the seat moved away. */
  commit(): AttachmentIntakeCommit | undefined
  /** One transient notice of a REAL outcome (success/failure). Gated by the
   *  full currency (seat AND session owner): a stale success must never be
   *  announced on the replacement owner's surface.
   *  The kind stays OPTIONAL so a route that never passed one keeps the
   *  composer's default (`undefined`) presentation. */
  notify(message: string, kind?: 'info' | 'error'): void
  /** One FENCE explanation (the session moved / a transition is pending while
   *  the read was in flight). Gated by the SEAT only: these exist precisely
   *  BECAUSE the session owner changed, so requiring session currency here
   *  would suppress exactly the explanation the user needs. */
  explain(message: string, kind?: 'info' | 'error'): void
}

/** The shared Client-local attachment intake inputs. */
export interface AttachmentIntakeDeps {
  readonly runner: ArtifactsCommandRunner
  /** `image` requires an image; `attach` accepts an image or a generic file
   *  through the existing admission rules. */
  readonly intent: 'attach' | 'image'
  /** The Client-local path the user chose (already unquoted). */
  readonly path: string
  /** The lifecycle signal (already combined with the invocation's). */
  readonly signal: AbortSignal
  /** The surface's session owner, captured BEFORE the read. */
  readonly scope: SessionScope
  readonly target: AttachmentIntakeTarget
}

/**
 * Read + stage ONE attachment through the shared intake and hand the staged
 * placeholder to the target's commit.
 *
 * Authority: this function owns the Client-local read (`readImageFile` /
 * `probeAttachment`), the image/fingerprint admission, the draft stores and the
 * notices. The CALLER owns the task classification and the commit policy. Every
 * currentness check runs BEFORE a store mutation, and the commit segment is
 * synchronous: the prune, the store add and the write share one currency read.
 *
 * Awaited only (callers own the detached/owned task). A seat that moved away
 * ends the intake without a notice; a real read error propagates to the
 * caller's ordinary failure handling.
 */
export async function runAttachmentIntake(deps: AttachmentIntakeDeps): Promise<void> {
  const { runner, intent, path, signal, scope, target } = deps
  signal.throwIfAborted()
  if (runner.sessionTransitionPending()) {
    // A FENCE explanation, not an outcome: it exists BECAUSE the session owner
    // is (about to be) different, so it is gated by the seat only.
    target.explain('a session transition is in progress — try again in a moment', 'error')
    return
  }
  const initialDraft = target.draft()
  if (initialDraft === undefined) return
  pruneUnreferencedDraftAttachments(initialDraft, runner.imageStore, runner.fileStore)

  /** The post-read fence, shared by both kinds: session owner, transition and
   *  the caller's seat. `kind` only shapes the transition notice wording. */
  const stillCurrent = (): boolean => {
    signal.throwIfAborted()
    if (!runner.isSessionScopeCurrent(scope)) {
      target.explain(`the session changed while reading the ${intent} — try again`, 'error')
      return false
    }
    if (runner.sessionTransitionPending()) {
      target.explain(`a session transition is in progress while reading the ${intent} — try again`, 'error')
      return false
    }
    return target.seatCurrent()
  }

  /** The ONE commit segment (synchronous): prune, add, write, notice. */
  const commitStaged = (
    add: () => { readonly id: number; readonly placeholder: string },
    remove: (id: number) => void,
  ): void => {
    const commit = target.commit()
    if (commit === undefined) return
    pruneUnreferencedDraftAttachments(commit.draft(), runner.imageStore, runner.fileStore)
    const staged = add()
    try {
      if (!commit.commit(staged.placeholder)) remove(staged.id)
    } catch (error) {
      // Only an item whose token never reached the draft is dropped; a visible
      // placeholder keeps its bytes and keeps the owned task's classification.
      if (!commit.draft().includes(staged.placeholder)) remove(staged.id)
      throw error
    }
    target.notify(`attached ${staged.placeholder} — Enter to send`)
  }

  /** Read one path as an IMAGE (both intents use this for an image). */
  const stageImage = async (imagePath: string): Promise<void> => {
    const resolved = await readImageFile(imagePath, runner.cwd, runner.imageLimits(), runner.imageStore.remainingBytes())
    if (!stillCurrent()) return
    commitStaged(
      () => runner.imageStore.add({
        bytes: resolved.bytes,
        mediaType: resolved.mediaType,
        width: resolved.width,
        height: resolved.height,
        source: { type: 'path', path: resolved.path },
        name: resolved.name,
      }),
      id => runner.imageStore.remove(id),
    )
  }

  if (intent === 'image') {
    // An image-only command never probes: it reads as an image and reports the
    // image-admission error when the path is not one.
    await stageImage(path)
    return
  }

  const probe = await probeAttachment(path, runner.cwd, signal)
  if (!stillCurrent()) return
  if (probe.kind === 'image') {
    await stageImage(probe.path)
    return
  }
  const fileStore = runner.fileStore
  if (fileStore === undefined) throw new FileInputError('File draft storage is unavailable.')
  commitStaged(
    () => fileStore.add({
      name: probe.name,
      byteLength: probe.byteLength,
      source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
    }),
    id => fileStore.remove(id),
  )
}

export function createArtifactsCommands(deps: ArtifactsCommandDeps): ArtifactsCommandRegistrars {
  const { runner, app, composer: composerGetter, registerOne, registerTuiCommand, detach, notifyOutcome } = deps

  /** The LEADING command route (`/image <path>` at line start): unchanged UX.
   *  The read/stage core is the shared {@link runAttachmentIntake}; only this
   *  route's commit policy (insert at the composer cursor) and its own fences
   *  (composer seat currency, usage errors) live here. */
  const stageAttachmentCommand = (
    invocation: CommandInvocation,
    intent: 'attach' | 'image',
  ): CommandResult => {
    const words = parseShellWords(invocation.rawInput)
    if (words.length !== 1 || words[0] === '') {
      return { kind: 'error', text: `Usage: /${intent} <path>` }
    }
    const path = words[0]!
    // Image UX PR3-B1: the intake commits into the composer that is mounted
    // NOW. Without one there is no draft seat to write, so the command refuses
    // SYNCHRONOUSLY — before any file read, store mutation or success.
    const composer = composerGetter()
    if (composer === undefined) {
      return { kind: 'error', text: 'the draft composer is unavailable on this renderer' }
    }
    // The composer-seat fence runs BESIDE the session-scope and transition
    // gates: a replaced seat must never receive this intake's token or notice,
    // even when the session itself did not move.
    const seatCurrent = (): boolean => composerGetter() === composer
    const outcomeCurrent = (): boolean => seatCurrent() && runner.isSessionScopeCurrent(scope)
    // A sessionless-capable capture taken BEFORE the file IO: it stays current
    // only while the surface still has the same owner/generation — a first
    // Session appearing mid-read (including the publish-before-bump window)
    // makes it stale.
    const scope = runner.captureSessionScope()
    // The command registry supplies the runner-owned lifecycle signal. The
    // fallback keeps direct headless handler calls honest without weakening
    // teardown cancellation in the real dispatch path.
    const signal = invocation.signal === undefined || invocation.signal === runner.signal
      ? runner.signal
      : AbortSignal.any([runner.signal, invocation.signal])
    detach('attachment intake', () => {
      runOwned('attachment intake', async () => {
        await runAttachmentIntake({
          runner,
          intent,
          path,
          signal,
          scope,
          target: {
            seatCurrent: () => {
              if (seatCurrent()) return true
              // A replaced seat keeps the legacy silence: the old composer was
              // already replaced, so there is nobody to explain it to.
              return false
            },
            draft: () => seatCurrent() ? composer.getDraft() : undefined,
            commit: () => seatCurrent()
              ? {
                  draft: () => composer.getDraft(),
                  commit: (placeholder) => {
                    composer.insertIntoEditor(`${placeholder} `)
                    return true
                  },
                }
              : undefined,
            notify: (message, kind) => {
              if (!outcomeCurrent()) return
              composer.notify(message, kind)
            },
            explain: (message, kind) => {
              if (!seatCurrent()) return
              composer.notify(message, kind)
            },
          },
        })
      }, {
        diag: runner.diag,
        sessionId: () => runner.currentSessionId,
        isCancellation: () => signal.aborted,
        onError: (error) => {
          if (!outcomeCurrent()) return
          composer.notify(safeErrorMessage(error), 'error')
        },
      })
    }, { notify: true })
    return { kind: 'success' }
  }

  /**
   * The INLINE completion route (Image UX PR5): the SAME Client-local intake,
   * committed through the stake's own in-place undoable edit instead of the
   * composer's cursor insert. The stake is supplied by the mounted app, which
   * owns the editor, the undoable edit and the seat fence; this plane owns the
   * read, the stores, the session fence and the notices.
   *
   * Nothing is read until the app has proven the accepted document and cursor
   * are still live; every post-read fence is the shared intake's.
   */
  const inlineAttachmentStager = (): InlineAttachmentStager => (stake: InlineAttachmentStake): void => {
    const scope = runner.captureSessionScope()
    /** The intake may act only while the stake's seat is still the live one
     *  AND the session owner did not move. */
    const stillOwned = (): boolean => stake.current() && runner.isSessionScopeCurrent(scope)
    detach('attachment intake', () => {
      runOwned('attachment intake', async () => {
        await runAttachmentIntake({
          runner,
          intent: stake.command === 'image' ? 'image' : 'attach',
          path: stake.path,
          signal: runner.signal,
          scope,
          target: {
            seatCurrent: () => stillOwned(),
            draft: () => stillOwned() ? stake.draft() : undefined,
            commit: () => stillOwned()
              ? {
                  // The fragment is re-proven inside the synchronous commit
                  // segment (the shared intake reads this immediately before
                  // the store add); the app's own commit re-checks it too and
                  // refuses rather than editing a newer draft.
                  draft: () => stake.draft() ?? '',
                  commit: (placeholder) => {
                    if (!stillOwned() || !stake.current()) return false
                    return stake.commit(placeholder)
                  },
                }
              : undefined,
            notify: (message, kind) => {
              if (!stillOwned()) return
              stake.notify(message, kind)
            },
            explain: (message, kind) => {
              if (!stake.current()) return
              stake.notify(message, kind)
            },
          },
        })
      }, {
        diag: runner.diag,
        sessionId: () => runner.currentSessionId,
        isCancellation: () => runner.signal.aborted,
        onError: (error) => {
          if (!stillOwned()) return
          stake.notify(safeErrorMessage(error), 'error')
        },
      })
    }, { notify: true })
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
        // fullscreen drag selection (src/client/clipboard/copy.ts): an independent
        // terminal-client OSC 52 leg plus an independent native/platform
        // compatibility leg. A helper success never suppresses the OSC 52 leg.
        const ok = await runner.copyToClipboard(text)
        if (!ok) return { kind: 'error', text: 'failed to copy last assistant message' }
        // PR4-B2-A: the CONFIRMED success is supplemented through the
        // renderer-neutral outcome notice, so a renderer without a PiTui
        // command card still reports it. The text states only what the policy
        // established (accepted/emitted), never that the OS clipboard was
        // verified; the failure branches keep their existing owner (the Direct
        // command card) and add no second Dock line.
        // F5: the clipboard policy can outlive the Session it was pinned to (a
        // native helper awaits across a /resume commit), so a late success is
        // never announced on the replacement owner's surface.
        if (runner.isSessionScopeCurrent(scope) && !runner.signal.aborted) {
          notifyOutcome('copied last assistant message')
        }
        return { kind: 'success', text: 'copied last assistant message' }
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

  const registerViewImage = (): void => {
    registerTuiCommand({
      name: 'view-image',
      description: 'View images in the current transcript window',
      handler: (invocation) => {
        // No arguments: the list is always the CURRENT mounted window.
        if (invocation.rawInput.trim() !== '') {
          return { kind: 'error', text: 'The /view-image command does not accept arguments.' }
        }
        // Registered only where a PiTui surface is mounted (see
        // registerTuiCommands); this guard keeps a direct headless handler
        // call honest instead of silently doing nothing.
        const mountedApp = runner.app
        if (mountedApp === undefined) {
          return { kind: 'error', text: 'the image viewer is unavailable on this renderer' }
        }
        mountedApp.openTranscriptImagePicker()
        return { kind: 'success' }
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
          // Unchanged PiTui route: with a PiTui app mounted this is the
          // long-standing inline notice beside the command card. A renderer
          // without one refuses `/transcript` in the admission gate before this
          // handler runs, so its returned error text keeps its own owner there.
          app?.notify(text, 'error')
          return { kind: 'error', text }
        }
        return { kind: 'success', text: 'Transcript export requested.' }
      },
    })
  }

  return {
    registerCopy,
    registerAttach,
    inlineAttachmentStager,
    registerViewImage,
    registerExport,
    registerTranscript,
  }
}
