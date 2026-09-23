import type { PiExtensionStatusSnapshot } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function PiExtensionStatus({
  statuses,
}: {
  readonly statuses: PiExtensionStatusSnapshot["statuses"];
}) {
  if (statuses.length === 0) return null;

  return (
    <View className="mb-1 border-b border-border">
      <ScrollView
        style={{ maxHeight: 96, flexGrow: 0 }}
        keyboardShouldPersistTaps="always"
        nestedScrollEnabled
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        <View className="min-w-0 flex-row flex-wrap items-start gap-x-3 gap-y-1.5 px-3 pt-1 pb-2">
          {statuses.map(({ key, text }) => (
            <View
              key={key}
              className="max-w-full min-w-0 flex-row items-stretch overflow-hidden rounded-md border border-border bg-subtle"
            >
              <View className="max-w-[112px] justify-center border-r border-border bg-subtle-strong px-2 py-1">
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {key}
                </Text>
              </View>
              <Text
                className="min-w-0 shrink px-2 py-1 text-xs text-foreground"
                style={{ fontVariant: ["tabular-nums"] }}
                selectable
              >
                {text}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
