import Constants from "expo-constants";
import { makeRelayClientTracingLayer } from "@t3tools/shared/relayTracing";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";
import * as RuntimePredicate from "effect/Predicate";

export interface TracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly appVariant: string;
}

export function resolveTracingConfig(): TracingConfig | null {
  const config = resolveCloudPublicConfig();
  if (!hasTracingPublicConfig(config)) {
    return null;
  }
  const { tracesUrl, tracesDataset, tracesToken } = config.observability;
  return { tracesUrl, tracesDataset, tracesToken };
}

export function makeTracingLayer(config: TracingConfig | null, resource: TracingResource) {
  return makeRelayClientTracingLayer(config, {
    serviceName: "t3-mobile-relay-client",
    serviceVersion: resource.serviceVersion,
    runtime: "react-native",
    client: `mobile-${resource.appVariant}`,
  });
}

export const tracingLayer = makeTracingLayer(resolveTracingConfig(), {
  serviceVersion: Constants.expoConfig?.version,
  appVariant: RuntimePredicate.isString(Constants.expoConfig?.extra?.appVariant)
    ? Constants.expoConfig.extra.appVariant
    : "unknown",
});
