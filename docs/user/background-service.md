# Running Rove Code in the background

The self-hosted source build does not yet have a supported managed background
service. Its inherited service installer depends on a published CLI archive,
which this fork has not released. Do not install an upstream package to run this
fork as a service.

For now, keep the server process or desktop host running while remote devices
are connected. See [remote access](./remote-access.md) for LAN and tailnet
pairing. Stop the process normally when you no longer need remote access.

A Rove-owned service installer and updater require tested CLI archives for each
host platform. This guide will describe setup, update, and removal when those
artifacts are available.
