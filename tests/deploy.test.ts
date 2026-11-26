import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { staleDependencies, staleDependenciesMessage } from "../scripts/deploy.ts";
import { commitSuperproject, git, initFixtureRepo } from "./git-fixture.ts";

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
// The commit the fixture's superproject pins for the engine (#83).
let engineGitlink: string;

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
    ".gitignore",
  ]) {
    copyFileSync(join(repo, file), join(checkout, file));
  }
  writeFileSync(join(engine, "scripts/copy-catalog-assets.ts"), FAKE_COPY_CATALOG);
  writeFileSync(
    join(engine, "package.json"),
    JSON.stringify({ type: "module", version: "1.9.2", scripts: { "generate:catalog": GENERATE, "build:web": "node -e \"\"" } }),
  );

  // A real repo, as a checkout is: the engine is its own repo recorded as a gitlink, and everything else is committed.
  // deploy.ts refuses to deploy a dirty tree (#83), so deployWith commits whatever a test wrote before it runs.
  ({ gitlink: engineGitlink } = initFixtureRepo(checkout));

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

function runDeploy(env: NodeJS.ProcessEnv, args: string[]) {
  // Secrets in the outer environment (e.g. a cloud session set up to deploy) must not leak into these runs.
  const { SPLITMIND_ADMIN_TOKEN: _admin, SPLITMIND_ENCRYPTION_KEY: _key, ...outer } = process.env;
  return spawnSync(process.execPath, [join(checkout, "scripts/deploy.ts"), ...args], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...outer, SPLITMIND_WRANGLER: wrangler, FAKE_CF_STATE: account, ...env },
  });
}

// Most tests are not about cleanliness: whatever they wrote into the checkout (patches, notes) is committed first, so
// the tree is clean when the script runs. Changes inside vendor/open-connector never count, so those stay as written.
function deployWith(env: NodeJS.ProcessEnv, ...args: string[]) {
  if (existsSync(join(checkout, ".git"))) commitSuperproject(checkout, "test setup");
  return runDeploy(env, args);
}

