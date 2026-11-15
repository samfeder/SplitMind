import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #31 round 2, item 6. docs/guardrails.md option 0 and the 0019 row of patches/README.md must carry the operating
// facts that keep read-only from silently turning off or from missing relabelled actions. These tests pin the
// facts a reader needs (commands, names, conditions), not the prose around them.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Markdown flattened to plain sentences: no backticks or emphasis, wrapped lines joined. */
const plain = (text: string) => text.replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
const sentences = (text: string) => plain(text).split(/(?<=[.!?])\s+/);

/** Option 0 of "Read-only accounts": from its list item to option 1. */
function optionZero(): string {
  const guardrails = read("docs/guardrails.md");
  const start = guardrails.indexOf("0. **Mark the connection read-only");
  expect(start, "option 0 of the read-only section").toBeGreaterThan(-1);
  const end = guardrails.indexOf("\n1. **Least privilege", start);
  expect(end).toBeGreaterThan(start);
  return guardrails.slice(start, end);
}

/** The 0019 row of the patch table. */
function row0019(): string {
  const line = read("patches/README.md")
    .split("\n")
    .find((candidate) => candidate.startsWith("| `0019-"));
  expect(line, "the 0019 row in patches/README.md").toBeDefined();
  return line!;
}

const tokenNames = /runtime tokens whose names start with ["“]?MCP OAuth["”]?/i;

/** A sentence that says 0017's grants were already re-issued, so reconnect again after 0019. */
function saysReconnectAgainAfter0019(text: string): boolean {
  return sentences(text).some(
    (sentence) =>
      /0017/.test(sentence) && /re-?issued/i.test(sentence) && /reconnect again/i.test(sentence) && /0019/.test(sentence),
  );
}

describe("guardrails option 0: setting the variable", () => {
  it("says to set it with wrangler secret put against wrangler.local.jsonc", () => {
    expect(plain(optionZero())).toContain(
      "wrangler secret put OOMOL_CONNECT_READ_ONLY_CONNECTIONS --config wrangler.local.jsonc",
    );
  });

  it("says never to set it as a dashboard variable, because the next deploy deletes it and read-only silently turns off", () => {
    const text = sentences(optionZero());

    expect(text.some((sentence) => /never/i.test(sentence) && /dashboard variable/i.test(sentence))).toBe(true);
    expect(
      text.some(
        (sentence) =>
          /deploy/i.test(sentence) && /delete/i.test(sentence) && /silently/i.test(sentence) && /read-only/i.test(sentence),
      ),
    ).toBe(true);
  });

  it("says to check after each deploy that list_connections still shows readOnly: true", () => {
    const text = sentences(optionZero());

    expect(
      text.some(
        (sentence) =>
          /after each deploy/i.test(sentence) && /list_connections/.test(sentence) && /readOnly: true/.test(sentence),
      ),
    ).toBe(true);
  });
});

describe("guardrails option 0: after deploying patch 0019", () => {
  it('names the tokens as "runtime tokens whose names start with MCP OAuth"', () => {
    expect(plain(optionZero())).toMatch(tokenNames);
  });

  it("says that if 0017 was deployed and its grants re-issued, you reconnect again after 0019", () => {
    expect(saysReconnectAgainAfter0019(optionZero())).toBe(true);
  });

  it("still ties the reconnect to claude.ai, Claude Code and #95", () => {
    const text = plain(optionZero());

    expect(text).toMatch(/claude\.ai/i);
    expect(text).toMatch(/Claude Code/);
    expect(text).toContain("#95");
  });
});

describe("patches/README.md 0019 row", () => {
  it('names the tokens as "runtime tokens whose names start with MCP OAuth"', () => {
    expect(plain(row0019())).toMatch(tokenNames);
  });

  it("says that if 0017 was deployed and its grants re-issued, you reconnect again after 0019", () => {
    expect(saysReconnectAgainAfter0019(row0019())).toBe(true);
  });

  it("keeps the #95 reason and the #130 pointer", () => {
    const text = plain(row0019());

    expect(text).toContain("#95");
    expect(text).toContain("#130");
  });
});
