# Footer customization

`dsh-pi-tui` has a composable Footer rather than a fixed status line.

For most users, `/footer` is the only entry point you need. It lets you arrange
builtin status items, create your own text or command items, and place
plugin-provided items without editing YAML by hand.

This guide covers the user-facing Footer surface. Plugin authors should also
read [Extension API v1](extension-api.md).

## Quick start

Open the editor:

```text
/footer
```

`/statusline` is an alias of `/footer`.

A typical workflow is:

1. Select a row and press `Enter`.
2. Press `A` to open the Add picker.
3. Add builtin, custom, or extension items.
4. Use `Left` / `Right` to move an item between sides.
5. Use Move Mode to reorder items.
6. Open the Item Editor to change Style, Tone, Prefix/Suffix, or Importance.
7. Return to the first page and choose **Save changes**, or press `S`.

The preview is rendered by the real Footer composer, so it follows the same
layout and width rules as the live Footer.

If you leave with unsaved changes, the editor asks whether to save, discard,
or keep editing. A failed settings write keeps the editor open and preserves
the draft.

## Choose a footer mode

The Footer has four top-level modes:

| Value | Meaning |
| --- | --- |
| `default` | The classic two-row native Footer. The historical `full` value is treated as the same mode where supported. |
| `compact` | Native Footer with the statistics row hidden. |
| `custom` | A user-composed `footerLayout`, normally edited through `/footer`. |
| `command` | One trusted user command owns the whole status surface. This mode is configured manually rather than selected from the ordinary `/settings` Footer picker. |

For interactive customization, use `custom`.

## The four kinds of Footer items

A custom layout can contain items from four sources.

### Builtin Item

First-party status facts such as Model, Context, Token usage, Tasks, Git branch,
run state, and version.

Builtin items may expose more than one Style.

### Custom Text

A user-owned static text value created from `/footer`.

Examples:

```text
prod
VPN
west-us
```

### Custom Command Item

A user-owned command whose cached output becomes one ordinary Footer item.

Examples:

```text
09:41
battery 82%
vpn up
```

A Custom Command Item can sit next to builtin, Custom Text, and extension
items. It does **not** replace the whole Footer.

### Extension Item

A plugin can contribute a configurable item through the Stable
`chrome.footer.item` extension slot.

Once the plugin is installed, the item appears in `/footer` and can be
shown, hidden, ordered, and placed like a builtin item.

## Using `/footer`

The editor is hierarchical rather than one large form.

### Row Selector

The first page selects a logical Footer row.

Use it to:

- enter a row;
- inspect whether there are unsaved changes;
- choose **Save changes**;
- press `S` as the save shortcut.

### Edit Row

The row is presented as one ordered list. Left and Right are placement groups,
not separate cursor modes.

Common actions:

- `Up` / `Down` — move the cursor;
- `Left` / `Right` — move the selected item between sides;
- `Space` — remove the selected item from the row;
- `A` — open the searchable Add picker;
- `M` — enter Move Mode;
- `Enter` — open the Item Editor;
- `F` — cycle an item's Style when that shortcut is available.

### Add picker

The Add picker searches labels, ids, and descriptions.

The picker lists the whole definition catalog. Adding a definition that is
already placed appends an independent second placement — this is how the
default Footer shows Performance twice (once as `latency`, once as `speed`):
each placement keeps its own Style, Tone, Prefix/Suffix, and Importance.

In addition to builtin and extension items, the picker contains:

```text
+ Create Custom Text
+ Create Custom Command
```

Creating a Custom Command asks for its name, command, refresh interval,
timeout, and default tone.

### Item Editor

Depending on the selected item, the editor exposes:

- Style;
- Tone;
- Prefix;
- Suffix;
- Importance;
- Reset to default;
- Custom Text editing;
- Custom Command editing (command, refresh, timeout);
- Rename / Delete for user-owned custom items.

`Tone` is semantic rather than arbitrary RGB/ANSI. The Host remains responsible
for the actual terminal styling.

## Builtin items and styles

