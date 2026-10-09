import type { ComponentType } from "react";
import type { AccessibilityProps, ColorValue } from "react-native";
import type { IconProps } from "phosphor-react-native";

/**
 * A Phosphor icon as AppSymbol renders it. The icon spreads extra props onto its
 * Svg, so accessibility props reach the native view even though Phosphor's own
 * props type omits them.
 */
export type AppSymbolPhosphorIcon = ComponentType<
  IconProps & Pick<AccessibilityProps, "accessibilityLabel">
>;

/**
 * Phosphor types its color as a string. Tints reaching AppSymbol are resolved
 * color strings (theme values or Uniwind's `tintColorClassName`), never platform colors.
 */
export function phosphorTintColor(tintColor: ColorValue | undefined): string | undefined {
  return typeof tintColor === "string" ? tintColor : undefined;
}
