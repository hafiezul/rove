# Require Pi 0.82.0 or later

The Pi integration is designed against Pi CLI 0.82.0, including its RPC model discovery, lifecycle events, extension UI protocol, `get_commands` skill and extension-command discovery, native session handling, and tool-policy behavior. T3 Code will require Pi 0.82.0 or later and show an upgrade warning when a discovered installation is older.

The baseline was originally 0.81.1. It moved to 0.82.0 when skill discovery landed: 0.82.0 replaced the flat `path`/`location` fields on `get_commands` entries with a structured `sourceInfo` object, which the skill and extension-command probes depend on.
