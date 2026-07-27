# Pi text generation runs as an isolated one-shot print-mode process

Pi was the only provider whose `textGeneration` failed outright, so commit messages, PR content,
branch names, and thread titles errored whenever a Pi instance was the selected text-generation
model. T3 Code will implement them by spawning the instance's Pi binary in print mode
(`pi -p`) with a deliberately minimal launch profile, rather than reusing the conversation
runtime's RPC session.

The run inherits only `binaryPath`, `configDirectory` (as `PI_CODING_AGENT_DIR`), and the instance
environment. It ignores `launchArgs` and `trustedExtensions`, and passes `--no-session`,
`--no-approve`, `--no-tools`, `--no-extensions`, `--no-skills`, `--no-context-files`, and
`--no-prompt-templates`. Generating a commit message must not execute bash, load an extension, or
read `AGENTS.md`. `--no-approve` is required because print mode never prompts for project trust and
otherwise falls back to the user's global `defaultProjectTrust`; without it, a user who set
`"always"` would silently load project-local `.pi` resources and the isolation guarantee would be
conditional on a setting T3 Code cannot observe.

## Consequences

Pi has no `--json-schema` or `--output-schema` equivalent, so structured output is not enforced by
the CLI. Sampling showed Pi wrapping the JSON object in prose and markdown fences in most runs even
under a hardened system prompt. Results are therefore recovered with `extractJsonObject` (as
`GrokTextGeneration` already does) and, on a decode failure, one corrective retry. This is weaker
than the Claude and Codex paths, which get schema enforcement from the CLI itself.

Model selection is passed as separate `--provider` and `--model` arguments rather than a combined
`provider/id` slug, because Pi model IDs may themselves contain a slash (for example
`rootsys.cloud` / `fiq/kimi-k3`), which makes the combined form ambiguous.

Thinking level is forced to `off` rather than honoring the selection's `reasoningEffort`, mirroring
Codex's hardcoded `low`; these are not reasoning tasks. Image attachments are described in the
prompt text but never sent as image content, matching `CursorTextGeneration`, so screenshot-only
messages lose visual context when generating a thread title.