// Runs the script on the tree exactly as the test left it, dirty or not.
function deployAsIs(env: NodeJS.ProcessEnv, ...args: string[]) {
  return runDeploy(env, args);
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

  it("renders the anonymous-write budget: Durable Object binding, SQLite migration and both daily limits (#78)", () => {
    deploy();
    const rendered = parseJsonc(readFileSync(join(engine, "wrangler.local.jsonc"), "utf8"));

    expect(rendered.durable_objects).toEqual({
      bindings: [{ name: "MCP_OAUTH_ANONYMOUS_WRITES", class_name: "McpOAuthAnonymousWriteBudget" }],
    });
    // new_sqlite_classes, not new_classes: the key-value-backed kind is not available on Workers Free.
    expect(rendered.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["McpOAuthAnonymousWriteBudget"] }]);
    const vars = rendered.vars as Record<string, unknown>;
    expect(vars.OOMOL_CONNECT_MCP_OAUTH_MAX_ANONYMOUS_WRITES_PER_DAY).toBe("100");
    expect(vars.OOMOL_CONNECT_MCP_OAUTH_MAX_ANONYMOUS_WRITES_PER_IP_PER_DAY).toBe("20");
    // The class lives in the Worker's main module, so the binding needs no script_name.
    expect(rendered.main).toBe("src/server/cloudflare.ts");
    expect(JSON.stringify(rendered.durable_objects)).not.toContain("script_name");
    // Nothing is left over from the registration-only cap this replaced.
    expect(JSON.stringify(rendered)).not.toContain("REGISTRATION");
    expect(JSON.stringify(rendered)).not.toContain("McpOAuthRegistrationCounter");
  });

  it("renders the same budget config when the deploy runs again", () => {
    deploy();
    const first = parseJsonc(readFileSync(join(engine, "wrangler.local.jsonc"), "utf8"));
    deploy();
    const second = parseJsonc(readFileSync(join(engine, "wrangler.local.jsonc"), "utf8"));
    expect(second.durable_objects).toEqual(first.durable_objects);
    expect(second.migrations).toEqual(first.migrations);
    expect(second.migrations).toHaveLength(1);
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

    describe("stale vendor dependencies (#150)", () => {
      // The engine's manifests are what patches change; node_modules is what bootstrap installs.
      const lock = (versions: Record<string, string>) =>
        writeFileSync(
          join(engine, "package-lock.json"),
          JSON.stringify({
            lockfileVersion: 3,
            packages: { "": {}, ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])) },
          }),
        );
      const manifest = (dependencies: Record<string, string>) =>
        writeFileSync(
          join(engine, "package.json"),
          JSON.stringify({ type: "module", dependencies, scripts: { "generate:catalog": GENERATE, "build:web": 'node -e ""' } }),
        );
      const install = (name: string, version: string) => {
        mkdirSync(join(engine, "node_modules", name), { recursive: true });
        writeFileSync(join(engine, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
      };
      const message = "vendor/open-connector dependencies are out of date (graphql); run scripts/bootstrap.sh, then deploy again";

      it("a locked dependency that is not installed: exit 1 with the message and no wrangler call, no saved state, no rendered config", () => {
        manifest({ graphql: "^16.0.0" });
        lock({ graphql: "16.9.0" });

        const result = deploy();

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        untouched(result);
      });

      it("--dry-run stops the same way, before the build", () => {
        manifest({ graphql: "^16.0.0" });
        lock({ graphql: "16.9.0" });

        const result = deploy("--dry-run");

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        expect(readAccount().calls).toEqual([]);
        expect(result.stdout).not.toContain("==> Building");
      });

      it("an installed version that differs from the lockfile also stops the deploy", () => {
        manifest({ graphql: "^16.0.0" });
        lock({ graphql: "16.9.0" });
        install("graphql", "16.8.0");

        const result = deploy();

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        untouched(result);
      });

      it("a re-run after a pulled patch added a dependency leaves the account and the saved state alone", () => {
        deploy();
        const savedBefore = readFileSync(join(checkout, "splitmind.local.json"), "utf8");
        setAccount({ ...readAccount(), calls: [], deployedOrigins: [] });
        manifest({ graphql: "^16.0.0" });
        lock({ graphql: "16.9.0" });

        const result = deploy();

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        expect(readAccount().calls).toEqual([]);
        expect(readFileSync(join(checkout, "splitmind.local.json"), "utf8")).toBe(savedBefore);
      });

      it("checks after the patches apply: a patch that adds a dependency to the manifests is what makes it stale", () => {
        // Build the patch with git itself, from a scratch repo holding the manifests before and after.
        const scratch = join(dir, "scratch");
        mkdirSync(scratch);
        const git = (...args: string[]) =>
          spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: scratch, encoding: "utf8" });
        const write = (dependencies: Record<string, string>, packages: Record<string, { version: string }>) => {
          writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "engine", dependencies }, null, 2) + "\n");
          writeFileSync(
            join(scratch, "package-lock.json"),
            JSON.stringify({ name: "engine", lockfileVersion: 3, packages: { "": { name: "engine", dependencies }, ...packages } }, null, 2) + "\n",
          );
        };
        git("init", "-q");
        write({}, {});
        git("add", "-A");
        git("commit", "-q", "-m", "before");
        // The engine starts exactly as the scratch repo did, with the dependency list empty and nothing missing.
        copyFileSync(join(scratch, "package.json"), join(engine, "package.json"));
        copyFileSync(join(scratch, "package-lock.json"), join(engine, "package-lock.json"));
        write({ graphql: "^16.0.0" }, { "node_modules/graphql": { version: "16.9.0" } });
        const patch = git("diff").stdout;
        expect(patch).toContain("graphql");
        writeFileSync(join(patchesDir(), "0001-graphql.patch"), patch);

        const result = deploy();

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        expect(readFileSync(join(engine, "package.json"), "utf8")).toContain("graphql");
        untouched(result);
      });

      it("everything installed at the locked versions deploys as before", () => {
        manifest({ graphql: "^16.0.0" });
        lock({ graphql: "16.9.0" });
        install("graphql", "16.9.0");

        const result = deploy();

        expect(result.stderr).not.toContain("dependencies are out of date");
        expect(readAccount().calls).toContain("whoami");
      });
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

    it("--dry-run stays offline: the only wrangler call is deploy --dry-run, with no whoami, d1, kv or secret call (#161)", () => {
      const result = deploy("--dry-run");

      expect(result.status).toBe(0);
      const calls = readAccount().calls;
      const offending = calls.filter((call) => !/^deploy( |$)/.test(call) || !call.split(" ").includes("--dry-run"));
      expect(offending).toEqual([]);
      expect(calls).toHaveLength(1);
      for (const online of ["whoami", "d1 ", "kv ", "secret "]) {
        expect(calls.some((call) => call.startsWith(online))).toBe(false);
      }
      expect(result.stdout).not.toContain("==> Checking Cloudflare login");
      expect(result.stdout).not.toContain("==> Cloudflare resources");
      expect(existsSync(join(checkout, "splitmind.local.json"))).toBe(false);
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

describe("staleDependencies (#150)", () => {
  let engineDir: string;

  beforeEach(() => {
    engineDir = mkdtempSync(join(tmpdir(), "splitmind-stale-deps-"));
  });
  afterEach(() => {
    rmSync(engineDir, { recursive: true, force: true });
  });

  interface Manifest {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }
  const writeManifest = (manifest: Manifest) => writeFileSync(join(engineDir, "package.json"), JSON.stringify({ name: "engine", ...manifest }));
  const writeLock = (packages: Record<string, { version: string; optional?: boolean }>) =>
    writeFileSync(
      join(engineDir, "package-lock.json"),
      JSON.stringify({ name: "engine", lockfileVersion: 3, packages: { "": { name: "engine" }, ...packages } }),
    );
  const installed = (name: string, version: string) => {
    mkdirSync(join(engineDir, "node_modules", name), { recursive: true });
    writeFileSync(join(engineDir, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  };

  it("D1: returns [] when every direct dependency is installed at its lockfile version", () => {
    writeManifest({ dependencies: { hono: "^4.0.0", zod: "^3.0.0" } });
    writeLock({ "node_modules/hono": { version: "4.6.3" }, "node_modules/zod": { version: "3.23.8" } });
    installed("hono", "4.6.3");
    installed("zod", "3.23.8");

    expect(staleDependencies(engineDir)).toEqual([]);
  });

  it("D1: a transitive package that is not installed is not reported (only direct dependencies count)", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    writeLock({ "node_modules/hono": { version: "4.6.3" }, "node_modules/left-pad": { version: "1.3.0" } });
    installed("hono", "4.6.3");

    expect(staleDependencies(engineDir)).toEqual([]);
  });

  it("D2: a locked dependency that is not installed is reported by name", () => {
    writeManifest({ dependencies: { hono: "^4.0.0", graphql: "^16.0.0" } });
    writeLock({ "node_modules/hono": { version: "4.6.3" }, "node_modules/graphql": { version: "16.9.0" } });
    installed("hono", "4.6.3");

    expect(staleDependencies(engineDir)).toEqual(["graphql"]);
  });

  it("D2: a node_modules directory that does not exist at all reports every locked direct dependency", () => {
    writeManifest({ dependencies: { hono: "^4.0.0", graphql: "^16.0.0" } });
    writeLock({ "node_modules/hono": { version: "4.6.3" }, "node_modules/graphql": { version: "16.9.0" } });

    expect(staleDependencies(engineDir)).toEqual(["graphql", "hono"]);
  });

  it("D2: a package directory with no package.json counts as not installed", () => {
    writeManifest({ dependencies: { graphql: "^16.0.0" } });
    writeLock({ "node_modules/graphql": { version: "16.9.0" } });
    mkdirSync(join(engineDir, "node_modules/graphql"), { recursive: true });

    expect(staleDependencies(engineDir)).toEqual(["graphql"]);
  });

  it("D3: an installed version that differs from the lockfile is reported, older or newer", () => {
    writeManifest({ dependencies: { hono: "^4.0.0", zod: "^3.0.0", ok: "^1.0.0" } });
    writeLock({
      "node_modules/hono": { version: "4.6.3" },
      "node_modules/zod": { version: "3.23.8" },
      "node_modules/ok": { version: "1.0.0" },
    });
    installed("hono", "4.5.0");
    installed("zod", "3.24.0");
    installed("ok", "1.0.0");

    expect(staleDependencies(engineDir)).toEqual(["hono", "zod"]);
  });

  it("D3: versions are compared exactly, not by prefix", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    writeLock({ "node_modules/hono": { version: "4.6.3" } });
    installed("hono", "4.6.30");

    expect(staleDependencies(engineDir)).toEqual(["hono"]);
  });

  it("D4: a scoped dependency is looked up under node_modules/@scope/name", () => {
    writeManifest({ dependencies: { "@scope/x": "^1.0.0", "@scope/y": "^2.0.0" } });
    writeLock({ "node_modules/@scope/x": { version: "1.2.3" }, "node_modules/@scope/y": { version: "2.0.0" } });
    installed("@scope/x", "1.2.3");

    expect(staleDependencies(engineDir)).toEqual(["@scope/y"]);

    installed("@scope/y", "2.0.0");
    expect(staleDependencies(engineDir)).toEqual([]);

    installed("@scope/x", "1.0.0");
    expect(staleDependencies(engineDir)).toEqual(["@scope/x"]);
  });

  it("D5: an optional dependency that is not installed is not reported", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" }, optionalDependencies: { "@rollup/rollup-darwin-arm64": "^4.0.0" } });
    writeLock({
      "node_modules/hono": { version: "4.6.3" },
      "node_modules/@rollup/rollup-darwin-arm64": { version: "4.24.0", optional: true },
    });
    installed("hono", "4.6.3");

    expect(staleDependencies(engineDir)).toEqual([]);
  });

  it("D5: an optional dependency that is installed at a different version is still reported", () => {
    writeManifest({ optionalDependencies: { fsevents: "^2.0.0" } });
    writeLock({ "node_modules/fsevents": { version: "2.3.3", optional: true } });
    installed("fsevents", "2.3.0");

    expect(staleDependencies(engineDir)).toEqual(["fsevents"]);
  });

  it("D5: a missing dependency whose lockfile entry is not optional is reported even if another is optional", () => {
    writeManifest({ dependencies: { graphql: "^16.0.0" }, optionalDependencies: { fsevents: "^2.0.0" } });
    writeLock({ "node_modules/graphql": { version: "16.9.0" }, "node_modules/fsevents": { version: "2.3.3", optional: true } });

    expect(staleDependencies(engineDir)).toEqual(["graphql"]);
  });

  it("D5: a direct dependency with no lockfile entry is skipped", () => {
    writeManifest({ dependencies: { hono: "^4.0.0", unlocked: "^1.0.0" } });
    writeLock({ "node_modules/hono": { version: "4.6.3" } });
    installed("hono", "4.6.3");

    expect(staleDependencies(engineDir)).toEqual([]);
  });

  it("D6: no package-lock.json returns [] and does not block", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });

    expect(staleDependencies(engineDir)).toEqual([]);
  });

  it("D6: an unreadable package-lock.json (not JSON) returns []", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    writeFileSync(join(engineDir, "package-lock.json"), "{ not json");

    expect(staleDependencies(engineDir)).toEqual([]);
  });

  it("D6: a package-lock.json that is a directory (unreadable) returns []", () => {
    writeManifest({ dependencies: { hono: "^4.0.0" } });
    mkdirSync(join(engineDir, "package-lock.json"));

    expect(staleDependencies(engineDir)).toEqual([]);
  });

  it("D7: names come back sorted, whatever order the manifest and lockfile list them in", () => {
    writeManifest({ dependencies: { zeta: "^1.0.0", alpha: "^1.0.0", "@scope/mid": "^1.0.0", mu: "^1.0.0" } });
    writeLock({
      "node_modules/zeta": { version: "1.0.0" },
      "node_modules/alpha": { version: "1.0.0" },
      "node_modules/@scope/mid": { version: "1.0.0" },
      "node_modules/mu": { version: "1.0.0" },
    });

    const names = staleDependencies(engineDir);
    expect(names).toEqual(["@scope/mid", "alpha", "mu", "zeta"]);
    expect(names).toEqual([...names].sort());
  });

  it("D7: devDependencies are included, and a name in more than one group is reported once", () => {
    writeManifest({
      dependencies: { hono: "^4.0.0" },
      devDependencies: { vitest: "^2.0.0", hono: "^4.0.0" },
    });
    writeLock({ "node_modules/hono": { version: "4.6.3" }, "node_modules/vitest": { version: "2.1.0" } });
    installed("hono", "4.6.3");

    expect(staleDependencies(engineDir)).toEqual(["vitest"]);
  });

  it("D7: a stale dependency in each of the three groups is reported", () => {
    writeManifest({
      dependencies: { d: "^1.0.0" },
      devDependencies: { a: "^1.0.0" },
      optionalDependencies: { o: "^1.0.0" },
    });
    writeLock({ "node_modules/d": { version: "1.0.0" }, "node_modules/a": { version: "1.0.0" }, "node_modules/o": { version: "1.0.0" } });
    installed("o", "0.9.0");

    expect(staleDependencies(engineDir)).toEqual(["a", "d", "o"]);
  });

  describe("entries that are not registry installs (#158)", () => {
    const writeRawLock = (packages: Record<string, unknown>) =>
      writeFileSync(
        join(engineDir, "package-lock.json"),
        JSON.stringify({ name: "engine", lockfileVersion: 3, packages: { "": { name: "engine" }, ...packages } }),
      );

    it("R1: a link: dependency (lockfile entry has link: true and no version) is not reported, even though node_modules holds the target's version", () => {
      writeManifest({ dependencies: { "local-lib": "link:../local-lib", hono: "^4.0.0" } });
      writeRawLock({
        "node_modules/local-lib": { resolved: "../local-lib", link: true },
        "node_modules/hono": { version: "4.6.3" },
      });
      installed("local-lib", "0.0.1");
      installed("hono", "4.6.3");

      expect(staleDependencies(engineDir)).toEqual([]);
    });

    it("R1: an entry with link: true is skipped even if it carries a version that differs from the installed one", () => {
      writeManifest({ dependencies: { "local-lib": "file:../local-lib" } });
      writeRawLock({ "node_modules/local-lib": { resolved: "../local-lib", link: true, version: "9.9.9" } });
      installed("local-lib", "0.0.1");

      expect(staleDependencies(engineDir)).toEqual([]);
    });

    it("R1: a link: dependency that is not installed at all is not reported either", () => {
      writeManifest({ dependencies: { "local-lib": "link:../local-lib" } });
      writeRawLock({ "node_modules/local-lib": { resolved: "../local-lib", link: true } });

      expect(staleDependencies(engineDir)).toEqual([]);
    });

    it("R1: an entry with no version (and no link flag) is skipped", () => {
      writeManifest({ dependencies: { "ws-pkg": "workspace:*" } });
      writeRawLock({ "node_modules/ws-pkg": { resolved: "packages/ws-pkg" } });
      installed("ws-pkg", "1.0.0");

      expect(staleDependencies(engineDir)).toEqual([]);
    });

    it("R1: skipping link entries does not hide a genuinely stale registry dependency next to them", () => {
      writeManifest({ dependencies: { "local-lib": "link:../local-lib", hono: "^4.0.0" } });
      writeRawLock({
        "node_modules/local-lib": { resolved: "../local-lib", link: true },
        "node_modules/hono": { version: "4.6.3" },
      });
      installed("local-lib", "0.0.1");
      installed("hono", "4.5.0");

      expect(staleDependencies(engineDir)).toEqual(["hono"]);
    });

    it("R1: an npm: alias dependency whose installed version matches the lockfile is not reported", () => {
      writeManifest({ dependencies: { aliased: "npm:real-package@^2.0.0" } });
      writeRawLock({ "node_modules/aliased": { name: "real-package", version: "2.3.4" } });
      mkdirSync(join(engineDir, "node_modules/aliased"), { recursive: true });
      writeFileSync(join(engineDir, "node_modules/aliased/package.json"), JSON.stringify({ name: "real-package", version: "2.3.4" }));

      expect(staleDependencies(engineDir)).toEqual([]);
    });

    it("R1: an npm: alias dependency whose installed version differs is still reported under the alias name", () => {
      writeManifest({ dependencies: { aliased: "npm:real-package@^2.0.0" } });
      writeRawLock({ "node_modules/aliased": { name: "real-package", version: "2.3.4" } });
      mkdirSync(join(engineDir, "node_modules/aliased"), { recursive: true });
      writeFileSync(join(engineDir, "node_modules/aliased/package.json"), JSON.stringify({ name: "real-package", version: "2.0.0" }));

      expect(staleDependencies(engineDir)).toEqual(["aliased"]);
    });
  });
});

