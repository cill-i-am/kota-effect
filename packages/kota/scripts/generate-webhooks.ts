#!/usr/bin/env node
/**
 * generate-webhooks — emit typed webhook events from the OpenAPI `webhooks`.
 *
 * Input:  specs/openapi.json (`webhooks` + `components.schemas`)
 *         src/services/kota.ts (types it already exports are reused)
 * Output: src/services/webhook-events.ts
 *
 * distilled compiles operations, and the webhook payload schemas are not
 * reachable from any operation, so they are emitted here. Only V2 events are
 * emitted: V1 is deprecated and new
 * endpoints must subscribe with `"version": "V2"`.
 *
 * In the document every event's `type` is a plain string; the event name is
 * the webhook's `summary` (`employee.created`), so it becomes the `type`
 * literal and `KotaWebhookEvent` is a union discriminated on it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const spec = JSON.parse(fs.readFileSync(path.join(root, "specs/openapi.json"), "utf8"));
const schemas: Record<string, any> = spec.components.schemas;
const servicesFile = path.join(root, "src/services/kota.ts");
const outFile = path.join(root, "src/services/webhook-events.ts");

/** Types `kota.ts` exports, keyed by name, with their property names. */
const kotaSource = fs.readFileSync(servicesFile, "utf8");
const kotaTypes = new Map<string, Set<string> | undefined>();
for (const m of kotaSource.matchAll(/^export interface (\w+) \{\n([\s\S]*?)^\}/gm)) {
  const props = new Set([...m[2]!.matchAll(/^  (\w+)\??:/gm)].map((p) => p[1]!));
  kotaTypes.set(m[1]!, props);
}
for (const m of kotaSource.matchAll(/^export type (\w+) =/gm)) {
  if (!kotaTypes.has(m[1]!)) kotaTypes.set(m[1]!, undefined);
}

const refName = (ref: string) => ref.split("/").at(-1)!;
const doc = (text: unknown, indent = "") =>
  typeof text === "string" && text.trim()
    ? `${indent}/** ${text
        .trim()
        .replace(/\*\//g, "*\\/")
        .replace(/\s*\n\s*/g, " ")} */\n`
    : "";

const imported = new Set<string>();
const emitted = new Map<string, string>();
const pending: string[] = [];

/** Use kota.ts's type when it is the same component (same property names). */
const reuse = (name: string): boolean => {
  if (!kotaTypes.has(name)) return false;
  const props = kotaTypes.get(name);
  const schema = schemas[name];
  if (props === undefined || !schema?.properties) return true;
  const expected = Object.keys(schema.properties);
  const same = expected.length === props.size && expected.every((p) => props.has(p));
  if (!same) throw new Error(`kota.ts ${name} differs from components.schemas.${name}`);
  return true;
};

const named = (name: string): string => {
  if (reuse(name)) {
    imported.add(name);
    return name;
  }
  if (!emitted.has(name) && !pending.includes(name)) pending.push(name);
  return name;
};

const tsType = (schema: any): string => {
  if (!schema || typeof schema !== "object") return "unknown";
  if (schema.$ref) return named(refName(schema.$ref));
  const nullable = Array.isArray(schema.type) && schema.type.includes("null");
  const base = baseType(schema);
  return nullable && base !== "unknown" ? `${base} | null` : base;
};

const baseType = (schema: any): string => {
  if (schema.allOf) {
    const parts = schema.allOf.map(tsType);
    return parts.length === 1 ? parts[0]! : `(${parts.join(" & ")})`;
  }
  if (schema.oneOf || schema.anyOf) {
    return `(${(schema.oneOf ?? schema.anyOf).map(tsType).join(" | ")})`;
  }
  if (schema.enum) return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  const types: string[] = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
    (t: unknown) => t && t !== "null",
  );
  const type = types[0];
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `Array<${tsType(schema.items)}>`;
    case "object":
      return objectType(schema, "");
    default:
      return schema.properties ? objectType(schema, "") : "unknown";
  }
};

