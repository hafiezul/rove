import { describe, expect, it } from "vite-plus/test";

import {
  buildPiLaunchPlan,
  buildPiModelProbeLaunchPlan,
  buildPiTextGenerationLaunchPlan,
  parsePiVersion,
  PI_MINIMUM_VERSION,
  validatePiLaunchArgs,
} from "./PiRuntime.ts";

describe("Pi runtime launch plan", () => {
  it("keeps the Pi configuration directory in PI_CODING_AGENT_DIR", () => {
    const plan = buildPiLaunchPlan({
      configDirectory: "/Users/example/.pi-work",
      launchArgs: "--verbose",
      trustedExtensions: [],
      sessionDirectory: "/tmp/t3/pi/work",
      sessionId: "thread_123",
    });

    expect(plan).toEqual({
      _tag: "Success",
      args: [
        "--verbose",
        "--mode",
        "rpc",
        "--no-extensions",
        "--session-dir",
        "/tmp/t3/pi/work",
        "--session-id",
        "thread_123",
      ],
      environment: { PI_CODING_AGENT_DIR: "/Users/example/.pi-work" },
    });
  });

  it("disables discovered extensions when no trusted extension is selected", () => {
    const plan = buildPiLaunchPlan({
      configDirectory: "",
      launchArgs: "",
      trustedExtensions: [],
      sessionDirectory: "/tmp/t3/pi/work",
      sessionId: "thread_123",
    });

    expect(plan).toEqual({
      _tag: "Success",
      args: [
        "--mode",
        "rpc",
        "--no-extensions",
        "--session-dir",
        "/tmp/t3/pi/work",
        "--session-id",
        "thread_123",
      ],
      environment: {},
    });
    if (plan._tag === "Success") {
      expect(plan.args).toContain("--no-extensions");
    }
  });

  it("loads only the selected trusted extensions alongside --no-extensions", () => {
    expect(
      buildPiLaunchPlan({
        configDirectory: "",
        launchArgs: "--verbose",
        trustedExtensions: ["/tmp/t3-pi-extension.ts", " ~/pi-extensions/guard.ts "],
        sessionDirectory: "/tmp/t3/pi/work",
        sessionId: "thread_123",
      }),
    ).toEqual({
      _tag: "Success",
      args: [
        "--verbose",
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        "/tmp/t3-pi-extension.ts",
        "--extension",
        "~/pi-extensions/guard.ts",
        "--session-dir",
        "/tmp/t3/pi/work",
        "--session-id",
        "thread_123",
      ],
      environment: {},
    });
  });

  it("adds the env escape hatch extension after the selected trusted extensions", () => {
    expect(
      buildPiLaunchPlan({
        configDirectory: "",
        launchArgs: "",
        trustedExtensions: ["/tmp/t3-pi-extension.ts"],
        sessionDirectory: "/tmp/t3/pi/work",
        sessionId: "thread_123",
        environment: { T3CODE_PI_EXTENSION: " /tmp/env-extension.ts " },
      }),
    ).toEqual({
      _tag: "Success",
      args: [
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        "/tmp/t3-pi-extension.ts",
        "--extension",
        "/tmp/env-extension.ts",
        "--session-dir",
        "/tmp/t3/pi/work",
        "--session-id",
        "thread_123",
      ],
      environment: {},
    });
  });

  it("ignores blank trusted extension entries", () => {
    const plan = buildPiLaunchPlan({
      configDirectory: "",
      launchArgs: "",
      trustedExtensions: ["  "],
      sessionDirectory: "/tmp/t3/pi/work",
      sessionId: "thread_123",
    });

    if (plan._tag !== "Success") {
      throw new Error("expected a successful launch plan");
    }
    expect(plan.args).toContain("--no-extensions");
    expect(plan.args).not.toContain("--extension");
  });

  it.each([
    "--mode json",
    "--session-dir /tmp/other",
    "--session other",
    "--session=other",
    "--session-id=other",
    "--no-session",
    "--no-extensions",
    "--extension /tmp/t3-pi-extension.ts",
    "--extension=/tmp/t3-pi-extension.ts",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--fork prior-session",
  ])("rejects user launch arguments that override managed Pi parameters: %s", (launchArgs) => {
    expect(
      buildPiLaunchPlan({
        configDirectory: "",
        launchArgs,
        trustedExtensions: [],
        sessionDirectory: "/tmp/t3/pi/work",
        sessionId: "thread_123",
      }),
    ).toEqual({ _tag: "Failure", message: expect.stringContaining("managed by T3 Code") });
  });
});

