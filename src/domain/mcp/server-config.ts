/**
 * FR4 — the pure MCP server configuration editing domain (S1).
 *
 * Everything here is transport/UI-neutral policy over ONE official
 * `mcp-manager` settings descriptor: the server-name grammar, the
 * User-added / Inherited / Overridden provenance classification of one
 * entry (from the SAME descriptor's `base`/`user` layers), the per-transport
 * draft validation (cross-transport fields, `${credential:REF}` template
 * syntax), and the projection of one edit intent onto the official
 * `SettingsPathOp[]` batch (dirty field paths only; unknown/hidden fields
 * are never rewritten).
 *
 * There is NO IO here: the owning adapter supplies the descriptor facts, the
 * controller supplies the draft. The official Host schema/manager remains the
 * final validator — these rules exist so a broken draft is refused BEFORE a
 * settings mutation is dispatched, and so a User-only delete and an
 * inherited-override reset (the SAME official `unset ['servers', name]`)
 * are distinguished by their `base`/`user` preconditions, never by wording.
 *
 * @module @xmoon76/dsh-pi-tui/domain/mcp/server-config
 */

/** The official server-name grammar (`@deepseek-ai/dsh-mcp-client`). */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** One server transport, as the official manager schema defines it. */
export type McpServerTransport = 'stdio' | 'streamable-http'

/**
 * The CONFIG-EDITABLE fields of one server entry. Fields the official schema
 * owns but this milestone does not edit (`startupTimeoutMs`,
 * `toolCallTimeoutMs`, `closeTimeoutMs`, `reconnect`) are deliberately absent:
 * an edit never restates them, so they survive untouched (the DEFERRED rule).
 */
export interface McpServerEntryDraft {
  readonly transport: McpServerTransport
  /** stdio: the executable command (required non-empty). */
  readonly command: string
  /** stdio: one argument per row (the whole list is one dirty list). */
  readonly args: readonly string[]
  /** stdio: env key → value (values may be `${credential:REF}` references). */
  readonly env: ReadonlyMap<string, string>
  /** stdio: the working directory ('' = unset). */
  readonly cwd: string
  /** streamable-http: the endpoint URL (required non-empty). */
  readonly url: string
  /** streamable-http: header key → value. */
  readonly headers: ReadonlyMap<string, string>
  readonly enabled: boolean
}

/**
 * The provenance of one configured entry, derived ONLY from the same
 * descriptor's `base` and `value` (effective) layers.
 *
 * The official ConfigEditor materializes the WHOLE effective `servers` map
 * into the USER patch on any write (a volatile field), so a `user.servers[name]`
 * key is NOT proof of a user override — an untouched inherited entry can carry
 * one after an unrelated Add/Edit. The observable rule is therefore:
 *
 * - `user-added`: the base layer has no entry for the name but the effective
 *   layer does — deletable.
 * - `inherited`: the effective entry equals the base entry — editable and
 *   disableable, NOT deletable.
 * - `overridden`: the effective entry differs from the base entry — the user
 *   override may be reset (official `unset` restores base) or edited further.
 *
 * A user edit that happens to produce EXACTLY the base value is
 * observationally indistinguishable from inherited state; the descriptor is
 * the only authority this contract has, so it reports `inherited`.
 */
export type McpServerConfigProvenance = 'user-added' | 'inherited' | 'overridden'

/** One classified configured entry as the controller/page consume it. */
export interface McpClassifiedServerEntry {
  readonly name: string
  readonly provenance: McpServerConfigProvenance
  /** The effective entry value (transport field facts only; secrets ride as
   *  `${credential:REF}` reference strings or are redacted by the Host). */
  readonly effective: {
    readonly transport: McpServerTransport
    readonly command?: string
    readonly args?: readonly string[]
    readonly env?: ReadonlyMap<string, string>
    readonly cwd?: string
    readonly url?: string
    readonly headers?: ReadonlyMap<string, string>
    readonly enabled?: boolean
  }
  /** The BASE (inherited) entry's env/headers key sets, when the descriptor
   *  exposed a base entry with dict fields. The per-key removal policy: an
   *  official per-key `unset` on a base-owned key RESTORES the inherited value
   *  (it cannot delete), so only keys the base does not own are removable. */
  readonly baseKeys?: {
    readonly env?: ReadonlySet<string>
    readonly headers?: ReadonlySet<string>
  }
}

