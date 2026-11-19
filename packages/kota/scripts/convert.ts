#!/usr/bin/env node
/**
 * convert — turn the Kota OpenAPI document into a Smithy 2.0 JSON model.
 *
 * Input:  specs/openapi.json       (snapshot of https://api.kota.io/openapi.json)
 *         patches/*.patch.json     (RFC-6902 patches to the Smithy model)
 * Output: .generated-specs/kota.json
 *
 * The OpenAPI → Smithy converter is distilled's (tools/distilled-dev);
 * `scripts/generate.ts` compiles the model into src/services.
 */
import * as path from "node:path";
import { runOpenApiConvert } from "@distilled.cloud/dev/codegen/openapi-cli";

await runOpenApiConvert({
  root: path.resolve(import.meta.dirname, ".."),
  specs: [
    { name: "kota", specPath: "specs/openapi.json" },
    {
      // Adaptive Requirements: the `ar_`/`ars_`
      // ids the intents' `.../requirements` lists return are fetched and answered
      // here. Same host and bearer token; its own OpenAPI document.
      name: "requirements",
      specPath: "specs/requirements.openapi.json",
      // The document declares `Authorization` as an operation parameter; the
      // protocol already sends it from the credentials.
      preprocess: (spec: any) => {
        for (const item of Object.values<any>(spec.paths)) {
          for (const op of Object.values<any>(item)) {
            if (Array.isArray(op?.parameters)) {
              op.parameters = op.parameters.filter(
                (p: any) => !(p.in === "header" && p.name?.toLowerCase() === "authorization"),
              );
            }
          }
        }
      },
      options: { namespace: "io.kota.requirements", serviceName: "KotaRequirements" },
    },
  ],
  patchesDir: "patches",
  options: {
    namespace: "io.kota.api",
    serviceName: "Kota",
    // `Idempotency-Key` is the only header parameter the API declares, and it
    // is a real per-call input on create endpoints.
    headerParams: true,
    skipDeprecated: true,
  },
});
