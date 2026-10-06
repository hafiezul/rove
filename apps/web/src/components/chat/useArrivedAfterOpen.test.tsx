import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useArrivedAfterOpen } from "./useArrivedAfterOpen";

let root: Root;
let arrived: (id: string) => boolean;
let frames: Array<FrameRequestCallback> = [];

function Probe(props: { ids: ReadonlyArray<string>; scopeKey: string }) {
  const arrivedAfterOpen = useArrivedAfterOpen(props.ids, props.scopeKey);
  useLayoutEffect(() => {
    arrived = arrivedAfterOpen;
  });
  return null;
}

async function render(ids: ReadonlyArray<string>, scopeKey = "thread-a") {
  await act(() => root.render(<Probe ids={ids} scopeKey={scopeKey} />));
}

/** Runs the two frames the scope waits for before treating arrivals as new. */
async function paintOpeningFrames() {
  for (let frame = 0; frame < 2; frame++) {
    const pending = frames;
    frames = [];
    await act(() => {
      for (const callback of pending) callback(0);
    });
  }
}

beforeEach(() => {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  frames = [];
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: EventTarget,
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    cancelAnimationFrame: () => {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // SAFETY: the probe renders nothing, so ReactDOM only touches the stubbed fields.
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useArrivedAfterOpen", () => {
  it("renders ids restored with the scope in place and flags later arrivals", async () => {
    await render(["restored"]);
    expect(arrived("restored")).toBe(false);

    await paintOpeningFrames();
    expect(arrived("restored")).toBe(false);

    await render(["restored", "new"]);
    expect(arrived("new")).toBe(true);
  });

  it("treats ids that load during the opening frames as restored", async () => {
    await render([]);
    await render(["late-restore"]);
    await paintOpeningFrames();
    expect(arrived("late-restore")).toBe(false);
  });

  it("starts over when the scope changes", async () => {
    await render([]);
    await paintOpeningFrames();
    await render(["pending"]);
    expect(arrived("pending")).toBe(true);

    await render(["other-pending"], "thread-b");
    expect(arrived("other-pending")).toBe(false);
    await paintOpeningFrames();
    expect(arrived("other-pending")).toBe(false);
  });
});
