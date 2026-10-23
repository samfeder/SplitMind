import { readFileSync } from "node:fs";
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