describe("staleDependenciesMessage (#150)", () => {
  const prefix = "vendor/open-connector dependencies are out of date";
  const suffix = "run scripts/bootstrap.sh, then deploy again";

  it("D8: names up to five are all listed, with no 'more'", () => {
    expect(staleDependenciesMessage(["graphql"])).toBe(`${prefix} (graphql); ${suffix}`);
    expect(staleDependenciesMessage(["a", "b", "c", "d", "e"])).toBe(`${prefix} (a, b, c, d, e); ${suffix}`);
  });

  it("D8: six names list the first five and say 'and 1 more'", () => {
    expect(staleDependenciesMessage(["a", "b", "c", "d", "e", "f"])).toBe(`${prefix} (a, b, c, d, e and 1 more); ${suffix}`);
  });

  it("D8: many names list the first five and count the rest", () => {
    const names = Array.from({ length: 12 }, (_, index) => `pkg${index}`);
    expect(staleDependenciesMessage(names)).toBe(`${prefix} (pkg0, pkg1, pkg2, pkg3, pkg4 and 7 more); ${suffix}`);
  });

  it("D8: scoped names are printed as they are", () => {
    expect(staleDependenciesMessage(["@scope/x", "graphql"])).toBe(`${prefix} (@scope/x, graphql); ${suffix}`);
  });
});

