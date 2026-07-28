# Derive Pi thinking levels instead of probing them per model

Pi's `set_model` is not scoped to the RPC session. It calls
`settingsManager.setDefaultModelAndProvider(...)`, which writes `defaultProvider` and `defaultModel`
into the Pi configuration directory's `settings.json` and persists it.

The catalog probe used to select every model in turn so it could read that model's
`get_available_thinking_levels`, because Pi reports levels for the _currently selected_ model. That
walk ran on the snapshot refresh interval, against the user's real `~/.pi` whenever no per-instance
configuration directory was set. The observable effect was that T3 Code silently rewrote the user's
Pi CLI default model — and, through Pi's re-clamping on model switch, the default thinking level —
every few minutes, to whichever model happened to sort last in the catalog. Picking a model in T3
Code's own model picker had the same effect for the selected model.

The supported levels are a pure function of the model object that `get_available_models` already
returns: Pi's `getSupportedThinkingLevels` reads `reasoning` and `thinkingLevelMap` and nothing else.
We reproduce that derivation in `derivePiThinkingLevels` and drop the `set_model` walk entirely. This
was checked against a live Pi 0.82.1 across a 27-model catalog: the derived levels matched the RPC
response for every model.

## Consequences

- The catalog probe is read-only with respect to Pi's settings, and is also cheaper: it no longer
  issues three RPC round trips per model.
- `derivePiThinkingLevels` restates a rule owned by `@earendil-works/pi-ai`. If Pi changes how a
  model expresses supported levels, the derivation must be updated with it; the RPC response is the
  reference to check against.
- Only Pi's already-selected model reports a `currentThinkingLevel`, because that is the only model
  whose live level can be read without selecting it.
- Applying a model to a live session still calls `set_model`, which still writes Pi's defaults. That
  is a deliberate user action on a session they are using, not unattended background probing.
