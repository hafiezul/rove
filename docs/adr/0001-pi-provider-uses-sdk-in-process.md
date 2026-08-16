# Pi provider embeds the Pi SDK in-process instead of spawning `pi --mode rpc`

Every other Rove provider driver integrates across a process boundary: a spawned CLI
or a managed server, with events decoded from JSON lines or a wire protocol. The Pi
driver instead imports `createAgentSession` from `@earendil-works/pi-coding-agent`
and runs Pi sessions inside the Rove server process, with the package pinned as a
normal dependency and updated deliberately through the existing provider-maintenance
machinery.

This follows Pi's own guidance for Node/TypeScript hosts (its RPC mode is itself
implemented on the SDK) and buys the things an event-heavy adapter needs most:
discriminated-union event types instead of hand-validated JSONL, synchronous state
reads (`session.messages`, `session.agent.state`) for `readThread`/`hasSession`, and
typed session-replacement APIs (`fork`, used for fork-as-rollback).

The rejected alternative — spawning `pi --mode rpc` per thread — offers crash
isolation and runs the user's exact installed binary. We accepted the loss of
isolation deliberately: a misbehaving Pi session (or a globally installed extension,
once extension loading ships) can affect the server process, and mitigations live in
ordinary adapter error-handling. Version drift is handled in the opposite direction
from other providers: Rove controls the Pi version rather than discovering whatever
the user has installed.

Reversing this decision means rewriting the adapter's transport, but the adapter
boundary (driver + adapter conforming to `ProviderAdapterShape`) hides the swap from
orchestration and clients.