Builtin ids currently include:

```text
agent-preset
model
reasoning
permission-preset
sandbox-mode
approval-policy
plan-state
focus-mode
focused-seat
view-scope
cwd
project
git-branch
run-state
queue
tasks
agents
todo
context
cache-hit
token-usage
performance
turns-steps
stats-line
version
ext:*
```

`ext:*` is the compatibility bridge for the legacy aggregate extension Footer
segment. First-class extension items use their own `ext:<owner>/<id>` identity.

Common builtin Style sets include:

| Item | Styles |
| --- | --- |
| Agent preset | `badge`, `compact` |
| Model | `badge`, `plain`, `compact` |
| Permission preset | `badge`, `plain`, `compact` |
| Plan state | `badge`, `plain` |
| Working directory | `short`, `basename`, `full` |
| Git branch | `plain`, `label` |
| Context | `bar`, `percent`, `full` |
| Token usage | `pi`, `io`, `total`, `compact` |
| Cache hit | `pi`, `full`, `compact` |
| Performance | `full`, `speed`, `latency` |
| Turns / steps | `both`, `turns`, `steps` |
| Version | `tui`, `dsh`, `both` |

The `default` preset's second row composes real semantic placements:

```text
token-usage:pi · cache-hit:pi · performance:latency · performance:speed
```

rendering as `↑114M ↓54k R520k W12k · CH93.9% · TTFB 8.1s · 51 tok/s`. The
left group is session cumulative usage; the right group is recent model
performance — the average time-to-first-token and the effective output
throughput over the last five completed model requests (a model/provider
switch resets that window). The session lifetime LLM wall time is still
accumulated and available through `/stats`, but no longer part of the
default Footer row.

Omitting `format` keeps that item's default Style.

The selected Style is a persisted preference. On a narrow terminal the runtime
may render a shorter density form to preserve more useful information; that
does not rewrite the saved Style.

## Custom Text items

Create a Custom Text item from the Add picker:

```text
/footer
→ select row
→ A
→ + Create Custom Text
```

A Custom Text definition belongs to the USER settings layer and uses the
`user:*` id namespace.

A hand-written equivalent looks like:

```yaml
footer: custom

footerCustomItems:
  - schemaVersion: 1
    id: user:environment
    kind: text
    text: prod
    tone: warning

footerLayout:
  schemaVersion: 1
  rows:
    - left:
        - id: model
        - id: user:environment
      right:
        - id: context
```

The custom definition and its placement are separate facts:

- `footerCustomItems` defines what `user:environment` is;
- `footerLayout` decides whether it is visible, where it appears, and whether
  the placement overrides its Tone / Prefix / Suffix / Importance.

Deleting or renaming a custom item through `/footer` also updates the managed
layout references.

## Custom Command Items

Create one from:

```text
/footer
→ select row
→ A
→ + Create Custom Command
```

A Custom Command Item is an ordinary one-line Footer item backed by a local
command.

Example:

```yaml
footer: custom

footerCustomItems:
  - schemaVersion: 1
    id: user:clock
    kind: command
    command: "date '+%H:%M'"
    refreshIntervalMs: 5000
    timeoutMs: 300
    tone: textDim

footerLayout:
  schemaVersion: 1
  rows:
    - left:
        - id: model
        - id: git-branch
      right:
        - id: user:clock
        - id: context
```

The current defaults are:

| Setting | Default / bounds |
| --- | --- |
| `refreshIntervalMs` | default 5000 ms; runtime minimum 1000 ms |
| `timeoutMs` | default 300 ms; runtime range 1..1000 ms |
| rows contributed by one item | exactly 1 |

The cached value is the **first non-empty sanitized stdout line**.

An unsaved command draft is never executed. The configurator can show a
placeholder while editing, but execution starts only after the settings write
succeeds and the committed item is actually authorized and visible.

If an item is hidden, removed, renamed, deleted, or no longer part of the
rendered layout, its per-item runner is stopped and its cache is cleared.

