# Pi subagents are observed through the processes and agents they start

Pi has no subagent API. Each subagent extension invents its own: some relaunch
the Pi CLI, some start a detached runner that launches Pi later, some run an
agent inside the parent process, some call a model directly, and some start
another agent CLI such as `claude` or `codex`. Their tool results all have
different shapes. Rove Code used to read one extension's result shape, which
showed nothing for every other extension, and a second shape-reader was removed
because it parsed notification text and broke whenever the extension changed.

Rove Code instead watches what every subagent extension must do: start an agent
somewhere. It never reads an extension's own result format.

## What Rove Code hooks

All of this lives in Rove Code; nothing is installed into extensions or Pi.

- **Tool-call context.** In the Pi runtime worker, every tool of a thread's
  agent runs inside an `AsyncLocalStorage` context naming the thread and the
  tool call (`PiAgentObserver.ts`). Agents run tools through `agent.state.tools`,
  so Rove Code wraps what that property returns.
- **Process starts.** The agent hook (`PiAgentHook.ts`) wraps `child_process` in
  the worker. A process started inside a tool call gets `ROVE_AGENT_PARENT`
  (thread and tool call) and `NODE_OPTIONS=--require <hook>`. The hook therefore
  loads in every Node descendant, including detached runners and Pi binaries
  found on `PATH`, and attribution survives the tool call returning.
- **Pi children.** When the hook sees a Pi CLI start (by `package.json` name,
  or the hosted CLI entry), it adds itself with `-e`. Pi loads explicit `-e`
  extensions even with `--no-extensions`. As an extension, it reports the
  child's model, prompt, tool calls, replies, and usage through public extension
  events.
- **In-process agents.** Extensions share the worker's Pi SDK modules, so one
  patch of pi-agent-core's `Agent.runWithLifecycle` sees any agent run that
  starts inside a tool call.
- **Direct model calls.** A pi-ai `AssistantMessageEventStream` that first
  pushes inside a tool (not inside an agent loop) is tool code calling a model.
  Each tool call's model calls become one row.
- **Agent CLIs.** The process wrapper recognizes common agent CLIs by command
  name, directly or at the start of a shell command line, and reads their
  JSON-lines output by tapping the stdout stream's `push`, which does not change
  how the extension consumes it. Runs that exit quickly without output (such as
  `--version`) never become rows.

## Transport and transcripts

Every observation is one transcript entry. Its writer appends it synchronously
to `<stateDir>/agent-transcripts/<threadId>/<agentId>.jsonl`, then sends it to
the worker over a local socket for live status. When a process exits, the
worker replays that agent's file, so entries still in flight are not lost. The
files survive Rove Code restarts and are removed with the thread.
`PiAgentRoster.ts` folds entries into ordinary `task.*` rows; a tool call that
starts two or more agents becomes a group. The client reads a transcript only
through `orchestration.getAgentTranscript`, which takes a thread and task id,
never a path.

## What is not observable

- Agents on another machine (SSH, remote runners): only the local client
  process is visible.
- Agents that are not Node programs and are not recognized agent CLIs, or agent
  CLIs started from a script file rather than a command line: Rove Code cannot
  tell them from any other program.
- Processes started with `spawnSync` from the worker report only their exit,
  because the worker is blocked while they run.
- An extension that strips `NODE_OPTIONS` from the environment it passes to a
  Pi child it does not start directly.
- Agent names an extension keeps to itself. Rows are titled from the child's
  session name or first prompt; the role is the tool that started it.
- After a restart, rows of agents that were running show as interrupted. Their
  transcripts keep growing, because children write them directly.

## Rejected alternatives

- **Per-extension result readers.** They cater to one extension and break when
  it changes.
- **Watching Pi's session directory.** Children are not attributable to a
  thread or tool call without the environment marker, and children run with
  `--no-session` write nothing. Observed children report their session file
  path instead, which the agent detail view shows.
- **Sampling the process tree** (`native/resource-monitor`). It is an optional
  server-wide sidecar, cannot attribute a process to a tool call, and cannot
  tell an agent from any other program. Process interception already covers
  every attributable case.

## Consequences

`Agent.runWithLifecycle`, the `state.tools` accessor, and pi-ai's event stream
`push` are SDK internals. A Pi SDK upgrade that renames them disables that one
source without breaking sessions; the observer end-to-end test
(`PiAgentObserver.test.ts`) catches it. The hook is serialized with
`Function.prototype.toString`, so it must stay self-contained.
