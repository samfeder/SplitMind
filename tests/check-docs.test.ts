import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDocs, findBrokenLinks, findIdentifiers, headingAnchors } from "../scripts/check-docs.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function fakeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "splitmind-docs-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("check-docs", () => {
  it("finds no identifiers or broken links in this repo's docs", () => {
    expect(checkDocs(repoRoot)).toEqual([]);
  });

  it("accepts placeholders and redacted examples", () => {
    const text = [
      "Open `https://<your-worker>.workers.dev/mcp`.",
      "Mail <you>@example.com.",
      "Redact tokens, e.g. `xoxb-REDACTED`.",
      "A bare prefix like `xoxp-` is fine.",
      "Use `secret_basic` auth.",
    ].join("\n");
    expect(findIdentifiers("doc.md", text)).toEqual([]);
  });

  it("flags real-looking identifiers with their line", () => {
    // Built from parts so secret scanners don't mistake the fixtures for real leaks.
    const slackToken = ["xoxp", "1234567890", "abcdefghij"].join("-");
    const notionToken = "ntn_" + "a1".repeat(12);
    const text = [
      "Deployed at https://splitmind.my-team.workers.dev.",
      "Contact someone@company.io.",
      `Account ${"ab12".repeat(8)}.`,
      "Database 3f2504e0-4f89-11d3-9a0c-0305e82c3301.",
      `Token ${slackToken} and ${notionToken}.`,
    ].join("\n");
    expect(findIdentifiers("doc.md", text)).toEqual([
      { file: "doc.md", line: 1, problem: "workers.dev host without a <placeholder>" },
      { file: "doc.md", line: 2, problem: "email address" },
      { file: "doc.md", line: 3, problem: "32-hex id (Cloudflare account, KV or similar)" },
      { file: "doc.md", line: 4, problem: "UUID (D1 database or similar)" },
      { file: "doc.md", line: 5, problem: "Slack token" },
      { file: "doc.md", line: 5, problem: "Notion token" },
    ]);
  });

  it("builds GitHub-style heading anchors, skipping code fences", () => {
    const markdown = [
      "## 2. Writes must name an account (decision 8, E6.1)",
      "### U1 — `execute_action` without connectionName",
      "## Setup",
      "## Setup",
      "```bash",
      "# not a heading",
      "```",
    ].join("\n");
    expect([...headingAnchors(markdown)]).toEqual([
      "2-writes-must-name-an-account-decision-8-e61",
      "u1--execute_action-without-connectionname",
      "setup",
      "setup-1",
    ]);
  });

  it("flags links to missing files and headings, and ignores URLs and fenced code", () => {
    const markdown = [
      "[ok](a.md#check-a-deployment) [self](#b) [web](https://example.com/x.md)",
      "[gone](missing.md)",
      "[bad anchor](a.md#no-such-heading)",
      "```",
      "[in code](nowhere.md)",
      "```",
      "# B",
    ].join("\n");
    const repo = fakeRepo({ "docs/a.md": "# A\n## Check a deployment\n", "docs/b.md": markdown });
    expect(findBrokenLinks(repo, "docs/b.md", markdown)).toEqual([
      { file: "docs/b.md", line: 2, problem: "link to missing file missing.md" },
      { file: "docs/b.md", line: 3, problem: "link to missing heading #no-such-heading in docs/a.md" },
    ]);
  });
});
