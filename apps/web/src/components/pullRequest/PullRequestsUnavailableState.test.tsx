import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import * as RuntimePredicate from "effect/Predicate";

function textOf(node: ReactNode): string {
  if (RuntimePredicate.isString(node) || RuntimePredicate.isNumber(node)) return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

describe("PullRequestsUnavailableState", () => {
  it("can explain an unsupported environment without offering a futile retry", () => {
    const text = textOf(
      PullRequestsUnavailableState({
        title: "Pull requests unavailable",
        error: "Update this environment's Rove server to browse pull requests.",
      }),
    );

    expect(text).toContain("Pull requests unavailable");
    expect(text).toContain("Update this environment's Rove server");
    expect(text).not.toContain("Retry");
  });

  it("retains the retry for transient load failures", () => {
    expect(
      textOf(PullRequestsUnavailableState({ error: "GitHub did not answer.", onRetry: () => {} })),
    ).toContain("Retry");
  });
});