describe("Pi model probe launch plan", () => {
  it("uses Pi RPC without creating a probe session", () => {
    expect(
      buildPiModelProbeLaunchPlan({
        configDirectory: "/Users/example/.pi-work",
        launchArgs: "--verbose",
        trustedExtensions: ["/tmp/t3-pi-extension.ts"],
      }),
    ).toEqual({
      _tag: "Success",
      args: [
        "--verbose",
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        "/tmp/t3-pi-extension.ts",
        "--no-session",
      ],
      environment: { PI_CODING_AGENT_DIR: "/Users/example/.pi-work" },
    });
  });
});

describe("validatePiLaunchArgs", () => {
  it("rejects T3 Code managed flags before launching Pi", () => {
    expect(validatePiLaunchArgs("--mode json")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--session-dir=/tmp/other")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--session-id=other")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--no-session")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--no-extensions")).toContain("managed by T3 Code");
    expect(validatePiLaunchArgs("--extension /tmp/t3-pi-extension.ts")).toContain(
      "managed by T3 Code",
    );
    expect(validatePiLaunchArgs("--verbose")).toBeUndefined();
  });

  it("allows project-trust overrides so the probe can load project skills", () => {
    expect(validatePiLaunchArgs("--approve")).toBeUndefined();
    expect(validatePiLaunchArgs("--no-approve")).toBeUndefined();
    expect(
      buildPiModelProbeLaunchPlan({
        configDirectory: "",
        launchArgs: "--approve",
        trustedExtensions: [],
        environment: { T3CODE_PI_EXTENSION: "/tmp/env-extension.ts" },
      }),
    ).toEqual({
      _tag: "Success",
      args: [
        "--approve",
        "--mode",
        "rpc",
        "--no-extensions",
        "--extension",
        "/tmp/env-extension.ts",
        "--no-session",
      ],
      environment: {},
    });
  });
});

describe("Pi text generation launch plan", () => {
  it("isolates the run from tools, resources, and project trust", () => {
    expect(
      buildPiTextGenerationLaunchPlan({
        configDirectory: "",
        model: { provider: "vibeproxy", modelId: "claude-sonnet-5" },
      }),
    ).toEqual({
      args: [
        "-p",
        "--no-session",
        "--no-approve",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--thinking",
        "off",
        "--provider",
        "vibeproxy",
        "--model",
        "claude-sonnet-5",
      ],
      environment: {},
    });
  });

  it("keeps the Pi configuration directory in PI_CODING_AGENT_DIR", () => {
    expect(
      buildPiTextGenerationLaunchPlan({
        configDirectory: "/Users/example/.pi-work",
        model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      }).environment,
    ).toEqual({ PI_CODING_AGENT_DIR: "/Users/example/.pi-work" });
  });

  it("passes provider and model separately so slashes in a model id stay intact", () => {
    const plan = buildPiTextGenerationLaunchPlan({
      configDirectory: "",
      model: { provider: "rootsys.cloud", modelId: "fiq/kimi-k3" },
    });

    expect(plan.args).toContain("--provider");
    expect(plan.args[plan.args.indexOf("--provider") + 1]).toBe("rootsys.cloud");
    expect(plan.args[plan.args.indexOf("--model") + 1]).toBe("fiq/kimi-k3");
    expect(plan.args).not.toContain("rootsys.cloud/fiq/kimi-k3");
  });
});

describe("parsePiVersion", () => {
  it("accepts Pi 0.82.0 and newer", () => {
    expect(parsePiVersion("pi 0.82.0")).toEqual({ _tag: "Supported", version: PI_MINIMUM_VERSION });
    expect(parsePiVersion("pi 0.83.1")).toEqual({ _tag: "Supported", version: "0.83.1" });
  });

  it("reports an upgrade requirement for older Pi versions", () => {
    expect(parsePiVersion("pi 0.81.1")).toEqual({ _tag: "Unsupported", version: "0.81.1" });
    expect(parsePiVersion("pi 0.81.0")).toEqual({ _tag: "Unsupported", version: "0.81.0" });
    expect(parsePiVersion("pi 0.80.99")).toEqual({ _tag: "Unsupported", version: "0.80.99" });
  });

  it("reports invalid version output", () => {
    expect(parsePiVersion("not a version")).toEqual({ _tag: "Invalid" });
  });
});
