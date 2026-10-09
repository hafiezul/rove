import { IconBase, type Icon, type IconWeight } from "@phosphor-icons/react";
import { forwardRef, type ReactElement, type ReactNode } from "react";

const STROKE_WIDTH_BY_WEIGHT = [
  ["thin", 8],
  ["light", 12],
  ["regular", 16],
  ["bold", 24],
  ["fill", 16],
  ["duotone", 16],
] as const satisfies ReadonlyArray<readonly [IconWeight, number]>;

/**
 * Builds a Phosphor icon for a glyph the set lacks. Draw `children` as strokes on
 * Phosphor's 256 grid; the stroke width follows the `weight` prop so the glyph sits
 * next to stock icons. Elements that should be solid set their own `fill`/`stroke`.
 */
export function createPhosphorStrokeIcon(displayName: string, children: ReactNode): Icon {
  const weights = new Map<IconWeight, ReactElement>(
    STROKE_WIDTH_BY_WEIGHT.map(([weight, strokeWidth]) => [
      weight,
      <g
        key={weight}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </g>,
    ]),
  );
  const PhosphorStrokeIcon: Icon = forwardRef((props, ref) => (
    <IconBase ref={ref} {...props} weights={weights} />
  ));
  PhosphorStrokeIcon.displayName = displayName;
  return PhosphorStrokeIcon;
}
