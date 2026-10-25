import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the real scripts/deploy.ts in a throwaway checkout. Cloudflare is replaced by a stand-in `wrangler` that
// keeps a fake account in a JSON file, and the engine by a stand-in whose build steps write a tiny catalog.

const repo = resolve(import.meta.dirname, "..");

const FAKE_WRANGLER = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const file = process.env.FAKE_CF_STATE;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args.join(" "));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const key = args.slice(0, 3).join(" ");
if (args[0] === "whoami") {
  console.log("You are logged in.");
} else if (key === "d1 list --json") {
  console.log(JSON.stringify(state.d1));
} else if (args[0] === "d1" && args[1] === "create") {
  state.d1.push({ name: args[2], uuid: "d1-id-" + state.d1.length });
} else if (key === "kv namespace list") {
  console.log("warning: some banner first");
  console.log(JSON.stringify(state.kv));
} else if (key === "kv namespace create") {
  state.kv.push({ title: args[3], id: "kv-id-" + state.kv.length });
} else if (args[0] === "d1" && args[1] === "migrations") {
} else if (args[0] === "deploy") {
  const config = fs.readFileSync(path.join(process.cwd(), "wrangler.local.jsonc"), "utf8");
  state.deployedOrigins.push(JSON.parse(config.match(/"OOMOL_CONNECT_ORIGIN": ("[^"]*")/)[1]));
  fs.mkdirSync(path.dirname(process.env.WRANGLER_OUTPUT_FILE_PATH), { recursive: true });
  fs.writeFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: "wrangler-session" }) + "\\n" +
    JSON.stringify({ type: "deploy", targets: ["https://splitmind.fake-subdomain.workers.dev"], bundle_size: { raw_bytes: 2097152, gzip_bytes: 1048576 } }) + "\\n");
} else if (key === "secret list --config") {
  console.log(JSON.stringify(state.secrets.map((name) => ({ name, type: "secret_text" }))));
} else if (args[0] === "secret" && args[1] === "put") {
  state.secrets.push(args[2]);
  state.secretValues[args[2]] = fs.readFileSync(0, "utf8");
} else {
  console.error("fake wrangler: unexpected " + args.join(" "));
  process.exit(9);
}
save();
`;

const FAKE_COPY_CATALOG = `import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function copyCatalogAssets({ sourceDir, targetDir }) {
  const files = (await readdir(sourceDir)).sort();
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, "index.json"), JSON.stringify({ files }));
  return { providerCount: files.length, chunks: ["apps-0000.json"] };
}
`;

const GENERATE = `node -e "const fs=require('fs');fs.mkdirSync('catalog/apps',{recursive:true});for(const s of ['github','gmail','notion','slack'])fs.writeFileSync('catalog/apps/'+s+'.json','{}')"`;

interface FakeAccount {
  calls: string[];
  d1: { name: string; uuid: string }[];
  kv: { title: string; id: string }[];
  secrets: string[];
  secretValues: Record<string, string>;
  deployedOrigins: string[];
}

let dir: string;
let checkout: string;
let engine: string;
let account: string;
let wrangler: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "splitmind-deploy-"));
  checkout = join(dir, "checkout");
  engine = join(checkout, "vendor/open-connector");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  mkdirSync(join(engine, "scripts"), { recursive: true });
  mkdirSync(join(engine, "node_modules"), { recursive: true });
  mkdirSync(join(checkout, "web/setup"), { recursive: true });
  mkdirSync(join(checkout, "slack"), { recursive: true });
  for (const file of [
    "scripts/deploy.ts",
    "scripts/catalog-assets.ts",
    "wrangler.template.jsonc",
    "web/setup/index.html",
    "web/setup/setup.js",
    "slack/app-manifest.json",
  ]) {
    copyFileSync(join(repo, file), join(checkout, file));
  }
  writeFileSync(join(engine, "scripts/copy-catalog-assets.ts"), FAKE_COPY_CATALOG);
  writeFileSync(
    join(engine, "package.json"),
    JSON.stringify({ type: "module", scripts: { "generate:catalog": GENERATE, "build:web": "node -e \"\"" } }),
  );

  wrangler = join(dir, "wrangler");
  writeFileSync(wrangler, FAKE_WRANGLER);
  chmodSync(wrangler, 0o755);
  account = join(dir, "account.json");
  setAccount({ calls: [], d1: [], kv: [], secrets: [], secretValues: {}, deployedOrigins: [] });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setAccount(value: FakeAccount): void {
  writeFileSync(account, JSON.stringify(value));
}

function readAccount(): FakeAccount {
  return JSON.parse(readFileSync(account, "utf8")) as FakeAccount;
}

function deployWith(env: NodeJS.ProcessEnv, ...args: string[]) {
  // Secrets in the outer environment (e.g. a cloud session set up to deploy) must not leak into these runs.
  const { SPLITMIND_ADMIN_TOKEN: _admin, SPLITMIND_ENCRYPTION_KEY: _key, ...outer } = process.env;
  return spawnSync(process.execPath, [join(checkout, "scripts/deploy.ts"), ...args], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...outer, SPLITMIND_WRANGLER: wrangler, FAKE_CF_STATE: account, ...env },
  });
}

function deploy(...args: string[]) {
  return deployWith({}, ...args);
}

// Built at runtime so secret scanners don't flag test fixtures.
const encryptionKey = Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)).toString("base64");
const adminToken = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 7)).toString("base64");

// Each test runs the script and its npm build steps as real processes, which is slow on a loaded machine.
describe("scripts/deploy.ts", { timeout: 30_000 }, () => {
  it("creates the resources, learns the workers.dev origin, redeploys with it, then stops for secrets", () => {
    const result = deploy();

    expect(result.status).toBe(1);
    const state = readAccount();
    expect(state.d1).toEqual([{ name: "splitmind-db", uuid: "d1-id-0" }]);
    expect(state.kv).toEqual([
      { title: "splitmind-transit-files", id: "kv-id-0" },
      { title: "splitmind-oauth", id: "kv-id-1" },
    ]);
    expect(state.calls).toContain("d1 migrations apply splitmind-db --remote --config wrangler.local.jsonc");
    // First pass has no origin (the Worker answers 503 until it has one); the second pass has the printed URL.
    expect(state.deployedOrigins).toEqual(["", "https://splitmind.fake-subdomain.workers.dev"]);
    expect(result.stdout).toContain("bundle: 2.00 MiB (gzip 1.00 MiB)");
    expect(result.stderr).toContain(
      "secrets not set: OOMOL_CONNECT_ADMIN_TOKEN, OOMOL_CONNECT_ENCRYPTION_KEY",
    );
    expect(result.stderr).toContain(
      "(cd vendor/open-connector && npx wrangler secret put OOMOL_CONNECT_ENCRYPTION_KEY --config wrangler.local.jsonc)",
    );
    expect(state.calls.some((call) => call.startsWith("secret put"))).toBe(false);

    const rendered = readFileSync(join(engine, "wrangler.local.jsonc"), "utf8");
    expect(rendered).toContain('"database_id": "d1-id-0"');
    expect(rendered).toContain('{ "binding": "TRANSIT_FILES", "id": "kv-id-0" }');
    expect(rendered).toContain('{ "binding": "OAUTH_KV", "id": "kv-id-1" }');
    expect(rendered).toContain('"OOMOL_CONNECT_ORIGIN": "https://splitmind.fake-subdomain.workers.dev"');
    expect(rendered).not.toMatch(/"<[a-z0-9-]+>"/);
    // The engine's sourcemap is over Cloudflare's 60 MiB cap; uploading it fails the deploy.
    expect(rendered).toContain('"upload_source_maps": false');
    // gmail.* is allowed, but not the mailbox-settings writes.
    expect(rendered).toContain('"OOMOL_CONNECT_ALLOWED_ACTIONS": "notion.*,slack.*,gmail.*"');
    expect(rendered).toContain('"OOMOL_CONNECT_BLOCKED_ACTIONS": "gmail.update_vacation_settings,');

    // Only the allowlisted providers reach the Worker's catalog assets.
    expect(JSON.parse(readFileSync(join(engine, "dist/web/catalog/index.json"), "utf8"))).toEqual({
      files: ["gmail.json", "notion.json", "slack.json"],
    });
  });

  it("sets missing secrets from the environment without printing them", () => {
    const result = deployWith({ SPLITMIND_ADMIN_TOKEN: adminToken, SPLITMIND_ENCRYPTION_KEY: encryptionKey });

    const state = readAccount();
    expect(state.secretValues).toEqual({
      OOMOL_CONNECT_ADMIN_TOKEN: adminToken,
      OOMOL_CONNECT_ENCRYPTION_KEY: encryptionKey,
    });
    expect(result.stdout).toContain("OOMOL_CONNECT_ADMIN_TOKEN: set from SPLITMIND_ADMIN_TOKEN");
    expect(result.stdout).toContain("OOMOL_CONNECT_ENCRYPTION_KEY: set from SPLITMIND_ENCRYPTION_KEY");
    expect(result.stderr).not.toContain("secrets not set");
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(adminToken);
      expect(output).not.toContain(encryptionKey);
    }
  });

  it("refuses an encryption key that is not 32 base64 bytes, without echoing it", () => {
    const shortKey = Buffer.from("sixteen byte key").toString("base64");

    const result = deployWith({ SPLITMIND_ADMIN_TOKEN: adminToken, SPLITMIND_ENCRYPTION_KEY: shortKey });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SPLITMIND_ENCRYPTION_KEY must be exactly 32 bytes in base64");
    expect(result.stderr).not.toContain(shortKey);
    expect(readAccount().secrets).toEqual([]);
  });

  it("reuses everything on a re-run and deploys once", () => {
    deploy();
    const before = readAccount();
    setAccount({ ...before, calls: [], deployedOrigins: [] });

    const result = deploy();

    const state = readAccount();
    expect(result.stdout).toContain("D1 splitmind-db: exists");
    expect(result.stdout).toContain("KV splitmind-oauth: exists");
    expect(state.calls.filter((call) => call.includes("create"))).toEqual([]);
    expect(state.d1).toHaveLength(1);
    expect(state.kv).toHaveLength(2);
    expect(state.deployedOrigins).toEqual(["https://splitmind.fake-subdomain.workers.dev"]);
  });

  it("applies a patch the engine doesn't have yet, once, before building", () => {
    writeFileSync(join(engine, "greeting.txt"), "hello\n");
    mkdirSync(join(checkout, "patches"));
    writeFileSync(
      join(checkout, "patches/0001-greeting.patch"),
      ["--- a/greeting.txt", "+++ b/greeting.txt", "@@ -1 +1 @@", "-hello", "+hello, patched", ""].join("\n"),
    );

    const first = deploy();
    const second = deploy();

    expect(readFileSync(join(engine, "greeting.txt"), "utf8")).toBe("hello, patched\n");
    expect(first.stdout).toContain("applied: patches/0001-greeting.patch");
    expect(second.stdout).not.toContain("applied: patches/0001-greeting.patch");
  });

  it("stops before building when a patch no longer fits the engine", () => {
    writeFileSync(join(engine, "greeting.txt"), "something else\n");
    mkdirSync(join(checkout, "patches"));
    writeFileSync(
      join(checkout, "patches/0001-greeting.patch"),
      ["--- a/greeting.txt", "+++ b/greeting.txt", "@@ -1 +1 @@", "-hello", "+hello, patched", ""].join("\n"),
    );

    const result = deploy();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("patches/0001-greeting.patch does not apply to vendor/open-connector");
    expect(readAccount().calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("keeps the saved state out of git", () => {
    deploy();

    const saved = JSON.parse(readFileSync(join(checkout, "splitmind.local.json"), "utf8")) as { origin: string };
    expect(saved.origin).toBe("https://splitmind.fake-subdomain.workers.dev");
    const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", "splitmind.local.json"], { cwd: repo });
    expect(ignored.status).toBe(0);
  });

  it("refuses an origin with a path", () => {
    const result = deploy("--origin", "https://connector.example.com/mcp");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--origin must be https://host with no path or trailing slash");
    expect(existsSync(join(checkout, "splitmind.local.json"))).toBe(false);
    expect(readAccount().calls).toEqual([]);
  });

  it("will not reuse state saved for a different Worker name", () => {
    deploy();

    const result = deploy("--name", "splitmind-dry-run");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('splitmind.local.json is for Worker "splitmind"');
  });
});
