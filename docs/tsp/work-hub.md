# Work Hub (TSP)

The native TSP Work Center: the read-only `/tasks` surface of the experimental
TSP renderer, its temporary Work Details Reader, and the admission that decides
whether the entry exists at all.

Related: [TSP foundation](./foundation.md) (bounded reader surface, identity and
currentness), [TSP overview](./overview.md) (capability and admission), [shared
Task/Job/Question owner](../architecture/surface-behavior.md),
[overlay and focus](../architecture/overlay-focus.md).

## Scope and ownership

The Work Hub is a PRESENTATION of facts another owner already decided. It owns
no catalog, no roster, no refresh policy and no business action.

| Concern | Owner |
|---|---|
| Command registration and its handler | `src/tui/commands/tasks.ts` (`tasks`, alias `subagents`) |
| Post-classification admission | `src/app/submission/controller.ts` over `src/app/command/tsp-capability.ts` |
| Task Center reachability truth | `SurfaceDisplaySeam.supportsTaskCenter` |
| Routing an opener to the ONE Task Runtime | `src/app/command/surface.ts` → `src/app/surface/runtime.ts` |
| Catalog/roster/attention, refresh, currentness, selection routing | `src/app/surface/task-runtime.ts`, `task-browser-runtime.ts` |
| Native picker, side Inspector, query and selection state | `src/tui/tsp/work-hub.ts` |
| Renderer mount, temporary Screen lifetime, input ownership | `src/tui/tsp/session.ts` |

Both renderers share ONE business entry and ONE `TaskRuntime`. The TSP Work Hub
is the presentation sink behind `TaskCenterPresentationPort`; it is never a
second Task Center implementation and holds no fallback read of DSH Tasks, Jobs
or Questions.

## Entry and capability admission

The only entries are the registered `/tasks` command and its registered alias
`/subagents`. Both reach the unchanged handler
(`requireLiveSessionScope()` → `runner.openTasksBrowser()`) and therefore the
unchanged `TaskRuntime` opener. The renderer never parses a slash line itself
and never opens the browser on its own initiative.

Admission is decided after classification, by the existing command classifier
and the mounted renderer's capability:

| Fact | Effect |
|---|---|
| The winner is a TUI-owned client command (`client-command` + `source: 'tui'`) | in scope |
| A genuine Host command of the same spelling won the line | not the TUI builtin; the Host handler runs |
| A Client-extension command or a skill invocation | not the TUI builtin; its own owner runs |
| The mounted pane negotiated `picker`, `col`, `row`, `text` and the `scroll` feature | the command is admitted |
| Any of those is missing | the command is refused before the opener runs |

`supportsTaskCenter` reports the renderer's structural negotiated capability
only. It does not report transient interaction state: a mounted but unbound
input, an occupied modal seat, an in-progress hydration, an open Reader or the
current pane width do not change it. A refusal keeps the user's draft and
states itself once; it never runs a handler that reports success, and it never
mounts a browser the user could not read or leave.

The `supportsViewer` capability stays `false` on this renderer: the read-only
Work Hub does not add a Viewer, and Task Center availability implies nothing
about modals, Job Workspace or the subagent viewer.

## Native Work Hub

The Hub is ONE native `ui.picker` layer over the base inline surface, with an
optional side Inspector:

- **Needs attention** — Question rows awaiting a human answer. This is a
  separate dataset, not work; a Question never counts as a running child.
- **Work · Subagents** — the current DSH descendant set in the catalog's stable
  pre-order, nested by parent and depth, with its mode and running/inactive
  activity.
- **Work · Jobs** — the flat current Job roster of the same Session scope.

Search filters the visible rows only. Selection, query and focus are the Hub's
own discardable state; they never address a business target. The Inspector,
when the pane is wide enough to request one, restates the selected row's facts
and is client-presented, not a second source.

## Read-only Work Details

`Enter` on the current row, or the native `View details` action, asks the
renderer for ONE temporary read-only Reader on the SAME SDK Session. The Hub
re-resolves the CURRENT row through the Task Runtime projection before asking,
so a selection captured on an older frame or revision cannot open a newer row.

