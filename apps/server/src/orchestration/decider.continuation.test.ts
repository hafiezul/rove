import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  THREAD_CONTINUED_ACTIVITY_KIND,
  ThreadId,
  type OrchestrationReadModel,
} from "@rove-code/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/x",
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: "settled",
      settledAt: NOW,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

it.layer(NodeServices.layer)("thread.continuation.record decider", (it) => {
  it.effect("records the link as a continued activity without waking the thread", () =>
    Effect.gen(function* () {
      const link = {
        direction: "to" as const,
        environmentId: EnvironmentId.make("env-server"),
        threadId: ThreadId.make("thread-elsewhere"),
        environmentLabel: "Server",
      };
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.continuation.record",
          commandId: CommandId.make("cmd-continue"),
          threadId: ThreadId.make("thread-1"),
          link,
          createdAt: NOW,
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.activity-appended"]);
      const event = events[0];
      if (event?.type !== "thread.activity-appended") return;
      expect(event.payload.activity).toMatchObject({
        kind: THREAD_CONTINUED_ACTIVITY_KIND,
        tone: "info",
        summary: "Continued on Server",
        payload: link,
        turnId: null,
      });
    }),
  );

  it.effect("rejects a link on a thread that does not exist", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.continuation.record",
            commandId: CommandId.make("cmd-missing"),
            threadId: ThreadId.make("thread-missing"),
            link: {
              direction: "from",
              environmentId: EnvironmentId.make("env-server"),
              threadId: ThreadId.make("thread-elsewhere"),
              environmentLabel: "Server",
            },
            createdAt: NOW,
          },
          readModel,
        }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
