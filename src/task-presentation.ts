/**
 * Pure Task Center presentation projection.
 *
 * The durable task rows stay in catalog order. This module only decides what
 * the current surface can see: scope/type/search filtering, ancestor
 * retention, disclosure, and tree connectors. It never mutates a runtime row
 * or reorders the catalog.
 *
 * @module @xmoon76/dsh-pi-tui/task-presentation
 */

/** The two independent Task Center scope filters. */
export type TaskScope = 'active' | 'all'

/** A row-shaped value consumed by both Quick Tasks and Task Center. */
export interface TaskPanelItem {
  /** Stable row identity (`agent:…`, `job:…`). */
  readonly value: string
  /** Primary display label. */
  readonly label: string
  /** Durable mode or another non-truncatable semantic suffix. */
  readonly suffix?: string
  /** Current state word. */
  readonly status: string
  /** Optional status/detail metadata. */
  readonly detail?: string
  readonly startedAt?: number
  readonly finishedAt?: number
  /** Logical group (`subagents` / `jobs`, or a display label). */
  readonly group?: string
  /** Type-filter identity (`subagent`, `bash`, `pwsh`, ...). */
  readonly type?: string
  /** Source and semantic capabilities. */
  readonly source?: 'subagent' | 'job'
  readonly canOpen?: boolean
  readonly canStop?: boolean
  /** Kept as a compatibility alias for older callers. */
  readonly interruptible?: boolean
  readonly active?: boolean
  readonly attention?: boolean
  /** Durable tree facts. Parent ids are row ids when possible. */
  readonly parentId?: string
  readonly depth?: number
  readonly hasChildren?: boolean
  readonly parentLabel?: string
  readonly mode?: 'one-shot' | 'continuable' | string
  readonly access?: string
  /** Presentation facts populated by {@link projectTaskItems}. */
  readonly expanded?: boolean
  readonly ancestorContext?: boolean
  readonly treePrefix?: string
  /** Quick Tasks' discoverable transition row. */
  readonly kind?: 'task' | 'view-full'
}

/** Inputs controlling one projection. */
export interface TaskPresentationProjectionOptions {
  readonly scope: TaskScope
  readonly typeFilter?: string | null
  readonly query?: string
  readonly expandedIds?: ReadonlySet<string>
  readonly collapsedIds?: ReadonlySet<string>
  /** Running/search branches expand unless explicitly collapsed. */
  readonly autoExpandRunning?: boolean
  /** Quick may surface attention rows when there is no live work. */
  readonly includeAttentionInActive?: boolean
}

/** A projected row set and the ids that remain visible. */
export interface TaskPresentationProjection {
  readonly rows: TaskPanelItem[]
  readonly matchedIds: ReadonlySet<string>
}

const ACTIVE_STATES = new Set(['running', 'stopping'])

/** Status-based fallback for callers that have not supplied `active`. */
export function isTaskItemActive(item: Pick<TaskPanelItem, 'active' | 'status'>): boolean {
  return item.active ?? ACTIVE_STATES.has(item.status)
}

/** Whether a task status deserves an error/attention marker. */
export function isTaskItemFailure(status: string): boolean {
  return status === 'failed' || status === 'timed_out' || status === 'lost'
}

/** Normalize a parent reference from a durable child id to a row id. */
function parentIdOf(item: TaskPanelItem, byId: ReadonlyMap<string, TaskPanelItem>, byChildId: ReadonlyMap<string, string>): string | undefined {
  const parent = item.parentId
  if (parent === undefined || parent === '') return undefined
  if (byId.has(parent)) return parent
  return byChildId.get(parent) ?? parent
}

/**
 * Project rows for one Quick/Full view.
 *
 * Active projection is `active rows + their ancestors`; it never promotes a
 * child to a root and never changes the input order. Search and type are
 * applied orthogonally. Ancestors retained only for context are marked
 * `ancestorContext` and keep their real inactive state.
 */
