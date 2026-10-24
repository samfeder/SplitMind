import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanPastedSecret } from "../scripts/verify-deployment.ts";

// Runs the real scripts/verify-deployment.ts against a stand-in Worker: a local HTTP server that answers like
// OpenConnector does. One variant follows the SplitMind policy; the other leaves the raw proxy open.

const script = resolve(import.meta.dirname, "../scripts/verify-deployment.ts");
const ADMIN = "test-admin-token";
const RUNTIME = "test-runtime-token";

interface Behaviour {
  proxyOpen: boolean;
  connections?: { service: string; connectionName: string; default: boolean; profile?: { accountId: string } }[];
  blockOpen?: boolean;
}

let server: Server | undefined;
let deletedTokens: string[] = [];
let toolCalls: unknown[] = [];

afterEach(async () => {
  if (server) await new Promise((done) => server!.close(done));
  server = undefined;
  deletedTokens = [];
  toolCalls = [];
});

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function startWorker(behaviour: Behaviour): Promise<string> {
  let origin = "";
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const auth = request.headers.authorization;
    const url = request.url ?? "";
    const key = `${request.method} ${url}`;
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => route(request, response, key, url, auth, body));
  });
  const route = (request: IncomingMessage, response: ServerResponse, key: string, url: string, auth: string | undefined, body: string) => {
    if (key === "GET /health") return send(response, 200, '{"ok":true}\n');
    if (key === "GET /.well-known/oauth-authorization-server") return send(response, 200, { issuer: origin });
    if (key === "POST /mcp" && auth !== `Bearer ${RUNTIME}`) return send(response, 401, { error: "invalid_token" });
    if (key === "POST /mcp") {
      const call = JSON.parse(body) as { params: { arguments: { connectionName?: string } } };
      toolCalls.push(call.params.arguments);
      const code = call.params.arguments.connectionName ? "connection_not_found" : "authorization_failed";
      const result = { structuredContent: { ok: false, error: { code } } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      return response.end(`event: message\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id: 1 })}\n\n`);
    }
    if (key === "GET /api/connections") {
      if (auth !== `Bearer ${ADMIN}`) return send(response, 401, { errorCode: "unauthorized" });
      return send(response, 200, behaviour.connections ?? []);
    }
    if (key === "POST /api/runtime-tokens") {
      if (auth !== `Bearer ${ADMIN}`) return send(response, 401, { errorCode: "unauthorized" });
      return send(response, 201, { token: RUNTIME, record: { id: "token-1" } });
    }
    if (request.method === "DELETE" && url.startsWith("/api/runtime-tokens/")) {
      deletedTokens.push(url.slice("/api/runtime-tokens/".length));
      return send(response, 200, { ok: true });
    }
    if (auth !== `Bearer ${RUNTIME}`) return send(response, 401, { errorCode: "unauthorized" });
    if (url.startsWith("/v1/proxy/")) {
      return behaviour.proxyOpen
        ? send(response, 200, { success: true, data: { status: 200 } })
        : send(response, 403, { success: false, errorCode: "proxy_blocked" });
    }
    if (key === "GET /v1/providers") return send(response, 200, { success: true, data: [{ service: "slack" }, { service: "gmail" }, { service: "notion" }] });
    if (key === "POST /v1/actions/github.get_current_user") return send(response, 404, { success: false, errorCode: "unknown_action" });
    if (url.startsWith("/v1/actions/gmail.update_") || url === "/v1/actions/gmail.stop_watch") {
      return behaviour.blockOpen
        ? send(response, 400, { success: false, errorCode: "invalid_input" })
        : send(response, 400, { success: false, errorCode: "action_blocked" });
    }
    if (key === "POST /v1/actions/notion.search") return send(response, 400, { success: false, errorCode: "invalid_input" });
    return send(response, 500, { unexpected: key });
  };
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return origin;
}

