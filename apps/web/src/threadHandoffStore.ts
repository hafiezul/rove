import type { EnvironmentId, ThreadId } from "@rove-code/contracts";
import { create } from "zustand";

/** Where a draft opened by "Continue on" came from. */
export interface PendingThreadHandoff {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
}

/**
 * Drafts opened by "Continue on", keyed by the draft's thread id. The links
 * between the two threads are recorded only once the draft's first send
 * creates the thread, so an abandoned draft never leaves a link behind.
 * In memory: a reload drops the pending link, not the draft.
 */
interface ThreadHandoffStoreState {
  pendingByThreadId: Readonly<Record<string, PendingThreadHandoff>>;
  setPending: (threadId: ThreadId, pending: PendingThreadHandoff) => void;
  /** Returns and clears the pending handoff for a thread. */
  take: (threadId: ThreadId) => PendingThreadHandoff | null;
}

export const useThreadHandoffStore = create<ThreadHandoffStoreState>((set, get) => ({
  pendingByThreadId: {},
  setPending: (threadId, pending) =>
    set((state) => ({ pendingByThreadId: { ...state.pendingByThreadId, [threadId]: pending } })),
  take: (threadId) => {
    const pending = get().pendingByThreadId[threadId] ?? null;
    if (pending !== null) {
      set((state) => {
        const { [threadId]: _taken, ...rest } = state.pendingByThreadId;
        return { pendingByThreadId: rest };
      });
    }
    return pending;
  },
}));
