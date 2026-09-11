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
server process, and mitigations live in
ordinary adapter error-handling. Version drift is handled in the opposite direction
from other providers: Rove Code controls the Pi version rather than discovering whatever
the user has installed.

Reversing this decision means rewriting the adapter's transport, but the adapter
boundary (driver + adapter conforming to `ProviderAdapterShape`) hides the swap from
orchestration and clients.

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
