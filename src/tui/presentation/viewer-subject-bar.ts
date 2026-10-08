/**
 * The child-viewer SUBJECT BAR (viewer UX plan §4.1): the ONE built-in
 * display of the viewed child's identity — navigation affordance, child
 * label, live run activity, its real provider/model identity and (when the
 * child exposes one) its own session title.
 *
 * It is a PURE projection of the committed StatusSnapshot: the subject
 * identity/activity read `snapshot.view.subject`, the model identity reads
 * `snapshot.composition.model`. It never reads the parent session, the
 * global model picker or the viewer access classification — an absent child
 * fact renders as unknown (`model ?`), never as the parent's value.
 *
 * The bar is deliberately NOT a footer item and NOT a transcript item: it
 * is a fixed header-adjacent chrome row owned by TuiApp (see
 * `renderViewerSubjectBar` method on TuiApp, the pinned layout entry and the
 * fullscreen paint snapshot).
 * @module @xmoon76/dsh-pi-tui/tui/presentation/viewer-subject-bar
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { StatusSnapshot } from '../../domain/status/types.ts'
import { sanitizedPhysicalLine } from './lines.ts'
import { color } from '../theme/runtime.ts'

/** The navigation affordance: Esc returns to the main session (even when the
 *  displayed child is nested — the viewer never navigates to the direct
 *  parent), so the label is `back`, not `parent`. */
const NAVIGATION_FULL = '‹ back'
/** The narrow fallback of the navigation affordance. */
const NAVIGATION_SHORT = '‹'
/** The minimum cells a trimmed child label keeps (when the width allows). */
const LABEL_MIN_CELLS = 6
/** The separator between the navigation affordance and the child identity. */
const LEFT_SEPARATOR = '  '
/** The separator between the activity marker and the model identity. */
const RIGHT_SEPARATOR = '   '
/** The minimum gap between the left (identity) and right (status) groups. */
const GROUP_GAP_MIN_CELLS = 2
/** The explicit unknown-model stand-in — never the parent's model. */
const UNKNOWN_MODEL = 'model ?'

/**
 * Render the viewer subject bar.
 *
 * @param input.snapshot - the committed status snapshot (the ONLY state read).
 * @param input.childTitle - the committed child display-projection title; the
 *   CALLER must only pass it when it belongs to the same child subject
 *   (`displaySubjectPresentation.sessionId === view.subject.id`). A title
 *   equal to the label is not repeated.
 * @param input.width - the terminal width in cells.
 * @returns the single-line bar, or `''` on the main subject (zero rows).
 */
export function renderViewerSubjectBar(input: {
  snapshot: StatusSnapshot
  childTitle?: string
  width: number
}): string {
  const subject = input.snapshot.view.subject
  if (subject.kind !== 'subagent') return ''
  const width = Number.isFinite(input.width) ? Math.max(1, Math.floor(input.width)) : 1
  // Every rendered text field is a Host projection string (external data):
  // normalize each to ONE display line before measuring. The single-physical-
  // line contract must hold for any label/title/model a projection carries.
  const labelText = subject.label === undefined ? '' : sanitizedPhysicalLine(subject.label)
  const label = labelText === '' ? undefined : labelText
  const titleText = input.childTitle === undefined ? '' : sanitizedPhysicalLine(input.childTitle)
  const title = titleText === '' || titleText === label ? undefined : titleText

  const navigation = {
    full: color.textMuted(NAVIGATION_FULL),
    short: color.textMuted(NAVIGATION_SHORT),
  }
  const activity = subject.activity === 'running'
    ? { full: color.primary('● running'), short: color.primary('●') }
    : subject.activity === 'inactive'
      ? { full: color.textMuted('○ inactive'), short: color.textMuted('○') }
      : undefined
  const model = input.snapshot.composition.model
  const modelVariants = modelVariantsOf(model)
  const paintModel = (text: string): string => model === undefined ? color.textMuted(text) : color.accent(text)

  // The fixed degradation ladder (viewer UX plan §2.3): hide the optional
  // title first, then trim the label, then collapse the activity words, then
  // the `back` word, then drop `@effort`, then fall back from
  // `provider/model` to the model id and finally ellipsize the id. The LAST
  // ladder entry truncates the model id so it can still fit an extreme width.
  const ladder: ReadonlyArray<{
    title: boolean
    activityFull: boolean
    navigationFull: boolean
    modelStage: number
    trimLabel: boolean
    trimModel: boolean
  }> = [
    { title: true, activityFull: true, navigationFull: true, modelStage: 0, trimLabel: false, trimModel: false },
    { title: false, activityFull: true, navigationFull: true, modelStage: 0, trimLabel: false, trimModel: false },
    { title: false, activityFull: true, navigationFull: true, modelStage: 0, trimLabel: true, trimModel: false },
    { title: false, activityFull: false, navigationFull: true, modelStage: 0, trimLabel: true, trimModel: false },
    { title: false, activityFull: false, navigationFull: false, modelStage: 0, trimLabel: true, trimModel: false },
    { title: false, activityFull: false, navigationFull: false, modelStage: 1, trimLabel: true, trimModel: false },
    { title: false, activityFull: false, navigationFull: false, modelStage: 2, trimLabel: true, trimModel: false },
    { title: false, activityFull: false, navigationFull: false, modelStage: 2, trimLabel: true, trimModel: true },
  ]

  for (const step of ladder) {
    const identity = identityOf(label, step.title ? title : undefined)
    const statusText = activity === undefined ? '' : (step.activityFull ? activity.full : activity.short)
    const modelText = paintModel(modelVariants[Math.min(step.modelStage, modelVariants.length - 1)]!)
    const line = composeCandidate({
      navigationText: step.navigationFull ? navigation.full : navigation.short,
      identity,
      statusText,
      modelText,
      width,
      trimLabel: step.trimLabel,
      trimModel: step.trimModel,
    })
    if (line !== undefined) return line
  }
  // Ultimate safety for a width that cannot hold the terse ladder entry at
  // all: cell-safe truncation of the plain terse composition (never a wrap).
  const terse = [
    navigation.short,
    ...label === undefined ? [] : [label],
    ...activity === undefined ? [] : [activity.short],
    paintModel(modelVariants[modelVariants.length - 1]!),
  ].join(' ')
  return truncateToWidth(terse, width, '…')
}

