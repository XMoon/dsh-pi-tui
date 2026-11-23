/**
 * The ONE pure ACP v1 Form projection of an official `user-questions/request`.
 *
 * The Host `userQuestions` waterfall stays the business authority: this module
 * only turns the official `AskUserQuestionItem` batch into a standard ACP v1
 * `elicitation/create` `form` schema and turns the client's response back into
 * the official answer batch. It keeps no answer state, no policy and no client
 * identity: every schema key it mints (`q0`, `q1`, …) belongs to exactly ONE
 * request, and the original DSH question id is restored from that request's own
 * bindings — a wire key is never mistaken for an official id.
 *
 * Only the standard `mode: 'form'` shape is produced: DSH native questions have
 * no URL request, so there is no URL mode, no client-specific `_meta` and no
 * permission/approval semantics. `decline`/`cancel` are returned as such and
 * never become an empty "skipped" answer.
 *
 * @module app/remote-process/local-acp-question-form
 */

import type { ElicitationPropertySchema, ElicitationSchema } from '@agentclientprotocol/sdk'

/** The official human-readable prompt of one question Form. */
export const ACP_QUESTION_FORM_MESSAGE = "Answer the agent's questions"

/** One selectable answer as the official question vocabulary declares it. */
export interface AcpQuestionOption {
  readonly label: string
  readonly description?: string
}

/**
 * One official `AskUserQuestionItem` as this projection reads it. The shape is
 * structural: the Host DTO satisfies it and this module never imports a
 * second business model.
 */
export interface AcpQuestionSpec {
  /** Stable caller-provided question id, echoed in the answer. */
  readonly id: string
  /** The question to display. */
  readonly question: string
  /** Optional supporting detail kept out of option labels. */
  readonly detail?: string
  /** Optional short heading/group label. */
  readonly header?: string
  /** Optional choices; absent means free text. */
  readonly options?: readonly AcpQuestionOption[]
  /** Whether more than one option may be selected. */
  readonly multiSelect?: boolean
}

