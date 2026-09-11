import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { useProviderResources } from "../../lib/useProviderResources";

const SCOPE_LABEL = {
  user: "User",
  project: "Project",
  temporary: "Session",
} as const;

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ minWidth: 72 }}>
      <Text style={{ fontSize: 24, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
        {value}
      </Text>
      <Text style={{ fontSize: 12, color: "#888" }}>{label}</Text>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text accessibilityRole="header" style={{ fontSize: 15, fontWeight: "700" }}>
      {children}
    </Text>
  );
}

export function ProviderExtensions(props: ReturnType<typeof useProviderResources>) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const warningCount = props.data?.warnings.length ?? 0;
  const modelCount =
    props.data?.modelProviders.reduce((total, provider) => total + provider.modelCount, 0) ?? 0;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Extensions${warningCount > 0 ? `, ${warningCount} issues` : ""}`}
        onPress={() => setOpen(true)}
        style={{ padding: 8 }}
      >
        <Text style={{ color: "#888" }}>
          Extensions
          {warningCount > 0 ? ` · ${warningCount}` : ""}
          {props.isPending && props.data === null ? " · Loading…" : props.error ? " · Error" : ""}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <ScrollView contentContainerStyle={{ padding: 24, gap: 20, paddingBottom: 48 }}>
          <Text accessibilityRole="header" style={{ fontSize: 22 }}>
            Pi provider catalog
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)}>
            <Text>Close</Text>
          </Pressable>
          <Text>
            Extensions loaded for this Pi provider on the server. Entries marked project apply
            inside their own threads. Headless mode does not support interactive terminal UI, custom
            dialogs, or editor widgets.
          </Text>

          <View
            style={{ flexDirection: "row", gap: 32 }}
            accessible
            accessibilityLabel="Catalog summary"
          >
            <Stat
              value={props.data ? String(props.data.extensions.length) : "–"}
              label="Extensions"
            />
            <Stat value={props.data ? String(modelCount) : "–"} label="Models" />
            <Stat
              value={props.data ? String(warningCount) : "–"}
              label={warningCount === 1 ? "Issue" : "Issues"}
            />
          </View>

          {props.isPending && props.data === null && (
            <Text accessibilityLiveRegion="polite">Loading catalog…</Text>
          )}
          {props.error && <Text accessibilityRole="alert">{props.error}</Text>}

          {props.data && warningCount > 0 && (
            <View style={{ gap: 8 }}>
              <SectionTitle>Needs attention</SectionTitle>
              {props.data.warnings.map((warning) => (
                <Text key={warning}>• {warning}</Text>
              ))}
            </View>
          )}

          {props.data && (
            <View style={{ gap: 4 }}>
              <SectionTitle>Models</SectionTitle>
              {props.data.modelProviders.length === 0 && <Text>No extension providers.</Text>}
              {props.data.modelProviders.map((provider) => (
                <View key={provider.id} style={{ gap: 2, paddingVertical: 6 }}>
                  <Text style={{ fontWeight: "600" }}>{provider.name}</Text>
                  <Text style={{ fontSize: 13, color: "#888" }}>
                    {provider.modelCount} {provider.modelCount === 1 ? "model" : "models"} ·{" "}
                    {provider.authenticated ? "Authenticated" : "Sign in needed"}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {props.data && (
            <View style={{ gap: 4 }}>
              <SectionTitle>Extensions</SectionTitle>
              {props.data.extensions.length === 0 && (
                <Text>Install a Pi extension on the server to see it here.</Text>
              )}
              {props.data.extensions.map((extension) => {
                const isOpen = expanded === extension.path;
                return (
                  <View key={extension.path}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: isOpen }}
                      onPress={() => setExpanded(isOpen ? null : extension.path)}
                      style={{ paddingVertical: 8 }}
                    >
                      <Text style={{ fontWeight: "600" }}>
                        {isOpen ? "▾" : "▸"} {extension.name}
                      </Text>
                      <Text style={{ fontSize: 13, color: "#888" }}>
                        {SCOPE_LABEL[extension.scope]} · {extension.tools.length}{" "}
                        {extension.tools.length === 1 ? "tool" : "tools"} ·{" "}
                        {extension.commands.length}{" "}
                        {extension.commands.length === 1 ? "command" : "commands"}
                      </Text>
                    </Pressable>
                    {isOpen && (
                      <View style={{ gap: 6, paddingLeft: 20, paddingBottom: 8 }}>
                        <Text style={{ fontSize: 13 }} numberOfLines={2}>
                          {extension.path}
                        </Text>
                        <Text style={{ fontSize: 13 }}>
                          Tools: {extension.tools.join(", ") || "None"}
                        </Text>
                        <Text style={{ fontSize: 13 }}>
                          Commands:{" "}
                          {extension.commands.length > 0
                            ? extension.commands.map((command) => `/${command}`).join(", ")
                            : "None"}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: props.isPending }}
            disabled={props.isPending}
            onPress={() => void props.refresh()}
          >
            <Text style={{ fontWeight: "600" }}>{props.error ? "Retry" : "Refresh catalogue"}</Text>
          </Pressable>
          <Text style={{ fontSize: 13, color: "#888" }}>
            Project extensions apply inside their own threads.
          </Text>
        </ScrollView>
      </Modal>
    </>
  );
}
