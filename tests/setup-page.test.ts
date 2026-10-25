import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installPrivacyPage, installSetupPage } from "../scripts/deploy.ts";
import {
  accountsOf,
  nicknameProblem,
  renderSlackManifest,
  slackCredentials,
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
