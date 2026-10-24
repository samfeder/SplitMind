// Deploys SplitMind's OpenConnector Worker to the Cloudflare account wrangler is logged in to. Safe to re-run: it
// finds the D1 database and KV namespaces it created before, and only asks for secrets that are not set yet.
//
// Usage: node scripts/deploy.ts [--name <worker-name>] [--origin <url>] [--render-only] [--dry-run]
//
//   --name         Worker name (default: splitmind). Resource names derive from it.
//   --origin       Public origin, e.g. a custom domain. Default: the workers.dev URL wrangler prints.
//   --render-only  Write vendor/open-connector/wrangler.local.jsonc from the saved state and stop.
//   --dry-run      Build and bundle with placeholder resource ids; needs no Cloudflare login and changes nothing.
//
// Steps: check wrangler login -> create or find D1 + two KV namespaces -> render wrangler.local.jsonc -> apply D1
// migrations -> build with the trimmed catalog -> deploy -> set missing secrets (you paste them) -> GET /health.
// Account-specific state (resource ids, origin) is saved to splitmind.local.json, which git ignores. Secrets are
// never read, printed or stored by this script: wrangler prompts for them directly.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const engine = join(root, "vendor/open-connector");
const statePath = join(root, "splitmind.local.json");
const renderedPath = join(engine, "wrangler.local.jsonc");
const requiredSecrets = ["OOMOL_CONNECT_ADMIN_TOKEN", "OOMOL_CONNECT_ENCRYPTION_KEY"];

// Where a non-interactive run (CI, a cloud session) may take each secret from. Values are piped to wrangler and
// never printed.
const secretSources: Record<string, string> = {
  OOMOL_CONNECT_ADMIN_TOKEN: "SPLITMIND_ADMIN_TOKEN",
  OOMOL_CONNECT_ENCRYPTION_KEY: "SPLITMIND_ENCRYPTION_KEY",
};

// Returns why a secret value is unusable, without repeating the value.
export function secretProblem(name: string, value: string): string | undefined {
  if (name === "OOMOL_CONNECT_ENCRYPTION_KEY") {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== value) {
      return "must be exactly 32 bytes in base64 (the output of `openssl rand -base64 32`)";
    }
  } else if (value.length < 32) {
    return "must be at least 32 characters (use `openssl rand -base64 32`)";
  }
  return undefined;
}

export interface DeployState {
  workerName: string;
  d1: { name: string; id: string };
  kv: { transit: { title: string; id: string }; oauth: { title: string; id: string } };
  origin?: string;
}

export interface RenderValues {
  workerName: string;
  d1Name: string;
  d1Id: string;
  transitKvId: string;
  oauthKvId: string;
  origin: string;
}

/** Fills the template's <placeholders>. Throws if any placeholder is left, so a half-rendered config never deploys. */
export function renderTemplate(template: string, values: RenderValues): string {
  const replacements: Record<string, string> = {
    "<worker-name>": values.workerName,
    "<d1-database-name>": values.d1Name,
    "<d1-database-id>": values.d1Id,
    "<transit-kv-namespace-id>": values.transitKvId,
    "<oauth-kv-namespace-id>": values.oauthKvId,
    "<public-origin>": values.origin,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!/^[\w.:/-]*$/.test(value)) throw new Error(`unsafe value for ${placeholder}: ${JSON.stringify(value)}`);
    rendered = rendered.replaceAll(`"${placeholder}"`, JSON.stringify(value));
  }
  const left = stripComments(rendered).match(/"<[a-z0-9-]+>"/g);
  if (left) throw new Error(`template placeholders not filled: ${[...new Set(left)].join(", ")}`);
  return rendered;
}

/** The provider ids in the template's OOMOL_CONNECT_ALLOWED_ACTIONS ("notion.*,slack.*,gmail.*" -> gmail, notion, slack). */
export function allowlistedProviders(template: string): string[] {
  const match = stripComments(template).match(/"OOMOL_CONNECT_ALLOWED_ACTIONS"\s*:\s*"([^"]*)"/);
  if (!match) throw new Error("template has no OOMOL_CONNECT_ALLOWED_ACTIONS");
  const providers = match[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(".")[0]!);
  return [...new Set(providers)].sort();
}

