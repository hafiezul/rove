import { useColorScheme } from "react-native";
import { Path, Rect, Svg } from "react-native-svg";

import { markFill, resolveProviderMark } from "./providerMarks";

type ProviderIconProps = {
  readonly provider: string | null | undefined;
  readonly size?: number;
};

export function ProviderIcon(props: ProviderIconProps) {
  const isDarkMode = useColorScheme() === "dark";
  const size = props.size ?? 16;
  const mark = resolveProviderMark(props.provider);

  if (mark === undefined) return null;

  return (
    <Svg width={size} height={size} viewBox={mark.viewBox} fill="none">
      {mark.shapes.map((shape) =>
        shape.kind === "rect" ? (
          <Rect
            key={`rect:${shape.width}x${shape.height}`}
            width={shape.width}
            height={shape.height}
            rx={shape.rx}
            fill={markFill(shape.fill, isDarkMode)}
          />
        ) : (
          <Path
            key={`path:${shape.d}`}
            d={shape.d}
            fillRule={shape.fillRule}
            fill={markFill(shape.fill, isDarkMode)}
          />
        ),
      )}
    </Svg>
  );
}
