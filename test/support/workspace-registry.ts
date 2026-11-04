/**
 * Shared test stand-in for the official Host `workspaceRegistry`
 * (`@deepseek-ai/dsh-workspace`), the ONE Workspace authority the Direct
 * `SessionLifecycle` resolves before an ordinary create.
 *
 * The fake reproduces exactly the three faces the adapter consumes — `create`
 * (create-or-reuse by canonical path), `get` and `list` — plus the entity's
 * header-validated `sessionIds`/`attachSession`. It does NOT run real the
 * filesystem: a harness that needs path canonicalization must pass its own
 * `canonical` mapping.
 *
 * @module @xmoon76/dsh-pi-tui/support/workspace-registry
 */

/** One fake Host Workspace row (the official `Workspace` structural subset). */
export interface FakeHostWorkspace {
  readonly id: string
  readonly path: string
  readonly sessionIds: string[]
  attachSession(sessionId: unknown): Promise<void>
}

/** The official Host registry subset the Direct lifecycle consumes. */
export interface FakeHostWorkspaceRegistry {
  create(path: string): Promise<FakeHostWorkspace>
  get(id: string): FakeHostWorkspace | undefined
  list(): readonly FakeHostWorkspace[]
}

/**
 * Build one fake registry. `canonical` maps a proposed path to the canonical
 * path the registry stores (identity by default, like a harness that runs no
 * realpath); a repeated canonical path reuses the SAME Workspace identity.
 */
export function createFakeHostWorkspaceRegistry(options: {
  readonly canonical?: (path: string) => string
} = {}): { registry: FakeHostWorkspaceRegistry; workspaces: FakeHostWorkspace[] } {
  const workspaces: FakeHostWorkspace[] = []
  const make = (id: string, path: string): FakeHostWorkspace => ({
    id,
    path,
    sessionIds: [],
    attachSession: async (sessionId) => {
      const text = String(sessionId)
      const row = workspaces.find(candidate => candidate.id === id)
      if (row !== undefined && !row.sessionIds.includes(text)) row.sessionIds.unshift(text)
    },
  })
  const registry: FakeHostWorkspaceRegistry = {
    create: async (path) => {
      const canonical = options.canonical?.(path) ?? path
      const existing = workspaces.find(workspace => workspace.path === canonical)
      if (existing !== undefined) return existing
      const created = make(`workspace-${String(workspaces.length + 1)}`, canonical)
      workspaces.push(created)
      return created
    },
    get: (id) => workspaces.find(workspace => workspace.id === id),
    list: () => workspaces,
  }
  return { registry, workspaces }
}

/** Provide the fake under the official Cordis service key. */
export function provideFakeHostWorkspaceRegistry(
  ctx: { provide(name: string, value: unknown): void },
  registry: FakeHostWorkspaceRegistry = createFakeHostWorkspaceRegistry().registry,
): FakeHostWorkspaceRegistry {
  ctx.provide('workspaceRegistry', registry)
  return registry
}
