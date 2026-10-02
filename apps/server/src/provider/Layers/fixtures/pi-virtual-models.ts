import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const register = (provider: string, id: string) =>
    pi.registerVirtualModel({
      provider,
      id,
      name: `Router ${id}`,
      thinkingLevels: ["off"],
      route(_request, ctx) {
        const model = ctx.modelRegistry.find("rove-extension-test", "fixture");
        if (!model) throw new Error("Fixture model is missing.");
        return { model, thinkingLevel: "off" };
      },
    });

  for (const provider of ["rove-router-test", "rove-extension-test"]) {
    register(provider, "auto");
    pi.on("session_start", () => register(provider, "late"));
  }
}
