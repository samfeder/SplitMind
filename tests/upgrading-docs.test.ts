import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #150. The documented upgrade has to install the dependencies a new patch brings, and rolling back a patch has to
// say how to reset the submodule, because deploy never un-applies a patch. These tests pin the facts a reader needs
// (commands and their order), not the prose around them.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Markdown flattened to plain text: no backticks or emphasis, wrapped lines joined. */
const plain = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ").trim();

const reset = "git -C vendor/open-connector checkout -- . && git -C vendor/open-connector clean -fd";

/** The text under a heading whose title matches, up to the next heading of the same or a higher level. */
function section(markdown: string, title: RegExp): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && title.test(line));
  expect(start, `a heading matching ${title}`).toBeGreaterThan(-1);
  const level = lines[start]!.match(/^(#+)/)![1]!.length;
  const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}}\\s`).test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("docs/upgrading-openconnector.md (#150)", () => {
  const doc = read("docs/upgrading-openconnector.md");

  it("D9: the upgrade steps say git pull, then scripts/bootstrap.sh, then npm run deploy, in that order", () => {
    const steps = plain(section(doc, /^#+\s+Upgrade steps/i));
    const pull = steps.indexOf("git pull");
    const bootstrap = steps.indexOf("scripts/bootstrap.sh", pull);
    const deploy = steps.indexOf("npm run deploy", bootstrap);
    expect(pull, "git pull in the upgrade steps").toBeGreaterThan(-1);
    expect(bootstrap, "scripts/bootstrap.sh after git pull").toBeGreaterThan(pull);
    expect(deploy, "npm run deploy after scripts/bootstrap.sh").toBeGreaterThan(bootstrap);
  });

  it("D9: says deploy stops with the out-of-date message when bootstrap was skipped", () => {
    const text = plain(doc);
    expect(text).toContain("dependencies are out of date");
    expect(text).toMatch(/deploy[^.]*(stops|refuses|fails)[^.]*bootstrap|bootstrap[^.]*skipped[^.]*deploy|deploy[^.]*bootstrap[^.]*skipped/i);
  });

  it("D9: has a rollback section that resets the submodule, then runs bootstrap and deploys", () => {
    const rollback = section(doc, /^#+\s+Rolling back/i);
    const text = plain(rollback);
    expect(text).toContain(reset);
    const at = text.indexOf(reset);
    expect(text.indexOf("scripts/bootstrap.sh", at), "bootstrap after the reset").toBeGreaterThan(at);
    expect(text, "deploy after the reset").toMatch(/deploy/i);
  });

  it("D9: the rollback section says deploy never un-applies a removed patch", () => {
    const text = plain(section(doc, /^#+\s+Rolling back/i));
    expect(text).toMatch(/deploy never (un-applies|removes|reverses|reverts)/i);
    expect(text).toMatch(/patch/i);
  });
});

describe("docs/setup/cloudflare.md (#150)", () => {
  it("D9: the re-running and upgrading section sends a git pull through scripts/bootstrap.sh before npm run deploy", () => {
    const upgrading = section(read("docs/setup/cloudflare.md"), /^#+\s+Re-running and upgrading/i);
    const bullets = upgrading.split(/\n(?=- )/).map(plain);
    const pulled = bullets.filter((bullet) => bullet.includes("git pull"));
    expect(pulled.length, "a bullet that names git pull").toBeGreaterThan(0);
    for (const bullet of pulled) {
      const bootstrap = bullet.indexOf("scripts/bootstrap.sh");
      expect(bootstrap, `scripts/bootstrap.sh in: ${bullet}`).toBeGreaterThan(bullet.indexOf("git pull"));
    }
  });
});
