import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEMES, getThemeColorsForAppearance } from "@rove-code/shared/themePalettes";

import { themeColorToNativeColor } from "../../lib/mobileTheme";

import { buildGhosttyThemeConfig, getMobileTerminalTheme } from "./terminalTheme";

describe("getMobileTerminalTheme", () => {
  it("uses the shared default light terminal colors", () => {
    expect(getMobileTerminalTheme("rove", "light")).toMatchObject({
      background: "#f6f7fb",
      foreground: "#1c2033",
      cursorForeground: "#3a52b4",
      cursorBackground: "#f6f7fb",
    });
  });

  it("uses the shared default dark terminal colors", () => {
    expect(getMobileTerminalTheme("rove", "dark")).toMatchObject({
      background: "#0e1019",
      foreground: "#e9ecf5",
      cursorForeground: "#6e8bea",
      cursorBackground: "#0e1019",
    });
  });
  it("applies the selected palette without replacing ANSI status colors", () => {
    const standard = getMobileTerminalTheme("rove", "dark");
    const ocean = getMobileTerminalTheme("ocean", "dark");

    expect(ocean.background).not.toBe(standard.background);
    expect(ocean.cursorForeground).not.toBe(standard.cursorForeground);
    expect(ocean.palette).toEqual(standard.palette);
  });

  it("uses the canonical desktop terminal roles for built-in themes", () => {
    const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === "ocean")!;
    const colors = getThemeColorsForAppearance(theme, "dark")!;
    const terminal = getMobileTerminalTheme("ocean", "dark");

    expect(terminal.background).toBe(themeColorToNativeColor(colors.terminalBackground));
    expect(terminal.foreground).toBe(themeColorToNativeColor(colors.terminalForeground));
    expect(terminal.cursorForeground).toBe(themeColorToNativeColor(colors.terminalCursor));
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getMobileTerminalTheme("rove", "dark"));

    expect(config).toContain("background = #0e1019");
    expect(config).toContain("foreground = #e9ecf5");
    expect(config).toContain("cursor-color = #6e8bea");
    expect(config).toContain("palette = 0=#141415");
    expect(config).toContain("palette = 15=#c6c6c8");
    expect(config.endsWith("\n")).toBe(true);
  });
});
