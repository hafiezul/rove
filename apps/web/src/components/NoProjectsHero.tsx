import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoProjectsHero() {
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const handleNewThread = useNewThreadHandler();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startThread = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await handleNewThread(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start a thread. Check your environment connection and try again.",
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <Empty size="hero" className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle>What should we work on?</EmptyTitle>
              <EmptyDescription>
                Start a thread, or add a project to work in an existing folder.
              </EmptyDescription>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="mt-6 flex justify-center gap-2">
                <Button size="sm" disabled={starting} onClick={() => void startThread()}>
                  <PlusIcon className="size-4" />
                  {starting ? "Starting…" : "New thread"}
                </Button>
                <Button variant="outline" size="sm" onClick={openAddProject}>
                  <PlusIcon className="size-4" />
                  Add project
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
