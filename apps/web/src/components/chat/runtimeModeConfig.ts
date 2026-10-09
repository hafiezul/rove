import type { RuntimeMode } from "@rove-code/contracts";
import {
  type Icon as PhosphorIcon,
  LockIcon,
  LockOpenIcon,
  PencilLineIcon,
  SparkleIcon,
} from "@phosphor-icons/react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: PhosphorIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PencilLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparkleIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
