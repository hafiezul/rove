"use client";

import { useMemo, type ReactNode } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  ProviderSettingsFormAnnotation,
  ProviderSettingsFormControl,
  ProviderSettingsFormSchemaAnnotation,
  ServerProviderModel,
} from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import type { ProviderClientDefinition } from "./providerDriverMeta";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly defaultBooleanValue?: boolean | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readFieldAnnotations(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
) {
  return Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
}

function readFieldAnnotationString(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
  key: "title" | "description",
): string | undefined {
  const annotations = readFieldAnnotations(fieldSchema);
  const value = annotations?.[key];
  return RuntimePredicate.isString(value) ? value : undefined;
}

function readProviderSettingsFormAnnotation(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): ProviderSettingsFormAnnotation {
  const annotation = readFieldAnnotations(fieldSchema)?.providerSettingsForm;
  return annotation ?? {};
}

function readProviderSettingsFormSchemaAnnotation(
  definition: ProviderClientDefinition,
): ProviderSettingsFormSchemaAnnotation {
  return Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
}

function readFieldBooleanDefault(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): boolean | undefined {
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    decodeDefault = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  const decoded = decodeDefault(undefined);
  return Option.isSome(decoded) && RuntimePredicate.isBoolean(decoded.value)
    ? decoded.value
    : undefined;
}

export function deriveProviderSettingsFields(
  definition: ProviderClientDefinition,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const schemaAnnotation = readProviderSettingsFormSchemaAnnotation(definition);
  const orderedKeys = new Map(
    (schemaAnnotation.order ?? []).map((key, index) => [key, index] as const),
  );
  const orderFallbackOffset = orderedKeys.size;

  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) => {
      return (
        (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index)
      );
    })
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const formAnnotation = readProviderSettingsFormAnnotation(fieldSchema);
      if (formAnnotation.hidden) return [];

      const annotatedTitle = readFieldAnnotationString(fieldSchema, "title");
      const annotatedDescription = readFieldAnnotationString(fieldSchema, "description");
      return [
        {
          key,
          control: formAnnotation.control ?? "text",
          label: annotatedTitle ?? titleizeFieldKey(key),
          ...(annotatedDescription !== undefined
            ? { description: annotatedDescription }
            : undefined),
          ...(formAnnotation.placeholder !== undefined
            ? { placeholder: formAnnotation.placeholder }
            : undefined),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : undefined),
        } satisfies ProviderSettingsFieldModel,
      ];
    });
}

export function readProviderConfigString(config: unknown, key: string): string {
  if (!RuntimePredicate.isObjectOrArray(config)) return "";
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    value = (config as Record<string, SchemaJson>)[key];
  return RuntimePredicate.isString(value) ? value : "";
}

