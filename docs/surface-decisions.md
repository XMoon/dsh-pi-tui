# Surface decisions: plain-exit, queue notices, credential targets

Small user-visible behaviors that each needed a decision; kept in one doc
so a contributor can find the rationale without reading every file.

## Plain `exit` quits the TUI

Typing exactly `exit` (trimmed, lowercase) in the editor and pressing Enter
quits the TUI — shell muscle memory. The intercept sits at the very top of
the runner's `dispatchUserInput`, BEFORE session creation and before the
busy-Enter steer gate, so `exit` never births a session and always quits
regardless of the delivery preference. `/exit` remains the command form;
any other prompt (including `exit!` or `Exit`) still goes to the model.

## Background-subagent settlement notices never appear in the queue pane

The queue pane is the mirror of the agent's inbox and therefore a
USER-INPUT surface (kimi's queue pane lists only queued prompts). dsh
pushes two kinds of background-subagent notices into the parent's inbox:

- continuable children: `source.kind === 'subagent-settled'` (the
  continuation manager's settlement notice);
- one-shot background subagent jobs: `tool-jobs` completion notices whose
  summary starts with `subagent `.

Both are the runtime's account of a child ending, not steerable input, so
the queue mirror drops them (`isSubagentSettlementNotice`). The task
browser is their surface: terminal job rows (one-shot), inactive child rows
(continuable), `/subagents` for transcripts. A FAILED settlement
additionally surfaces once as a transient error notify
(`subagentNoticeIsFailure`, classified on the producers' deterministic
wording — "finished and" is the only success phrasing for
`subagent-settled`; `[status: failed|killed]` for tool-jobs). The dsh-side
delivery is unchanged: the parent model still receives the notice; only the
TUI's queue mirror filters it. Bash-job notices stay in the queue.

Classification helpers: `src/index.ts` (`isSubagentSettlementNotice`,
`subagentNoticeIsFailure`), pinned by `test/queue-notices.test.ts`.

## /login and /logout resolve credential targets, not just DEEPSEEK_API_KEY

The official deepseek adapter authenticates through `DEEPSEEK_API_KEY`;
the llm-pi-ai adapter (a multi-provider seam) declares one route per
provider, each carrying its own `apiKeyEnv` credential ref in the
`llm-pi-ai` settings section (`providers.<route>.apiKeyEnv`). /login and
/logout resolve their argument against that set:

- no argument → a picker of `deepseek official (DEEPSEEK_API_KEY)` plus
  every llm-pi-ai route (deduped by ref), then the key-entry question;
- an argument matching a route name (or its first word, so `/login
  deepseek` reaches the official entry) → that route's `apiKeyEnv`;
- an env-var-looking argument (`OPENAI_API_KEY`, `MY_CUSTOM_KEY`) → used
  verbatim, uppercased when typed lowercase (the original escape hatch —
  `/login my_custom_key` sets `MY_CUSTOM_KEY` exactly like the old
  `.toUpperCase()` did);
- anything else → an error listing the valid options.

Without the settings service (or the llm-pi-ai section) the option set
degrades to the official target only, preserving the old behavior.
Resolution helpers: `src/commands.ts` (`credentialOptionsFor`,
`resolveCredentialArg`), pinned by `test/login-credentials.test.ts`.
