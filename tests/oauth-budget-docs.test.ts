import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The high-stakes review of #78 made two things conditions of shipping: a rollback runbook for the one-way Durable
// Object migration, and docs that say what the budget covers. These tests pin the facts a reader needs, not the prose.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** The runbook lives in docs/setup/cloudflare.md or in docs/runbooks/mcp-oauth-budget-rollback.md, linked from it. */
function runbook(): string {
  const dedicated = "docs/runbooks/mcp-oauth-budget-rollback.md";
  return `${read("docs/setup/cloudflare.md")}\n${existsSync(join(root, dedicated)) ? read(dedicated) : ""}`;
}

/** The budget section of docs/guardrails.md, up to the next top-level section. */
function budgetSection(): string {
  const guardrails = read("docs/guardrails.md");
  const start = guardrails.indexOf("### Budget for anonymous KV writes");
  expect(start).toBeGreaterThan(-1);
  const end = guardrails.indexOf("\n## ", start);
  return guardrails.slice(start, end === -1 ? undefined : end);
}

describe("rollback runbook for the anonymous-write budget (H1)", () => {
  it("explains the kill switch: remove the durable_objects binding, keep the migrations and the class", () => {
    const text = runbook();
    expect(text).toMatch(/kill switch/i);
    expect(text).toContain("durable_objects");
    expect(text).toContain("migrations");
    expect(text).toContain("McpOAuthAnonymousWriteBudget");
  });

  it("explains full removal: reverse-apply 0017 and append a v2 migration that deletes the class", () => {
    const text = runbook();
    expect(text).toContain("deleted_classes");
    expect(text).toMatch(/["']?tag["']?\s*:\s*["']v2["']/);
    expect(text).toMatch(/reverse|revert|un-?apply/i);
    expect(text).toContain("0017");
  });

  it("says never to remove the v1 migration", () => {
    expect(runbook()).toMatch(/never[^.\n]{0,80}\bv1\b|\bv1\b[^.\n]{0,80}never/i);
  });

  it("says a Worker version rollback cannot cross the first deploy of 0017", () => {
    const text = runbook();
    expect(text).toMatch(/version rollback|roll ?back (to )?(a |the )?(previous|earlier|older) version/i);
    expect(text).toMatch(/cannot|can't|can not|will not|won't/i);
  });

  it("has a deploy checklist: one fresh sign-in from claude.ai and one tool call on an existing connection", () => {
    const text = runbook();
    expect(text).toMatch(/checklist/i);
    expect(text).toMatch(/fresh sign-in/i);
    expect(text).toMatch(/claude\.ai/i);
    expect(text).toMatch(/tool call/i);
    expect(text).toMatch(/existing connection/i);
  });
});

describe("docs/guardrails.md budget section (H4)", () => {
  it("covers registration, client assertions and the point that sign-in writes nothing before the administrator token", () => {
    const text = budgetSection();
    expect(text).toMatch(/registration/i);
    expect(text).toMatch(/client assertion/i);
    expect(text).toMatch(/administrator token/i);
    expect(text).toContain("OOMOL_CONNECT_MCP_OAUTH_MAX_ANONYMOUS_WRITES_PER_DAY");
    expect(text).toContain("OOMOL_CONNECT_MCP_OAUTH_MAX_ANONYMOUS_WRITES_PER_IP_PER_DAY");
  });

  it("no longer says sign-in starts use the budget or answer 429", () => {
    const text = budgetSection();
    expect(text).not.toMatch(/sign-in starts?/i);
    expect(text).not.toMatch(/\b429\b/);
    expect(text).not.toMatch(/block new sign-ins/i);
  });

  it("states the trade-off: new registrations can be blocked until 00:00 UTC, CIMD sign-ins and refreshes are not", () => {
    const text = budgetSection();
    expect(text).toMatch(/block new registrations/i);
    expect(text).toContain("00:00 UTC");
    expect(text).toContain("CIMD");
    expect(text).toMatch(/keep refreshing/i);
  });

  it("gives the way out: raise the variable and redeploy", () => {
    const text = budgetSection();
    expect(text).toMatch(/raise|increase|change the value/i);
    expect(text).toMatch(/redeploy|npm run deploy/i);
  });

  it("does not claim that nothing changes without the binding, since the token-endpoint refusal and body cap always run", () => {
    const text = budgetSection();
    expect(text).not.toMatch(/without the binding[^.]{0,60}nothing changes|nothing changes[^.]{0,60}without the binding/i);
    expect(text).toMatch(/body cap|64 ?KiB/i);
  });
});