/** One validation problem of a draft (never a secret). */
export interface McpDraftIssue {
  readonly field: 'name' | 'transport' | 'command' | 'args' | 'env' | 'cwd' | 'url' | 'headers'
  readonly message: string
}

/** Whether one string is a valid `${credential:REF}` template per the
 *  official mcp-client rules (adjacent plain text allowed; every other
 *  `${...}` occurrence is invalid). */
function validTemplateSyntax(value: string): boolean {
  const token = /\$\{([^}]*)\}/gu
  for (const match of value.matchAll(token)) {
    if (!/^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/u.test(match[0] ?? '')) return false
  }
  return true
}

/** Whether one env/header key is acceptable (non-empty, no control chars,
 *  no `.`/`$`/newline — the official path op turns it into a settings path
 *  segment, so a path-meta key is refused before dispatch). */
function validMapKey(key: string): boolean {
  return key !== '' && !/[\u0000-\u001f\u007f]/u.test(key) && !key.includes('.') && !key.includes('$')
}

/**
 * Validate one whole draft (Add or an edited form): name grammar first, then
 * the per-transport cross-field rules, then the template syntax of every
 * templated string. Returns every issue found (the UI shows them all); an
 * empty list means the draft is dispatchable.
 */
export function validateMcpServerDraft(name: string, draft: McpServerEntryDraft): readonly McpDraftIssue[] {
  const issues: McpDraftIssue[] = []
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    issues.push({ field: 'name', message: 'the name may contain 1-32 ASCII letters, digits, "_" or "-"' })
  }
  if (draft.transport === 'stdio') {
    if (draft.command.trim() === '') issues.push({ field: 'command', message: 'a stdio server requires a command' })
    for (const [index, arg] of draft.args.entries()) {
      if (!validTemplateSyntax(arg)) {
        issues.push({ field: 'args', message: `argument ${String(index + 1)} has an invalid ${'${credential:REF}'} token` })
      }
    }
    for (const [key, value] of draft.env) {
      if (!validMapKey(key)) issues.push({ field: 'env', message: `invalid env key ${JSON.stringify(key)}` })
      if (!validTemplateSyntax(value)) {
        issues.push({ field: 'env', message: `env ${JSON.stringify(key)} has an invalid ${'${credential:REF}'} token` })
      }
    }
    if (!validTemplateSyntax(draft.command)) {
      issues.push({ field: 'command', message: `the command has an invalid ${'${credential:REF}'} token` })
    }
    if (!validTemplateSyntax(draft.cwd)) {
      issues.push({ field: 'cwd', message: `the working directory has an invalid ${'${credential:REF}'} token` })
    }
  } else {
    if (draft.url.trim() === '') issues.push({ field: 'url', message: 'a streamable-http server requires a URL' })
    for (const [key, value] of draft.headers) {
      if (!validMapKey(key)) issues.push({ field: 'headers', message: `invalid header key ${JSON.stringify(key)}` })
      if (!validTemplateSyntax(value)) {
        issues.push({ field: 'headers', message: `header ${JSON.stringify(key)} has an invalid ${'${credential:REF}'} token` })
      }
    }
    if (!validTemplateSyntax(draft.url)) {
      issues.push({ field: 'url', message: `the URL has an invalid ${'${credential:REF}'} token` })
    }
  }
  return issues
}