/** The child identity text: label plus the optional title description. */
function identityOf(label: string | undefined, title: string | undefined): string | undefined {
  if (label !== undefined && title !== undefined) return `${label} · ${title}`
  if (label !== undefined) return label
  return title
}

/** The model identity variants from most to least verbose (dedup-preserving):
 * `provider/model @effort` → `provider/model` → `model`. A missing provider
 * never fabricates one; a missing model yields the explicit unknown token. */
function modelVariantsOf(model: StatusSnapshot['composition']['model']): string[] {
  if (model === undefined) return [UNKNOWN_MODEL]
  const provider = model.provider === undefined ? undefined : sanitizedPhysicalLine(model.provider)
  const effort = model.reasoningEffort === undefined ? undefined : sanitizedPhysicalLine(model.reasoningEffort)
  const id = sanitizedPhysicalLine(model.id)
  const variants: string[] = []
  if (provider !== undefined && provider !== '') {
    variants.push(`${provider}/${id}${effort === undefined ? '' : ` @${effort}`}`)
    variants.push(`${provider}/${id}`)
  } else if (effort !== undefined) {
    variants.push(`${id} @${effort}`)
  }
  variants.push(id)
  return [...new Set(variants)]
}

/** Compose one candidate line and return it only when it fits `width`
 *  (right-aligned); the flexible label/model may be trimmed per the ladder
 *  step. Returns `undefined` when the step cannot fit. */
function composeCandidate(input: {
  navigationText: string
  identity: string | undefined
  statusText: string
  modelText: string
  width: number
  trimLabel: boolean
  trimModel: boolean
}): string | undefined {
  const { navigationText, statusText, width } = input
  let identity = input.identity
  let modelText = input.modelText
  const leftSeparatorWidth = identity === undefined ? 0 : visibleWidth(LEFT_SEPARATOR)
  const rightSeparatorWidth = statusText === '' ? 0 : visibleWidth(RIGHT_SEPARATOR)
  // The fixed cells: the navigation entry, the identity separator, the status
  // group and the minimum inter-group gap. The identity + model share the rest.
  const fixedWidth = visibleWidth(navigationText)
    + leftSeparatorWidth
    + visibleWidth(statusText)
    + rightSeparatorWidth
    + GROUP_GAP_MIN_CELLS
  const flexWidth = width - fixedWidth
  if (flexWidth < 1) return undefined
  let identityWidth = identity === undefined ? 0 : visibleWidth(identity)
  let modelWidth = visibleWidth(modelText)
  if (identityWidth + modelWidth > flexWidth) {
    if (input.trimModel) {
      // The LAST ladder step: the label has already been reduced as far as the
      // earlier steps allowed, so it drops to its identifiability floor FIRST
      // and the model then lives on the remaining budget. Trimming the model
      // against the un-trimmed label would ellipsize the model to nothing while
      // a needlessly long label survived (the model is the last thing to lose
      // its identity, plan §2.3).
      if (identity !== undefined) {
        const floor = Math.min(LABEL_MIN_CELLS, identityWidth)
        if (identityWidth > floor) {
          identity = truncateToWidth(identity, floor, '…')
          identityWidth = visibleWidth(identity)
        }
      }
      const modelRoom = flexWidth - identityWidth
      if (modelRoom < 1) return undefined
      if (modelWidth > modelRoom) {
        modelText = truncateToWidth(modelText, modelRoom, '…')
        modelWidth = visibleWidth(modelText)
      }
    } else {
      let overflow = identityWidth + modelWidth - flexWidth
      // The label is trimmed only after the title was already dropped, and
      // never below the minimum identifiability floor (the step then fails
      // instead, so the NEXT step can spend the budget differently).
      if (overflow > 0 && input.trimLabel && identity !== undefined) {
        const floor = Math.min(LABEL_MIN_CELLS, identityWidth)
        const target = Math.max(1, identityWidth - overflow)
        if (target < floor) return undefined
        identity = truncateToWidth(identity, target, '…')
        overflow -= identityWidth - visibleWidth(identity)
        identityWidth = visibleWidth(identity)
      }
    }
    if (identityWidth + modelWidth > flexWidth) return undefined
  }
  const leftText = identity === undefined
    ? navigationText
    : `${navigationText}${LEFT_SEPARATOR}${identity}`
  const leftWidth = visibleWidth(leftText)
  const rightText = statusText === '' ? modelText : `${statusText}${RIGHT_SEPARATOR}${modelText}`
  const rightWidth = visibleWidth(rightText)
  if (leftWidth + rightWidth + GROUP_GAP_MIN_CELLS > width) return undefined
  return `${leftText}${' '.repeat(width - leftWidth - rightWidth)}${rightText}`
}
