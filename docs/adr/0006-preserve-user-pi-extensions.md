# Isolate Pi from discovered user extensions

Pi runtime instances will start with Pi's `--no-extensions` flag so arbitrary user extension hooks cannot alter T3 Code tool execution. T3 Code will render compatible RPC extension dialogs from explicitly loaded extensions where possible and clearly report unsupported custom extension UI as requiring Pi's terminal interface.

Superseded in part by ADR 0014. This decision originally let users load a trusted extension through Pi's `--extension <path>` launch argument. Raw launch arguments can no longer pass `--extension`; the per-instance trusted-extension selection is now the only way to load one.