/** The exact action ids in the template's OOMOL_CONNECT_BLOCKED_ACTIONS; empty if it has none. */
export function blockedActions(template: string): string[] {
  const match = stripComments(template).match(/"OOMOL_CONNECT_BLOCKED_ACTIONS"\s*:\s*"([^"]*)"/);
  if (!match) return [];
  return [...new Set(match[1]!.split(",").map((entry) => entry.trim()).filter(Boolean))].sort();
}

export interface DeployRecord {
  targets: string[];
  rawBytes?: number;
  gzipBytes?: number;
}

/** The last "deploy" entry in wrangler's ND-JSON output file (WRANGLER_OUTPUT_FILE_PATH). */
export function parseDeployRecord(ndjson: string): DeployRecord | undefined {
  let record: DeployRecord | undefined;
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as {
      type?: string;
      targets?: string[];
      bundle_size?: { raw_bytes?: number; gzip_bytes?: number };
    };
    if (entry.type !== "deploy") continue;
    record = {
      targets: entry.targets ?? [],
      ...(entry.bundle_size?.raw_bytes === undefined ? {} : { rawBytes: entry.bundle_size.raw_bytes }),
      ...(entry.bundle_size?.gzip_bytes === undefined ? {} : { gzipBytes: entry.bundle_size.gzip_bytes }),
    };
  }
  return record;
}

/** The workers.dev URL among a deploy's targets. */
export function workersDevOrigin(record: DeployRecord): string | undefined {
  return record.targets.find((target) => /^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(target));
}

function stripComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "");
}

// --- wrangler -------------------------------------------------------------------------------------------------------

function wranglerCommand(): string[] {
  // Tests point this at a stand-in; normal runs use the engine's pinned wrangler.
  const override = process.env.SPLITMIND_WRANGLER;
  return override ? [override] : [join(engine, "node_modules/.bin/wrangler")];
}

