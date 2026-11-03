import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installPrivacyPage, installSecurityHeaders, installSetupPage } from "../scripts/deploy.ts";
import {
  accountsOf,
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
