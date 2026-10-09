import type { ComponentProps } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { CHATGPT_USAGE_URL } from "@rove-code/shared/usageLimits";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";

export function ChatGptUsageButton(props: Omit<ComponentProps<typeof Button>, "onClick">) {
  return (
    <Button
      variant="ghost-muted"
      size="sm"
      {...props}
      onClick={() => void ensureLocalApi().shell.openExternal(CHATGPT_USAGE_URL)}
    >
      Manage usage
      <ArrowSquareOutIcon className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
