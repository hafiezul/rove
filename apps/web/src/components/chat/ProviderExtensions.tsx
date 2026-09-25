import type { PiCatalogSnapshot } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  PuzzleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { cn } from "~/lib/utils";

export interface ProviderExtensionsProps {
  data: PiCatalogSnapshot | null;
  error: string | null;
  isPending: boolean;
  refresh: () => Promise<void>;
  /** Extension paths the Pi instance blocks from loading. */
  disabledExtensions: ReadonlyArray<string>;
  onToggleExtension: (path: string, disabled: boolean) => void;
}

const SCOPE_LABEL = {
  user: "User",
  project: "Project",
  temporary: "Session",
} as const;

function scopeBadgeVariant(scope: keyof typeof SCOPE_LABEL) {
  switch (scope) {
    case "project":
      return "info" as const;
    case "user":
      return "secondary" as const;
    case "temporary":
      return "outline" as const;
  }
}

function ExtensionRow({
  extension,
  disabled,
  onToggle,
}: {
  extension: PiCatalogSnapshot["extensions"][number];
  disabled: boolean;
  onToggle: (path: string, disabled: boolean) => void;
}) {
  const switchId = `extension-loaded-${extension.path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <Collapsible>
      <div className="flex w-full items-center gap-2 rounded-md py-1.5">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:bg-accent/50">
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform data-open:rotate-180" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium",
              disabled && "text-muted-foreground line-through",
            )}
          >
            {extension.name}
          </span>
        </CollapsibleTrigger>
        {disabled && (
          <Badge variant="warning" size="sm">
            Disabled
          </Badge>
        )}
        <Badge variant={scopeBadgeVariant(extension.scope)} size="sm">
          {SCOPE_LABEL[extension.scope]}
        </Badge>
        <Switch
          id={switchId}
          checked={!disabled}
          onCheckedChange={(checked) => onToggle(extension.path, !checked)}
          aria-label={`Load ${extension.name} in new sessions`}
        />
      </div>
      <CollapsiblePanel>
        <dl className="space-y-1.5 ps-6 pe-1 pt-1 pb-2 text-xs">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">Source</dt>
            <dd className="min-w-0 flex-1 truncate font-mono">{extension.path}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">Tools</dt>
            <dd className="min-w-0 flex-1">
              {extension.tools.length > 0 ? extension.tools.join(", ") : "None"}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">Commands</dt>
            <dd className="min-w-0 flex-1">
              {extension.commands.length > 0
                ? extension.commands.map((command) => `/${command}`).join(", ")
                : "None"}
            </dd>
          </div>
        </dl>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ProviderExtensionsContent({
  data,
  error,
  isPending,
  refresh,
  disabledExtensions,
  onToggleExtension,
}: ProviderExtensionsProps) {
  const modelCount =
    data?.modelProviders.reduce((total, provider) => total + provider.modelCount, 0) ?? 0;
  const warningCount = data?.warnings.length ?? 0;
  const compatibilityWarnings = data?.compatibilityWarnings ?? [];

  return (
    <div className="space-y-3 p-4 text-sm">
      {isPending && data === null && (
        <div className="flex items-center gap-2 text-muted-foreground" role="status">
          <Spinner className="size-4" />
          Loading catalog…
        </div>
      )}
      {error && (
        <Alert variant="error">
          <AlertTitle>Catalog failed to load</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {data && warningCount > 0 && (
        <Alert variant="warning">
          <AlertTitle>Needs attention</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 ps-4">
              {data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {data && compatibilityWarnings.length > 0 && (
        <section aria-label="Compatibility" className="flex gap-2 border-s-2 border-warning ps-3">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="space-y-1">
            <h3 className="font-medium">Needs Pi's terminal</h3>
            {compatibilityWarnings.map((warning) => (
              <p key={warning} className="text-muted-foreground">
                {warning}
              </p>
            ))}
          </div>
        </section>
      )}

      {data && (
        <>
          <section aria-label="Model providers" className="space-y-1">
            <h3 className="text-xs font-semibold text-muted-foreground">
              Models<span className="tabular-nums"> ({modelCount})</span>
            </h3>
            {data.modelProviders.length === 0 && (
              <p className="text-sm text-muted-foreground">No extension providers.</p>
            )}
            {data.modelProviders.map((provider) => (
              <div key={provider.id} className="flex items-center gap-2 py-1">
                {provider.authenticated ? (
                  <CircleCheckIcon
                    aria-label="Authenticated"
                    className="size-4 shrink-0 text-success"
                  />
                ) : (
                  <CircleAlertIcon
                    aria-label="Not authenticated"
                    className="size-4 shrink-0 text-warning"
                  />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{provider.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {provider.modelCount} {provider.modelCount === 1 ? "model" : "models"}
                </span>
                <Badge variant={provider.authenticated ? "success" : "warning"} size="sm">
                  {provider.authenticated ? "Authenticated" : "Sign in needed"}
                </Badge>
              </div>
            ))}
          </section>

          <section aria-label="Extensions" className="space-y-1">
            <h3 className="text-xs font-semibold text-muted-foreground">
              Extensions<span className="tabular-nums"> ({data.extensions.length})</span>
            </h3>
            {data.extensions.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No extensions found</EmptyTitle>
                  <EmptyDescription>
                    Install a Pi extension on the server to see it here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              data.extensions.map((extension) => (
                <ExtensionRow
                  key={extension.path}
                  extension={extension}
                  disabled={disabledExtensions.includes(extension.path)}
                  onToggle={onToggleExtension}
                />
              ))
            )}
          </section>
        </>
      )}

      <div className="space-y-2 pt-1">
        <Button size="sm" variant="outline" disabled={isPending} onClick={() => void refresh()}>
          <RefreshCwIcon className={cn(isPending && "motion-safe:animate-spin")} />
          {error ? "Retry" : "Refresh"}
        </Button>
        <ul className="space-y-1 text-xs text-muted-foreground">
          {compatibilityWarnings.length === 0 && (
            <li>Found does not mean every feature works in Rove. Pi terminal UI stays in Pi.</li>
          )}
          <li>Refresh re-reads extensions and model catalogs from the server's Pi config.</li>
          <li>Switches apply to new sessions. Live threads reload on their next turn.</li>
        </ul>
      </div>
    </div>
  );
}

export function ProviderExtensions(props: ProviderExtensionsProps) {
  const issueCount =
    (props.data?.warnings.length ?? 0) + (props.data?.compatibilityWarnings?.length ?? 0);
  return (
    <div className="flex items-center gap-1">
      <Dialog>
        <DialogTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label={`Extensions${issueCount > 0 ? `, ${issueCount} ${issueCount === 1 ? "issue" : "issues"}` : ""}`}
            >
              {issueCount > 0 ? (
                <TriangleAlertIcon className="size-3.5 text-warning" />
              ) : (
                <PuzzleIcon className="size-3.5" />
              )}
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                Extensions
              </span>
              {issueCount > 0 && (
                <Badge variant="warning" size="sm">
                  {issueCount}
                </Badge>
              )}
            </Button>
          }
        >
          Extensions
        </DialogTrigger>
        <DialogPopup className="overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pi provider catalog</DialogTitle>
            <DialogDescription>
              Global Pi extensions found on the server. Project extensions load in their threads.
            </DialogDescription>
          </DialogHeader>
          <ProviderExtensionsContent {...props} />
        </DialogPopup>
      </Dialog>
      {props.isPending && props.data === null && (
        <span role="status" className="text-xs text-muted-foreground">
          Loading catalog…
        </span>
      )}
      {props.error && (
        <Button size="xs" variant="outline" onClick={() => void props.refresh()}>
          <RefreshCwIcon className="size-3.5" />
          Retry
        </Button>
      )}
    </div>
  );
}