Changing a saved command invalidates the previous generation and starts the new
configuration promptly; stale output from the old process cannot overwrite the
new value.

### Command examples

The exact shell is platform-dependent. On a POSIX shell, simple examples are:

```sh
date '+%H:%M'
```

```sh
git branch --show-current
```

```sh
printf 'vpn up\n'
```

Keep Footer commands fast. A Footer is chrome, not a task runner.

For expensive information, prefer a cheap cached helper command or a plugin
that maintains its own state and only publishes plain Footer data.

## Custom Command Item vs whole-footer command

These are intentionally different features.

| | Custom Command Item | Whole-footer command |
| --- | --- | --- |
| Created in `/footer` | Yes | No |
| Replaces the whole Footer | No | Yes |
| Mixes with builtin items | Yes | No |
| Multiple commands | Multiple items may coexist | One surface command |
| Output rows | One item line | Configurable whole-surface rows |
| Native layout | Still the active layout | Used as fallback |
| Typical use | Clock, branch helper, VPN/battery/build status | Fully custom status-line renderer |

Use a **Custom Command Item** when you only need one dynamic fact.

Use **whole-footer command mode** when you deliberately want to own the entire
status surface.

## Whole-footer command

Whole-footer command mode is configured in the USER settings layer:

```yaml
footer: command

footerCommand:
  schemaVersion: 1
  command: "~/.config/dsh/statusline.sh"
  timeoutMs: 300
  refreshIntervalMs: 1000
  maxRows: 1
```

Current bounds are:

| Setting | Default / bounds |
| --- | --- |
| `refreshIntervalMs` | default 1000 ms; minimum 1000 ms |
| `timeoutMs` | default 300 ms; range 1..1000 ms |
| `maxRows` | default 1; range 1..2 |

The command receives a safe JSON status snapshot on stdin and writes the
surface text to stdout.

Stdout is sanitized before rendering. The Footer accepts the supported styling
subset rather than arbitrary terminal control sequences.

If the command is unavailable, invalid, times out, exits unsuccessfully, or
produces no usable output, the TUI falls back to the native Footer surface.

The Host instruction surface remains Host-owned; a command Footer cannot take
over exit/cancellation instructions.

## Status JSON on stdin

Custom Command Items and the whole-footer command use the same safe status
projection.

The v1 payload has these top-level sections:

```text
schemaVersion
surface
view
composition
access
collaboration
interaction
workspace
activity
usage
host
```

`collaboration` currently carries only `plan`. For example, `workspace.cwd`
is the current display subject's working directory, while
`composition.model` describes the current model when known.

The payload deliberately contains no:

- secrets;
- credentials;
- raw user prompts;
- tool arguments;
- environment dump;
- raw Session events.

A small POSIX example using `jq`:

```sh
#!/bin/sh
payload=$(cat)
cwd=$(printf '%s' "$payload" | jq -r '.workspace.cwd // "-"')
model=$(printf '%s' "$payload" | jq -r '.composition.model.id // "-"')
printf '%s · %s\n' "$model" "$cwd"
```

The protocol is versioned with `schemaVersion: 1`. Scripts should tolerate
optional facts being absent.

## Extension-provided Footer items

Plugins can contribute first-class configurable Footer items through the Stable
extension API:

```text
@xmoon76/dsh-pi-tui/extensions
```

and the slot:

```text
chrome.footer.item
```

From the user's point of view:

- the installed plugin's item appears in `/footer`;
- it can be shown or hidden;
- it can move between Left and Right;
- it can be reordered with builtin and custom items;
- an unloaded plugin leaves the persisted layout reference intact;
- reloading the same plugin can restore the item automatically.

The persisted identity is a canonical key such as:

```text
ext:plugin-name/quota
```

Users normally do not need to write that key by hand.

Extension Footer items are plain Host-rendered data. They do not receive direct
terminal ownership, arbitrary ANSI, cursor control, shell execution, or
keyboard focus through this slot.

Plugin authors should use the full contract in
[Extension API v1](extension-api.md) rather than copying internal TUI code.

## Responsive and narrow-terminal behavior