export function readProviderConfigBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  if (!RuntimePredicate.isObjectOrArray(config)) return defaultValue;
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    value = (config as Record<string, SchemaJson>)[key];
  return RuntimePredicate.isBoolean(value) ? value : defaultValue;
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): Record<string, SchemaJson> | undefined {
  const // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    base: Record<string, SchemaJson> = RuntimePredicate.isObjectOrArray(config)
      ? { ...(config as Record<string, SchemaJson>) }
      : {};

  if (RuntimePredicate.isBoolean(value)) {
    const emptyBooleanValue = field.defaultBooleanValue ?? false;
    if (field.clearWhenEmpty === "omit" && value === emptyBooleanValue) {
      delete base[field.key];
    } else {
      base[field.key] = value;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const trimmed = value.trim();
  if (field.clearWhenEmpty === "omit" && trimmed.length === 0) {
    delete base[field.key];
  } else {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

interface ProviderSettingsFormProps {
  readonly definition: ProviderClientDefinition;
  readonly value: unknown;
  readonly models?: ReadonlyArray<ServerProviderModel> | undefined;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  readonly onChange: (nextConfig: Record<string, SchemaJson> | undefined) => void;
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div>{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "card"
      ? "mt-1 block text-xs text-muted-foreground"
      : "text-[11px] text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  const description = field.description ? (
    <span className={descriptionClassName}>{field.description}</span>
  ) : null;

  if (field.control === "switch") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          <Switch
            checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
            onCheckedChange={(checked) =>
              onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
            }
            aria-label={field.label}
          />
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "textarea") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <Textarea
            id={inputId}
            className={cn(variant === "card" && "mt-1.5")}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  const type = field.control === "password" ? "password" : undefined;
  return (
    <FieldFrame variant={variant}>
      <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
        {label}
        {variant === "card" ? (
          <DraftInput
            id={inputId}
            className="mt-1.5"
            type={type}
            autoComplete={field.control === "password" ? "off" : undefined}
            value={readProviderConfigString(value, field.key)}
            onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
            placeholder={field.placeholder}
            spellCheck={false}
          />
        ) : (
          <Input
            id={inputId}
            className="bg-background"
            type={type}
            autoComplete={field.control === "password" ? "off" : undefined}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
        )}
        {description}
      </label>
    </FieldFrame>
  );
}

export function resolvePiThinkingSetting(
  value: unknown,
  models: ReadonlyArray<ServerProviderModel>,
) {
  const slug = readProviderConfigString(value, "model").trim();
  const model = slug
    ? models.find((candidate) => candidate.slug === slug)
    : models.find((candidate) => candidate.isDefault);
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === "thinkingLevel" && candidate.type === "select",
  );
  const options = descriptor?.type === "select" ? descriptor.options : [];
  const selected = readProviderConfigString(value, "thinkingLevel").trim();
  return {
    options,
    selected,
    unavailable: selected !== "" && !options.some((option) => option.id === selected),
  };
}

const EMPTY_MODELS: ReadonlyArray<ServerProviderModel> = [];

function PiThinkingSettingsField({
  field,
  value,
  models = EMPTY_MODELS,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps & { models?: ReadonlyArray<ServerProviderModel> | undefined }) {
  const { options, selected, unavailable } = resolvePiThinkingSetting(value, models);
  const id = `${idPrefix}-${field.key}`;
  return (
    <FieldFrame variant={variant}>
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {field.label}
      </label>
      <Select
        value={selected}
        onValueChange={(next) => {
          if (next !== null && (next === "" || options.some((option) => option.id === next))) {
            onChange(nextProviderConfigWithFieldValue(value, field, next));
          }
        }}
      >
        <SelectTrigger id={id} className="mt-1.5 w-full">
          <SelectValue>
            {selected === ""
              ? "Use Pi default"
              : unavailable
                ? `${selected} (unavailable)`
                : options.find((option) => option.id === selected)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="">Use Pi default</SelectItem>
          {unavailable ? (
            <SelectItem value={selected} disabled>
              {selected} (unavailable)
            </SelectItem>
          ) : null}
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <p className="mt-1 text-xs text-muted-foreground">
        {options.length === 0
          ? "Reasoning choices are available once the selected model is in this provider's catalog."
          : unavailable
            ? "The saved override is not supported by this model. Choose a supported level or use Pi default."
            : "Choices follow the selected model. Use Pi default to clear the override."}
      </p>
    </FieldFrame>
  );
}

export function ProviderSettingsForm({
  definition,
  value,
  models,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(() => deriveProviderSettingsFields(definition), [definition]);

  if (fields.length === 0) {
    return null;
  }

  return (
    <>
      {fields.map((field) =>
        definition.value === "pi" && field.key === "thinkingLevel" ? (
          <PiThinkingSettingsField
            key={field.key}
            field={field}
            value={value}
            models={models}
            idPrefix={idPrefix}
            variant={variant}
            onChange={onChange}
          />
        ) : (
          <ProviderSettingsFieldRow
            key={field.key}
            field={field}
            value={value}
            idPrefix={idPrefix}
            variant={variant}
            onChange={onChange}
          />
        ),
      )}
    </>
  );
}
