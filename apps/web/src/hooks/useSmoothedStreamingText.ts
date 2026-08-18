import {
  advanceSmoothedStreamingText,
  SMOOTH_STREAMING_FRAME_INTERVAL_MS,
} from "@t3tools/shared/streamingText";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Decouples a provider's bursty token cadence from expensive markdown/list
 * rendering. Source text remains authoritative; only an append-only live
 * prefix is paced, and completed or replacement text is shown immediately.
 */
export function useSmoothedStreamingText(sourceText: string, streaming: boolean): string {
  const [renderedText, setRenderedText] = useState(sourceText);
  const renderedTextRef = useRef(sourceText);
  const sourceTextRef = useRef(sourceText);
  const streamingRef = useRef(streaming);
  const frameRef = useRef<number | null>(null);
  const lastRenderAtRef = useRef<number | null>(null);

  const cancelScheduledFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const commitRenderedText = useCallback((nextText: string) => {
    if (renderedTextRef.current === nextText) {
      return;
    }
    renderedTextRef.current = nextText;
    setRenderedText(nextText);
  }, []);

  const renderNextFrame = useCallback(
    function renderNextFrame(timestamp: number) {
      frameRef.current = null;
      if (!streamingRef.current) {
        return;
      }

      const source = sourceTextRef.current;
      const rendered = renderedTextRef.current;
      if (!source.startsWith(rendered)) {
        lastRenderAtRef.current = null;
        commitRenderedText(source);
        return;
      }
      if (source === rendered) {
        return;
      }

      const lastRenderAt = lastRenderAtRef.current;
      if (lastRenderAt !== null && timestamp - lastRenderAt < SMOOTH_STREAMING_FRAME_INTERVAL_MS) {
        frameRef.current = requestAnimationFrame(renderNextFrame);
        return;
      }

      lastRenderAtRef.current = timestamp;
      const nextText = advanceSmoothedStreamingText(rendered, source);
      commitRenderedText(nextText);
      if (nextText !== source) {
        frameRef.current = requestAnimationFrame(renderNextFrame);
      }
    },
    [commitRenderedText],
  );

  const scheduleNextFrame = useCallback(() => {
    if (frameRef.current === null) {
      frameRef.current = requestAnimationFrame(renderNextFrame);
    }
  }, [renderNextFrame]);

  useEffect(() => {
    sourceTextRef.current = sourceText;
    streamingRef.current = streaming;
    const rendered = renderedTextRef.current;

    if (!streaming) {
      cancelScheduledFrame();
      lastRenderAtRef.current = null;
      commitRenderedText(sourceText);
      return;
    }

    if (!sourceText.startsWith(rendered)) {
      cancelScheduledFrame();
      lastRenderAtRef.current = null;
      commitRenderedText(sourceText);
      return;
    }

    if (rendered !== sourceText) {
      scheduleNextFrame();
    }
  }, [cancelScheduledFrame, commitRenderedText, scheduleNextFrame, sourceText, streaming]);

  useEffect(() => cancelScheduledFrame, [cancelScheduledFrame]);

  // Never delay a settled response or show a stale prefix after a provider
  // replacement. The paced path is solely for append-only live text.
  return !streaming || !sourceText.startsWith(renderedText) ? sourceText : renderedText;
}