The Footer is responsive.

For native layouts, width pressure follows this general order:

```text
preferred presentation
→ compact presentation where the item supports one
→ drop lower-importance items
→ safe truncation as the final fallback
```

This means a saved item can become shorter or disappear temporarily when the
terminal is narrow.

That is presentation only:

- the saved Style is not changed;
- the item is not deleted from the layout;
- widening the terminal restores richer output when space is available.

A layout currently contains one or two logical rows. Physical wrapping is
bounded by the Footer's surface budget so Footer chrome cannot grow without
limit and crowd the transcript/editor off screen.

## Raw settings reference

Most users should prefer `/footer`. The raw settings form is useful for
dotfile management or debugging.

### Native custom layout

```yaml
footer: custom

footerLayout:
  schemaVersion: 1
  rows:
    - left:
        - id: agent-preset
          format: compact
        - id: model
        - id: project
        - id: context
          format: full
      right:
        - id: focus-mode
      separator:
        text: " │ "
        tone: textDim
```

Each item reference may also carry supported placement overrides such as Tone,
Prefix, Suffix, and Importance.

Invalid layouts fail soft rather than preventing the TUI from starting.

### Custom definitions

Custom definitions are stored separately from layout references:

```yaml
footerCustomItems:
  - schemaVersion: 1
    id: user:environment
    kind: text
    text: prod

  - schemaVersion: 1
    id: user:clock
    kind: command
    command: "date '+%H:%M'"
    refreshIntervalMs: 5000
    timeoutMs: 300
```

Keeping definition and placement separate lets the same custom definition
survive show/hide/reorder operations without changing what it means.

## Security model

Footer commands are executable local code. Treat them like shell scripts you
chose to run yourself.

The important trust boundary is:

> Repository or project settings must not be able to silently turn Footer
> configuration into shell execution.

For whole-footer command mode, both the mode and command must be owned by the
USER settings layer.

For Custom Command Items, a command definition must be USER-owned and committed,
the USER's current Footer mode/layout must authorize it, and the item must also
be part of the currently rendered layout.

As a result:

- a project cannot provide a command string for execution;
- a project cannot resurrect a dormant command left in USER settings;
- an unsaved `/footer` draft never executes;
- a failed save never executes the draft;
- hiding/removing an item stops its runner;
- whole-footer command mode suspends per-item command runners.

The stdin payload is intentionally free of secrets and prompts, but this does
**not** sandbox the command itself. A local command still runs with the
permissions and environment available to the TUI process.

Keep commands small, auditable, and side-effect-free whenever possible.

## Troubleshooting

### My Custom Command shows nothing

Check, in order:

1. The item was actually saved.
2. `footer` is using the layout that contains the item.
3. The item is present in the currently rendered layout.
4. The command exits successfully.
5. It prints at least one non-empty stdout line.
6. It finishes before `timeoutMs`.
7. Its output is not only unsupported terminal control data.

Prefer testing the command directly in the same shell environment first.

### The command ran in my shell but not from a project config

That is expected.

Executable Footer commands are USER-trusted configuration. Repository/project
configuration is intentionally unable to trigger shell execution.

### An item disappears when I resize the terminal

That is expected responsive behavior.

Builtin items may compact first; lower-importance items may then be omitted
until more width is available. The saved layout is unchanged.

### A plugin Footer item disappeared

The plugin may be unloaded or unavailable.

The layout reference is preserved. Re-enabling/reloading the same plugin can
restore its item without rebuilding the layout.

### I changed a Style but narrow output looks different

Style is the saved preferred presentation. Runtime density may choose a shorter
form under width pressure without modifying that preference.

## Plugin authors

Do not import repository-private TUI internals to add a Footer item.

Use the Stable package boundary:

```text
@xmoon76/dsh-pi-tui/extensions
```

and feature-detect the configurable Footer item capability before relying on
it.

See [Extension API v1](extension-api.md) for the authoritative registration,
ownership, lifecycle, HMR identity, sanitization, and compatibility contract.