/** One official settings path op (the port's DTO mirrors the wire shape). */
export interface McpSettingsPathOp {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** Which fields of one draft differ from the entry's effective values. */
export type McpDirtyFields = ReadonlySet<'transport' | 'command' | 'args' | 'env' | 'cwd' | 'url' | 'headers' | 'enabled'>

/** The set of per-key changes of one dict field. */
export interface McpDictFieldPatch {
  /** keys whose values changed or were added. */
  readonly set: ReadonlyMap<string, string>
  /** keys removed relative to the effective entry. */
  readonly unset: readonly string[]
}

/** The plan for one edit: the dirty scalar fields plus per-key dict patches. */
export interface McpEditPatch {
  readonly scalars: McpDirtyFields
  readonly env?: McpDictFieldPatch
  readonly headers?: McpDictFieldPatch
}

/** Diff one edited draft against the effective entry. */
export function diffMcpServerDraft(effective: McpClassifiedServerEntry['effective'], draft: McpServerEntryDraft): McpEditPatch {
  const scalars = new Set<'transport' | 'command' | 'args' | 'env' | 'cwd' | 'url' | 'headers' | 'enabled'>()
  if (effective.transport !== draft.transport) scalars.add('transport')
  if (draft.transport === 'stdio' || effective.transport === 'stdio') {
    if ((effective.command ?? '') !== draft.command) scalars.add('command')
    if ((effective.cwd ?? '') !== draft.cwd) scalars.add('cwd')
  }
  if (draft.transport === 'streamable-http' || effective.transport === 'streamable-http') {
    if ((effective.url ?? '') !== draft.url) scalars.add('url')
  }
  if ((effective.enabled ?? true) !== draft.enabled) scalars.add('enabled')
  // args: whole-list replacement whenever any element differs.
  const effectiveArgs = effective.args ?? []
  const argsDiffer = effectiveArgs.length !== draft.args.length
    || effectiveArgs.some((arg, index) => arg !== draft.args[index])
  if (argsDiffer) scalars.add('args')
  // dict fields: per-key patches.
  const dictPatch = (
    before: ReadonlyMap<string, string> | undefined,
    after: ReadonlyMap<string, string>,
  ): McpDictFieldPatch => {
    const set = new Map<string, string>()
    const unset: string[] = []
    for (const [key, value] of after) {
      if (before?.get(key) !== value) set.set(key, value)
    }
    for (const key of before?.keys() ?? []) {
      if (!after.has(key)) unset.push(key)
    }
    return { set, unset }
  }
  const env = dictPatch(effective.env, draft.env)
  const headers = dictPatch(effective.headers, draft.headers)
  if (env.set.size > 0 || env.unset.length > 0) scalars.add('env')
  if (headers.set.size > 0 || headers.unset.length > 0) scalars.add('headers')
  return { scalars, ...env.set.size > 0 || env.unset.length > 0 ? { env } : {}, ...headers.set.size > 0 || headers.unset.length > 0 ? { headers } : {} }
}

/**
 * Project one ADD onto the official ops (the legal whole-entry `set` for a
 * NEW user-only server): transport + the transport's own fields + `enabled`.
 * Cross-transport fields are omitted entirely (the official schema defaults
 * them), and the deferred budget fields are never restated.
 */
export function mcpAddOps(name: string, draft: McpServerEntryDraft): readonly McpSettingsPathOp[] {
  const value: Record<string, unknown> = { transport: draft.transport, enabled: draft.enabled }
  if (draft.transport === 'stdio') {
    value.command = draft.command
    value.args = [...draft.args]
    value.cwd = draft.cwd
    if (draft.env.size > 0) value.env = Object.fromEntries(draft.env)
  } else {
    value.url = draft.url
    if (draft.headers.size > 0) value.headers = Object.fromEntries(draft.headers)
  }
  return [{ op: 'set', path: ['servers', name], value }]
}

/** The stdio fields a transport switch away must clear (official schema
 *  defaults: '' / [] / {}). */
const STDIO_SWITCH_FIELDS = ['command', 'args', 'env', 'cwd'] as const
/** The streamable-http fields a transport switch away must clear. */
const HTTP_SWITCH_FIELDS = ['url', 'headers'] as const

/**
 * Project one EDIT onto the official ops: ONLY the dirty field paths. An
 * existing entry is never restated as a whole object (a whole `set` would
 * wash away hidden/unknown and deferred fields); `env`/`headers` patch per
 * key, `args` replace as one list (the official dirty-list semantics), and a
 * transport switch explicitly resets the OLD transport's fields to the
 * official schema defaults — an `unset` there would resurrect an INHERITED
 * value, so the switch path never emits an unset for the abandoned fields.
 */
export function mcpEditOps(name: string, effective: McpClassifiedServerEntry['effective'], draft: McpServerEntryDraft, patch: McpEditPatch): readonly McpSettingsPathOp[] {
  const ops: McpSettingsPathOp[] = []
  const root = ['servers', name] as const
  const switched = patch.scalars.has('transport')
  if (switched) {
    ops.push({ op: 'set', path: [...root, 'transport'], value: draft.transport })
    // Reset the abandoned transport's fields to the official schema defaults.
    const abandon = draft.transport === 'stdio' ? HTTP_SWITCH_FIELDS : STDIO_SWITCH_FIELDS
    for (const field of abandon) {
      const fallback = field === 'args' ? [] : field === 'env' || field === 'headers' ? {} : ''
      ops.push({ op: 'set', path: [...root, field], value: fallback })
    }
  }
  if (draft.transport === 'stdio') {
    if (patch.scalars.has('command')) ops.push({ op: 'set', path: [...root, 'command'], value: draft.command })
    if (patch.scalars.has('cwd')) ops.push({ op: 'set', path: [...root, 'cwd'], value: draft.cwd })
    if (patch.scalars.has('args')) ops.push({ op: 'set', path: [...root, 'args'], value: [...draft.args] })
    // `env` is a stdio field only. On a TRANSPORT SWITCH the abandoned dict was
    // already reset wholesale above, so the per-key patch of the NEW transport
    // rides as plain `set`s (an unset could restore an inherited key the user
    // never asked to restore); without a switch the ordinary per-key patch
    // applies.
    const envPatch = patch.env
    if (envPatch !== undefined) {
      for (const [key, value] of envPatch.set) ops.push({ op: 'set', path: [...root, 'env', key], value })
      if (!switched) for (const key of envPatch.unset) ops.push({ op: 'unset', path: [...root, 'env', key] })
    }
  } else {
    if (patch.scalars.has('url')) ops.push({ op: 'set', path: [...root, 'url'], value: draft.url })
    const headersPatch = patch.headers
    if (headersPatch !== undefined) {
      for (const [key, value] of headersPatch.set) ops.push({ op: 'set', path: [...root, 'headers', key], value })
      if (!switched) for (const key of headersPatch.unset) ops.push({ op: 'unset', path: [...root, 'headers', key] })
    }
  }
  if (patch.scalars.has('enabled')) ops.push({ op: 'set', path: [...root, 'enabled'], value: draft.enabled })
  return ops
}

/**
 * The official op of BOTH terminal actions — the SAME `unset
 * ['servers', name]`. The caller's precondition (user-only vs inherited
 * override) is what distinguishes Delete from Reset; the official mutate
 * resolves the difference (user-only: gone; inherited: base restored).
 */
export function mcpRemoveOps(name: string): readonly McpSettingsPathOp[] {
  return [{ op: 'unset', path: ['servers', name] }]
}

/** The official op of the Enable/Disable toggle. */
export function mcpSetEnabledOps(name: string, enabled: boolean): readonly McpSettingsPathOp[] {
  return [{ op: 'set', path: ['servers', name, 'enabled'], value: enabled }]
}

/* ------------------------------------------------------------------------- *
 * Descriptor projection (the adapter-agnostic classification).
 * ------------------------------------------------------------------------- */

/** Whether one raw value is a plain record (not an array/null). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one layer's `servers` map (own keys only — a name like `__proto__`
 *  must never resolve through the prototype chain). */
function serverMapOf(layer: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(layer)) return undefined
  const servers = layer.servers
  return isPlainRecord(servers) ? servers : undefined
}

