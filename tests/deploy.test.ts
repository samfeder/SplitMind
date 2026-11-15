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
// What the probe file held when this call was made: shows whether the engine was patched before the account was touched.
if (process.env.FAKE_PROBE_FILE) {
  (state.probes = state.probes || []).push(fs.existsSync(process.env.FAKE_PROBE_FILE) ? fs.readFileSync(process.env.FAKE_PROBE_FILE, "utf8").trim() : "missing");
}
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

const GENERATE = `node -e "const fs=require('fs');fs.mkdirSync('catalog/apps',{recursive:true});for(const s of ['github','gmail','notion','slack','netlify','cloudflare_dns','cloudflare_worker','mail_watch'])fs.writeFileSync('catalog/apps/'+s+'.json','{}')"`;

interface FakeAccount {
  calls: string[];
  d1: { name: string; uuid: string }[];
  kv: { title: string; id: string }[];
  secrets: string[];
  secretValues: Record<string, string>;
  deployedOrigins: string[];
  probes?: string[];
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
  mkdirSync(join(checkout, "web/privacy"), { recursive: true });
  mkdirSync(join(checkout, "slack"), { recursive: true });
  for (const file of [
    "scripts/deploy.ts",
    "scripts/catalog-assets.ts",
    "wrangler.template.jsonc",
    "web/setup/index.html",
    "web/setup/setup.js",
    "web/privacy/index.html",
    "web/_headers",
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
    expect(rendered).toContain(
      '"OOMOL_CONNECT_ALLOWED_ACTIONS": "notion.*,slack.*,gmail.*,netlify.*,cloudflare_dns.*,cloudflare_worker.*,mail_watch.*"',
    );
    expect(rendered).toContain('"OOMOL_CONNECT_BLOCKED_ACTIONS": "gmail.update_vacation_settings,');
    // Only Claude's callbacks may finish MCP OAuth (#77).
    expect(rendered).toContain(
      '"OOMOL_CONNECT_MCP_OAUTH_ALLOWED_REDIRECT_URIS": "https://claude.ai/api/mcp/auth_callback,http://localhost/callback,http://127.0.0.1/callback"',
    );

    // Only the allowlisted providers reach the Worker's catalog assets.
    expect(JSON.parse(readFileSync(join(engine, "dist/web/catalog/index.json"), "utf8"))).toEqual({
      files: [
        "cloudflare_dns.json",
        "cloudflare_worker.json",
        "gmail.json",
        "mail_watch.json",
        "netlify.json",
        "notion.json",
        "slack.json",
      ],
    });
  });

  it("leaves the email watch off: neither variable is in the template or the rendered config (patch 0009)", () => {
    deploy();

    const rendered = readFileSync(join(engine, "wrangler.local.jsonc"), "utf8");
    const template = readFileSync(join(repo, "wrangler.template.jsonc"), "utf8");
    for (const name of ["OOMOL_CONNECT_EMAIL_WATCH_CONNECTIONS", "OOMOL_CONNECT_EMAIL_WATCH_INTERVAL_MINUTES"]) {
      expect(rendered).not.toContain(name);
      // Not even as a commented-out example: Sam names the connections and the chief approves, in a later change.
      expect(template).not.toContain(name);
    }
    expect(rendered).not.toContain("EMAIL_WATCH");
    // The Worker's cron already fires every minute; the watch rides on it and adds no second trigger.
    expect(rendered).toContain('"crons": ["* * * * *"]');
  });

  it("allows the mail_watch actions, or the list and acknowledge actions would be refused and left out of the catalog (patch 0009)", () => {
    deploy();

    const rendered = readFileSync(join(engine, "wrangler.local.jsonc"), "utf8");
    const allowed = rendered.match(/"OOMOL_CONNECT_ALLOWED_ACTIONS": "([^"]*)"/)![1]!.split(",");
    expect(allowed).toContain("mail_watch.*");
    // The watcher's own Gmail reads stay inside gmail.* and the blocked list does not name them.
    expect(allowed).toContain("gmail.*");
    const blocked = rendered.match(/"OOMOL_CONNECT_BLOCKED_ACTIONS": "([^"]*)"/)![1]!.split(",");
    for (const action of ["gmail.get_profile", "gmail.list_history", "gmail.fetch_message_by_message_id"]) {
      expect(blocked).not.toContain(action);
    }
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

