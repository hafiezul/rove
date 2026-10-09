import { GitPullRequestIcon } from "phosphor-react-native/src/icons/GitPullRequest";
import { SymbolView as ExpoSymbolView } from "expo-symbols";
import { withUniwind } from "uniwind";
import type { AppSymbolViewProps } from "./AppSymbol";
import { phosphorTintColor, type AppSymbolPhosphorIcon } from "./AppSymbolPhosphor";

const PullRequestIcon: AppSymbolPhosphorIcon = GitPullRequestIcon;

export type { SFSymbol } from "expo-symbols";
export type { AppSymbolName } from "./AppSymbol";

/**
 * Use SF Symbols on iOS except for pull requests, which have no matching
 * native glyph. Import only that Phosphor icon to keep the bundle small.
 */
function AppSymbolView(props: AppSymbolViewProps) {
  const name = typeof props.name === "string" ? props.name : props.name.ios;
  if (name === "arrow.triangle.pull") {
    return (
      <PullRequestIcon
        accessibilityLabel={props.accessibilityLabel}
        color={phosphorTintColor(props.tintColor)}
        size={props.size}
        style={props.style}
        testID={props.testID}
      />
    );
  }

  return <ExpoSymbolView {...props} />;
}

export const SymbolView = withUniwind(AppSymbolView);
