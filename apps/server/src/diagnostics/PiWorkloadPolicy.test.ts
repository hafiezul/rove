import { describe, expect, it, vi } from "vite-plus/test";

const control = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<string>>());
vi.mock("./ProcessBudget.ts", async (original) => ({
  ...(await original<typeof import("./ProcessBudget.ts")>()),
  executeProcessControl: control,
}));
import { resolvePiWorkloadMemory } from "./PiWorkloadPolicy.ts";

const gib = 1024 ** 3;
describe("Pi workload policy", () => {
  it("leaves larger, unsupported and explicitly disabled hosts alone", async () => {
    control.mockReset();
    expect(await resolvePiWorkloadMemory("auto", "2048", {}, "linux", 16 * gib)).toBeUndefined();
    expect(await resolvePiWorkloadMemory("auto", "2048", {}, "darwin", 4 * gib)).toBeUndefined();
    expect(await resolvePiWorkloadMemory("off", "2048", {}, "linux", 4 * gib)).toBeUndefined();
    expect(control).not.toHaveBeenCalled();
  });

  it("reserves half a small host for the OS and Pi while respecting smaller configured limits", async () => {
    control.mockReset().mockResolvedValue("");
    expect(await resolvePiWorkloadMemory("auto", "2048", {}, "linux", 2 * gib)).toBe(1024);
    expect(await resolvePiWorkloadMemory("auto", "384", {}, "linux", 2 * gib)).toBe(384);
    expect(await resolvePiWorkloadMemory("auto", "2048", {}, "linux", 8 * gib)).toBe(2048);
  });

  it("fails closed for explicit protection when the manager is unavailable", async () => {
    control.mockReset().mockRejectedValue(new Error("user systemd unavailable"));
    expect(await resolvePiWorkloadMemory("auto", "2048", {}, "linux", 4 * gib)).toBeUndefined();
    await expect(resolvePiWorkloadMemory("on", "2048", {}, "linux", 4 * gib)).rejects.toThrow(
      "unavailable",
    );
    await expect(
      resolvePiWorkloadMemory(
        "off",
        "2048",
        { ROVE_PI_MEMORY_BUDGET_MIB: "384" },
        "linux",
        4 * gib,
      ),
    ).rejects.toThrow("unavailable");
  });

  it("preserves explicit memory settings and environment precedence", async () => {
    control.mockReset().mockResolvedValue("");
    expect(await resolvePiWorkloadMemory("on", "2048", {}, "linux", 2 * gib)).toBe(2048);
    expect(
      await resolvePiWorkloadMemory(
        "off",
        "2048",
        { ROVE_PI_MEMORY_BUDGET_MIB: "384" },
        "linux",
        2 * gib,
      ),
    ).toBe(384);
    await expect(resolvePiWorkloadMemory("on", "2048", {}, "darwin", 4 * gib)).rejects.toThrow(
      "Linux",
    );
  });
});
