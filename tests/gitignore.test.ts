import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Asks git itself whether a path is ignored, so the test exercises the real
// .gitignore rather than parsing it.
function isIgnored(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--no-index", path]);
    return true;
  } catch {
    return false;
  }
}

describe(".gitignore", () => {
  it.each([
    "wrangler.local.jsonc",
    ".env",
    ".env.production",
    ".dev.vars",
    ".wrangler/state/v3/d1/db.sqlite",
    "node_modules/vitest/package.json",
  ])("ignores %s", (path) => {
    expect(isIgnored(path)).toBe(true);
  });

  it.each([".env.example", ".dev.vars.example", "wrangler.jsonc", "README.md"])(
    "keeps %s tracked",
    (path) => {
      expect(isIgnored(path)).toBe(false);
    },
  );
});
