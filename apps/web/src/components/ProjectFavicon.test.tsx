import type { ComponentType, Dispatch, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as RuntimePredicate from "effect/Predicate";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastResource: null as AssetResource | null,
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
        slots[index] = RuntimePredicate.isFunction(initialValue)
          ? (initialValue as () => T)()
          : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
          previous = slots[index] as T;
        // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
        slots[index] = RuntimePredicate.isFunction(nextValue)
          ? (nextValue as (value: T) => T)(previous)
          : nextValue;
      };
      // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: EnvironmentId, resource: AssetResource) => {
    testState.lastResource = resource;
    return { _tag: "Success", url: testState.faviconUrl };
  },
}));

import { ProjectFavicon } from "./ProjectFavicon";

type ProjectFaviconImageProps = {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
};

type ImageElement = ReactElement<{
  readonly src: string;
  readonly onLoad?: () => void;
  readonly onError?: () => void;
}>;

type ProjectFaviconImageElement = ReactElement<{
  readonly children: [ReactElement | null, ImageElement | null, ImageElement | null];
}>;

function resolveImageComponent() {
  hooks.beginRender();
  const // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace-test",
    }) as ReactElement<ProjectFaviconImageProps>;
  hooks.reset();

  // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
  return {
    Component: element.type as (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
    props: element.props,
  };
}

function renderImage(
  Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
  props: ProjectFaviconImageProps,
): ProjectFaviconImageElement {
  hooks.beginRender();
  return Component(props);
}

describe("ProjectFavicon", () => {
  beforeEach(() => {
    hooks.reset();
  });

  it("falls back when the displayed favicon fails without discarding a valid older image early", () => {
    const { Component, props } = resolveImageComponent();
    const initialLoadingImage = renderImage(Component, props).props.children[2];
    initialLoadingImage?.props.onLoad?.();

    const refreshedProps = {
      ...props,
      src: "https://environment.test/api/assets/token-b/v1-20-favicon.svg",
    };
    const refreshing = renderImage(Component, refreshedProps).props.children;
    expect(refreshing[1]?.props.src).toBe(props.src);
    refreshing[2]?.props.onError?.();

    const afterRefreshError = renderImage(Component, refreshedProps).props.children;
    expect(afterRefreshError[1]?.props.src).toBe(props.src);
    afterRefreshError[1]?.props.onError?.();

    const afterDisplayedError = renderImage(Component, refreshedProps).props.children;
    expect(afterDisplayedError[0]).not.toBeNull();
    expect(afterDisplayedError[1]).toBeNull();
  });

  it("requests a saved favicon path when one is set", () => {
    ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace-test",
      faviconPath: "brand/icon.svg",
    });

    expect(testState.lastResource).toEqual({
      _tag: "project-favicon",
      cwd: "/workspace-test",
      path: "brand/icon.svg",
    });
  });
});
