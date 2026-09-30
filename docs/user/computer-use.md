# Computer use

Agents can see and control native Mac apps through [Cua Driver](https://cua.ai/docs/cua-driver).
They can list windows, read a window's accessibility tree, click, type, and take
screenshots. Cua usually acts on a window without moving your cursor. For web pages, agents
keep using Rove Code's browser panel.

Computer use is off by default and works only when the environment runs on macOS.

## Set it up

1. Open **Settings → Integrations → Computer use**.
2. If Cua Driver is missing, run the install command shown there on the Mac that runs the
   environment, then select **Check again**.
3. Turn on **Agent computer use**.
4. Select **Grant permissions** and allow Accessibility and Screen Recording for Cua Driver
   in the macOS prompts. macOS asks on the Mac running the environment, not the device you
   are using to connect.

macOS grants these permissions to Cua Driver, not to Rove Code. You can revoke them in
**System Settings → Privacy & Security**.

## Using it

Ask the agent to use a native app, for example "open Notes and create a note titled
Groceries". Every provider connected through Rove Code gets the same tools. Threads that
were already running can use computer use as soon as you turn it on.

Cua Driver starts when an agent first uses it. **Stop** quits it until an agent needs it
again.

## Stopping an agent

Turn off **Agent computer use**. Rove Code refuses the next computer-use action from every
agent, including agents that are running now.