/** Structural equality of two detached JSON-shaped values: key order does not
 *  matter for objects, array order does, and absent ≠ present. */
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => structurallyEqual(item, right[index]))
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]))
  }
  return false
}

/**
 * Classify one configured name from ONE descriptor's `base`/`value` layers.
 * The USER layer is deliberately NOT consulted for ownership (the official
 * ConfigEditor materializes inherited entries into the USER patch on any
 * write). An absent name (neither layer holds it) is `undefined`: the caller
 * must treat it as not-config-owned (plugin-owned/retained/unknown), never
 * guess.
 */
export function classifyMcpServerProvenance(base: unknown, value: unknown, name: string): McpServerConfigProvenance | undefined {
  const baseServers = serverMapOf(base)
  const valueServers = serverMapOf(value)
  if (valueServers === undefined || !Object.hasOwn(valueServers, name)) return undefined
  if (baseServers === undefined || !Object.hasOwn(baseServers, name)) return 'user-added'
  return structurallyEqual(baseServers[name], valueServers[name]) ? 'inherited' : 'overridden'
}

/**
 * The base dict key sets of one raw base entry (own keys only), or `undefined`
 * when the descriptor carries no base entry / no dict fields.
 */
export function baseDictKeysOf(baseEntry: unknown): { env?: ReadonlySet<string>; headers?: ReadonlySet<string> } | undefined {
  if (!isPlainRecord(baseEntry)) return undefined
  const of = (value: unknown): ReadonlySet<string> | undefined => {
    if (!isPlainRecord(value)) return undefined
    return new Set(Object.keys(value))
  }
  const env = of(baseEntry.env)
  const headers = of(baseEntry.headers)
  if (env === undefined && headers === undefined) return undefined
  return { ...env === undefined ? {} : { env }, ...headers === undefined ? {} : { headers } }
}

