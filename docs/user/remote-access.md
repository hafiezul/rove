# Remote access

Rove Code connects directly over your LAN or private tailnet. The host must stay
running and reachable while you work. This fork does not provide a hosted web
app, cloud relay, or mobile store build.

## Pair over a LAN or private network

On the desktop host, open **Settings → Connections**, enable **Network access**,
and create a pairing link using an address the other device can reach. Turning
network access off in the same place removes the route.

For a [source installation](./install.md#run-from-source), build the client
(`vp run build:desktop`) and start a headless server on the host's LAN or
tailnet address:

```bash
node apps/server/src/bin.ts serve --host <private-ip>
```

In another terminal in the same checkout, create a fresh link for the running
server:

```bash
node apps/server/src/bin.ts pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
on the receiving device. A loopback address such as `127.0.0.1` only reaches
the device that opens the link. Create a separate one-time link for each device.
Paired devices can reconnect without the original link. On web and desktop,
manage paired clients in **Settings → Connections**; on a mobile source build,
open **Settings → Environments**.

If you use Tailscale, join both devices to the same tailnet. The desktop host
can enable **Tailscale HTTPS** in **Settings → Connections**. On a headless
source server, start with `--tailscale-serve`, then create the link with
`node apps/server/src/bin.ts pair --tailscale`. Disable Tailscale HTTPS in
Settings, or remove the default-port mapping with
`tailscale serve --https=443 off`.

## Balance new threads across machines

On web and desktop, **Settings → Connections → Load balancing** appears when
two or more machines are connected. Enable it to choose among machines for
new threads. Set a machine to **Prefer**, **Less often**, or **Manual only** to
influence the choice. These are preferences, not fixed traffic percentages.
Existing threads stay on their original machine; mobile selects a machine
manually.

## Revoke access

On the host, **Settings → Connections** lets authorized administrators revoke
pairing links and client sessions. Revoking a link prevents new pairings;
revoking a session removes a device's existing access. Treat pairing URLs and
authorization codes as passwords and keep them out of screenshots, logs, and
bug reports.

Desktop-managed SSH and Rove Connect are not part of this first self-hosted
release. Their managed server downloads, identities, and service infrastructure
must be replaced before those paths can be supported.
