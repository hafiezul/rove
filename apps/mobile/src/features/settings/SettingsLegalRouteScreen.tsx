import { Linking, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

const LICENSE_URL = "https://github.com/hafiezul/rove/blob/main/LICENSE";
const SECURITY_REPORT_URL = "https://github.com/hafiezul/rove/security/advisories/new";

export function SettingsLegalRouteScreen() {
  if (LEGAL_URL !== null) {
    return <SettingsLegalDocumentRouteScreen documentName="Legal" documentUrl={LEGAL_URL} />;
  }

  return (
    <View className="flex-1 items-center justify-center gap-4 bg-sheet px-8">
      <SymbolView name="doc.text" size={32} tintColorClassName="accent-icon" type="monochrome" />
      <Text className="text-center font-rove-bold text-lg text-foreground">Legal information</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        This source build has not published its own privacy policy or terms of service. It does not
        use upstream legal documents.
      </Text>
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(LICENSE_URL).catch(() => undefined)}
        className="rounded-xl px-4 py-3 active:bg-foreground/5"
      >
        <Text className="font-rove-medium text-base text-foreground">View the MIT license</Text>
      </Pressable>
      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(SECURITY_REPORT_URL).catch(() => undefined)}
        className="rounded-xl px-4 py-3 active:bg-foreground/5"
      >
        <Text className="font-rove-medium text-base text-foreground">Report a security issue</Text>
      </Pressable>
    </View>
  );
}
