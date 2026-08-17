import { useEffect } from "react";

import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { ReviewSectionItem } from "./reviewModel";
import { getCachedReviewParsedDiff } from "./reviewState";
import * as RuntimePredicate from "effect/Predicate";

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

function scheduleIdle(callback: IdleCallback): number {
  if (RuntimePredicate.isFunction(globalThis.requestIdleCallback)) {
    return globalThis.requestIdleCallback(callback, { timeout: 2_000 });
  }

  // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
  return setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 100) as number;
}

function cancelIdle(handle: number): void {
  if (RuntimePredicate.isFunction(globalThis.cancelIdleCallback)) {
    globalThis.cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle);
}

export function prewarmReviewDiffSection(input: {
  readonly threadKey: string;
  readonly section: ReviewSectionItem;
}): void {
  const { section, threadKey } = input;
  if (section.diff === null) {
    return;
  }

  const parsedDiff = getCachedReviewParsedDiff({
    threadKey,
    sectionId: section.id,
    diff: section.diff,
  });
  getCachedNativeReviewDiffData({ parsedDiff, comments: [] });
}

/** Warms one cached section per idle period, after navigation animations finish. */
export function useReviewDiffPrewarming(input: {
  readonly threadKey: string | null;
  readonly sections: ReadonlyArray<ReviewSectionItem>;
  readonly selectedSectionId: string | null;
}): void {
  const { sections, selectedSectionId, threadKey } = input;

  useEffect(() => {
    if (!threadKey) {
      return;
    }

    const pendingSections = sections.filter(
      (section) => section.id !== selectedSectionId && section.diff !== null,
    );
    if (pendingSections.length === 0) {
      return;
    }

    let cancelled = false;
    let idleHandle: number | null = null;
    let nextSectionIndex = 0;

    const scheduleNext = () => {
      idleHandle = scheduleIdle(() => {
        if (cancelled) {
          return;
        }

        const section = pendingSections[nextSectionIndex];
        if (!section) {
          return;
        }
        nextSectionIndex += 1;
        prewarmReviewDiffSection({ threadKey, section });

        if (nextSectionIndex < pendingSections.length) {
          scheduleNext();
        }
      });
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (idleHandle !== null) {
        cancelIdle(idleHandle);
      }
    };
  }, [sections, selectedSectionId, threadKey]);
}
