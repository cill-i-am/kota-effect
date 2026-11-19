#!/usr/bin/env node
/**
 * fetch-spec — refresh specs/*.json from the live Kota API.
 *
 *   pnpm spec:fetch                                        # production (default)
 *   KOTA_SPEC_HOST=https://test.api.kota.io pnpm spec:fetch
 *
 * Writes the document pretty-printed so spec changes review as small diffs,
 * then prints the operation count. Run `pnpm generate` afterwards.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const host = (process.env.KOTA_SPEC_HOST ?? "https://api.kota.io").replace(/\/+$/, "");
const specs = [
  // The main public API.
  { url: `${host}/openapi.json`, file: "openapi.json" },
  // Adaptive Requirements, same host.
  { url: `${host}/requirements/openapi.json`, file: "requirements.openapi.json" },
];

const methods = new Set(["get", "post", "put", "patch", "delete"]);
for (const { url, file } of specs) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    console.error(`GET ${url} -> ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const spec = (await response.json()) as { paths: Record<string, Record<string, unknown>> };
  const out = path.resolve(import.meta.dirname, "../specs", file);
  fs.writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
  const operations = Object.values(spec.paths).flatMap((item) =>
    Object.keys(item).filter((m) => methods.has(m)),
  ).length;
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${operations} operations) from ${url}`);
}
console.log("Update specs/SOURCE.md with today's date, then run `pnpm generate`.");
