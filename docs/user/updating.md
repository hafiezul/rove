# Updating Rove Code

This fork currently runs from source and does not publish a managed updater. If
you use more than one machine, update the source checkout on the machine running
the server as well as the client you use to reach it. An older server may show
a version-mismatch notice in the conversation or **Settings → Connections**;
it cannot update itself in this build.

Finish active agent work and terminal commands before stopping the server. In
each checkout, pull the desired revision, run `vp i`, and restart the process
using the same host and pairing settings you used before. For a desktop source
build, rebuild and relaunch the desktop app. Your state remains under
`~/.rove-code`, or the worktree-local `.rove` in a linked development worktree.

**Settings → General → Continue threads after restarts** can resume supported
active threads after an update or crash when Rove Code starts again. Terminal
commands may still be interrupted, and threads without saved provider resume
state need a new message. The setting does not start the server for you.

Desktop installers, a self-update feed, and mobile store releases will have
separate update instructions once this project publishes and verifies its own
artifacts.
