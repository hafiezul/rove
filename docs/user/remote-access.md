# Connect to another environment

Each environment owns its repositories, provider credentials, and thread history. Desktop and web clients can connect to several environments at once. Install and authenticate your coding agents on each host.

Packaged hosting requires a published Rove CLI release or a staged release candidate. Do not use an upstream package to install this fork.

## Add a persistent CLI host

Install the CLI following [installation](./install.md), then install its [background service](./background-service.md). On a private tailnet, run:

```sh
rove service install --tailscale-serve
rove pair --tailscale
```

Both devices must belong to the tailnet. Tailscale must run where the server and its loopback endpoint are reachable. Installing Tailscale only on Windows does not establish that a WSL distribution owns the Windows Tailscale address.

For direct LAN or tailnet access, bind to an address available on the host:

```sh
rove service install --host <private-ip> --port 3773
rove pair
```

On the receiving client, open **Settings → Connections → Add environment** and use the pairing URL. Create a separate one-time link for each client. Pairing expires, but a paired client's saved session allows it to reconnect without the original link.

The service retains its connection settings across restarts and updates. Keep the machine and, for WSL, the distribution running. A sleeping host is offline.

## Add a host through desktop SSH

In the desktop app, add an SSH environment using a host or SSH alias your computer can reach. Tailscale SSH addresses use the same path.

Rove downloads its exact-version CLI archive and installs a persistent host service if needed. An existing service is reused, or restarted if stopped. Disconnecting or removing the saved SSH connection closes the local forward, not the host service. Update the host through its connection row or `rove update`.

Linux hosts require systemd and user-service prerequisites. macOS requires an available graphical login session for its launch agent. SSH requires the server to be reachable on the host's loopback interface. A browser cannot provision a host through SSH. It can pair with that host through a reachable HTTPS endpoint.

## Share a desktop host

On the desktop host, open **Settings → Connections**, enable **Network access**, and create a pairing link using an address the other device can reach. Turning network access off removes that route. The desktop application must stay running because it supervises the environment.

## Use a hosted browser app

Open the hosted app and add each environment under **Settings → Connections**. The app connects directly to the backend. It does not run agents or proxy environment traffic.

Use a reachable HTTPS backend, such as Tailscale HTTPS or an operator-managed Cloudflare Tunnel. A plain HTTP LAN endpoint does not work from a public HTTPS app. A loopback URL refers to the device opening it, not the remote host.

## Use configured Rove Connect

Rove Connect links an environment to a cloud account and manages its tunnel. It is available only in builds configured for an operator's Clerk instance and relay. Direct pairing, Tailscale, and SSH do not require it.

Connect does not replace host installation or updates. Keep the host's background service installed and use `rove update` for its runtime. Operators configure cloud deployment using the [Connect setup procedure](../operations/connect-setup.md).

## Balance new threads across hosts

On web and desktop, **Settings → Connections → Load balancing** appears when two or more machines are connected. Set a machine to **Prefer**, **Less often**, or **Manual only** to influence new-thread placement. Existing threads remain on their original environment. Mobile selects a machine manually.

Clone the repository and authenticate an eligible provider on each machine before balancing work across them. Project grouping does not synchronize files between machines.

## Continue a thread on another machine

On web and desktop, right-click a project thread (or open its menu in the chat header) and choose **Continue on**, then the machine. Each machine needs its own clone of the repository with the same remote.

The thread's branch must be pushed first. Commit and push any remaining changes from the thread before continuing. Rove Code then opens a new thread on the other machine that checks out the same branch in a new worktree, with the recent conversation in the composer. Review it and send it to continue. Once it is sent, each thread links to the other: the original shows **Continued on** with a way to open the new thread. The original thread stays where it was; its provider session does not move.

## Revoke access

On the host, authorized administrators can revoke pairing links and client sessions in **Settings → Connections**. Revoking a link prevents new pairings. Revoking a session removes a client's existing access.

Treat pairing URLs and authorization codes as passwords. Keep them out of screenshots, logs, and bug reports.
