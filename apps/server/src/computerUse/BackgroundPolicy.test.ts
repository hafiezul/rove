import { expect, it } from "vite-plus/test";

import { backgroundRefusal } from "./BackgroundPolicy.ts";

for (const name of [
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
]) {
  it(`${name} accepts window input and refuses desktop, foreground, or unbound input`, () => {
    const tool = {
      name,
      description: name,
      inputSchema: { type: "object" as const },
      readOnly: false,
    };
    for (const args of [
      { pid: 4 },
      { pid: 4, scope: "window", delivery_mode: "background" },
      { target: { kind: "window", pid: 4, window_id: 42 } },
      { element_token: "s01234567:1" },
    ]) {
      expect(backgroundRefusal(tool, args)).toBeUndefined();
    }
    for (const args of [
      {},
      { pid: 0 },
      { pid: "4" },
      { pid: 4, scope: "desktop" },
      { pid: 4, delivery_mode: "foreground" },
      { pid: 4, delivery_mode: "auto" },
      { target: { kind: "desktop", display_id: "primary" } },
      { target: { kind: "window", pid: "4", window_id: 42 } },
      { pid: 4, session: "foreign-session" },
    ]) {
      expect(backgroundRefusal(tool, args)).toBeTypeOf("string");
    }
  });
}

it("allows desktop observation without allowing desktop input", () => {
  expect(
    backgroundRefusal(
      {
        name: "get_desktop_state",
        description: "Capture.",
        inputSchema: { type: "object" },
        readOnly: true,
      },
      { max_image_dimension: 64 },
    ),
  ).toBeUndefined();
});

it("refuses unreviewed operations even if their catalog claims they are read-only", () => {
  expect(
    backgroundRefusal(
      {
        name: "new_driver_operation",
        description: "Unknown.",
        inputSchema: { type: "object" },
        readOnly: true,
      },
      {},
    ),
  ).toContain("not a background operation");
});
