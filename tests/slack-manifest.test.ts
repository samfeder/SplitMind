import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Reads the manifest exactly as a user pastes it into Slack's
// "Create New App → From a manifest" dialog.
const manifest = JSON.parse(readFileSync("slack/app-manifest.json", "utf8"));

describe("slack/app-manifest.json", () => {
  it("keeps the redirect URL a placeholder for the deployment's OAuth callback", () => {
    expect(manifest.oauth_config.redirect_urls).toEqual(["<origin>/oauth/callback"]);
  });

  it("asks for user scopes only, so actions run as the connected user", () => {
    expect(manifest.oauth_config.scopes.bot).toBeUndefined();
    expect(manifest.features?.bot_user).toBeUndefined();
  });

  it.each([
    "search:read",
    "channels:read",
    "channels:history",
    "groups:read",
    "groups:history",
    "chat:write",
    "reactions:write",
  ])("includes the %s user scope the v0.1 Slack actions need", (scope) => {
    expect(manifest.oauth_config.scopes.user).toContain(scope);
  });

  it("is never deployed across an Enterprise org", () => {
    expect(manifest.settings.org_deploy_enabled).toBe(false);
  });

  it("issues non-expiring user tokens", () => {
    expect(manifest.settings.token_rotation_enabled).toBe(false);
  });
});

// Runs scripts/slack-manifest.ts as a user would, in a throwaway checkout so the saved-state lookup is exercised.
function runManifestScript(args: string[], state?: object) {
  const checkout = mkdtempSync(join(tmpdir(), "splitmind-slack-"));
  mkdirSync(join(checkout, "scripts"));
  mkdirSync(join(checkout, "slack"));
  copyFileSync("scripts/slack-manifest.ts", join(checkout, "scripts/slack-manifest.ts"));
  copyFileSync("slack/app-manifest.json", join(checkout, "slack/app-manifest.json"));
  if (state) writeFileSync(join(checkout, "splitmind.local.json"), JSON.stringify(state));
  return spawnSync(process.execPath, [join(checkout, "scripts/slack-manifest.ts"), ...args], { encoding: "utf8" });
}

describe("scripts/slack-manifest.ts", () => {
  it("fills in the redirect URL from the deployed origin, leaving the rest unchanged", () => {
    const result = runManifestScript([], { origin: "https://connector.example.com" });

    expect(result.status).toBe(0);
    const rendered = JSON.parse(result.stdout);
    expect(rendered.oauth_config.redirect_urls).toEqual(["https://connector.example.com/oauth/callback"]);
    expect({ ...rendered, oauth_config: { ...rendered.oauth_config, redirect_urls: [] } }).toEqual({
      ...manifest,
      oauth_config: { ...manifest.oauth_config, redirect_urls: [] },
    });
  });

  it("takes --origin over the saved state", () => {
    const result = runManifestScript(["--origin", "https://other.example.com"], { origin: "https://connector.example.com" });

    expect(JSON.parse(result.stdout).oauth_config.redirect_urls).toEqual(["https://other.example.com/oauth/callback"]);
  });

  it("refuses an origin with a path or trailing slash", () => {
    const result = runManifestScript(["--origin", "https://connector.example.com/"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("origin must be https://host with no path or trailing slash");
    expect(result.stdout).toBe("");
  });

  it("asks for an origin when nothing is deployed yet", () => {
    const result = runManifestScript([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pass --origin https://<host>, or deploy first");
  });
});
