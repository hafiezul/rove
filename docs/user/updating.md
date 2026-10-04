# Update Rove Code

Desktop clients and remote hosts update independently. Updating the Mac application does not replace a Linux host's runtime.

## Update a CLI host

For a host installed as a background service, run:

```sh
rove update
```

The CLI downloads a Rove release and offers to restart the service. To select an exact version, pass it to `rove update`. If you decline the restart, run `rove service restart` when ready.

You can also invoke the updater through the published npm launcher:

```sh
npx @rove-code/cli@latest update
```

The service uses its own pinned runtime. Updating the npm launcher alone does not replace a running server. No Git checkout or dependency installation is required for a packaged host update.

Use the same data directory when installing, pairing, or updating an environment. Its identity, authorization, thread history, and saved connection route remain there across versions.

## Update from a client

On web and desktop, open **Settings → Connections** and update a connected host. A launcher-managed CLI host supports remote updates. A desktop-managed host updates through the desktop application supervising it.

A server started by hand has no update owner. Install the background service before expecting remote updates. A development checkout is not a packaged host.

The client verifies the resulting version after reconnecting. If a trial service update fails before committing, the launcher restores the previous runtime and database. A reconnect alone does not mean the update succeeded.

## Protect active work

Finish active terminal commands before restarting. **Settings → General → Continue threads after restarts** can resume supported threads with saved provider state. Terminal commands can still be interrupted. The setting does not start a stopped host.

Release commands require published Rove artifacts. Do not substitute an upstream package or change the host's data directory to work around a missing release.
