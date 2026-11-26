import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #83. The setup page's footer line and the docs. There is no DOM harness in this repo (no jsdom or happy-dom), so the
// footer's rendering from a stubbed fetch (V6) is not tested here; these pin the facts that can be checked statically:
// the page fetches /version.json uncached, never feeds it to innerHTML, links the commit to GitHub, and the CSP
// still allows the same-origin fetch.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const plain = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ").trim();

describe("setup page version footer (#83)", () => {
  const script = read("web/setup/setup.js");

  it("fetches /version.json from the same origin without caching", () => {
    expect(script).toMatch(/fetch\(\s*["'`]\/version\.json["'`]/);
    expect(script).toMatch(/cache:\s*["']no-store["']/);
  });

  it("links the short commit to the SplitMind repo on GitHub", () => {
    expect(script).toContain("https://github.com/samfeder/SplitMind/commit/");
  });

  it("never puts fetched values through innerHTML", () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("the setup page's CSP still lets it call its own origin", () => {
    const headers = read("web/_headers");
    const setup = headers.slice(headers.indexOf("/setup/*"));
    const csp = setup.split("\n").find((line) => line.trim().startsWith("Content-Security-Policy"))!;
    expect(csp).toMatch(/connect-src[^;]*'self'/);
  });
});

describe("docs (#83)", () => {
  it.each(["docs/setup/cloudflare.md", "docs/upgrading-openconnector.md"])(
    "%s explains /version.json, the clean-tree check and --allow-dirty",
    (path) => {
      const text = plain(read(path));

      expect(text).toContain("/version.json");
      expect(text).toContain("--allow-dirty");
      expect(text).toMatch(/commit or stash|uncommitted|clean tree|clean working tree|dirty/i);
    },
  );
});