/** One answer item of the official answer batch. */
export interface AcpQuestionAnswerItem {
  /** The answered OFFICIAL question id (never the wire key). */
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** One question's wire binding inside the generated Form. */
export interface AcpQuestionFormField {
  /** The official question id this key restores. */
  readonly id: string
  /** The primary schema key (`qN`). */
  readonly key: string
  /** The optional free-text companion key (`qN__other`), present with options only. */
  readonly otherKey?: string
  /** Valid option labels; empty for a free-text question. */
  readonly options: readonly string[]
  /** Whether the answer is a multi-selection array. */
  readonly multiSelect: boolean
  /** Whether the question has any options at all. */
  readonly choice: boolean
}

/** One generated Form plus the exact bindings its response is validated against. */
export interface AcpQuestionForm {
  readonly message: string
  readonly requestedSchema: ElicitationSchema
  readonly fields: readonly AcpQuestionFormField[]
}

/** The classified outcome of one client elicitation response. */
export type AcpQuestionFormOutcome =
  | { readonly kind: 'answered'; readonly answers: readonly AcpQuestionAnswerItem[] }
  | { readonly kind: 'declined' }
  | { readonly kind: 'cancelled' }
  /** The response did not describe a legal answer to THIS form. */
  | { readonly kind: 'invalid' }

function optionEntries(options: readonly AcpQuestionOption[]): Array<{ const: string; title: string; description?: string }> {
  return options.map(option => ({
    const: option.label,
    title: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
}

/**
 * Build the standard ACP v1 Form of one official question batch.
 * @param questions - the official questions, in ask order (ids must be unique).
 * @returns the Form with its bindings, or `undefined` when the batch cannot be
 *   represented (empty batch or duplicate official ids) — the caller must fail
 *   the request closed instead of presenting a colliding Form.
 */
export function buildQuestionForm(questions: readonly AcpQuestionSpec[]): AcpQuestionForm | undefined {
  if (questions.length === 0) return undefined
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) return undefined
    ids.add(question.id)
  }
  const properties: Record<string, ElicitationPropertySchema> = {}
  const fields: AcpQuestionFormField[] = []
  for (const [position, question] of questions.entries()) {
    const key = `q${String(position)}`
    const options = question.options ?? []
    const choice = options.length > 0
    const multiSelect = question.multiSelect === true
    const description = question.detail === undefined
      ? question.question
      : `${question.question}\n\n${question.detail}`
    const title = question.header ?? `Question ${String(position + 1)}`
    const entries = optionEntries(options)
    properties[key] = !choice
      ? { type: 'string', title, description }
      : multiSelect
        ? {
          type: 'array',
          title,
          description,
          minItems: 0,
          maxItems: options.length,
          items: { anyOf: entries },
        }
        : { type: 'string', title, description, oneOf: entries }
    const otherKey = choice ? `${key}__other` : undefined
    if (otherKey !== undefined) {
      properties[otherKey] = { type: 'string', title: 'Other (optional)' }
    }
    fields.push({
      id: question.id,
      key,
      ...otherKey === undefined ? {} : { otherKey },
      options: options.map(option => option.label),
      multiSelect,
      choice,
    })
  }
  return {
    message: ACP_QUESTION_FORM_MESSAGE,
    requestedSchema: { type: 'object', properties, required: [] },
    fields,
  }
}

/**
 * Convert one standard ACP elicitation response into the official answer batch.
 *
 * Every official question id appears exactly once in an accepted batch: the
 * Form carries no `required` entries (DSH skip semantics), so an omitted or
 * empty key is `{selected: []}` — the documented "skipped" answer, never an
 * approval or a default option. A single-select free-text value replaces the
 * selection; a multi-select free-text value accompanies it.
 *
 * @param form - the exact Form that was sent (its bindings validate the answer).
 * @param response - the client's response action plus optional content.
 * @returns the classified outcome; `invalid` must fail the request closed.
 */
export function answerQuestionForm(form: AcpQuestionForm, response: unknown): AcpQuestionFormOutcome {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) return { kind: 'invalid' }
  const action = (response as { readonly action?: unknown }).action
  if (action === 'decline') return { kind: 'declined' }
  if (action === 'cancel') return { kind: 'cancelled' }
  if (action !== 'accept') return { kind: 'invalid' }
  const rawContent = (response as { readonly content?: unknown }).content
  if (rawContent === undefined || rawContent === null) {
    return { kind: 'answered', answers: skipAll(form) }
  }
  if (typeof rawContent !== 'object' || Array.isArray(rawContent)) return { kind: 'invalid' }
  const content = rawContent as Record<string, unknown>
  const acceptedKeys = new Set<string>()
  for (const field of form.fields) {
    acceptedKeys.add(field.key)
    if (field.otherKey !== undefined) acceptedKeys.add(field.otherKey)
  }
  for (const key of Object.keys(content)) {
    if (!acceptedKeys.has(key)) return { kind: 'invalid' }
  }
  const answers: AcpQuestionAnswerItem[] = []
  for (const field of form.fields) {
    const primary = readValue(content, field.key)
    const other = field.otherKey === undefined ? undefined : readValue(content, field.otherKey)
    if (primary === 'wrong-type' || other === 'wrong-type') return { kind: 'invalid' }
    const answersForField = fieldAnswer(field, primary, other)
    if (answersForField === undefined) return { kind: 'invalid' }
    answers.push(answersForField)
  }
  return { kind: 'answered', answers }
}

function skipAll(form: AcpQuestionForm): readonly AcpQuestionAnswerItem[] {
  return form.fields.map(field => ({ id: field.id, selected: [] }))
}

/** One present-or-absent schema value, or the client's wrong primitive type. */
type FormValue = string | readonly string[] | undefined | 'wrong-type'

/**
 * Read one own property without ever consulting the object prototype. An empty
 * string is "no value": both DSH's skip semantics and a rendered-but-unfilled
 * control express the same absence, and no default is invented from it.
 */
function readValue(content: Record<string, unknown>, key: string): FormValue {
  if (!Object.hasOwn(content, key)) return undefined
  const value = content[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value === '' ? undefined : value
  if (!Array.isArray(value)) return 'wrong-type'
  const selected: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return 'wrong-type'
    if (item !== '') selected.push(item)
  }
  return selected
}

/** Build one official answer item from this field's validated values. */
function fieldAnswer(
  field: AcpQuestionFormField,
  primary: FormValue,
  other: FormValue,
): AcpQuestionAnswerItem | undefined {
  if (primary === 'wrong-type' || other === 'wrong-type') return undefined
  if (other !== undefined && typeof other !== 'string') return undefined
  const custom = typeof other === 'string' ? other : undefined
  if (!field.choice) {
    // A free-text question has no option list: the primary string IS the answer.
    if (typeof primary === 'string') {
      return { id: field.id, selected: [], custom: primary }
    }
    if (primary !== undefined) return undefined
    return custom === undefined ? { id: field.id, selected: [] } : { id: field.id, selected: [], custom }
  }
  if (field.multiSelect) {
    if (primary !== undefined && typeof primary === 'string') return undefined
    const selected = primary ?? []
    for (const label of selected) {
      if (!field.options.includes(label)) return undefined
    }
    if (new Set(selected).size !== selected.length) return undefined
    return custom === undefined
      ? { id: field.id, selected: [...selected] }
      : { id: field.id, selected: [...selected], custom }
  }
  if (primary !== undefined && typeof primary !== 'string') return undefined
  if (typeof primary === 'string' && !field.options.includes(primary)) return undefined
  if (custom !== undefined) return { id: field.id, selected: [], custom }
  return primary === undefined ? { id: field.id, selected: [] } : { id: field.id, selected: [primary] }
}
