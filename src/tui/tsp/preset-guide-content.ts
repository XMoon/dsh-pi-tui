/** The official English Mode Guides of the four SHIPPED presets.
 *
 * The copy is a verbatim transcription of the official Web surface's curated
 * help, pinned to
 * `deepseek-ai/deepseek-harness@d743267388641bc76f17c45ce8b4c231aed1d32c`
 * `packages/client/ui-agent-preset/src/client/guide-locales.ts` (the `guideEn`
 * seat): the intro, the mode explanation and the usage examples, unchanged.
 * Refreshing the official wording means refreshing that pin — this module never
 * translates, rewrites or generates guide text of its own.
 *
 * Source license: the upstream repository is MIT (`Copyright (c) 2026
 * DeepSeek`); this transcription keeps the upstream wording and attributes the
 * source in this header rather than duplicating a license file, per the
 * repository's vendoring-attribution practice for small quoted excerpts.
 *
 * The Guide is READ-ONLY static content: it is not part of the live roster and
 * carries no business authority. A Custom declaration that reuses a shipped id
 * must never borrow an official Guide, so the lookup requires the caller's
 * ALREADY-DERIVED shipped classification instead of trusting the id alone.
 * @module tui/tsp/preset-guide-content
 */

/** The two Markdown sections the official Web dialog renders, in order. */
export const GUIDE_SECTION_HEADS = {
  modeDetails: 'Mode details',
  howToUse: 'How to use',
} as const

/** One shipped preset's official English Guide copy, in the official reading order. */
interface BuiltInGuideCopy {
  readonly intro: string
  readonly explanation: string
  readonly usage: string
}