  it("applies a new patch on top of stacked patches that no longer reverse one by one", () => {
    writeFileSync(join(engine, "greeting.txt"), "hello\n");
    writeFileSync(join(engine, "farewell.txt"), "bye\n");
    mkdirSync(join(checkout, "patches"));
    const edit = (file: string, from: string, to: string) =>
      [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");
    writeFileSync(join(checkout, "patches/0001-greeting.patch"), edit("greeting.txt", "hello", "hello, patched"));
    writeFileSync(
      join(checkout, "patches/0002-greeting-again.patch"),
      edit("greeting.txt", "hello, patched", "hello, patched twice"),
    );
    deploy();
    writeFileSync(join(checkout, "patches/0003-farewell.patch"), edit("farewell.txt", "bye", "bye, patched"));

    const result = deploy();

    expect(result.stderr).not.toContain("does not apply");
    expect(result.stdout).toContain("applied: patches/0003-farewell.patch");
    expect(result.stdout).not.toContain("applied: patches/0001-greeting.patch");
    expect(readFileSync(join(engine, "greeting.txt"), "utf8")).toBe("hello, patched twice\n");
    expect(readFileSync(join(engine, "farewell.txt"), "utf8")).toBe("bye, patched\n");
  });

  describe("patches missing from the middle of the stack, or with repeated context", () => {
    const edit = (file: string, from: string, to: string) =>
      [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");
    const reset = "git -C vendor/open-connector checkout -- . && git -C vendor/open-connector clean -fd";
    const deployed = () => readAccount().calls.some((call) => call.startsWith("deploy"));

    it("stops before building, naming the patch and the recovery steps, when 0002 is missing but 0001 and 0003 are on", () => {
      // Engine as it would be with 0001 and 0003 applied by hand and 0002 left out.
      writeFileSync(join(engine, "a.txt"), "a.txt one\n");
      writeFileSync(join(engine, "b.txt"), "b.txt original\n");
      writeFileSync(join(engine, "c.txt"), "c.txt three\n");
      mkdirSync(join(checkout, "patches"));
      writeFileSync(join(checkout, "patches/0001-a.patch"), edit("a.txt", "a.txt original", "a.txt one"));
      writeFileSync(join(checkout, "patches/0002-b.patch"), edit("b.txt", "b.txt original", "b.txt two"));
      writeFileSync(join(checkout, "patches/0003-c.patch"), edit("c.txt", "c.txt original", "c.txt three"));

      const result = deploy();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("0002-b.patch");
      expect(result.stderr).toContain(reset);
      expect(result.stderr).toMatch(/bootstrap[^\n]*again|again[^\n]*bootstrap/i);
      expect(result.stdout).not.toMatch(/^\s*applied: patches\/0002/m);
      expect(readFileSync(join(engine, "b.txt"), "utf8")).toBe("b.txt original\n");
      expect(deployed()).toBe(false);
    });

    it("treats a patch as applied when its context also appears elsewhere in the file, and goes on to deploy", () => {
      writeFileSync(join(engine, "rep.txt"), "a\nb\nc\nd\ne\nf\na\nb\nc\nd\ne\nf\n");
      mkdirSync(join(checkout, "patches"));
      writeFileSync(
        join(checkout, "patches/0001-rep.patch"),
        ["diff --git a/rep.txt b/rep.txt", "--- a/rep.txt", "+++ b/rep.txt", "@@ -7,6 +7,7 @@", " a", " b", " c", "+X", " d", " e", " f", ""].join("\n"),
      );
      writeFileSync(
        join(checkout, "patches/0002-new.patch"),
        ["diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+new file", ""].join("\n"),
      );
      const first = deploy();
      expect(first.stdout).toMatch(/^\s*applied: patches\/0001-rep\.patch/m);
      expect(first.stdout).toMatch(/^\s*applied: patches\/0002-new\.patch/m);
      setAccount({ ...readAccount(), calls: [], deployedOrigins: [] });

      const second = deploy();

      expect(second.stderr).not.toContain("not applied");
      expect(second.stderr).not.toContain("does not apply");
      expect(second.stdout).not.toMatch(/^\s*applied: /m);
      expect(readFileSync(join(engine, "rep.txt"), "utf8")).toBe("a\nb\nc\nd\ne\nf\na\nb\nc\nX\nd\ne\nf\n");
      expect(deployed()).toBe(true);
    });
  });

  it("says to run bootstrap when wrangler is not installed", () => {
    const result = deployWith({ SPLITMIND_WRANGLER: join(engine, "node_modules/.bin/wrangler") });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not start wrangler");
    expect(result.stderr).toContain("run scripts/bootstrap.sh first");
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

  describe("patches and the engine check come before anything touches the Cloudflare account", () => {
    const edit = (file: string, from: string, to: string) =>
      [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");
    const reset = "git -C vendor/open-connector checkout -- . && git -C vendor/open-connector clean -fd";
    const patchesDir = () => {
      mkdirSync(join(checkout, "patches"), { recursive: true });
      return join(checkout, "patches");
    };
    // An engine with greeting.txt that patch 0001 can no longer be applied to.
    const stalePatch = () => {
      writeFileSync(join(engine, "greeting.txt"), "something else\n");
      writeFileSync(join(patchesDir(), "0001-greeting.patch"), edit("greeting.txt", "hello", "hello, patched"));
    };
    const untouched = (result: { stdout: string }) => {
      expect(readAccount().calls).toEqual([]);
      expect(existsSync(join(checkout, "splitmind.local.json"))).toBe(false);
      expect(existsSync(join(engine, "wrangler.local.jsonc"))).toBe(false);
      expect(result.stdout).not.toContain("==> Checking Cloudflare login");
      expect(result.stdout).not.toContain("==> Cloudflare resources");
      expect(result.stdout).not.toContain("==> Applying D1 migrations");
    };

    it("a patch that does not apply: exit 1, the existing message, and no wrangler call, no saved state, no rendered config", () => {
      stalePatch();

      const result = deploy();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("patches/0001-greeting.patch does not apply to vendor/open-connector");
      untouched(result);
    });

    it("a later patch that does not apply, after an earlier one applied: still no wrangler call", () => {
      writeFileSync(join(engine, "greeting.txt"), "hello\n");
      writeFileSync(join(engine, "farewell.txt"), "something else\n");
      writeFileSync(join(patchesDir(), "0001-greeting.patch"), edit("greeting.txt", "hello", "hello, patched"));
      writeFileSync(join(patchesDir(), "0002-farewell.patch"), edit("farewell.txt", "bye", "bye, patched"));

      const result = deploy();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("patches/0002-farewell.patch does not apply to vendor/open-connector");
      untouched(result);
    });

    it("a missing middle patch (0001 and 0003 on, 0002 not): exit 1 with the recovery message and no wrangler call", () => {
      writeFileSync(join(engine, "a.txt"), "a.txt one\n");
      writeFileSync(join(engine, "b.txt"), "b.txt original\n");
      writeFileSync(join(engine, "c.txt"), "c.txt three\n");
      writeFileSync(join(patchesDir(), "0001-a.patch"), edit("a.txt", "a.txt original", "a.txt one"));
      writeFileSync(join(patchesDir(), "0002-b.patch"), edit("b.txt", "b.txt original", "b.txt two"));
      writeFileSync(join(patchesDir(), "0003-c.patch"), edit("c.txt", "c.txt original", "c.txt three"));

      const result = deploy();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("patches/0002-b.patch is not applied, but a later patch is");
      expect(result.stderr).toContain(reset);
      expect(result.stderr).toMatch(/bootstrap[^\n]*again|again[^\n]*bootstrap/i);
      expect(readFileSync(join(engine, "b.txt"), "utf8")).toBe("b.txt original\n");
      untouched(result);
    });

    it("an engine with no node_modules: exit 1 with the existing message and no wrangler call", () => {
      rmSync(join(engine, "node_modules"), { recursive: true });

      const result = deploy();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("vendor/open-connector has no node_modules; run scripts/bootstrap.sh first");
      untouched(result);
    });

    it("a re-run with a new patch that does not apply leaves the account and the saved state alone", () => {
      deploy();
      const savedBefore = readFileSync(join(checkout, "splitmind.local.json"), "utf8");
      setAccount({ ...readAccount(), calls: [], deployedOrigins: [] });
      stalePatch();

      const result = deploy();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("patches/0001-greeting.patch does not apply to vendor/open-connector");
      expect(readAccount().calls).toEqual([]);
      expect(readFileSync(join(checkout, "splitmind.local.json"), "utf8")).toBe(savedBefore);
    });

    it("--dry-run with a patch that does not apply: exit 1, the existing message, no wrangler call", () => {
      stalePatch();

      const result = deploy("--dry-run");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("patches/0001-greeting.patch does not apply to vendor/open-connector");
      expect(readAccount().calls).toEqual([]);
      expect(result.stdout).not.toContain("==> Building");
    });

    it("--dry-run with a missing middle patch or no node_modules: exit 1, no wrangler call, no build", () => {
      writeFileSync(join(engine, "a.txt"), "a.txt one\n");
      writeFileSync(join(engine, "b.txt"), "b.txt original\n");
      writeFileSync(join(engine, "c.txt"), "c.txt three\n");
      writeFileSync(join(patchesDir(), "0001-a.patch"), edit("a.txt", "a.txt original", "a.txt one"));
      writeFileSync(join(patchesDir(), "0002-b.patch"), edit("b.txt", "b.txt original", "b.txt two"));
      writeFileSync(join(patchesDir(), "0003-c.patch"), edit("c.txt", "c.txt original", "c.txt three"));
      const middle = deploy("--dry-run");
      expect(middle.status).toBe(1);
      expect(middle.stderr).toContain(reset);
      expect(middle.stdout).not.toContain("==> Building");

      rmSync(join(engine, "node_modules"), { recursive: true });
      const bare = deploy("--dry-run");
      expect(bare.status).toBe(1);
      expect(bare.stderr).toContain("vendor/open-connector has no node_modules; run scripts/bootstrap.sh first");
      expect(bare.stdout).not.toContain("==> Building");
      expect(readAccount().calls).toEqual([]);
    });

    it("--dry-run applies each patch once, then builds, and calls only wrangler deploy --dry-run", () => {
      writeFileSync(join(engine, "greeting.txt"), "hello\n");
      writeFileSync(join(patchesDir(), "0001-greeting.patch"), edit("greeting.txt", "hello", "hello, patched"));

      const result = deploy("--dry-run");

      expect(result.status).toBe(0);
      expect(result.stdout.match(/^\s*applied: patches\/0001-greeting\.patch$/gm)).toHaveLength(1);
      expect(result.stdout.match(/^==> Patches$/gm)).toHaveLength(1);
      expect(result.stdout.indexOf("==> Patches")).toBeLessThan(result.stdout.indexOf("==> Building"));
      expect(result.stdout.indexOf("applied: patches/0001-greeting.patch")).toBeLessThan(result.stdout.indexOf("==> Building"));
      expect(readFileSync(join(engine, "greeting.txt"), "utf8")).toBe("hello, patched\n");
      const calls = readAccount().calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^deploy .*--dry-run/);
    });

    it("--render-only needs no patches, no node_modules and no wrangler call", () => {
      deploy();
      rmSync(join(engine, "node_modules"), { recursive: true });
      stalePatch();
      setAccount({ ...readAccount(), calls: [] });

      const result = deploy("--render-only");

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("==> Patches");
      expect(readAccount().calls).toEqual([]);
    });

    it("happy path: patches are on disk at the first wrangler call and applied once; then login, resources, migrations, build, deploy", () => {
      writeFileSync(join(engine, "greeting.txt"), "hello\n");
      writeFileSync(join(patchesDir(), "0001-greeting.patch"), edit("greeting.txt", "hello", "hello, patched"));

      const result = deployWith({ FAKE_PROBE_FILE: join(engine, "greeting.txt") });

      const out = result.stdout;
      expect(result.stdout.match(/^\s*applied: patches\/0001-greeting\.patch$/gm)).toHaveLength(1);
      expect(out.match(/^==> Patches$/gm)).toHaveLength(1);
      const order = [
        "==> Patches",
        "applied: patches/0001-greeting.patch",
        "==> Checking Cloudflare login",
        "==> Cloudflare resources",
        "==> Applying D1 migrations",
        "==> Building",
        "==> Deploying",
      ].map((marker) => ({ marker, at: out.indexOf(marker) }));
      for (const { marker, at } of order) expect(at, `${marker} is in the output`).toBeGreaterThanOrEqual(0);
      const positions = order.map((entry) => entry.at);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));

      const state = readAccount();
      expect(state.calls[0]).toBe("whoami");
      const indexOf = (prefix: string) => state.calls.findIndex((call) => call.startsWith(prefix));
      const sequence = [indexOf("whoami"), indexOf("d1 list"), indexOf("kv namespace list"), indexOf("d1 migrations apply"), indexOf("deploy")];
      expect(sequence.every((index) => index >= 0)).toBe(true);
      expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
      // Every wrangler call, the very first included, saw the patched file.
      expect(state.probes).toHaveLength(state.calls.length);
      expect(new Set(state.probes)).toEqual(new Set(["hello, patched"]));
    });
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
