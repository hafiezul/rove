# Computer use

Agents can see and control native Mac apps through [Cua Driver](https://cua.ai/docs/cua-driver).
They can list windows, read a window's accessibility tree, click, type, and take
screenshots. Rove allows background window actions and refuses desktop input and foreground
escalation. For web pages, agents keep using Rove Code's browser panel.

If an app requires foreground input, the agent can try an app API or continue other work.
The GUI step remains blocked rather than taking over your desktop. This restriction applies
to Computer Use tools, not shell commands or actions an app takes in response.

Computer use is off by default and works only when the environment runs on macOS.

## Set it up

1. Open **Settings → Integrations → Computer use**.
2. If Cua Driver is missing, select **Install**. Rove Code runs Cua's official installer,
   which downloads the app from Cua's GitHub releases into `/Applications`. Rove Code then
   checks that Cua AI, Inc. signed the app and refuses to run it otherwise.
3. Turn on **Agent computer use**.
4. Select **Grant permissions** and allow Accessibility and Screen Recording for Cua Driver
   in the macOS prompts. macOS asks on the Mac running the environment, not the device you
   are using to connect.

macOS grants these permissions to Cua Driver, not to Rove Code. You can revoke them in
**System Settings → Privacy & Security**.

## Usage data

Cua can send a pseudonymous installation ID and content-free usage counts to Cua. When Rove
Code installs Cua, it turns this off. If you installed Cua yourself, your existing choice
stays. Change it with **Share usage data with Cua**.

## Using it

Ask the agent to use a native app, for example "open Notes and create a note titled
Groceries". Every provider connected through Rove Code gets the same tools. Threads that
were already running can use computer use as soon as you turn it on.

Cua Driver starts when an agent first needs it. If Rove Code started it, Rove Code quits it
after 5 minutes without computer use, when you turn off **Agent computer use**, and when the
Rove Code server stops. Rove Code leaves a Cua Driver it did not start running.

## Stopping an agent

Turn off **Agent computer use**. Rove Code refuses the next computer-use action from every
agent, including agents that are running now.
