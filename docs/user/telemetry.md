# Product usage data

The Rove Code server sends product usage events to Rove's PostHog project, associated with a
hashed random installation identifier. Provider account IDs are not used. Events include the
provider, model, reasoning effort, permission mode, turn result, duration, and main-agent token
totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, set `ROVE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent and prevents analytics from
accessing or creating the installation identifier.
