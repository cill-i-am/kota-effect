#!/usr/bin/env node
/**
 * generate — compile the Smithy model into the Kota Effect SDK.
 *
 * Input:  the model from scripts/convert.ts
 * Output: src/services/kota.ts + src/services/index.ts
 *
 * The compiler is distilled's (tools/distilled-dev). Kota keeps the wire's
 * snake_case member names on the TS surface, so request and response objects
 * match the API reference one to one.
 */
import { execFileSync } from "node:child_process";
import { runGeneratorCli } from "@distilled.cloud/dev/codegen/cli";
import type { SdkSpec } from "@distilled.cloud/dev/codegen/generator";

// distilled stamps `distilled.specUpdatedAt` in package.json from the last
// commit touching specs/, and fails after writing src/services when there is
// none. Fail before generating instead, with the fix.
const specCommit = execFileSync("git", ["log", "-1", "--format=%H", "--", "specs"], {
  cwd: `${import.meta.dirname}/..`,
  encoding: "utf8",
}).trim();
if (!specCommit) {
  console.error(
    "packages/kota/specs has no commit yet. Commit specs/ (distilled stamps specUpdatedAt from git), then re-run `pnpm generate`.",
  );
  process.exit(1);
}

const PAGINATED_TRAIT = "smithy.api#paginated";

const kotaSpec: SdkSpec = {
  nullableTrait: "com.distilled.openapi#nullable",
  errorMatchersTrait: "com.distilled.openapi#errorMatchers",

  extraBindings: [
    {
      // Sole member of a synthesized wrapper for bare array/scalar bodies.
      trait: "com.distilled.openapi#rawResponse",
      binding: "rawResponse",
      pipe: "T.RawResponse()",
      rootPipe: "T.RawResponseRoot()",
    },
  ],

  // Every non-2xx response is an RFC 9110 problem document
  // (`application/problem+json`): `type`, `title`, `status`, `detail`, plus
  // Kota's `error_code` and `trace_id` extensions and, for validation
  // failures, `errors`. Typed error classes keep the human message and the
  // whole document as `body`; `problemDetails(error)` reads it back typed.
  errors: {
    defaultFields: () => ["  message: S.String,", "  body: S.Unknown,"],
  },

  union: ({ name, caseTargets, tsRef }) => [
    `export type ${name} = ${caseTargets.map(tsRef).join(" | ") || "unknown"};`,
    `export const ${name} = S.Unknown as any as S.Schema<${name}>;\n`,
  ],

  // List endpoints take `page`/`page_size` and answer with `items`,
  // `page`, `has_next_page`; see src/pagination.ts.
  paginationProfiles: {
    page: { strategy: "paginateKota", requires: () => ["inputToken"], itemsFallback: "items" },
  },

  operationDecl: {
    contextType: "KotaOpContext",
    commonErrorType: "KotaOpError",
    commonErrorClasses: ["UnknownKotaError"],
    protocol: "KotaProtocol",
    retry: "Retry.Retry",
  },

  sourceNote: ".generated-specs (specs/openapi.json)",
};

runGeneratorCli({
  description: "Generate the Kota Effect SDK from the Smithy model",
  convert: () => import("./convert.ts"),
  root: `${import.meta.dirname}/..`,
  // patches/ is consumed by scripts/convert.ts.
  patchesDir: false,
  spec: (model) => {
    // Kota's paged lists are not one of
    // the shapes the converter auto-detects, so stamp the trait on every
    // operation whose input has `page` and whose output has `items` and
    // `has_next_page`.
    const shapes = (model.shapes ?? {}) as Record<string, any>;
    for (const shape of Object.values(shapes)) {
      if (shape?.type !== "operation" || shape.traits?.[PAGINATED_TRAIT]) continue;
      const input = shapes[shape.input?.target];
      const output = shapes[shape.output?.target];
      if (!input?.members?.page || !output?.members?.items || !output.members.has_next_page) {
        continue;
      }
      shape.traits ??= {};
      shape.traits[PAGINATED_TRAIT] = {
        mode: "page",
        inputToken: "page",
        outputToken: "page",
        items: "items",
        hasNextPage: "has_next_page",
        ...(input.members.page_size ? { pageSize: "page_size" } : {}),
      };
    }
    return kotaSpec;
  },
});
