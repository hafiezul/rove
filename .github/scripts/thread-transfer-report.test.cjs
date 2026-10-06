const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderComment,
  resolve,
  upsertCommentForCurrentHead,
  validateResult,
} = require("./thread-transfer-report.cjs");

function result(overrides = {}) {
  const observed = {
    totalWireBytes: 2_200_000,
    threadSnapshotWireBytes: 1_950_000,
    threadSnapshotDecodedBytes: 9_100_000,
    measuredTurnWebSocketWireBytes: 250_000,
    measuredTurnWebSocketDecodedBytes: 1_150_000,
    measuredTurnWebSocketMessages: 15,
  };
  const ceiling = {
    totalWireBytes: 2_900_000,
    threadSnapshotWireBytes: 2_600_000,
    measuredTurnWebSocketWireBytes: 320_000,
    measuredTurnWebSocketDecodedBytes: 1_550_000,
    measuredTurnWebSocketMessages: 20,
  };
  return {
    schemaVersion: 2,
    scenario: {
      id: "thread-transfer-v1",
      historyTurns: 10,
      historyCommandToolsPerTurn: 5,
      historyMcpResultBytes: 900_000,
      measuredCommandTools: 20,
      measuredMcpResultBytes: 1_100_000,
    },
    providers: {
      codex: { observed: { ...observed, ...overrides }, ceiling },
      claudeAgent: { observed, ceiling },
      pi: { observed: { ...observed }, ceiling: { ...ceiling } },
    },
  };
}

test("validates the fixed artifact schema", () => {
  assert.equal(validateResult(result()).schemaVersion, 2);
  assert.throws(
    () => validateResult({ ...result(), injectedMarkdown: "@everyone" }),
    /unexpected fields/,
  );
  assert.throws(
    () => validateResult(result({ totalWireBytes: "lots" })),
    /non-negative safe integer/,
  );
});

test("accepts historical artifacts without Pi and rejects unknown or invalid providers", () => {
  const legacy = result();
  legacy.schemaVersion = 1;
  delete legacy.providers.pi;
  assert.equal(validateResult(legacy), legacy);
  assert.equal(validateResult(result()).providers.pi.observed.totalWireBytes, 2_200_000);

  const unknown = result();
  unknown.providers.unrecognized = unknown.providers.pi;
  assert.throws(() => validateResult(unknown), /unexpected fields/);

  const invalid = result();
  invalid.providers.pi.observed.totalWireBytes = -1;
  assert.throws(() => validateResult(invalid), /non-negative safe integer/);

  const missing = result();
  delete missing.providers.codex;
  assert.throws(() => validateResult(missing), /unexpected fields/);

  const missingPi = result();
  delete missingPi.providers.pi;
  assert.throws(() => validateResult(missingPi), /unexpected fields/);

  assert.throws(() => validateResult({ ...result(), schemaVersion: 3 }), /must be 1 or 2/);
});

test("reports Pi without losing existing provider comparisons against an older baseline", () => {
  const baseline = result();
  baseline.schemaVersion = 1;
  delete baseline.providers.pi;
  const comment = renderComment({
    current: result({ measuredTurnWebSocketWireBytes: 260_000 }),
    baseline,
    currentRun: { sha: "bbbbbbbb", conclusion: "success", url: "https://example.com/current" },
    baselineRun: { sha: "aaaaaaaa", matchesBase: true, url: "https://example.com/baseline" },
  });
  assert.match(comment, /\| Codex \| Live turn WebSocket wire .*\+9\.8 KiB \(\+4\.0%\)/);
  assert.match(comment, /\| Pi \| Live turn WebSocket wire \| — \| 244\.1 KiB \| — \|/);
  assert.match(comment, /Pi has no .*baseline measurement/);
  assert.match(comment, /Pi decoded thread snapshot/);
  assert.doesNotMatch(comment, /fixture changed/);

  const legacyComment = renderComment({
    current: baseline,
    baseline,
    currentRun: { sha: "aaaaaaaa", conclusion: "success", url: "https://example.com/legacy" },
    baselineRun: { sha: "aaaaaaaa", matchesBase: true, url: "https://example.com/baseline" },
  });
  assert.doesNotMatch(legacyComment, /\| Pi \|/);
});