The document carries `← Work`, the row's identity, classification, status and
the known type/parent/depth/mode/timestamp/detail facts, and wraps long content
instead of truncating it. Reading keys route to the SDK's native `scroll` on the
document's `main` region.

The Reader is not a business surface: it holds no catalog, mutates nothing and
never calls the row's business selection router. A row whose facts changed while
the Reader was open repaints from the current projection without resetting the
reading anchor; a row that no longer exists is retired by the Reader's existing
currentness rules rather than silently replaced by a neighbour.

## Input, focus and return

- Up/Down, Home/End, PageUp/PageDown and pointer selection change the Hub's
  current row and the Inspector only.
- Typing edits the search query; the query and selection survive a Reader round
  trip.
- `Esc` or the native `← Work` row closes the Reader and returns to the SAME
  Hub with the same selection and query.
- While the temporary Screen is open or still closing it is the frontmost seat:
  base and composer keys never act behind it.
- The Hub's own `Close`/`Esc` retires it through the original presentation
  close path and returns to the composer.
- A modal arriving while the Reader is open retires the Reader through the
  existing modal-priority path before the modal becomes the visible seat; a
  Session switch or surface disposal retires both, and no stale row, callback
  or read from the outgoing subject can revive them.

The client decides how a `mode:'screen'` surface is physically presented (a
covered base, a separate tab, or another client mechanism). That is a client
fact, not part of this contract; a client whose presentation makes the shortest
path require extra user navigation is a product decision for the Owner, not an
implementation detail this document may promise.

## Loading, empty and failure states

Every state describes what the current source really returned:

- A coalesced refresh shows `loading`/`ready`/`stale` plus its truthful error;
  a background refresh never erases a newer error and never overwrites a newer
  source.
- Either half of the read may be independently absent: a Job-only roster shows
  the real Jobs and invents no descendant row, a descendant-only read shows the
  real descendants and invents no Job.
- When both halves are genuinely empty the Hub states that empty roster and
  keeps its usable actions; it never fabricates a completed or placeholder work
  item.
- A pane too narrow to present the Hub keeps its existing explicit
  unavailable message and exits with `Esc`. Pane width never changes
  `supportsTaskCenter`; it is a presentation fact of the moment.
- A refused command restores the draft and states the refusal once.

## Responsive layout and client presentation

The Hub requests a side Inspector only when the pane is wide enough for it and
`preview: 'none'` otherwise; the client still decides what it paints. Below the
internal pane floor the Hub reports itself unavailable rather than painting an
unreachable action bar.

A `View details` action is painted only while a Reader could really be admitted;
painting it while the capability or the Reader slot would refuse it is a dead
control. Narrow, short and clamped viewports must keep the primary read action
or its keyboard equivalent reachable — a `Node` existing on the wire is not
evidence that a user can reach it.

## Boundaries and forbidden operations

The Work Hub is read-only by contract:

- No Stop, Interrupt, Answer, Skip, Open Agent or View Output control exists,
  and no Hub or Reader input reaches a Job writer, the subagent interrupt path,
  a Question answerer or the business `TaskPresentation` selection router.
- Question rows are attention, never work, and are never answered from here.
- `supportsViewer` stays `false`; the existing subagent viewer authority is not
  reachable from the Hub.
- No completed/parked inference: the Hub shows the status the source reports,
  never a derived "done", and never Job output.
- No second Task Runtime, second SDK Session, second input loop or renderer
  side queue, and no PiTui-only surface call (`mounted()`) on this branch.

## Related contracts

- [TSP foundation](./foundation.md) — the bounded reader surface, node
  identity/revision, seat ownership and async currentness the Reader relies on.
- [TSP overview](./overview.md) — renderer selection, capability negotiation and
  admission entry points.
- [Shared Task/Job/Question owner](../architecture/surface-behavior.md) — the
  Task Center, Task Browser and Job Workspace business contract both renderers
  consume.
- [Overlay and focus](../architecture/overlay-focus.md) — managed overlay
  precedence for the temporary Screen against modals.
