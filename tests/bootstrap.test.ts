import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the real scripts/bootstrap.sh against throwaway git repositories: a
// stand-in "upstream" and a SplitMind checkout that pins it as a submodule.

const script = resolve(import.meta.dirname, "../scripts/bootstrap.sh");

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  // Local file:// submodules are off by default since git 2.38.1.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function bootstrap(cwd: string, ...args: string[]) {
  return spawnSync("bash", [join(cwd, "scripts/bootstrap.sh"), ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

const VALID_PATCH = `diff --git a/greeting.txt b/greeting.txt
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-hello from upstream
+hello from upstream, patched
`;

const BROKEN_PATCH = `diff --git a/greeting.txt b/greeting.txt
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-text that is not in the file
+replacement
`;

let dir: string;
let checkout: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "splitmind-bootstrap-"));

  const upstream = join(dir, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  writeFileSync(join(upstream, "greeting.txt"), "hello from upstream\n");
  git(upstream, "add", "greeting.txt");
  git(upstream, "commit", "-q", "-m", "upstream");
  git(upstream, "tag", "v1.0.0");

  const origin = join(dir, "origin");
  mkdirSync(join(origin, "scripts"), { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  copyFileSync(script, join(origin, "scripts/bootstrap.sh"));
  git(origin, "submodule", "add", "-q", upstream, "vendor/open-connector");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "pin upstream");

  // A plain clone leaves the submodule uninitialised, like a fresh checkout.
  checkout = join(dir, "checkout");
  git(dir, "clone", "-q", origin, checkout);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function addPatch(name: string, body: string) {
  mkdirSync(join(checkout, "patches"), { recursive: true });
  writeFileSync(join(checkout, "patches", name), body);
}

function greeting(): string {
  return readFileSync(join(checkout, "vendor/open-connector/greeting.txt"), "utf8");
}

describe("scripts/bootstrap.sh", () => {
  it("initialises the submodule and reports when there are no patches", () => {
    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No patches to apply.");
    expect(run.stdout).toContain("v1.0.0");
    expect(greeting()).toBe("hello from upstream\n");
  });

  it("applies a patch, and skips it on a second run", () => {
    addPatch("0001-greeting.patch", VALID_PATCH);

    const first = bootstrap(checkout, "--skip-install");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("applied: patches/0001-greeting.patch");
    expect(greeting()).toBe("hello from upstream, patched\n");

    const second = bootstrap(checkout, "--skip-install");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already applied: patches/0001-greeting.patch");
    expect(greeting()).toBe("hello from upstream, patched\n");
  });

  it("skips stacked patches that no longer reverse one by one", () => {
    addPatch("0001-greeting.patch", VALID_PATCH);
    addPatch(
      "0002-greeting-again.patch",
      VALID_PATCH.replace("-hello from upstream\n", "-hello from upstream, patched\n").replace(
        "+hello from upstream, patched\n",
        "+hello from upstream, patched twice\n",
      ),
    );
    expect(bootstrap(checkout, "--skip-install").status).toBe(0);

    const second = bootstrap(checkout, "--skip-install");

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already applied: patches/0001-greeting.patch");
    expect(second.stdout).toContain("already applied: patches/0002-greeting-again.patch");
    expect(greeting()).toBe("hello from upstream, patched twice\n");
  });

  it("stops and names a patch that does not apply", () => {
    addPatch("0001-broken.patch", BROKEN_PATCH);

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("patches/0001-broken.patch does not apply");
    expect(greeting()).toBe("hello from upstream\n");
  });

  it("rejects an unknown option", () => {
    const run = bootstrap(checkout, "--bogus");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown option: --bogus");
  });
});