test("compares Pi metrics and fails its exceeded ceiling", () => {
  const current = result();
  current.providers.pi.observed.measuredTurnWebSocketWireBytes = 340_000;
  current.providers.pi.ceiling.measuredTurnWebSocketWireBytes = 330_000;
  const comment = renderComment({
    current,
    baseline: result(),
    currentRun: { sha: "bbbbbbbb", conclusion: "failure", url: "https://example.com/current" },
    baselineRun: { sha: "aaaaaaaa", matchesBase: true, url: "https://example.com/baseline" },
  });
  assert.match(comment, /\| Pi \| Live turn WebSocket wire .*\+87\.9 KiB \(\+36\.0%\).*❌/);
  assert.match(comment, /One or more thread transfer ceilings were exceeded/);
  assert.match(comment, /Pi Live turn WebSocket wire: 312\.5 KiB → 322\.3 KiB/);
  assert.doesNotMatch(comment, /Pi has no .*baseline measurement/);
});

test("renders baseline, impact, ceiling, and ceiling changes", () => {
  const baseline = result();
  const current = result({ measuredTurnWebSocketWireBytes: 260_000 });
  current.providers.codex.ceiling = {
    ...current.providers.codex.ceiling,
    measuredTurnWebSocketWireBytes: 330_000,
  };
  const comment = renderComment({
    current,
    baseline,
    currentRun: {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      conclusion: "success",
      url: "https://github.com/rovecode/rove/actions/runs/2",
    },
    baselineRun: {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      matchesBase: true,
      url: "https://github.com/rovecode/rove/actions/runs/1",
    },
  });

  assert.match(comment, /Main baseline \| This PR \| Impact \| PR ceiling/);
  assert.match(comment, /\+9\.8 KiB \(\+4\.0%\)/);
  assert.match(comment, /This PR changes transfer ceilings/);
  assert.match(comment, /312\.5 KiB → 322\.3 KiB/);
  assert.match(comment, /<!-- rove-thread-transfer-report -->/);
  assert.match(
    comment,
    /<!-- rove-thread-transfer-result-sha:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->/,
  );
});

test("resolves a fallback PR with a redacted head repo and exact main baseline", async () => {
  const outputs = {};
  const listWorkflowRunArtifacts = () => {};
  const listWorkflowRuns = () => {};
  const listPullRequestsAssociatedWithCommit = () => {};
  const github = {
    paginate: async (method, input) => {
      if (method === listPullRequestsAssociatedWithCommit) {
        return [
          {
            number: 5350,
            state: "open",
            head: { sha: "head-sha", ref: "feature-branch", repo: null },
          },
        ];
      }
      if (method === listWorkflowRunArtifacts) {
        return [
          {
            name: "thread-transfer-results",
            expired: false,
            runId: input.run_id,
          },
        ];
      }
      if (method === listWorkflowRuns) {
        return [{ id: 1, head_sha: "base-sha" }];
      }
      throw new Error("unexpected pagination call");
    },
    rest: {
      actions: { listWorkflowRunArtifacts, listWorkflowRuns },
      pulls: {
        get: async () => ({
          data: {
            head: { sha: "head-sha" },
            base: { sha: "base-sha", ref: "main" },
          },
        }),
      },
      repos: { listPullRequestsAssociatedWithCommit },
    },
  };
  await resolve({
    github,
    context: {
      repo: { owner: "pingdotgg", repo: "rove" },
      payload: {
        workflow_run: {
          id: 2,
          event: "pull_request",
          workflow_id: 3,
          head_sha: "head-sha",
          head_branch: "feature-branch",
          head_repository: { full_name: "rovecode/rove" },
          conclusion: "success",
          pull_requests: [],
        },
      },
    },
    core: {
      info: () => {},
      setOutput: (key, value) => {
        outputs[key] = value;
      },
    },
  });

  assert.equal(outputs.publish, "true");
  assert.equal(outputs.pull_number, "5350");
  assert.equal(outputs.pr_artifact, "true");
  assert.equal(outputs.baseline_run_id, "1");
  assert.equal(outputs.baseline_matches_base, "true");
});

