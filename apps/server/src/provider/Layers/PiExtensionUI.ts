// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";
import {
  initTheme,
  type ExtensionUIContext,
  type ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
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
  const warned = new Set<string>();
  const lastText = new Map<string, string>();
  const textUpdates = new Map<string, string>();
  let textTimer: ReturnType<typeof setTimeout> | undefined;
  const showText = (kind: string, key: string, value: string | undefined) => {
    if (stopped) return;
    const displayKey = textForDisplay(key).slice(0, 120);
    const id = `${kind}:${displayKey}`;
    if (value === undefined) {
      lastText.delete(id);
      textUpdates.delete(id);
      return;
    }
    const text = textForDisplay(value).slice(0, 4096).trim();
    if (!text || lastText.get(id) === text) return;
    if (!lastText.has(id) && lastText.size >= 64) {
      const oldest = lastText.keys().next().value!;
      lastText.delete(oldest);
      textUpdates.delete(oldest);
    }
    lastText.set(id, text);
    textUpdates.set(id, `${displayKey}: ${text}`);
    if (textTimer !== undefined) return;
    // @effect-diagnostics-next-line globalTimers:off - Coalesce SDK callbacks before publishing bounded text snapshots.
    textTimer = setTimeout(() => {
      textTimer = undefined;
      const message = [...textUpdates.values()].join("\n").slice(0, 8192);
      textUpdates.clear();
      if (message) emit({ type: "rove_ui_notify", message, level: "info" });
    }, 500);
    textTimer.unref();
  };
  const unsupported = (method: string) => {
    if (stopped || warned.has(method)) return;
    warned.add(method);
    emit({
      type: "rove_ui_notify",
      level: "warning",
      message: `Pi extension UI ${method} is not supported in Rove. Use Pi's terminal UI for this feature.`,
    });
  };

  const ask = (
    title: string,
    description: string | undefined,
    choices: string[] | undefined,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> => {
    if (stopped || opts?.signal?.aborted) return Promise.resolve(undefined);
    if (pending.size >= 32) throw new Error("Too many pending Pi extension questions.");
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
    // Rove's free-text question preserves multi-line responses. Prefill is shown
    // as context rather than overwriting a draft on an arbitrary remote client.
    editor: (title, prefill) => ask(title, prefill, undefined),
    notify: (message, level = "info") => {
      const text = textForDisplay(message).trim();
      if (!stopped && text) emit({ type: "rove_ui_notify", message: text, level });
    },
    custom: (factory, options) => {
      unsupported("custom");
      // Match Pi's RPC fallback without executing a terminal component factory.
      return fallback.custom(factory, options);
    },
    setStatus: (key, text) => showText("status", key, text),
    setWorkingMessage: (text) => showText("working", "Pi", text),
    setWidget: (key, content) => {
      if (content === undefined || Array.isArray(content)) {
        showText("widget", key, content?.slice(0, 128).join("\n"));
      } else unsupported("setWidget(component)");
    },
    setEditorText: () => unsupported("setEditorText"),
    pasteToEditor: () => unsupported("pasteToEditor"),
    setEditorComponent: () => unsupported("setEditorComponent"),
    setFooter: () => unsupported("setFooter"),
    setHeader: () => unsupported("setHeader"),
    setTitle: () => unsupported("setTitle"),
    addAutocompleteProvider: () => unsupported("addAutocompleteProvider"),
    onTerminalInput: () => {
      unsupported("onTerminalInput");
      return () => {};
    },
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
      textTimer = undefined;
      textUpdates.clear();
      lastText.clear();
      for (const request of pending.values()) request.cancel();
    },
  };
}
