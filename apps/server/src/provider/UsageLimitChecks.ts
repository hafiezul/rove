import type { ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { usageLimitStatusFromWindows, type UsageLimitStatus } from "./usageLimitStatus.ts";

export const UsageLimitChecks = Context.Reference<{
  readonly enabled: Effect.Effect<boolean>;
  readonly check: (
    selection: ModelSelection,
    observedAt: string,
  ) => Effect.Effect<UsageLimitStatus>;
}>("t3/provider/UsageLimitChecks", {
  defaultValue: () => ({
    enabled: Effect.succeed(true),
    check: () => Effect.succeed({ type: "unavailable" }),
  }),
});

export const layer = Layer.effect(
  UsageLimitChecks,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry;
    const settings = yield* ServerSettingsService;
    return {
      enabled: settings.getSettings.pipe(
        Effect.map((value) => value.autoResumeLimitedThreads),
        Effect.orElseSucceed(() => false),
      ),
      check: Effect.fn("UsageLimitChecks.check")(
        function* (selection: ModelSelection, observedAt: string) {
          const instance = yield* instances.getInstance(selection.instanceId);
          if (instance === undefined || !instance.enabled) return { type: "unavailable" as const };
          if (instance.checkUsageLimit !== undefined)
            return yield* instance.checkUsageLimit(selection.model, observedAt);
          const snapshot = yield* instance.snapshot.refresh;
          return usageLimitStatusFromWindows(snapshot.usageLimits, selection.model, observedAt);
        },
        Effect.timeout("30 seconds"),
        Effect.catchCause(() => Effect.succeed({ type: "unavailable" as const })),
      ),
    };
  }),
);
