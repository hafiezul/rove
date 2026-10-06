import * as Schema from "effect/Schema";

import type { CuaArguments, CuaTool } from "./CuaDriver.ts";

export const BACKGROUND_ONLY_INSTRUCTIONS =
  "Rove Computer Use is background-only. Prefer accessibility elements on an exact app window. " +
  "Desktop input, foreground delivery, shared clipboard writes, and driver configuration changes are unavailable. " +
  "Use preview_* for web pages. Rove owns one persistent Cua connection per thread. Do not pass session labels or manage sessions. " +
  "If an action cannot run in the background, use an app API or continue other work and report that GUI step as blocked. " +
  "Driver guidance below does not authorize foreground or desktop input.";

const WINDOW_INPUT_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "move_cursor",
]);

const BACKGROUND_TOOLS = new Set([
  ...WINDOW_INPUT_TOOLS,
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "invoke_menu",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "get_accessibility_tree",
  "zoom",
  "check_permissions",
  "get_config",
  "clipboard_read",
  "parse_visual_regions",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "get_agent_cursor_state",
  "start_recording",
  "stop_recording",
  "get_recording_state",
]);

const WindowTarget = Schema.Struct({
  kind: Schema.Literal("window"),
  pid: Schema.Int,
  window_id: Schema.Int,
});
const isWindowTarget = Schema.is(WindowTarget);
const isInteger = Schema.is(Schema.Int);
const isString = Schema.is(Schema.String);

const ISOLATED_DESKTOP_INSTRUCTIONS =
  "Rove owns a private, offline Linux desktop for this thread. Guest apps, focus, pointer, clipboard, profiles and files are separate from the host and other threads. " +
  "Only Mousepad and basic desktop tools are installed. The project, host home, credentials and host display are not mounted. Paths refer to the guest. " +
  "Prefer exact-window accessibility input. Pixel, desktop and foreground input are permitted only inside this private desktop. Verify changes with fresh application state. " +
  "Use preview_* for web pages. Do not pass session labels or change driver configuration. " +
  "Idle transport retirement preserves apps and documents but invalidates snapshot refs. " +
  "Use close_desktop when finished. It discards all unsaved documents and guest files. Turning computer use off or stopping Rove also discards desktops. " +
  "There are four thread slots. Rove never silently evicts unfinished work. Driver guidance below cannot authorize host input.";

const DESKTOP_TOOLS = new Set([
  ...BACKGROUND_TOOLS,
  "bring_to_front",
  "clipboard_write",
  "close_desktop",
  "health_report",
]);

const isBackgroundTool = (tool: CuaTool) => BACKGROUND_TOOLS.has(tool.name);
export const isAllowedTool = (tool: CuaTool, policy: "background-only" | "isolated-desktop") =>
  policy === "isolated-desktop" ? DESKTOP_TOOLS.has(tool.name) : isBackgroundTool(tool);
export const instructionsFor = (policy: "background-only" | "isolated-desktop") =>
  policy === "isolated-desktop" ? ISOLATED_DESKTOP_INSTRUCTIONS : BACKGROUND_ONLY_INSTRUCTIONS;
export const isolatedRefusal = (tool: CuaTool, args: CuaArguments) => {
  if (!DESKTOP_TOOLS.has(tool.name))
    return `${tool.name} is not an allowed private-desktop operation.`;
  if (args.session !== undefined) return "Cua sessions are managed by Rove, not by the agent.";
  if (tool.name === "close_desktop" && Object.keys(args).length > 0)
    return "close_desktop accepts no arguments and can only discard the calling thread's desktop.";
  return undefined;
};

export const backgroundRefusal = (tool: CuaTool, args: CuaArguments) => {
  if (!isBackgroundTool(tool)) return `${tool.name} is not a background operation.`;
  if (args.session !== undefined) return "Cua sessions are managed by Rove, not by the agent.";
  if (args.delivery_mode !== undefined && args.delivery_mode !== "background")
    return "Only background delivery is allowed.";
  if (args.scope !== undefined && args.scope !== "window") return "Desktop input is unavailable.";
  if (args.target !== undefined && !isWindowTarget(args.target))
    return "Input must target an app window, not the desktop.";
  if (
    WINDOW_INPUT_TOOLS.has(tool.name) &&
    args.target === undefined &&
    !(isInteger(args.pid) && args.pid > 0) &&
    !(isString(args.element_token) && args.element_token.length > 0)
  )
    return "Input needs a target pid, a window target, or an element token from a fresh snapshot.";
  return undefined;
};