function wrangler(
  args: string[],
  options: { cwd?: string; interactive?: boolean; env?: NodeJS.ProcessEnv; input?: string } = {},
): string {
  const [command, ...prefix] = wranglerCommand();
  const result = spawnSync(command!, [...prefix, ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    input: options.input,
    stdio: options.interactive ? "inherit" : [options.input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", ...options.env },
  });
  if (result.status !== 0) {
    if (!options.interactive) process.stderr.write(result.stderr ?? "");
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (exit ${result.status})`);
  }
  return result.stdout ?? "";
}

function parseJsonOutput<T>(output: string): T {
  // Wrangler can print warnings (e.g. about proxies) before the JSON.
  const start = output.search(/^\s*[[{]/m);
  return JSON.parse(start >= 0 ? output.slice(start) : output) as T;
}

function findOrCreateD1(name: string): string {
  const list = () => parseJsonOutput<{ name: string; uuid: string }[]>(wrangler(["d1", "list", "--json"]));
  let found = list().find((db) => db.name === name);
  if (found) {
    console.log(`    D1 ${name}: exists`);
  } else {
    wrangler(["d1", "create", name, "--update-config=false"]);
    found = list().find((db) => db.name === name);
    if (!found) throw new Error(`created D1 ${name} but cannot find it in wrangler d1 list`);
    console.log(`    D1 ${name}: created`);
  }
  return found.uuid;
}

function findOrCreateKv(title: string): string {
  const list = () => parseJsonOutput<{ title: string; id: string }[]>(wrangler(["kv", "namespace", "list"]));
  let found = list().find((ns) => ns.title === title);
  if (found) {
    console.log(`    KV ${title}: exists`);
  } else {
    wrangler(["kv", "namespace", "create", title, "--update-config=false"]);
    found = list().find((ns) => ns.title === title);
    if (!found) throw new Error(`created KV namespace ${title} but cannot find it in wrangler kv namespace list`);
    console.log(`    KV ${title}: created`);
  }
  return found.id;
}

// --- steps ----------------------------------------------------------------------------------------------------------

function readState(): DeployState | undefined {
  return existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as DeployState) : undefined;
}

function writeState(state: DeployState): void {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function readTemplate(): string {
  return readFileSync(join(root, "wrangler.template.jsonc"), "utf8");
}

function render(state: DeployState): void {
  const rendered = renderTemplate(readTemplate(), {
    workerName: state.workerName,
    d1Name: state.d1.name,
    d1Id: state.d1.id,
    transitKvId: state.kv.transit.id,
    oauthKvId: state.kv.oauth.id,
    // Before the first deploy the workers.dev URL is unknown. An empty origin keeps the Worker failing closed
    // (503 on every request) until the second pass fills it in.
    origin: state.origin ?? "",
  });
  writeFileSync(renderedPath, rendered);
  console.log(`    wrote ${renderedPath.slice(root.length + 1)}`);
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})`);
}

function build(template: string): void {
  if (!existsSync(join(engine, "node_modules"))) {
    throw new Error("vendor/open-connector has no node_modules; run scripts/bootstrap.sh first");
  }
  console.log("==> Building (catalog, Web Console, trimmed catalog assets)");
  run("npm", ["run", "generate:catalog"], engine);
  run("npm", ["run", "build:web"], engine);
  run(process.execPath, [join(root, "scripts/catalog-assets.ts"), engine, allowlistedProviders(template).join(",")], root);
}

function deploy(extraArgs: string[] = []): DeployRecord | undefined {
  console.log("==> Deploying");
  // Interactive, so wrangler can ask first-time questions (e.g. registering a workers.dev subdomain). The URL and
  // bundle size come back through wrangler's machine-readable output file instead of scraping the terminal.
  const outputFile = join(engine, ".wrangler/splitmind-deploy-output.ndjson");
  rmSync(outputFile, { force: true });
  wrangler(["deploy", "--config", "wrangler.local.jsonc", "--minify", ...extraArgs], {
    cwd: engine,
    interactive: true,
    env: { WRANGLER_OUTPUT_FILE_PATH: outputFile },
  });
  const record = existsSync(outputFile) ? parseDeployRecord(readFileSync(outputFile, "utf8")) : undefined;
  if (record?.rawBytes !== undefined) {
    const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
    console.log(`    bundle: ${mib(record.rawBytes)} (gzip ${mib(record.gzipBytes ?? 0)})`);
  }
  return record;
}

function ensureSecrets(): void {
  const present = new Set(
    parseJsonOutput<{ name: string }[]>(
      wrangler(["secret", "list", "--config", "wrangler.local.jsonc", "--format", "json"], { cwd: engine }),
    ).map((secret) => secret.name),
  );
  let missing = requiredSecrets.filter((name) => !present.has(name));
  if (missing.length === 0) {
    console.log("    secrets: all set");
    return;
  }
  // Check every value first, so a bad one doesn't leave the Worker with only some of its secrets.
  const fromEnv = missing.flatMap((name) => {
    const source = secretSources[name]!;
    const value = process.env[source]?.trim();
    if (!value) return [];
    const problem = secretProblem(name, value);
    if (problem) throw new Error(`${source} ${problem}`);
    return [{ name, source, value }];
  });
  for (const { name, source, value } of fromEnv) {
    wrangler(["secret", "put", name, "--config", "wrangler.local.jsonc"], { cwd: engine, input: value });
    console.log(`    ${name}: set from ${source}`);
  }
  missing = missing.filter((name) => !fromEnv.some((secret) => secret.name === name));
  if (missing.length === 0) return;
  const commands = missing.map((name) => `  (cd vendor/open-connector && npx wrangler secret put ${name} --config wrangler.local.jsonc)`);
  if (!process.stdin.isTTY) {
    console.error(
      `deploy: secrets not set: ${missing.join(", ")}. Run these in a terminal, or set ` +
        `${missing.map((name) => secretSources[name]).join(" and ")} in the environment, then re-run this script:`,
    );
    console.error(commands.join("\n"));
    throw new Error("missing secrets");
  }
  for (const name of missing) {
    console.log(`\n    ${name} is not set.`);
    console.log("    In another terminal run `openssl rand -base64 32` and paste the output at the prompt below.");
    if (name === "OOMOL_CONNECT_ENCRYPTION_KEY") {
      console.log("    Save this one in your password manager first: if it is lost, stored credentials cannot be recovered.");
      console.log("    Use the openssl output exactly. A 32-byte base64 key takes the fast HKDF path (ADR-0001).");
    }
    wrangler(["secret", "put", name, "--config", "wrangler.local.jsonc"], { cwd: engine, interactive: true });
  }
}

async function checkHealth(origin: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(`${origin}/health`);
      const body = await response.text();
      console.log(`    GET /health -> ${response.status} ${body.trim()}`);
      if (response.status === 200 && body.trim() === '{"ok":true}') return true;
    } catch (error) {
      console.log(`    GET /health -> ${(error as Error).message}`);
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
  return false;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      origin: { type: "string" },
      "render-only": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: node scripts/deploy.ts [--name <worker-name>] [--origin <url>] [--render-only] [--dry-run]");
    return 0;
  }
  if (values.origin !== undefined && !/^https:\/\/[^/\s]+$/.test(values.origin)) {
    console.error("deploy: --origin must be https://host with no path or trailing slash");
    return 2;
  }

  const template = readTemplate();
  const saved = readState();
  const workerName = values.name ?? saved?.workerName ?? "splitmind";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerName)) {
    console.error("deploy: --name must be lowercase letters, digits and dashes");
    return 2;
  }
  if (saved && saved.workerName !== workerName) {
    console.error(`deploy: splitmind.local.json is for Worker "${saved.workerName}"; move it aside to deploy "${workerName}"`);
    return 2;
  }

  if (values["dry-run"]) {
    const placeholder = "0".repeat(32);
    writeFileSync(
      renderedPath,
      renderTemplate(template, {
        workerName,
        d1Name: `${workerName}-db`,
        d1Id: "00000000-0000-0000-0000-000000000000",
        transitKvId: placeholder,
        oauthKvId: placeholder,
        origin: values.origin ?? `https://${workerName}.example.workers.dev`,
      }),
    );
    build(template);
    deploy(["--dry-run", "--outdir", join(engine, ".wrangler/splitmind-dry-run")]);
    console.log("==> Dry run complete; nothing was uploaded.");
    return 0;
  }

  if (values["render-only"]) {
    if (!saved) {
      console.error("deploy: no splitmind.local.json yet; run a full deploy first");
      return 1;
    }
    render({ ...saved, ...(values.origin ? { origin: values.origin } : {}) });
    return 0;
  }

  console.log("==> Checking Cloudflare login");
  wrangler(["whoami"]);

  console.log("==> Cloudflare resources");
  const state: DeployState = {
    workerName,
    d1: { name: `${workerName}-db`, id: findOrCreateD1(`${workerName}-db`) },
    kv: {
      transit: { title: `${workerName}-transit-files`, id: findOrCreateKv(`${workerName}-transit-files`) },
      oauth: { title: `${workerName}-oauth`, id: findOrCreateKv(`${workerName}-oauth`) },
    },
    ...(values.origin ? { origin: values.origin } : saved?.origin ? { origin: saved.origin } : {}),
  };
  writeState(state);
  render(state);

  console.log("==> Applying D1 migrations");
  wrangler(["d1", "migrations", "apply", state.d1.name, "--remote", "--config", "wrangler.local.jsonc"], {
    cwd: engine,
    interactive: true,
  });

  build(template);
  const record = deploy();

  if (!state.origin) {
    const url = record && workersDevOrigin(record);
    if (!url) throw new Error("could not find the workers.dev URL in wrangler's output; re-run with --origin");
    state.origin = url;
    writeState(state);
    console.log(`==> Origin is ${url}; redeploying with it`);
    render(state);
    deploy();
  }

  console.log("==> Secrets");
  ensureSecrets();

  console.log("==> Health check");
  if (!(await checkHealth(state.origin))) {
    console.error("deploy: /health did not return {\"ok\":true}. See docs/setup/cloudflare.md, Troubleshooting.");
    return 1;
  }
  console.log(`==> Deployed. Open ${state.origin} and sign in with the admin token.`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`deploy: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
