# Pi conversation rollback forks a new native session

T3 Code's revert-to-message flow restores the filesystem checkpoint and then asks the provider to
roll its conversation back by N turns. Pi's RPC surface has no in-place branch command — the TUI's
`/tree` leaf move is not exposed — so the only way to truncate a Pi conversation is `fork`, which
writes a _new_ session file and swaps the runtime onto it. We accept the fork: reverting a Pi thread
changes its native session identity.

This amends ADR 0002. The thread ID is the _initial_ Pi session ID; after a revert the thread's
resume cursor is authoritative, carrying the forked session file and ID, and continuation relaunches
Pi with `--session <path>` rather than `--session-id <thread id>`. The Pi Session Directory stays
isolated per runtime instance, so the fork lands beside its origin and Pi Continuation Compatibility
is unaffected.

## Consequences

- A reverted Pi thread no longer has a session file named after its thread ID. The documented
  "launch Pi with `--session-dir` and pick the saved session" recipe still works, but the mapping is
  no longer by name.
- `ProviderService.rollbackConversation` must re-persist the session binding after a successful
  rollback, otherwise the post-fork resume cursor is lost on restart and the thread resumes the
  pre-revert conversation.
- Forked sessions accumulate in the instance's session directory. Pi records the origin in the
  session header's `parentSession`, so the chain remains inspectable. We deliberately do not delete
  the pre-revert session: it is the only remaining record of the discarded turns, deleting it would
  break the `parentSession` chain, and Pi's own `/fork` leaves originals in place.