test("does not guess when a fallback commit belongs to multiple PRs", async () => {
  const outputs = {};
  const listPullRequestsAssociatedWithCommit = () => {};
  let fetchedPull = false;
  await resolve({
    github: {
      paginate: async (method) => {
        assert.equal(method, listPullRequestsAssociatedWithCommit);
        return [5350, 5351].map((number) => ({
          number,
          state: "open",
          head: {
            sha: "head-sha",
            ref: "feature-branch",
            repo: { full_name: "rovecode/rove" },
          },
        }));
      },
      rest: {
        actions: {},
        pulls: {
          get: async () => {
            fetchedPull = true;
          },
        },
        repos: { listPullRequestsAssociatedWithCommit },
      },
    },
    context: {
      repo: { owner: "pingdotgg", repo: "rove" },
      payload: {
        workflow_run: {
          id: 2,
          event: "pull_request",
          workflow_id: 3,
          head_sha: "head-sha",
          head_branch: "feature-branch",
          head_repository: { full_name: "rovecode/rove" },
          conclusion: "success",
          pull_requests: [],
        },
      },
    },
    core: {
      info: () => {},
      setOutput: (key, value) => {
        outputs[key] = value;
      },
    },
  });

  assert.equal(outputs.publish, "false");
  assert.equal(fetchedPull, false);
});

test("does not publish a stale result after the PR head advances", async () => {
  let listedComments = false;
  const info = [];
  const published = await upsertCommentForCurrentHead(
    {
      paginate: async () => {
        listedComments = true;
        return [];
      },
      rest: {
        issues: {
          listComments: () => {},
          createComment: () => {
            throw new Error("must not create a stale comment");
          },
          updateComment: () => {
            throw new Error("must not update a stale comment");
          },
        },
        pulls: {
          get: async () => ({ data: { head: { sha: "new-head-sha" } } }),
        },
      },
    },
    { repo: { owner: "pingdotgg", repo: "rove" } },
    { info: (message) => info.push(message) },
    5350,
    "old-head-sha",
    "stale body",
  );

  assert.equal(published, false);
  assert.equal(listedComments, false);
  assert.deepEqual(info, ["Skipping stale CI result old-head-sha; PR head is new-head-sha."]);
});

test("preserves a successful result when a same-SHA rerun has no artifact", async () => {
  let updatedComment = false;
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const published = await upsertCommentForCurrentHead(
    {
      paginate: async () => [
        {
          id: 1,
          user: { login: "github-actions[bot]" },
          body: `<!-- rove-thread-transfer-report -->\n<!-- rove-thread-transfer-result-sha:${sha} -->`,
        },
      ],
      rest: {
        issues: {
          listComments: () => {},
          createComment: () => {
            updatedComment = true;
          },
          updateComment: () => {
            updatedComment = true;
          },
        },
        pulls: {
          get: async () => ({ data: { head: { sha } } }),
        },
      },
    },
    { repo: { owner: "pingdotgg", repo: "rove" } },
    { info: () => {} },
    5350,
    sha,
    "missing artifact warning",
    { preserveResultSha: sha },
  );

  assert.equal(published, true);
  assert.equal(updatedComment, false);
});

test("accepts V2 without comparing it to the V1 scenario", () => {
  const current = result();
  current.scenario.id = "thread-transfer-v2";
  current.providers.codex.ceiling = { ...current.providers.codex.ceiling, totalWireBytes: 3000000 };
  assert.equal(validateResult(current), current);
  const comment = renderComment({
    current,
    baseline: result(),
    currentRun: { sha: "bbbbbbbb", conclusion: "success", url: "https://example.com/current" },
    baselineRun: { sha: "aaaaaaaa", matchesBase: true, url: "https://example.com/baseline" },
  });
  assert.match(comment, /fixture changed/);
  assert.doesNotMatch(comment, /This PR changes transfer ceilings/);
  assert.doesNotMatch(comment, /[+-]\d+\.\d+%/);
  current.scenario.id = "unrecognized";
  assert.throws(() => validateResult(current), /not supported/);
});
