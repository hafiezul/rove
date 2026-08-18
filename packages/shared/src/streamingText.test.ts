import { describe, expect, it } from "vite-plus/test";

import {
  advanceSmoothedStreamingText,
  SMOOTH_STREAMING_MAX_CHARS_PER_FRAME,
} from "./streamingText.js";

describe("advanceSmoothedStreamingText", () => {
  it("reveals an append-only provider update in bounded chunks", () => {
    const source = "a".repeat(SMOOTH_STREAMING_MAX_CHARS_PER_FRAME + 12);

    const first = advanceSmoothedStreamingText("", source);
    expect(first).toHaveLength(SMOOTH_STREAMING_MAX_CHARS_PER_FRAME);
    expect(first).toBe(source.slice(0, SMOOTH_STREAMING_MAX_CHARS_PER_FRAME));
    expect(advanceSmoothedStreamingText(first, source)).toBe(source);
  });

  it("applies a replacement immediately instead of retaining stale text", () => {
    expect(advanceSmoothedStreamingText("old response", "new response")).toBe("new response");
  });

  it("never reveals half of a surrogate pair", () => {
    const source = "A🙂B";

    expect(advanceSmoothedStreamingText("A", source, 1)).toBe("A🙂");
  });
});