async function verify(origin: string, adminToken: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [script, "--origin", origin], {
    env: { ...process.env, SPLITMIND_ADMIN_TOKEN: adminToken },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise<number | null>((done) => child.on("close", done));
  return { status, stdout, stderr };
}

describe("scripts/verify-deployment.ts", () => {
  it("passes every check on a Worker that follows the policy, and cleans up its token", async () => {
    const origin = await startWorker({ proxyOpen: false });

    const result = await verify(origin, ADMIN);

    expect(result.stdout).toContain("PASS  raw notion proxy is blocked by deployment policy  (403 proxy_blocked)");
    expect(result.stdout).toContain("PASS  raw gmail proxy is blocked by deployment policy  (403 proxy_blocked)");
    expect(result.stdout).toContain("PASS  only gmail, notion and slack are offered  (200 [gmail, notion, slack])");
    expect(result.stdout).toContain("PASS  the 5 blocked action(s) are refused by policy  (gmail.stop_watch=400 action_blocked, ");
    expect(result.stdout).toContain("PASS  no default gmail connection  (200 0 connection(s): [])");
    expect(result.stdout).toContain("PASS  an action outside the allowlist is refused  (404 unknown_action)");
    expect(result.stdout).toContain("PASS  no default notion connection  (200 0 connection(s): [])");
    expect(result.stdout).toContain("All 14 checks passed.");
    expect(result.status).toBe(0);
    expect(deletedTokens).toEqual(["token-1"]);
  });

  it("fails when the raw proxy is open, and still deletes its token", async () => {
    const origin = await startWorker({ proxyOpen: true });

    const result = await verify(origin, ADMIN);

    expect(result.stdout).toContain("FAIL  raw slack proxy is blocked by deployment policy  (200)");
    expect(result.stdout).toContain("3 of 14 checks failed.");
    expect(result.status).toBe(1);
    expect(deletedTokens).toEqual(["token-1"]);
  });

  it("checks that writes naming no account are refused when only named connections exist", async () => {
    const origin = await startWorker({
      proxyOpen: false,
      connections: [
        { service: "notion", connectionName: "notion_a", default: false, profile: { accountId: "bot-A" } },
        { service: "notion", connectionName: "notion_b", default: false, profile: { accountId: "bot-B" } },
      ],
    });

    const result = await verify(origin, ADMIN);

    expect(result.stdout).toContain("PASS  no default notion connection  (200 2 connection(s): [notion_a, notion_b])");
    expect(result.stdout).toContain("PASS  each notion connection is a different account  (2 connection(s))");
    expect(result.stdout).toContain(
      "PASS  unnamed notion write is refused (MCP execute_action, no connectionName)  (ok=false authorization_failed)",
    );
    expect(result.stdout).toContain('PASS  notion write to connectionName "default" is refused  (ok=false connection_not_found)');
    expect(result.status).toBe(0);
    expect(toolCalls).toEqual([
      { actionId: "notion.create_page", input: { parent: { page_id: "00000000000000000000000000000000" }, properties: {} } },
      {
        actionId: "notion.create_page",
        input: { parent: { page_id: "00000000000000000000000000000000" }, properties: {} },
        connectionName: "default",
      },
    ]);
  });

  it("fails when a blocked action gets past policy", async () => {
    const origin = await startWorker({ proxyOpen: false, blockOpen: true });

    const result = await verify(origin, ADMIN);

    expect(result.stdout).toContain("FAIL  the 5 blocked action(s) are refused by policy  (gmail.stop_watch=400 invalid_input, ");
    expect(result.status).toBe(1);
  });

  it("fails when one Google account is connected under two aliases", async () => {
    const origin = await startWorker({
      proxyOpen: false,
      connections: [
        { service: "gmail", connectionName: "personal", default: false, profile: { accountId: "a@example.com" } },
        { service: "gmail", connectionName: "work", default: false, profile: { accountId: "a@example.com" } },
        { service: "gmail", connectionName: "side", default: false, profile: { accountId: "b@example.com" } },
      ],
    });

    const result = await verify(origin, ADMIN);

    expect(result.stdout).toContain("FAIL  each gmail connection is a different account  (same account under [personal, work])");
    expect(result.stdout).toContain(
      "PASS  unnamed gmail write is refused (MCP execute_action, no connectionName)  (ok=false authorization_failed)",
    );
    expect(result.status).toBe(1);
  });

  it("never sends the unnamed write when a default connection exists", async () => {
    const origin = await startWorker({
      proxyOpen: false,
      connections: [{ service: "slack", connectionName: "default", default: true }],
    });

    const result = await verify(origin, ADMIN);

    expect(result.stdout).toContain("FAIL  no default slack connection  (200 1 connection(s): [default])");
    expect(result.stdout).toContain("FAIL  unnamed slack write is refused  (skipped: a default connection exists; rename it first)");
    expect(result.status).toBe(1);
    expect(toolCalls).toEqual([]);
  });

  it("never prints the admin token", async () => {
    const origin = await startWorker({ proxyOpen: false });

    const wrong = await verify(origin, "not-the-admin-token");

    expect(wrong.stdout).toContain(
      "FAIL  create a temporary runtime token (admin token accepted)  (401 unauthorized; is this the admin token, not the encryption key?)",
    );
    expect(wrong.status).toBe(1);
    expect(wrong.stdout + wrong.stderr).not.toContain("not-the-admin-token");
  });
});

describe("cleanPastedSecret", () => {
  it("strips bracketed-paste markers and surrounding whitespace", () => {
    expect(cleanPastedSecret("\u001b[200~abc+/=\u001b[201~")).toBe("abc+/=");
    expect(cleanPastedSecret("  abc+/= \t")).toBe("abc+/=");
    expect(cleanPastedSecret("abc+/=")).toBe("abc+/=");
  });
});
