# Model selection in the experimental TSP renderer

The existing `/model` command has PiTui and native TSP presentation adapters.
This is a PR4 implementation candidate, not a finalized UX or a completed PR4
milestone. Direct and PiTui remain the production defaults. TSP uses the existing
experimental renderer opt-in described in [TSP integration](../tern-tsp.md).

## Availability and behavior

The mounted terminal must advertise `picker`, `overlay` and `el` before the
TUI-owned `/model` command becomes available. Older panes refuse the command
before invoking its handler. This admission follows authoritative command
classification; a genuine Host command named `model` retains its Host route.
Other PiTui-only builtins remain unavailable in TSP.

The picker searches model and provider names and IDs. Browsing, pointer
activation and viewing Details do not apply a selection. A model without
advertised reasoning choices requires one explicit confirmation. A model with
reasoning choices first opens an effort page, then requires confirmation of the
complete selection. Provider default omits `reasoningEffort` from the payload.
Back or Escape returns from Details/effort without losing the query or per-model
draft effort; Escape from the list closes the picker.

Before a Session exists, the picker labels the operation **Default for new
sessions** and uses **Save default**. With a live Session it labels the operation
**Use for this session** and uses **Apply**. Current/default values are
authoritative facts, separate from the highlighted row and draft effort. Only
advertised model descriptions and reasoning choices are shown; the catalog
does not supply price, context-window or performance comparisons.

Narrow layouts hide the preview and retain a Details action with a separate
full-page view. Pending saves disable repeated confirmation but allow closing
the presentation. Closing does not cancel an admitted business operation.
Rejected, cancelled and unsupported outcomes leave the picker usable;
indeterminate outcomes close it with the original reconciliation notice.
Directory errors require closing and reopening `/model` to retry.

## Ownership and lifecycle

`src/app/command/model-presentation.ts` is a narrow Client-local presentation
contract. `src/tui/commands/models.ts` remains the singular read/write owner:
it captures Session scope, loads the directory, brands effort IDs, tracks
default-save intentions and admits live selection through the original writer.
Both renderers share the pure projection in
`src/tui/pickers/model-directory.ts`; neither introduces a catalog or writer.

The PiTui adapter retains the existing picker and overlay broker. The native
presenter in `src/tui/tsp/model-picker.ts` owns query, caret, highlight, draft
effort and page state. The official SDK remains the sole tty owner. No new Host
lookup, wire operation, transport cache or public extension API is introduced.

Receiver IDs and pointer callbacks carry an open serial and presentation
revision. Admission rechecks the captured subject, current presentation, phase,
row and effort. Question/Approval owns the first modal seat and suspends Model
input. Resume retokens receivers; hydration and disposal retire the picker
synchronously. Old input and async settlements cannot close or repaint a newly
opened picker. The original default-save tracker still settles admitted writes
after their presentation closes.

## Regression coverage

Build before running artifact-dependent tests, as required by `AGENTS.md`.

```sh
node scripts/run-with-temp-root.mjs node --test \
  test/model-picker.test.ts \
  test/tern-tsp-model-picker.test.ts \
  test/tern-tsp-model-profile.test.ts
```

The native Model tests exercise the official SDK over a scripted tty, the real
runner/classifier/handler, outcome handling, modal precedence, stale receivers,
grapheme search, duplicate confirmation, close/reopen and legacy-pane refusal.
Official Direct Host fixtures additionally observe one live Session selection
and same-name Host command routing. Model endpoints remain scripted.

The profile test removes the historical default-owner stand-in and mounts the
official Loader, ConfigEditor, SettingsForms and default-model service over
isolated real profile documents. It checks one committed save, actual YAML,
volatile Loader update, removal of the previous effort, authoritative reopen
and disk recovery through a fresh Context and Loader, with no Agent or model
request. Its minimal profile contains only the default-model row; it does not
certify a user's full profile, HMR or the unrelated legacy TUI settings marker.
Each fixture documents its reproduced prerequisites and substitutions inline.

## Current UX and qualification limits

The candidate still needs visual refinement: content-sensitive picker sizing,
less repetition of current/default information, consistent typography and
primary-action styling between native and composed pages, and large-directory
provider navigation. The effort confirmation cost and final layout remain
design decisions, rather than measured usability improvements.

Automated and headless evidence does not certify physical mouse/keyboard input,
OS focus, IME, paste, themes, accessibility or long-catalog scrolling. Full
shipped-profile startup/HMR, clean live-Agent teardown and the new Remote TSP
application success path also need separate qualification. These limits do not
change the existing Direct/Remote semantic adapters.

One-time research comparisons, headless screenshots, controls, run logs and
qualification counts are kept outside the repository. This document records
maintainable behavior and boundaries; regression test sources remain in `test/`.
