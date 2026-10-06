# Computer use

Agents use [Cua Driver](https://cua.ai/docs/cua-driver) to discover apps, inspect
accessibility state, click, type, and capture screenshots. Every provider connected
through Rove Code gets the same tools. Computer use is off by default.

On macOS, agents act on your apps in the background. Desktop input, foreground
escalation, shared clipboard writes, and driver configuration changes are refused.
If a GUI step cannot run in the background, the agent can use an app API or report
that step as blocked. These restrictions apply to Computer Use tools, not shell
commands or actions an app takes in response.

On Linux, including WSL, each thread gets a private, headless desktop. Its focus,
pointer, clipboard, and apps are separate from your desktop and other threads.
There is no host-desktop fallback. No display, WSLg, or physical monitor is needed.
macOS does not yet have private desktops. Native Windows apps are not supported.

For web pages, agents keep using Rove Code's browser panel.

## Set it up

Open **Settings → Integrations → Computer use**. Select **Install** if Cua Driver
is missing, then turn on **Agent computer use**. Rove uses Cua's official installer,
which downloads the driver from Cua's GitHub releases.

### macOS

Select **Check permissions** to start Cua Driver. If permissions are missing, select
**Grant permissions**. Allow Accessibility and Screen Recording for Cua Driver.
macOS asks on the Mac running the environment, not the device you use to connect.

The installer puts `CuaDriver.app` in `/Applications`. Rove checks that Cua AI, Inc.
signed the app and refuses to run it otherwise. macOS grants these permissions to
Cua Driver, not Rove. Revoke them in **System Settings → Privacy & Security**.

### Linux and WSL

Install rootless Podman on the machine running the environment. On Debian or Ubuntu,
run `sudo apt install podman uidmap` yourself. Run Rove as an unprivileged user, and
check that `podman info` works for that user. Rove does not ask for a sudo password
or use a remote Podman connection.

Select **Install** or **Prepare desktop** to build the private desktop image. The
first build needs internet access and downloads Ubuntu desktop packages. Rove
includes the installed Cua executable in an image identified by its contents.
Updating that executable may require preparing another image. The driver is
installed in `~/.local/bin` by default. An existing driver on `PATH` is also detected.

Select **Check desktop** to test the private graphical session. Runtime problems
are reported here. They never cause Rove to attach to your host display.

## Using a Linux desktop

The initial desktop includes Mousepad and basic desktop tools. For example, ask the
agent to open Mousepad, create a new unsaved document, and verify the text it typed.
Accessibility input is preferred. Foreground and pixel input are allowed inside
this private desktop because they cannot change your host focus or pointer.

The guest is offline. It has no project mount, host home, credentials, browser
profile, or host clipboard. Paths and files used by computer-use tools belong to
the guest. This desktop cannot open your host apps or edit your project files.
Use shell tools for project work and the browser panel for web tasks.

Rove allows four thread desktops at once. A fifth thread is refused until a slot
is explicitly released. Rove does not silently evict unfinished documents.

## Lifetime and stopping

An idle Cua connection closes after five minutes. On Linux, the private desktop
stays alive, including unsaved documents. The next call reconnects to it, but
snapshot and capture references must be refreshed. Ask the agent to use
`close_desktop` when finished. This discards only that thread's desktop, including
all unsaved documents and guest files. The next call creates a new empty desktop.

Turning off **Agent computer use** refuses new agent calls. It also discards all
Linux desktops. Stopping the Rove server discards them too. They are temporary
workspaces, not durable storage. After an abrupt failure, Rove removes desktops
whose recorded server process has died. Desktops belonging to another live Rove
server are left alone. Do not expect documents to survive a restart.

On macOS, Rove quits the shared daemon after its connections retire only if Rove
started it. A separately started daemon is left running.

## Usage data

Cua's usage collection is disabled inside Linux agent desktops. On macOS, Cua can
send a pseudonymous installation ID and content-free usage counts. Rove turns this
off when it installs Cua. An existing installation keeps its preference. Change
that preference with **Share usage data with Cua**.