/** The four shipped presets' pinned official copy, keyed by shipped id. */
const BUILT_IN_GUIDES: Readonly<Record<string, BuiltInGuideCopy>> = {
  standard: {
    intro: 'Choose Standard mode when starting a new task. Describe what you want to accomplish, point to the relevant files, and explain how to check the result.',
    explanation: [
      '### How it works',
      'The agent calls tools directly to read and edit files, search, and run terminal commands. It includes Skills, planning, goals, subagents, workflows, and context compaction.',
      '### When to choose it',
      'Start here for everyday coding, file work, and research. Standard mode can also write scripts and process files in batches. PTC changes how tool calls are organized; it is not required for batch tasks.',
    ].join('\n\n'),
    usage: [
      '### Fix a bug',
      '> Find out why submitting the search form twice makes the results disappear. Fix it and run the relevant tests. Explain the cause and what changed.',
      'Expected output: a code change, the relevant test results, and an explanation of the cause.',
      '### Organize project notes',
      '> Read the Markdown notes in this project. Summarize the agreed decisions and open questions, with links to the source files.',
      'Expected output: a summary with references that you can check against the original notes.',
    ].join('\n\n'),
  },
  ptc: {
    intro: 'Choose PTC mode when starting a new task. Specify the input files, processing rules, and output format. The agent writes the code.',
    explanation: [
      '### How tools are called',
      'PTC means Programmatic Tool Calling. In this built-in preset, the agent uses run_code to write a TypeScript program that calls tools through a generated SDK. The program can use loops, conditions, error handling, and concurrent calls where appropriate.',
      '### What reaches the model',
      'Tool results first reach the program, which can filter and combine them. The model receives what the program prints or returns; image results are attached separately. Nested tool calls are still recorded and remain subject to tool permissions.',
      '### Compared with Standard mode',
      'Both modes can handle coding and batch tasks. Standard mode exposes individual tools directly; PTC organizes tool calls in code. The current PTC preset leaves the workflow tool disabled. Speed and token use depend on the task and how the program handles its results.',
    ].join('\n\n'),
    usage: [
      '### Check a set of configuration files',
      '> Check all JSON files in configs/. List missing required fields and invalid values against schema.json. Save a CSV with one row per issue. Include unreadable files in the report and keep checking the rest. Leave the original files unchanged.',
      'Expected output: an issue summary and a CSV report. The program can repeat the same checks, handle individual failures, and collect the results.',
      '### Summarize error logs',
      '> Analyze the log files in logs/. Group errors by service and error type. Show the ten most frequent groups and one example from each. Save the full counts to a CSV.',
      'Expected output: the top error groups and a complete count table. Intermediate data can be aggregated in the program before the summary reaches the model.',
    ].join('\n\n'),
  },
  minimal: {
    intro: 'Choose Minimal mode for a new task. For a comparison, hold the model, permissions, input, and starting workspace state constant across runs.',
    explanation: [
      '### What is included',
      'One persistent shell tool and a fixed system prompt. The built-in preset does not load Skills, planning, context compaction, or the standard runtime context.',
      '### When to choose it',
      'Use it as a baseline for experiments and comparisons. It can still read files and execute scripts through shell commands, but offers fewer built-in ways to manage a long task. Fewer tools does not necessarily make it easier for a beginner.',
    ].join('\n\n'),
    usage: [
      '### Compare performance on a small bug fix',
      '> Run the tests for this project, find the cause of the failure, and make the smallest fix. Run the relevant tests again and report the result.',
      'Run the same task separately in Standard and Minimal modes from the same starting state. Compare task completion, tool calls, and the resulting changes. Minimal mode performs the work through terminal commands.',
    ].join('\n\n'),
  },
  cordis: {
    intro: 'Choose Creator mode for a new task. Describe the capability you want, where it should appear, and how you will verify it.',
    explanation: [
      '### What you can create',
      'Creator mode includes the standard task tools plus runtime inspection, persistent plugin management, and guidance for authoring Cordis plugins and agent presets. It can create a plugin that adds a capability or UI, or a preset that combines tools and prompts for a particular job.',
      '### Plugins and modes',
      'A plugin adds capabilities to DSH, such as a tool, a service connection, or a UI entry. A mode is an agent preset that selects tools and defines how the agent works in a task. A plugin can be included in a custom preset.',
      '### How the result takes effect',
      'Ask the agent to install and verify the result, not just generate source code. A plugin may load immediately or require a restart, depending on what it changes. A newly created preset is selected when starting a new task.',
    ].join('\n\n'),
    usage: [
      '### Add a UI',
      '> Create a DSH plugin that adds a project notes entry to the sidebar. Let me browse the Markdown files in this workspace and preview a selected note. Install it and verify that the page opens.',
      'Expected output: an installed plugin with a working entry and preview page, plus any remaining activation steps.',
      '### Add a tool',
      '> Create a plugin with a tool that reads this project’s test report and summarizes the failed tests. Register it and verify it with a sample report.',
      'Expected output: a plugin with a callable tool and a verified sample call.',
      '### Create my own mode',
      '> Create a “Code review” mode based on Standard mode. Have it prioritize potential bugs and test gaps, cite file paths and lines, and ask before modifying files. Save it as a selectable preset.',
      'Expected output: a custom preset for new tasks. These review instructions guide the agent; permission settings determine which actions it can execute.',
    ].join('\n\n'),
  },
}

/**
 * The complete read-only Markdown body of one shipped preset's Mode guide: the
 * two official sections the Web dialog shows, rendered as ONE continuous
 * scrolling body instead of behind a second layer of tabs or a modal.
 */
function copyMarkdown(copy: BuiltInGuideCopy): string {
  return [
    `## ${GUIDE_SECTION_HEADS.modeDetails}`,
    copy.intro,
    copy.explanation,
    `## ${GUIDE_SECTION_HEADS.howToUse}`,
    copy.usage,
  ].join('\n\n')
}

/**
 * The official Mode guide of one row, or `undefined` when the row must not have
 * one.
 *
 * `builtIn` is the row's ALREADY-DERIVED shipped classification — the value
 * `isBuiltInPresetRow` produced from the raw roster DTO. It is checked FIRST and
 * on its own: the shipped-id table is consulted only for a row the official
 * classification really calls shipped, so a user declaration that happens to
 * reuse `standard`/`ptc`/`minimal`/`cordis` (and therefore publishes its own
 * `name`) keeps its own copy and never inherits an official Guide.
 */
export function builtInGuide(row: { readonly id: string; readonly builtIn: boolean }): string | undefined {
  if (!row.builtIn) return undefined
  const copy = BUILT_IN_GUIDES[row.id]
  return copy === undefined ? undefined : copyMarkdown(copy)
}
