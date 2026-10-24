// Checks a running SplitMind Worker over HTTP: health, OAuth discovery, the decision-7 policy baseline (no raw
// provider proxy; only the allowlisted providers' actions, minus the blocked ones) and the decision-8 guardrail (no
// default connection for any provider, so a write that names no account is refused; no account connected twice).
// Prints one PASS/FAIL line per check; exits non-zero on any FAIL.
//
// Usage: node scripts/verify-deployment.ts [--origin <url>]
//   --origin  Worker origin (default: the one saved in splitmind.local.json by scripts/deploy.ts).
//
// It needs the admin token to create one temporary runtime token, which it deletes before exiting. The admin token
// comes from SPLITMIND_ADMIN_TOKEN, or a hidden prompt; it is never printed. The temporary token is granted every
// proxy and every action, so any refusal below comes from the deployment's own policy, not from the token.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { allowlistedProviders, blockedActions } from "./deploy.ts";

const root = resolve(import.meta.dirname, "..");

interface Envelope {
  success?: boolean;
  errorCode?: string;
  data?: unknown;
}

interface Connection {
  service: string;
  connectionName: string;
  default?: boolean;
  profile?: { accountId?: string };
}

/** One write per provider that would change something if it ever reached a workspace. Used only with no alias. */
const guardedWrites: Record<string, { actionId: string; input: unknown }> = {
  notion: {
    actionId: "notion.create_page",
    input: { parent: { page_id: "00000000000000000000000000000000" }, properties: {} },
  },
  slack: { actionId: "slack.post_message", input: { channelId: "C0000000000", text: "SplitMind guardrail check" } },
  gmail: {
    actionId: "gmail.create_draft",
    input: { to: "nobody@example.invalid", subject: "SplitMind guardrail check", body: "SplitMind guardrail check" },
  },
};

/** "a", "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function request(
  origin: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: Envelope | undefined }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: Envelope | undefined;
  try {
    json = JSON.parse(text) as Envelope;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

/** Calls an MCP tool with a runtime token and returns its structured result (the endpoint answers in SSE framing). */
async function callTool(origin: string, token: string, name: string, args: unknown): Promise<{ status: number; result: Record<string, unknown> | undefined }> {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await response.text();
  const payload = text.trimStart().startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5))
        .join("");
  try {
    const message = JSON.parse(payload) as { result?: { structuredContent?: Record<string, unknown> } };
    return { status: response.status, result: message.result?.structuredContent };
  } catch {
    return { status: response.status, result: undefined };
  }
}

function toolError(result: Record<string, unknown> | undefined): string {
  const error = result?.error as { code?: string } | undefined;
  return result ? `ok=${String(result.ok)}${error?.code ? ` ${error.code}` : ""}` : "no result";
}

function describe(result: { status: number; json: Envelope | undefined; text: string }): string {
  return `${result.status}${result.json?.errorCode ? ` ${result.json.errorCode}` : ""}`;
}

