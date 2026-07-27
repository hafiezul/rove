# Gate checkpoint revert on a provider rollback capability

`CheckpointReactor` restores the filesystem checkpoint _before_ calling
`ProviderService.rollbackConversation`. When the provider cannot roll back, the files are already
reverted and the thread ends in a revert-failure activity with a conversation that still contains the
discarded turns. Pi and Grok both hit this today: their adapters fail `rollbackThread`
unconditionally.

We add a conversation-rollback capability to `ProviderAdapterCapabilities`, alongside
`sessionModelSwitch`, and have the revert flow consult it before touching the filesystem. An
unsupported provider — or a Pi thread with no recorded entry ID for the target turn — refuses the
revert up front and leaves the workspace untouched.

A refusal reuses the existing `appendRevertFailureActivity` path, which already renders a
`detail` string as a timeline row. The refusal states that the thread has no recorded Pi position for
that turn and that nothing was changed — no new UI surface is introduced.

## Consequences

- The capability is not static per driver. Pi answers it per thread and per target turn, because it
  depends on whether an entry ID was recorded, so the check takes the revert target as input rather
  than being a constant on the adapter.
- Grok's revert changes from "files reverted, conversation intact, failure row" to "nothing changed,
  refusal row." That is a deliberate user-visible behavior change for a second provider.
