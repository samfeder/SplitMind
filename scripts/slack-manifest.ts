// Prints slack/app-manifest.json with <origin> filled in, ready to paste into Slack's "Create New App → From a
// manifest" dialog. Nothing is written to disk, so the filled-in copy never lands in the repo.
//
// Usage: node scripts/slack-manifest.ts [--origin <url>]
//   --origin  Worker origin (default: the one saved in splitmind.local.json by scripts/deploy.ts).
// On a Mac: npm run -s slack-manifest | pbcopy
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");

export function renderSlackManifest(manifest: string, origin: string): string {
  if (!/^https:\/\/[^/\s]+$/.test(origin)) throw new Error("origin must be https://host with no path or trailing slash");
  if (!manifest.includes("<origin>")) throw new Error("manifest has no <origin> placeholder");
  return manifest.replaceAll("<origin>", origin);
}

function main(): number {
  const { values } = parseArgs({ options: { origin: { type: "string" } } });
  let origin = values.origin;
  if (!origin) {
    const statePath = join(root, "splitmind.local.json");
    origin = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { origin?: string }).origin : undefined;
  }
  if (!origin) {
    console.error("slack-manifest: pass --origin https://<host>, or deploy first so splitmind.local.json has one");
    return 2;
  }
  try {
    process.stdout.write(renderSlackManifest(readFileSync(join(root, "slack/app-manifest.json"), "utf8"), origin));
    return 0;
  } catch (error) {
    console.error(`slack-manifest: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = main();