const objectType = (schema: any, indent: string): string => {
  const props = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const lines = Object.entries(props).map(
    ([key, value]: [string, any]) =>
      `${doc(value?.description, `${indent}  `)}${indent}  ${key}${required.has(key) ? "" : "?"}: ${tsType(value)};`,
  );
  const extra =
    schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? [`${indent}  [key: string]: ${tsType(schema.additionalProperties)} | undefined;`]
      : [];
  if (lines.length + extra.length === 0) {
    return extra.length || schema.additionalProperties ? "Record<string, unknown>" : "{}";
  }
  return `{\n${[...lines, ...extra].join("\n")}\n${indent}}`;
};

const emit = (name: string) => {
  const schema = schemas[name];
  if (!schema) throw new Error(`missing components.schemas.${name}`);
  const body =
    schema.type === "object" || schema.properties
      ? `export interface ${name} ${objectType(schema, "")}`
      : `export type ${name} = ${tsType(schema)};`;
  emitted.set(name, `${doc(schema.description)}${body}`);
};

// V2 events: one envelope per event, `type` narrowed to the event name.
interface Event {
  readonly type: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly data: string;
}
const events: Event[] = [];
for (const [key, item] of Object.entries<any>(spec.webhooks)) {
  if (!key.endsWith("V2Webhook")) continue;
  const post = item.post;
  const envelope = schemas[refName(post.requestBody.content["application/json"].schema.$ref)];
  const required = ["id", "type", "platform_id", "data", "created"];
  if (!required.every((p) => envelope.properties?.[p])) {
    throw new Error(
      `${key}: unexpected webhook envelope ${Object.keys(envelope.properties ?? {})}`,
    );
  }
  events.push({
    type: post.summary,
    name: key.replace(/V2Webhook$/, "Event"),
    description: post.requestBody.description,
    data: tsType(envelope.properties.data),
  });
}
while (pending.length) {
  const next = pending.shift()!;
  if (!emitted.has(next)) emit(next);
}

const eventDecls = events.map(
  (e) =>
    `${doc(`\`${e.type}\`: ${e.description ?? ""}`)}export interface ${e.name} extends WebhookEnvelope<${JSON.stringify(e.type)}, ${e.data}> {}`,
);

const out = `// AUTO-GENERATED by scripts/generate-webhooks.ts from specs/openapi.json (webhooks, V2). Do not edit.
${
  imported.size
    ? `import type {\n${[...imported]
        .sort()
        .map((n) => `  ${n},`)
        .join("\n")}\n} from "./kota.ts";\n`
    : ""
}
/** The envelope every V2 webhook delivery shares. */
export interface WebhookEnvelope<Type extends string, Data> {
  /** Event id, prefixed with \`evt_\`. */
  id: string;
  /** The event name, e.g. \`employee.created\`. */
  type: Type;
  /** Platform id, prefixed with \`pt_\`. */
  platform_id: string;
  data: Data;
  /** When the event happened (ISO 8601). */
  created: string;
}

${[...emitted.values()].join("\n\n")}

${eventDecls.join("\n\n")}

/** Every V2 webhook event, discriminated on \`type\`. */
export type KotaWebhookEvent =
${events.map((e) => `  | ${e.name}`).join("\n")};

/** Every V2 webhook event name. */
export type KotaWebhookEventType = KotaWebhookEvent["type"];

/** Every V2 webhook event name, in the order the API documents them. */
export const WEBHOOK_EVENT_TYPES = [
${events.map((e) => `  ${JSON.stringify(e.type)},`).join("\n")}
] as const satisfies ReadonlyArray<KotaWebhookEventType>;
`;

fs.writeFileSync(outFile, out);
execFileSync("pnpm", ["exec", "oxfmt", outFile], { cwd: root, stdio: "inherit" });

const index = path.join(root, "src/services/index.ts");
const indexText = fs.readFileSync(index, "utf8");
const line = `export * as WebhookEvents from "./webhook-events.ts";\n`;
if (!indexText.includes(line)) fs.writeFileSync(index, indexText + line);

console.log(
  `✅ ${events.length} webhook events, ${emitted.size} payload types, ${imported.size} reused from kota.ts -> ${path.relative(root, outFile)}`,
);
