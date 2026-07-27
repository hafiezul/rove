# Record Pi entry IDs per turn to target a rollback

Pi's `fork` takes an entry ID, but T3 Code's revert asks for a _count_ of turns to drop. Counting
backwards through `get_fork_messages` is unsafe: it walks every session entry, so it includes
abandoned branches and pre-compaction history, and it silently omits user turns whose text is empty
(an image-only prompt). Counting can therefore fork from the wrong point without any signal.

We record the Pi entry ID for each turn as it happens and store it in the session binding's
`runtimePayload`, which is already durable and merges on update. A revert forks from an exact
recorded entry, with no counting. Entry IDs survive the fork — `createBranchedSession` copies
retained entries with their IDs intact — so repeated reverts need no remapping.

The anchor is captured with a `get_entries` probe when a turn settles, not while it streams. Pi's
streamed messages carry no entry ID — verified against the RPC message types and a live probe — so
there is nothing to piggyback on. Probing at settle costs one round trip per turn against a local
process, and only needs the response's `leafId` plus the trailing user entry.

## Consequences

- Threads that predate this change, and any turn whose entry ID was not captured, have no target.
  Those reverts fail rather than guess; see ADR 0019 for where that check happens.
- A turn interrupted or lost to transport failure records no anchor. That is correct: the revert
  target must be a position Pi actually persisted.
