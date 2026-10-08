import type { UsageProviderKind } from "@rove-code/contracts";

import { cn } from "../../lib/utils";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Brand mark for the harness a row belongs to. */
export function UsageProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_PRESENTATION[provider].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}
