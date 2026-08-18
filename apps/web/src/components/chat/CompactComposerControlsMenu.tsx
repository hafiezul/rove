import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  runtimeModeSelectable: boolean;
  traitsMenuContent?: ReactNode;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const displayedRuntimeMode = props.runtimeModeSelectable ? props.runtimeMode : "full-access";

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            variant="ghost"
            className={size === "xs" ? "shrink-0" : "shrink-0 px-2"}
            aria-label="More composer controls"
            data-composer-shortcut={
              props.traitsMenuContent ? "composer.mode composer.effort" : "composer.mode"
            }
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        {!props.runtimeModeSelectable ? (
          <div className="px-2 pb-1.5 text-muted-foreground text-xs">
            Pi managed — permission modes can't be changed yet.
          </div>
        ) : null}
        <MenuRadioGroup
          value={displayedRuntimeMode}
          onValueChange={(value) => {
            if (!props.runtimeModeSelectable || !value || value === props.runtimeMode) return;
            // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem disabled={!props.runtimeModeSelectable} value="approval-required">
            Supervised
          </MenuRadioItem>
          <MenuRadioItem disabled={!props.runtimeModeSelectable} value="auto-accept-edits">
            Auto-accept edits
          </MenuRadioItem>
          <MenuRadioItem disabled={!props.runtimeModeSelectable} value="auto">
            Auto
          </MenuRadioItem>
          <MenuRadioItem disabled={!props.runtimeModeSelectable} value="full-access">
            Full access
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
