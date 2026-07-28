/**
 * ProviderSessionBootReconcilerService - Reconciles persisted provider session state at startup.
 *
 * Provider processes are children of the T3 Code server, so no session
 * survives a restart. Persisted non-stopped rows therefore describe sessions
 * that no longer exist; this service repairs them before clients connect.
 *
 * @module ProviderSessionBootReconcilerService
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * ProviderSessionBootReconcilerShape - Service API for boot reconciliation.
 */
export interface ProviderSessionBootReconcilerShape {
  /**
   * Reconcile every persisted provider session against the fact that no
   * provider process is live, resolving once the repair has been ingested.
   *
   * Must run after runtime ingestion has started, because the repair is
   * expressed as provider runtime events.
   */
  readonly reconcile: () => Effect.Effect<void>;
}

/**
 * ProviderSessionBootReconcilerService - Service tag for boot reconciliation.
 */
export class ProviderSessionBootReconcilerService extends Context.Service<
  ProviderSessionBootReconcilerService,
  ProviderSessionBootReconcilerShape
>()(
  "t3/orchestration/Services/ProviderSessionBootReconciler/ProviderSessionBootReconcilerService",
) {}
