import { EnvironmentId } from "@rove-code/contracts";

import type { RelayEnvironmentView } from "../connection/useConnectionController";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

interface ShowcaseEnvironmentDisplayUrls {
  readonly [environmentLabel: string]: string | undefined;
}

const SHOWCASE_LOCAL_ENVIRONMENT_DISPLAY_URLS: ShowcaseEnvironmentDisplayUrls = {
  "Moonbase Terminal": "https://moonbase.tail9f3a.ts.net/",
  "Suspense Station": "https://rove.hafiezulzikry.com/",
  "Kernel Cabin": "http://100.82.16.5:3773/",
};

export function applyShowcaseLocalEnvironmentDisplayUrls(
  environments: ReadonlyArray<ConnectedEnvironmentSummary>,
): ReadonlyArray<ConnectedEnvironmentSummary> {
  return environments.map((environment) => ({
    ...environment,
    displayUrl:
      SHOWCASE_LOCAL_ENVIRONMENT_DISPLAY_URLS[environment.environmentLabel] ??
      environment.displayUrl,
  }));
}

export function resolveShowcaseEnvironmentUpdateDisplayUrl(input: {
  readonly actualDisplayUrl: string;
  readonly presentedDisplayUrl: string;
  readonly submittedDisplayUrl: string;
}): string {
  return input.submittedDisplayUrl === input.presentedDisplayUrl
    ? input.actualDisplayUrl
    : input.submittedDisplayUrl;
}

const pocketPiId = EnvironmentId.make("showcase-pocket-pi");
const pocketPiEndpoint = {
  httpBaseUrl: "https://rove.hafiezulzikry.com",
  wsBaseUrl: "wss://rove.hafiezulzikry.com",
  providerKind: "rove_relay" as const,
};

export const SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS: ReadonlyArray<ConnectedEnvironmentSummary> = [
  {
    environmentId: EnvironmentId.make("showcase-aurora-gpu"),
    environmentLabel: "Aurora GPU Pod",
    displayUrl: "https://rove.hafiezulzikry.com",
    isRelayManaged: true,
    isEnabled: true,
    connectionState: "connected",
    connectionError: null,
    connectionErrorTraceId: null,
  },
];

export const SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS: ReadonlyArray<RelayEnvironmentView> = [
  {
    environment: {
      environmentId: pocketPiId,
      label: "Pocket Pi",
      endpoint: pocketPiEndpoint,
      linkedAt: "2026-07-16T08:00:00.000Z",
    },
    availability: "online",
    status: {
      environmentId: pocketPiId,
      endpoint: pocketPiEndpoint,
      status: "online",
      checkedAt: "2026-07-16T08:41:00.000Z",
    },
    error: null,
    traceId: null,
  },
];
