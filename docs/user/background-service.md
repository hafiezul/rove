# Keep a Rove host running

Install the Rove CLI from a published Rove release before following this guide. Release candidates can use the staged CLI executable. See [installation](./install.md).

## Install the service

Run the command as the account that owns your repositories and provider credentials. Do not run Rove with `sudo`.

```sh
rove service install
rove service status
```

The service runs independently of your terminal and connected clients. It uses an exact-version runtime outside the npm cache. Removing an npm cache entry does not remove the installed host.

To reach the host over a tailnet, install it with Tailscale HTTPS enabled:

```sh
rove service install --tailscale-serve
rove pair --tailscale
```

To bind directly to a private interface, specify its address and port:

```sh
rove service install --host <private-ip> --port 3773
rove pair
```

Installation saves the address, port, Tailscale settings, and provider search path. Repairs and updates retain these settings when you omit the flags. To change them, run `service install` with the new values. Use `--tailscale-serve=false` to disable Tailscale exposure, and `--host 127.0.0.1` to return to loopback binding.

## Prepare Linux or WSL

Linux hosts require a systemd user manager. WSL distributions must have systemd enabled and remain running while clients use the environment. A user service does not start Windows or a stopped WSL distribution.

Check the prerequisites:

```sh
systemctl --user status
loginctl show-user "$(id -un)" --property=Linger
```

Installation attempts to enable lingering for your account. If permission is denied, enable it as an administrator, then retry installation as your normal user:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Lingering allows the service to run after your last login session ends. Native Windows background services are not supported. Use a systemd-enabled WSL distribution for a persistent Windows host.

macOS hosts use a launch agent in your graphical login session. Installing one over SSH requires that session to exist.

## Update or remove the service

```sh
rove update
rove service status
```

The update command downloads the selected release and offers to restart the service. If you defer the restart, run `rove service restart` when ready. Connected clients reconnect to the same environment. Pairing and thread history remain in its data directory.

Authorized clients can update launcher-managed hosts in **Settings → Connections**. Finish terminal commands before an update. See [updates](./updating.md) for thread continuation and rollback behavior.

To remove automatic startup and stop the service:

```sh
rove service uninstall
```

Removal does not delete repositories, credentials, or thread history. Reinstalling with the same data directory restores the same environment.
