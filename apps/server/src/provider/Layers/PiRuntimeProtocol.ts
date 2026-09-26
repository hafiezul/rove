import type { PiCatalogHost, PiCatalogHostOptions } from "./PiCatalogHost.ts";
import type { PiCreateSessionInput, PiSessionEventLike, PiSessionLike } from "./PiAdapter.ts";
import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";

export type PiPromptOptions = Omit<
  NonNullable<Parameters<PiSessionLike["prompt"]>[1]>,
  "preflightResult"
>;

type SessionMethod =
  | "followUp"
  | "compact"
  | "abort"
  | "dispose"
  | "setModel"
  | "setThinkingLevel"
  | "respondToUserInput"
  | "fork";
type SessionCalls = {
  [K in SessionMethod]: {
    args: [key: number, ...Parameters<NonNullable<PiSessionLike[K]>>];
    result: Awaited<ReturnType<NonNullable<PiSessionLike[K]>>>;
  };
};
type CatalogMethod =
  | "getCatalog"
  | "refreshCatalog"
  | "getCatalogModels"
  | "getExtensionSlashCommands";
type CatalogCalls = {
  [K in CatalogMethod]: {
    args: Parameters<PiCatalogHost[K]>;
    result: Awaited<ReturnType<PiCatalogHost[K]>>;
  };
};
export type PiRuntimeCalls = SessionCalls &
  CatalogCalls & {
    initialize: { args: [PiCatalogHostOptions]; result: void };
    createSession: {
      args: [
        key: number,
        input: PiCreateSessionInput,
        textGeneration: boolean,
        mcp: McpProviderSessionConfig | undefined,
      ];
      result: void;
    };
    prompt: { args: [key: number, text: string, options: PiPromptOptions]; result: void };
    shutdown: { args: []; result: void };
  };
export type PiRuntimeRequest = {
  [K in keyof PiRuntimeCalls]: { id: number; method: K; args: PiRuntimeCalls[K]["args"] };
}[keyof PiRuntimeCalls];

export interface PiSessionState {
  sessionId: string;
  sessionFile: PiSessionLike["sessionFile"];
  resumeOutcome: PiSessionLike["resumeOutcome"];
  modelFallbackMessage: PiSessionLike["modelFallbackMessage"];
  isStreaming: boolean;
  hasPendingUserInput: boolean;
  isPreparingPrompt: boolean;
  autoCompactionEnabled: PiSessionLike["autoCompactionEnabled"];
  thinkingLevel: string | undefined;
  model: ReturnType<NonNullable<PiSessionLike["getModel"]>>;
  stats: ReturnType<NonNullable<PiSessionLike["getSessionStats"]>>;
  leafId: string | undefined;
}
export interface PiArrayPatch<T> {
  from: number;
  items: ReadonlyArray<T>;
}
export interface PiSessionUpdate {
  state: Partial<PiSessionState>;
  messages?: PiArrayPatch<unknown> | undefined;
  entries?: PiArrayPatch<ReturnType<NonNullable<PiSessionLike["getEntries"]>>[number]> | undefined;
  branch?: PiArrayPatch<ReturnType<NonNullable<PiSessionLike["getBranch"]>>[number]> | undefined;
}
export type PiRuntimeMessage =
  | {
      type: "reply";
      id: number;
      result?: unknown;
      error?: { message: string; failedExtensionPaths?: ReadonlyArray<string> };
    }
  | { type: "state"; key: number; update: PiSessionUpdate }
  | { type: "event"; key: number; event: PiSessionEventLike }
  | { type: "preflight"; id: number; success: boolean }
  | { type: "catalogChanged" };