/** Project one effective entry value into the transport-fact DTO (strings,
 *  string lists and string maps only). A field that IS present with the wrong
 *  type refuses the WHOLE entry: a silently coerced draft would overwrite the
 *  stored value with a guess. The effective `enabled` defaults to true per the
 *  official schema. */
export function projectMcpServerEntry(value: unknown): McpClassifiedServerEntry['effective'] | undefined {
  if (!isPlainRecord(value)) return undefined
  const transport = value.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') return undefined
  const stringOf = (input: unknown): string | undefined => typeof input === 'string' ? input : undefined
  const listOf = (input: unknown): readonly string[] | undefined => {
    if (!Array.isArray(input) || !input.every(item => typeof item === 'string')) return undefined
    return Object.freeze([...input])
  }
  const mapOf = (input: unknown): ReadonlyMap<string, string> | undefined => {
    if (!isPlainRecord(input)) return undefined
    const out = new Map<string, string>()
    for (const [key, entry] of Object.entries(input)) {
      if (typeof entry !== 'string') return undefined
      out.set(key, entry)
    }
    return out
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return undefined
  const enabled = typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}
  if (transport === 'stdio') {
    for (const field of ['command', 'cwd'] as const) {
      if (value[field] !== undefined && typeof value[field] !== 'string') return undefined
    }
    const args = value.args === undefined ? Object.freeze([] as string[]) : listOf(value.args)
    const env = value.env === undefined ? new Map<string, string>() : mapOf(value.env)
    if (args === undefined || env === undefined) return undefined
    return Object.freeze({
      transport,
      command: stringOf(value.command) ?? '',
      args,
      cwd: stringOf(value.cwd) ?? '',
      env,
      ...enabled,
    })
  }
  if (value.url !== undefined && typeof value.url !== 'string') return undefined
  const headers = value.headers === undefined ? new Map<string, string>() : mapOf(value.headers)
  if (headers === undefined) return undefined
  return Object.freeze({
    transport,
    url: stringOf(value.url) ?? '',
    headers,
    ...enabled,
  })
}
