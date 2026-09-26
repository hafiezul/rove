# Pi provider uses the bundled SDK in an isolated instance process

Rove Code controls the Pi SDK version as a normal dependency rather than invoking
the user's installed `pi --mode rpc`. The SDK supplies extension loading, typed
events, model implementations, session history, and tree navigation.

Each Pi driver instance owns one Rove child process. Its environment receives the
instance's resolved `PI_CODING_AGENT_DIR` at spawn, before loading the SDK or any
extensions. The server never changes its own agent-directory environment. This
matters because extensions can create SDK sessions with default settings, read
the environment themselves, or spawn another Pi process. Passing `agentDir` only
to Rove's parent session does not configure those paths. Extension-specific launch
metadata cannot fix extensions that do not consume it.

A subprocess rather than a worker thread also supports extensions that use
process APIs such as `process.chdir()`. This is configuration and crash isolation,
not a security sandbox: extensions still run with the server account's filesystem
and network access. Extensions that explicitly override the directory or discard
their inherited environment remain responsible for that choice.

The catalog, thread sessions, and tool-free text-generation sessions live together
inside the instance process. This preserves shared extension model implementations
without attempting to serialize functions. Project resources remain scoped to
thread loaders; the catalog loads only global resources from a neutral cwd at the
agent directory. One process per instance avoids a Node/SDK process per idle thread,
but an extension crash or hang affects all sessions in that instance. Other Pi
instances and the server remain independent.

The driver communicates through private typed IPC, not stdout (which extensions
may write to). Thread-authorized Rove tools retain their existing HTTP/MCP channel;
only their scoped configuration crosses IPC. The server mirrors session state for
the adapter's synchronous reads. History updates carry changed suffixes, assistant
streaming events omit cumulative snapshots, and tool progress is sampled and bounded
before crossing IPC. Final tool results remain intact. A stalled IPC consumer has
a bounded message queue and fails the instance rather than accumulating indefinitely.

Startup and prompt preparation have parent-owned deadlines. Accepted prompts are
not automatically replayed after process failure: tools may already have run.
Disposal first requests SDK cleanup, then terminates only the captured child if it
does not finish. Persisted session cursors support an explicit restart/resume. The
single-executable build hosts the same runtime as a hidden subcommand; Node builds
ship it as a sibling bundle entry.

Thread extension binding remains deferred until the first routed prompt. A
`session_start` hook can open a dialog, but `ProviderService` cannot route its answer
until `startSession` returns and its binding is persisted. Opening a dialog accepts
the pending prompt before waiting for the answer. IPC must continue handling Stop
and dialog responses while a prompt is pending; do not serialize requests behind
prompt completion.
