# Reconcile provider sessions at boot

Provider session liveness is persisted (`provider_session_runtime.status`, `projection_thread_sessions.active_turn_id`) but every provider process is a child of the server, so a restart leaves rows claiming turns that no process is running; the reaper cannot repair them because it deliberately skips threads with an active turn. At startup, after reactors are running and before the welcome event is published, T3 Code now sweeps every non-stopped runtime row and feeds synthetic `turn.completed{state:"interrupted"}` and `session.exited` events into `ProviderRuntimeIngestion`, so clients never observe a stale running turn.

## Considered options

Deriving liveness from a per-boot epoch stamp was rejected: it leaves the append-only log asserting a turn that never ended, and every consumer — sidebar, mobile thread list, relay Live Activity — would have to learn the epoch rule independently. Repairing only the stop path was rejected as insufficient: a thread the user never opens would stay "Working" forever.

## Consequences

Synthetic provider events are written for turns no provider reported on, so a turn that genuinely completed in the provider's own storage immediately before the crash is recorded as interrupted. The sweep assumes a fresh server owns zero provider processes, which does not hold if two servers ever share one SQLite database.
