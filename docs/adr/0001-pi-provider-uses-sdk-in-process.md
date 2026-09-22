# Pi provider embeds the Pi SDK in-process instead of spawning `pi --mode rpc`

Every other Rove Code provider driver integrates across a process boundary: a spawned CLI
or a managed server, with events decoded from JSON lines or a wire protocol. The Pi
driver instead imports `createAgentSession` from `@earendil-works/pi-coding-agent`
and runs Pi sessions inside the Rove Code server process, with the package pinned as a
normal dependency and updated deliberately through the existing provider-maintenance
machinery.

This follows Pi's own guidance for Node/TypeScript hosts (its RPC mode is itself
implemented on the SDK) and buys the things an event-heavy adapter needs most:
discriminated-union event types instead of hand-validated JSONL, synchronous state
reads (`session.messages`, `session.agent.state`) for `readThread`/`hasSession`, and
typed session-replacement APIs (`fork`, used for fork-as-rollback).

The rejected alternative — spawning `pi --mode rpc` per thread — offers crash
isolation and runs the user's exact installed binary. We accepted the loss of
isolation deliberately. A misbehaving Pi session or loaded extension can affect the
server process. Adapter exception handling only covers thrown/rejected failures;
it cannot contain an infinite loop, `process.exit`, or native crashes. Version drift is handled in the opposite direction
from other providers: Rove Code controls the Pi version rather than discovering whatever
the user has installed.

Reversing this decision means rewriting the adapter's transport, but the adapter
boundary (driver + adapter conforming to `ProviderAdapterShape`) hides the swap from
orchestration and clients.

## Containment review: SDK-backed child process

The in-process decision remains in force. A stronger alternative is a **Rove-owned
child process using the bundled SDK**, not the user's CLI or `pi --mode rpc`.
This retains deliberate SDK upgrades and the adapter contract while moving
extension execution out of the server process.

A useful first boundary is one child per thread session, with a separate child
for the provider catalog host. A single shared child is cheaper but lets one
extension take down all Pi threads. Isolating only thread sessions leaves global
catalog extensions able to take down the server. Background text-generation
sessions run in-process as well: in-memory, extension-free, and tool-free, so
they carry no project trust and cannot execute anything.

Before adopting this design, prototype and measure:

- Startup latency and resident memory with many idle threads.
- Typed request/response IPC for prompts, model changes, snapshots, fork, and
  disposal; ordered runtime events with bounded progress and backpressure.
- Remote Rove tool calls routed back to the server with the existing thread
  authorization, rather than exposing server internals in the child.
- Parent-owned deadlines and termination of only the spawned child; classify
  child exit as a recoverable session failure, preserving the persisted cursor.
  Never automatically replay an accepted prompt: its tools may already have run.
- Credential/config sharing, extension registrations, headless hooks, and
  packaging on all supported server/desktop platforms.

Current hardening bounds resource startup to 60 seconds and asynchronous disposal
to 5 seconds, disposes resources that arrive after cancellation, and samples tool
progress before queueing it (two 1,024-character snapshots per second per session).
Final tool results remain authoritative and are not truncated by this sampling.
These are responsiveness safeguards, **not fault isolation**. A blocked event loop
also blocks deadlines. A child-process migration should supersede this ADR only
after validating the above lifecycle and performance trade-offs.

## Catalog host (provider-level extension models)

Thread-scoped extension loading put models behind per-thread preparation:
open thread, wait for a session, then read its catalog. Pickers, defaults,
and selection validation all read the static provider snapshot instead, so
extension models were visible but unselectable there.

Each Pi driver instance now keeps one catalog host: a long-lived session
that loads global extensions only (neutral cwd at the agent directory, so
no project resources resolve) and publishes their models into the provider
snapshot. Registration events republish; the provider health interval
backstops a missed push. Thread sessions keep full per-thread loading for
tools, hooks, and project extensions. A broken global extension degrades
the catalog with a warning instead of failing the driver.

The rejected alternative — full extension loading at provider level — would
leak project tools, hooks, and trust decisions across projects sharing one
runtime. The other rejected alternative — keeping thread-owned preparation —
kept the phantom-session, expiry, and validation-patch machinery this
removes.
