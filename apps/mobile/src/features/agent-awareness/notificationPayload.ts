import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";
function dataFromNotificationResponse(response: unknown): Record<string, SchemaJson> | null {
  if (!RuntimePredicate.isObjectOrArray(response)) {
    return null;
  }
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    notification = (response as { readonly notification?: unknown }).notification;
  if (!RuntimePredicate.isObjectOrArray(notification)) {
    return null;
  }
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    request = (notification as { readonly request?: unknown }).request;
  if (!RuntimePredicate.isObjectOrArray(request)) {
    return null;
  }
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    content = (request as { readonly content?: unknown }).content;
  if (!RuntimePredicate.isObjectOrArray(content)) {
    return null;
  }
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    data = (content as { readonly data?: unknown }).data;
  // SAFETY: The surrounding adapter has established this JSON-object view before field access.
  return RuntimePredicate.isObjectOrArray(data) ? (data as Record<string, SchemaJson>) : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (!RuntimePredicate.isObjectOrArray(response)) {
    return null;
  }
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    notification = (response as { readonly notification?: unknown }).notification;
  if (!RuntimePredicate.isObjectOrArray(notification)) {
    return null;
  }
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    request = (notification as { readonly request?: unknown }).request;
  if (!RuntimePredicate.isObjectOrArray(request)) {
    return null;
  }
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    identifier = (request as { readonly identifier?: unknown }).identifier;
  return RuntimePredicate.isString(identifier) ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  const data = dataFromNotificationResponse(response);
  const deepLink = data?.deepLink;
  if (RuntimePredicate.isString(deepLink)) {
    const normalizedDeepLink = normalizeThreadDeepLink(deepLink);
    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;
  if (RuntimePredicate.isString(environmentId) && RuntimePredicate.isString(threadId)) {
    return encodeThreadDeepLink({ environmentId, threadId });
  }
  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
}): void {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return;
  }
  if (responseId) {
    input.handledResponseIds.add(responseId);
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    input.navigate(deepLink);
  }
}