export async function verify(origin: string, adminToken: string): Promise<Check[]> {
  // The providers the deployment should offer are the ones its template allowlists.
  const template = readFileSync(join(root, "wrangler.template.jsonc"), "utf8");
  const expected = allowlistedProviders(template);
  const blocked = blockedActions(template);
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const health = await request(origin, "GET", "/health");
  check("GET /health returns {\"ok\":true}", health.status === 200 && health.text.trim() === '{"ok":true}', describe(health));

  const discovery = await request(origin, "GET", "/.well-known/oauth-authorization-server");
  const issuer = (discovery.json as { issuer?: string } | undefined)?.issuer;
  check("OAuth discovery names this origin as issuer", discovery.status === 200 && issuer === origin, `${discovery.status} issuer=${issuer}`);

  const anonymous = await request(origin, "POST", "/mcp", undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("POST /mcp without a token is refused", anonymous.status === 401, describe(anonymous));

  const created = await request(origin, "POST", "/api/runtime-tokens", adminToken, {
    name: "splitmind-verify (temporary)",
    allowedActions: [],
    blockedActions: [],
    allowedProxies: ["*"],
  });
  const record = created.json as { token?: string; record?: { id?: string } } | undefined;
  if (created.status !== 200 && created.status !== 201) {
    const hint = created.status === 401 ? "; is this the admin token, not the encryption key?" : "";
    check("create a temporary runtime token (admin token accepted)", false, describe(created) + hint);
    return checks;
  }
  const token = record?.token;
  const tokenId = record?.record?.id;
  if (!token || !tokenId) {
    check("create a temporary runtime token (admin token accepted)", false, `${created.status} unexpected body`);
    return checks;
  }

  try {
    for (const service of expected) {
      const proxy = await request(origin, "POST", `/v1/proxy/${service}`, token, { method: "GET", path: "/" });
      check(`raw ${service} proxy is blocked by deployment policy`, proxy.status === 403 && proxy.json?.errorCode === "proxy_blocked", describe(proxy));
    }

    const providers = await request(origin, "GET", "/v1/providers", token);
    const services = Array.isArray(providers.json?.data)
      ? (providers.json.data as { service: string }[]).map((provider) => provider.service).sort()
      : [];
    check(`only ${listOf(expected)} are offered`, providers.status === 200 && services.join(",") === expected.join(","), `${providers.status} [${services.join(", ")}]`);

    const outside = await request(origin, "POST", "/v1/actions/github.get_current_user", token, {});
    check(
      "an action outside the allowlist is refused",
      outside.status >= 400 && ["unknown_action", "action_not_allowed", "action_blocked"].includes(outside.json?.errorCode ?? ""),
      describe(outside),
    );

    // Contrast: an allowlisted action gets past policy and fails later, on its input.
    const inside = await request(origin, "POST", "/v1/actions/notion.search", token, {});
    check(
      "an allowlisted action is not refused by policy",
      !["unknown_action", "action_not_allowed", "action_blocked"].includes(inside.json?.errorCode ?? "") && inside.status !== 401,
      describe(inside),
    );

    // Blocked ids sit inside an allowed provider (e.g. gmail.* minus mailbox settings), so the block must win.
    if (blocked.length > 0) {
      const codes: string[] = [];
      for (const actionId of blocked) {
        const refused = await request(origin, "POST", `/v1/actions/${encodeURIComponent(actionId)}`, token, {});
        codes.push(`${actionId}=${describe(refused)}`);
      }
      check(
        `the ${blocked.length} blocked action(s) are refused by policy`,
        codes.every((code) => code.endsWith(" action_blocked")),
        codes.join(", "),
      );
    }

    await checkGuardrail(origin, adminToken, token, check);
  } finally {
    const deleted = await request(origin, "DELETE", `/api/runtime-tokens/${encodeURIComponent(tokenId)}`, adminToken);
    check("temporary runtime token deleted", deleted.status >= 200 && deleted.status < 300, describe(deleted));
  }
  return checks;
}

async function checkGuardrail(
  origin: string,
  adminToken: string,
  token: string,
  check: (name: string, ok: boolean, detail: string) => void,
): Promise<void> {
  const listed = await request(origin, "GET", "/api/connections", adminToken);
  const rows = Array.isArray(listed.json) ? (listed.json as unknown as Connection[]) : [];
  for (const service of Object.keys(guardedWrites)) {
    const mine = rows.filter((row) => row.service === service);
    const defaults = mine.filter((row) => row.default || row.connectionName === "default");
    check(
      `no default ${service} connection`,
      listed.status === 200 && defaults.length === 0,
      `${listed.status} ${mine.length} connection(s): [${mine.map((row) => row.connectionName).join(", ")}]`,
    );
    if (defaults.length > 0) {
      // Never send the unnamed write when a default exists: it would land in that workspace.
      check(`unnamed ${service} write is refused`, false, "skipped: a default connection exists; rename it first");
      continue;
    }
    if (mine.length === 0) continue;

    // Signing in to the provider as the wrong account (e.g. the browser's current Google session) stores the same
    // account under a second alias, so a call naming either alias would act there.
    if (mine.length > 1) {
      const count = (id: string | undefined) => mine.filter((row) => id && row.profile?.accountId === id).length;
      const repeated = mine.filter((row) => count(row.profile?.accountId) > 1).map((row) => row.connectionName);
      check(
        `each ${service} connection is a different account`,
        repeated.length === 0,
        repeated.length === 0 ? `${mine.length} connection(s)` : `same account under [${repeated.join(", ")}]`,
      );
    }

    const { actionId, input } = guardedWrites[service]!;
    const unnamed = await callTool(origin, token, "execute_action", { actionId, input });
    check(`unnamed ${service} write is refused (MCP execute_action, no connectionName)`, unnamed.result?.ok === false, toolError(unnamed.result));
    const named = await callTool(origin, token, "execute_action", { actionId, input, connectionName: "default" });
    const code = (named.result?.error as { code?: string } | undefined)?.code;
    check(`${service} write to connectionName "default" is refused`, named.result?.ok === false && code === "connection_not_found", toolError(named.result));
  }
}

// Terminals with bracketed paste wrap pasted text in ESC[200~ … ESC[201~; password managers can add whitespace.
export function cleanPastedSecret(raw: string): string {
  return raw.replace(/\u001b\[20[01]~/g, "").trim();
}

async function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise((done, fail) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          done(value);
          return;
        }
        if (char === "\u0003") {
          stdin.setRawMode(false);
          fail(new Error("cancelled"));
          return;
        }
        value = char === "\u007f" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { origin: { type: "string" } } });
  let origin = values.origin;
  if (!origin) {
    const statePath = join(root, "splitmind.local.json");
    origin = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { origin?: string }).origin : undefined;
  }
  if (!origin || !/^https?:\/\/[^/\s]+$/.test(origin)) {
    console.error("verify: pass --origin https://<host> (no path), or deploy first so splitmind.local.json has one");
    return 2;
  }

  let adminToken = process.env.SPLITMIND_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    if (!process.stdin.isTTY) {
      console.error("verify: set SPLITMIND_ADMIN_TOKEN, or run in a terminal to be prompted");
      return 2;
    }
    adminToken = cleanPastedSecret(await promptHidden("Admin token (input hidden): "));
  }

  console.log(`Verifying ${origin}`);
  const checks = await verify(origin, adminToken);
  for (const { name, ok, detail } of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${detail})`);
  }
  const failed = checks.filter((item) => !item.ok).length;
  console.log(failed === 0 ? `All ${checks.length} checks passed.` : `${failed} of ${checks.length} checks failed.`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`verify: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
