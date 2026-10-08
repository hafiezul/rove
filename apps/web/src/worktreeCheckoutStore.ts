import type { ThreadId } from "@rove-code/contracts";
import { create } from "zustand";

/**
 * Threads whose first send checks out the selected branch itself instead of
 * branching off it. A one-off choice for the next worktree, so it lives in
 * memory rather than in the persisted draft. The branch toolbar toggles it;
 * "Continue on another environment" presets it for the draft it opens.
 */
interface WorktreeCheckoutStoreState {
  checkoutBaseBranchByThreadId: Readonly<Record<string, boolean>>;
  setCheckoutBaseBranch: (threadId: ThreadId, checkoutBaseBranch: boolean) => void;
}

export const useWorktreeCheckoutStore = create<WorktreeCheckoutStoreState>((set) => ({
  checkoutBaseBranchByThreadId: {},
  setCheckoutBaseBranch: (threadId, checkoutBaseBranch) =>
    set((state) =>
      state.checkoutBaseBranchByThreadId[threadId] === checkoutBaseBranch
        ? state
        : {
            checkoutBaseBranchByThreadId: {
              ...state.checkoutBaseBranchByThreadId,
              [threadId]: checkoutBaseBranch,
            },
          },
    ),
}));
