import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installPrivacyPage, installSecurityHeaders, installSetupPage } from "../scripts/deploy.ts";
import {
  accountsOf,
  apiError,
  callbackError,
  explainError,
  nicknameProblem,
  renderSlackManifest,
  PROVIDERS,
  slackCredentials,
  TOKEN_PROVIDERS,
  tokenConnectionBody,
  withGoogleAccountChooser,
} from "../web/setup/setup.js";

const repo = resolve(import.meta.dirname, "..");
const manifestText = readFileSync(join(repo, "slack/app-manifest.json"), "utf8");
const html = readFileSync(join(repo, "web/setup/index.html"), "utf8");
const script = readFileSync(join(repo, "web/setup/setup.js"), "utf8");

describe("setup page nicknames", () => {
  it("accepts a short alias", () => {
    expect(nicknameProblem("home")).toBeUndefined();
    expect(nicknameProblem("work_2")).toBeUndefined();
  });

  it.each(["", "default", "Default", "-home", "has space", "a".repeat(65)])("refuses %j", (name) => {
    expect(nicknameProblem(name)).toBeTypeOf("string");
  });

  it("refuses a nickname that provider already uses", () => {
    expect(nicknameProblem("home", ["home"])).toMatch(/already connected/);
  });
});

describe("Gmail account chooser", () => {
  it("adds select_account and keeps consent, so Google never reuses the browser's account silently", () => {
    const url = withGoogleAccountChooser(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&prompt=consent&state=s&access_type=offline",
    );
    const params = new URL(url).searchParams;
    expect(params.get("prompt")?.split(" ").sort()).toEqual(["consent", "select_account"]);
    expect(params.get("state")).toBe("s");
    expect(params.get("access_type")).toBe("offline");
  });

  it("leaves other providers' URLs alone", () => {
    const notion = "https://api.notion.com/v1/oauth/authorize?client_id=x&owner=user";
    expect(withGoogleAccountChooser(notion)).toBe(notion);
  });
});

describe("Slack app creation", () => {
  it("fills the origin and names the app after the workspace nickname", () => {
    const manifest = renderSlackManifest(manifestText, "https://splitmind.example.workers.dev", "work");
    expect(manifest.oauth_config.redirect_urls).toEqual(["https://splitmind.example.workers.dev/oauth/callback"]);
    expect(manifest.display_information.name).toBe("SplitMind (work)");
    expect(JSON.stringify(manifest)).not.toContain("<origin>");
  });

  it("keeps the app name within Slack's 35-character limit", () => {
    const manifest = renderSlackManifest(manifestText, "https://a.example", "x".repeat(64));
    expect(manifest.display_information.name.length).toBeLessThanOrEqual(35);
  });

  it("refuses an origin with a path", () => {
    expect(() => renderSlackManifest(manifestText, "https://a.example/setup", "work")).toThrow();
  });

  it("reads the client credentials from apps.manifest.create", () => {
    expect(
      slackCredentials({ ok: true, app_id: "A1", credentials: { client_id: "1.2", client_secret: "s" } }),
    ).toEqual({ appId: "A1", clientId: "1.2", clientSecret: "s" });
  });

  it("explains an expired configuration token", () => {
    expect(() => slackCredentials({ ok: false, error: "invalid_auth" })).toThrow(/Generate a fresh one/);
  });

  it("passes on Slack's manifest errors", () => {
    expect(() =>
      slackCredentials({ ok: false, error: "invalid_manifest", errors: [{ pointer: "/oauth_config", message: "bad" }] }),
    ).toThrow(/invalid_manifest.*\/oauth_config bad/);
  });
});

describe("account list", () => {
  it("shows stored connections only", () => {
    const connections = [
      { service: "gmail", connectionName: "home", configured: true, virtual: false },
      { service: "gmail", connectionName: "default", configured: false, virtual: true },
      { service: "gmail", connectionName: "mkt", configured: true, virtual: false, marketplace: { id: "m" } },
      { service: "slack", connectionName: "work", configured: true, virtual: false },
    ];
    expect(accountsOf(connections, "gmail").map((c: { connectionName: string }) => c.connectionName)).toEqual(["home"]);
  });
});

