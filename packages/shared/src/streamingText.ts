/**
 * Maximum amount of a streaming payload revealed in one visual update.
 * Keeping this bounded turns provider bursts into a short, steady reveal
 * instead of a single layout-changing jump.
 */
export const SMOOTH_STREAMING_MAX_CHARS_PER_FRAME = 160;

/**
 * Text renderers use this cadence while a provider is streaming. It is below
 * display refresh rate so markdown parsing and list measurement do not compete
 * with input/scroll work on every animation frame.
 */
export const SMOOTH_STREAMING_FRAME_INTERVAL_MS = 48;

/**
 * Advances a rendered streaming prefix toward the authoritative provider text.
 * A replacement (rather than an append) is applied immediately so a retry,
 * correction, or newly keyed message can never leave stale text on screen.
 */
export function advanceSmoothedStreamingText(
  renderedText: string,
  sourceText: string,
  maxChars = SMOOTH_STREAMING_MAX_CHARS_PER_FRAME,
): string {
  if (renderedText === sourceText) {
    return renderedText;
  }
  if (!sourceText.startsWith(renderedText)) {
    return sourceText;
  }

  const safeMaxChars = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : SMOOTH_STREAMING_MAX_CHARS_PER_FRAME;
  let end = Math.min(sourceText.length, renderedText.length + safeMaxChars);

  // Do not briefly render half of a UTF-16 surrogate pair while revealing an
  // emoji or another astral-plane character.
  if (
    end < sourceText.length &&
    isHighSurrogate(sourceText.charCodeAt(end - 1)) &&
    isLowSurrogate(sourceText.charCodeAt(end))
  ) {
    // If the requested chunk is only the high surrogate, include its matching
    // low surrogate rather than producing an empty update that would stall.
    end = end - 1 > renderedText.length ? end - 1 : Math.min(sourceText.length, end + 1);
  }

  return sourceText.slice(0, Math.max(end, renderedText.length));
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
