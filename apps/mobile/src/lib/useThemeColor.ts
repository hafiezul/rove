import type { ColorValue } from "react-native";
import { useCSSVariable } from "uniwind";

/**
 * Typed wrapper around `useCSSVariable` that returns a `ColorValue` for use
 * in React Native style props (backgroundColor, tintColor, etc.).
 *
 * Usage: `const color = useThemeColor("--color-icon");`
 */
export function useThemeColor(variable: `--color-${string}`): ColorValue {
  // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
  return useCSSVariable(variable) as ColorValue;
}
