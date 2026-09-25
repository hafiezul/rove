// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import {
  initTheme,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  PiExtensionStatusSnapshot,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import type { PiSessionEventLike } from "./PiAdapter.ts";

const textForDisplay = (text: string) =>
  NodeUtil.stripVTControlCharacters(text.slice(0, 65_536)).slice(0, 16_384);
const decodeAnswer = Schema.decodeUnknownSync(
  Schema.Struct({ answer: Schema.optional(Schema.String) }),
);

let themeInitialized = false;

/** Standard Pi dialogs use Rove's provider-neutral questions, never terminal emulation. */
export function createPiExtensionUI(
  fallback: ExtensionUIContext,
  emit: (event: PiSessionEventLike) => void,
  onPrompt: () => void,
  reportUnsupportedUI: () => void,
) {
  // Common extensions style status strings through ctx.ui.theme. Pi's SDK
  // leaves it uninitialized; use a built-in theme without a terminal watcher,
  // then strip ANSI at the display boundary rather than changing client themes.
  if (!themeInitialized) {
    initTheme("dark", false);
    themeInitialized = true;
  }
  let stopped = false;
  const pending = new Map<
    string,
    {
      answer: (answers: ProviderUserInputAnswers) => void;
      cancel: () => void;
    }
  >();
  let reportedUnsupported = false;
  const lastText = new Map<string, { text: string; message: string }>();
  const statuses = new Map<string, string>();
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const showStatus = (key: string, value: string | undefined) => {
    if (stopped) return;
    const displayKey = textForDisplay(key).slice(0, 120).trim() || "Pi extension";
    const text = value === undefined ? "" : textForDisplay(value).slice(0, 4096).trim();
    if (statuses.get(displayKey) === text || (!text && !statuses.has(displayKey))) return;
    if (!text) {
      statuses.delete(displayKey);
    } else {
      if (!statuses.has(displayKey) && statuses.size >= 64) {
        statuses.delete(statuses.keys().next().value!);
      }
      statuses.set(displayKey, text);
    }
    if (statusTimer !== undefined) return;
    // @effect-diagnostics-next-line globalTimers:off - Coalesce extension-owned UI bursts before sending a bounded snapshot.
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      let remaining = 8192;
      const visible: PiExtensionStatusSnapshot["statuses"][number][] = [];
      for (const [statusKey, statusText] of statuses) {
        if (remaining <= statusKey.length) break;
        const text = statusText.slice(0, remaining - statusKey.length);
        visible.push({ key: statusKey, text });
        remaining -= statusKey.length + text.length;
      }
      emit({ type: "rove_ui_status", statuses: visible });
    }, 250);
    statusTimer.unref();
  };
  const showText = (kind: string, key: string, value: string | undefined) => {
    if (stopped) return;
    const displayKey = textForDisplay(key).slice(0, 120);
    const id = `${kind}:${displayKey}`;
    if (value === undefined) {
      lastText.delete(id);
      return;
    }
    const text = textForDisplay(value).slice(0, 4096).trim();
    if (!text || lastText.get(id)?.text === text) return;
    if (!lastText.has(id) && lastText.size >= 64) {
      const oldest = lastText.keys().next().value!;
      lastText.delete(oldest);
    }
    lastText.set(id, { text, message: `${displayKey}: ${text}` });
    if (textTimer !== undefined) return;
    // @effect-diagnostics-next-line globalTimers:off - Coalesce SDK callbacks before publishing bounded text snapshots.
    textTimer = setTimeout(() => {
      textTimer = undefined;
      const message = [...lastText.values()]
        .map((entry) => entry.message)
        .join("\n")
        .slice(0, 8192);
      if (message) emit({ type: "rove_ui_text", message });
    }, 500);
    textTimer.unref();
  };
  const unsupported = () => {
    if (stopped || reportedUnsupported) return;
    reportedUnsupported = true;
    reportUnsupportedUI();
  };

  const ask = (
    title: string,
    description: string | undefined,
    choices: string[] | undefined,
    opts?: ExtensionUIDialogOptions,
    editor?: { prefill?: string | undefined },
  ): Promise<string | undefined> => {
    if (stopped || opts?.signal?.aborted) return Promise.resolve(undefined);
    if (pending.size >= 32) throw new Error("Too many pending Pi extension questions.");
    if (editor?.prefill !== undefined && editor.prefill.length > 65_536) {
      throw new Error("Pi extension editor prefill exceeds 65,536 characters in Rove.");
    }
    // Do not send an unbounded extension-owned array across the wire.
    if (choices && (choices.length === 0 || choices.length > 256)) {
      throw new Error("Pi extension selectors require between 1 and 256 options in Rove.");
    }
    const requestId = NodeCrypto.randomUUID();
    const question = {
      id: "answer",
      header: "Pi extension",
      question:
        textForDisplay([title, description].filter(Boolean).join("\n\n")).trim() ||
        "Pi extension input",
      options:
        choices?.map((choice, index) => ({
          label: textForDisplay(choice).slice(0, 512).trim() || `Option ${index + 1}`,
          description: "",
          value: String(index),
        })) ?? [],
      allowCustomAnswer: choices === undefined,
      ...(editor ? { inputMode: "multiline" as const } : undefined),
      ...(editor?.prefill !== undefined ? { initialAnswer: editor.prefill } : undefined),
      multiSelect: false,
    } satisfies UserInputQuestion;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: string | undefined, answer?: string) => {
        if (!pending.delete(requestId)) return;
        if (timer !== undefined) clearTimeout(timer);
        opts?.signal?.removeEventListener("abort", cancel);
        emit({
          type: "rove_ui_resolved",
          requestId,
          answers: answer === undefined ? {} : { answer },
        });
        resolve(value);
      };
      const cancel = () => finish(undefined);
      pending.set(requestId, {
        cancel,
        answer: (answers) => {
          const { answer } = decodeAnswer(answers);
          if (answer === undefined) return cancel();
          if (choices === undefined) return finish(answer, answer);
          const index = question.options.findIndex((option) => option.value === answer);
          if (index < 0) throw new Error("Choose one of the Pi extension's offered options.");
          finish(choices[index], answer);
        },
      });
      opts?.signal?.addEventListener("abort", cancel, { once: true });
      if (opts?.signal?.aborted) {
        cancel();
        return;
      }
      if (opts?.timeout !== undefined && Number.isFinite(opts.timeout)) {
        // @effect-diagnostics-next-line globalTimers:off - Pi's Promise UI owns and clears this SDK dialog deadline.
        timer = setTimeout(cancel, Math.max(0, opts.timeout));
        timer.unref();
      }
      // Accept the command before waiting: provider-command processing must be
      // free to route the answer (or Stop) back to this session.
      try {
        onPrompt();
        emit({ type: "rove_ui_request", requestId, questions: [question] });
      } catch (error) {
        cancel();
        throw error;
      }
    });
  };

  const ui: ExtensionUIContext = {
    ...fallback,
    select: (title, choices, opts) => ask(title, undefined, choices, opts),
    confirm: async (title, message, opts) =>
      (await ask(title, message, ["Yes", "No"], opts)) === "Yes",
    input: (title, placeholder, opts) => ask(title, placeholder, undefined, opts),
    editor: (title, prefill) => ask(title, undefined, undefined, undefined, { prefill }),
    notify: (message, level = "info") => {
      const text = textForDisplay(message).trim();
      if (!stopped && text) emit({ type: "rove_ui_notify", message: text, level });
    },
    custom: (factory, options) => {
      unsupported();
      // Match Pi's RPC fallback without executing a terminal component factory.
      return fallback.custom(factory, options);
    },
    onTerminalInput: (handler) => {
      unsupported();
      return fallback.onTerminalInput(handler);
    },
    setStatus: showStatus,
    setWorkingMessage: (text) => showText("working", "Pi", text),
    setWidget: (key, content) => {
      if (content === undefined || Array.isArray(content)) {
        showText("widget", key, content?.slice(0, 128).join("\n"));
      } else unsupported();
    },
    setEditorText: unsupported,
    pasteToEditor: unsupported,
    setEditorComponent: unsupported,
    setFooter: unsupported,
    setHeader: unsupported,
    setTitle: unsupported,
    addAutocompleteProvider: unsupported,
  };
  return {
    ui,
    get hasPendingInput() {
      return pending.size > 0;
    },
    respond: (requestId: string, answers: ProviderUserInputAnswers) => {
      const request = pending.get(requestId);
      if (!request) return false;
      request.answer(answers);
      return true;
    },
    stop: () => {
      stopped = true;
      if (textTimer !== undefined) clearTimeout(textTimer);
      if (statusTimer !== undefined) clearTimeout(statusTimer);
      textTimer = undefined;
      statusTimer = undefined;
      lastText.clear();
      statuses.clear();
      for (const request of pending.values()) request.cancel();
    },
  };
}