/** Parses JSONC: drops // and /* *\/ comments outside strings, and trailing commas. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i];
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}

// #83. What a deploy publishes at <origin>/version.json, and the refusal to deploy a tree that isn't committed.
describe("version.json and the clean-tree check (#83)", { timeout: 30_000 }, () => {
  const versionPath = () => join(engine, "dist/web/version.json");
  const readVersion = () => JSON.parse(readFileSync(versionPath(), "utf8")) as {
    splitmind: { commit: string; dirty: boolean };
    openconnector: { version: string; commit: string };
    patches: { name: string; sha256: string }[];
    builtAt: string;
  };
  const edit = (file: string, from: string, to: string) =>
    [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join("\n");
  const hint = "commit or stash them, or pass --allow-dirty";
  const dirtyTree = () => writeFileSync(join(checkout, "notes.txt"), "scratch\n");
  const settle = () => commitSuperproject(checkout, "settle");
  const keys = (value: object) => Object.keys(value).sort();

  describe("V3: the file is written into the web build output on every build path", () => {
    it("--dry-run writes version.json next to the setup page, with the documented fields", () => {
      writeFileSync(join(engine, "greeting.txt"), "hello\n");
      // The engine sits past the commit the checkout pins, as it does after bootstrap.
      git(engine, "add", "-A");
      git(engine, "commit", "-q", "-m", "local baseline");
      mkdirSync(join(checkout, "patches"));
      writeFileSync(join(checkout, "patches/0002-second.patch"), edit("greeting.txt", "hello, patched", "hello, twice"));
      writeFileSync(join(checkout, "patches/0001-first.patch"), edit("greeting.txt", "hello", "hello, patched"));
      const before = Date.now();

      const result = deploy("--dry-run");

      expect(result.status).toBe(0);
      expect(existsSync(join(engine, "dist/web/setup/index.html"))).toBe(true);
      const info = readVersion();
      expect(keys(info)).toEqual(["builtAt", "openconnector", "patches", "splitmind"]);
      expect(keys(info.splitmind)).toEqual(["commit", "dirty"]);
      expect(keys(info.openconnector)).toEqual(["commit", "version"]);
      expect(info.splitmind).toEqual({ commit: git(checkout, "rev-parse", "HEAD"), dirty: false });
      expect(info.openconnector).toEqual({ version: "1.9.2", commit: engineGitlink });
      // The pin is reported, not the engine's own (later) HEAD.
      expect(git(engine, "rev-parse", "HEAD")).not.toBe(engineGitlink);
      expect(info.patches).toEqual(
        ["0001-first.patch", "0002-second.patch"].map((name) => ({
          name,
          sha256: createHash("sha256").update(readFileSync(join(checkout, "patches", name))).digest("hex"),
        })),
      );
      expect(info.builtAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(Date.parse(info.builtAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(info.builtAt)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it("--dry-run makes only the one `deploy --dry-run` wrangler call", () => {
      const result = deploy("--dry-run");

      expect(result.status).toBe(0);
      const calls = readAccount().calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/^deploy .*--dry-run/);
      expect(existsSync(versionPath())).toBe(true);
    });

    it("--dry-run on a dirty tree is not refused, and records dirty: true", () => {
      dirtyTree();

      const result = deployAsIs({}, "--dry-run");

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("--allow-dirty");
      expect(readVersion().splitmind.dirty).toBe(true);
      expect(readVersion().splitmind.commit).toBe(git(checkout, "rev-parse", "HEAD"));
      expect(readAccount().calls).toHaveLength(1);
    });

    it("a real deploy writes it too, and the second build pass keeps it", () => {
      const result = deploy();

      // Stops at the secrets prompt, after both builds and deploys.
      expect(result.status).toBe(1);
      expect(readAccount().calls.filter((call) => call.startsWith("deploy"))).toHaveLength(2);
      const info = readVersion();
      expect(info.splitmind).toEqual({ commit: git(checkout, "rev-parse", "HEAD"), dirty: false });
      expect(info.openconnector.commit).toBe(engineGitlink);
    });

    it("version.json stays parseable and fresh across two dry runs", () => {
      deploy("--dry-run");
      const first = readVersion();

      const second = deploy("--dry-run");

      expect(second.status).toBe(0);
      expect(readVersion().splitmind).toEqual(first.splitmind);
      expect(Date.parse(readVersion().builtAt)).toBeGreaterThanOrEqual(Date.parse(first.builtAt));
    });
  });

  describe("V4: a real deploy refuses a dirty tree", () => {
    it("an untracked file: exit non-zero, names the file and the hint, and the account is never touched", () => {
      dirtyTree();

      const result = deployAsIs({});

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("notes.txt");
      expect(result.stderr).toContain(hint);
      expect(readAccount().calls).toEqual([]);
      expect(existsSync(join(checkout, "splitmind.local.json"))).toBe(false);
      expect(existsSync(join(engine, "wrangler.local.jsonc"))).toBe(false);
      expect(result.stdout).not.toContain("==> Checking Cloudflare login");
      expect(result.stdout).not.toContain("==> Cloudflare resources");
    });

    it("a modified tracked file: refused, naming it", () => {
      writeFileSync(join(checkout, "wrangler.template.jsonc"), `${readFileSync(join(checkout, "wrangler.template.jsonc"), "utf8")}\n// local edit\n`);

      const result = deployAsIs({});

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("wrangler.template.jsonc");
      expect(result.stderr).toContain(hint);
      expect(readAccount().calls).toEqual([]);
    });

    it("a staged but uncommitted file: refused", () => {
      dirtyTree();
      git(checkout, "add", "notes.txt");

      const result = deployAsIs({});

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(hint);
      expect(readAccount().calls).toEqual([]);
    });

    it("with many dirty files it names the first few, not all of them", () => {
      for (let n = 1; n <= 20; n++) writeFileSync(join(checkout, `scratch-${String(n).padStart(2, "0")}.txt`), "x\n");

      const result = deployAsIs({});

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("scratch-01.txt");
      expect(result.stderr).not.toContain("scratch-20.txt");
      expect(result.stderr).toContain(hint);
      expect(readAccount().calls).toEqual([]);
    });

    it("--allow-dirty goes ahead: wrangler is called, nothing is refused, and the file records dirty: true", () => {
      dirtyTree();

      const result = deployAsIs({}, "--allow-dirty");

      expect(result.stderr).not.toContain(hint);
      expect(result.stderr).not.toMatch(/unknown option|allow-dirty/i);
      const calls = readAccount().calls;
      expect(calls[0]).toBe("whoami");
      expect(calls.some((call) => call.startsWith("deploy"))).toBe(true);
      expect(readVersion().splitmind.dirty).toBe(true);
      expect(readVersion().splitmind.commit).toBe(git(checkout, "rev-parse", "HEAD"));
    });

    it("--allow-dirty on a clean tree still records dirty: false", () => {
      settle();

      deployAsIs({}, "--allow-dirty");

      expect(readVersion().splitmind.dirty).toBe(false);
    });

    it("--allow-dirty works with --dry-run too", () => {
      dirtyTree();

      const result = deployAsIs({}, "--dry-run", "--allow-dirty");

      expect(result.status).toBe(0);
      expect(readVersion().splitmind.dirty).toBe(true);
    });

    it("--render-only is not refused on a dirty tree", () => {
      deploy();
      dirtyTree();
      setAccount({ ...readAccount(), calls: [] });

      const result = deployAsIs({}, "--render-only");

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain(hint);
    });

    it("the engine being modified, patched or ahead of its pin does not count as dirty", () => {
      settle();
      writeFileSync(join(engine, "greeting.txt"), "hello\n");
      writeFileSync(join(engine, "package.json"), `${readFileSync(join(engine, "package.json"), "utf8")}\n`);
      git(engine, "add", "-A");
      git(engine, "commit", "-q", "-m", "local baseline");
      writeFileSync(join(engine, "package.json"), `${readFileSync(join(engine, "package.json"), "utf8")}\n`);
      expect(git(checkout, "status", "--porcelain")).toBe(" M vendor/open-connector");

      const result = deployAsIs({});

      expect(result.stderr).not.toContain(hint);
      expect(readAccount().calls[0]).toBe("whoami");
      expect(readVersion().splitmind.dirty).toBe(false);
      expect(readVersion().openconnector.commit).toBe(engineGitlink);
    });

    it("an untracked .spec-*.md does not count", () => {
      settle();
      writeFileSync(join(checkout, ".spec-83.md"), "spec\n");

      const result = deployAsIs({});

      expect(result.stderr).not.toContain(hint);
      expect(readAccount().calls[0]).toBe("whoami");
    });

    it("a re-run is not refused for the saved state or rendered config its own first run left behind", () => {
      deploy();
      expect(existsSync(join(checkout, "splitmind.local.json"))).toBe(true);
      setAccount({ ...readAccount(), calls: [] });

      const result = deployAsIs({});

      expect(result.stderr).not.toContain(hint);
      expect(readAccount().calls[0]).toBe("whoami");
    });

    it("a folder that is not a git repo is treated as dirty: refused, and the account is never touched", () => {
      rmSync(join(checkout, ".git"), { recursive: true, force: true });

      const result = deployAsIs({});

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(hint);
      expect(readAccount().calls).toEqual([]);
    });

    it("a folder that is not a git repo deploys with --allow-dirty, recording commit unknown and dirty: true", () => {
      rmSync(join(checkout, ".git"), { recursive: true, force: true });

      deployAsIs({}, "--allow-dirty");

      expect(readAccount().calls[0]).toBe("whoami");
      expect(readVersion().splitmind).toEqual({ commit: "unknown", dirty: true });
    });

    it("--help lists --allow-dirty", () => {
      const result = deployAsIs({}, "--help");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("--allow-dirty");
    });
  });

  describe("V5: nothing private is published", () => {
    it("holds no origin, worker name, resource id, account id, secret, token, user or host", () => {
      const shortKey = Buffer.from("sixteen byte key").toString("base64");
      const env = {
        SPLITMIND_ADMIN_TOKEN: adminToken,
        // Refused as too short, which stops the run after the build: version.json is written by then.
        SPLITMIND_ENCRYPTION_KEY: shortKey,
        CLOUDFLARE_API_TOKEN: "dummy-cloudflare-api-token-4c1e9a",
        CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        MY_SERVICE_SECRET: "dummy-service-secret-77d2f0",
        GITHUB_TOKEN: "dummy-github-token-91ab33",
        OAUTH_CLIENT_SECRET: "dummy-oauth-client-secret-5e5e5e",
      };

      const result = deployWith(env, "--name", "very-private-worker", "--origin", "https://connector.private-origin.test");

      expect(result.stderr).toContain("SPLITMIND_ENCRYPTION_KEY must be exactly 32 bytes in base64");
      const text = readFileSync(versionPath(), "utf8");
      expect(keys(JSON.parse(text) as object)).toEqual(["builtAt", "openconnector", "patches", "splitmind"]);
      const forbidden = [
        "very-private-worker",
        "private-origin.test",
        "https://",
        "d1-id-",
        "kv-id-",
        "fake-subdomain",
        adminToken,
        encryptionKey,
        shortKey,
        checkout,
        dir,
        tmpdir(),
        ...Object.values(env),
        // Every other value in the environment the script ran in.
        ...Object.values(process.env).filter((value): value is string => typeof value === "string" && value.length >= 16),
      ];
      for (const value of forbidden) expect(text, `version.json must not contain ${value.slice(0, 12)}...`).not.toContain(value);
      const person = userInfo().username;
      if (person.length >= 5 && !/^[0-9a-f]+$/.test(person)) expect(text).not.toContain(person);
      const host = hostname();
      if (host.length >= 5 && !/^[0-9a-f]+$/.test(host)) expect(text).not.toContain(host);
      expect(text).not.toContain("Version Fixture Person");
      expect(text).not.toContain("person@fixture.example");
    });
  });
});
