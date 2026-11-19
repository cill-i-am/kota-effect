#!/usr/bin/env node
/**
 * Re-vendor distilled's private code generator (packages/dev/src) at a ref.
 *
 *   pnpm vendor:distilled [ref]   # default: main
 *
 * Shallow-clones alchemy-run/distilled into a temp directory, replaces
 * tools/distilled-dev/src with its packages/dev/src, and records the commit in
 * tools/distilled-dev/package.json + README.md.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ref = process.argv[2] ?? "main";
const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "tools/distilled-dev");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "distilled-"));

try {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("remote", "add", "origin", "https://github.com/alchemy-run/distilled.git");
  git("fetch", "--quiet", "--depth=1", "origin", ref);
  git("sparse-checkout", "set", "packages/dev/src", "LICENSE", "NOTICE");
  git("checkout", "--quiet", "FETCH_HEAD");
  const sha = git("rev-parse", "HEAD");

  fs.rmSync(path.join(target, "src"), { recursive: true, force: true });
  fs.cpSync(path.join(tmp, "packages/dev/src"), path.join(target, "src"), { recursive: true });
  fs.rmSync(path.join(target, "src/testing.ts"), { force: true });
  for (const f of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(tmp, f), path.join(target, f));

  const pkgPath = path.join(target, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = `0.0.0-vendored.${sha.slice(0, 7)}`;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const readmePath = path.join(target, "README.md");
  fs.writeFileSync(
    readmePath,
    fs.readFileSync(readmePath, "utf8").replace(/commit\s+`[0-9a-f]{40}`/, `commit \`${sha}\``),
  );
  console.log(`Vendored distilled packages/dev at ${sha}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
