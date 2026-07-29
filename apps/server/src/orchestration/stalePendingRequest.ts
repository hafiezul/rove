/**
 * Wording for a prompt whose provider callback no longer exists.
 *
 * A prompt's answer travels back through an in-memory callback owned by the
 * provider process. That callback does not survive a restart or a recovered
 * session, so a prompt outliving one can never be answered.
 *
 * Two paths retire such a prompt — `ProviderCommandReactor` when a user
 * answers a dead prompt, and `ProviderSessionBootReconciler` when it finds one
 * still open at boot — and downstream consumers (the projection's pending
 * counts and the web session logic) recognise the retirement by matching on
 * this wording. It therefore lives in one place.
 *
 * @module orchestration/stalePendingRequest
 */

export type StalePendingRequestKind = "approval" | "user-input";

export function stalePendingRequestDetail(
  requestKind: StalePendingRequestKind,
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}
