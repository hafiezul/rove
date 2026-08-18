import * as RuntimePredicate from "effect/Predicate";

import type {
  DesktopAppBranding,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingFrame,
  DesktopPreviewTabState,
  DesktopSshPasswordPromptRequest,
  DesktopUpdateState,
} from "@t3tools/contracts";
import type { Json as SchemaJson } from "effect/Schema";

type RecordValue = Record<string, SchemaJson>;

export const isRecord = (value: unknown): value is RecordValue =>
  RuntimePredicate.isObjectOrArray(value) && !Array.isArray(value);

export const isString = RuntimePredicate.isString;

export const isBoolean = RuntimePredicate.isBoolean;

const isNumber = (value: unknown): value is number =>
  RuntimePredicate.isNumber(value) && Number.isFinite(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);

const isTrimmedNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.trim() === value;

// The main process encodes request/response payloads with contract schemas. These guards keep
// malformed asynchronous event data out of the context bridge without requiring packages from a
// sandboxed preload.
export const isDesktopAppBranding = (value: unknown): value is DesktopAppBranding =>
  isRecord(value) &&
  isString(value.baseName) &&
  isString(value.stageLabel) &&
  isString(value.displayName);

export const isDesktopSshPasswordPromptRequest = (
  value: unknown,
): value is DesktopSshPasswordPromptRequest =>
  isRecord(value) &&
  isString(value.requestId) &&
  isString(value.destination) &&
  isNullableString(value.username) &&
  isString(value.prompt) &&
  isString(value.expiresAt);

export const isDesktopUpdateState = (value: unknown): value is DesktopUpdateState =>
  isRecord(value) &&
  isBoolean(value.enabled) &&
  isString(value.status) &&
  isString(value.channel) &&
  isString(value.currentVersion) &&
  isBoolean(value.canRetry);

export const isDesktopPreviewRecordingFrame = (
  value: unknown,
): value is DesktopPreviewRecordingFrame =>
  isRecord(value) &&
  isTrimmedNonEmptyString(value.tabId) &&
  isString(value.data) &&
  isNumber(value.width) &&
  isNumber(value.height) &&
  isString(value.receivedAt);

export const isDesktopPreviewTabState = (value: unknown): value is DesktopPreviewTabState =>
  isRecord(value) &&
  isTrimmedNonEmptyString(value.tabId) &&
  (value.webContentsId === null || Number.isInteger(value.webContentsId)) &&
  isRecord(value.navStatus) &&
  isString(value.navStatus.kind) &&
  isBoolean(value.canGoBack) &&
  isBoolean(value.canGoForward) &&
  isNumber(value.zoomFactor) &&
  isBoolean(value.pictureInPicture) &&
  isString(value.colorScheme) &&
  isString(value.controller) &&
  isString(value.updatedAt);

export const isDesktopPreviewPointerEvent = (value: unknown): value is DesktopPreviewPointerEvent =>
  isRecord(value) &&
  isTrimmedNonEmptyString(value.tabId) &&
  isString(value.phase) &&
  isNumber(value.x) &&
  isNumber(value.y) &&
  Number.isInteger(value.sequence) &&
  isString(value.createdAt);
