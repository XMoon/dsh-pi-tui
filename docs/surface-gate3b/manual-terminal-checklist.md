# Gate-3B manual terminal checklist

## Availability and result

**Current result: `M-01..M-07 NOT_RUN (ENV_UNAVAILABLE)`.** This execution environment exposes no interactive operator terminal, system clipboard/OSC52, tmux/SSH session, IME composition, or physical CJK-font configuration to the agent. No real-terminal artifacts were captured. `VirtualTerminal`, CI, test callbacks and generated screenshots are not substitutes. No Owner waiver exists.

For every run, record the operator, date, terminal/version, OS, SSH/tmux versions where relevant, columns×rows, font/CJK width configuration, locale, display mode, DSH mode/version, exact test steps, expected/actual, evidence link, and cleanup/restoration. Use synthetic nonsecret content only; redact prompts, command histories, credentials and clipboard data.

## M-01 — Job Command exactness

**Status:** `NOT_RUN (ENV_UNAVAILABLE)`<br>
**Next operator:** operator with a real local terminal and clipboard; repeat over tmux/SSH if available.

1. Start a safe Bash and Pwsh background Job with a known synthetic command containing leading/trailing spaces, repeated inner spaces, a tab, CJK and a newline where supported.
2. Open `/tasks`, select the Job, click the Command summary and click Copy All. Paste into a local scratch file and compare exact UTF-8 bytes with the source fixture.
3. Drag-copy a middle multiline/wrapped substring; ensure offscreen text is excluded. Record clipboard rejection truthfully.

Expected: exact original bytes, not screen-truncated or trimmed text. Preserve only a sanitized byte/hash comparison.

## M-02 — Job Follow, Find and exit

**Status:** `NOT_RUN (ENV_UNAVAILABLE)`<br>
**Next operator:** operator with a real terminal; tmux/SSH if supported.

1. Produce retained output longer than the viewport. Open the Job, scroll/PgUp, search with Ctrl+F and `/`, Esc/Back, End, switch Command↔Output, exit/reopen, then settle the Job.
2. Capture a short screen recording or before/after frames showing paused follow and explicit End recovery.

Expected: manual browsing remains paused until End; no global Find/editor input capture; no stale observer or new-view overwrite.

## M-03 — Settings write

**Status:** `NOT_RUN (ENV_UNAVAILABLE)`<br>
**Next operator:** operator with a reversible nonproduction profile/settings fixture.

1. Open `/settings`, change a safe Appearance/Display value, leave and reopen, and verify the authoritative value and scope.
2. Exercise a rejected/unavailable value only with a safe fixture; repeat at 120×40, 80×24, 44×24 and 80×10.
3. Restore the original value and record the restoration.

Expected: persisted value and scope agree; failure is truthful; no unrelated/default scope is overwritten.

## M-04 — History and IME

**Status:** `NOT_RUN (ENV_UNAVAILABLE)`<br>
**Next operator:** operator with a real IME-capable terminal and safe local History data.

1. With a nonempty CJK/multiline draft, open History, search, scroll Preview, Copy All, Enter-accept without submitting, then reopen and Esc to restore the original draft/cursor.
2. During IME composition/autocomplete, attempt `↓` at the last visual line. If safe, trigger Question/Approval PARK and settlement.

Expected: draft/cursor/IME state is preserved; no accidental Quick entry/submit; no phantom focus; copied preview is exact.

## M-05 — Task Quick and widgetsBelow

**Status:** `NOT_RUN (ENV_UNAVAILABLE)`<br>
**Next operator:** operator with a trusted local `input.widget.below` provider and at least one real synthetic Job.

1. In separate runs, expose one, two and three below-widget rows. At 80×24, 80×10, 80×8 and 44×24 (CJK), exercise Main and Fullscreen where supported.
2. Confirm Footer badge, hidden Quick zero-row state, last-visual-line `↓`, scrolling/wheel, typed Job/Question entry, Esc/first Up, resize, and `➜ Open Task Center…` via Enter and Fullscreen click.

Expected: widget rows and Footer stay truthful; active Quick respects budgets; real-task N excludes the Full action; Full opens once. Preserve/document the accepted Main Root 80×8 flowing exception; do not reduce widget grants to manufacture a pass.

## M-06 — Clipboard, SSH and tmux

**Status:** `NOT_RUN (ENV_UNAVAILABLE)`<br>
**Next operator:** operator with a local clipboard and supported tmux/SSH path.

1. Repeat one Job selection/Copy All and one History Copy All over each locally supported remote/tmux path; paste into a terminal/editor and exercise clipboard denial.

Expected: distinguish OSC52 delivery, OS clipboard availability and rejection/not-supported. Do not infer one from another.

## M-07 — Appearance, themes and CJK width

**Status:** `NOT_RUN (ENV_UNAVAILABLE)`<br>
**Next operator:** operator with physical 44/80/120-column terminals, dark/light/custom themes and a CJK-capable font.

1. Render Job, Settings, History and Task Quick at each width/theme. Capture `➜`, status, selection `>`, dividers, truncated actions and Esc hints.

Expected: no double highlight, ghost wrap or ambiguous new glyph; physical rows match the bounded budgets. Library width arithmetic alone is insufficient.

## Waiver and closure rule

Any material M case still `NOT_RUN` at freeze leaves the Gate `PENDING_MANUAL` / `NOT_READY_FOR_UNQUALIFIED_ACCEPTANCE`. Only the Owner may issue an explicit, scoped waiver naming the exact tests and residual risks; none is recorded here. No Phase 3C work is authorized by this checklist.