describe("page safety", () => {
  it("loads no third-party scripts or styles", () => {
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
  });

  it("only talks to its own Worker and Slack's app-creation endpoint", () => {
    const hosts = [...script.matchAll(/fetch\("https:\/\/([^/"]+)[^"]*"/g)].map((match) => match[1]);
    expect(hosts).toEqual(["slack.com"]);
    expect(script).toContain('fetch("https://slack.com/api/apps.manifest.create"');
  });

  it("never stores a token or secret in the browser", () => {
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});

describe("installSetupPage", () => {
  it("copies the page and the Slack manifest into the Web Console build", () => {
    const dist = mkdtempSync(join(tmpdir(), "splitmind-web-"));
    try {
      installSetupPage(repo, dist);
      expect(readdirSync(join(dist, "setup")).sort()).toEqual(["index.html", "setup.js", "slack-manifest.json"]);
      expect(readFileSync(join(dist, "setup/slack-manifest.json"), "utf8")).toBe(manifestText);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("installSecurityHeaders", () => {
  const upstream = "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";

  it("keeps the Web Console's own rules and adds ours once, however often it runs", () => {
    const dist = mkdtempSync(join(tmpdir(), "splitmind-web-"));
    try {
      writeFileSync(join(dist, "_headers"), upstream);
      installSecurityHeaders(repo, dist);
      installSecurityHeaders(repo, dist);
      const headers = readFileSync(join(dist, "_headers"), "utf8");
      expect(headers.startsWith(upstream)).toBe(true);
      expect(headers.match(/^\/setup\/\*$/gm)).toHaveLength(1);
      expect(headers.match(/X-Frame-Options: DENY/g)).toHaveLength(1);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("writes the file when the build has none", () => {
    const dist = mkdtempSync(join(tmpdir(), "splitmind-web-"));
    try {
      installSecurityHeaders(repo, dist);
      expect(readFileSync(join(dist, "_headers"), "utf8")).toContain("frame-ancestors 'none'");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("lets the setup page reach only itself and Slack, and nobody frame it", () => {
    const rules = readFileSync(join(repo, "web/_headers"), "utf8");
    const csp = rules.split("\n/setup/*\n")[1].split("\n")[0];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("connect-src 'self' https://slack.com;");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});

describe("installPrivacyPage", () => {
  it("copies the privacy policy into the Web Console build", () => {
    const dist = mkdtempSync(join(tmpdir(), "splitmind-web-"));
    try {
      installPrivacyPage(repo, dist);
      expect(readdirSync(join(dist, "privacy"))).toEqual(["index.html"]);
      expect(readFileSync(join(dist, "privacy/index.html"), "utf8")).toContain("<h1>SplitMind privacy policy</h1>");
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("states the Limited Use commitment Google asks for", () => {
    const policy = readFileSync(join(repo, "web/privacy/index.html"), "utf8");
    expect(policy).toContain("Google API Services User Data Policy");
    expect(policy).toContain("Limited Use requirements");
  });
});

describe("token providers (Netlify, Cloudflare)", () => {
  const upstream = (service: string) =>
    readFileSync(join(repo, "vendor/open-connector/src/providers", service, "definition.ts"), "utf8");
  const template = readFileSync(join(repo, "wrangler.template.jsonc"), "utf8");

  const vendored = existsSync(join(repo, "vendor/open-connector/src/providers"));

  it.each(Object.keys(TOKEN_PROVIDERS))("%s is on the page and allowlisted", (service) => {
    expect(PROVIDERS).toContain(service);
    expect(template).toContain(`${service}.*`);
  });

  // CI checks out without the submodule; locally (and after bootstrap) this pins the fields to the vendored release.
  it.skipIf(!vendored).each(Object.keys(TOKEN_PROVIDERS))("%s matches upstream's auth definition", (service) => {
    const spec = TOKEN_PROVIDERS[service as keyof typeof TOKEN_PROVIDERS];
    const definition = upstream(service);
    expect(definition).toContain(`type: "${spec.authType}"`);
    if (spec.authType === "custom_credential") {
      for (const field of spec.fields) expect(definition).toContain(`key: "${field.key}"`);
    } else {
      expect(spec.fields.map((field) => field.key)).toEqual(["apiKey"]);
    }
  });

  it("builds the api_key body the console API expects, trimming pasted whitespace", () => {
    expect(tokenConnectionBody("netlify", "home", { apiKey: "  nfp_x \n" })).toEqual({
      authType: "api_key",
      connectionName: "home",
      values: { apiKey: "nfp_x" },
    });
  });

  it("builds the custom_credential body for Workers with the account ID", () => {
    const accountId = "0".repeat(32);
    expect(tokenConnectionBody("cloudflare_worker", "work", { apiKey: "t", accountId })).toEqual({
      authType: "custom_credential",
      connectionName: "work",
      values: { apiKey: "t", accountId },
    });
  });

  it("refuses a missing token or a malformed account ID", () => {
    expect(() => tokenConnectionBody("cloudflare_dns", "a", { apiKey: " " })).toThrow(/Cloudflare API token/);
    expect(() => tokenConnectionBody("cloudflare_worker", "a", { apiKey: "t", accountId: "abc" })).toThrow(/32 hex/);
    expect(() => tokenConnectionBody("gmail", "a", {})).toThrow(/doesn't connect with a token/);
  });
});

// Plain-English errors (#66). Error shapes come from the vendored OpenConnector:
//  - the console API answers { error: { code, message } } (server/api/http-utils.ts jsonError);
//  - Gmail's failed users.getProfile surfaces as code "credential_verification_failed" with Google's message;
//  - a provider's OAuth error query on /oauth/callback becomes code "oauth_provider_error" with the message
//    `OAuth provider returned error "<error>": <error_description>` (server/api/console-oauth-routes.ts).
describe("explainError", () => {
  const sentence = (found: { text: string } | undefined) => {
    expect(found).toBeDefined();
    expect(found!.text).toBeTypeOf("string");
    expect(found!.text.trim()).not.toBe("");
    expect(found!.text).not.toMatch(/\n/);
  };
  const words = (found: { text: string; next?: string } | undefined) => `${found?.text ?? ""} ${found?.next ?? ""}`;

  describe("Gmail account without an inbox (E1)", () => {
    const base = { service: "gmail", code: "credential_verification_failed", status: 400 };

    it.each(["Precondition check failed.", "PRECONDITION CHECK FAILED", 'Gmail profile: {"error":{"status":"FAILED_PRECONDITION","message":"Precondition check failed."}}'])(
      "maps %j",
      (message) => {
        const found = explainError({ ...base, message });
        sentence(found);
        expect(found!.text).toMatch(/no Gmail inbox/i);
        expect(words(found)).toMatch(/forward/i);
      },
    );

    it("does not depend on the HTTP status", () => {
      for (const status of [undefined, 400, 500]) {
        expect(explainError({ ...base, message: "Precondition check failed.", status })?.text).toMatch(/no Gmail inbox/i);
      }
    });

    it("does not map the same message under another code", () => {
      for (const code of ["oauth_provider_error", "invalid_input", "provider_error", "connection_not_found"]) {
        expect(explainError({ ...base, code, message: "Precondition check failed." })).toBeUndefined();
      }
    });

    it("does not map the same message and code for another service", () => {
      for (const service of ["notion", "slack", "netlify", "cloudflare_dns"]) {
        expect(explainError({ ...base, service, message: "Precondition check failed." })).toBeUndefined();
      }
    });

    it("does not map a different verification failure", () => {
      expect(explainError({ ...base, message: "profile unavailable" })).toBeUndefined();
    });
  });

  describe("Workspace admin blocks the app (E2)", () => {
    const base = { service: "gmail", code: "oauth_provider_error", status: 400 };

    it.each([
      'OAuth provider returned error "access_denied": admin_policy_enforced',
      'OAuth provider returned error "admin_policy_enforced".',
      "Access blocked: SplitMind has not completed the Google verification process",
      "ACCESS BLOCKED",
    ])("maps %j", (message) => {
      const found = explainError({ ...base, message });
      sentence(found);
      expect(found!.text).toMatch(/Workspace admin/i);
      expect(found!.text).toMatch(/blocks/i);
    });

    it("links to the doc section on trusting the OAuth client, and that section exists", () => {
      const found = explainError({ ...base, message: "admin_policy_enforced" });
      expect(found?.docHref).toBeTypeOf("string");
      // Either repo-relative or a GitHub URL; in both cases it ends in the docs path plus an anchor.
      const match = /(docs\/providers\/gmail\.md)#([a-z0-9-]+)$/.exec(found!.docHref!);
      expect(match, `docHref ${found?.docHref}`).not.toBeNull();
      const file = join(repo, match![1]);
      expect(existsSync(file)).toBe(true);
      const slugs = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) =>
          line
            .replace(/^#+ /, "")
            .toLowerCase()
            .replace(/[^a-z0-9 -]/g, "")
            .replace(/ /g, "-"),
        );
      expect(slugs).toContain(match![2]);
      expect(match![2]).toBe("a-google-workspace-account");
    });

    it("leaves a plain cancel alone: the user pressing Cancel is not an admin block", () => {
      expect(explainError({ ...base, message: 'OAuth provider returned error "access_denied".' })).toBeUndefined();
    });

    it("needs the OAuth code, not the message alone", () => {
      expect(explainError({ ...base, code: "connection_not_found", message: "Access blocked" })).toBeUndefined();
    });

    it("does not tell a Slack or Notion user their Google admin is the problem", () => {
      for (const service of ["slack", "notion"]) {
        expect(explainError({ ...base, service, message: "admin_policy_enforced" })).toBeUndefined();
      }
    });
  });

  describe("Slack admin approval pending (E3)", () => {
    const base = { service: "slack", status: 400 };
    const assertMaps = (found: ReturnType<typeof explainError>) => {
      sentence(found);
      expect(found!.text).toMatch(/Slack workspace admin/i);
      expect(found!.text).toMatch(/approve/i);
      expect(words(found)).toMatch(/Connect again/i);
    };

    it.each(["App approval pending", undefined])("maps the app_approval_pending code (message %j)", (message) => {
      assertMaps(explainError({ ...base, code: "app_approval_pending", message }));
    });

    it.each([
      'OAuth provider returned error "access_denied": the app is awaiting admin approval',
      'OAuth provider returned error "access_denied": APPROVAL required from a workspace admin',
      "This app is pending approval",
    ])("maps an OAuth return that mentions approval: %j", (message) => {
      assertMaps(explainError({ ...base, code: "oauth_provider_error", message }));
    });

    it("leaves a plain access_denied alone: that is the user pressing Cancel", () => {
      expect(explainError({ ...base, code: "oauth_provider_error", message: 'OAuth provider returned error "access_denied".' })).toBeUndefined();
    });

    it("needs the OAuth code for a message match", () => {
      expect(explainError({ ...base, code: "connection_not_found", message: "approval" })).toBeUndefined();
    });

    it("does not apply to other services", () => {
      for (const service of ["gmail", "notion", "netlify"]) {
        expect(explainError({ service, code: "oauth_provider_error", message: "awaiting admin approval" })).toBeUndefined();
        expect(explainError({ service, code: "app_approval_pending", message: "x" })).toBeUndefined();
      }
    });
  });

  describe("unknown errors (E4)", () => {
    it.each([
      { service: "notion", code: "some_new_code", message: "Something odd happened" },
      { service: "gmail", code: "rate_limited", message: "Slow down" },
      { service: "netlify", code: "credential_verification_failed", message: "Bad token" },
      { service: "cloudflare_worker", code: "invalid_input", message: "Account ID is wrong" },
    ])("returns undefined for %j so the raw message shows as today", (input) => {
      expect(explainError({ ...input, status: 400 })).toBeUndefined();
    });

    it("does not throw when a field is missing, null or oddly typed", () => {
      const inputs = [
        {},
        { service: "gmail" },
        { code: "credential_verification_failed" },
        { message: "Precondition check failed." },
        { service: "gmail", code: "credential_verification_failed" },
        { service: "gmail", message: "Precondition check failed." },
        { code: "oauth_provider_error", message: "Access blocked" },
        { service: "slack", code: "app_approval_pending" },
        { service: "slack", code: "oauth_provider_error" },
        { service: "gmail", code: null, message: null, status: null },
        { service: undefined, code: undefined, message: undefined, status: undefined },
        { service: "gmail", code: 42, message: { not: "a string" }, status: "400" },
      ];
      for (const input of inputs) expect(() => explainError(input as never)).not.toThrow();
    });

    it("returns undefined, not an empty object, when nothing matches", () => {
      expect(explainError({})).toBeUndefined();
      expect(explainError({ service: "gmail", code: "credential_verification_failed" })).toBeUndefined();
    });
  });
});

describe("apiError (E5)", () => {
  it("keeps the message and carries the code and status", () => {
    const error = apiError({ error: { code: "credential_verification_failed", message: "Precondition check failed." } }, 400);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Precondition check failed.");
    expect(error.code).toBe("credential_verification_failed");
    expect(error.status).toBe(400);
  });

  it("falls back to payload.message, then to the status line, exactly as requestJson does today", () => {
    const plain = apiError({ message: "Not allowed" }, 403);
    expect(plain.message).toBe("Not allowed");
    expect(plain.status).toBe(403);
    expect(plain.code).toBeUndefined();

    const empty = apiError(undefined, 502);
    expect(empty.message).toBe("Request failed (502)");
    expect(empty.status).toBe(502);
    expect(empty.code).toBeUndefined();
  });

  it("feeds explainError directly", () => {
    const error = apiError({ error: { code: "credential_verification_failed", message: "Precondition check failed." } }, 400);
    expect(explainError({ service: "gmail", code: error.code, message: error.message, status: error.status })?.text).toMatch(/no Gmail inbox/i);
  });

  it("is what requestJson throws", () => {
    expect(script).toMatch(/throw apiError\(/);
  });
});

describe("setup page error rendering (E6, static)", () => {
  /** The text of every `catch ... { ... }` block, found by brace matching. */
  const catchBlocks = (source: string): string[] => {
    const blocks: string[] = [];
    for (const match of source.matchAll(/catch\s*(\([^)]*\))?\s*\{/g)) {
      let depth = 1;
      let index = match.index! + match[0].length;
      const start = index;
      while (depth > 0 && index < source.length) {
        const char = source[index++];
        if (char === "{") depth++;
        else if (char === "}") depth--;
      }
      blocks.push(source.slice(start, index));
    }
    return blocks;
  };
  /** Names of functions (other than explainError itself) whose body calls explainError. */
  const helpers = [...script.matchAll(/(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g)]
    .map((match) => {
      let depth = 1;
      let index = match.index! + match[0].length;
      const start = index;
      while (depth > 0 && index < script.length) {
        const char = script[index++];
        if (char === "{") depth++;
        else if (char === "}") depth--;
      }
      return { name: match[1], body: script.slice(start, index) };
    })
    .filter(({ name, body }) => name !== "explainError" && /\bexplainError\(/.test(body))
    .map(({ name }) => name);

  it("never sets innerHTML, insertAdjacentHTML or outerHTML", () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("exports explainError and apiError", () => {
    expect(script).toMatch(/export function explainError\(/);
    expect(script).toMatch(/export function apiError\(/);
  });

  it("never passes a raw error.message straight to setStatus", () => {
    expect(script).not.toMatch(/setStatus\([^;]*\b(error|err|e)\.message/);
  });

  it("routes every catch block that reports an error through explainError, directly or via a helper", () => {
    const reporting = catchBlocks(script).filter((block) => /setStatus\(/.test(block) && /"error"/.test(block));
    expect(reporting.length).toBeGreaterThanOrEqual(5); // startOAuth, disconnect, the Slack-app save, connectToken, connectSlack
    for (const block of reporting) {
      const routed = /\bexplainError\(/.test(block) || helpers.some((name) => new RegExp(`\\b${name}\\(`).test(block));
      expect(routed, `catch block does not use explainError:\n${block}`).toBe(true);
    }
  });

  it("renders the raw message behind a Details toggle using DOM APIs", () => {
    expect(script).toMatch(/["']details["']/);
    expect(script).toMatch(/["']summary["']/);
    expect(script).toMatch(/Details/);
  });

  it("tells Notion guests that only workspace members can connect apps", () => {
    const page = html + script;
    expect(page).toContain("Notion only lets workspace members connect apps");
    expect(page).toMatch(/If you're a guest, ask an owner to make you a member or connect SplitMind for you/);
  });

  it("tells the user to tick the pages SplitMind may see in Notion's consent screen", () => {
    const page = html + script;
    expect(page).toContain("tick the pages SplitMind may see");
    expect(page).toMatch(/with none ticked it sees nothing/);
  });

  it("adds no new API call (the hint is static)", () => {
    // api() is called 9 times on main: configs, connections x2, authorizations, delete, save config, token connect, session x2.
    expect([...script.matchAll(/\bapi\(\s*"(GET|POST|PUT|DELETE)"/g)]).toHaveLength(9);
  });
});

// Reading the OAuth popup (no server change). The popup ends on our own /oauth/callback, which answers
// { error: { code, message } } as JSON on failure (jsonError in the vendored server/api/http-utils.ts) and an HTML
// completion page on success.
describe("callbackError (P1)", () => {
  it("returns code and message from a JSON error body", () => {
    const body = JSON.stringify({ error: { code: "credential_verification_failed", message: "Precondition check failed." } });
    expect(callbackError(body)).toEqual({ code: "credential_verification_failed", message: "Precondition check failed." });
  });

  it("copes with the whitespace and pretty-printing a browser's JSON view adds", () => {
    const body = `\n  ${JSON.stringify({ error: { code: "invalid_oauth_callback", message: "OAuth callback requires state and code." } }, null, 2)}\n`;
    expect(callbackError(body)).toEqual({ code: "invalid_oauth_callback", message: "OAuth callback requires state and code." });
  });

  it("reads the provider-error shape the callback really emits", () => {
    const message = 'OAuth provider returned error "access_denied": admin_policy_enforced';
    expect(callbackError(JSON.stringify({ error: { code: "oauth_provider_error", message } }))).toEqual({
      code: "oauth_provider_error",
      message,
    });
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "  \n "],
    ["plain text", "Connected. You can close this tab."],
    ["an HTML completion page", "<!doctype html><html><body><h1>Gmail connected</h1></body></html>"],
    ["truncated JSON", '{"error":{"code":"x","message":'],
    ["JSON null", "null"],
    ["a JSON number", "42"],
    ["a JSON string", '"boom"'],
    ["a JSON array", '[{"error":{"code":"x","message":"y"}}]'],
    ["JSON without error", '{"ok":true}'],
    ["a success body", '{"service":"gmail","connectionName":"home","status":"connected"}'],
    ["an error that is a string", '{"error":"boom"}'],
    ["an error that is null", '{"error":null}'],
    ["an error without a message", '{"error":{"code":"x"}}'],
    ["an error whose message is not a string", '{"error":{"code":"x","message":{"a":1}}}'],
  ])("returns undefined for %s", (_name, body) => {
    expect(callbackError(body)).toBeUndefined();
  });

  it("never throws, whatever it is given", () => {
    for (const input of [undefined, null, 0, {}, [], "{", "\u0000", "{".repeat(100_000)]) {
      expect(() => callbackError(input as never)).not.toThrow();
    }
  });
});

describe("callback body to plain English (P3, end to end on the pure parts)", () => {
  it("turns the Gmail no-inbox callback body into the no-inbox text", () => {
    const body = JSON.stringify({ error: { code: "credential_verification_failed", message: "Precondition check failed." } });
    expect(explainError({ service: "gmail", ...callbackError(body) })?.text).toMatch(/no Gmail inbox/i);
  });

  it("turns a Workspace-blocked callback body into the admin text with its doc link", () => {
    const body = JSON.stringify({
      error: { code: "oauth_provider_error", message: 'OAuth provider returned error "access_denied": admin_policy_enforced' },
    });
    const found = explainError({ service: "gmail", ...callbackError(body) });
    expect(found?.text).toMatch(/Workspace admin/i);
    expect(found?.docHref).toMatch(/docs\/providers\/gmail\.md#a-google-workspace-account$/);
  });

  it("turns a Slack approval-pending callback body into the approval text", () => {
    const body = JSON.stringify({
      error: { code: "oauth_provider_error", message: 'OAuth provider returned error "access_denied": app approval pending' },
    });
    expect(explainError({ service: "slack", ...callbackError(body) })?.text).toMatch(/Slack workspace admin/i);
  });

  it("leaves an unrecognised callback error to the raw message", () => {
    const body = JSON.stringify({ error: { code: "invalid_oauth_callback", message: "OAuth callback requires state and code." } });
    expect(explainError({ service: "gmail", ...callbackError(body) })).toBeUndefined();
  });
});

describe("popup polling reads the callback (P2, static)", () => {
  const bodyOf = (source: string, open: RegExp): { name: string; body: string }[] =>
    [...source.matchAll(open)].map((match) => {
      let depth = 1;
      let index = match.index! + match[0].length;
      const start = index;
      while (depth > 0 && index < source.length) {
        const char = source[index++];
        if (char === "{") depth++;
        else if (char === "}") depth--;
      }
      return { name: match[1] ?? "", body: source.slice(start, index) };
    });
  const functions = new Map(
    bodyOf(script, /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g).map(({ name, body }) => [name, body]),
  );
  /** pollUntilConnected plus every file-local function reachable from it. */
  const reachable = (): string => {
    const seen = new Set<string>();
    const queue = ["pollUntilConnected"];
    let text = "";
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name) || !functions.has(name) || name === "explainError" || name === "callbackError") continue;
      seen.add(name);
      const body = functions.get(name)!;
      text += `\n${body}`;
      for (const other of functions.keys()) if (new RegExp(`\\b${other}\\(`).test(body)) queue.push(other);
    }
    return text;
  };
  const explainHelpers = [...functions].filter(([name, body]) => name !== "explainError" && /\bexplainError\(/.test(body)).map(([name]) => name);

  it("exports callbackError", () => {
    expect(script).toMatch(/export function callbackError\(/);
  });

  it("polling reaches callbackError and the /oauth/callback path", () => {
    expect(functions.has("pollUntilConnected")).toBe(true);
    const text = reachable();
    expect(text).toMatch(/\bcallbackError\(/);
    expect(text).toContain("/oauth/callback");
  });

  it("reads the popup's location and body inside a try block, because that throws on the provider's origin", () => {
    const tries = bodyOf(reachable(), /\btry\s*\{/g).map(({ body }) => body);
    expect(tries.some((block) => /\.pathname/.test(block) && /textContent/.test(block))).toBe(true);
  });

  it("shows what it read through explainError, directly or via a helper", () => {
    const text = reachable();
    const routed = /\bexplainError\(/.test(text) || explainHelpers.some((name) => new RegExp(`\\b${name}\\(`).test(text));
    expect(routed).toBe(true);
  });

  it("stops polling and closes the popup once it has an error", () => {
    const text = reachable();
    expect(text).toMatch(/clearInterval\(/);
    expect(text).toMatch(/\.close\(\)/);
  });

  it("still never uses innerHTML for the callback text", () => {
    expect(script).not.toMatch(/innerHTML/);
  });
});
