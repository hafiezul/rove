import { ProviderRegistry, type ProviderRegistryContract } from "../Services/ProviderRegistry.ts";
import { PiCatalogError, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistryContract => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
  piCatalog: () => Effect.fail(new PiCatalogError({ message: "Unavailable in tests." })),
  refreshPiCatalog: () => Effect.fail(new PiCatalogError({ message: "Unavailable in tests." })),
});

export const makeProviderRegistryLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry, makeProviderRegistryMock(providers));