export function projectTaskItems(
  input: readonly TaskPanelItem[],
  options: TaskPresentationProjectionOptions,
): TaskPresentationProjection {
  const all = input.filter(item => item.kind !== 'view-full')
  const byId = new Map(all.map(item => [item.value, item]))
  const byChildId = new Map<string, string>()
  for (const item of all) {
    if (item.source === 'subagent' && item.value.startsWith('agent:')) {
      byChildId.set(item.value.slice('agent:'.length), item.value)
    }
  }
  const parentById = new Map<string, string | undefined>()
  for (const item of all) parentById.set(item.value, parentIdOf(item, byId, byChildId))

  const typeFilter = options.typeFilter ?? null
  const query = (options.query ?? '').trim().toLowerCase()
  const typeMatches = (item: TaskPanelItem): boolean => typeFilter === null || item.type === typeFilter
  const queryMatches = (item: TaskPanelItem): boolean => query === '' || [
    item.value,
    item.label,
    item.suffix ?? '',
    item.status,
    item.detail ?? '',
    item.group ?? '',
  ].join('\n').toLowerCase().includes(query)
  const filterMatches = (item: TaskPanelItem): boolean => typeMatches(item) && queryMatches(item)

  const matchedIds = new Set(all.filter(filterMatches).map(item => item.value))
  // The FULL tree (before any include pass): answering "does this inactive
  // branch contain active work?" during Active projection needs the
  // complete lineage, not the selected subset.
  const childrenMap = new Map<string | undefined, TaskPanelItem[]>()
  for (const item of all) {
    const parent = parentById.get(item.value)
    const list = childrenMap.get(parent) ?? []
    list.push(item)
    childrenMap.set(parent, list)
  }
  /** Fold a subtree predicate bottom-up in ONE reverse-preorder pass — the
   * whole projection stays O(n) even for deep/long trees; per-node BFS
   * re-scans (an earlier revision) made search keystrokes quadratic. */
  const propagateSubtree = (
    nodes: readonly TaskPanelItem[],
    tree: Map<string | undefined, TaskPanelItem[]>,
    marker: (item: TaskPanelItem) => boolean,
  ): (id: string) => boolean => {
    const subtree = new Map<string, boolean>()
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i]!
      const anyChild = (tree.get(node.value) ?? []).some(child => subtree.get(child.value) === true)
      subtree.set(node.value, anyChild || marker(node))
    }
    return (id: string) => (tree.get(id) ?? []).some(child => subtree.get(child.value) === true)
  }
  const hasActiveDescendantInAll = propagateSubtree(all, childrenMap, isTaskItemActive)
  const isDescendantOf = (candidate: TaskPanelItem, root: string): boolean => {
    let parent = parentById.get(candidate.value)
    const seen = new Set<string>()
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      if (parent === root) return true
      parent = parentById.get(parent)
    }
    return false
  }

  const includedIds = new Set<string>()
  const includeWithAncestors = (item: TaskPanelItem): void => {
    let current: TaskPanelItem | undefined = item
    const seen = new Set<string>()
    while (current !== undefined && !seen.has(current.value)) {
      seen.add(current.value)
      if (typeMatches(current)) includedIds.add(current.value)
      const parent = parentById.get(current.value)
      current = parent === undefined ? undefined : byId.get(parent)
    }
  }

  if (options.scope === 'active') {
    // Search narrows the active set; with an empty query every active row is
    // retained. A query that matches an INACTIVE branch keeps that branch
    // only as the CONTEXT of active work below it — the matching ancestors
    // and their active descendants join together, never an isolated dead
    // branch (an Active view must keep at least one active row; PR review
    // M3).
    for (const item of all) {
      if (!typeMatches(item)) continue
      if (isTaskItemActive(item) && queryMatches(item)) includeWithAncestors(item)
      else if (options.includeAttentionInActive === true && !isTaskItemActive(item)
        && (item.attention === true || isTaskItemFailure(item.status)) && queryMatches(item)) includeWithAncestors(item)
      else if (!isTaskItemActive(item) && queryMatches(item) && item.hasChildren
        && hasActiveDescendantInAll(item.value)) {
        for (const candidate of all) {
          if (candidate.value !== item.value && isTaskItemActive(candidate) && isDescendantOf(candidate, item.value)) {
            includeWithAncestors(candidate)
          }
        }
      }
    }
  } else {
    for (const item of all) {
      if (filterMatches(item)) includeWithAncestors(item)
    }
  }

  const selected = all.filter(item => includedIds.has(item.value))
  const children = new Map<string | undefined, TaskPanelItem[]>()
  for (const item of selected) {
    const parent = parentById.get(item.value)
    const list = children.get(parent) ?? []
    list.push(item)
    children.set(parent, list)
  }
  const expandedIds = options.expandedIds ?? new Set<string>()
  const collapsedIds = options.collapsedIds ?? new Set<string>()
  const autoExpandRunning = options.autoExpandRunning ?? true

  // Descendant predicates over the SELECTED tree, folded once (O(n)) — the
  // disclosure pass below then answers each query in O(1).
  const hasMatchingDescendant = query === ''
    ? (): boolean => false
    : propagateSubtree(selected, children, item => matchedIds.has(item.value))
  const hasActiveDescendant = propagateSubtree(selected, children, isTaskItemActive)
  const hasAttentionDescendant = propagateSubtree(selected, children,
    item => item.attention === true || isTaskItemFailure(item.status))
  const isExpanded = (item: TaskPanelItem): boolean => {
    if (!(item.hasChildren || (children.get(item.value)?.length ?? 0) > 0)) return false
    if (collapsedIds.has(item.value)) return false
    if (expandedIds.has(item.value)) return true
    if (hasMatchingDescendant(item.value)) return true
    if (autoExpandRunning && hasActiveDescendant(item.value)) return true
    if (options.includeAttentionInActive === true && hasAttentionDescendant(item.value)) return true
    // Settled branches start collapsed. Disclosure is presentation state, so
    // the user can expand a historical branch without changing the catalog.
    return false
  }

  const visible: TaskPanelItem[] = []
  for (const item of selected) {
    let parent = parentById.get(item.value)
    let hidden = false
    const seen = new Set<string>()
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      const ancestor = byId.get(parent)
      if (ancestor !== undefined && !isExpanded(ancestor)) {
        hidden = true
        break
      }
      parent = parentById.get(parent)
    }
    if (hidden) continue
    // Context rows are the NON-ACTIVE rows kept only to explain the view:
    // inactive ancestors in Active scope, or any row that survived a filter
    // without matching it. An ACTIVE row is never context — it is the work
    // the view exists to show, even when a search query did not match it
    // (a matching inactive branch pulls its running descendants in, PR
    // review M3).
    const context = !isTaskItemActive(item) && ((options.scope === 'active') || !matchedIds.has(item.value))
    visible.push({
      ...item,
      kind: item.kind ?? 'task',
      parentId: parentById.get(item.value),
      expanded: isExpanded(item),
      ancestorContext: context,
    })
  }

  // Connectors are calculated from the projected visible tree, not written
  // back into durable rows. Hidden siblings therefore do not leave misleading
  // branch tails in the current view.
  const visibleSubagents = visible.filter(item => item.source === 'subagent')
  const visibleById = new Map(visibleSubagents.map(item => [item.value, item]))
  const siblings = new Map<string | undefined, TaskPanelItem[]>()
  for (const item of visibleSubagents) {
    const parent = item.parentId === undefined || item.parentId === '' ? undefined : item.parentId
    const list = siblings.get(parent) ?? []
    list.push(item)
    siblings.set(parent, list)
  }
  const connectorFor = (item: TaskPanelItem): string => {
    if (item.depth === undefined && item.parentId === undefined) return item.treePrefix ?? ''
    const parts: string[] = []
    let currentParent = item.parentId
    const path: TaskPanelItem[] = []
    const seen = new Set<string>()
    while (currentParent !== undefined && !seen.has(currentParent)) {
      seen.add(currentParent)
      const parent = visibleById.get(currentParent)
      if (parent === undefined) break
      path.unshift(parent)
      currentParent = parent.parentId
    }
    for (const ancestor of path) {
      const parentSiblings = siblings.get(ancestor.parentId === '' ? undefined : ancestor.parentId) ?? []
      const last = parentSiblings.length === 0 || parentSiblings.at(-1)?.value === ancestor.value
      parts.push(last ? '   ' : '│  ')
    }
    const parentSiblings = siblings.get(item.parentId === '' ? undefined : item.parentId) ?? []
    const last = parentSiblings.length === 0 || parentSiblings.at(-1)?.value === item.value
    parts.push(last ? '└─ ' : '├─ ')
    return parts.join('')
  }

  return {
    rows: visible.map(item => item.source === 'subagent'
      ? { ...item, treePrefix: connectorFor(item) }
      : item),
    matchedIds,
  }
}

/** Return all row ids that are currently in a projection. */
export function projectedTaskIds(
  input: readonly TaskPanelItem[],
  options: TaskPresentationProjectionOptions,
): string[] {
  return projectTaskItems(input, options).rows.map(item => item.value)
}
